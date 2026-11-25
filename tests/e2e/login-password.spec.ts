import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { forStory } from "./story-cases.js";

const details = forStory("KAN-83");

async function openLogin(page: Page) {
  await page.goto("/login");
  await page
    .getByRole("button", { name: "Reject Optional", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Login", exact: true }),
  ).toBeVisible();
  const show = page.getByRole("button", { name: "Show password", exact: true });
  await expect(show).toBeVisible();
  return {
    show,
    hide: page.getByRole("button", { name: "Hide password", exact: true }),
    password: page.getByLabel("Password", { exact: true }),
    email: page.getByLabel("Email address", { exact: true }),
    submit: page.getByRole("button", { name: /Log in/i }),
  };
}

function watchLoginRequests(page: Page) {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/auth/login") {
      requests.push(request.method());
    }
  });
  return requests;
}

const masking = "KAN-83-TC-01: Initial masking and repeat toggling";
test(masking, details(masking), async ({ page, app }) => {
  const { password, show, hide } = await openLogin(page);
  const synthetic = app.users[0]!.password;
  await expect(password).toHaveAttribute("type", "password");
  await password.fill(synthetic);
  for (const [control, type, next] of [
    [show, "text", hide],
    [hide, "password", show],
    [show, "text", hide],
  ] as const) {
    await control.click();
    await expect(password).toHaveAttribute("type", type);
    await expect(next).toBeVisible();
    expect((await password.inputValue()) === synthetic).toBe(true);
  }
});

const keyboard = "KAN-83-TC-02: Keyboard toggle and form isolation";
test(keyboard, details(keyboard), async ({ page, app }) => {
  const { password, email, show, hide } = await openLogin(page);
  const requests = watchLoginRequests(page);
  await email.fill(app.users[0]!.email);
  await password.fill(app.users[0]!.password);
  await page.keyboard.press("Tab");
  await expect(show).toBeFocused();
  await page.keyboard.press("Space");
  await expect(hide).toBeFocused();
  await expect(password).toHaveAttribute("type", "text");
  await page.keyboard.press("Enter");
  await expect(show).toBeFocused();
  await expect(password).toHaveAttribute("type", "password");
  await expect(page).toHaveURL("/login");
  expect(requests).toEqual([]);
});

const required = "KAN-83-TC-04: Required password in either state";
test(required, details(required), async ({ page, app }) => {
  const { email, password, show, submit } = await openLogin(page);
  const requests = watchLoginRequests(page);
  await email.fill(app.users[0]!.email);
  for (const type of ["password", "text"]) {
    if (type === "text") await show.click();
    await expect(password).toHaveAttribute("type", type);
    await submit.click();
    await expect(password).toBeFocused();
    expect(
      await password.evaluate(
        (input: HTMLInputElement) => input.validity.valueMissing,
      ),
    ).toBe(true);
    await expect(page).toHaveURL("/login");
    expect(requests).toEqual([]);
  }
});

const outcomes = "KAN-83-TC-05: Valid and invalid login in either state";
test(outcomes, details(outcomes), async ({ browser, app }) => {
  test.setTimeout(90_000);
  const user = app.users[0]!;
  for (const visible of [false, true]) {
    for (const valid of [false, true]) {
      const context = await browser.newContext({ baseURL: app.url });
      try {
        const page = await context.newPage();
        const { email, password, show, submit } = await openLogin(page);
        await email.fill(user.email);
        await password.fill(valid ? user.password : `${user.password}x`);
        if (visible) await show.click();
        await expect(password).toHaveAttribute(
          "type",
          visible ? "text" : "password",
        );
        await submit.click();
        if (valid) {
          await expect(page).toHaveURL("/profile");
          await expect(
            page.getByRole("link", { name: "Tasks", exact: true }),
          ).toBeVisible();
        } else {
          await expect(page.getByRole("status")).toContainText(
            "Email or password is incorrect.",
          );
          await expect(page).toHaveURL("/login");
          const profile = await context.request.get("/profile", {
            maxRedirects: 0,
          });
          expect(profile.status()).toBe(302);
          expect(profile.headers().location).toBe("/login");
        }
      } finally {
        await context.close();
      }
    }
  }
});
