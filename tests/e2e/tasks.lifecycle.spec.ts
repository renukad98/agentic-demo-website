import { test, expect, signIn, createTask } from "./fixtures.js";

test("TM-TC-01/03/04/05/27: create, edit completed task, complete, reopen and confirm/cancel delete", async ({
  page,
  app,
}) => {
  // Five lifecycle cases share one session, and Playwright's configured slowMo adds up across the browser actions.
  test.slow();
  await signIn(page, app.users[0]!);
  await page.getByLabel("Task title", { exact: true }).fill("  Plan release  ");
  await page
    .getByLabel("Description (optional)")
    .fill(" first line\nsecond line ");
  await page.getByLabel("Priority", { exact: true }).selectOption("High");
  await page.getByLabel("Due date (optional)").fill("2024-02-29");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  const card = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Plan release", exact: true }),
  });
  await expect(card).toBeVisible();
  await expect(card).toContainText("High priority · Pending");
  await expect(card).toContainText("Due: 2024-02-29");
  await card.getByRole("button", { name: "Complete", exact: true }).click();
  await expect(card).toContainText("Completed");
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByLabel("Description (optional)")
    .fill("Changed while completed");
  await page.getByLabel("Due date (optional)").fill("");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(card).toContainText("Changed while completed");
  await expect(card).toContainText("Completed");
  await expect(card).toContainText("No due date");
  await card.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(card).toContainText("Pending");
  await page.reload();
  await expect(card).toContainText("Pending");
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Permanently delete task?" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Cancel deletion", exact: true })
    .click();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(page.getByText("No tasks yet.", { exact: false })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("article")).toHaveCount(0);
});

test("TM-TC-01/02/28: defaults, identical titles and server-ordered list survive reload", async ({
  page,
  app,
}) => {
  await signIn(page, app.users[0]!);
  const first = await createTask(page.request, "Same title");
  const second = await createTask(page.request, "Same title");
  expect(first.id).not.toBe(second.id);
  expect(first.priority).toBe("Medium");
  expect(first.status).toBe("Pending");
  expect(first.dueDate).toBeNull();
  await createTask(page.request, "Newest entry");
  await page.reload();
  await expect(page.getByRole("article")).toHaveCount(3);
  await expect(page.getByRole("article").first()).toContainText("Newest entry");
  await expect(
    page.getByRole("article").filter({ hasText: "Same title" }),
  ).toHaveCount(2);
  await expect(page.getByRole("searchbox")).toHaveCount(0);
});

test("TM-TC-06/07/10/20: field feedback retains input and date-only display", async ({
  page,
  app,
}) => {
  await signIn(page, app.users[0]!);
  await page.getByLabel("Task title", { exact: true }).fill("   ");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(page.getByLabel("Task title", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(
    page.getByText("Enter a task title.", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Task title", { exact: true }).fill("a".repeat(200));
  await page.getByLabel("Description (optional)").fill("d".repeat(2000));
  await page.getByLabel("Due date (optional)").fill("2000-02-29");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(page.getByRole("article")).toContainText("Due: 2000-02-29");
  await expect(page.getByRole("article").getByRole("heading")).toHaveText(
    "a".repeat(200),
  );
});
