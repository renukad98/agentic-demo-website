import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import request from "supertest";
import { taskApiFixture } from "./helpers/taskApiFixture.js";

test("TM-TC-11/23: task page/APIs require active session and raw HTML/data aliases never expose records", async () => {
  const f = await taskApiFixture();
  try {
    const anon = request.agent(f.app);
    await anon.get("/tasks").expect(302).expect("Location", "/login");
    await anon.get("/api/tasks").expect(401);
    await anon.post("/api/tasks").send({ title: "no token" }).expect(403);
    const csrf = (await anon.get("/api/csrf")).body.token;
    await anon
      .post("/api/tasks")
      .set("X-CSRF-Token", csrf)
      .send({ title: "no auth" })
      .expect(401);
    for (const path of [
      "/tasks.html",
      "/tasks%2ehtml",
      "/data/tasks.json",
      "/tasks.json",
    ])
      await anon.get(path).expect(404);
    const a = await f.login();
    await a.agent.get("/tasks").expect(200).expect("Cache-Control", "no-store");
    await a.agent
      .get("/api/tasks")
      .expect(200)
      .expect("Cache-Control", "no-store");
    await f.users.mutate((users) => {
      users.find((u) => u.id === a.user.id)!.isActive = false;
    });
    await a.agent.get("/api/tasks").expect(401);
    await a.agent.get("/tasks").expect(302);
    for (const response of [
      await a.agent
        .post("/api/tasks")
        .set("X-CSRF-Token", a.csrf)
        .send({ title: "inactive" }),
      await a.agent
        .patch(`/api/tasks/${randomUUID()}`)
        .set("X-CSRF-Token", a.csrf)
        .send({ title: "inactive" }),
      await a.agent
        .patch(`/api/tasks/${randomUUID()}/status`)
        .set("X-CSRF-Token", a.csrf)
        .send({ status: "Pending" }),
      await a.agent
        .delete(`/api/tasks/${randomUUID()}`)
        .set("X-CSRF-Token", a.csrf),
    ])
      assert.equal(response.status, 401);
  } finally {
    await f.cleanup();
  }
});

test("TM-TC-02/12/25/27: cross-owner and nonexistent IDs have indistinguishable errors for every mutation", async () => {
  const f = await taskApiFixture();
  try {
    const a = await f.login(),
      b = await f.login(1);
    const task = (
      await a.agent
        .post("/api/tasks")
        .set("X-CSRF-Token", a.csrf)
        .send({ title: "A private task" })
        .expect(201)
    ).body.task;
    const before = await readFile(f.taskFile, "utf8");
    assert.deepEqual(
      (await b.agent.get("/api/tasks").expect(200)).body.tasks,
      [],
    );
    const absent = randomUUID();
    for (const operation of ["edit", "complete", "reopen", "delete"]) {
      const attempt = (id: string) =>
        operation === "edit"
          ? b.agent.patch(`/api/tasks/${id}`).send({ title: "theft" })
          : operation === "delete"
            ? b.agent.delete(`/api/tasks/${id}`)
            : b.agent.patch(`/api/tasks/${id}/status`).send({
                status: operation === "complete" ? "Completed" : "Pending",
              });
      const denied = await attempt(task.id)
        .set("X-CSRF-Token", b.csrf)
        .expect(404);
      const missing = await attempt(absent)
        .set("X-CSRF-Token", b.csrf)
        .expect(404);
      assert.deepEqual(denied.body, missing.body);
      assert.equal(await readFile(f.taskFile, "utf8"), before);
    }
    await a.agent
      .delete(`/api/tasks/${task.id}`)
      .set("X-CSRF-Token", a.csrf)
      .expect(200);
    await a.agent
      .delete(`/api/tasks/${task.id}`)
      .set("X-CSRF-Token", a.csrf)
      .expect(404);
    await a.agent
      .patch(`/api/tasks/${task.id}/status`)
      .set("X-CSRF-Token", a.csrf)
      .send({ status: "Pending" })
      .expect(404);
  } finally {
    await f.cleanup();
  }
});

test("TM-TC-13/27: missing, incorrect and pre-login CSRF tokens block every mutation", async () => {
  const f = await taskApiFixture();
  try {
    const a = await f.login();
    const task = (
      await a.agent
        .post("/api/tasks")
        .set("X-CSRF-Token", a.csrf)
        .send({ title: "protected" })
        .expect(201)
    ).body.task;
    const before = await readFile(f.taskFile, "utf8");
    for (const token of [undefined, "wrong", a.before]) {
      const operations = [
        a.agent.post("/api/tasks").send({ title: "bad" }),
        a.agent.patch(`/api/tasks/${task.id}`).send({ title: "bad" }),
        a.agent
          .patch(`/api/tasks/${task.id}/status`)
          .send({ status: "Completed" }),
        a.agent.delete(`/api/tasks/${task.id}`),
      ];
      for (const operation of operations) {
        if (token) operation.set("X-CSRF-Token", token);
        await operation.expect(403);
      }
      assert.equal(await readFile(f.taskFile, "utf8"), before);
    }
    await a.agent
      .patch(`/api/tasks/${task.id}/status`)
      .set("X-CSRF-Token", a.csrf)
      .send({ status: "Completed" })
      .expect(200);
  } finally {
    await f.cleanup();
  }
});

