import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { config } from "dotenv";
import { ApprovalEvidenceGate } from "../agentic/approvals.js";
import { objectDigest } from "../agentic/artifacts.js";
import type { JournalReservationRequest } from "../agentic/journal-reservation.js";
import { XrayTokenProvider } from "./clients/authentication.js";
import { XrayReadClient } from "./clients/index.js";
import { XrayHttpReadTransport } from "./clients/transport.js";
import { inspectGenericCreationResponse } from "./executor-preparation.js";
import { IdentityRegistry, identityKey, verifyBinding } from "./identity.js";
import { localLinkPreview } from "./local-link-preview.js";
import { localLinkTarget } from "./local-link-target.js";
import { previewLocalExecution } from "./local-execution-preview.js";
import { previewLocalImport } from "./local-import-preview.js";
import { reconcileLocalImport, runLocalImport } from "./local-import.js";
import {
  previewLocalManual,
  reconcileLocalManual,
  runLocalManual,
} from "./local-manual.js";
import { manualCaseId } from "./manual-plan.js";
import {
  reconcileLocalExecution,
  runLocalExecution,
} from "./local-execution.js";
import { previewRestLink, runRestLink } from "./local-link.js";
import { OperationJournal } from "./operation-journal.js";
import { duplicateDecision, genericProposal } from "./planner.js";
import {
  publicationRequest,
  XrayPublicationTransport,
} from "./publication-transport.js";
import { writeOperationId } from "./write-integration.js";

const origin = "https://xray.cloud.getxray.app";
const tenant = "renudhamankar98.atlassian.net";
const projectKey = "KAN";
const storyKey = "KAN-25";
const operation = "xray.test.create";
const registryPath = "artifacts/qa/automation-identities";
const approvalLifetime = 120_000;

async function prepare(root: string) {
  const registry = await IdentityRegistry.load(
    root,
    registryPath + "/registry-v1.json",
  );
  const identity = registry
    .list()
    .find(
      (item) =>
        item.automationId === "task-create-inflight-single-submit-v1" &&
        item.associations.some(
          (association) => association.storyKey === storyKey,
        ),
    );
  if (!identity || identity.xray)
    throw new Error("IDENTITY_UNAVAILABLE_OR_BOUND");
  const { sourceDigest, evidenceDigest } = await verifyBinding(root, identity);
  const proposal = genericProposal(
    storyKey,
    projectKey,
    identity,
    identity.binding!.testTitle,
    {
      projectId: "10001",
      issueTypeId: "10045",
      reporter: { accountId: "712020:a8fac447-b5f9-4da3-a23a-bb24d61b4baa" },
    },
  );
  const request = publicationRequest(proposal);
  const display = {
    operation,
    tenant,
    projectKey,
    storyKey,
    apiOrigin: origin,
    method: "POST",
    path: request.path,
    body: request.body,
    automationIdentity: identityKey(identity),
  };
  return {
    identity,
    proposal,
    display,
    sourceDigest,
    evidenceDigest,
    fingerprint: objectDigest(display),
  };
}

type Ports = {
  fetch: typeof globalThis.fetch;
  tokens: XrayTokenProvider;
  confirm: (preview: string) => Promise<string>;
  now?: () => number;
};

