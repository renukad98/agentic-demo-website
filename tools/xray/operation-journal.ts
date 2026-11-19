import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  operations,
  storyKey,
  safeId,
  digest,
} from "../agentic/contracts/index.js";
import {
  noSymlinks,
  within,
  objectDigest,
  sanitized,
} from "../agentic/artifacts.js";
import { takeVerifiedApprovalEvidence } from "../agentic/approvals.js";
import {
  journalReservationRequestSchema,
  authorityAuditSchema,
  type JournalReservationRequest,
} from "../agentic/journal-reservation.js";
import { takeAuthorityTransition } from "../agentic/approval-authority.js";
import { validatePublicationReservation } from "./publication-transport.js";
import { localLinkTargets } from "./local-link-target.js";
const statuses = [
  "Planned",
  "Awaiting approval",
  "Approved",
  "Attempted",
  "Confirmed",
  "Failed",
  "Uncertain",
  "Reconciled",
] as const;
const journalSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    operationId: safeId,
    storyKey,
    operation: operations,
    payloadDigest: digest,
    approvalReference: safeId.optional(),
    status: z.enum(statuses),
    remoteIds: z.array(z.string().min(1)),
    remoteTestKey: storyKey.optional(),
    remoteExecutionKey: storyKey.optional(),
    at: z.string().datetime(),
    errorCode: z
      .enum(["TIMEOUT", "DENIED", "VALIDATION", "TRANSPORT"])
      .optional(),
    reconciliation: z
      .enum(["pending", "confirmed", "absent", "ambiguous"])
      .optional(),
    tenant: z.string().min(1).optional(),
    projectKey: z
      .string()
      .regex(/^[A-Z][A-Z0-9]*$/)
      .optional(),
    sourceDigest: digest.optional(),
    evidenceDigest: digest.optional(),
    automationIdentity: z.string().min(1).optional(),
    approvalConsumptionId: safeId.optional(),
    reconciliationEvidenceDigest: digest.optional(),
    retryOf: safeId.optional(),
  })
  .strict();
type Entry = z.infer<typeof journalSchema>;
const localAttempts = new WeakMap<
  object,
  {
    operation: Entry["operation"];
    digest: string;
    expiresAt: number;
    now: () => number;
  }
>();
export function takeLocalCreationAttempt(
  ticket: object,
  payloadDigest: string,
) {
  takeLocalAttempt(ticket, payloadDigest, "xray.test.create");
}
export function takeLocalLinkAttempt(ticket: object, payloadDigest: string) {
  takeLocalAttempt(ticket, payloadDigest, "jira.test.link");
}
export function takeLocalExecutionAttempt(
  ticket: object,
  payloadDigest: string,
) {
  takeLocalAttempt(ticket, payloadDigest, "xray.execution.create");
}
export function takeLocalImportAttempt(ticket: object, payloadDigest: string) {
  takeLocalAttempt(ticket, payloadDigest, "xray.results.import");
}
function takeLocalAttempt(
  ticket: object,
  payloadDigest: string,
  operation: Entry["operation"],
) {
  const attempt = localAttempts.get(ticket);
  localAttempts.delete(ticket);
  if (
    !attempt ||
    attempt.operation !== operation ||
    attempt.digest !== payloadDigest ||
    attempt.now() >= attempt.expiresAt
  )
    throw new Error("LOCAL_CREATION_ATTEMPT_REQUIRED");
}
const transitions: Record<Entry["status"], Entry["status"][]> = {
  Planned: ["Awaiting approval"],
  "Awaiting approval": ["Approved"],
  Approved: ["Attempted", "Uncertain"],
  Attempted: ["Confirmed", "Failed", "Uncertain"],
  Confirmed: [],
  Failed: [],
  Uncertain: ["Reconciled"],
  Reconciled: [],
};

