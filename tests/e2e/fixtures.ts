import {
  test as base,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import { createApp } from "../../src/app.js";

export interface FixtureUser {
  id: string;
  email: string;
  password: string;
}
interface TestApp {
  url: string;
  users: FixtureUser[];
  userFile: string;
  taskFile: string;
}
export const test = base.extend<{ app: TestApp }>({
  app: async ({ browserName: _browserName }, use) => {
    const dir = await mkdtemp(join(tmpdir(), "kan25-browser-"));
    const users = [0, 1].map((index) => ({
      id: randomUUID(),
      email: `fixture-${index}@example.test`,
      password: randomBytes(24).toString("hex"),
    }));
    const now = new Date().toISOString();
    const userFile = join(dir, "users.json");
    const taskFile = join(dir, "tasks.json");
    const persisted = await Promise.all(
      users.map(async (u) => ({
        id: u.id,
        email: u.email,
        fullName: "Fixture User",
        passwordHash: await bcrypt.hash(u.password, 4),
        phone: "",
        address: "",
        createdAt: now,
        updatedAt: now,
        isActive: true,
        termsAcceptedAt: now,
        privacyAcknowledgedAt: now,
        legalVersion: "1.0",
      })),
    );
    await writeFile(userFile, JSON.stringify(persisted));
    const app = createApp({
      secret: randomBytes(48).toString("hex"),
      userFile,
      taskFile,
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture server did not bind a local port.");
    try {
      await use({
        url: `http://127.0.0.1:${address.port}`,
        users,
        userFile,
        taskFile,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(dir, { recursive: true, force: true });
    }
  },
  baseURL: async ({ app }, use) => {
    await use(app.url);
  },
});
export { expect };
export async function signIn(page: Page, user: FixtureUser) {
  await page.goto("/login");
  const reject = page.getByRole("button", {
    name: "Reject Optional",
    exact: true,
  });
  if (await reject.isVisible()) await reject.click();
  await page.getByLabel("Email address").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: /Log in/i }).click();
  await expect(page).toHaveURL(/\/profile$/);
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(page.getByText("No tasks yet.", { exact: false })).toBeVisible();
}
export async function token(request: APIRequestContext) {
  return (await (await request.get("/api/csrf")).json()).token as string;
}
export async function createTask(
  request: APIRequestContext,
  title: string,
  extra = {},
) {
  const response = await request.post("/api/tasks", {
    headers: { "X-CSRF-Token": await token(request) },
    data: { title, ...extra },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).task;
}
export async function apiLogin(request: APIRequestContext, user: FixtureUser) {
  const csrf = await token(request);
  const response = await request.post("/api/auth/login", {
    headers: { "X-CSRF-Token": csrf },
    data: { email: user.email, password: user.password },
  });
  expect(response.status()).toBe(200);
}
