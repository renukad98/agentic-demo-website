import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { JiraIssueLinkClient } from "../../tools/xray-mcp/helpers/jira-link-client.js";
import { XrayClient } from "../../tools/xray-mcp/helpers/xray-client.js";
import { createChatWriteXrayMcpServer } from "../../tools/xray-mcp/src/integrations/xray-mcp/server.js";

test(
  "stdio independently opts in by flag or environment and announces writes on stderr",
  { timeout: 30_000 },
  async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "xray-write-startup-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const serverPath = fileURLToPath(
      new URL(
        "../../tools/xray-mcp/src/integrations/xray-mcp/server.ts",
        import.meta.url,
      ),
    );
    for (const [args, enabled] of [
      [[], "false"],
      [["--enable-writes"], "false"],
      [[], "true"],
    ] as const) {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", import.meta.resolve("tsx"), serverPath, ...args],
        cwd,
        stderr: "pipe",
        env: {
          XRAY_CLIENT_ID: "fixture-id",
          XRAY_CLIENT_SECRET: "fixture-secret",
          XRAY_ENABLE_WRITES: enabled,
        },
      });
      let diagnostic = "";
      transport.stderr!.on("data", (chunk) => {
        diagnostic += String(chunk);
      });
      const client = new Client({ name: "write-startup-test", version: "1" });
      try {
        await client.connect(transport);
        const tools = (await client.listTools()).tools;
        const optIn = args.length > 0 || enabled === "true";
        const names = [
          "xray_get_test",
          "xray_get_test_coverage",
          "xray_search_tests",
        ];
        if (optIn)
          names.push(
            "xray_create_manual_test",
            "xray_link_test_to_story",
            "xray_resolve_test_keys",
          );
        assert.deepEqual(tools.map((tool) => tool.name).sort(), names.sort());
        assert.equal(diagnostic.includes("opt-in writes enabled"), optIn);
        if (optIn) {
          assert.equal(
            tools.find((tool) => tool.name === "xray_resolve_test_keys")
              ?.annotations?.readOnlyHint,
            true,
          );
          assert.equal(
            tools.find((tool) => tool.name === "xray_create_manual_test")
              ?.annotations?.readOnlyHint,
            false,
          );
        }
      } finally {
        await client.close();
      }
    }
  },
);