function latest(entries: Entry[]): Entry[] {
  return [...new Map(entries.map((e) => [e.operationId, e])).values()];
}
function validateAppend(entries: Entry[], raw: Entry): Entry {
  const entry = journalSchema.parse(raw);
  if (
    !entry.tenant ||
    !entry.projectKey ||
    !entry.sourceDigest ||
    !entry.evidenceDigest
  )
    throw new Error("Journal operation context required");
  if (entry.operation === "xray.test.create" && !entry.automationIdentity)
    throw new Error("Creation identity required");
  const history = entries.filter(
    (record) => record.operationId === entry.operationId,
  );
  const prior = history.at(-1);
  if (!prior && entry.status !== "Planned")
    throw new Error("Journal must start Planned");
  if (!prior) {
    const existing = latest(entries);
    const recovery = entry.retryOf
      ? existing.find((record) => record.operationId === entry.retryOf)
      : undefined;
    if (
      entry.retryOf &&
      (!recovery ||
        recovery.status !== "Reconciled" ||
        recovery.reconciliation !== "absent" ||
        !recovery.reconciliationEvidenceDigest ||
        recovery.remoteIds.length ||
        recovery.operation !== entry.operation ||
        recovery.tenant !== entry.tenant ||
        recovery.projectKey !== entry.projectKey ||
        recovery.automationIdentity !== entry.automationIdentity)
    )
      throw new Error(
        "Retry requires reviewed absent read-back; confirmed/uncertain operations cannot replay",
      );
    for (const record of existing) {
      if (
        record.operationId === entry.retryOf ||
        record.tenant !== entry.tenant ||
        record.projectKey !== entry.projectKey
      )
        continue;
      if (
        record.operation === entry.operation &&
        record.payloadDigest === entry.payloadDigest
      )
        throw new Error("Duplicate operation proposal");
      if (
        entry.operation === "xray.test.create" &&
        record.operation === entry.operation &&
        record.automationIdentity === entry.automationIdentity
      )
        throw new Error(
          "Existing creation identity; reconcile or reuse confirmed Test, never create another automatically",
        );
      if (
        ["xray.execution.create", "xray.results.import"].includes(
          entry.operation,
        ) &&
        record.operation === entry.operation &&
        record.automationIdentity === entry.automationIdentity &&
        record.evidenceDigest === entry.evidenceDigest &&
        (entry.operation === "xray.execution.create" ||
          record.remoteExecutionKey === entry.remoteExecutionKey)
      )
        throw new Error(
          "Existing execution/result evidence scope; reconcile before a new operation",
        );
    }
  }
  if (prior) {
    if (
      prior.storyKey !== entry.storyKey ||
      prior.operation !== entry.operation ||
      prior.payloadDigest !== entry.payloadDigest
    )
      throw new Error("Changed operation requires new proposal and approval");
    if (!transitions[prior.status].includes(entry.status))
      throw new Error("Unsafe journal transition/retry");
    if (
      prior.approvalReference &&
      prior.approvalReference !== entry.approvalReference
    )
      throw new Error("Approval reference changed");
    if (prior.remoteIds.some((id) => !entry.remoteIds.includes(id)))
      throw new Error("Cannot discard confirmed remote IDs");
    for (const key of [
      "tenant",
      "projectKey",
      "sourceDigest",
      "evidenceDigest",
      "automationIdentity",
      "retryOf",
      "approvalConsumptionId",
      "remoteTestKey",
      "remoteExecutionKey",
    ] as const) {
      if (prior[key] !== undefined && prior[key] !== entry[key])
        throw new Error(
          "Immutable journal context changed; new review required",
        );
    }
  }
  if (
    ["Approved", "Attempted", "Confirmed"].includes(entry.status) &&
    (!entry.approvalReference || !entry.approvalConsumptionId)
  )
    throw new Error("Missing approval reference or consumption audit ID");
  if (entry.status === "Confirmed" && !entry.remoteIds.length)
    throw new Error("Missing confirmed remote IDs");
  if (
    entry.status === "Reconciled" &&
    (!entry.reconciliation || entry.reconciliation === "pending")
  )
    throw new Error("Read-back reconciliation required");
  if (entry.status === "Reconciled" && !entry.reconciliationEvidenceDigest)
    throw new Error("Reconciliation evidence digest required");
  if (
    entry.status === "Reconciled" &&
    entry.reconciliation === "absent" &&
    entry.remoteIds.length
  )
    throw new Error("Absent reconciliation contradicts confirmed remote IDs");
  if (
    ["xray.test.create", "xray.execution.create"].includes(entry.operation) &&
    (entry.status === "Confirmed" ||
      (entry.status === "Reconciled" && entry.reconciliation === "confirmed"))
  ) {
    if (
      entry.remoteIds.length !== 1 ||
      !/^[1-9][0-9]*$/.test(entry.remoteIds[0]!)
    )
      throw new Error("Conflicting or invalid confirmed Test IDs");
  }
  if (
    entry.operation === "xray.execution.create" &&
    entry.status === "Confirmed" &&
    (!entry.remoteExecutionKey ||
      !entry.remoteExecutionKey.startsWith(entry.projectKey + "-"))
  )
    throw new Error("Confirmed execution key required");

  return entry;
}
const consumptionSchema = z
  .object({
    approvalId: safeId,
    operationId: safeId,
    consumptionId: safeId,
    requestDigest: digest,
    request: journalReservationRequestSchema,
    payload: z.unknown(),
    expiresAt: z.string().datetime(),
    sessionId: z.string().uuid(),
    at: z.string().datetime(),
    remoteVerified: z.literal(false),
    authority: authorityAuditSchema.optional(),
  })
  .strict();
