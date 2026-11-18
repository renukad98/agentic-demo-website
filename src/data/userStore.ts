import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { User } from "../types/user.js";

export class UserStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}
  async read(): Promise<User[]> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as User[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  mutate<T>(operation: (users: User[]) => T): Promise<T> {
    const task = this.queue.then(async () => {
      const users = await this.read();
      const result = operation(users);
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(users, null, 2) + "\n", {
        mode: 0o600,
      });
      await rename(temporary, this.file);
      return result;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
}
