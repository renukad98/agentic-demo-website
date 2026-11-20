import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
// @ts-expect-error The task controller deliberately remains browser JavaScript.
import { initTasks } from "../public/js/tasks.js";

const markup = await readFile("views/tasks.html", "utf8");
function dom() {
  const d = new JSDOM(markup, { url: "http://localhost/tasks" });
  d.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  d.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  return d;
}
const record = {
  id: "f438ad5e-7da0-4f46-9307-20607bda0654",
  ownerId: "owner",
  title: "<img src=x onerror=alert(1)>",
  description: " first line\n second line ",
  priority: "Medium",
  status: "Pending",
  dueDate: "2020-02-29",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
async function settled(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert(predicate(), "observable controller update did not settle");
}
test("TM-TC-20 TM-TC-21: renders literal text, whitespace, labels and empty state without persistent task storage", async () => {
  const d = dom();
  let tasks = [record];
  const controller = initTasks(d.window.document, async () => json({ tasks }));
  try {
    await controller.ready;
    assert.equal(
      d.window.document.querySelector("article h3")?.textContent,
      record.title,
    );
    assert.equal(d.window.document.querySelector("article img"), null);
    assert.equal(
      d.window.document.querySelector(".task-description")?.textContent,
      record.description,
    );
    assert(
      d.window.document
        .querySelector("article")
        ?.textContent?.includes("2020-02-29"),
    );
    assert.equal(d.window.localStorage.length, 0);
    assert.equal(d.window.sessionStorage.length, 0);
    tasks = [];
    await controller.reload();
    assert.equal(
      d.window.document.querySelector<HTMLElement>("#task-empty")?.hidden,
      false,
    );
    assert.equal(
      d.window.document.querySelector("#task-loading")?.getAttribute("hidden"),
      "",
    );
  } finally {
    controller.dispose();
    d.window.close();
  }
});

test("TM-TC-06 TM-TC-20: blank validation and server field errors are associated with controls and preserve input", async () => {
  const d = dom();
  const controller = initTasks(d.window.document, async (url: string) =>
    url === "/api/tasks" ? json({ tasks: [] }) : json({ token: "fixture" }),
  );
  try {
    await controller.ready;
    const form = d.window.document.querySelector<HTMLFormElement>("form")!;
    form.dispatchEvent(
      new d.window.Event("submit", { bubbles: true, cancelable: true }),
    );
    assert.equal(
      d.window.document
        .querySelector("#task-title")
        ?.getAttribute("aria-invalid"),
      "true",
    );
    assert.equal(d.window.document.activeElement?.id, "task-title");
    assert(d.window.document.querySelector("#task-title-error")?.textContent);
  } finally {
    controller.dispose();
    d.window.close();
  }
  const second = dom();
  const c = initTasks(
    second.window.document,
    async (url: string, options: { method?: string }) =>
      options?.method === "POST"
        ? json(
            {
              error: {
                message: "Check fields.",
                fields: { description: ["Too long."] },
              },
            },
            400,
          )
        : url === "/api/csrf"
          ? json({ token: "fixture" })
          : json({ tasks: [] }),
  );
  try {
    await c.ready;
    second.window.document.querySelector<HTMLInputElement>(
      "#task-title",
    )!.value = "Retain this";
    second.window.document
      .querySelector("form")!
      .dispatchEvent(new second.window.Event("submit", { cancelable: true }));
    await settled(
      () =>
        second.window.document.querySelector("#task-description-error")
          ?.textContent === "Too long.",
    );
    assert.equal(
      second.window.document.querySelector<HTMLInputElement>("#task-title")!
        .value,
      "Retain this",
    );
    assert.equal(
      second.window.document
        .querySelector("#task-description")
        ?.getAttribute("aria-invalid"),
      "true",
    );
    assert.equal(
      second.window.document.querySelector<HTMLButtonElement>("#task-submit")!
        .disabled,
      false,
    );
  } finally {
    c.dispose();
    second.window.close();
  }
});

test("TM-TC-22: duplicate in-flight submissions are guarded and uncertain create failures advise reconciliation", async () => {
  const d = dom();
  let posts = 0;
  let fail!: (reason: Error) => void;
  const pending = new Promise<Response>((_resolve, reject) => {
    fail = reject;
  });
  const controller = initTasks(
    d.window.document,
    async (url: string, options: { method?: string }) => {
      if (options?.method === "POST") {
        posts++;
        return pending;
      }
      return json(url === "/api/csrf" ? { token: "fixture" } : { tasks: [] });
    },
  );
  try {
    await controller.ready;
    d.window.document.querySelector<HTMLInputElement>("#task-title")!.value =
      "One request";
    const form = d.window.document.querySelector("form")!;
    form.dispatchEvent(new d.window.Event("submit", { cancelable: true }));
    form.dispatchEvent(new d.window.Event("submit", { cancelable: true }));
    await settled(() => posts === 1);
    assert.equal(
      d.window.document.querySelector<HTMLButtonElement>("#task-submit")!
        .disabled,
      true,
    );
    fail(new TypeError("Network interrupted"));
    await settled(
      () =>
        d.window.document
          .querySelector("#task-status")
          ?.textContent?.includes("Check your task list") ?? false,
    );
    assert.equal(posts, 1);
    assert.equal(
      d.window.document.querySelector<HTMLInputElement>("#task-title")!.value,
      "One request",
    );
    assert.equal(
      d.window.document.querySelector<HTMLButtonElement>("#task-submit")!
        .disabled,
      false,
    );
  } finally {
    controller.dispose();
    d.window.close();
  }
});

test("TM-TC-22: detected session expiry clears rendered tasks and edit state", async () => {
  const d = dom();
  let expired = false;
  const c = initTasks(d.window.document, async () =>
    expired
      ? json({ error: { message: "Please log in." } }, 401)
      : json({ tasks: [record] }),
  );
  try {
    await c.ready;
    assert(d.window.document.querySelector("article"));
    d.window.document
      .querySelector<HTMLButtonElement>("article button")!
      .click();
    expired = true;
    await c.reload();
    assert.equal(d.window.document.querySelector("article"), null);
    assert.equal(
      d.window.document.querySelector<HTMLInputElement>("#task-title")!.value,
      "",
    );
    assert.equal(
      d.window.document.querySelector<HTMLElement>("#task-workspace")!.hidden,
      true,
    );
    assert.equal(
      d.window.document.querySelector<HTMLElement>("#task-login")!.hidden,
      false,
    );
  } finally {
    c.dispose();
    d.window.close();
  }
});

test("TM-TC-22: cached CSRF rejection checks session read-only and clears expired private content without replay", async () => {
  const d = dom();
  let expired = false;
  let writes = 0;
  const c = initTasks(
    d.window.document,
    async (url: string, options: { method?: string }) => {
      if (url === "/api/csrf") return json({ token: "fixture" });
      if (url === "/api/auth/me")
        return json({ error: { message: "Please log in." } }, 401);
      if (options?.method === "PATCH") {
        writes++;
        return expired
          ? json({ error: { message: "Invalid CSRF." } }, 403)
          : json({ task: record });
      }
      return json({ tasks: [record] });
    },
  );
  try {
    await c.ready;
    expired = true;
    const complete = [
      ...d.window.document.querySelectorAll<HTMLButtonElement>(
        "article button",
      ),
    ].find((b) => b.textContent === "Complete")!;
    complete.click();
    await settled(
      () =>
        d.window.document.querySelector<HTMLElement>("#task-login")!.hidden ===
        false,
    );
    assert.equal(writes, 1);
    assert.equal(d.window.document.querySelector("article"), null);
    assert.equal(
      d.window.document.querySelector<HTMLElement>("#task-workspace")!.hidden,
      true,
    );
  } finally {
    c.dispose();
    d.window.close();
  }
});

test("TM-TC-22: unreadable successful create response is uncertain, not safe to retry automatically", async () => {
  const d = dom();
  let posts = 0;
  const c = initTasks(
    d.window.document,
    async (url: string, options: { method?: string }) => {
      if (url === "/api/csrf") return json({ token: "fixture" });
      if (options?.method === "POST") {
        posts++;
        return new Response("{", { status: 201 });
      }
      return json({ tasks: [] });
    },
  );
  try {
    await c.ready;
    d.window.document.querySelector<HTMLInputElement>("#task-title")!.value =
      "Potentially saved";
    d.window.document
      .querySelector("form")!
      .dispatchEvent(new d.window.Event("submit", { cancelable: true }));
    await settled(() =>
      d.window.document
        .querySelector("#task-status")!
        .textContent!.includes("Check your task list"),
    );
    assert.equal(posts, 1);
    assert.equal(
      d.window.document.querySelector<HTMLInputElement>("#task-title")!.value,
      "Potentially saved",
    );
  } finally {
    c.dispose();
    d.window.close();
  }
});

test("TM-TC-10: incomplete native date input is not silently interpreted as clearing a due date", async () => {
  const d = dom();
  let writes = 0;
  const c = initTasks(
    d.window.document,
    async (_url: string, options: { method?: string }) => {
      if (options?.method === "POST") writes++;
      return json({ tasks: [] });
    },
  );
  try {
    await c.ready;
    d.window.document.querySelector<HTMLInputElement>("#task-title")!.value =
      "Valid title";
    Object.defineProperty(
      d.window.document.querySelector("#task-dueDate"),
      "validity",
      { value: { badInput: true } },
    );
    d.window.document
      .querySelector("form")!
      .dispatchEvent(new d.window.Event("submit", { cancelable: true }));
    assert.equal(writes, 0);
    assert.equal(
      d.window.document
        .querySelector("#task-dueDate")!
        .getAttribute("aria-invalid"),
      "true",
    );
    assert(
      d.window.document
        .querySelector("#task-dueDate-error")!
        .textContent!.includes("complete valid due date"),
    );
  } finally {
    c.dispose();
    d.window.close();
  }
});

test("KAN-39-TC-001/002/003/004/010: bulk confirmation, cancellation, failure, and success", async () => {
  const d = dom();
  const doc = d.window.document;
  const completed = {
    ...record,
    title: "Completed fixture",
    status: "Completed",
  };
  const pending = { ...record, id: "pending", title: "Pending fixture" };
  let tasks = [pending];
  let writes = 0;
  let fail = true;
  const controller = initTasks(
    doc,
    async (url: string, options: RequestInit) => {
      if (url === "/api/csrf") return json({ token: "fixture" });
      if (url === "/api/tasks" && options.method === "GET")
        return json({ tasks });
      assert.equal(url, "/api/tasks/completed");
      assert.equal(options.method, "DELETE");
      writes++;
      if (fail)
        return json({ error: { message: "Unable to delete tasks." } }, 500);
      tasks = [pending];
      return json({ deletedIds: [completed.id] });
    },
  );
  try {
    const clear = doc.querySelector<HTMLButtonElement>(
      "#task-clear-completed",
    )!;
    const dialog = doc.querySelector<HTMLDialogElement>("#task-delete-dialog")!;
    const confirm = doc.querySelector<HTMLButtonElement>(
      "#task-delete-confirm",
    )!;
    const status = doc.querySelector("#task-status")!;
    const titles = () =>
      [...doc.querySelectorAll("#task-list h3")].map(
        (node) => node.textContent,
      );
    await controller.ready;
    assert.equal(clear.hidden, true);
    tasks = [pending, completed];
    await controller.reload();
    assert.equal(clear.hidden, false);

    clear.click();
    assert.equal(dialog.open, true);
    assert.match(
      dialog.textContent!,
      /all your completed tasks will be permanently deleted/i,
    );
    assert.equal(writes, 0);
    doc.querySelector<HTMLButtonElement>("#task-delete-cancel")!.click();
    assert.equal(dialog.open, false);
    assert.equal(doc.activeElement, clear);
    clear.click();
    dialog.dispatchEvent(new d.window.Event("cancel", { cancelable: true }));
    assert.equal(dialog.open, false);
    assert.equal(writes, 0);
    assert.deepEqual(titles(), [pending.title, completed.title]);

    clear.click();
    confirm.click();
    await settled(() => status.textContent === "Unable to delete tasks.");
    assert.deepEqual(titles(), [pending.title, completed.title]);
    fail = false;
    clear.click();
    confirm.click();
    await settled(() => doc.activeElement?.id === "task-list-heading");
    assert.equal(writes, 2);
    assert.equal(clear.hidden, true);
    assert.deepEqual(titles(), [pending.title]);
    await controller.reload();
    assert.deepEqual(titles(), [pending.title]);
  } finally {
    controller.dispose();
    d.window.close();
  }
});
