import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { canonicalizeJson, digestOperationPayload, type CanonicalJsonValue } from './approval-canonicalization.js';
import { parseJiraStoryPayload } from './contracts/jira-story-creation.js';

export type LocalDemoAction = 'jira.issue.create' | 'xray.test.create' | 'jira.issue.link' | 'xray.story.publish';
export interface LocalDemoApprovalRequest {
  readonly action: LocalDemoAction;
  readonly projectKey: string;
  readonly workflowId: string;
  readonly correlationId: string;
  readonly operationPayload: CanonicalJsonValue;
}
export interface LocalDemoApprovalRecord extends LocalDemoApprovalRequest {
  readonly approvalId: string;
  readonly digest: string;
  readonly recordDigest: string;
  readonly status: 'pending' | 'approved' | 'consumed';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly approvedAt?: string;
  readonly consumedAt?: string;
}

export class LocalDemoApprovalError extends Error {
  constructor(message: string) { super(message); this.name = 'LocalDemoApprovalError'; }
}

function approvalDirectory(): string {
  const directory = process.env.XRAY_DEMO_APPROVAL_DIR?.trim() ||
    (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'AgenticQAFramework', 'xray-demo-approvals') : '');
  if (!directory || !isAbsolute(directory)) {
      throw new LocalDemoApprovalError('Local demo approval storage must be an absolute Windows user-data path.');
  }
  return directory;
}

function seal(record: Omit<LocalDemoApprovalRecord, 'recordDigest'>): LocalDemoApprovalRecord {
  const unsigned = { ...record } as LocalDemoApprovalRecord;
  delete (unsigned as { recordDigest?: string }).recordDigest;
  return { ...unsigned, recordDigest: digestOperationPayload(unsigned) };
}

export function isLocalDemoModeEnabled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && env.XRAY_LOCAL_DEMO_MODE === 'true' && env.NODE_ENV !== 'production' && env.CI !== 'true';
}

/** Local workflow safeguard only. Same-user processes can alter these records or run the approver. */
export class LocalDemoApprovalService {
  constructor(
    private readonly directory = approvalDirectory(),
    private readonly clock: () => Date = () => new Date(),
    private readonly idFactory: () => string = randomUUID,
    private readonly ttlMs = 10 * 60_000,
  ) {
    if (!isAbsolute(directory)) throw new LocalDemoApprovalError('Demo approval storage path must be absolute.');
  }

