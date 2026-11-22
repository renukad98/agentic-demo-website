import type { Page } from "@playwright/test";
import { test, expect, signIn, createTask, apiLogin } from "./fixtures.js";
import { forStory } from "./story-cases.js";

const details = forStory("KAN-29");
const searchBox = (page: Page) =>
  page.getByRole("searchbox", { name: "Search tasks by title" });
const taskCards = (page: Page) => page.locator("[data-task-id]");
const visibleIds = (page: Page) =>
  taskCards(page).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-task-id")),
  );
const noMatches = (page: Page) =>
  page
    .getByRole("status")
    .and(page.getByText("No matching tasks found", { exact: true }));
const refreshTasks = (page: Page) =>
  page.getByRole("button", { name: "Refresh tasks", exact: true });
async function readTasks(page: Page): Promise<{ id: string; title: string }[]> {
  const response = await page.request.get("/api/tasks");
  expect(response.ok()).toBeTruthy();
  return (await response.json()).tasks;
}

const filteringTitle =
  "KAN-29-TC-001/002/004/005/006/007: keyboard search filters owned titles and restores the ordered list";
test(
  filteringTitle,
  details(filteringTitle),
  async ({ page, app, playwright }) => {
    test.slow();
    const other = await playwright.request.newContext({ baseURL: app.url });
    const privateTask = await (async () => {
      try {
        await apiLogin(other, app.users[1]!);
        return await createTask(other, "Plan release");
      } finally {
        await other.dispose();
      }
    })();
    await signIn(page, app.users[0]!);
    const plan = await createTask(page.request, "Plan release");
    const print = await createTask(page.request, "Print notes");
    const invoice = await createTask(page.request, "Invoice", {
      description: "Plan release",
    });
    const orderedIds = (await readTasks(page)).map(({ id }) => id);
    expect([...orderedIds].sort()).toEqual(
      [plan.id, print.id, invoice.id].sort(),
    );

    await page.reload();
    const search = searchBox(page);
    const privateCard = taskCards(page).and(
      page.locator('[data-task-id="' + privateTask.id + '"]'),
    );
    await expect(search).toBeVisible();
    await expect.poll(() => visibleIds(page)).toEqual(orderedIds);
    await expect(privateCard).toHaveCount(0);

    await refreshTasks(page).focus();
    await page.keyboard.press("Tab");
    await expect(search).toBeFocused();
    await expect(search.and(page.locator(":focus-visible"))).toBeVisible();
    await expect(search).toHaveCSS("outline-style", "solid");
    await expect(search).toHaveCSS("outline-width", "3px");

    await page.keyboard.type("P");
    await expect
      .poll(() => visibleIds(page))
      .toEqual(orderedIds.filter((id) => id !== invoice.id));
    await page.keyboard.type("L");
    await expect.poll(() => visibleIds(page)).toEqual([plan.id]);
    await expect(privateCard).toHaveCount(0);
    await expect(search).toBeFocused();

    await search.fill("plan");
    await expect.poll(() => visibleIds(page)).toEqual([plan.id]);
    await expect(search).toBeFocused();
    await search.press("ControlOrMeta+A");
    await search.press("Backspace");
    await expect(search).toHaveValue("");
    await expect.poll(() => visibleIds(page)).toEqual(orderedIds);
    await expect(search).toBeFocused();
    await expect(privateCard).toHaveCount(0);

    await search.fill("zzz");
    await expect(taskCards(page)).toHaveCount(0);
    await expect(noMatches(page)).toBeVisible();
    await search.press("ControlOrMeta+A");
    await search.press("Backspace");
    await expect(search).toHaveValue("");
    await expect.poll(() => visibleIds(page)).toEqual(orderedIds);
    await expect(noMatches(page)).toBeHidden();
    await expect(privateCard).toHaveCount(0);
    await expect(search).toBeFocused();
  },
);

const persistenceTitle =
  "KAN-29-TC-003/008/011/012/013: search matches literal titles and persists through in-page updates";
test(persistenceTitle, details(persistenceTitle), async ({ page, app }) => {
  test.slow();
  await signIn(page, app.users[0]!);
  const search = searchBox(page);
  const empty = page.getByText("No tasks yet.", { exact: false });
  await expect(search).toHaveValue("");
  await expect(empty).toBeVisible();
  await search.fill("plan");
  await expect(noMatches(page)).toBeVisible();
  await expect(empty).toBeHidden();
  await search.clear();
  await expect(empty).toBeVisible();
  await expect(noMatches(page)).toBeHidden();

  const plan = await createTask(page.request, "Weekly planning");
  const invoice = await createTask(page.request, "Invoice");
  const initialIds = (await readTasks(page)).map(({ id }) => id);
  expect([...initialIds].sort()).toEqual([plan.id, invoice.id].sort());
  await refreshTasks(page).click();
  await expect.poll(() => visibleIds(page)).toEqual(initialIds);
  await search.fill("  plan  ");
  await expect.poll(() => visibleIds(page)).toEqual([plan.id]);
  await search.fill("   ");
  await expect.poll(() => visibleIds(page)).toEqual(initialIds);

  await search.fill("plan");
  await expect(search).toHaveValue("plan");
  await expect.poll(() => visibleIds(page)).toEqual([plan.id]);
  const planCard = page.locator('[data-task-id="' + plan.id + '"]');
  await planCard.getByRole("button", { name: "Complete", exact: true }).click();
  await expect(planCard).toContainText("Completed");
  await expect(search).toHaveValue("plan");
  await expect.poll(() => visibleIds(page)).toEqual([plan.id]);

  const literalTitle = "PLAN [follow-up] <b>draft</b>";
  const followUp = await createTask(page.request, literalTitle);
  const allIds = (await readTasks(page)).map(({ id }) => id);
  expect([...allIds].sort()).toEqual([plan.id, invoice.id, followUp.id].sort());
  const matchingIds = allIds.filter((id) => id !== invoice.id);
  await refreshTasks(page).click();
  await expect.poll(() => visibleIds(page)).toEqual(matchingIds);
  await expect(search).toHaveValue("plan");

  await search.fill("PLAN");
  await expect.poll(() => visibleIds(page)).toEqual(matchingIds);
  await page.reload();
  await expect(search).toHaveValue("");
  await expect.poll(() => visibleIds(page)).toEqual(allIds);

  const literalHeading = page.getByRole("heading", {
    name: literalTitle,
    exact: true,
  });
  for (const query of ["[", "<b>"]) {
    await search.fill(query);
    await expect.poll(() => visibleIds(page)).toEqual([followUp.id]);
    await expect(literalHeading).toHaveText(literalTitle);
    await expect(literalHeading.locator("b")).toHaveCount(0);
  }
});

