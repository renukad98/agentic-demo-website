import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalizeJson, digestOperationPayload } from './approval-canonicalization.js';
import type { ApprovalRecordSigner } from './approval-signature.js';
import type { StoryExecution } from './contracts/xray-story-publication.js';

/** Production hosts must supply a trusted signer. Digest-only mode is a local demo safeguard. */
export class StoryExecutionStore {
  get trusted(): boolean { return this.signer !== undefined; }
  async lockedStory<T>(environment: string, story: string, action: () => Promise<T>): Promise<T> {
    const digest = digestOperationPayload({ environment, story }).slice(7, 39);
    return this.locked(digest.slice(0, 8) + '-' + digest.slice(8, 12) + '-' + digest.slice(12, 16) + '-' + digest.slice(16, 20) + '-' + digest.slice(20), action);
  }
  constructor(
    private readonly directory: string,
    private readonly signer?: ApprovalRecordSigner,
    private readonly replace = rename,
    private readonly platform = process.platform,
  ) {
    if (!isAbsolute(directory)) throw new Error('Execution directory must be absolute.');
  }
  async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(id) + '.lock';
    const handle = await open(path, 'wx', 0o600).catch(() => { throw new Error('Execution locked; reconcile stale locks before recovery.'); });
    try { return await action(); } finally { await handle.close(); await rm(path); }
  }
  async get(id: string): Promise<StoryExecution | undefined> {
    let raw: string;
    try { raw = await readFile(this.path(id), 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
    const entry = JSON.parse(raw) as { execution: StoryExecution; seal: string };
    const payload = canonicalizeJson(entry.execution);
    if (entry.execution.executionId !== id || !(this.signer ? this.signer.verify(payload, entry.seal) : digestOperationPayload(entry.execution) === entry.seal)) throw new Error('Execution integrity check failed.');
    return entry.execution;
  }
  async assertNoPriorBatch(plan: StoryExecution['plan'], checkLocks = false): Promise<void> {
    let files: string[];
    try { files = await readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const name of files) {
      if (checkLocks && name.endsWith('.lock')) throw new Error('Execution journal has an active or unresolved lock.');
      if (name.endsWith('.tmp')) throw new Error('Execution journal has an unresolved temporary snapshot.');
      if (!/^[a-f0-9-]{36}\.json$/i.test(name)) continue;
      const entry = await this.get(name.slice(0, -5));
      if (!entry) throw new Error('Execution journal changed during inspection.');
      if (entry.plan.storyKey === plan.storyKey &&
          (entry.plan.workflowId === plan.workflowId ||
            entry.plan.cases.some(c => plan.cases.some(p => p.testCaseId === c.testCaseId))))
        throw new Error('A prior batch execution requires review; do not publish again.');
    }
  }
  async save(execution: StoryExecution): Promise<void> {
    const path = this.path(execution.executionId);
    const temp = path + '.' + randomUUID() + '.tmp';
    const seal = this.signer ? this.signer.sign(canonicalizeJson(execution)) : digestOperationPayload(execution);
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ execution, seal })); await file.sync(); } finally { await file.close(); }
    // Retry only the local atomic replacement of the same flushed file.
    // Keep the previous snapshot and the temporary file if replacement fails.
    for (const wait of [0, 20, 40, 80, 160]) {
      if (wait) await delay(wait);
      try {
        await this.replace(temp, path);
        return;
      } catch (error) {
        const { code } = error as NodeJS.ErrnoException;
        if (wait === 160 || this.platform !== 'win32' ||
            (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error;
      }
    }
  }
  private path(id: string): string {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid execution ID.');
    return join(this.directory, id + '.json');
  }
}
