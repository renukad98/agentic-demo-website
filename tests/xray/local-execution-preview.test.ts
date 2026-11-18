import { objectDigest } from "../../tools/agentic/artifacts.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { previewLocalExecution } from "../../tools/xray/local-execution-preview.js";
import {
  runLocalExecution,
  reconcileLocalExecution,
} from "../../tools/xray/local-execution.js";
import { OperationJournal } from "../../tools/xray/operation-journal.js";

import {
  createDemoEvidenceFixture,
  fixtureSourceDigest,
  fixtureEvidenceDigest,
} from "./support/local-demo-evidence.js";

const evidenceRoot = await createDemoEvidenceFixture();

const automationIdentity =
  "agentic-demo-website:playwright:task-create-inflight-single-submit-v1";
const base = {
  schemaVersion: "1.0.0",
  status: "Confirmed",
  tenant: "renudhamankar98.atlassian.net",
  storyKey: "KAN-25",
  projectKey: "KAN",
  remoteTestKey: "KAN-26",
  automationIdentity,
  at: "2026-11-18T00:00:00.000Z",
  payloadDigest:
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sourceDigest: fixtureSourceDigest,
  evidenceDigest: fixtureEvidenceDigest,
} as const;
const a = {
  ...base,
  operationId: "a",
  operation: "xray.test.create",
  remoteIds: ["10066"],
} as const;
const b = {
  ...base,
  operationId: "b",
  operation: "jira.test.link",
  remoteIds: ["10010"],
} as const;
const entries = [
  { ...a, remoteIds: [...a.remoteIds] },
  { ...b, remoteIds: [...b.remoteIds] },
];
const read = {
  async getExecutionSnapshot() {
    return null;
  },
  async getTest() {
    return {
      issueId: "10066",
      jira: { key: "KAN-26" },
      testType: { name: "Generic" },
      unstructured: automationIdentity,
    };
  },
  async getCoverage() {
    return [{ issueId: "10065", jira: { key: "KAN-25" } }];
  },
  async searchExecutions() {
    return [];
  },
};

const summary = "Automated validation for KAN-25";
function snapshot(
  title = summary,
  members = ["10066"],
  environments = ["chromium"],
) {
  return {
    issueId: "10077",
    projectId: "10001",
    jira: { key: "KAN-27", summary: title, created: new Date().toISOString() },
    testEnvironments: environments,
    tests: {
      total: members.length,
      start: 0 as const,
      results: members.map((issueId) => ({ issueId })),
    },
  };
}

test("C detects a possible renamed equivalent while allowing broader historical executions", async () => {
  const history = snapshot("Historical validation", ["10066", "10012"]);
  const inventory = {
    ...read,
    async searchExecutions() {
      return [history];
    },
  };
  await previewLocalExecution(evidenceRoot, entries, {
    ...inventory,
    async getExecutionSnapshot() {
      return history;
    },
  });
  await assert.rejects(
    previewLocalExecution(evidenceRoot, entries, {
      ...inventory,
      async getExecutionSnapshot() {
        return snapshot("Historical validation");
      },
    }),
    /POSSIBLE_RENAMED_EXECUTION/,
  );
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "xray-execution-demo-"));
  const journal = new OperationJournal(directory);
  t.after(async () => {
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  });
  for (const entry of entries) {
    for (const status of [
      "Planned",
      "Awaiting approval",
      "Approved",
      "Attempted",
      "Confirmed",
    ] as const) {
      await journal.record({
        ...entry,
        status,
        remoteIds: status === "Confirmed" ? entry.remoteIds : [],
        ...(["Approved", "Attempted", "Confirmed"].includes(status)
          ? {
              approvalReference: "approval-" + entry.operationId,
              approvalConsumptionId: "consumption-" + entry.operationId,
            }
          : {}),
      });
    }
  }
  const state = {
    calls: 0,
    loseResponse: false,
    members: ["10066"],
    environments: ["chromium"],
  };
  let created: string | undefined;
  const current = () => ({
    ...snapshot(summary, state.members, state.environments),
    jira: { key: "KAN-27", summary, created },
  });
  const ports = {
    read: {
      ...read,
      async searchExecutions() {
        return created ? [current()] : [];
      },
      async getExecutionSnapshot() {
        return created ? current() : null;
      },
    },
    tokens: {
      async getToken() {
        return "synthetic-token";
      },
      invalidate() {},
    },
    async confirm(display: string) {
      return "APPROVE " + JSON.parse(display).fingerprint;
    },
    fetch: (async (url, options) => {
      assert.equal(url, "https://xray.cloud.getxray.app/api/v2/graphql");
      assert.equal(options?.method, "POST");
      assert.deepEqual(
        JSON.parse(String(options?.body)).variables.testIssueIds,
        ["10066"],
      );
      assert.equal(
        (await journal.latestEntries()).find(
          (x) => x.operation === "xray.execution.create",
        )?.status,
        "Attempted",
      );
      state.calls++;
      created = new Date().toISOString();
      if (state.loseResponse) throw new Error("mock response lost");
      return Response.json({
        data: {
          createTestExecution: {
            testExecution: { issueId: "10077", jira: { key: "KAN-27" } },
            warnings: [],
          },
        },
      });
    }) satisfies typeof fetch,
  };
  return { journal, state, ports };
}

