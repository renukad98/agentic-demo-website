import test, { before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import { objectDigest } from "../../tools/agentic/artifacts.js";
import { TrustedHumanApprovalBoundary } from "../../tools/agentic/approval-authority.js";
import { identityKey } from "../../tools/xray/identity.js";
import { writeOperationId } from "../../tools/xray/write-integration.js";
import { genericProposal } from "../../tools/xray/planner.js";
import {
  inspectGenericCreationResponse,
  GenericTestCreationAdapter,
  JiraStoryLinkAdapter,
} from "../../tools/xray/executor-preparation.js";
import { preparationFixture } from "./support/executor-preparation-fixture.js";
import { fixtureNow } from "./support/json-journal-fixtures.js";
let calls = 0;
before(() => {
  const deny = () => {
    calls++;
    throw new Error("NETWORK_FORBIDDEN");
  };
  mock.method(globalThis, "fetch", deny);
  mock.method(http, "request", deny);
  mock.method(https, "request", deny);
  mock.method(net.Socket.prototype, "connect", deny);
});
after(() => {
  assert.equal(calls, 0);
  mock.restoreAll();
});
test("prepared create: exact canonical proposal and durable authorization remain inert", async (t) => {
  const f = await preparationFixture(t),
    adapter = f.createAdapter(),
    result = await adapter.prepare(f.input, f.preflight);
  assert.equal(result.status, "PREPARED_DISABLED");
  assert.equal(result.remoteWritesEnabled, false);
  assert.deepEqual(result.proposal, f.proposal);
  assert.deepEqual(result.request.body, {
    query: f.proposal.payload.query,
    variables: f.proposal.payload.variables,
  });
  assert.equal(result.request.path, "/api/v2/graphql");
  assert.equal(
    (await f.journal.entries(f.request.operationId)).at(-1)!.status,
    "Approved",
  );
  assert.throws(() => adapter.execute(), /DISABLED/);
  const document = JSON.parse(
    await fs.readFile(join(f.root, "journal", "operations.json"), "utf8"),
  );
  assert.equal(
    document.consumptions[0].authority.events.at(-1).state,
    "consumed",
  );
});
for (const mode of [
  "digest",
  "Reporter",
  "project ID",
  "type ID",
  "query",
  "identity",
  "tenant",
  "project",
  "Story",
  "payload",
] as const) {
  test("prepared create: rejects " + mode + " substitution", async (t) => {
    const f = await preparationFixture(t),
      input = structuredClone(f.input);
    const payload = input.proposal.payload as {
      query?: unknown;
      variables: {
        jira: {
          fields: {
            reporter?: unknown;
            project: { id: string };
            issuetype: { id: string };
          };
        };
      };
    };
    if (mode === "digest")
      input.proposal.payloadDigest = "sha256:" + "0".repeat(64);
    if (mode === "Reporter") delete payload.variables.jira.fields.reporter;
    if (mode === "project ID") payload.variables.jira.fields.project.id = "999";
    if (mode === "type ID") payload.variables.jira.fields.issuetype.id = "999";
    if (mode === "query") payload.query = "mutation Unknown {}";
    if (mode === "identity") input.identity.automationId = "wrong";
    if (mode === "tenant") input.approvalRequest.tenant = "other";
    if (mode === "project") input.approvalRequest.projectKey = "OTHER";
    if (mode === "Story") input.proposal.storyKey = "SYN-99";
    if (mode === "payload")
      payload.variables.jira.fields.project.id = "invalid";
    const preflight = structuredClone(f.preflight);
    if (
      ["Reporter", "project ID", "type ID", "query", "payload"].includes(mode)
    ) {
      input.proposal.payloadDigest = objectDigest(input.proposal.payload);
      input.approvalRequest.payloadDigest = input.proposal.payloadDigest;
      input.approvalRequest.operationId = writeOperationId({
        tenant: f.context.tenant,
        projectKey: f.context.projectKey,
        operation: "xray.test.create",
        payloadDigest: input.proposal.payloadDigest,
      });
      preflight.payloadDigest = input.proposal.payloadDigest;
      input.approvalRequest.preflightDigest = objectDigest(preflight);
      f.authority.grant("create", input.approvalRequest);
    }
    await assert.rejects(f.createAdapter().prepare(input, preflight));
    assert.equal(f.authority.consumeCalls, 0);
  });
}
for (const mode of ["missing", "expired", "revoked", "outage"] as const) {
  test(
    "prepared create: " + mode + " authority blocks preparation",
    async (t) => {
      const f = await preparationFixture(t);
      if (mode === "missing") f.authority.decisions.clear();
      if (mode === "expired")
        f.authority.decisions.get("create")!.expiresAt = new Date(
          fixtureNow - 1,
        ).toISOString();
      if (mode === "revoked")
        await f.authority.revokeApproval(
          "create",
          objectDigest(f.input.approvalRequest),
        );
      if (mode === "outage") f.authority.unavailable = true;
      await assert.rejects(f.createAdapter().prepare(f.input, f.preflight));
      assert.equal(f.authority.consumeCalls, 0);
    },
  );
}
for (const mode of [
  "stale",
  "future",
  "ambiguous",
  "incomplete",
  "duplicate",
  "page gap",
  "preflight digest",
  "endpoint",
] as const) {
  test(
    "prepared create: " + mode + " preflight rejected before authority",
    async (t) => {
      const f = await preparationFixture(t),
        preflight = structuredClone(f.preflight),
        input = structuredClone(f.input);
      if (mode === "stale") preflight.startedAt = fixtureNow - 300001;
      if (mode === "future") preflight.checkedAt = fixtureNow + 1;
      if (mode === "ambiguous") preflight.ambiguous = true;
      if (mode === "incomplete") preflight.pages[0]!.total = 1;
      if (mode === "page gap") preflight.pages[0]!.start = 1;
      if (mode === "endpoint")
        preflight.xrayApiBase = "https://us.xray.cloud.getxray.app";
      if (mode === "duplicate") {
        preflight.pages[0] = { total: 1, start: 0, ids: ["201"] };
        preflight.candidates = [
          {
            key: "SYN-9",
            issueId: "201",
            identity: identityKey(f.identity),
            behaviorDigest: f.identity.behaviorDigest,
            type: "Generic",
          },
        ];
      }
      if (mode !== "preflight digest")
        input.approvalRequest.preflightDigest = objectDigest(preflight);
      else input.approvalRequest.preflightDigest = "sha256:" + "0".repeat(64);
      f.authority.grant("create", input.approvalRequest);
      await assert.rejects(f.createAdapter().prepare(input, preflight));
      assert.equal(f.authority.consumeCalls, 0);
    },
  );
}
test("prepared create: default authority has no mock fallback", async (t) => {
  const f = await preparationFixture(t);
  await assert.rejects(
    f
      .createAdapter(new TrustedHumanApprovalBoundary())
      .prepare(f.input, f.preflight),
    /UNAVAILABLE/,
  );
});
test("prepared create: repeated or restarted preparation cannot create another reservation", async (t) => {
  const f = await preparationFixture(t);
  await f.createAdapter().prepare(f.input, f.preflight);
  await assert.rejects(f.createAdapter().prepare(f.input, f.preflight));
  await f.journal.close();
  const journal = f.open();
  await assert.rejects(
    f.createAdapter(f.boundary, journal).prepare(f.input, f.preflight),
  );
  assert.equal(f.authority.consumeCalls, 1);
});
test("prepared link: confirmed identity and separate grant produce exact disabled link request", async (t) => {
  const f = await preparationFixture(t);
  await f.seedConfirmed();
  const adapter = f.linkAdapter(),
    result = await adapter.prepare(f.linkInput, f.observation);
  assert.equal(result.status, "PREPARED_DISABLED");
  if (result.status === "PREPARED_DISABLED") {
    assert.deepEqual(result.request.body, f.link.payload);
    assert.equal(result.request.path, "/rest/api/3/issueLink");
  }
  assert.equal(
    (await f.journal.entries(f.request.operationId)).at(-1)!.remoteTestKey,
    "SYN-2",
  );
  assert.throws(() => adapter.execute(), /DISABLED/);
});
for (const mode of [
  "no confirmation",
  "wrong Test",
  "wrong Story",
  "wrong identity",
  "reversed direction",
  "creation approval",
  "conflicting link",
] as const) {
  test("prepared link: " + mode + " rejected", async (t) => {
    const f = await preparationFixture(t);
    if (mode !== "no confirmation") await f.seedConfirmed();
    const observation = structuredClone(f.observation),
      input = structuredClone(f.linkInput);
    if (mode === "wrong Test") observation.test.key = "SYN-99";
    if (mode === "wrong Story") observation.story.key = "SYN-99";
    if (mode === "wrong identity") observation.test.unstructured = "other";
    if (mode === "reversed direction") {
      const body = input.proposal.payload as {
        inwardIssue: { key: string };
        outwardIssue: { key: string };
      };
      body.inwardIssue.key = "SYN-1";
      body.outwardIssue.key = "SYN-2";
    }
    if (mode === "creation approval") input.approvalReference = "create";
    if (mode === "conflicting link")
      observation.links = [
        {
          testKey: "SYN-2",
          storyKey: "SYN-1",
          typeId: "10037",
          direction: "is tested by",
        },
      ];
    if (mode === "reversed direction") {
      input.proposal.payloadDigest = objectDigest(input.proposal.payload);
      input.approvalRequest.payloadDigest = input.proposal.payloadDigest;
      input.approvalRequest.operationId = writeOperationId({
        tenant: f.context.tenant,
        projectKey: f.context.projectKey,
        operation: "jira.test.link",
        payloadDigest: input.proposal.payloadDigest,
      });
      observation.preflight.payloadDigest = input.proposal.payloadDigest;
    }
    input.approvalRequest.preflightDigest = objectDigest(observation);
    f.authority.grant("link", input.approvalRequest);
    await assert.rejects(f.linkAdapter().prepare(input, observation));
    assert.equal(f.authority.consumeCalls, 0);
  });
}
test("prepared link: existing equivalent link produces no write and consumes no grant", async (t) => {
  const f = await preparationFixture(t);
  await f.seedConfirmed();
  const observation = structuredClone(f.observation);
  observation.links = [
    {
      testKey: "SYN-2",
      storyKey: "SYN-1",
      typeId: "10037",
      direction: "tests",
    },
  ];
  const input = structuredClone(f.linkInput);
  input.approvalRequest.preflightDigest = objectDigest(observation);
  assert.equal(
    (await f.linkAdapter().prepare(input, observation)).status,
    "NO_WRITE_ALREADY_LINKED",
  );
  assert.equal(f.authority.consumeCalls, 0);
});
test("prepared link: lost authority response preserves confirmed creation and blocks replay", async (t) => {
  const f = await preparationFixture(t);
  await f.seedConfirmed();
  f.authority.consumeFailure = true;
  await assert.rejects(
    f.linkAdapter().prepare(f.linkInput, f.observation),
    /UNCERTAIN/,
  );
  const confirmed = (await f.journal.entries(f.request.operationId)).at(-1)!;
  assert.equal(confirmed.status, "Confirmed");
  assert.deepEqual(confirmed.remoteIds, ["101"]);
  assert.equal(confirmed.remoteTestKey, "SYN-2");
  await assert.rejects(f.linkAdapter().prepare(f.linkInput, f.observation));
  assert.equal(f.authority.consumeCalls, 1);
});
test("response classifier: complete synthetic creation still requires read-back", () => {
  assert.deepEqual(
    inspectGenericCreationResponse(
      {
        data: {
          createTest: {
            test: {
              issueId: "201",
              jira: { key: "SYN-3" },
              testType: { name: "Generic" },
              unstructured: "synthetic-id",
            },
          },
        },
      },
      "SYN",
      "synthetic-id",
    ),
    { status: "REQUIRES_READ_BACK", issueId: "201", testKey: "SYN-3" },
  );
});
for (const mode of [
  "missing key",
  "errors",
  "malformed errors",
  "warnings",
  "wrong identity",
  "wrong project",
] as const) {
  test(
    "response classifier: " +
      mode +
      " never discards known ID or claims confirmation",
    () => {
      const response: {
        data: {
          createTest: {
            test: {
              issueId: string;
              jira: { key?: string };
              testType: { name: string };
              unstructured: string;
            };
            warnings?: unknown[];
          };
        };
        errors?: unknown;
      } = {
        data: {
          createTest: {
            test: {
              issueId: "201",
              jira: { key: "SYN-3" },
              testType: { name: "Generic" },
              unstructured: "synthetic-id",
            },
          },
        },
      };
      if (mode === "missing key") delete response.data.createTest.test.jira.key;
      if (mode === "errors") response.errors = [{ message: "synthetic" }];
      if (mode === "malformed errors") response.errors = "malformed";
      if (mode === "warnings") response.data.createTest.warnings = ["review"];
      if (mode === "wrong identity")
        response.data.createTest.test.unstructured = "other";
      if (mode === "wrong project")
        response.data.createTest.test.jira.key = "OTHER-3";
      const result = inspectGenericCreationResponse(
        response,
        "SYN",
        "synthetic-id",
      );
      assert.equal(result.issueId, "201");
      assert.equal(
        result.status,
        mode === "warnings" ? "REVIEW_WARNINGS" : "UNCERTAIN_RECONCILE",
      );
    },
  );
}
test("prepared adapters: constructor does not accept live transport and all execution stays disabled", async (t) => {
  const f = await preparationFixture(t);
  assert.throws(() => f.createAdapter().execute(), /DISABLED/);
  assert.throws(() => f.linkAdapter().execute(), /DISABLED/);
  assert.throws(
    () =>
      new GenericTestCreationAdapter(f.root, f.registry, f.journal, {
        ...f.context,
        jiraOrigin: "https://outside.example",
      }),
    /ORIGIN/,
  );
  assert.throws(
    () =>
      new JiraStoryLinkAdapter(f.root, f.registry, f.journal, {
        ...f.context,
        xrayApiBase: "https://outside.example",
      }),
  );
  const source = await fs.readFile(
    "tools/xray/executor-preparation.ts",
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /process\.env|process\.argv|fetch\(|node:http|node:sqlite|mcp__/,
  );
});
test("prepared create: changed source fingerprint blocks preparation", async (t) => {
  const f = await preparationFixture(t);
  await fs.writeFile(
    join(f.root, f.identity.sourceLocation),
    "changed synthetic source",
  );
  await assert.rejects(f.createAdapter().prepare(f.input, f.preflight));
  assert.equal(f.authority.consumeCalls, 0);
});
test("prepared link: target omitted from complete preflight is not eligible", async (t) => {
  const f = await preparationFixture(t);
  await f.seedConfirmed();
  const observation = structuredClone(f.observation);
  observation.preflight.pages = [{ total: 0, start: 0, ids: [] }];
  observation.preflight.candidates = [];
  const input = structuredClone(f.linkInput);
  input.approvalRequest.preflightDigest = objectDigest(observation);
  f.authority.grant("link", input.approvalRequest);
  await assert.rejects(
    f.linkAdapter().prepare(input, observation),
    /TEST_NOT_VISIBLE/,
  );
  assert.equal(f.authority.consumeCalls, 0);
});
test("prepared create: reusable adapter accepts another registered Story without hardcoding", async (t) => {
  const f = await preparationFixture(t),
    input = structuredClone(f.input);
  input.identity = f.registry.register({
    ...input.identity,
    associations: [
      ...input.identity.associations,
      { ...input.identity.associations[0]!, storyKey: "SYN-7" },
    ],
  });
  input.proposal = genericProposal(
    "SYN-7",
    f.context.projectKey,
    input.identity,
    "Another Story behavior",
    {
      projectId: f.context.projectId,
      issueTypeId: f.context.testIssueTypeId,
      reporter: { accountId: "mock-reporter-01" },
    },
  );
  input.approvalRequest.target = "SYN-7";
  input.approvalRequest.payloadDigest = input.proposal.payloadDigest;
  input.approvalRequest.operationId = writeOperationId({
    tenant: f.context.tenant,
    projectKey: f.context.projectKey,
    operation: "xray.test.create",
    payloadDigest: input.proposal.payloadDigest,
  });
  const preflight = {
    ...f.preflight,
    storyKey: "SYN-7",
    payloadDigest: input.proposal.payloadDigest,
  };
  input.approvalRequest.preflightDigest = objectDigest(preflight);
  f.authority.grant("create", input.approvalRequest);
  assert.equal(
    (await f.createAdapter().prepare(input, preflight)).proposal.storyKey,
    "SYN-7",
  );
});
