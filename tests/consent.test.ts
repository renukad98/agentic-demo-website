import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
// @ts-expect-error The frontend deliberately uses vanilla JavaScript.
import { initConsent, CONSENT_KEY } from "../public/js/cookieConsent.js";

test("cookie banner accepts, persists, customizes and withdraws optional consent", () => {
  const dom = new JSDOM(
    '<button data-cookie-settings>Cookie Settings</button><div id="cookie-root"></div>',
    { url: "http://localhost" },
  );
  const { window } = dom;
  // JSDOM has no native dialog layout; emulate only its open/close methods.
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    localStorage: window.localStorage,
    CustomEvent: window.CustomEvent,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  try {
    const click = (selector: string) => {
      const node = window.document.querySelector<HTMLButtonElement>(selector);
      assert(node);
      node.click();
    };
    const record = () => JSON.parse(window.localStorage.getItem(CONSENT_KEY)!);
    const dialog = () => window.document.querySelector("dialog")!;
    initConsent();
    assert.equal(dialog().open, true);
    assert.equal(window.localStorage.length, 0);
    assert.equal(window.document.cookie, "");
    click('[data-choice="reject"]');
    assert.equal(dialog().open, false);
    assert.equal(record().necessary, true);
    assert.equal(record().analytics, false);
    assert.equal(record().functional, false);
    assert.equal(record().marketing, false);
    initConsent();
    assert.equal(dialog().open, false); // Simulated reload respects saved decision.
    click("[data-cookie-settings]");
    assert.equal(dialog().open, true);
    click('[data-choice="all"]');
    assert.equal(record().analytics, true);
    assert.equal(record().marketing, true);
    click("[data-cookie-settings]");
    const analytics =
      window.document.querySelector<HTMLInputElement>('[name="analytics"]')!;
    analytics.checked = false;
    click('[data-choice="save"]');
    assert.equal(record().analytics, false);
    assert.equal(record().functional, true);
    click("[data-cookie-settings]");
    click('[data-choice="reject"]');
    assert.equal(record().functional, false);
    assert.equal(record().marketing, false);
    assert.equal(window.document.cookie, "");
    assert.equal(record().version, "1.0");
    assert(Number.isFinite(Date.parse(record().timestamp)));
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.close();
  }
});