test("opt-in creates one exact Manual Test, resolves IDs and reads back the Test link", async (t) => {
  const steps = [{ action: " Open ", data: "", result: "Visible" }];
  const warnings = ["Folder /Regression was not found."];
  const issueId = "30";
  const testKey = "KAN-30";
  const storyKey = "KAN-29";
  const type = {
    id: "10",
    name: "Test",
    inward: "is tested by",
    outward: "tests",
  };
  let mutationCount = 0;
  let linkPosts = 0;
  let linkReads = 0;
  let linkFailure = false;
  const xray = new XrayClient({
    clientId: "fixture-id",
    clientSecret: "fixture-secret",
    baseUrl: "https://xray.invalid",
    graphqlUrl: "https://xray.invalid/api/v2/graphql",
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL, init: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/authenticate"))
        return Response.json("fixture-access-token");
      assert.equal(url, "https://xray.invalid/api/v2/graphql");
      const { query, variables } = JSON.parse(String(init.body));
      if (query.includes("mutation CreateManualTest")) {
        mutationCount++;
        assert.match(query, /testType: \{ name: "Manual" \}/);
        assert.deepEqual(variables, {
          steps,
          folderPath: "/Regression",
          jira: { fields: { project: { key: "KAN" }, summary: " Open task " } },
        });
        assert.match(query, /\bwarnings\b/);
        return Response.json({ data: { createTest: { test: { issueId }, warnings } } });
      }
      if (query.includes("query ResolveTestKeys")) {
        assert.deepEqual(variables, { issueIds: [issueId, "999"], limit: 2 });
        return Response.json({
          data: {
            getTests: { results: [{ issueId, jira: { key: testKey } }] },
          },
        });
      }
      assert.match(query, /query VerifyManualTestForLink/);
      assert.deepEqual(variables, { issueId });
      return Response.json({
        data: {
          getTest: {
            issueId,
            testType: { name: "Manual" },
            jira: { key: testKey },
          },
        },
      });
    },
  );
  const jira = new JiraIssueLinkClient(
    {
      baseUrl: "https://jira.invalid",
      email: "fixture@example.invalid",
      apiToken: "fixture-token",
    },
    async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/mypermissions")) {
        return Response.json({
          permissions: { LINK_ISSUES: { havePermission: true } },
        });
      }
      if (url.pathname.endsWith("/issueLinkType"))
        return Response.json({ issueLinkTypes: [type] });
      const link = {
        id: "55",
        type,
        inwardIssue: { key: testKey },
        outwardIssue: { key: storyKey },
      };
      if (url.pathname.endsWith("/issueLink")) {
        assert.equal(init?.method, "POST");
        assert.deepEqual(JSON.parse(String(init?.body)), {
          type: { id: type.id },
          inwardIssue: link.inwardIssue,
          outwardIssue: link.outwardIssue,
        });
        if (linkFailure) return new Response(null, { status: 503 });
        linkPosts++;
        return new Response(null, { status: 201 });
      }
      if (url.pathname.endsWith("/issueLink/55")) {
        linkReads++;
        return Response.json(link);
      }
      const story = url.pathname.endsWith(storyKey);
      assert(story || url.pathname.endsWith(testKey));
      return Response.json({
        id: story ? "29" : issueId,
        key: story ? storyKey : testKey,
        fields: {
          project: { key: "KAN" },
          issuetype: { name: story ? "Story" : "Test" },
          issuelinks: linkPosts ? [{ id: link.id }] : [],
        },
      });
    },
  );
  const server = createChatWriteXrayMcpServer(xray, () => jira);
  const client = new Client({ name: "write-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert(Array.isArray(result.content));
    const content = result.content[0];
    assert(typeof content?.text === "string");
    return JSON.parse(content.text);
  };
  assert.deepEqual(
    await call("xray_create_manual_test", {
      projectKey: "KAN",
      summary: " Open task ",
      steps,
      folderPath: "/Regression",
    }),
    { issueId, warnings },
  );
  assert.deepEqual(
    await call("xray_resolve_test_keys", { issueIds: [issueId, "999"] }),
    [
      { issueId, key: testKey },
      { issueId: "999", key: null },
    ],
  );
  linkFailure = true;
  const failed = await client.callTool({
    name: "xray_link_test_to_story",
    arguments: { storyKey, testKey },
  });
  assert.equal(failed.isError, true);
  assert.match(JSON.stringify(failed.content), /HTTP 503.*Do not retry/);
  linkFailure = false;
  assert.deepEqual(
    await call("xray_link_test_to_story", { storyKey, testKey }),
    {
      status: "linked",
      storyKey,
      testKey,
      linkId: "55",
      reconciled: false,
    },
  );
  assert.equal(
    (await call("xray_link_test_to_story", { storyKey, testKey })).status,
    "already-linked",
  );
  assert.equal(mutationCount, 1);
  assert.equal(linkPosts, 1);
  assert(linkReads >= 2);
});

test("tool errors preserve the message while redacting credential values", async (t) => {
  const original = process.env.JIRA_API_TOKEN;
  process.env.JIRA_API_TOKEN = "fixture-credential";
  t.after(() => {
    if (original === undefined) delete process.env.JIRA_API_TOKEN;
    else process.env.JIRA_API_TOKEN = original;
  });
  const server = createChatWriteXrayMcpServer({
    async graphqlRequest() {
      throw new Error("Unexpected read");
    },
    async createManualTest() {
      throw new Error(
        "Validation failed: fixture-credential and Authorization: Basic ZmFrZQ==",
      );
    },
  });
  const client = new Client({ name: "redaction-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());
  const response = await client.callTool({
    name: "xray_create_manual_test",
    arguments: {
      projectKey: "QA",
      summary: "Test",
      steps: [{ action: "Act", data: "", result: "Observe" }],
    },
  });
  assert.equal(response.isError, true);
  assert.deepEqual(response.content, [
    {
      type: "text",
      text: "Validation failed: [REDACTED] and authorization=[REDACTED]",
    },
  ]);
});
