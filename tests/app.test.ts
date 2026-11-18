import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import bcrypt from "bcrypt";
import { createApp } from "../src/app.js";
import { UserStore } from "../src/data/userStore.js";
// @ts-expect-error Browser module is intentionally plain JavaScript.
import { validConsent } from "../public/js/cookieConsent.js";
const secret = "test-secret-".repeat(4);
const body = {
  fullName: "Taylor Example",
  email: "taylor@example.com",
  password: "StrongPassword!42",
  confirmPassword: "StrongPassword!42",
  phone: "+1 555 1234",
  address: "Demo Street",
  termsAccepted: true,
  privacyAcknowledged: true,
};
test("complete authentication, validation, persistence and profile lifecycle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-"));
  try {
    const userFile = join(dir, "users.json");
    const app = createApp({ secret, userFile });
    const agent = request.agent(app);
    const homepage = await agent.get("/").expect(200);
    assert.equal(homepage.headers["set-cookie"], undefined);
    assert(homepage.headers["content-security-policy"]);
    const token = (await agent.get("/api/csrf").expect(200)).body.token;
    await agent.post("/api/auth/register").send(body).expect(403);
    await agent.get("/api/users/me").expect(401);
    await agent.get("/profile").expect(302).expect("Location", "/login");
    await agent.get("/profile.html").expect(404);
    await agent.get("/profile%2ehtml").expect(404);
    await agent
      .post("/api/auth/register")
      .set("X-CSRF-Token", token)
      .send({ ...body, termsAccepted: false })
      .expect(400);
    await agent
      .post("/api/auth/register")
      .set("X-CSRF-Token", token)
      .send({ ...body, confirmPassword: "different" })
      .expect(400);
    const registration = await agent
      .post("/api/auth/register")
      .set("X-CSRF-Token", token)
      .send(body)
      .expect(201);
    assert.equal(registration.body.user.isActive, true);
    assert.equal(registration.body.user.passwordHash, undefined);
    const users = JSON.parse(await readFile(userFile, "utf8"));
    assert.notEqual(users[0].passwordHash, body.password);
    assert(await bcrypt.compare(body.password, users[0].passwordHash));
    await agent
      .post("/api/auth/register")
      .set("X-CSRF-Token", token)
      .send({ ...body, email: body.email.toUpperCase() })
      .expect(409);
    await agent
      .post("/api/auth/login")
      .set("X-CSRF-Token", token)
      .send({ email: body.email, password: "bad" })
      .expect(401);
    const before = (await agent.get("/api/csrf")).headers["set-cookie"];
    const login = await agent
      .post("/api/auth/login")
      .set("X-CSRF-Token", token)
      .send(body)
      .expect(200);
    const loginCookies = login.headers["set-cookie"];
    assert(Array.isArray(loginCookies));
    const sessionCookie = loginCookies[0];
    assert(sessionCookie);
    assert(sessionCookie.includes("HttpOnly"));
    assert(sessionCookie.includes("SameSite=Lax"));
    assert.notDeepEqual(before, login.headers["set-cookie"]);
    await agent.post("/api/auth/logout").set("X-CSRF-Token", token).expect(403);
    await agent.get("/api/auth/me").expect(200);
    await agent.get("/profile").expect(200);
    const fresh = (await agent.get("/api/csrf")).body.token;
    const updated = await agent
      .put("/api/users/me")
      .set("X-CSRF-Token", fresh)
      .send({
        fullName: "Updated Name",
        phone: "",
        address: "New address",
        email: "evil@example.com",
      })
      .expect(200);
    assert.equal(updated.body.user.email, body.email);
    assert.equal(updated.body.user.fullName, "Updated Name");
    assert.equal(
      (await new UserStore(userFile).read())[0]?.fullName,
      "Updated Name",
    );
    const restarted = request.agent(createApp({ secret, userFile }));
    const restartToken = (await restarted.get("/api/csrf")).body.token;
    await restarted
      .post("/api/auth/login")
      .set("X-CSRF-Token", restartToken)
      .send(body)
      .expect(200);
    await agent.post("/api/auth/logout").set("X-CSRF-Token", fresh).expect(200);
    await agent.get("/api/users/me").expect(401);
    await agent.get("/api/users").expect(404);
    for (const path of [
      "/",
      "/login",
      "/register",
      "/privacy",
      "/terms",
      "/cookies",
    ])
      await agent.get(path).expect(200);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("queued writes keep all concurrent records and reject duplicate emails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-race-"));
  try {
    const app = createApp({ secret, userFile: join(dir, "users.json") });
    const agent = request.agent(app);
    const token = (await agent.get("/api/csrf")).body.token;
    const results = await Promise.all(
      [1, 2].map(() =>
        agent.post("/api/auth/register").set("X-CSRF-Token", token).send(body),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(
      (await new UserStore(join(dir, "users.json")).read()).length,
      1,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("consent requires explicit categories, matching version, and fresh timestamp", () => {
  const record = {
    necessary: true,
    functional: false,
    analytics: false,
    marketing: false,
    version: "1.0",
    timestamp: new Date().toISOString(),
  };
  assert.equal(validConsent(null), false);
  assert.equal(validConsent(record), true);
  assert.equal(validConsent({ ...record, version: "old" }), false);
  assert.equal(validConsent({ ...record, necessary: false }), false);
  assert.equal(validConsent({ ...record, timestamp: "2020-01-01" }), false);
  assert.equal(validConsent({ ...record, analytics: undefined }), false);
  assert.equal(
    validConsent({
      ...record,
      functional: true,
      analytics: true,
      marketing: true,
    }),
    true,
  );
});