  async createRequest(request: LocalDemoApprovalRequest, notAfter = Number.POSITIVE_INFINITY): Promise<LocalDemoApprovalRecord> {
    if (!['jira.issue.create', 'xray.test.create', 'jira.issue.link', 'xray.story.publish'].includes(request.action) ||
        !(request.action === 'jira.issue.create' ? /^[A-Z][A-Z0-9_]{1,29}$/ : /^[A-Z][A-Z0-9_]{0,9}$/).test(request.projectKey) ||
        !request.workflowId.trim() || !request.correlationId.trim()) {
      throw new LocalDemoApprovalError('Demo approval request is invalid.');
    }
    this.validateStoryRequest(request);
    const createdAt = this.clock();
    const expiresAt = Math.min(createdAt.getTime() + this.ttlMs, notAfter);
    if (!Number.isFinite(expiresAt) || expiresAt <= createdAt.getTime()) {
      throw new LocalDemoApprovalError('Demo approval scope has expired.');
    }
    const base = {
      ...request,
      approvalId: this.idFactory(),
      status: 'pending' as const,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
    const digest = digestOperationPayload({
      action: base.action, projectKey: base.projectKey, workflowId: base.workflowId,
      correlationId: base.correlationId, operationPayload: base.operationPayload,
    });
    const record = seal({ ...base, digest });
    await this.withLock(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await open(this.path(record.approvalId), 'wx', 0o600).then(async (handle) => {
        try { await handle.writeFile(JSON.stringify(record), 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
      });
    });
    return record;
  }

  async get(approvalId: string): Promise<LocalDemoApprovalRecord> {
    return this.withLock(async () => {
      const record = await this.read(approvalId);
      this.validateIntegrity(record);
      return record;
    });
  }

  async approve(approvalId: string, typedDigest: string): Promise<LocalDemoApprovalRecord> {
    return this.withLock(async () => {
      const current = await this.read(approvalId);
      this.validateIntegrity(current);
      if (current.status !== 'pending') throw new LocalDemoApprovalError('Demo approval is no longer pending.');
      if (this.clock().getTime() >= Date.parse(current.expiresAt)) throw new LocalDemoApprovalError('Demo approval has expired.');
      if (typedDigest !== current.digest) throw new LocalDemoApprovalError('Typed digest does not match this exact operation.');
      const approved = seal({ ...current, status: 'approved', approvedAt: this.clock().toISOString() });
      await this.replace(approved);
      return approved;
    });
  }

  /** Consumes the record atomically immediately before calling the supplied write callback. */
  async execute<T>(
    approvalId: string,
    expected: LocalDemoApprovalRequest,
    write: (payload: CanonicalJsonValue) => Promise<T>,
  ): Promise<T> {
    const record = await this.withLock(async () => {
      const current = await this.read(approvalId);
      this.validateIntegrity(current);
      if (current.status !== 'approved') throw new LocalDemoApprovalError(current.status === 'consumed' ? 'Demo approval has already been used.' : 'Demo approval is not approved.');
      if (this.clock().getTime() >= Date.parse(current.expiresAt)) throw new LocalDemoApprovalError('Demo approval has expired.');
      if (canonicalizeJson({ action: current.action, projectKey: current.projectKey, workflowId: current.workflowId,
        correlationId: current.correlationId, operationPayload: current.operationPayload }) !==
        canonicalizeJson({ action: expected.action, projectKey: expected.projectKey, workflowId: expected.workflowId,
          correlationId: expected.correlationId, operationPayload: expected.operationPayload })) {
        throw new LocalDemoApprovalError('Demo approval does not match the exact requested operation.');
      }
      const consumed = seal({ ...current, status: 'consumed', consumedAt: this.clock().toISOString() });
      await this.replace(consumed);
      return consumed;
    });
    return write(record.operationPayload);
  }

  private validateIntegrity(record: LocalDemoApprovalRecord): void {
    this.validateStoryRequest(record);
    const digest = digestOperationPayload({ action: record.action, projectKey: record.projectKey,
      workflowId: record.workflowId, correlationId: record.correlationId, operationPayload: record.operationPayload });
    const { recordDigest, ...unsigned } = record;
    if (digest !== record.digest || digestOperationPayload(unsigned) !== recordDigest || !Number.isFinite(Date.parse(record.expiresAt))) {
      throw new LocalDemoApprovalError('Demo approval record is invalid or changed.');
    }
  }

  private validateStoryRequest(request: LocalDemoApprovalRequest): void {
    if (request.action !== 'jira.issue.create') return;
    const payload = parseJiraStoryPayload(request.operationPayload);
    if (payload.projectKey !== request.projectKey) throw new LocalDemoApprovalError('Story project binding mismatch.');
  }

  private async read(approvalId: string): Promise<LocalDemoApprovalRecord> {
    if (!/^[0-9a-f-]{36}$/i.test(approvalId)) throw new LocalDemoApprovalError('Demo approval ID is invalid.');
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.path(approvalId), 'utf8')); }
    catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        throw new LocalDemoApprovalError('Demo approval record was not found.');
      }
      throw new LocalDemoApprovalError('Demo approval record could not be read.');
    }
    if (typeof parsed !== 'object' || parsed === null || (parsed as LocalDemoApprovalRecord).approvalId !== approvalId) {
      throw new LocalDemoApprovalError('Demo approval record is malformed.');
    }
    return parsed as LocalDemoApprovalRecord;
  }

  private async replace(record: LocalDemoApprovalRecord): Promise<void> {
    const path = this.path(record.approvalId);
    const temp = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record), 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, path);
  }

  private path(id: string): string { return join(this.directory, `${id}.json`); }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, '.demo-approval.lock');
    const deadline = Date.now() + 5_000;
    let handle;
    while (!handle) {
      try { handle = await open(lock, 'wx', 0o600); }
      catch (error: unknown) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error;
        if (Date.now() >= deadline) throw new LocalDemoApprovalError('Demo approval storage is locked; operation failed closed.');
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    try { return await fn(); }
    finally { await handle.close(); await rm(lock, { force: true }); }
  }
}
