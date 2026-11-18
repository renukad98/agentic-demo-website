import {
  test,
  expect,
  signIn,
  createTask,
  apiLogin,
  token,
} from "./fixtures.js";
import { randomUUID } from "node:crypto";

test("TM-TC-11/23: unauthenticated routes and static aliases protect task data", async ({
  page,
  request,
}) => {
  await page.goto("/tasks");
  await expect(page).toHaveURL(/\/login$/);
  expect((await request.get("/api/tasks")).status()).toBe(401);
  for (const path of [
    "/tasks.html",
    "/tasks%2ehtml",
    "/data/tasks.json",
    "/data/users.json",
  ])
    expect((await request.get(path)).status()).toBe(404);
  for (const path of [
    "/",
    "/login",
    "/register",
    "/privacy",
    "/terms",
    "/cookies",
  ])
    expect((await request.get(path)).status()).toBe(200);
});

test("TM-TC-02/12/13/27: ownership denial and CSRF remain effective in browser sessions", async ({
  page,
  app,
  browser,
}) => {
  await signIn(page, app.users[0]!);
  const task = await createTask(page.request, "Only owner A sees this");
  const other = await browser.newContext({ baseURL: app.url });
  try {
    const oldToken = await token(other.request);
    await apiLogin(other.request, app.users[1]!);
    expect((await other.request.get("/api/tasks")).status()).toBe(200);
    expect(
      (await (await other.request.get("/api/tasks")).json()).tasks,
    ).toEqual([]);
    const csrf = await token(other.request);
    for (const id of [task.id, randomUUID()]) {
      const headers = { "X-CSRF-Token": csrf };
      const edit = await other.request.patch(`/api/tasks/${id}`, {
        headers,
        data: { title: "Intrusion" },
      });
      const status = await other.request.patch(`/api/tasks/${id}/status`, {
        headers,
        data: { status: "Completed" },
      });
      const deletion = await other.request.delete(`/api/tasks/${id}`, {
        headers,
      });
      expect([edit.status(), status.status(), deletion.status()]).toEqual([
        404, 404, 404,
      ]);
    }
    const old = await other.request.post("/api/tasks", {
      headers: { "X-CSRF-Token": oldToken },
      data: { title: "Stale" },
    });
    expect(old.status()).toBe(403);
    const protectedTask = (await (await page.request.get("/api/tasks")).json())
      .tasks[0];
    expect(protectedTask.title).toBe("Only owner A sees this");
    expect(protectedTask.status).toBe("Pending");
  } finally {
    await other.close();
  }
});

test("TM-TC-21/23: task text is literal, private and absent from persistent browser storage", async ({
  page,
  app,
}) => {
  await signIn(page, app.users[0]!);
  const hostile = '<img src=x onerror="window.taskScriptExecuted=true">';
  await createTask(page.request, hostile, {
    description: "<script>window.taskScriptExecuted=true</script>\nline two",
  });
  await page.reload();
  await expect(page.getByRole("article").getByRole("heading")).toHaveText(
    hostile,
  );
  await expect(page.locator("#task-list img, #task-list script")).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(
      () =>
        (window as Window & { taskScriptExecuted?: boolean })
          .taskScriptExecuted,
    ),
  ).toBeUndefined();
  const stored = await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
  }));
  expect(JSON.stringify(stored)).not.toContain(hostile);
  expect(stored.session).toEqual([]);
  expect((await page.request.get("/tasks")).headers()["cache-control"]).toBe(
    "no-store",
  );
  expect(
    (await page.request.get("/api/tasks")).headers()["cache-control"],
  ).toBe("no-store");
});
