import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
// @ts-expect-error The frontend deliberately uses vanilla JavaScript.
import { initLoginPasswordToggle } from "../public/js/loginPassword.js";

test("KAN-83-TC-03: Toggle behavior preserves the form contract", (t) => {
  const html = readFileSync(
    new URL("../public/login.html", import.meta.url),
    "utf8",
  );
  const { window } = new JSDOM(html);
  t.after(() => window.close());
  const form = window.document.querySelector<HTMLFormElement>("#login-form");
  const password = form?.querySelector<HTMLInputElement>("#login-password");
  const toggle = form?.querySelector<HTMLButtonElement>(
    "[data-password-toggle]",
  );
  assert.ok(form && password && toggle);
  assert.equal(password.type, "password");
  assert.equal(toggle.hidden, true);
  assert.equal(toggle.type, "button");

  password.value = "synthetic-password";
  const submit = t.mock.fn((event: Event) => event.preventDefault());
  form.addEventListener("submit", submit);
  initLoginPasswordToggle(form);
  assert.equal(toggle.hidden, false);
  assert.equal(toggle.textContent?.trim(), "Show password");

  for (const [type, action] of [
    ["text", "Hide password"],
    ["password", "Show password"],
  ]) {
    toggle.click();
    assert.equal(password.type, type);
    assert.equal(toggle.textContent, action);
    assert.equal(password.name, "password");
    assert.equal(password.value === "synthetic-password", true);
    assert.equal(password.required, true);
    assert.equal(password.autocomplete, "current-password");
    assert.equal(
      new window.FormData(form).get("password") === password.value,
      true,
    );
  }
  assert.equal(submit.mock.callCount(), 0);
});
