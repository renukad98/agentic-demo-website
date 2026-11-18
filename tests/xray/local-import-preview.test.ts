import { objectDigest } from "../../tools/agentic/artifacts.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { IdentityRegistry } from "../../tools/xray/identity.js";
import {
  previewLocalImport,
  selectedPlaywrightResult,
} from "../../tools/xray/local-import-preview.js";
import {
  reconcileLocalImport,
  runLocalImport,
} from "../../tools/xray/local-import.js";
import { OperationJournal } from "../../tools/xray/operation-journal.js";

import {
  createDemoEvidenceFixture,
  fixtureSourceDigest,
  fixtureEvidenceDigest,
  fixtureFinish,
  registryFile,
} from "./support/local-demo-evidence.js";

const evidenceRoot = await createDemoEvidenceFixture();

const identityName =
  "agentic-demo-website:playwright:task-create-inflight-single-submit-v1";
const base = {
  schemaVersion: "1.0.0",
  tenant: "renudhamankar98.atlassian.net",
  projectKey: "KAN",
  storyKey: "KAN-25",
  remoteTestKey: "KAN-26",
  status: "Confirmed",
  automationIdentity: identityName,
  at: "2026-11-18T00:00:00.000Z",
  payloadDigest:
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sourceDigest: fixtureSourceDigest,
  evidenceDigest: fixtureEvidenceDigest,
} as const;
const entries = [
  {
    ...base,
    operationId: "a",
    operation: "xray.test.create" as const,
    remoteIds: ["10066"],
  },
  {
    ...base,
    operationId: "b",
    operation: "jira.test.link" as const,
    remoteIds: ["10010"],
  },
  {
    ...base,
    operationId: "c",
    operation: "xray.execution.create" as const,
    status: "Reconciled" as const,
    reconciliation: "confirmed" as const,
    remoteIds: ["10067"],
    remoteExecutionKey: "KAN-27",
  },
];
const emptyRun = {
  id: "synthetic-test-run",
  status: { name: "TO DO" },
  startedOn: null,
  finishedOn: null,
  comment: "",
  evidence: [],
  test: { issueId: "10066" },
  testExecution: { issueId: "10067" },
};
const read = {
  async getTest() {
    return {
      issueId: "10066",
      jira: { key: "KAN-26" },
      testType: { name: "Generic" },
      unstructured: identityName,
    };
  },
  async getCoverage() {
    return [{ issueId: "10065", jira: { key: "KAN-25" } }];
  },
  async getExecutionSnapshot() {
    return {
      issueId: "10067",
      projectId: "10001",
      jira: { key: "KAN-27" },
      testEnvironments: ["chromium"],
      tests: { start: 0 as const, total: 1, results: [{ issueId: "10066" }] },
    };
  },
  async getAllRuns() {
    return [emptyRun];
  },
};

