import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { fingerprint, objectDigest } from "../agentic/artifacts.js";
import { resultSchema, type Identity } from "../agentic/contracts/index.js";
import type { XrayReadClient } from "./clients/index.js";
import { IdentityRegistry, identityKey, verifyBinding } from "./identity.js";
import type { OperationJournal } from "./operation-journal.js";
import { importProposal } from "./planner.js";
import { publicationRequest } from "./publication-transport.js";
import { verifyExecutionMembership } from "./publication-readback.js";

const story = "KAN-25";
const testKey = "KAN-26",
  testId = "10066";
const executionKey = "KAN-27",
  executionId = "10067";
const identityName =
  "agentic-demo-website:playwright:task-create-inflight-single-submit-v1";
const tenant = "renudhamankar98.atlassian.net";
const runId = "phase5d-20261116-150241";
const operation = "xray.results.import";
const spec = z.object({
  id: z.string(),
  title: z.string(),
  file: z.string(),
  tests: z.array(
    z.object({
      projectName: z.string(),
      status: z.string(),
      expectedStatus: z.string(),
      results: z
        .array(
          z.object({
            status: z.literal("passed"),
            retry: z.literal(0),
            duration: z.number().nonnegative(),
            startTime: z.string().datetime(),
            errors: z.array(z.unknown()).length(0),
          }),
        )
        .length(1),
    }),
  ),
});

export function selectedPlaywrightResult(body: Buffer, identity: Identity) {
  const run = identity.binding?.historicalExecutions.find(
    (entry) => entry.runId === runId,
  );
  if (
    !run ||
    identityKey(identity) !== identityName ||
    run.outcome !== "passed" ||
    run.projectName !== "chromium" ||
    fingerprint(body) !== run.artifactDigest
  )
    throw new Error("PLAYWRIGHT_ARTIFACT_OR_IDENTITY_MISMATCH");
  const report = z
    .object({
      suites: z.array(z.unknown()),
      errors: z.array(z.unknown()).length(0),
      stats: z.object({
        duration: z.number().positive(),
        expected: z.number().int().positive(),
        unexpected: z.literal(0),
        flaky: z.literal(0),
      }),
    })
    .parse(JSON.parse(body.toString("utf8").replace(/^\uFEFF/, "")));
  const matching: unknown[] = [];
  const walk = (suites: unknown[]) => {
    for (const raw of suites) {
      const suite = z
        .object({
          specs: z.array(z.unknown()).optional(),
          suites: z.array(z.unknown()).optional(),
        })
        .parse(raw);
      for (const candidate of suite.specs ?? []) {
        if (z.object({ id: z.string() }).parse(candidate).id === run.runnerId)
          matching.push(candidate);
      }
      walk(suite.suites ?? []);
    }
  };
  walk(report.suites);
  const selected = spec.parse(matching[0]);
  const tests = selected.tests.filter(
    (test) => test.projectName === run.projectName,
  );
  const [test] = tests,
    attempt = test?.results[0];
  const file = selected.file.replace(/\\/g, "/");
  if (
    matching.length !== 1 ||
    tests.length !== 1 ||
    !attempt ||
    selected.title !== run.testTitle ||
    selected.title !== identity.binding?.testTitle ||
    !(
      identity.sourceLocation === file ||
      identity.sourceLocation.endsWith("/" + file)
    ) ||
    test.status !== "expected" ||
    test.expectedStatus !== "passed"
  )
    throw new Error("PLAYWRIGHT_RESULT_NOT_AN_EXACT_PASS");
  return {
    evidence: {
      runId,
      artifactPath: run.artifactPath,
      artifactDigest: run.artifactDigest,
      runnerId: run.runnerId,
      projectName: run.projectName,
      testTitle: run.testTitle,
    },
    result: resultSchema.parse({
      identity: identityName,
      runner: "playwright",
      outcome: "passed",
      attempt: attempt.retry,
      startedAt: attempt.startTime,
      durationMs: attempt.duration,
      finishedAt: new Date(
        Date.parse(attempt.startTime) + attempt.duration,
      ).toISOString(),
      failures: [],
      evidence: [run.artifactPath],
      artifactDigest: run.artifactDigest,
    }),
  };
}

type Entries = Awaited<ReturnType<OperationJournal["latestEntries"]>>;
export type ImportRead = Pick<
  XrayReadClient,
  "getTest" | "getCoverage" | "getExecutionSnapshot" | "getAllRuns"
