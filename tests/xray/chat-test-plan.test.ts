import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  previewTestPlan,
  recordTestPlan,
} from "../../tools/agentic/chat-test-plan.js";
import { JiraIssueLinkClient } from "../../tools/xray-mcp/helpers/jira-link-client.js";
import { XrayClient } from "../../tools/xray-mcp/helpers/xray-client.js";
import { createChatWriteXrayMcpServer } from "../../tools/xray-mcp/src/integrations/xray-mcp/server.js";

const command = "qa test-plan QA-10";
const title = "Demo Story";
const summary = "Agentic Demo Website – Demo Story";
const plan = { issueId: "200", key: "QA-20" };
const relate = { inwardKey: plan.key, outwardKey: "QA-10" };
const type = {
  id: "100",
  name: "Relates",
  inward: "relates to",
  outward: "relates to",
};

async function fixture(
  t: TestContext,
  options: {
    saved?: boolean;
    linked?: boolean;
    fail?: "mutation" | "plan-read" | "link-post" | "link-read";
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "qa-test-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, "qa", "QA-10");
  await mkdir(folder, { recursive: true });
  const file = join(folder, "feature.json");
  const original = {
    storyKey: "QA-10",
    title,
    stage: "published",
    ...(options.saved ? { testPlanKey: plan.key } : {}),
  };
  await writeFile(file, JSON.stringify(original));
  await writeFile(
    join(root, "qa", "current.json"),
    JSON.stringify({ storyKey: "QA-10" }),
  );
  const feature = async () =>
    JSON.parse(await readFile(file, "utf8")) as typeof original;
  const operations: string[] = [];
  let linked = Boolean(options.linked);

  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/authenticate")) return Response.json("fixture-token");
      const { query, variables } = JSON.parse(String(init?.body));
      if (query.includes("mutation CreateTestPlan")) {
        operations.push("create");
        assert.deepEqual(variables, {
          jira: { fields: { project: { key: "QA" }, summary } },
        });
        return options.fail === "mutation"
          ? new Response(null, { status: 400 })
          : Response.json({
              data: { createTestPlan: { testPlan: { issueId: plan.issueId } } },
            });
      }
      assert.match(query, /query VerifyTestPlan/);
      operations.push("verify-plan");
      assert.deepEqual(variables, { issueId: plan.issueId });
      return Response.json({
        data: {
          getTestPlan:
            options.fail === "plan-read"
              ? null
              : { issueId: plan.issueId, jira: { key: plan.key, summary } },
        },
      });
    },
  );

  const jira = new JiraIssueLinkClient(
    {
      baseUrl: "https://jira.invalid",
      email: "fixture@example.test",
      apiToken: "fixture-secret",
    },
    async (url, init) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path.endsWith("/issueLinkType"))
        return Response.json({ issueLinkTypes: [type] });
      if (path.endsWith("/issueLink") && init?.method === "POST") {
        operations.push("link");
        assert.deepEqual(JSON.parse(String(init.body)), {
          inwardIssue: { key: plan.key },
          outwardIssue: { key: "QA-10" },
          type: { id: type.id },
        });
        if (options.fail === "link-post")
          return new Response(null, { status: 403 });
        linked = options.fail !== "link-read";
        return new Response(null, { status: 201 });
      }
      if (path.endsWith("/issueLink/101")) {
        operations.push("verify-link");
        return Response.json({
          id: "101",
          type,
          inwardIssue: { key: options.linked ? "QA-10" : plan.key },
          outwardIssue: { key: options.linked ? plan.key : "QA-10" },
        });
      }
      assert.match(path, /\/issue\/QA-(10|20)$/);
      if (parsed.searchParams.get("fields") === "issuelinks")
        return Response.json({
          fields: { issuelinks: linked ? [{ id: "101" }] : [] },
        });
      const key = path.split("/").at(-1);
      return Response.json({
        id: key === plan.key ? plan.issueId : "100",
        key,
        fields: {},
      });
    },
  );
  const xray = new XrayClient({
    clientId: "fixture-id",
    clientSecret: "fixture-secret",
    baseUrl: "https://xray.invalid",
    graphqlUrl: "https://xray.invalid/api/v2/graphql",
  });
  const server = createChatWriteXrayMcpServer(xray, () => jira);
  const client = new Client({ name: "test-plan", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());

  async function call(
    name: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await client.callTool({ name, arguments: input });
    const content = response.content as Array<{ text: string }>;
    if (response.isError) throw new Error(content[0]?.text);
    return JSON.parse(content[0]!.text);
  }

  return { root, feature, original, operations, call };
}