const documentSchema = z
  .object({
    schemaVersion: z.literal("2.0.0"),
    entries: z.array(journalSchema),
    consumptions: z.array(consumptionSchema),
    lastClock: z.number().int().nonnegative(),
  })
  .strict();
type Document = z.infer<typeof documentSchema>;
type Owner = {
  root: string;
  tail: Promise<void>;
  token: string;
  locked: boolean;
  blocked: boolean;
  seen: boolean;
  directory: string;
  instances: Set<OperationJournal>;
};
const owners = new Map<string, Owner>();
const empty = (): Document => ({
  schemaVersion: "2.0.0",
  entries: [],
  consumptions: [],
  lastClock: 0,
});
function validateDocument(raw: unknown): Document {
  const document = documentSchema.parse(raw),
    entries: Entry[] = [];
  for (const entry of document.entries)
    entries.push(validateAppend(entries, entry));
  const approvals = new Set<string>(),
    ids = new Set<string>(),
    ops = new Set<string>();
  const externalConsumptions = new Map<string, string>();
  for (const row of document.consumptions) {
    if (
      approvals.has(row.approvalId) ||
      ids.has(row.consumptionId) ||
      ops.has(row.operationId)
    )
      throw new Error("JOURNAL_CONSUMPTION_REPLAY");
    approvals.add(row.approvalId);
    ids.add(row.consumptionId);
    ops.add(row.operationId);
    if (
      row.request.operationId !== row.operationId ||
      row.requestDigest !== objectDigest(row.request) ||
      row.request.payloadDigest !== objectDigest(row.payload) ||
      Date.parse(row.at) >= Date.parse(row.expiresAt)
    )
      throw new Error("JOURNAL_CONSUMPTION_BINDING");
    if (row.authority && row.authority.requestDigest !== row.requestDigest)
      throw new Error("JOURNAL_AUTHORITY_BINDING");
    for (const event of row.authority?.events ?? []) {
      if (!event.externalConsumptionId) continue;
      const key =
        row.authority!.authorityId + ":" + event.externalConsumptionId;
      const prior = externalConsumptions.get(key);
      if (prior && prior !== row.operationId)
        throw new Error("JOURNAL_EXTERNAL_CONSUMPTION_REPLAY");
      externalConsumptions.set(key, row.operationId);
    }
    const approved = entries.find(
      (e) => e.operationId === row.operationId && e.status === "Approved",
    );
    if (
      !approved ||
      approved.approvalReference !== row.approvalId ||
      approved.approvalConsumptionId !== row.consumptionId ||
      approved.tenant !== row.request.tenant ||
      approved.projectKey !== row.request.projectKey ||
      approved.storyKey !== row.request.target ||
      approved.operation !== row.request.operation ||
      approved.automationIdentity !== row.request.automationIdentity ||
      approved.sourceDigest !== row.request.sourceDigest ||
      approved.evidenceDigest !== row.request.evidenceDigest ||
      approved.payloadDigest !== row.request.payloadDigest
    )
      throw new Error("JOURNAL_RESERVATION_BINDING");
  }
  return document;
}
/** Existing journal with one validated JSON history, no database or network.
 * Exclusive ownership is cooperative single-process safety, not distributed/adversarial fencing.
 */
