import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ApprovalEvidenceGate } from "../agentic/approvals.js";
import {
  fingerprint,
  noSymlinks,
  objectDigest,
  within,
} from "../agentic/artifacts.js";
import type { JournalReservationRequest } from "../agentic/journal-reservation.js";
import type { TokenProvider } from "./clients/authentication.js";
import type { XrayReadClient } from "./clients/index.js";
import {
  kan29ManualCaseId,
  localManualCaseId,
  manualMutation,
  manualStep,
  manualVariables,
  parseManualCase,
} from "./manual-plan.js";
import type { OperationJournal } from "./operation-journal.js";
import { XrayPublicationTransport } from "./publication-transport.js";
import { writeOperationId } from "./write-integration.js";

const artifact =
  "artifacts/qa/KAN-25/orchestration-demo-20261117-100046/test-cases.md";
const origin = "https://xray.cloud.getxray.app";
const tenant = "renudhamankar98.atlassian.net";
const kan29Artifact =
  "artifacts/qa/KAN-29/publication-manual-01/manual-tests.json";
const kan29ApprovedDigest =
  "sha256:dbf35d25704c33b64e040057d057e52be9fe3ab71e71b35d583d496acdc873a3";
const projectKey = "KAN";
const operation = "xray.test.create";
function storyFor(caseId: string) {
  return localManualCaseId.parse(caseId).startsWith("KAN-29-")
    ? "KAN-29"
    : "KAN-25";
}
const caseIdentity = (caseId: string) =>
  "agentic-demo-website:manual:" + storyFor(caseId) + ":" + caseId;
type Read = Pick<XrayReadClient, "searchTests" | "getManualTest">;
type RemoteTest = NonNullable<Awaited<ReturnType<Read["getManualTest"]>>>;
type Plan = Awaited<ReturnType<typeof manualPlan>>;

const approvedCase = z
  .object({
    projectKey: z.literal("KAN"),
    testCaseId: kan29ManualCaseId,
    summary: z.string().min(1).max(255),
    description: z.string().min(1),
    steps: z.array(manualStep).min(1).max(100),
  })
  .strict();

async function manualPlan(root: string, caseId: string) {
  const story = storyFor(caseId);
  const artifactPath = story === "KAN-29" ? kan29Artifact : artifact;
  const source = within(root, artifactPath);
  await noSymlinks(root, source);
  const bytes = await readFile(source);
  const sourceDigest = fingerprint(bytes);
  const approved = story === "KAN-29" ? readApprovedCase() : undefined;
  function readApprovedCase() {
    if (sourceDigest !== kan29ApprovedDigest)
      throw new Error("KAN29_APPROVED_MANUAL_MANIFEST_CHANGED");
    const cases = z
      .array(approvedCase)
      .length(14)
      .parse(JSON.parse(bytes.toString("utf8")));
    const selected = cases.find((item) => item.testCaseId === caseId);
    if (
      new Set(cases.map((item) => item.testCaseId)).size !== 14 ||
      !selected ||
      !selected.summary.startsWith(caseId + ": ")
    )
      throw new Error("KAN29_APPROVED_MANUAL_CASE_INVALID");
    return selected;
  }
  const scenario = approved
    ? {
        caseId,
        title: approved.summary.slice(caseId.length + 2),
        steps: approved.steps.map((step, index) => ({
          number: index + 1,
          ...step,
        })),
        description: approved.description,
      }
    : parseManualCase(bytes.toString("utf8"), caseId);
  const evidenceDigest = objectDigest(scenario);
  const identity = caseIdentity(caseId);
  const description = [
    "Manual case: " + identity,
    "Story: " + story,
    ...("description" in scenario
      ? [scenario.description]
      : [
          "Preconditions and test data: " + scenario.preconditionsAndData,
          "Requirements: " + scenario.requirements.join(", "),
          "Acceptance criteria: " + scenario.acceptance.join(", "),
        ]),
    "Source: " + artifactPath,
    "Source digest: " + sourceDigest,
  ].join("\n");
  const variables = manualVariables.parse({
    testType: { name: "Manual" },
    steps: scenario.steps.map(({ action, data, result }) => ({
      action,
      data,
      result,
    })),
    jira: {
      fields: {
        project: { key: projectKey, id: "10001" },
        issuetype: { id: "10045" },
        reporter: { accountId: "712020:a8fac447-b5f9-4da3-a23a-bb24d61b4baa" },
        summary: caseId + ": " + scenario.title,
        description,
      },
    },
  });
  const payload = { mutation: "createTest", query: manualMutation, variables };
  const proposal = {
    schemaVersion: "1.0.0",
    operation,
    storyKey: story,
    target: story,
    payload,
    payloadDigest: objectDigest(payload),
    evidenceDigest,
    remoteWritesEnabled: false,
  };
  const review = {
    operation,
    tenant,
    story,
    projectKey,
    testType: "Manual",
    identity,
    sourceDigest,
    evidenceDigest,
    ...scenario,
    request: {
      method: "POST",
      origin,
      path: "/api/v2/graphql",
      body: { query: manualMutation, variables },
    },
  };
  return { proposal, review: { ...review, fingerprint: objectDigest(review) } };
}