const fetchErrorTitle =
  "KAN-29-TC-009: loading and refresh failure suppress the no-match message";
test(fetchErrorTitle, details(fetchErrorTitle), async ({ page, app }) => {
  test.slow();
  await signIn(page, app.users[0]!);
  const search = searchBox(page);
  const plan = await createTask(page.request, "Weekly planning");
  await refreshTasks(page).click();
  await expect.poll(() => visibleIds(page)).toEqual([plan.id]);
  await search.fill("zzz");
  await expect(noMatches(page)).toBeVisible();

  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await pending;
    await route.fulfill({
      status: 500,
      json: { error: { message: "Please retry later." } },
    });
  });

  const loading = page.getByText("Loading your tasks…", { exact: true });
  const noMatchMessage = page.getByText("No matching tasks found", {
    exact: true,
  });
  try {
    await refreshTasks(page).click();
    await expect(loading).toBeVisible();
    await expect(noMatchMessage).toBeHidden();
  } finally {
    release();
  }
  await expect(page.locator("#task-status")).toContainText(
    "Unable to load tasks. Please retry later. Use Refresh tasks to retry.",
  );
  await expect(loading).toBeHidden();
  await expect(noMatchMessage).toBeHidden();
  await page.unroute("**/api/tasks");
  await refreshTasks(page).click();
  await expect(search).toHaveValue("zzz");
  await expect(noMatches(page)).toBeVisible();
});

const lifecycleTitle =
  "KAN-29-TC-010: searching leaves tasks unchanged and preserves the task lifecycle";
test(lifecycleTitle, details(lifecycleTitle), async ({ page, app }) => {
  test.slow();
  await signIn(page, app.users[0]!);
  const plan = await createTask(page.request, "Weekly planning");
  await createTask(page.request, "Invoice");
  const before = await readTasks(page);
  const originalIds = before.map(({ id }) => id);
  await refreshTasks(page).click();
  await expect.poll(() => visibleIds(page)).toEqual(originalIds);

  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      /^\/api\/tasks(?:\/|$)/.test(new URL(request.url()).pathname) &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())
    ) {
      writes.push(request.method());
    }
  });
  const search = searchBox(page);
  await search.fill("plan");
  await expect.poll(() => visibleIds(page)).toEqual([plan.id]);
  expect(await readTasks(page)).toEqual(before);
  expect(writes).toEqual([]);
  await search.clear();
  await expect.poll(() => visibleIds(page)).toEqual(originalIds);
  expect(await readTasks(page)).toEqual(before);
  expect(writes).toEqual([]);

  const titleField = page.getByLabel("Task title", { exact: true });
  await titleField.fill("Lifecycle addition");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(page.locator("#task-status")).toHaveText("Task created.");
  const created = (await readTasks(page)).find(
    ({ title }) => title === "Lifecycle addition",
  );
  expect(created).toBeDefined();
  const createdId = created!.id;
  const card = page.locator('[data-task-id="' + createdId + '"]');
  await expect
    .poll(() => visibleIds(page))
    .toEqual([createdId, ...originalIds]);
  await expect(card.getByRole("heading")).toHaveText("Lifecycle addition");

  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await titleField.fill("Lifecycle renamed");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(card.getByRole("heading")).toHaveText("Lifecycle renamed");

  await card.getByRole("button", { name: "Complete", exact: true }).click();
  await expect(
    card.getByText("Medium priority · Completed", { exact: true }),
  ).toBeVisible();

  await card.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Permanently delete task?" });
  await dialog
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => visibleIds(page)).toEqual(originalIds);
  expect(await readTasks(page)).toEqual(before);
  expect(writes).toEqual(["POST", "PATCH", "PATCH", "DELETE"]);
});

const expiryTitle =
  "KAN-29-TC-014: session expiry clears private matching tasks";
test(expiryTitle, details(expiryTitle), async ({ page, app, context }) => {
  await signIn(page, app.users[0]!);
  const privateTask = await createTask(page.request, "Private planning note");
  await createTask(page.request, "Invoice");
  await refreshTasks(page).click();
  await expect(taskCards(page)).toHaveCount(2);
  const search = searchBox(page);
  await search.fill("plan");
  await expect.poll(() => visibleIds(page)).toEqual([privateTask.id]);
  await expect(
    page.getByRole("heading", { name: "Private planning note", exact: true }),
  ).toBeVisible();

  await context.clearCookies();
  await refreshTasks(page).click();
  await expect(taskCards(page)).toHaveCount(0);
  await expect(page.locator("#task-search")).toHaveValue("");
  await expect(page.locator("#task-workspace")).toBeHidden();
  await expect(
    page.getByRole("link", { name: "Log in again", exact: true }),
  ).toBeVisible();
});
