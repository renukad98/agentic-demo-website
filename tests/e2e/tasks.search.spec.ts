import { test, expect, signIn, createTask, apiLogin } from "./fixtures.js";

test("KAN-29: search filters owned titles as you type and restores the list on clear", async ({
  page,
  app,
  playwright,
}) => {
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
  const response = await page.request.get("/api/tasks");
  expect(response.ok()).toBeTruthy();
  const { tasks } = await response.json();
  const orderedIds = tasks.map((task: { id: string }) => task.id);
  expect([...orderedIds].sort()).toEqual(
    [plan.id, print.id, invoice.id].sort(),
  );

  await page.reload();
  const search = page.getByRole("searchbox", { name: "Search tasks by title" });
  const cards = page.locator("[data-task-id]");
  const privateCard = page.locator(`[data-task-id="${privateTask.id}"]`);
  const visibleIds = () =>
    cards.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-task-id")),
    );
  await expect.poll(visibleIds).toEqual(orderedIds);
  await expect(privateCard).toHaveCount(0);

  await page.getByRole("button", { name: "Refresh tasks" }).focus();
  await page.keyboard.press("Tab");
  await expect(search).toBeFocused();
  await page.keyboard.type("P");
  await expect
    .poll(visibleIds)
    .toEqual(orderedIds.filter((id: string) => id !== invoice.id));
  await page.keyboard.type("L");
  await expect.poll(visibleIds).toEqual([plan.id]);
  await expect(privateCard).toHaveCount(0);
  await expect(search).toBeFocused();

  await search.fill("zzz");
  await expect(cards).toHaveCount(0);
  const noMatches = page.getByText("No matching tasks found", { exact: true });
  await expect(noMatches).toBeVisible();
  await search.press("ControlOrMeta+A");
  await search.press("Backspace");
  await expect.poll(visibleIds).toEqual(orderedIds);
  await expect(noMatches).toBeHidden();
  await expect(privateCard).toHaveCount(0);
  await expect(search).toBeFocused();
});

test("KAN-29: search persists across task changes and in-page refresh and resets on reload", async ({
  page,
  app,
}) => {
  await signIn(page, app.users[0]!);
  const search = page.getByRole("searchbox", { name: "Search tasks by title" });
  const empty = page.getByText("No tasks yet.", { exact: false });
  await search.fill("plan");
  await expect(
    page.getByText("No matching tasks found", { exact: true }),
  ).toBeVisible();
  await search.clear();
  await expect(empty).toBeVisible();

  await createTask(page.request, "Weekly planning");
  await createTask(page.request, "Invoice");
  const refresh = page.getByRole("button", { name: "Refresh tasks" });
  await refresh.click();
  const cards = page.getByRole("article");
  await expect(cards).toHaveCount(2);
  await search.fill("  PLAN  ");
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText("Weekly planning");
  await cards.getByRole("button", { name: "Complete", exact: true }).click();
  await expect(cards).toContainText("Completed");
  await expect(search).toHaveValue("  PLAN  ");

  await createTask(page.request, "Planning follow-up");
  await refresh.click();
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: "Planning follow-up" })).toBeVisible();
  await expect(cards.filter({ hasText: "Invoice" })).toHaveCount(0);
  await expect(search).toHaveValue("  PLAN  ");

  await page.reload();
  await expect(search).toHaveValue("");
  await expect(cards).toHaveCount(3);
  await expect(cards.filter({ hasText: "Invoice" })).toBeVisible();
});
