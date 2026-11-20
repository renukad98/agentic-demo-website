import type { Page } from "@playwright/test";
import {
  apiLogin,
  createTask,
  expect,
  signIn,
  test,
  token,
} from "./fixtures.js";
import { forStory } from "./story-cases.js";

const details = forStory("KAN-39");
const bulkPath = "/api/tasks/completed";
const clearButton = (page: Page) =>
  page.getByRole("button", { name: "Clear completed tasks", exact: true });
const confirmation = (page: Page) =>
  page.getByRole("dialog", { name: "Clear completed tasks?", exact: true });
const taskTitle = (page: Page, title: string) =>
  page.getByRole("heading", { name: title, exact: true });

async function createCompleted(page: Page, title: string) {
  const task = await createTask(page.request, title);
  const response = await page.request.patch(`/api/tasks/${task.id}/status`, {
    headers: { "X-CSRF-Token": await token(page.request) },
    data: { status: "Completed" },
  });
  expect(response.status()).toBe(200);
}

function observeBulkDeletes(page: Page) {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "DELETE" &&
      new URL(request.url()).pathname === bulkPath
    )
      requests.push(request.url());
  });
  return requests;
}

const openTitle = "KAN-39-TC-001: Open the bulk confirmation by keyboard";
test(openTitle, details(openTitle), async ({ page, app }) => {
  await signIn(page, app.users[0]!);
  await createCompleted(page, "Completed fixture");
  await createTask(page.request, "Pending fixture");
  await page.reload();
  const clear = clearButton(page);
  await expect(clear).toBeEnabled();
  const deletes = observeBulkDeletes(page);

  await page
    .getByRole("heading", { name: "Your task list", exact: true })
    .focus();
  await page.keyboard.press("Tab");
  await expect(clear).toBeFocused();
  await page.keyboard.press("Enter");

  const dialog = confirmation(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(
    /all your completed tasks will be permanently deleted/i,
  );
  await expect(
    dialog.getByRole("button", { name: "Cancel deletion", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Delete permanently", exact: true }),
  ).toBeFocused();
  expect(deletes).toHaveLength(0);
});

const confirmTitle = "KAN-39-TC-002: Confirm bulk deletion and verify reload";
test(confirmTitle, details(confirmTitle), async ({ page, app }) => {
  await signIn(page, app.users[0]!);
  await createCompleted(page, "First completed task");
  await createCompleted(page, "Second completed task");
  await createTask(page.request, "Keep this pending task");
  await page.reload();
  const first = taskTitle(page, "First completed task");
  const second = taskTitle(page, "Second completed task");
  const pending = taskTitle(page, "Keep this pending task");
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await expect(pending).toBeVisible();
  const deletes = observeBulkDeletes(page);

  await clearButton(page).click();
  const dialog = confirmation(page);
  await dialog
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Completed tasks permanently deleted.", { exact: true }),
  ).toBeVisible();
  await expect(first).toHaveCount(0);
  await expect(second).toHaveCount(0);
  await expect(pending).toBeVisible();
  await expect(clearButton(page)).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Your task list", exact: true }),
  ).toBeFocused();
  expect(deletes).toHaveLength(1);

  await page.reload();
  await expect(pending).toBeVisible();
  await expect(first).toHaveCount(0);
  await expect(second).toHaveCount(0);
  await expect(clearButton(page)).toBeHidden();
});

const cancelTitle = "KAN-39-TC-003: Cancel or dismiss bulk confirmation";
test(cancelTitle, details(cancelTitle), async ({ page, app }) => {
  test.slow();
  await signIn(page, app.users[0]!);
  await createCompleted(page, "Keep this completed task");
  await createTask(page.request, "Keep this pending task");
  await page.reload();
  const completed = taskTitle(page, "Keep this completed task");
  const pending = taskTitle(page, "Keep this pending task");
  const clear = clearButton(page);
  const dialog = confirmation(page);
  const deletes = observeBulkDeletes(page);
  for (const dismissal of ["Cancel", "Escape"]) {
    await test.step(dismissal, async () => {
      await expect(completed).toBeVisible();
      await expect(pending).toBeVisible();
      await clear.click();
      await expect(dialog).toBeVisible();
      if (dismissal === "Cancel")
        await dialog
          .getByRole("button", { name: "Cancel deletion", exact: true })
          .click();
      else await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(clear).toBeFocused();
      expect(deletes).toHaveLength(0);
      await page.reload();
      await expect(completed).toBeVisible();
      await expect(pending).toBeVisible();
      expect(deletes).toHaveLength(0);
    });
  }
});

const unavailableTitle =
  "KAN-39-TC-004: Hide bulk deletion without owned completed tasks";
test(
  unavailableTitle,
  details(unavailableTitle),
  async ({ page, app, playwright }) => {
    const other = await playwright.request.newContext({ baseURL: app.url });
    try {
      await apiLogin(other, app.users[1]!);
      const task = await createTask(other, "Other owner's completed task");
      const response = await other.patch(`/api/tasks/${task.id}/status`, {
        headers: { "X-CSRF-Token": await token(other) },
        data: { status: "Completed" },
      });
      expect(response.status()).toBe(200);
      await signIn(page, app.users[0]!);
      await expect(clearButton(page)).toBeHidden();

      await createTask(page.request, "Only pending task");
      await page.reload();
      await expect(taskTitle(page, "Only pending task")).toBeVisible();
      await expect(clearButton(page)).toBeHidden();
    } finally {
      await other.dispose();
    }
  },
);

const ownerTitle =
  "KAN-39-TC-005: Clear only the signed-in user's completed tasks";
test(ownerTitle, details(ownerTitle), async ({ page, app, browser }) => {
  const other = await browser.newPage({ baseURL: app.url });
  try {
    await apiLogin(other.request, app.users[1]!);
    await createCompleted(other, "C3");
    await createTask(other.request, "P2");
    await signIn(page, app.users[0]!);
    await createCompleted(page, "C1");
    await createCompleted(page, "C2");
    await createTask(page.request, "P1");
    await page.goto("/tasks");

    await expect(taskTitle(page, "C1")).toBeVisible();
    await expect(taskTitle(page, "C2")).toBeVisible();
    await expect(taskTitle(page, "P1")).toBeVisible();
    const clear = clearButton(page);
    await expect(clear).toBeEnabled();
    await clear.click();
    const dialog = confirmation(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleDescription(
      /all your completed tasks will be permanently deleted/i,
    );
    await dialog
      .getByRole("button", { name: "Delete permanently", exact: true })
      .click();
    await expect(taskTitle(page, "C1")).toHaveCount(0);
    await expect(taskTitle(page, "C2")).toHaveCount(0);
    await expect(taskTitle(page, "P1")).toBeVisible();
    await expect(clear).toBeHidden();

    await page.reload();
    await expect(taskTitle(page, "P1")).toBeVisible();
    await expect(taskTitle(page, "C1")).toHaveCount(0);
    await expect(taskTitle(page, "C2")).toHaveCount(0);

    await other.goto("/tasks");
    await expect(other.getByRole("article", { name: "C3" })).toContainText(
      "Medium priority · Completed",
    );
    await expect(other.getByRole("article", { name: "P2" })).toContainText(
      "Medium priority · Pending",
    );
  } finally {
    await other.close();
  }
});

const failureTitle =
  "KAN-39-TC-010: Keep tasks visible after a bulk deletion failure";
test(failureTitle, details(failureTitle), async ({ page, app }) => {
  await signIn(page, app.users[0]!);
  await createCompleted(page, "Keep after failure");
  await createTask(page.request, "Pending after failure");
  await page.reload();
  const completed = taskTitle(page, "Keep after failure");
  const pending = taskTitle(page, "Pending after failure");
  await expect(completed).toBeVisible();
  await expect(pending).toBeVisible();
  const pattern = "**/api/tasks/completed";
  await page.route(pattern, async (route) => {
    expect(route.request().method()).toBe("DELETE");
    await route.fulfill({
      status: 500,
      json: { error: { message: "Unable to delete completed tasks." } },
    });
  });

  await clearButton(page).click();
  await confirmation(page)
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(page.locator("#task-status")).toHaveText(
    "Unable to delete completed tasks.",
  );
  await expect(completed).toBeVisible();
  await expect(pending).toBeVisible();
  await expect(clearButton(page)).toBeEnabled();

  await page.unroute(pattern);
  await page.reload();
  await expect(completed).toBeVisible();
  await expect(pending).toBeVisible();
});
