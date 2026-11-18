import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createApp } from "../src/app.js";
import { taskFileSystem } from "../src/data/taskStore.js";
import { taskApiFixture } from "./helpers/taskApiFixture.js";

test("TM-TC-01/02/03/04/05/15/26/27: durable owner lifecycle, partial edits and no-op transitions", async () => {
  const f = await taskApiFixture();
  try {
    const { agent, csrf, user } = await f.login();
    assert.deepEqual(
      (await agent.get("/api/tasks").expect(200)).body.tasks,
      [],
    );
    const created = (
      await agent
        .post("/api/tasks")
        .set("X-CSRF-Token", csrf)
        .send({ title: "  First task  " })
        .expect(201)
    ).body.task;
    assert.equal(created.title, "First task");
    assert.equal(created.ownerId, user.id);
    assert.equal(created.description, "");
    assert.equal(created.priority, "Medium");
    assert.equal(created.status, "Pending");
    assert.equal(created.dueDate, null);
    assert.equal(created.createdAt, created.updatedAt);
    const duplicateTitle = (
      await agent
        .post("/api/tasks")
        .set("X-CSRF-Token", csrf)
        .send({
          title: "First task",
          description: "line one\n  line two  ",
          priority: "High",
          dueDate: "2000-02-29",
        })
        .expect(201)
    ).body.task;
    assert.notEqual(created.id, duplicateTitle.id);
    const path = `/api/tasks/${created.id}`;
    const complete = (
      await agent
        .patch(`${path}/status`)
        .set("X-CSRF-Token", csrf)
        .send({ status: "Completed" })
        .expect(200)
    ).body.task;
    assert.equal(complete.status, "Completed");
    assert(complete.updatedAt > created.updatedAt);
    const repeated = (
      await agent
        .patch(`${path}/status`)
        .set("X-CSRF-Token", csrf)
        .send({ status: "Completed" })
        .expect(200)
    ).body.task;
    assert.deepEqual(repeated, complete);
    const edited = (
      await agent
        .patch(path)
        .set("X-CSRF-Token", csrf)
        .send({
          title: "Renamed",
          description: "  retained\n text  ",
          dueDate: "0001-01-01",
          priority: "Low",
        })
        .expect(200)
    ).body.task;
    assert.equal(edited.status, "Completed");
    assert.equal(edited.createdAt, created.createdAt);
    assert.equal(edited.ownerId, created.ownerId);
    assert.equal(edited.id, created.id);
    assert.equal(edited.description, "  retained\n text  ");
    assert.equal(edited.dueDate, "0001-01-01");
    assert(edited.updatedAt > complete.updatedAt);
    const noOp = (
      await agent
        .patch(path)
        .set("X-CSRF-Token", csrf)
        .send({ title: " Renamed " })
        .expect(200)
    ).body.task;
    assert.deepEqual(noOp, edited);
    const cleared = (
      await agent
        .patch(path)
        .set("X-CSRF-Token", csrf)
        .send({ description: "", dueDate: "" })
        .expect(200)
    ).body.task;
    assert.equal(cleared.description, "");
    assert.equal(cleared.dueDate, null);
    assert.equal(cleared.priority, "Low");
    const reopened = (
      await agent
        .patch(`${path}/status`)
        .set("X-CSRF-Token", csrf)
        .send({ status: "Pending" })
        .expect(200)
    ).body.task;
    assert.equal(reopened.status, "Pending");
    assert(reopened.updatedAt > cleared.updatedAt);
    assert.deepEqual(
      (
        await agent
          .patch(`${path}/status`)
          .set("X-CSRF-Token", csrf)
          .send({ status: "Pending" })
          .expect(200)
      ).body.task,
      reopened,
    );
    const restart = createApp({
      secret: f.secret,
      userFile: f.userFile,
      taskFile: f.taskFile,
    });
    const logged = await f.login(0, restart);
    assert.equal(
      (await logged.agent.get("/api/tasks").expect(200)).body.tasks.length,
      2,
    );
    await logged.agent
      .delete(path)
      .set("X-CSRF-Token", logged.csrf)
      .expect(200);
    await logged.agent
      .delete(path)
      .set("X-CSRF-Token", logged.csrf)
      .expect(404);
    const later = await f.login(
      0,
      createApp({
        secret: f.secret,
        userFile: f.userFile,
        taskFile: f.taskFile,
      }),
    );
    const remaining = (await later.agent.get("/api/tasks").expect(200)).body
      .tasks;
    assert.deepEqual(
      remaining.map((t: { id: string }) => t.id),
      [duplicateTitle.id],
    );
  } finally {
    await f.cleanup();
  }
});