async function runLocalDemo(
  root: string,
  journal: OperationJournal,
  ports: Ports,
) {
  const now = ports.now ?? Date.now;
  const prepared = await prepare(root);
  const { identity, proposal, display, fingerprint } = prepared;
  const read = new XrayReadClient(
    new XrayHttpReadTransport({
      apiBase: origin,
      tokens: ports.tokens,
      fetch: ports.fetch,
      retries: 0,
    }),
  );
  const candidates = async () =>
    (await read.searchTests(projectKey)).filter(
      (test) => test.unstructured === display.automationIdentity,
    );
  const existing = await journal.findCreation(
    tenant,
    projectKey,
    display.automationIdentity,
  );
  if (existing.length) {
    // A missing result can reflect indexing delay. No automatic retry or cleared reservation.
    const matches = await candidates();
    const [entry] = existing;
    const [match] = matches;
    if (
      existing.length === 1 &&
      entry &&
      match &&
      matches.length === 1 &&
      ["Attempted", "Uncertain"].includes(entry.status) &&
      match.testType.name === "Generic" &&
      /^KAN-[1-9][0-9]*$/.test(match.jira.key) &&
      (!entry.remoteIds.length || entry.remoteIds[0] === match.issueId) &&
      (!entry.remoteTestKey || entry.remoteTestKey === match.jira.key)
    ) {
      const at = new Date(now()).toISOString();
      if (entry.status === "Attempted")
        await journal.record({
          ...entry,
          status: "Uncertain",
          reconciliation: "pending",
          at,
        });
      await journal.record({
        ...entry,
        status: "Reconciled",
        reconciliation: "confirmed",
        at,
        remoteIds: [match.issueId],
        remoteTestKey: match.jira.key,
        reconciliationEvidenceDigest: objectDigest(match),
      });
      return {
        status: "RECONCILED",
        key: match.jira.key,
        issueId: match.issueId,
      };
    }
    return {
      status: "EXISTING_ATTEMPT_REVIEW_REQUIRED",
      matches: matches.map((test) => ({
        issueId: test.issueId,
        key: test.jira.key,
        type: test.testType.name,
      })),
    };
  }
  const checkDuplicates = async () => {
    const matches = await candidates();
    // A remote Test does not carry our behavior digest. Treat any identity match as blocking.
    if (
      duplicateDecision(
        identity,
        matches.map((test) => ({
          key: test.jira.key,
          issueId: test.issueId,
          type: test.testType.name,
          identity: test.unstructured!,
          behaviorDigest: "",
        })),
        true,
      ).disposition !== "new"
    )
      throw new Error("DUPLICATE_TEST");
  };
  await checkDuplicates();
  const deadline = now() + approvalLifetime;
  const answer = await ports.confirm(
    JSON.stringify({ ...display, fingerprint }, null, 2),
  );
  if (answer !== "APPROVE " + fingerprint || now() >= deadline)
    throw new Error("LOCAL_APPROVAL_DENIED_OR_EXPIRED");
  const issued = now();
  await checkDuplicates();
  const fresh = await prepare(root);
  if (
    fresh.fingerprint !== fingerprint ||
    fresh.sourceDigest !== prepared.sourceDigest ||
    fresh.evidenceDigest !== prepared.evidenceDigest
  )
    throw new Error("LOCAL_APPROVAL_STALE");
  const request: JournalReservationRequest = {
    schemaVersion: "1.0.0",
    tenant,
    projectKey,
    operation,
    target: storyKey,
    automationIdentity: display.automationIdentity,
    payloadDigest: proposal.payloadDigest,
    operationId: writeOperationId({
      tenant,
      projectKey,
      operation,
      payloadDigest: proposal.payloadDigest,
    }),
    scope: [operation],
    sourceDigest: prepared.sourceDigest,
    evidenceDigest: prepared.evidenceDigest,
    preflightDigest: objectDigest({ origin, fingerprint, duplicates: [] }),
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
        issuedAt: new Date(issued).toISOString(),
        expiresAt: new Date(deadline).toISOString(),
      };
    },
  });
  const handle = await gate.verify(approvalId, request);
  const reservation = await journal.consumeAndReserve(
    request,
    proposal.payload,
    handle,
  );
  const attempted = {
    ...reservation.entry,
    status: "Attempted" as const,
    at: new Date(now()).toISOString(),
  };
  const ticket = await journal.record(attempted, request);
  if (!ticket) throw new Error("LOCAL_CREATION_ATTEMPT_REQUIRED");
  const transport = new XrayPublicationTransport(origin);
  try {
    const response = await transport.executeLocalCreation(
      proposal,
      ports,
      ticket,
    );
    const observed = inspectGenericCreationResponse(
      response,
      projectKey,
      display.automationIdentity,
    );
    if (
      observed.status !== "REQUIRES_READ_BACK" ||
      !observed.issueId ||
      !observed.testKey
    )
      throw new Error("CREATE_RESPONSE_UNCERTAIN");
    const result = await read.getTest(observed.issueId);
    if (
      !result ||
      result.issueId !== observed.issueId ||
      result.jira.key !== observed.testKey ||
      result.testType.name !== "Generic" ||
      result.unstructured !== display.automationIdentity
    )
      throw new Error("CREATE_READBACK_UNCERTAIN");
    await journal.record({
      ...attempted,
      status: "Confirmed",
      remoteIds: [result.issueId],
      remoteTestKey: result.jira.key,
      at: new Date(now()).toISOString(),
    });
    return {
      status: "CONFIRMED",
      key: result.jira.key,
      issueId: result.issueId,
    };
  } catch {
    await journal.record({
      ...attempted,
      status: "Uncertain",
      reconciliation: "pending",
      errorCode: "TRANSPORT",
      at: new Date(now()).toISOString(),
    });
    return { status: "UNCERTAIN_RUN_RECONCILE" };
  }
}