>;
export async function prepareLocalImport(
  root: string,
  entries: Entries,
  read: ImportRead,
  mode: "prepare" | "verify" = "prepare",
) {
  const scope = entries.filter(
    (entry) =>
      entry.tenant === tenant &&
      entry.projectKey === "KAN" &&
      entry.storyKey === story,
  );
  if (
    mode === "prepare" &&
    scope.some((entry) => entry.operation === operation)
  )
    throw new Error("IMPORT_ALREADY_JOURNALED_RECONCILE_BEFORE_REVIEW");
  const references = [
    ["xray.test.create", testId],
    ["jira.test.link", "10010"],
    ["xray.execution.create", executionId],
  ] as const;
  const confirmed = references.map(([kind, remoteId]) => {
    const matches = scope.filter(
      (entry) =>
        entry.operation === kind &&
        (entry.status === "Confirmed" ||
          (kind === "xray.execution.create" &&
            entry.status === "Reconciled" &&
            entry.reconciliation === "confirmed")) &&
        entry.remoteTestKey === testKey &&
        entry.automationIdentity === identityName &&
        entry.remoteIds.length === 1 &&
        entry.remoteIds[0] === remoteId &&
        (kind !== "xray.execution.create" ||
          entry.remoteExecutionKey === executionKey),
    );
    if (matches.length !== 1) throw new Error("CHECKPOINTS_A_B_C_REQUIRED");
    return matches[0]!;
  });
  const registry = await IdentityRegistry.load(
    root,
    "artifacts/qa/automation-identities/registry-v1.json",
  );
  const identity = registry
    .list()
    .find((item) => identityKey(item) === identityName);
  if (
    !identity ||
    (identity.xray &&
      (identity.xray.key !== testKey || identity.xray.issueId !== testId))
  )
    throw new Error("IMPORT_IDENTITY_MISMATCH");
  const binding = await verifyBinding(root, identity);
  if (
    confirmed.some(
      (entry) =>
        entry.sourceDigest !== binding.sourceDigest ||
        entry.evidenceDigest !== binding.evidenceDigest,
    )
  )
    throw new Error("IMPORT_EVIDENCE_STALE");
  const run = identity.binding?.historicalExecutions.find(
    (item) => item.runId === runId,
  );
  if (!run) throw new Error("REGISTERED_PLAYWRIGHT_RUN_MISSING");
  const { evidence, result } = selectedPlaywrightResult(
    await readFile(resolve(root, run.artifactPath)),
    identity,
  );
  const [test, coverage, execution, runs] = await Promise.all([
    read.getTest(testId),
    read.getCoverage(testId),
    read.getExecutionSnapshot(executionId),
    read.getAllRuns(executionId),
  ]);
  if (
    test?.issueId !== testId ||
    test.jira.key !== testKey ||
    test.testType.name !== "Generic" ||
    test.unstructured !== identityName ||
    !coverage.some(
      (item) => item.issueId === "10065" && item.jira.key === story,
    )
  )
    throw new Error("IMPORT_TEST_OR_COVERAGE_MISMATCH");
  if (
    !execution ||
    execution.projectId !== "10001" ||
    execution.testEnvironments.length !== 1 ||
    execution.testEnvironments[0] !== evidence.projectName
  )
    throw new Error("IMPORT_EXECUTION_ENVIRONMENT_MISMATCH");
  verifyExecutionMembership(
    { issueId: executionId, key: executionKey, testIssueIds: [testId] },
    [execution],
  );
  const [target] = runs;
  if (
    runs.length !== 1 ||
    !target ||
    target.test.issueId !== testId ||
    target.testExecution.issueId !== executionId
  )
    throw new Error("IMPORT_RUN_IDENTITY_UNVERIFIED");
  if (
    mode === "prepare" &&
    (target.status.name !== "TO DO" ||
      target.startedOn !== null ||
      target.finishedOn !== null ||
      target.comment === undefined ||
      Boolean(target.comment) ||
      target.evidence?.length !== 0)
  )
    throw new Error("IMPORT_RUN_ALREADY_POPULATED_OR_UNVERIFIABLE");
  const proposal = importProposal(
    story,
    executionKey,
    [result],
    [
      {
        ...identity,
        xray: {
          key: testKey,
          issueId: testId,
          behaviorDigest: identity.behaviorDigest,
          verifiedAt: confirmed[0]!.at,
        },
      },
    ],
    binding.evidenceDigest,
  );
  const wire = publicationRequest(proposal);
  if (wire.operation !== operation) throw new Error("INVALID_IMPORT_REQUEST");
  const review = {
    operation,
    tenant,
    story,
    testKey,
    testId,
    executionKey,
    executionId,
    testRunId: target.id,
    automationIdentity: identityName,
    ...binding,
    evidence,
    request: {
      method: "POST",
      origin: "https://xray.cloud.getxray.app",
      path: wire.path,
      body: wire.body,
    },
  };
  return {
    proposal,
    target,
    review: { ...review, fingerprint: objectDigest(review) },
  };
}

export async function previewLocalImport(
  root: string,
  entries: Entries,
  read: ImportRead,
) {
  return (await prepareLocalImport(root, entries, read)).review;
}