async function candidates(plan: Plan, read: Read) {
  const tests = await read.searchTests(projectKey);
  const matches: RemoteTest[] = [];
  for (const item of tests) {
    if (item.testType.name !== "Manual") continue;
    const full = await read.getManualTest(item.issueId);
    if (
      !full ||
      full.issueId !== item.issueId ||
      full.jira.key !== item.jira.key ||
      !full.jira.key.startsWith(projectKey + "-") ||
      full.testType.name !== "Manual"
    )
      throw new Error("MANUAL_DUPLICATE_INVENTORY_CHANGED");
    if (
      full.jira.description
        ?.split(/\r?\n/)
        .includes("Manual case: " + plan.review.identity) ||
      full.jira.summary?.startsWith(plan.review.caseId + ":") ||
      full.jira.summary === plan.review.title ||
      (full.steps &&
        objectDigest(full.steps) ===
          objectDigest(plan.proposal.payload.variables.steps))
    )
      matches.push(full);
  }
  return matches;
}

function verified(
  plan: Plan,
  test: RemoteTest | null,
  id: string,
  key: string,
) {
  const fields = plan.proposal.payload.variables.jira.fields;
  return (
    !!test &&
    test.issueId === id &&
    test.jira.key === key &&
    /^KAN-[1-9][0-9]*$/.test(key) &&
    test.testType.name === "Manual" &&
    test.jira.summary === fields.summary &&
    test.jira.description === fields.description &&
    objectDigest(test.steps ?? []) ===
      objectDigest(plan.proposal.payload.variables.steps)
  );
}

async function prepare(
  root: string,
  caseId: string,
  journal: OperationJournal,
  read: Read,
) {
  const plan = await manualPlan(root, caseId);
  if (
    (await journal.findCreation(tenant, projectKey, plan.review.identity))
      .length
  )
    throw new Error("MANUAL_CREATION_ALREADY_JOURNALED");
  if ((await candidates(plan, read)).length)
    throw new Error("POSSIBLE_DUPLICATE_MANUAL_TEST");
  return plan;
}
export async function previewLocalManual(
  root: string,
  caseId: string,
  journal: OperationJournal,
  read: Read,
) {
  return (await prepare(root, caseId, journal, read)).review;
}

export async function reconcileLocalManual(
  root: string,
  caseId: string,
  journal: OperationJournal,
  read: Read,
) {
  const entries = await journal.findCreation(
    tenant,
    projectKey,
    caseIdentity(caseId),
  );
  if (!entries.length) return { status: "NO_MANUAL_ATTEMPT" };
  const [prior] = entries;
  if (
    entries.length !== 1 ||
    !prior ||
    !["Attempted", "Uncertain"].includes(prior.status)
  )
    return { status: "MANUAL_RECONCILIATION_BLOCKED" };
  const plan = await manualPlan(root, caseId);
  if (
    prior.payloadDigest !== plan.proposal.payloadDigest ||
    (await journal.reservationFingerprint(prior.operationId)) !==
      plan.review.fingerprint
  )
    return { status: "MANUAL_RECONCILIATION_BLOCKED" };
  const matches =
    prior.remoteIds.length === 1 && prior.remoteTestKey
      ? [await read.getManualTest(prior.remoteIds[0]!)]
      : await candidates(plan, read);
  const [match] = matches;
  if (
    matches.length !== 1 ||
    !match ||
    !verified(
      plan,
      match,
      prior.remoteIds[0] ?? match.issueId,
      prior.remoteTestKey ?? match.jira.key,
    )
  )
    return { status: "MANUAL_RECONCILIATION_BLOCKED" };
  if (!prior.remoteIds.length) {
    const attempt = (await journal.entries(prior.operationId)).find(
      (entry) => entry.status === "Attempted",
    );
    const created = Date.parse(match.jira.created ?? "");
    if (
      !attempt ||
      !Number.isFinite(created) ||
      created < Date.parse(attempt.at)
    )
      return { status: "MANUAL_RECONCILIATION_BLOCKED" };
  }
  const at = new Date().toISOString();
  if (prior.status === "Attempted")
    await journal.record({
      ...prior,
      status: "Uncertain",
      reconciliation: "pending",
      at,
    });
  await journal.record({
    ...prior,
    status: "Reconciled",
    reconciliation: "confirmed",
    at,
    remoteIds: [match.issueId],
    remoteTestKey: match.jira.key,
    reconciliationEvidenceDigest: objectDigest(match),
  });
  return { status: "RECONCILED", key: match.jira.key, issueId: match.issueId };
}

