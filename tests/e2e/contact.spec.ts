import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { forStory } from "./story-cases.js";

const details = forStory("KAN-56");
const confirmation = "Your message was sent.";
const values = {
  name: " Visitor ",
  email: "visitor@example.test",
  message: " Hello ",
};

async function openContact(page: Page) {
  await page.goto("/contact");
  await page
    .getByRole("button", { name: "Reject Optional", exact: true })
    .click();
}

async function fillContact(page: Page, input = values) {
  await page.getByLabel("Name", { exact: true }).fill(input.name);
  await page.getByLabel("Email", { exact: true }).fill(input.email);
  await page.getByLabel("Message", { exact: true }).fill(input.message);
}
async function expectValues(page: Page, input = values) {
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    input.name,
  );
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
    input.email,
  );
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    input.message,
  );
}

const navigationTitle =
  "KAN-56-TC-001: Find Contact Us and navigate the form by keyboard";
test(navigationTitle, details(navigationTitle), async ({ page }) => {
  await page.goto("/");
  const consent = page.getByRole("button", {
    name: "Reject Optional",
    exact: true,
  });
  if (await consent.isVisible()) await consent.click();
  const footer = page.getByRole("navigation", { name: "Footer navigation" });
  await footer
    .getByRole("link", { name: "Terms of Service", exact: true })
    .focus();
  await page.keyboard.press("Tab");
  await expect(
    footer.getByRole("link", { name: "Contact Us", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/contact$/);
  await expect(page.getByRole("heading", { name: "Contact Us" })).toBeVisible();
  await page.getByRole("link", { name: "Register ↗", exact: true }).focus();
  for (const name of ["Name", "Email", "Message"]) {
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("textbox", { name, exact: true }),
    ).toBeFocused();
  }
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Submit", exact: true }),
  ).toBeFocused();
});

const validationTitle =
  "KAN-56-TC-003: Server validation identifies the field and retains values";
test(validationTitle, details(validationTitle), async ({ page }) => {
  await openContact(page);
  const invalid = { ...values, message: "   " };
  await fillContact(page, invalid);
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(message).toHaveAttribute("aria-invalid", "true");
  await expect(message).toHaveAccessibleDescription("Enter a message.");
  await expect(message).toBeFocused();
  await expect(page.locator("#contact-error")).toHaveText(
    "Check the form fields.",
  );
  await expectValues(page, invalid);
});

const persistenceTitle =
  "KAN-56-TC-004: Confirmation waits for one private normalized record";
test(persistenceTitle, details(persistenceTitle), async ({ page, app }) => {
  let release!: () => void;
  let started = false;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.contact.beforeSave = async () => {
    started = true;
    await hold;
  };
  try {
    await openContact(page);
    await fillContact(page);
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect.poll(() => started).toBe(true);
    await expect(page.locator("#contact-status")).toBeEmpty();
  } finally {
    release();
  }
  await expect(page.locator("#contact-status")).toHaveText(confirmation);
  const files = await readdir(app.contact.directory);
  expect(files).toHaveLength(1);
  const record = JSON.parse(
    await readFile(join(app.contact.directory, files[0]!), "utf8"),
  );
  expect(record).toMatchObject({
    name: "Visitor",
    email: "visitor@example.test",
    message: "Hello",
  });
  expect((await page.request.get("/api/contact")).status()).toBe(404);
});

const retryTitle =
  "KAN-56-TC-005: Failed storage preserves values for a manual retry";
test(retryTitle, details(retryTitle), async ({ page, app }) => {
  let attempts = 0;
  app.contact.beforeSave = async () => {
    attempts++;
    if (attempts === 1) throw new Error("Fixture storage failure");
  };
  await openContact(page);
  await fillContact(page);
  const submit = page.getByRole("button", { name: "Submit", exact: true });
  await submit.click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Something went wrong." }),
  ).toBeVisible();
  await expect(page.locator("#contact-status")).toBeEmpty();
  await expectValues(page);
  expect(attempts).toBe(1);
  await expect(readdir(app.contact.directory)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await submit.click();
  await expect(page.locator("#contact-status")).toHaveText(confirmation);
  expect(attempts).toBe(2);
  expect(await readdir(app.contact.directory)).toHaveLength(1);
});