async function importFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "xray-import-demo-"));
  const journal = new OperationJournal(directory);
  t.after(async () => {
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  });
  for (const entry of entries) {
    const { reconciliation, ...baseEntry } = {
      reconciliation: undefined,
      ...entry,
    };
    for (const status of [
      "Planned",
      "Awaiting approval",
      "Approved",
      "Attempted",
    ] as const)
      await journal.record({
        ...baseEntry,
        status,
        remoteIds: [],
        ...(["Approved", "Attempted"].includes(status)
          ? {
              approvalReference: "approval-" + entry.operationId,
              approvalConsumptionId: "consumption-" + entry.operationId,
            }
          : {}),
      });
    const approved = {
      ...entry,
      approvalReference: "approval-" + entry.operationId,
      approvalConsumptionId: "consumption-" + entry.operationId,
    };
    if (entry.status === "Reconciled") {
      await journal.record({
        ...approved,
        status: "Uncertain",
        remoteIds: [],
        reconciliation: "pending",
      });
      await journal.record({
        ...approved,
        reconciliation,
        reconciliationEvidenceDigest: base.payloadDigest,
      });
    } else await journal.record(approved);
  }
  const state = {
    posts: 0,
    malformed: false,
    lost: false,
    drift: false,
    run: { ...emptyRun } as Omit<
      typeof emptyRun,
      "startedOn" | "finishedOn"
    > & { startedOn: string | null; finishedOn: string | null },
  };
  const ports = {
    read: {
      ...read,
      async getAllRuns() {
        return [state.run];
      },
      async getTest() {
        const current = await read.getTest();
        return state.drift
          ? { ...current, unstructured: "unrelated" }
          : current;
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
    fetch: (async (url, init) => {
      assert.equal(
        url,
        "https://xray.cloud.getxray.app/api/v2/import/execution",
      );
      assert.equal(init?.method, "POST");
      assert.equal((await journal.latestEntries()).at(-1)?.status, "Attempted");
      state.posts++;
      const { testExecutionKey, tests } = JSON.parse(String(init?.body));
      assert.equal(testExecutionKey, "KAN-27");
      assert.equal(tests.length, 1);
      const [result] = tests;
      assert.equal(result.testKey, "KAN-26");
      assert.equal(result.status, "PASSED");
      state.run = {
        ...state.run,
        status: { name: "PASSED" },
        startedOn: result.start,
        finishedOn: result.finish,
        comment: result.comment,
      };
      if (state.lost) throw new Error("mock lost response");
      if (state.malformed) return Response.json({ unexpected: true });
      return Response.json({ id: "10067", key: "KAN-27" });
    }) satisfies typeof fetch,
  };
  return { journal, state, ports };
}

test("D dispatches once, confirms exact readback, and preserves A through C", async (t) => {
  const { journal, state, ports } = await importFixture(t);
  const before = await journal.latestEntries();
  const result = await runLocalImport(evidenceRoot, journal, ports);
  assert.equal(result.status, "CONFIRMED");
  assert.deepEqual((await journal.latestEntries()).slice(0, 3), before);
  assert.equal((await journal.latestEntries()).at(-1)?.status, "Confirmed");
  await assert.rejects(
    runLocalImport(evidenceRoot, journal, ports),
    /IMPORT_ALREADY_JOURNALED/,
  );
  assert.equal(state.posts, 1);
});

test("D rejects incorrect approval and evidence identity drift after approval", async (t) => {
  const { journal, state, ports } = await importFixture(t);
  await assert.rejects(
    runLocalImport(evidenceRoot, journal, {
      ...ports,
      async confirm() {
        return "APPROVE wrong";
      },
    }),
    /LOCAL_APPROVAL_DENIED_OR_EXPIRED/,
  );
  await assert.rejects(
    runLocalImport(evidenceRoot, journal, {
      ...ports,
      async confirm(display) {
        state.drift = true;
        return ports.confirm(display);
      },
    }),
    /IMPORT_TEST_OR_COVERAGE_MISMATCH/,
  );
  assert.equal(state.posts, 0);
  assert.equal((await journal.latestEntries()).length, 3);
});

test("D keeps malformed responses uncertain and requires matching timestamps and comment to reconcile", async (t) => {
  const { journal, state, ports } = await importFixture(t);
  state.malformed = true;
  assert.equal(
    (await runLocalImport(evidenceRoot, journal, ports)).status,
    "UNCERTAIN_RUN_RECONCILE_IMPORT",
  );
  const verified = state.run;
  state.run = { ...verified, finishedOn: "2026-11-16T09:44:40.000Z" };
  assert.equal(
    (await reconcileLocalImport(evidenceRoot, journal, ports.read)).status,
    "RECONCILIATION_REQUIRED",
  );
  state.run = { ...verified, comment: "Other evidence" };
  assert.equal(
    (await reconcileLocalImport(evidenceRoot, journal, ports.read)).status,
    "RECONCILIATION_REQUIRED",
  );
  for (const comment of [
    verified.comment.slice(0, -2),
    verified.comment + "\n",
    verified.comment.slice(0, -1) + " ",
  ]) {
    state.run = { ...verified, comment };
    assert.equal(
      (await reconcileLocalImport(evidenceRoot, journal, ports.read)).status,
      "RECONCILIATION_REQUIRED",
    );
  }
  state.run = { ...verified, id: "other-test-run" };
  assert.equal(
    (await reconcileLocalImport(evidenceRoot, journal, ports.read)).status,
    "RECONCILIATION_REQUIRED",
  );
  assert.equal(state.posts, 1);
});

test("D reconciles when Xray removes exactly the final newline", async (t) => {
  const { journal, state, ports } = await importFixture(t);
  state.lost = true;
  assert.equal(
    (await runLocalImport(evidenceRoot, journal, ports)).status,
    "UNCERTAIN_RUN_RECONCILE_IMPORT",
  );
  assert.ok(state.run.comment.endsWith("\n"));
  state.run = { ...state.run, comment: state.run.comment.slice(0, -1) };
  assert.equal(
    (await reconcileLocalImport(evidenceRoot, journal, ports.read)).status,
    "RECONCILED",
  );
  assert.equal(state.posts, 1);
});

test("D reconciles a lost response by reading the original Test Run, without another POST", async (t) => {
  const { journal, state, ports } = await importFixture(t);
  state.lost = true;
  assert.equal(
    (await runLocalImport(evidenceRoot, journal, ports)).status,
    "UNCERTAIN_RUN_RECONCILE_IMPORT",
  );
  assert.equal(
    (await reconcileLocalImport(evidenceRoot, journal, ports.read)).status,
    "RECONCILED",
  );
  assert.equal(
    (await journal.latestEntries()).at(-1)?.reconciliation,
    "confirmed",
  );
  assert.equal(state.posts, 1);
});

test("D concurrent approvals dispatch at most one import", async (t) => {
  const { journal, state, ports } = await importFixture(t);
  let prompts = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const start = () =>
    runLocalImport(evidenceRoot, journal, {
      ...ports,
      async confirm(display) {
        if (++prompts === 2) release();
        await barrier;
        return ports.confirm(display);
      },
    });
  const results = await Promise.allSettled([start(), start()]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(state.posts, 1);
});

test("D previews one registered completed Playwright pass into the reconciled execution", async () => {
  const preview = await previewLocalImport(evidenceRoot, entries, read);
  assert.equal(preview.request.path, "/api/v2/import/execution");
  assert.deepEqual(Object.keys(preview.request.body), [
    "testExecutionKey",
    "tests",
  ]);
  assert.equal(preview.request.body.testExecutionKey, "KAN-27");
  assert.equal(preview.request.body.tests.length, 1);
  assert.equal(preview.request.body.tests[0]?.testKey, "KAN-26");
  assert.equal(preview.request.body.tests[0]?.status, "PASSED");
  assert.equal(preview.request.body.tests[0]?.finish, fixtureFinish);
  const { fingerprint, ...review } = preview;
  assert.equal(fingerprint, objectDigest(review));
});

test("D rejects stale journal evidence and altered bytes", async () => {
  await assert.rejects(
    previewLocalImport(
      evidenceRoot,
      [
        { ...entries[0]!, evidenceDigest: base.payloadDigest },
        ...entries.slice(1),
      ],
      read,
    ),
    /IMPORT_EVIDENCE_STALE/,
  );
  const registry = await IdentityRegistry.load(evidenceRoot, registryFile);
  const identity = registry.list()[0]!;
  const run = identity.binding!.historicalExecutions.find(
    (entry) => entry.runId === "phase5d-20261116-150241",
  )!;
  const bytes = await readFile(join(evidenceRoot, run.artifactPath));
  assert.throws(
    () =>
      selectedPlaywrightResult(
        Buffer.concat([bytes, Buffer.from(" ")]),
        identity,
      ),
    /ARTIFACT_OR_IDENTITY_MISMATCH/,
  );
  assert.throws(
    () =>
      selectedPlaywrightResult(bytes, {
        ...identity,
        automationId: "other-case",
      }),
    /ARTIFACT_OR_IDENTITY_MISMATCH/,
  );
});

test("D refuses an already populated remote run and an uncertain local import", async () => {
  await assert.rejects(
    previewLocalImport(evidenceRoot, entries, {
      ...read,
      async getAllRuns() {
        return [
          { ...emptyRun, status: { name: "PASSED" }, comment: "Prior result" },
        ];
      },
    }),
    /ALREADY_POPULATED_OR_UNVERIFIABLE/,
  );
  await assert.rejects(
    previewLocalImport(
      evidenceRoot,
      [
        ...entries,
        {
          ...entries[0]!,
          operation: "xray.results.import",
          status: "Uncertain",
        },
      ],
      read,
    ),
    /IMPORT_ALREADY_JOURNALED/,
  );
});

test("D refuses ambiguous remote results and mismatched run membership", async () => {
  await assert.rejects(
    previewLocalImport(evidenceRoot, entries, {
      ...read,
      async getAllRuns() {
        return [emptyRun, { ...emptyRun, id: "another" }];
      },
    }),
    /IMPORT_RUN_IDENTITY_UNVERIFIED/,
  );
  await assert.rejects(
    previewLocalImport(evidenceRoot, entries, {
      ...read,
      async getAllRuns() {
        return [{ ...emptyRun, test: { issueId: "10000" } }];
      },
    }),
    /IMPORT_RUN_IDENTITY_UNVERIFIED/,
  );
});
