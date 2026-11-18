import {
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Task, TaskStatus } from "../types/task.js";
import {
  storedTasksSchema,
  normalizedTaskCreateSchema,
  normalizedTaskUpdateSchema,
  taskStatusSchema,
  type TaskCreate,
  type TaskUpdate,
} from "../tasks/taskValidation.js";
import { taskTimestamp } from "../tasks/taskTime.js";

export interface TaskFileSystem {
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}
export const taskFileSystem: TaskFileSystem = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  readFile: (path) => readFile(path, "utf8"),
  realpath,
  writeFile: (path, content) =>
    writeFile(path, content, { mode: 0o600, flag: "wx" }),
  rename,
  unlink,
};
export interface TaskStoreOptions {
  fs?: Partial<TaskFileSystem>;
  now?: () => number;
  uuid?: () => string;
  /** Override on a Windows directory configured for case-sensitive names. */
  caseSensitivePaths?: boolean;
}
const queues = new Map<string, Promise<unknown>>();
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

export class TaskStore {
  private readonly fs: TaskFileSystem;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly location: Promise<{ path: string; key: string }>;
  constructor(file: string, options: TaskStoreOptions = {}) {
    this.fs = { ...taskFileSystem, ...options.fs };
    this.now = options.now ?? Date.now;
    this.uuid = options.uuid ?? randomUUID;
    this.location = this.canonicalize(
      file,
      options.caseSensitivePaths ?? process.platform !== "win32",
    );
    // Construction can precede a request; retain rejection for the caller without an unhandled rejection.
    void this.location.catch(() => undefined);
  }
  private async canonicalize(file: string, caseSensitive: boolean) {
    const absolute = resolve(file);
    await this.fs.mkdir(dirname(absolute));
    let path: string;
    try {
      path = await this.fs.realpath(absolute);
    } catch (error) {
      if (!missing(error)) throw error;
      path = join(
        await this.fs.realpath(dirname(absolute)),
        basename(absolute),
      );
    }
    return { path, key: caseSensitive ? path : path.toLowerCase() };
  }
  private async serialized<T>(work: (path: string) => Promise<T>): Promise<T> {
    const location = await this.location;
    const previous = queues.get(location.key) ?? Promise.resolve();
    const pending = previous.then(() => work(location.path));
    const settled = pending.catch(() => undefined);
    queues.set(location.key, settled);
    try {
      return await pending;
    } finally {
      if (queues.get(location.key) === settled) queues.delete(location.key);
    }
  }
  private async read(path: string): Promise<Task[]> {
    let value: unknown;
    try {
      value = JSON.parse(await this.fs.readFile(path));
    } catch (error) {
      if (missing(error)) return [];
      throw new Error("Task storage is unavailable.", { cause: error });
    }
    const parsed = storedTasksSchema.safeParse(value);
    if (!parsed.success) throw new Error("Task storage is invalid.");
    return parsed.data;
  }
  private async commit(path: string, tasks: Task[]): Promise<void> {
    const parsed = storedTasksSchema.safeParse(tasks);
    if (!parsed.success) throw new Error("Invalid task storage mutation.");
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await this.fs.writeFile(
        temporary,
        JSON.stringify(parsed.data, null, 2) + "\n",
      );
      await this.fs.rename(temporary, path);
    } catch (error) {
      // Only remove this operation's unique sibling; never remove/reset the live file.
      await this.fs.unlink(temporary).catch(() => undefined);
      throw new Error("Task storage write failed.", { cause: error });
    }
  }
  async list(ownerId: string): Promise<Task[]> {
    return this.serialized(async (path) =>
      (await this.read(path))
        .filter((task) => task.ownerId === ownerId)
        .sort(
          (a, b) =>
            Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        ),
    );
  }
  async create(ownerId: string, input: TaskCreate): Promise<Task> {
    input = normalizedTaskCreateSchema.parse(input);
    return this.serialized(async (path) => {
      const tasks = await this.read(path);
      const stamp = taskTimestamp(this.now());
      const task: Task = {
        ...input,
        id: this.uuid(),
        ownerId,
        status: "Pending",
        createdAt: stamp,
        updatedAt: stamp,
      };
      tasks.push(task);
      await this.commit(path, tasks);
      return { ...task };
    });
  }
  async update(
    ownerId: string,
    id: string,
    input: TaskUpdate,
  ): Promise<Task | null> {
    return this.change(ownerId, id, normalizedTaskUpdateSchema.parse(input));
  }
  async setStatus(
    ownerId: string,
    id: string,
    status: TaskStatus,
  ): Promise<Task | null> {
    return this.change(ownerId, id, taskStatusSchema.parse({ status }));
  }
  private async change(
    ownerId: string,
    id: string,
    input: TaskUpdate | { status: TaskStatus },
  ): Promise<Task | null> {
    return this.serialized(async (path) => {
      const tasks = await this.read(path);
      const task = tasks.find(
        (item) => item.id === id && item.ownerId === ownerId,
      );
      if (!task) return null;
      const entries = Object.entries(input).filter(
        ([, value]) => value !== undefined,
      );
      if (entries.some(([key, value]) => task[key as keyof Task] !== value)) {
        Object.assign(task, Object.fromEntries(entries), {
          updatedAt: taskTimestamp(this.now(), task.updatedAt),
        });
        await this.commit(path, tasks);
      }
      return { ...task };
    });
  }
  async delete(ownerId: string, id: string): Promise<boolean> {
    return this.serialized(async (path) => {
      const tasks = await this.read(path);
      const index = tasks.findIndex(
        (item) => item.id === id && item.ownerId === ownerId,
      );
      if (index === -1) return false;
      tasks.splice(index, 1);
      await this.commit(path, tasks);
      return true;
    });
  }
}
