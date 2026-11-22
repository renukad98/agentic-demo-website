import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { ContactStore } from "../src/data/contactStore.js";

const valid = {
  name: "Visitor",
  email: "visitor@example.test",
  message: "Hello",
};
const emailOfLength = (length: number) =>
  "a".repeat(64) +
  "@" +
  "b".repeat(63) +
  "." +
  "c".repeat(60) +
  "." +
  "d".repeat(length - 195) +
  ".test";

test("KAN-56-TC-002/004: validate, normalize and store submissions privately", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kan56-api-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const contactDirectory = join(dir, "contact-messages");
  const agent = request.agent(
    createApp({
      secret: "x".repeat(32),
      userFile: join(dir, "users.json"),
      contactDirectory,
    }),
  );
  const csrf = (await agent.get("/api/csrf").expect(200)).body.token;
  const submit = (body: object) =>
    agent.post("/api/contact").set("X-CSRF-Token", csrf).send(body);

  await agent.post("/api/contact").send(valid).expect(403);
  await submit({}).expect(400);
  for (const [field, value] of [
    ["name", " "],
    ["name", "n".repeat(101)],
    ["email", "broken"],
    ["email", emailOfLength(255)],
    ["message", " "],
    ["message", "m".repeat(2001)],
  ] as const) {
    const response = await submit({ ...valid, [field]: value }).expect(400);
    assert.ok(response.body.error.fields[field]?.length);
  }
  await assert.rejects(readdir(contactDirectory), { code: "ENOENT" });

  const payloads = [
    { name: " N ", email: "  v@example.test ", message: " M " },
    {
      name: "N".repeat(100),
      email: emailOfLength(253),
      message: "m".repeat(2000),
    },
    { ...valid, email: emailOfLength(254) },
  ];
  for (const payload of payloads) await submit(payload).expect(201);
  const files = await readdir(contactDirectory);
  assert.equal(files.length, payloads.length);
  const records = await Promise.all(
    files.map(async (file) =>
      JSON.parse(await readFile(join(contactDirectory, file), "utf8")),
    ),
  );
  for (const payload of payloads) {
    assert.ok(
      records.some(
        (record) =>
          record.name === payload.name.trim() &&
          record.email === payload.email.trim() &&
          record.message === payload.message.trim(),
      ),
    );
  }
  await agent.get("/api/contact").expect(404);
  await agent.get("/contact-messages/" + files[0]).expect(404);
  assert.throws(
    () => new ContactStore("public/contact-messages"),
    /outside public assets/,
  );
});

test("KAN-56-TC-005: unsuccessful storage returns an error before a retry succeeds", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kan56-api-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const contactDirectory = join(dir, "contact-messages");
  const store = new ContactStore(contactDirectory);
  let reject = true;
  const agent = request.agent(
    createApp({
      secret: "x".repeat(32),
      userFile: join(dir, "users.json"),
      contactStore: {
        async save(message) {
          if (reject) throw new Error("Fixture storage failure");
          await store.save(message);
        },
      },
    }),
  );
  const csrf = (await agent.get("/api/csrf").expect(200)).body.token;
  const submit = () =>
    agent.post("/api/contact").set("X-CSRF-Token", csrf).send(valid);
  await submit().expect(500);
  await assert.rejects(readdir(contactDirectory), { code: "ENOENT" });
  reject = false;
  await submit().expect(201);
  assert.equal((await readdir(contactDirectory)).length, 1);
});
