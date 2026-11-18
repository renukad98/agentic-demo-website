import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { XrayHttpReadTransport } from "../../tools/xray/clients/transport.js";
import { XrayReadClient } from "../../tools/xray/clients/index.js";
import {
  previewLocalManual,
  reconcileLocalManual,
  runLocalManual,
} from "../../tools/xray/local-manual.js";
import {
  manualVariables,
  parseManualCase,
} from "../../tools/xray/manual-plan.js";
import { OperationJournal } from "../../tools/xray/operation-journal.js";

import {
  createDemoEvidenceFixture,
  manualCaseFile,
} from "./support/local-demo-evidence.js";

const evidenceRoot = await createDemoEvidenceFixture();

const caseId = "TM-TC-22";
const root = evidenceRoot;
const artifact = join(root, manualCaseFile);

test("manual mapping preserves reviewed numbering, action, data, oracle and traceability", async () => {
  const source = await readFile(artifact, "utf8");
  const plan = parseManualCase(source, caseId);
  assert.deepEqual(plan.requirements, ["TM-REQ-014", "TM-REQ-015"]);
  assert.deepEqual(plan.acceptance, ["TM-AC-19"]);
  assert.deepEqual(
    plan.steps.map(({ number }) => number),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.equal(
    plan.preconditionsAndData,
    "Synthetic controls and isolated fixture.",
  );
  assert.match(plan.steps[0]!.data, /Sample input 1/);
  assert.match(plan.steps[0]!.action, /^Act on fixture 1/);
  assert.match(plan.steps[0]!.result, /Observe fixture 1/);
  const legacy = parseManualCase(source, "TM-TC-01");
  assert.equal(legacy.steps[0]?.data, legacy.preconditionsAndData);
  const row = "| 1 | Act on fixture 1.";
  assert.throws(
    () =>
      parseManualCase(source.replace(row, "| 2 | Act on fixture 1."), caseId),
    /MANUAL_STEP_NUMBER/,
  );
  assert.throws(
    () =>
      parseManualCase(
        source.replace(
          "- Preconditions/data: Synthetic controls and isolated fixture.",
          "",
        ),
        caseId,
      ),
    /MANUAL_CASE_FIELD/,
  );
  assert.throws(() => parseManualCase(source.replace(row, "| 1 | "), caseId));
  assert.throws(() => parseManualCase(source, "TM-TC-24"), /DELIVERY_AUDIT/);
});

type RemoteManual = NonNullable<
  Awaited<ReturnType<XrayReadClient["getManualTest"]>>
>;
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "xray-manual-demo-"));
  const journal = new OperationJournal(directory);
  t.after(async () => {
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  });
  const state = {
    remote: null as RemoteManual | null,
    posts: 0,
    malformed: false,
    lost: false,
    badStep: false,
  };
  const tokens = {
    async getToken() {
      return "synthetic-token";
    },
    invalidate() {},
  };
  const ports = {
    tokens,
    read: {
      async searchTests() {
        return state.remote ? [state.remote] : [];
      },
      async getManualTest() {
        return state.remote;
      },
    },
    async confirm(display: string) {
      return "APPROVE " + JSON.parse(display).fingerprint;
    },
    fetch: (async (url, options) => {
      assert.equal(url, "https://xray.cloud.getxray.app/api/v2/graphql");
      assert.equal(options?.method, "POST");
      assert.equal((await journal.latestEntries())[0]?.status, "Attempted");
      const body = JSON.parse(String(options?.body));
      const variables = manualVariables.parse(body.variables);
      assert.match(
        body.query,
        /createTest\(testType: \$testType, steps: \$steps/,
      );
      const { summary, description } = variables.jira.fields;
      state.posts++;
      state.remote = {
        issueId: "30001",
        jira: {
          key: "KAN-99",
          summary,
          description,
          created: new Date().toISOString(),
        },
        testType: { name: "Manual" },
        steps: state.badStep
          ? [{ ...variables.steps[0]!, result: "Wrong result" }]
          : variables.steps,
      };
      if (state.lost) throw new Error("mock lost response");
      if (state.malformed) return Response.json({ data: { createTest: {} } });
      return Response.json({
        data: { createTest: { test: state.remote, warnings: [] } },
      });
    }) satisfies typeof fetch,
  };
  return { journal, state, ports };
}