/** Injected ports are for offline validation. Live composition is private to the CLI. */
export async function runLocalDemoOffline(
  root: string,
  journal: OperationJournal,
  ports: Ports,
) {
  if (ports.fetch === globalThis.fetch)
    throw new Error("OFFLINE_PORT_REQUIRED");
  return runLocalDemo(root, journal, ports);
}

async function main() {
  const [mode, ...extra] = process.argv.slice(2);
  const manualMode =
    mode === "preview-manual" ||
    mode === "execute-manual" ||
    mode === "reconcile-manual";
  const linkMode =
    mode === "preview-link-rest" ||
    mode === "execute-link" ||
    mode === "reconcile-link";
  if (
    (manualMode
      ? extra.length !== 1
      : linkMode
        ? extra.length > 1
        : extra.length !== 0) ||
    (!manualMode &&
      ![
        "preview",
        "execute",
        "reconcile",
        "preview-link",
        "preview-link-rest",
        "execute-link",
        "reconcile-link",
        "preview-execution",
        "execute-execution",
        "reconcile-execution",
        "preview-import",
        "execute-import",
        "reconcile-import",
      ].includes(mode ?? ""))
  )
    throw new Error("INVALID_CHECKPOINT_COMMAND");
  const caseId = manualMode ? manualCaseId.parse(extra[0]) : undefined;
  const linkTarget = linkMode ? localLinkTarget(extra[0]) : "KAN-26";
  const root = process.cwd();
  if (
    mode === "preview-link" ||
    (mode === "preview-link-rest" && linkTarget === "KAN-26")
  ) {
    const journal = new OperationJournal(resolve(root, registryPath));
    try {
      console.log(
        JSON.stringify(
          mode === "preview-link"
            ? localLinkPreview(await journal.latestEntries())
            : await previewRestLink(journal),
          null,
          2,
        ),
      );
    } finally {
      await journal.close();
    }
    return;
  }
  if (mode === "preview") {
    const { display, fingerprint } = await prepare(root);
    console.log(JSON.stringify({ ...display, fingerprint }, null, 2));
    return;
  }
  if (
    (mode === "execute" ||
      mode === "execute-link" ||
      mode === "execute-execution" ||
      mode === "execute-import" ||
      mode === "execute-manual") &&
    (!process.stdin.isTTY || !process.stdout.isTTY)
  )
    throw new Error("INTERACTIVE_TERMINAL_REQUIRED");
  const tokens = new XrayTokenProvider({
    apiBase: origin,
    credentials: {
      async resolve() {
        const values = config({
          path: resolve(root, ".env"),
          quiet: true,
          processEnv: {},
        }).parsed;
        if (
          !values?.XRAY_CLIENT_ID?.trim() ||
          !values.XRAY_CLIENT_SECRET?.trim()
        )
          throw new Error("LOCAL_XRAY_CREDENTIALS_UNAVAILABLE");
        return {
          clientId: values.XRAY_CLIENT_ID,
          clientSecret: values.XRAY_CLIENT_SECRET,
        };
      },
    },
  });
  const journal = new OperationJournal(resolve(root, registryPath));
  try {
    if (manualMode && caseId) {
      const read = new XrayReadClient(
        new XrayHttpReadTransport({
          apiBase: origin,
          tokens,
          fetch: globalThis.fetch,
          retries: 0,
        }),
      );
      if (mode === "preview-manual") {
        console.log(
          JSON.stringify(
            await previewLocalManual(root, caseId, journal, read),
            null,
            2,
          ),
        );
        return;
      }
      const result =
        mode === "reconcile-manual"
          ? await reconcileLocalManual(root, caseId, journal, read)
          : await runLocalManual(root, caseId, journal, {
              fetch: globalThis.fetch,
              tokens,
              read,
              confirm: (preview) =>
                terminalApproval(preview, "create one Xray Manual Test"),
            });
      console.log(JSON.stringify(result));
      if (!["CONFIRMED", "RECONCILED"].includes(result.status))
        process.exitCode = 1;
      return;
    }
    if (
      mode === "preview-import" ||
      mode === "execute-import" ||
      mode === "reconcile-import"
    ) {
      const read = new XrayReadClient(
        new XrayHttpReadTransport({
          apiBase: origin,
          tokens,
          fetch: globalThis.fetch,
          retries: 0,
        }),
      );
      if (mode === "preview-import") {
        const preview = await previewLocalImport(
          root,
          await journal.latestEntries(),
          read,
        );
        console.log(JSON.stringify(preview, null, 2));
        return;
      }
      const result =
        mode === "reconcile-import"
          ? await reconcileLocalImport(root, journal, read)
          : await runLocalImport(root, journal, {
              fetch: globalThis.fetch,
              tokens,
              read,
              confirm: (preview) =>
                terminalApproval(
                  preview,
                  "publish one Playwright result to KAN-27",
                ),
            });
      console.log(JSON.stringify(result));
      if (!["CONFIRMED", "RECONCILED"].includes(result.status))
        process.exitCode = 1;
      return;
    }
    if (
      mode === "preview-execution" ||
      mode === "execute-execution" ||
      mode === "reconcile-execution"
    ) {
      const read = new XrayReadClient(
        new XrayHttpReadTransport({
          apiBase: origin,
          tokens,
          fetch: globalThis.fetch,
          retries: 0,
        }),
      );
      if (mode === "preview-execution") {
        const preview = await previewLocalExecution(
          root,
          await journal.latestEntries(),
          read,
        );
        console.log(JSON.stringify(preview, null, 2));
        return;
      }
      const result =
        mode === "reconcile-execution"
          ? await reconcileLocalExecution(journal, read)
          : await runLocalExecution(root, journal, {
              fetch: globalThis.fetch,
              tokens,
              read,
              confirm: (preview) =>
                terminalApproval(preview, "create one Xray Test Execution"),
            });
      console.log(JSON.stringify(result));
      if (!["CONFIRMED", "RECONCILED"].includes(result.status))
        process.exitCode = 1;
      return;
    }
    if (linkMode) {
      const values = config({
        path: resolve(root, ".env"),
        quiet: true,
        processEnv: {},
      }).parsed;
      const result = await runRestLink(
        journal,
        {
          fetch: globalThis.fetch,
          credentials: {
            baseUrl: values?.JIRA_BASE_URL ?? "",
            email: values?.JIRA_EMAIL ?? "",
            token: values?.JIRA_API_TOKEN ?? "",
          },
          xray: new XrayReadClient(
            new XrayHttpReadTransport({
              apiBase: origin,
              tokens,
              fetch: globalThis.fetch,
              retries: 0,
            }),
          ),
          confirm:
            mode === "execute-link"
              ? (preview) =>
                  terminalApproval(preview, "link " + linkTarget + " to KAN-25")
              : undefined,
          previewOnly: mode === "preview-link-rest",
        },
        linkTarget,
      );
      console.log(JSON.stringify(result));
      if (!["CONFIRMED", "RECONCILED", "PREVIEW"].includes(result.status))
        process.exitCode = 1;
      return;
    }
    const result = await runLocalDemo(root, journal, {
      tokens,
      fetch: globalThis.fetch,
      async confirm(preview) {
        if (mode !== "execute") throw new Error("NO_EXISTING_ATTEMPT");
        return terminalApproval(preview, "create one Generic Test");
      },
    });
    console.log(JSON.stringify(result));
    if (result.status !== "CONFIRMED" && result.status !== "RECONCILED")
      process.exitCode = 1;
  } finally {
    tokens.invalidate();
    await journal.close();
  }
}

async function terminalApproval(preview: string, action: string) {
  console.log(preview);
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  try {
    return await terminal.question(
      "Type APPROVE <fingerprint> to " + action + ": ",
      { signal: AbortSignal.timeout(approvalLifetime) },
    );
  } finally {
    terminal.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void main().catch(() => {
    console.error(
      "Checkpoint stopped. Check terminal mode, credentials, identity evidence, duplicate results, and journal state.",
    );
    process.exitCode = 1;
  });
}
