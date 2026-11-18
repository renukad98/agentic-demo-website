import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApprovalEvidenceGate } from "../agentic/approvals.js";
import { objectDigest } from "../agentic/artifacts.js";
import type { JournalReservationRequest } from "../agentic/journal-reservation.js";
import { limitedJson } from "./clients/http.js";
import type { XrayReadClient } from "./clients/index.js";
import { localLinkPreview } from "./local-link-preview.js";
import { localLinkTargets, type LocalLinkTarget } from "./local-link-target.js";
import { OperationJournal, takeLocalLinkAttempt } from "./operation-journal.js";
import { writeOperationId } from "./write-integration.js";

const tenant = "renudhamankar98.atlassian.net";
const origin = "https://" + tenant;
const story = "KAN-25";
const operation = "jira.test.link";
const type = {
  id: "10037",
  name: "Test",
  inward: "is tested by",
  outward: "tests",
};
const id = z.string().regex(/^[1-9][0-9]*$/);
const link = z.object({
  id,
  type: z.object({ id, name: z.string() }),
  inwardIssue: z.object({ key: z.string() }).optional(),
  outwardIssue: z.object({ key: z.string() }).optional(),
});
const issue = z.object({
  id,
  key: z.string(),
  fields: z.object({ issuetype: z.object({ id }), issuelinks: z.array(link) }),
});

function restReview(reviewFingerprint: string, testKey: LocalLinkTarget) {
  const testId = localLinkTargets[testKey].issueId;
  const display = {
    operation,
    tenant,
    story,
    testKey,
    testIssueId: testId,
    direction: testKey + " tests " + story,
    previousReviewFingerprint: reviewFingerprint,
    request: {
      method: "POST",
      url: origin + "/rest/api/3/issueLink",
      // The Test is the inward end. From the Test, Jira exposes the Story as outwardIssue.
      body: {
        type: { id: type.id },
        inwardIssue: { key: testKey },
        outwardIssue: { key: story },
      },
    },
  };
  return { ...display, fingerprint: objectDigest(display) };
}

export async function previewRestLink(
  journal: OperationJournal,
  testKey: LocalLinkTarget = "KAN-26",
) {
  return restReview(
    localLinkPreview(await journal.latestEntries(), testKey).fingerprint,
    testKey,
  );
}

type Ports = {
  fetch: typeof fetch;
  credentials: { baseUrl: string; email: string; token: string };
  xray: Pick<XrayReadClient, "getTest" | "getCoverage"> &
    Partial<Pick<XrayReadClient, "getManualTest">>;
  confirm?: (preview: string) => Promise<string>;
  previewOnly?: boolean;
  now?: () => number;
};