test("TM-TC-06/07/08/10: API field boundaries, dates, clearing and invalid edits do not mutate", async () => {
  const f = await taskApiFixture();
  try {
    const { agent, csrf } = await f.login();
    const task = (
      await agent
        .post("/api/tasks")
        .set("X-CSRF-Token", csrf)
        .send({ title: "x" })
        .expect(201)
    ).body.task;
    const invalid = [
      {},
      { title: "" },
      { title: " \t " },
      { title: null },
      { title: 4 },
      { title: "x".repeat(201) },
      { description: null },
      { description: {} },
      { description: "x".repeat(2001) },
      { priority: "medium" },
      { priority: null },
      { priority: 3 },
      { dueDate: null },
      { dueDate: 5 },
      { dueDate: "1900-02-29" },
      { dueDate: "2026-04-31" },
      { dueDate: "0000-01-01" },
      { dueDate: "2026-11-15T00:00:00Z" },
    ];
    for (const patch of invalid) {
      const before = await readFile(f.taskFile, "utf8");
      const response = await agent
        .patch(`/api/tasks/${task.id}`)
        .set("X-CSRF-Token", csrf)
        .send(patch)
        .expect(400);
      assert.equal(response.body.error.code, "VALIDATION_ERROR");
      assert.equal(await readFile(f.taskFile, "utf8"), before);
    }
    for (const body of [
      {},
      { title: "" },
      { title: null },
      { title: "x".repeat(201) },
      { title: "ok", description: null },
      { title: "ok", priority: "MEDIUM" },
      { title: "ok", dueDate: null },
    ])
      await agent
        .post("/api/tasks")
        .set("X-CSRF-Token", csrf)
        .send(body)
        .expect(400);
    for (const priority of ["Low", "Medium", "High"])
      await agent
        .patch(`/api/tasks/${task.id}`)
        .set("X-CSRF-Token", csrf)
        .send({ priority })
        .expect(200);
    for (const dueDate of [
      "0001-01-01",
      "2000-02-29",
      "2020-01-01",
      new Date().toISOString().slice(0, 10),
      "9999-12-31",
    ])
      assert.equal(
        (
          await agent
            .patch(`/api/tasks/${task.id}`)
            .set("X-CSRF-Token", csrf)
            .send({ dueDate })
            .expect(200)
        ).body.task.dueDate,
        dueDate,
      );
    const max = await agent
      .patch(`/api/tasks/${task.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ title: "😀".repeat(100), description: "x".repeat(2000) })
      .expect(200);
    assert.equal(max.body.task.title.length, 200);
    assert.equal(max.body.task.description.length, 2000);
    const fieldError = await agent
      .patch(`/api/tasks/${task.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ title: "" })
      .expect(400);
    assert(fieldError.body.error.fields.title.length);
  } finally {
    await f.cleanup();
  }
});

