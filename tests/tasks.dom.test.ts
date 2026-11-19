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

test("KAN-29: title search filters live, restores order, and keeps the query through refresh", async () => {
  const d = dom();
  const doc = d.window.document;
  const search = doc.querySelector<HTMLInputElement>("#task-search")!;
  const empty = doc.querySelector<HTMLElement>("#task-empty")!;
  const noMatches = doc.querySelector<HTMLElement>("#task-no-matches")!;
  const plan = { ...record, id: "plan", title: "Weekly Planning [Q4]" };
  const print = { ...record, id: "print", title: "Print notes" };
  const invoice = {
    ...record,
    id: "invoice",
    title: "Invoice",
    description: "Planning",
  };
  let tasks = [plan, print, invoice];
  let fail = false;
  const requests: string[] = [];
  const controller = initTasks(doc, async (url: string, init: RequestInit) => {
    requests.push(`${init.method} ${url}`);
    return fail ? json({}, 500) : json({ tasks });
  });
  const visibleIds = () =>
    Array.from(
      doc.querySelectorAll<HTMLElement>("[data-task-id]"),
      (card) => card.dataset.taskId,
    );
  const type = (query: string) => {
    search.value = query;
    search.dispatchEvent(new d.window.Event("input", { bubbles: true }));
  };
  try {
    assert.equal(await controller.ready, true);
    assert.equal(search.labels?.[0]?.textContent, "Search tasks by title");
    search.focus();
    type("p");
    assert.deepEqual(visibleIds(), ["plan", "print"]);
    type("  PLAN  ");
    assert.deepEqual(visibleIds(), ["plan"]);
    type("[");
    assert.deepEqual(visibleIds(), ["plan"]);
    type("<b>");
    assert.deepEqual(visibleIds(), []);
    assert.equal(noMatches.hidden, false);
    assert.equal(noMatches.textContent?.trim(), "No matching tasks found");
    assert.equal(noMatches.getAttribute("role"), "status");
    assert.equal(empty.hidden, true);
    type("   ");
    assert.deepEqual(visibleIds(), ["plan", "print", "invoice"]);
    assert.equal(noMatches.hidden, true);
    assert.equal(doc.activeElement, search);
    assert.deepEqual(requests, ["GET /api/tasks"]);

    type("plan");
    tasks = [{ ...plan, id: "updated" }, invoice];
    assert.equal(await controller.reload(), true);
    assert.equal(search.value, "plan");
    assert.deepEqual(visibleIds(), ["updated"]);

    tasks = [];
    assert.equal(await controller.reload(), true);
    assert.equal(noMatches.hidden, false);
    type("");
    assert.equal(empty.hidden, false);
    assert.equal(noMatches.hidden, true);

    fail = true;
    assert.equal(await controller.reload(), false);
    type("plan");
    assert.equal(noMatches.hidden, true);
    assert.equal(empty.hidden, true);
    assert.match(
      doc.querySelector("#task-status")?.textContent ?? "",
      /Unable to load tasks/,
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
