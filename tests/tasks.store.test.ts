import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import {
  TaskStore,
  taskFileSystem,
  type TaskStoreOptions,
} from "../src/data/taskStore.js";
import {
  createTaskSchema,
  updateTaskSchema,
} from "../src/tasks/taskValidation.js";

const owner = randomUUID();
const other = randomUUID();
const input = (title = "Task") => createTaskSchema.parse({ title });
async function fixture(work: (file: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "tasks-store-"));
  try {
    await work(join(dir, "tasks.json"), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("TM-TC-01 TM-TC-02 TM-TC-15: missing file, unique tasks, isolation and restart durability", async () => {
  await fixture(async (file) => {
    const store = new TaskStore(file);
    assert.deepEqual(await store.list(owner), []);
    const a = await store.create(owner, input());
    const b = await store.create(owner, input());
    await store.create(other, input("Other"));
    assert.notEqual(a.id, b.id);
    assert.equal(a.createdAt, a.updatedAt);
    assert.equal(a.status, "Pending");
    assert.equal(a.ownerId, owner);
    a.title = "Detached caller change";
    const loaded = await new TaskStore(file).list(owner);
    assert.equal(loaded.length, 2);
    assert(loaded.every((t) => t.title === "Task"));
    assert.equal((await store.list(other)).length, 1);
  });
});
test("TM-TC-03 TM-TC-04 TM-TC-26 TM-TC-27: partial edits, complete/reopen and no-op timestamps", async () => {
  await fixture(async (file) => {
    const store = new TaskStore(file, { now: () => 0 });
    const task = await store.create(owner, input());
    const completed = await store.setStatus(owner, task.id, "Completed");
    assert.equal(completed?.status, "Completed");
    assert(completed!.updatedAt > task.updatedAt);
    const unchanged = await store.setStatus(owner, task.id, "Completed");
    assert.deepEqual(unchanged, completed);
    const edited = await store.update(
      owner,
      task.id,
      updateTaskSchema.parse({ title: " New " }),
    );
    assert.equal(edited?.title, "New");
    assert.equal(edited?.status, "Completed");
    assert.equal(edited?.createdAt, task.createdAt);
    const noOp = await store.update(
      owner,
      task.id,
      updateTaskSchema.parse({ title: "New" }),
    );
    assert.equal(noOp?.updatedAt, edited?.updatedAt);
    const reopened = await store.setStatus(owner, task.id, "Pending");
    assert.equal(reopened?.status, "Pending");
    assert(reopened!.updatedAt > edited!.updatedAt);
    assert.deepEqual(
      await store.setStatus(owner, task.id, "Pending"),
      reopened,
    );
    await store.update(
      owner,
      task.id,
      updateTaskSchema.parse({ dueDate: "2024-02-29", description: " \n " }),
    );
    const cleared = await store.update(
      owner,
      task.id,
      updateTaskSchema.parse({ dueDate: "", description: "" }),
    );
    assert.equal(cleared?.dueDate, null);
    assert.equal(cleared?.description, "");
  });
});
test("TM-TC-12 TM-TC-25: inaccessible, absent and deleted IDs never mutate or resurrect tasks", async () => {
  await fixture(async (file) => {
    const store = new TaskStore(file);
    const task = await store.create(owner, input());
    const before = await readFile(file, "utf8");
    assert.equal(
      await store.update(
        other,
        task.id,
        updateTaskSchema.parse({ title: "Stolen" }),
      ),
      null,
    );
    assert.equal(await store.setStatus(other, task.id, "Completed"), null);
    assert.equal(await store.delete(other, task.id), false);
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal(await store.delete(owner, task.id), true);
    assert.equal(await store.delete(owner, task.id), false);
    assert.equal(
      await store.update(
        owner,
        task.id,
        updateTaskSchema.parse({ title: "Restored" }),
      ),
      null,
    );
    assert.equal(await store.setStatus(owner, task.id, "Pending"), null);
    assert.deepEqual(await new TaskStore(file).list(owner), []);
  });
});
test("TM-TC-16: malformed or structurally invalid storage is never reset", async () => {
  await fixture(async (file) => {
    for (const text of ["{invalid", "{}", '[{"title":"invalid"}]']) {
      await writeFile(file, text);
      const store = new TaskStore(file);
      await assert.rejects(store.list(owner));
      await assert.rejects(store.create(owner, input()));
      assert.equal(await readFile(file, "utf8"), text);
    }
    await writeFile(file, "[]");
    const store = new TaskStore(file);
    const task = await store.create(owner, input());
    await writeFile(file, JSON.stringify([task, task]));
    await assert.rejects(store.list(owner));
  });
});
for (const failure of ["write", "partial-write", "rename"] as const) {
  test(`TM-TC-17: ${failure} failure preserves bytes, cleans temp and queue recovers`, async () => {
    await fixture(async (file, dir) => {
      const good = new TaskStore(file);
      const task = await good.create(owner, input());
      const before = await readFile(file, "utf8");
      let fail = true;
      const fs: TaskStoreOptions["fs"] = {
        writeFile: async (path, content) => {
          if (fail && failure !== "rename") {
            if (failure === "partial-write")
              await taskFileSystem.writeFile(path, content.slice(0, 10));
            throw new Error("controlled write failure");
          }
          await taskFileSystem.writeFile(path, content);
        },
        rename: async (from, to) => {
          if (fail && failure === "rename")
            throw new Error("controlled rename failure");
          await taskFileSystem.rename(from, to);
        },
      };
      const store = new TaskStore(file, { fs });
      await assert.rejects(
        store.update(
          owner,
          task.id,
          updateTaskSchema.parse({ title: "Failed" }),
        ),
      );
      assert.equal(await readFile(file, "utf8"), before);
      assert.deepEqual((await readdir(dir)).sort(), ["tasks.json"]);
      fail = false;
      assert.equal(
        (
          await store.update(
            owner,
            task.id,
            updateTaskSchema.parse({ title: "Recovered" }),
          )
        )?.title,
        "Recovered",
      );
    });
  });
}
test("TM-TC-18 TM-TC-19: shared per-path queues serialize independent and conflicting writes", async () => {
  await fixture(async (file) => {
    const a = new TaskStore(file);
    const b = new TaskStore(relative(process.cwd(), file));
    const tasks = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? a : b).create(owner, input(`Task ${i}`)),
      ),
    );
    assert.equal((await a.list(owner)).length, 20);
    assert.equal(new Set(tasks.map((t) => t.id)).size, 20);
    const task = tasks[0]!;
    const first = a.update(
      owner,
      task.id,
      updateTaskSchema.parse({ title: "First", priority: "High" }),
    );
    const second = b.update(
      owner,
      task.id,
      updateTaskSchema.parse({ title: "Last", description: "Preserved" }),
    );
    await Promise.all([first, second]);
    const final = (await a.list(owner)).find((t) => t.id === task.id)!;
    assert.equal(final.title, "Last");
    assert.equal(final.priority, "High");
    assert.equal(final.description, "Preserved");
    await Promise.all([
      a.delete(owner, task.id),
      b.update(
        owner,
        task.id,
        updateTaskSchema.parse({ title: "No resurrection" }),
      ),
    ]);
    assert.equal(
      (await a.list(owner)).find((t) => t.id === task.id),
      undefined,
    );
  });
});
test("TM-TC-18: canonical directory aliases share writes", async () => {
  await fixture(async (file, dir) => {
    const alias = `${dir}-alias`;
    await symlink(
      dir,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    try {
      const a = new TaskStore(file);
      const b = new TaskStore(join(alias, "tasks.json"));
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          (i % 2 ? a : b).create(owner, input(`${i}`)),
        ),
      );
      assert.equal((await a.list(owner)).length, 10);
    } finally {
      await rm(alias);
    }
  });
});
test("TM-TC-28: newest-first order uses deterministic ascending task ID on equal timestamps", async () => {
  await fixture(async (file) => {
    let now = 0;
    const ids = [
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000003",
    ];
    const store = new TaskStore(file, {
      now: () => now,
      uuid: () => ids.shift()!,
    });
    await store.create(owner, input("Tie 2"));
    await store.create(owner, input("Tie 1"));
    now = 10;
    await store.create(owner, input("Newest"));
    assert.deepEqual(
      (await store.list(owner)).map((t) => t.title),
      ["Newest", "Tie 1", "Tie 2"],
    );
  });
});
test("TM-TC-26: no-op requests never call a write adapter", async () => {
  await fixture(async (file) => {
    const base = new TaskStore(file);
    const task = await base.create(owner, input());
    const store = new TaskStore(file, {
      fs: {
        writeFile: async () => {
          throw new Error("must not write");
        },
      },
    });
    assert.deepEqual(
      await store.update(
        owner,
        task.id,
        updateTaskSchema.parse({ title: task.title }),
      ),
      task,
    );
    assert.deepEqual(await store.setStatus(owner, task.id, "Pending"), task);
  });
});