export async function runRestLink(
  journal: OperationJournal,
  ports: Ports,
  testKey: LocalLinkTarget = "KAN-26",
) {
  const target = localLinkTargets[testKey];
  const testId = target.issueId;
  if (
    ports.fetch === globalThis.fetch &&
    ports.confirm &&
    (!process.stdin.isTTY || !process.stdout.isTTY)
  )
    throw new Error("INTERACTIVE_TERMINAL_REQUIRED");
  const now = ports.now ?? Date.now;
  const { baseUrl, email, token } = ports.credentials;
  if (
    ![origin, origin + "/"].includes(baseUrl) ||
    !email.trim() ||
    !token.trim()
  )
    throw new Error("JIRA_CREDENTIALS_OR_ORIGIN_INVALID");
  const headers = {
    authorization:
      "Basic " + Buffer.from(email + ":" + token).toString("base64"),
    accept: "application/json",
  };
  const send = (url: string, body?: unknown) =>
    ports.fetch(url, {
      method: body ? "POST" : "GET",
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
      headers: {
        ...headers,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const get = async (path: string) => {
    const response = await send(origin + "/rest/api/3/" + path);
    if (!response.ok || response.redirected)
      throw new Error("JIRA_READ_FAILED");
    return limitedJson(response, 1024 * 1024);
  };
  const entries = await journal.latestEntries();
  const bEntries = entries.filter(
    (entry) =>
      entry.operation === operation &&
      entry.tenant === tenant &&
      entry.storyKey === story &&
      entry.remoteTestKey === testKey,
  );
  if (bEntries.length > 1) throw new Error("LINK_JOURNAL_AMBIGUOUS");
  const [prior] = bEntries;
  const aEntries = entries.filter((entry) => entry !== prior);
  if (prior && ports.previewOnly)
    throw new Error("CHECKPOINT_B_ALREADY_JOURNALED");
  const review = restReview(
    localLinkPreview(aEntries, testKey).fingerprint,
    testKey,
  );
  const creation = aEntries.find(
    (entry) =>
      entry.operation === "xray.test.create" &&
      entry.status === "Confirmed" &&
      entry.tenant === tenant &&
      entry.storyKey === story &&
      entry.automationIdentity === target.identity &&
      entry.remoteTestKey === testKey &&
      entry.remoteIds[0] === testId,
  );
  if (
    !creation?.sourceDigest ||
    !creation.evidenceDigest ||
    !creation.automationIdentity
  )
    throw new Error("CONFIRMED_TEST_EVIDENCE_REQUIRED");

  const observe = async () => {
    const fields = "?fields=issuetype,issuelinks";
    const [storyRaw, testRaw, metadata, xrayTest, coverage] = await Promise.all(
      [
        get("issue/" + story + fields),
        get("issue/" + testKey + fields),
        get("issueLinkType/" + type.id),
        ports.xray.getTest(testId),
        ports.xray.getCoverage(testId),
      ],
    );
    const requirement = issue.parse(storyRaw),
      test = issue.parse(testRaw);
    if (
      requirement.key !== story ||
      requirement.id !== "10065" ||
      requirement.fields.issuetype.id !== "10009" ||
      test.key !== testKey ||
      test.id !== testId ||
      test.fields.issuetype.id !== "10045" ||
      !z
        .object({
          id: z.literal(type.id),
          name: z.literal(type.name),
          inward: z.literal(type.inward),
          outward: z.literal(type.outward),
        })
        .safeParse(metadata).success ||
      xrayTest?.issueId !== testId ||
      xrayTest.jira.key !== testKey ||
      xrayTest.testType.name !== target.type ||
      (target.type === "Generic" &&
        xrayTest.unstructured !== creation.automationIdentity)
    )
      throw new Error("LINK_PREFLIGHT_MISMATCH");
    if (target.type === "Manual") {
      const manual = await ports.xray.getManualTest?.(testId);
      if (
        xrayTest.steps?.length !== 9 ||
        manual?.issueId !== testId ||
        manual.jira.key !== testKey ||
        manual.testType.name !== "Manual" ||
        manual.steps?.length !== 9 ||
        !manual.jira.description
          ?.split(/\r?\n/)
          .includes("Manual case: " + target.identity)
      )
        throw new Error("MANUAL_LINK_PREFLIGHT_MISMATCH");
    }
    const related = (links: z.infer<typeof link>[], key: string) =>
      links.filter(
        (item) =>
          (item.type.id === type.id || item.type.name === type.name) &&
          (item.inwardIssue?.key === key || item.outwardIssue?.key === key),
      );
    const fromTest = related(test.fields.issuelinks, story);
    const fromStory = related(requirement.fields.issuelinks, testKey);
    const [outward] = fromTest,
      [inward] = fromStory;
    const linkId =
      fromTest.length === 1 &&
      fromStory.length === 1 &&
      outward?.type.id === type.id &&
      inward?.type.id === type.id &&
      outward.outwardIssue?.key === story &&
      inward.inwardIssue?.key === testKey &&
      outward.id === inward.id
        ? outward.id
        : undefined;
    const coverageMatches = coverage.filter(
      (item) => item.jira.key === story || item.issueId === requirement.id,
    );
    const covered =
      coverageMatches.length === 1 &&
      coverageMatches[0]?.jira.key === story &&
      coverageMatches[0]?.issueId === requirement.id;
    return {
      linkId,
      covered,
      duplicate:
        coverageMatches.length > 0 ||
        fromTest.length > 0 ||
        fromStory.length > 0,
    };
  };
  const observed = await observe();
  const at = () => new Date(now()).toISOString();
  if (prior) {
    if (prior.status === "Confirmed" || prior.status === "Reconciled")
      return { status: "ALREADY_JOURNALED" };
    if (
      !["Attempted", "Uncertain"].includes(prior.status) ||
      (testKey === "KAN-28" &&
        (prior.payloadDigest !== objectDigest(review.request) ||
          (await journal.reservationFingerprint(prior.operationId)) !==
            review.fingerprint)) ||
      !observed.linkId ||
      !observed.covered
    )
      return { status: "RECONCILIATION_REQUIRED" };
    if (prior.status === "Attempted")
      await journal.record({
        ...prior,
        status: "Uncertain",
        reconciliation: "pending",
        at: at(),
      });
    await journal.record({
      ...prior,
      status: "Reconciled",
      reconciliation: "confirmed",
      reconciliationEvidenceDigest: objectDigest(observed),
      remoteIds: [observed.linkId],
      at: at(),
    });
    return { status: "RECONCILED", linkId: observed.linkId };
  }
  if (observed.duplicate) throw new Error("EXISTING_LINK_OR_COVERAGE");
  if (ports.previewOnly) return { status: "PREVIEW", ...review };
  if (!ports.confirm) return { status: "NO_LINK_ATTEMPT" };
  const deadline = now() + 120_000;
  const answer = await ports.confirm(JSON.stringify(review, null, 2));
  if (answer !== "APPROVE " + review.fingerprint || now() >= deadline)
    throw new Error("LOCAL_APPROVAL_DENIED_OR_EXPIRED");
  const issuedAt = at();
  if ((await observe()).duplicate) throw new Error("EXISTING_LINK_OR_COVERAGE");
  const payload = review.request;
  const payloadDigest = objectDigest(payload);
  const request: JournalReservationRequest = {
    schemaVersion: "1.0.0",
    tenant,
    projectKey: "KAN",
    operation,
    target: story,
    testKey,
    testIssueId: testId,
    payloadDigest,
    operationId: writeOperationId({
      tenant,
      projectKey: "KAN",
      operation,
      payloadDigest,
    }),
    automationIdentity: creation.automationIdentity,
    scope: [operation],
    sourceDigest: creation.sourceDigest,
    evidenceDigest: creation.evidenceDigest,
    preflightDigest: review.fingerprint,
    executorPrincipal: "windows-local-demo",
    authorityEpoch: "local-demo-v1",
    policyVersion: "json-offline-v1",
  };
  const approvalId = randomUUID(),
    digest = objectDigest(request);
  const gate = new ApprovalEvidenceGate({
    async verify(reference, _, requestDigest) {
      if (
        reference !== approvalId ||
        requestDigest !== digest ||
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
  const reservation = await journal.consumeAndReserve(request, payload, handle);
  const attempted = {
    ...reservation.entry,
    status: "Attempted" as const,
    at: at(),
  };
  const ticket = await journal.record(attempted, request);
  if (!ticket) throw new Error("LOCAL_LINK_ATTEMPT_REQUIRED");
  takeLocalLinkAttempt(ticket, objectDigest(payload));
  try {
    const response = await send(payload.url, payload.body);
    if (response.status !== 201 || response.redirected)
      throw new Error("LINK_RESPONSE_UNCERTAIN");
    const readback = await observe();
    if (!readback.linkId || !readback.covered)
      throw new Error("LINK_READBACK_UNCERTAIN");
    await journal.record({
      ...attempted,
      status: "Confirmed",
      remoteIds: [readback.linkId],
      at: at(),
    });
    return { status: "CONFIRMED", linkId: readback.linkId };
  } catch {
    await journal.record({
      ...attempted,
      status: "Uncertain",
      reconciliation: "pending",
      errorCode: "TRANSPORT",
      at: at(),
    });
    return { status: "UNCERTAIN_RUN_RECONCILE_LINK" };
  }
}
