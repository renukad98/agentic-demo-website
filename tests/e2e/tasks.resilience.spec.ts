import { test, expect, signIn, createTask } from "./fixtures.js";

test("TM-TC-20/22: loading and failure states support explicit retry", async ({
  page,
  app,
}) => {
  await signIn(page, app.users[0]!);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() === "GET") {
      await hold;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "Please retry later." } }),
      });
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "Refresh tasks", exact: true })
    .click();
  await expect(
    page.getByText("Loading your tasks…", { exact: true }),
  ).toBeVisible();
  release();
  await expect(page.locator("#task-status")).toContainText(
    "Unable to load tasks",
  );
  await page.unroute("**/api/tasks");
  await page
    .getByRole("button", { name: "Refresh tasks", exact: true })
    .click();
  await expect(page.getByText("No tasks yet.", { exact: false })).toBeVisible();
});

test("TM-TC-22: Create stays disabled in flight and does not duplicate requests", async ({
  page,
  app,
}) => {
  await signIn(page, app.users[0]!);
  let posts = 0;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() === "POST") {
      posts++;
      await hold;
    }
    await route.continue();
  });
  await page.getByLabel("Task title", { exact: true }).fill("Only one");
  const create = page.getByRole("button", { name: "Create task", exact: true });
  await create.click();
  await expect(create).toBeDisabled();
  await page.locator("#task-form").dispatchEvent("submit");
  expect(posts).toBe(1);
  release();
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(create).toBeEnabled();
  expect(posts).toBe(1);
});

test("TM-TC-22: uncertain committed creation gives guidance, and expired sessions clear tasks", async ({
  page,
  app,
  context,
}) => {
  await signIn(page, app.users[0]!);
  let posts = 0;
  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() === "POST") {
      posts++;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page
    .getByLabel("Task title", { exact: true })
    .fill("Committed before connection loss");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(page.locator("#task-status")).toContainText(
    "Check your task list before retrying",
  );
  expect(posts).toBe(1);
  await page.unroute("**/api/tasks");
  await page
    .getByRole("button", { name: "Refresh tasks", exact: true })
    .click();
  await expect(page.getByRole("article")).toHaveCount(1);
  await createTask(page.request, "Clear this private content");
  await context.clearCookies();
  await page
    .getByRole("button", { name: "Refresh tasks", exact: true })
    .click();
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Log in again", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#task-workspace")).not.toBeVisible();
});

test("TM-TC-22: malformed success after committed create requires reconciliation", async ({
  page,
  app,
}) => {
  await signIn(page, app.users[0]!);
  let posts = 0;
  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() === "POST") {
      posts++;
      await route.fetch();
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: "{",
      });
    } else await route.continue();
  });
  await page
    .getByLabel("Task title", { exact: true })
    .fill("Unreadable confirmed response");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(page.locator("#task-status")).toContainText(
    "Check your task list before retrying",
  );
  expect(posts).toBe(1);
  await page.unroute("**/api/tasks");
  await page
    .getByRole("button", { name: "Refresh tasks", exact: true })
    .click();
  await expect(page.getByRole("article")).toHaveCount(1);
});

test("TM-TC-22: expired session on cached-CSRF mutation clears data without replay", async ({
  page,
  app,
  context,
}) => {
  await signIn(page, app.users[0]!);
  await page
    .getByLabel("Task title", { exact: true })
    .fill("Private task before expiry");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(1);
  await context.clearCookies();
  let mutations = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/status")) mutations++;
  });
  await page
    .getByRole("article")
    .getByRole("button", { name: "Complete", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Log in again", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
  expect(mutations).toBe(1);
});