test("TM-TC-09: direct store calls cannot override protected fields", async () => {
  await fixture(async (file) => {
    const store = new TaskStore(file);
    const task = await store.create(owner, input());
    const before = await readFile(file, "utf8");
    await assert.rejects(
      store.update(owner, task.id, {
        title: "Changed",
        ownerId: other,
      } as never),
    );
    await assert.rejects(
      store.create(owner, { ...input(), status: "Completed" } as never),
    );
    assert.equal(await readFile(file, "utf8"), before);
  });
});

test("TM-TC-16: read errors other than missing data fail closed", async () => {
  await fixture(async (file) => {
    const store = new TaskStore(file, {
      fs: {
        readFile: async () => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        },
      },
    });
    await assert.rejects(store.list(owner));
    await assert.rejects(store.create(owner, input()));
  });
});

if (process.platform === "win32") {
  test("TM-TC-18: Windows case aliases share the canonical queue on the test volume", async () => {
    await fixture(async (file, dir) => {
      const a = new TaskStore(file);
      const b = new TaskStore(join(dir, "TASKS.JSON"));
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          (i % 2 ? a : b).create(owner, input(`${i}`)),
        ),
      );
      assert.equal((await a.list(owner)).length, 10);
      assert.equal((await b.list(owner)).length, 10);
      assert.equal((await readdir(dir)).length, 1);
    });
  });
}
