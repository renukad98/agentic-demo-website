import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ApprovalRecord } from './contracts/approval.js';
import type { ApprovalId, ISO8601DateTime } from './contracts/workflow.js';
import type { CanonicalJsonValue } from './approval-canonicalization.js';

export interface StoredApprovalRecord {
  readonly record: ApprovalRecord;
  readonly operationPayload: CanonicalJsonValue;
  readonly consumedAt: ISO8601DateTime | null;
  readonly signature: string;
}

export interface ApprovalRecordStore {
  create(entry: StoredApprovalRecord): Promise<void>;
  get(approvalId: ApprovalId): Promise<StoredApprovalRecord | undefined>;
  compareAndSet(
    approvalId: ApprovalId,
    expectedSignature: string,
    replacement: StoredApprovalRecord,
  ): Promise<boolean>;
}

function isStoredApprovalRecord(value: unknown): value is StoredApprovalRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.record === 'object' && entry.record !== null &&
    'approvalId' in entry.record && typeof entry.operationPayload !== 'undefined' &&
    (entry.consumedAt === null || typeof entry.consumedAt === 'string') &&
    typeof entry.signature === 'string';
}

/**
 * Local durable store. It serializes transitions with an exclusive lock and fails closed
 * if a lock is left behind after a process crash. Signature verification belongs to the service.
 */
export class JsonFileApprovalRecordStore implements ApprovalRecordStore {
  constructor(
    private readonly directory: string,
    private readonly lockTimeoutMs = 5_000,
  ) {
    if (!isAbsolute(directory)) throw new TypeError('Approval record directory must be an absolute trusted path.');
  }

  async create(entry: StoredApprovalRecord): Promise<void> {
    await this.withLock(async () => {
      const path = this.recordPath(entry.record.approvalId);
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(entry), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  }

  async get(approvalId: ApprovalId): Promise<StoredApprovalRecord | undefined> {
    return this.withLock(async () => {
      try {
        const text = await readFile(this.recordPath(approvalId), 'utf8');
        const parsed: unknown = JSON.parse(text);
        if (!isStoredApprovalRecord(parsed)) throw new Error('Stored approval record is malformed.');
        return parsed;
      } catch (error: unknown) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
          return undefined;
        }
        throw error;
      }
    });
  }

  async compareAndSet(
    approvalId: ApprovalId,
    expectedSignature: string,
    replacement: StoredApprovalRecord,
  ): Promise<boolean> {
    return this.withLock(async () => {
      const path = this.recordPath(approvalId);
      let current: StoredApprovalRecord;
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isStoredApprovalRecord(parsed)) throw new Error('Stored approval record is malformed.');
        current = parsed;
      } catch (error: unknown) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
          return false;
        }
        throw error;
      }
      if (
        current.signature !== expectedSignature || current.consumedAt !== null ||
        replacement.record.approvalId !== approvalId
      ) return false;

      const temporaryPath = `${path}.${randomUUID()}.tmp`;
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(replacement), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporaryPath, path);
      } catch (error: unknown) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
      return true;
    });
  }

  private recordPath(approvalId: ApprovalId): string {
    if (!/^[0-9a-f-]{36}$/i.test(approvalId)) throw new TypeError('Invalid approval ID.');
    return join(this.directory, `${approvalId}.json`);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = join(this.directory, '.approval-records.lock');
    const deadline = Date.now() + this.lockTimeoutMs;
    let lockHandle;
    while (!lockHandle) {
      try {
        lockHandle = await open(lockPath, 'wx', 0o600);
      } catch (error: unknown) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) {
          throw error;
        }
        if (Date.now() >= deadline) throw new Error('Approval store is locked; operation failed closed.');
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await operation();
    } finally {
      await lockHandle.close();
      await rm(lockPath, { force: true });
    }
  }
}