test("approved Test Plan preview supports create, verify, link, and record", async (t) => {
  const f = await fixture(t);
  const preview = await previewTestPlan(f.root, "qa test-plan");
  assert.deepEqual(preview.operations, [
    { tool: "xray_create_test_plan", projectKey: "QA", summary },
    {
      tool: "jira_link_issues",
      linkType: "Relates",
      inwardKey: null,
      outwardKey: "QA-10",
    },
  ]);
  assert.deepEqual(f.operations, []);
  const created = await f.call("xray_create_test_plan", {
    projectKey: "QA",
    summary,
  });
  assert.deepEqual(created, plan);
  const link = await f.call("jira_link_issues", relate);
  assert.equal((await f.feature()).testPlanKey, undefined);
  assert.deepEqual(
    await recordTestPlan(f.root, command, { preview, plan: created, link }),
    {
      storyKey: "QA-10",
      testPlanKey: plan.key,
      linkStatus: "linked",
    },
  );
  assert.deepEqual(await f.feature(), { ...f.original, testPlanKey: plan.key });
  assert.deepEqual(f.operations, [
    "create",
    "verify-plan",
    "link",
    "verify-link",
  ]);
});

for (const linked of [false, true]) {
  test(
    linked
      ? "link-only recognises an existing reverse Relates link"
      : "link-only keeps the saved Test Plan",
    async (t) => {
      const f = await fixture(t, { saved: true, linked });
      const preview = await previewTestPlan(f.root, command);
      assert.deepEqual(preview.operations, [
        { tool: "jira_link_issues", linkType: "Relates", ...relate },
      ]);
      const link = await f.call("jira_link_issues", relate);
      const result = await recordTestPlan(f.root, command, {
        preview,
        plan,
        link,
      });
      assert.equal(result.linkStatus, linked ? "already-linked" : "linked");
      assert.deepEqual(await f.feature(), f.original);
      assert.deepEqual(
        f.operations,
        linked ? ["verify-link"] : ["link", "verify-link"],
      );
    },
  );
}

for (const failure of [
  "mutation",
  "plan-read",
  "link-post",
  "link-read",
] as const) {
  test(
    "Test Plan route stops on " + failure + " and preserves the feature record",
    async (t) => {
      const f = await fixture(t, { fail: failure });
      const preview = await previewTestPlan(f.root, command);
      const create = () =>
        f.call("xray_create_test_plan", { projectKey: "QA", summary });
      if (failure === "mutation" || failure === "plan-read") {
        await assert.rejects(
          create(),
          /Check for the Test Plan|issue ID 200 could not be verified/,
        );
        assert.deepEqual(
          f.operations,
          failure === "mutation" ? ["create"] : ["create", "verify-plan"],
        );
      } else {
        assert.deepEqual(await create(), plan);
        await assert.rejects(
          f.call("jira_link_issues", relate),
          /HTTP 403|could not be verified/,
        );
        assert.deepEqual(f.operations, ["create", "verify-plan", "link"]);
      }
      await assert.rejects(recordTestPlan(f.root, command, { preview, plan }));
      assert.deepEqual(await f.feature(), f.original);
    },
  );
}

test("record rejects changed preview or mismatched link evidence", async (t) => {
  const f = await fixture(t);
  const preview = await previewTestPlan(f.root, command);
  const link = { status: "linked", linkId: "101", ...relate };
  await assert.rejects(
    recordTestPlan(f.root, command, {
      preview: { ...preview, operations: [] },
      plan,
      link,
    }),
    /approved Test Plan preview changed/,
  );
  await assert.rejects(
    recordTestPlan(f.root, command, {
      preview,
      plan,
      link: { ...link, outwardKey: "QA-11" },
    }),
    /link does not match/,
  );
  assert.deepEqual(await f.feature(), f.original);
  assert.deepEqual(f.operations, []);
});
