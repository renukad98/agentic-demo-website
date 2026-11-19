import { taskCaseDetails } from "./story-cases.js";
import { test, expect, signIn } from "./fixtures.js";

test("TM-TC-05/20: keyboard create, dialog cancellation/focus and narrow layout", taskCaseDetails("TM-TC-05/20:"), async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, app.users[0]!);
  await page.getByLabel("Task title", { exact: true }).focus();
  await page.keyboard.type("Keyboard task");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Description (optional)")).toBeFocused();
  await page.getByRole("button", { name: "Create task", exact: true }).focus();
  await page.keyboard.press("Enter");
  const card = page.getByRole("article");
  await expect(card).toBeVisible();
  const deletion = card.getByRole("button", { name: "Delete", exact: true });
  await deletion.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Cancel deletion", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Permanently delete task?" }),
  ).not.toBeVisible();
  await expect(deletion).toBeFocused();
  await expect(card).toBeVisible();
  await deletion.click();
  await page
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your task list", exact: true }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