type Ports = {
  read: Read;
  fetch: typeof fetch;
  tokens: TokenProvider;
  confirm: (display: string) => Promise<string>;
  now?: () => number;
};
const responseSchema = z.object({
  data: z.object({
    createTest: z.object({
      test: z.object({
        issueId: z.string().regex(/^[1-9][0-9]*$/),
        jira: z.object({
          key: z.string().regex(/^KAN-[1-9][0-9]*$/),
        }),
      }),
      warnings: z.array(z.unknown()).nullish(),
    }),
  }),
});

export async function runLocalManual(
  root: string,
  caseId: string,
  journal: OperationJournal,
  ports: Ports,
) {
  if (
    ports.fetch === globalThis.fetch &&
    (!process.stdin.isTTY || !process.stdout.isTTY)
  )
    throw new Error("INTERACTIVE_TERMINAL_REQUIRED");
  const now = ports.now ?? Date.now;
  const at = () => new Date(now()).toISOString();
  const plan = await prepare(root, caseId, journal, ports.read);
  const { proposal, review } = plan;
  const deadline = now() + 120_000;
  if (
    (await ports.confirm(JSON.stringify(review, null, 2))) !==
      "APPROVE " + review.fingerprint ||
    now() >= deadline
  )
    throw new Error("LOCAL_APPROVAL_DENIED_OR_EXPIRED");
  const issuedAt = at();
  const fresh = await prepare(root, caseId, journal, ports.read);
  if (fresh.review.fingerprint !== review.fingerprint)
    throw new Error("MANUAL_APPROVAL_STALE");
  const { payloadDigest, evidenceDigest } = proposal;
  const request: JournalReservationRequest = {
    schemaVersion: "1.0.0",
    tenant,
    projectKey,
    operation,
    target: review.story,
    automationIdentity: review.identity,
    payloadDigest,
    evidenceDigest,
    sourceDigest: review.sourceDigest,
    operationId: writeOperationId({
      tenant,
      projectKey,
      operation,
      payloadDigest,
    }),
    scope: [operation],
    preflightDigest: review.fingerprint,
    executorPrincipal: "windows-local-demo",
    authorityEpoch: "local-demo-v1",
    policyVersion: "json-offline-v1",
  };
  const approvalId = randomUUID();
  const gate = new ApprovalEvidenceGate({
    async verify(reference, _, requestDigest) {
      if (
        reference !== approvalId ||
        requestDigest !== objectDigest(request) ||
        now() >= deadline
      )
        throw new Error("LOCAL_APPROVAL_DENIED_OR_EXPIRED");
      return {
        schemaVersion: "1.0.0",
        approvalId,
        requestDigest,
        decision: "approved",
        authorityId: "windows-local-demo",
        humanReference: "interactive-terminal",
        issuedAt,
        expiresAt: new Date(deadline).toISOString(),
      };
    },
  });
  const handle = await gate.verify(approvalId, request);
  const reserved = await journal.consumeAndReserve(
    request,
    proposal.payload,
    handle,
  );
  const attempted = {
    ...reserved.entry,
    status: "Attempted" as const,
    at: at(),
  };
  const ticket = await journal.record(attempted, request);
  if (!ticket) throw new Error("LOCAL_MANUAL_ATTEMPT_REQUIRED");
  let observed:
    z.infer<typeof responseSchema>["data"]["createTest"]["test"] | undefined;
  try {
    const {
      data: { createTest },
    } = responseSchema.parse(
      await new XrayPublicationTransport(origin).executeLocalManual(
        proposal,
        ports,
        ticket,
      ),
    );
    observed = createTest.test;
    const {
      issueId,
      jira: { key },
    } = observed;
    if (
      createTest.warnings?.length ||
      !verified(plan, await ports.read.getManualTest(issueId), issueId, key)
    )
      throw new Error("MANUAL_READBACK_UNCERTAIN");
    await journal.record({
      ...attempted,
      status: "Confirmed",
      remoteIds: [issueId],
      remoteTestKey: key,
      at: at(),
    });
    return { status: "CONFIRMED", key, issueId };
  } catch {
    await journal.record({
      ...attempted,
      status: "Uncertain",
      reconciliation: "pending",
      errorCode: "TRANSPORT",
      at: at(),
      ...(observed
        ? { remoteIds: [observed.issueId], remoteTestKey: observed.jira.key }
        : {}),
    });
    return { status: "UNCERTAIN_RUN_RECONCILE_MANUAL" };
  }
}
