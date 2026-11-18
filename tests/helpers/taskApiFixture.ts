import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { UserStore } from "../../src/data/userStore.js";
import { TaskStore, type TaskStoreOptions } from "../../src/data/taskStore.js";

export async function taskApiFixture(taskStoreOptions: TaskStoreOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "kan25-api-"));
  const userFile = join(dir, "users.json");
  const taskFile = join(dir, "tasks.json");
  const secret = randomBytes(48).toString("hex");
  const password = randomBytes(24).toString("hex");
  const passwordHash = await bcrypt.hash(password, 4);
  const users = new UserStore(userFile);
  const identities = ["a", "b"].map((name) => ({
    id: randomUUID(),
    fullName: `Fixture ${name}`,
    email: `${name}@fixture.test`,
    passwordHash,
    phone: "",
    address: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isActive: true,
    termsAcceptedAt: new Date().toISOString(),
    privacyAcknowledgedAt: new Date().toISOString(),
    legalVersion: "1.0",
  }));
  await users.mutate((records) => {
    records.push(...identities);
  });
  const app = createApp({ secret, userFile, taskFile, taskStoreOptions });
  async function login(index = 0, target = app) {
    const agent = request.agent(target);
    const before = (await agent.get("/api/csrf").expect(200)).body
      .token as string;
    await agent
      .post("/api/auth/login")
      .set("X-CSRF-Token", before)
      .send({ email: identities[index]!.email, password })
      .expect(200);
    const csrf = (await agent.get("/api/csrf").expect(200)).body
      .token as string;
    return { agent, csrf, before, user: identities[index]! };
  }
  return {
    dir,
    userFile,
    taskFile,
    secret,
    app,
    users,
    identities,
    login,
    store: new TaskStore(taskFile),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