test("manual preview makes no write and approval dispatches one exact structured request", async (t) => {
  const { journal, state, ports } = await fixture(t);
  const preview = await previewLocalManual(root, caseId, journal, ports.read);
  assert.equal(preview.steps.length, 9);
  assert.deepEqual(
    preview.request.body.variables.steps,
    preview.steps.map(({ action, data, result }) => ({ action, data, result })),
  );
  assert.equal(state.posts, 0);
  assert.deepEqual(
    await runLocalManual(root, caseId, journal, {
      ...ports,
      async confirm(display) {
        assert.deepEqual(JSON.parse(display), preview);
        return ports.confirm(display);
      },
    }),
    { status: "CONFIRMED", key: "KAN-99", issueId: "30001" },
  );
  await assert.rejects(
    runLocalManual(root, caseId, journal, ports),
    /ALREADY_JOURNALED/,
  );
  assert.equal(state.posts, 1);
});

test("manual path refuses invalid approval and detects a renamed remote duplicate", async (t) => {
  const { journal, state, ports } = await fixture(t);
  const preview = await previewLocalManual(root, caseId, journal, ports.read);
  await assert.rejects(
    runLocalManual(root, caseId, journal, {
      ...ports,
      async confirm() {
        return "APPROVE wrong";
      },
    }),
    /LOCAL_APPROVAL_DENIED_OR_EXPIRED/,
  );
  state.remote = {
    issueId: "30001",
    testType: { name: "Manual" },
    jira: {
      key: "KAN-99",
      summary: "Renamed",
      description: preview.request.body.variables.jira.fields.description,
    },
    steps: [],
  };
  await assert.rejects(
    runLocalManual(root, caseId, journal, ports),
    /POSSIBLE_DUPLICATE/,
  );
  assert.equal(state.posts, 0);
});

test("manual reconciliation verifies a lost response with a unique exact candidate", async (t) => {
  const { journal, state, ports } = await fixture(t);
  state.lost = true;
  assert.equal(
    (await runLocalManual(root, caseId, journal, ports)).status,
    "UNCERTAIN_RUN_RECONCILE_MANUAL",
  );
  assert.equal(
    (await reconcileLocalManual(root, caseId, journal, ports.read)).status,
    "RECONCILED",
  );
  assert.equal(state.posts, 1);
});

test("manual malformed response and mismatched step leave the journal uncertain", async (t) => {
  const { journal, state, ports } = await fixture(t);
  state.malformed = state.badStep = true;
  assert.equal(
    (await runLocalManual(root, caseId, journal, ports)).status,
    "UNCERTAIN_RUN_RECONCILE_MANUAL",
  );
  assert.equal(
    (await reconcileLocalManual(root, caseId, journal, ports.read)).status,
    "MANUAL_RECONCILIATION_BLOCKED",
  );
  assert.equal((await journal.latestEntries())[0]?.status, "Uncertain");
  assert.equal(state.posts, 1);
});

test("manual read transport retains structured steps and rejects mismatched IDs", async () => {
  let issueId = "30001";
  const client = new XrayReadClient(
    new XrayHttpReadTransport({
      apiBase: "https://xray.cloud.getxray.app",
      tokens: {
        async getToken() {
          return "synthetic-token";
        },
        invalidate() {},
      },
      retries: 0,
      async fetch() {
        return Response.json({
          data: {
            getTest: {
              issueId,
              jira: { key: "KAN-99", description: "Preconditions" },
              testType: { name: "Manual" },
              steps: [{ action: "Act", data: "Input", result: "Observe" }],
            },
          },
        });
      },
    }),
  );
  assert.equal(
    (await client.getManualTest("30001"))?.steps?.[0]?.result,
    "Observe",
  );
  issueId = "30002";
  await assert.rejects(client.getManualTest("30001"), /MALFORMED_RESPONSE/);
});
