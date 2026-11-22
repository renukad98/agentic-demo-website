import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, isAbsolute, sep } from "node:path";

export type ContactMessage = {
  name: string;
  email: string;
  message: string;
};

export class ContactStore {
  constructor(private readonly directory: string) {
    const location = relative(resolve("public"), resolve(directory));
    if (
      !isAbsolute(location) &&
      location !== ".." &&
      !location.startsWith(".." + sep)
    )
      throw new Error("Contact messages must be stored outside public assets.");
  }

  async save(message: ContactMessage): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const destination = join(this.directory, id + ".json");
    const temporary = destination + ".tmp";
    const record = { ...message, receivedAt: new Date().toISOString() };
    await writeFile(temporary, JSON.stringify(record) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    try {
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