test("TM-TC-09/14/27: strict fields, malformed requests, payload limits and controlled status changes", async () => {
  const f = await taskApiFixture();
  try {
    const a = await f.login();
    const task = (
      await a.agent
        .post("/api/tasks")
        .set("X-CSRF-Token", a.csrf)
        .send({ title: "safe" })
        .expect(201)
    ).body.task;
    const before = await readFile(f.taskFile, "utf8");
    for (const field of [
      "id",
      "ownerId",
      "createdAt",
      "updatedAt",
      "status",
      "unknown",
    ]) {
      const value = field === "status" ? "Completed" : randomUUID();
      await a.agent
        .post("/api/tasks")
        .set("X-CSRF-Token", a.csrf)
        .send({ title: "attempt", [field]: value })
        .expect(400);
      await a.agent
        .patch(`/api/tasks/${task.id}`)
        .set("X-CSRF-Token", a.csrf)
        .send({ [field]: value })
        .expect(400);
    }
    for (const body of [
      {},
      { status: null },
      { status: "pending" },
      { status: "Unknown" },
      { status: 3 },
      { status: "Pending", title: "override" },
      { status: "Completed", ownerId: randomUUID() },
    ])
      await a.agent
        .patch(`/api/tasks/${task.id}/status`)
        .set("X-CSRF-Token", a.csrf)
        .send(body)
        .expect(400);
    await a.agent
      .patch(`/api/tasks/${task.id}`)
      .set("X-CSRF-Token", a.csrf)
      .send({})
      .expect(400);
    await a.agent
      .patch("/api/tasks/not-a-uuid")
      .set("X-CSRF-Token", a.csrf)
      .send({ title: "bad" })
      .expect(400);
    await a.agent
      .post("/api/tasks")
      .set("X-CSRF-Token", a.csrf)
      .set("Content-Type", "application/json")
      .send('{"title":')
      .expect("Cache-Control", "no-store")
      .expect(400);
    await a.agent
      .post("/api/tasks")
      .set("X-CSRF-Token", a.csrf)
      .send({ title: "x".repeat(17000) })
      .expect("Cache-Control", "no-store")
      .expect(413);
    await a.agent
      .delete(`/api/tasks/${task.id}`)
      .set("X-CSRF-Token", a.csrf)
      .send({ ownerId: randomUUID() })
      .expect(400);
    await a.agent.get(`/api/tasks/${task.id}`).expect(404);
    await a.agent
      .post(`/api/tasks/${task.id}/complete`)
      .set("X-CSRF-Token", a.csrf)
      .expect(404);
    assert.equal(await readFile(f.taskFile, "utf8"), before);
  } finally {
    await f.cleanup();
  }
});

test("TM-TC-21/23: task responses retain security headers, literal text and never publish storage", async () => {
  const f = await taskApiFixture();
  try {
    const a = await f.login();
    const literal = '<img src=x onerror="globalThis.attacked=true">';
    const task = await a.agent
      .post("/api/tasks")
      .set("X-CSRF-Token", a.csrf)
      .send({ title: literal, description: "<script>attack()</script>" })
      .expect(201);
    assert.equal(task.body.task.title, literal);
    const list = await a.agent
      .get("/api/tasks")
      .expect(200)
      .expect("Cache-Control", "no-store");
    assert(list.headers["content-security-policy"]);
    assert.equal(list.body.tasks[0].description, "<script>attack()</script>");
    assert(!JSON.stringify(list.body).includes("passwordHash"));
    for (const path of [
      "/tasks.html",
      "/data/tasks.json",
      "/views/tasks.html",
      "/api/users",
    ])
      await a.agent.get(path).expect(404);
  } finally {
    await f.cleanup();
  }
});

test("KAN-39-TC-007: bulk deletion rejects unauthenticated, CSRF-invalid and out-of-scope requests", async () => {
  const f = await taskApiFixture();
  try {
    const a = await f.login();
    const task = await f.store.create(a.user.id, {
      title: "Completed task",
      description: "",
      priority: "Medium",
      dueDate: null,
    });
    await f.store.setStatus(a.user.id, task.id, "Completed");
    const before = await readFile(f.taskFile, "utf8");
    const anon = request.agent(f.app);
    const token = (await anon.get("/api/csrf").expect(200)).body
      .token as string;
    await anon
      .delete("/api/tasks/completed")
      .set("X-CSRF-Token", token)
      .expect(401);
    await a.agent.delete("/api/tasks/completed").expect(403);
    await a.agent
      .delete("/api/tasks/completed")
      .set("X-CSRF-Token", "incorrect")
      .expect(403);
    await a.agent
      .delete("/api/tasks/completed")
      .set("X-CSRF-Token", a.csrf)
      .send({ ownerId: a.user.id })
      .expect(400);
    assert.equal(await readFile(f.taskFile, "utf8"), before);
  } finally {
    await f.cleanup();
  }
});
