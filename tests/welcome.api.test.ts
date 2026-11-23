import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";

async function guest(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "kan72-api-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return request(
    createApp({
      secret: "x".repeat(32),
      userFile: join(dir, "users.json"),
      contactDirectory: join(dir, "contact"),
    }),
  );
}

test("KAN-72-TC-01: Serve the standalone welcome page", async (t) => {
  const client = await guest(t);
  const response = await client
    .get("/welcome.html")
    .expect(200)
    .expect("Content-Type", /html/);
  assert.match(response.text, /<h1>Welcome to Agentic Demo Website<\/h1>/);
  assert.match(response.text, /<p>We’re glad you’re here\./);
});

test("KAN-72-TC-04: Serve the existing home directly", async (t) => {
  const client = await guest(t);
  const response = await client
    .get("/")
    .expect(200)
    .expect("Content-Type", /html/);
  assert.match(
    response.text,
    /<h1>Your space\.<br\s*\/?>A simpler start\.<\/h1>/,
  );
  assert.equal(response.headers.location, undefined);
});