test("C confirms once after reading exact membership and environment and preserves A and B", async (t) => {
  const { journal, state, ports } = await fixture(t);
  const before = await journal.latestEntries();
  assert.deepEqual(await runLocalExecution(evidenceRoot, journal, ports), {
    status: "CONFIRMED",
    key: "KAN-27",
    issueId: "10077",
  });
  assert.deepEqual((await journal.latestEntries()).slice(0, 2), before);
  await assert.rejects(
    runLocalExecution(evidenceRoot, journal, ports),
    /CHECKPOINT_C_ALREADY_JOURNALED/,
  );
  assert.equal(state.calls, 1);
});

test("C rejects incorrect or expired approval before dispatch", async (t) => {
  const { journal, state, ports } = await fixture(t);
  await assert.rejects(
    runLocalExecution(evidenceRoot, journal, {
      ...ports,
      async confirm() {
        return "APPROVE wrong";
      },
    }),
    /LOCAL_APPROVAL_DENIED_OR_EXPIRED/,
  );
  let time = Date.now();
  await assert.rejects(
    runLocalExecution(evidenceRoot, journal, {
      ...ports,
      now: () => time,
      async confirm(display) {
        time += 120_000;
        return ports.confirm(display);
      },
    }),
    /LOCAL_APPROVAL_DENIED_OR_EXPIRED/,
  );
  assert.equal(state.calls, 0);
});

test("C blocks on mismatched membership or environment and reconciles the returned ID by reads", async (t) => {
  const { journal, state, ports } = await fixture(t);
  state.members = ["10066", "10012"];
  assert.equal(
    (await runLocalExecution(evidenceRoot, journal, ports)).status,
    "UNCERTAIN_RUN_RECONCILE_EXECUTION",
  );
  state.members = ["10066"];
  state.environments = ["firefox"];
  assert.equal(
    (await reconcileLocalExecution(journal, ports.read)).status,
    "RECONCILIATION_REQUIRED",
  );
  state.environments = ["chromium"];
  assert.equal(
    (await reconcileLocalExecution(journal, ports.read)).status,
    "RECONCILED",
  );
  assert.equal(state.calls, 1);
});

test("C reconciles a lost response using a unique matching execution created after the attempt", async (t) => {
  const { journal, state, ports } = await fixture(t);
  state.loseResponse = true;
  assert.equal(
    (await runLocalExecution(evidenceRoot, journal, ports)).status,
    "UNCERTAIN_RUN_RECONCILE_EXECUTION",
  );
  assert.equal(
    (await reconcileLocalExecution(journal, ports.read)).status,
    "RECONCILED",
  );
  assert.equal(state.calls, 1);
});

test("C concurrent approvals can dispatch only once", async (t) => {
  const { journal, state, ports } = await fixture(t);
  let prompted = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const start = () =>
    runLocalExecution(evidenceRoot, journal, {
      ...ports,
      async confirm(display) {
        if (++prompted === 2) release();
        await barrier;
        return ports.confirm(display);
      },
    });
  const results = await Promise.allSettled([start(), start()]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(state.calls, 1);
});

test("C preview binds one confirmed Test, the Chromium environment and Jira create fields", async () => {
  const preview = await previewLocalExecution(evidenceRoot, entries, read);
  assert.equal(preview.request.path, "/api/v2/graphql");
  assert.match(preview.request.body.query, /createTestExecution\(/);
  assert.deepEqual(preview.request.body.variables.testIssueIds, ["10066"]);
  assert.deepEqual(preview.request.body.variables.testEnvironments, [
    "chromium",
  ]);
  assert.equal(
    preview.request.body.variables.jira.fields.issuetype.id,
    "10046",
  );
  const { fingerprint, ...review } = preview;
  assert.equal(fingerprint, objectDigest(review));
});

test("C preview requires the confirmed link journal and current remote coverage", async () => {
  await assert.rejects(
    previewLocalExecution(evidenceRoot, entries.slice(0, 1), read),
    /CONFIRMED_CHECKPOINTS/,
  );
  await assert.rejects(
    previewLocalExecution(evidenceRoot, entries, {
      ...read,
      async getCoverage() {
        return [];
      },
    }),
    /TEST_IDENTITY_OR_COVERAGE_CHANGED/,
  );
});

test("C preview blocks a matching execution and an existing C journal entry", async () => {
  await assert.rejects(
    previewLocalExecution(evidenceRoot, entries, {
      ...read,
      async searchExecutions() {
        return [
          {
            issueId: "123",
            jira: { key: "KAN-99", summary: "Automated validation for KAN-25" },
          },
        ];
      },
    }),
    /MATCHING_OR_UNVERIFIABLE_EXECUTION_EXISTS/,
  );
  await assert.rejects(
    previewLocalExecution(
      evidenceRoot,
      [
        ...entries,
        {
          ...entries[0]!,
          operation: "xray.execution.create",
          status: "Attempted",
        },
      ],
      read,
    ),
    /CHECKPOINT_C_ALREADY_JOURNALED/,
  );
});