export class OperationJournal {
  private closed = false;
  private directorySync:
    "not-attempted" | "completed" | "unsupported-or-denied" = "not-attempted";
  constructor(
    private readonly root: string,
    private readonly now = Date.now,
  ) {}
  private async owner(): Promise<Owner> {
    if (this.closed) throw new Error("JOURNAL_CLOSED");
    if ((await fs.lstat(this.root)).isSymbolicLink())
      throw new Error("Symlink journal roots are forbidden");
    const canonicalRoot = await fs.realpath(this.root),
      directory = within(canonicalRoot, "journal");
    await noSymlinks(canonicalRoot, directory);
    const ownerKey =
      process.platform === "win32" ? directory.toLowerCase() : directory;
    let owner = owners.get(ownerKey);
    if (!owner) {
      owner = {
        root: canonicalRoot,
        tail: Promise.resolve(),
        token: randomUUID(),
        locked: false,
        blocked: false,
        seen: false,
        directory,
        instances: new Set(),
      };
      owners.set(ownerKey, owner);
    }
    owner.instances.add(this);
    return owner;
  }
  private async queue<T>(work: (owner: Owner) => Promise<T>): Promise<T> {
    const owner = await this.owner();
    const result = owner.tail.then(() => {
      if (this.closed) throw new Error("JOURNAL_CLOSED");
      return work(owner);
    });
    owner.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private async acquire(owner: Owner) {
    if (owner.blocked) throw new Error("JOURNAL_WRITE_UNCERTAIN_RECONCILE");
    const lock = within(owner.directory, "writer-lock");
    await noSymlinks(owner.root, lock);
    if (!owner.locked) {
      await fs.mkdir(owner.directory, { recursive: true });
      try {
        await fs.mkdir(lock);
      } catch {
        throw new Error("JOURNAL_OWNER_BUSY_OR_STALE");
      }
      owner.token = randomUUID();
      const file = await fs.open(within(lock, "owner"), "wx", 0o600);
      try {
        await file.writeFile(
          JSON.stringify({ pid: process.pid, token: owner.token }),
        );
        await file.sync();
      } catch {
        owner.blocked = true;
        throw new Error("JOURNAL_OWNER_ESTABLISHMENT_FAILED");
      } finally {
        await file.close();
      }
      owner.locked = true;
    }
    let metadata: unknown;
    try {
      metadata = JSON.parse(await fs.readFile(within(lock, "owner"), "utf8"));
    } catch {
      owner.blocked = true;
      throw new Error("JOURNAL_OWNERSHIP_LOST");
    }
    const parsed = z
      .object({ pid: z.number().int(), token: z.string().uuid() })
      .strict()
      .safeParse(metadata);
    if (
      !parsed.success ||
      parsed.data.pid !== process.pid ||
      parsed.data.token !== owner.token
    ) {
      owner.blocked = true;
      throw new Error("JOURNAL_OWNERSHIP_LOST");
    }
  }
  private async load(owner: Owner): Promise<Document> {
    const path = within(owner.directory, "operations.json");
    await noSymlinks(owner.root, path);
    let readCompleted = false;
    try {
      const body = await fs.readFile(path, "utf8");
      readCompleted = true;
      const document = validateDocument(JSON.parse(body));
      const names = await fs.readdir(owner.directory);
      if (
        names.some(
          (n) =>
            n !== "operations.json" &&
            n !== "writer-lock" &&
            !/^operations\.json\.tmp-[0-9a-f-]{36}$/.test(n),
        )
      )
        throw new Error("LEGACY_OR_UNKNOWN_LAYOUT");
      owner.seen = true;
      return document;
    } catch (error) {
      if (readCompleted || (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("JOURNAL_CORRUPT_OR_UNREADABLE");
      let names: string[] = [];
      try {
        names = await fs.readdir(owner.directory);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (
        owner.seen ||
        names.some((n) => n !== "writer-lock") ||
        (names.includes("writer-lock") && !owner.locked)
      )
        throw new Error("JOURNAL_RECOVERY_OR_LEGACY_MIGRATION_REQUIRED");
      return empty();
    }
  }
  private async replacementSnapshot(path: string): Promise<string | null> {
    let before;
    try {
      before = await fs.lstat(path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!before.isFile() || before.ino === 0n) throw new Error("JOURNAL_FILE_ID_UNAVAILABLE");
    const fingerprint = (stat: typeof before) =>
      [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    const bytes = await fs.readFile(path);
    const after = await fs.lstat(path, { bigint: true });
    if (fingerprint(before) !== fingerprint(after)) throw new Error("JOURNAL_FILE_CHANGED");
    return fingerprint(after) + ":" + createHash("sha256").update(bytes).digest("hex");
  }
  private async replace(owner: Owner, document: Document) {
    validateDocument(document);
    const path = within(owner.directory, "operations.json"),
      temporary = within(
        owner.directory,
        "operations.json.tmp-" + randomUUID(),
      );
    await noSymlinks(owner.root, path);
    let phase = "temporary-write";
    let created = false,
      renamed = false,
      renameStarted = false;
    try {
      const file = await fs.open(temporary, "wx", 0o600);
      created = true;
      try {
        await file.writeFile(sanitized(document), "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await this.acquire(owner);
      const windows = process.platform === "win32";
      const destinationBefore = windows ? await this.replacementSnapshot(path) : null;
      const temporaryBefore = windows ? await this.replacementSnapshot(temporary) : null;
      renameStarted = true;
      phase = "rename";
      for (const wait of [0, 20, 60, 140]) {
        if (wait) {
          await delay(wait);
          await this.acquire(owner);
          if (!temporaryBefore ||
              await this.replacementSnapshot(temporary) !== temporaryBefore ||
              await this.replacementSnapshot(path) !== destinationBefore) {
            throw new Error("JOURNAL_REPLACEMENT_STATE_CHANGED");
          }
        }
        try {
          await fs.rename(temporary, path);
          break;
        } catch (error) {
          if (!windows || wait === 140 || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        }
      }
      renamed = true;
      owner.seen = true;
      let directory;
      try {
        phase = "directory-sync";
        directory = await fs.open(owner.directory, "r");
        await directory.sync();
        this.directorySync = "completed";
      } catch (error) {
        if (
          ["EPERM", "EACCES", "EISDIR", "EINVAL", "ENOTSUP", "EBADF"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          this.directorySync = "unsupported-or-denied";
        else throw error;
      } finally {
        try {
          await directory?.close();
        } catch (error) {
          phase = "directory-close";
          throw error;
        }
      }
    } catch (error) {
      if (renameStarted) owner.blocked = true;
      const rawCode = (error as NodeJS.ErrnoException).code;
      const code = typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(rawCode)
        ? rawCode : "UNKNOWN";
      throw new Error(
        (renameStarted
          ? "JOURNAL_REPLACEMENT_UNCERTAIN_RECONCILE"
          : "JOURNAL_WRITE_FAILED") + " [" + phase + ":" + code + "]",
      );
    } finally {
      if (created && !renamed)
        try {
          await fs.unlink(temporary);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            owner.blocked = true;
        }
    }
  }
  private tick(document: Document) {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < document.lastClock)
      throw new Error("JOURNAL_CLOCK_ROLLBACK");
    document.lastClock = now;
    return now;
  }
  async entries(operationId: string): Promise<Entry[]> {
    safeId.parse(operationId);
    return this.queue(async (owner) =>
      (await this.load(owner)).entries.filter(
        (e) => e.operationId === operationId,
      ),
    );
  }
  async latestEntries(): Promise<Entry[]> {
    return this.queue(async (owner) =>
      latest((await this.load(owner)).entries),
    );
  }
  async reservationFingerprint(operationId: string) {
    return this.queue(
      async (owner) =>
        (await this.load(owner)).consumptions.find(
          (row) => row.operationId === operationId,
        )?.request.preflightDigest,
    );
  }
  async findCreation(
    tenant: string,
    projectKey: string,
    automationIdentity: string,
  ) {
    return (await this.latestEntries()).filter(
      (e) =>
        e.tenant === tenant &&
        e.projectKey === projectKey &&
        e.operation === "xray.test.create" &&
        e.automationIdentity === automationIdentity,
    );
  }
  async record(raw: Entry, localRequest?: JournalReservationRequest) {
    const copied = journalSchema.parse(structuredClone(raw));
    const localDigest = localRequest && objectDigest(localRequest);
    return this.queue(async (owner) => {
      await this.acquire(owner);
      const document = await this.load(owner),
        now = this.tick(document);
      const consumption = document.consumptions.find(
        (c) => c.operationId === copied.operationId,
      );
      const kan29Link =
        copied.operation === "jira.test.link" &&
        consumption?.request.target === localLinkTargets["KAN-30"].story &&
        consumption.request.testKey === "KAN-30" &&
        consumption.request.testIssueId ===
          localLinkTargets["KAN-30"].issueId &&
        consumption.request.automationIdentity ===
          localLinkTargets["KAN-30"].identity;
      if (copied.status === "Attempted" && consumption?.authority)
        throw new Error("PRODUCTION_AUTHORITY_EXECUTION_DISABLED");
      if (
        localDigest &&
        (copied.status !== "Attempted" ||
          (copied.operation !== "xray.test.create" &&
            copied.operation !== "jira.test.link" &&
            copied.operation !== "xray.execution.create" &&
            copied.operation !== "xray.results.import") ||
          consumption?.request.executorPrincipal !== "windows-local-demo" ||
          consumption.request.operation !== copied.operation ||
          (copied.operation !== "xray.test.create" &&
            !kan29Link &&
            (consumption.request.testKey !== "KAN-26" ||
              consumption.request.testIssueId !== "10066") &&
            !(
              copied.operation === "jira.test.link" &&
              consumption.request.testKey === "KAN-28" &&
              consumption.request.testIssueId ===
                localLinkTargets["KAN-28"].issueId &&
              consumption.request.automationIdentity ===
                localLinkTargets["KAN-28"].identity
            )) ||
          (copied.operation === "xray.results.import" &&
            (consumption.request.executionKey !== "KAN-27" ||
              consumption.request.executionIssueId !== "10067")) ||
          consumption.requestDigest !== localDigest ||
          consumption.consumptionId !== copied.approvalConsumptionId ||
          consumption.request.payloadDigest !== copied.payloadDigest ||
          consumption.approvalId !== copied.approvalReference ||
          (consumption.request.target !== "KAN-25" &&
            !kan29Link &&
            !(
              copied.operation === "xray.test.create" &&
              consumption.request.target === "KAN-29" &&
              /^agentic-demo-website:manual:KAN-29:KAN-29-TC-0(?:0[1-9]|1[0-4])$/.test(
                consumption.request.automationIdentity ?? "",
              )
            )) ||
          consumption.request.projectKey !== "KAN" ||
          consumption.request.tenant !== "renudhamankar98.atlassian.net" ||
          consumption.request.authorityEpoch !== "local-demo-v1")
      )
        throw new Error("LOCAL_CREATION_RESERVATION_REQUIRED");
      if (
        copied.status === "Attempted" &&
        consumption &&
        (Date.parse(consumption.expiresAt) <= now ||
          consumption.sessionId !== owner.token)
      )
        throw new Error("JOURNAL_RESERVATION_EXPIRED_OR_PREVIOUS_SESSION");
      document.entries.push(validateAppend(document.entries, copied));
      await this.replace(owner, document);
      if (localDigest && consumption) {
        const ticket = Object.freeze({});
        localAttempts.set(ticket, {
          operation: copied.operation,
          digest: copied.payloadDigest,
          expiresAt: Date.parse(consumption.expiresAt),
          now: this.now,
        });
        return ticket;
      }
    });
  }
  /** No production authority: this coordinates LOCAL evidence consumption/reservation only. */
  async consumeAndReserve(
    raw: JournalReservationRequest,
    payload: unknown,
    handle: object,
  ) {
    const request = journalReservationRequestSchema.parse(structuredClone(raw)),
      copiedPayload = structuredClone(payload);
    if (request.payloadDigest !== objectDigest(copiedPayload))
      throw new Error("PAYLOAD_BINDING_MISMATCH");
    const manualLinkTarget =
      request.operation === "jira.test.link" &&
      request.executorPrincipal === "windows-local-demo" &&
      (request.testKey === "KAN-28" || request.testKey === "KAN-30")
        ? localLinkTargets[request.testKey]
        : undefined;
    if (
      request.operation === "jira.test.link" &&
      request.executorPrincipal === "windows-local-demo" &&
      request.target === "KAN-29" &&
      request.testKey !== "KAN-30"
    )
      throw new Error("MANUAL_LINK_RESERVATION_MISMATCH");
    if (
      manualLinkTarget &&
      (request.tenant !== "renudhamankar98.atlassian.net" ||
        request.projectKey !== "KAN" ||
        request.target !== manualLinkTarget.story ||
        request.testIssueId !== manualLinkTarget.issueId ||
        request.automationIdentity !== manualLinkTarget.identity ||
        request.payloadDigest !==
          objectDigest({
            method: "POST",
            url: "https://renudhamankar98.atlassian.net/rest/api/3/issueLink",
            body: {
              type: { id: "10037" },
              inwardIssue: { key: request.testKey },
              outwardIssue: { key: manualLinkTarget.story },
            },
          }))
    )
      throw new Error("MANUAL_LINK_RESERVATION_MISMATCH");
    if (
      ["xray.execution.create", "xray.results.import"].includes(
        request.operation,
      )
    )
      validatePublicationReservation(request, copiedPayload);
    return this.queue(async (owner) => {
      await this.acquire(owner);
      const document = await this.load(owner),
        now = this.tick(document);
      const evidence = takeVerifiedApprovalEvidence(
        handle,
        objectDigest(request),
      );
      if (
        Date.parse(evidence.issuedAt) > now ||
        Date.parse(evidence.expiresAt) <= now ||
        Date.parse(evidence.expiresAt) <= Date.parse(evidence.issuedAt)
      )
        throw new Error("EXPIRED_APPROVAL");
      if (
        document.consumptions.some(
          (c) =>
            c.approvalId === evidence.approvalId ||
            c.operationId === request.operationId,
        )
      )
        throw new Error("APPROVAL_REPLAY_OR_OPERATION_RESERVED");
      if (
        request.operation !== "xray.test.create" &&
        !latest(document.entries).some(
          (e) =>
            e.tenant === request.tenant &&
            e.projectKey === request.projectKey &&
            e.automationIdentity === request.automationIdentity &&
            e.operation === "xray.test.create" &&
            e.status === "Confirmed" &&
            e.remoteIds.includes(request.testIssueId!) &&
            e.remoteTestKey === request.testKey &&
            (!manualLinkTarget ||
              (e.storyKey === request.target &&
                e.remoteIds.length === 1 &&
                e.sourceDigest === request.sourceDigest &&
                e.evidenceDigest === request.evidenceDigest)),
        )
      )
        throw new Error("LINK_REQUIRES_CONFIRMED_TEST");
      if (
        request.operation === "xray.results.import" &&
        !latest(document.entries).some(
          (e) =>
            e.operation === "xray.execution.create" &&
            (e.status === "Confirmed" ||
              (e.status === "Reconciled" &&
                e.reconciliation === "confirmed")) &&
            e.tenant === request.tenant &&
            e.projectKey === request.projectKey &&
            e.automationIdentity === request.automationIdentity &&
            e.storyKey === request.target &&
            e.remoteIds.length === 1 &&
            e.remoteIds[0] === request.executionIssueId &&
            e.remoteExecutionKey === request.executionKey,
        )
      )
        throw new Error("IMPORT_REQUIRES_CONFIRMED_EXECUTION");
      if (
        (request.operation === "xray.execution.create" ||
          request.operation === "xray.results.import") &&
        request.executorPrincipal === "windows-local-demo" &&
        !latest(document.entries).some(
          (entry) =>
            entry.operation === "jira.test.link" &&
            entry.status === "Confirmed" &&
            entry.tenant === request.tenant &&
            entry.projectKey === request.projectKey &&
            entry.storyKey === request.target &&
            entry.remoteTestKey === request.testKey &&
            entry.automationIdentity === request.automationIdentity &&
            entry.sourceDigest === request.sourceDigest &&
            entry.evidenceDigest === request.evidenceDigest &&
            entry.remoteIds.length === 1 &&
            entry.remoteIds[0] === "10010",
        )
      )
        throw new Error("EXECUTION_REQUIRES_CONFIRMED_LINK");
      const consumptionId = randomUUID();
      const base = {
        schemaVersion: "1.0.0" as const,
        operationId: request.operationId,
        storyKey: request.target,
        operation: request.operation,
        payloadDigest: request.payloadDigest,
        tenant: request.tenant,
        projectKey: request.projectKey,
        automationIdentity: request.automationIdentity,
        sourceDigest: request.sourceDigest,
        evidenceDigest: request.evidenceDigest,
        ...(request.testKey ? { remoteTestKey: request.testKey } : {}),
        ...(request.executionKey
          ? { remoteExecutionKey: request.executionKey }
          : {}),
        remoteIds: [] as string[],
        at: new Date(now).toISOString(),
      };
      for (const status of [
        "Planned",
        "Awaiting approval",
        "Approved",
      ] as const) {
        const entry = {
          ...base,
          status,
          ...(status === "Approved"
            ? {
                approvalReference: evidence.approvalId,
                approvalConsumptionId: consumptionId,
              }
            : {}),
        };
        document.entries.push(validateAppend(document.entries, entry));
      }
      document.consumptions.push({
        approvalId: evidence.approvalId,
        operationId: request.operationId,
        consumptionId,
        requestDigest: objectDigest(request),
        request,
        payload: copiedPayload,
        expiresAt: evidence.expiresAt,
        sessionId: owner.token,
        at: base.at,
        remoteVerified: false,
        ...(evidence.authority
          ? { authority: structuredClone(evidence.authority) }
          : {}),
      });
      await this.replace(owner, document);
      return {
        entry: document.entries.at(-1)!,
        consumptionId,
        remoteVerified: false as const,
      };
    });
  }
  /** Audit only; never an execution permit. Transition handles come from the trusted adapter. */
  async applyAuthorityTransition(handle: object) {
    const transition = takeAuthorityTransition(handle);
    return this.queue(async (owner) => {
      await this.acquire(owner);
      const document = await this.load(owner),
        now = this.tick(document);
      const row = document.consumptions.find(
        (c) => c.operationId === transition.operationId,
      );
      if (
        !row?.authority ||
        row.requestDigest !== transition.requestDigest ||
        row.authority.authorityId !== transition.authorityId ||
        row.authority.decisionId !== transition.decisionId
      )
        throw new Error("JOURNAL_AUTHORITY_CONTEXT");
      const last = row.authority.events.at(-1)!;
      if (objectDigest(last) === objectDigest(transition.event)) return;
      if (Date.parse(transition.event.at) > now)
        throw new Error("JOURNAL_AUTHORITY_EVENT_TIME");
      row.authority.events.push(transition.event);
      authorityAuditSchema.parse(row.authority);
      if (transition.event.state !== "consumed") {
        const entry = latest(document.entries).find(
          (e) => e.operationId === row.operationId,
        )!;
        if (entry.status === "Approved" || entry.status === "Attempted")
          document.entries.push(
            validateAppend(document.entries, {
              ...entry,
              status: "Uncertain",
              errorCode:
                transition.event.state === "revoked" ? "DENIED" : "TRANSPORT",
              reconciliation: "pending",
              at: new Date(now).toISOString(),
            }),
          );
      }
      await this.replace(owner, document);
    });
  }
  async assertNoUncertainOperations() {
    if (
      (await this.latestEntries()).some(
        (e) =>
          ["Awaiting approval", "Approved", "Attempted", "Uncertain"].includes(
            e.status,
          ) ||
          (e.status === "Reconciled" && e.reconciliation !== "confirmed"),
      )
    )
      throw new Error("Dependent operations blocked pending recovery review");
  }
  durabilityStatus() {
    return {
      storage: "single-json-file",
      directorySync: this.directorySync,
      physicalCrashDurability: "NOT VERIFIED",
      productionPublication: "BLOCKED",
    };
  }
  async close() {
    return this.queue(async (owner) => {
      owner.instances.delete(this);
      this.closed = true;
      if (owner.instances.size || !owner.locked) return;
      const lock = within(owner.directory, "writer-lock"),
        metadata = JSON.parse(
          await fs.readFile(within(lock, "owner"), "utf8"),
        ) as { token?: string; pid?: number };
      if (metadata.token !== owner.token || metadata.pid !== process.pid)
        throw new Error("JOURNAL_OWNERSHIP_LOST");
      await fs.unlink(within(lock, "owner"));
      await fs.rmdir(lock);
      owner.locked = false;
    });
  }
}