test("TM-TC-18/19: separate app instances serialize concurrent independent and same-record partial writes", async () => {
  const f = await taskApiFixture();
  try {
    const a = await f.login();
    const b = await f.login(
      0,
      createApp({
        secret: f.secret,
        userFile: f.userFile,
        taskFile: f.taskFile,
      }),
    );
    const created = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        (i % 2 ? a : b).agent
          .post("/api/tasks")
          .set("X-CSRF-Token", (i % 2 ? a : b).csrf)
          .send({ title: `task ${i}` })
          .expect(201),
      ),
    );
    assert.equal((await a.agent.get("/api/tasks")).body.tasks.length, 8);
    const id = created[0]!.body.task.id;
    await Promise.all([
      a.agent
        .patch(`/api/tasks/${id}`)
        .set("X-CSRF-Token", a.csrf)
        .send({ title: "changed" })
        .expect(200),
      b.agent
        .patch(`/api/tasks/${id}`)
        .set("X-CSRF-Token", b.csrf)
        .send({ description: "independent detail" })
        .expect(200),
    ]);
    const task = (await a.agent.get("/api/tasks")).body.tasks.find(
      (t: { id: string }) => t.id === id,
    );
    assert.equal(task.title, "changed");
    assert.equal(task.description, "independent detail");
    await a.agent
      .delete(`/api/tasks/${id}`)
      .set("X-CSRF-Token", a.csrf)
      .expect(200);
    await b.agent
      .patch(`/api/tasks/${id}`)
      .set("X-CSRF-Token", b.csrf)
      .send({ title: "resurrect" })
      .expect(404);
  } finally {
    await f.cleanup();
  }
});

test("TM-TC-16: corrupt and invalid stored data produce safe API errors and remain untouched", async () => {
  const f = await taskApiFixture();
  try {
    const { agent, csrf } = await f.login();
    for (const content of ["{broken", "{}", '[{"id":"invalid"}]']) {
      await writeFile(f.taskFile, content);
      for (const response of [
        await agent.get("/api/tasks").expect(500),
        await agent
          .post("/api/tasks")
          .set("X-CSRF-Token", csrf)
          .send({ title: "do not reset" })
          .expect(500),
      ]) {
        assert.equal(response.body.error.code, "INTERNAL_ERROR");
        assert(!JSON.stringify(response.body).includes(f.dir));
      }
      assert.equal(await readFile(f.taskFile, "utf8"), content);
    }
  } finally {
    await f.cleanup();
  }
});

test("TM-TC-17: failed writes/rename do not report success; original bytes survive and queue recovers", async () => {
  for (const operation of ["writeFile", "rename"] as const) {
    let fail = false;
    const f = await taskApiFixture({
      fs: {
        [operation]: async (
          ...args: Parameters<(typeof taskFileSystem)[typeof operation]>
        ) => {
          if (fail) throw new Error("Injected storage failure");
          // Both adapter operations have the same pair of string arguments.
          await taskFileSystem[operation](args[0], args[1]);
        },
      },
    });
    try {
      const { agent, csrf } = await f.login();
      const task = (
        await agent
          .post("/api/tasks")
          .set("X-CSRF-Token", csrf)
          .send({ title: "original" })
          .expect(201)
      ).body.task;
      const before = await readFile(f.taskFile, "utf8");
      fail = true;
      const response = await agent
        .patch(`/api/tasks/${task.id}`)
        .set("X-CSRF-Token", csrf)
        .send({ title: "must fail" })
        .expect(500);
      assert.equal(response.body.error.code, "INTERNAL_ERROR");
      assert.equal(await readFile(f.taskFile, "utf8"), before);
      fail = false;
      await agent
        .patch(`/api/tasks/${task.id}`)
        .set("X-CSRF-Token", csrf)
        .send({ title: "recovered" })
        .expect(200);
    } finally {
      await f.cleanup();
    }
  }
});

test("TM-TC-28: API list sorts newest first, then ascending ID on equal timestamps", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z"),
    id = 3;
  const f = await taskApiFixture({
    now: () => now,
    uuid: () => `00000000-0000-4000-8000-${String(id--).padStart(12, "0")}`,
  });
  try {
    const { agent, csrf } = await f.login();
    for (const title of ["first", "second"])
      await agent
        .post("/api/tasks")
        .set("X-CSRF-Token", csrf)
        .send({ title })
        .expect(201);
    now += 1000;
    await agent
      .post("/api/tasks")
      .set("X-CSRF-Token", csrf)
      .send({ title: "newest" })
      .expect(201);
    assert.deepEqual(
      (await agent.get("/api/tasks")).body.tasks.map(
        (t: { title: string }) => t.title,
      ),
      ["newest", "second", "first"],
    );
  } finally {
    await f.cleanup();
  }
});
