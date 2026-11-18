export const CONSENT_KEY = "agentic.consent";
export const POLICY_VERSION = "1.0";
export function validConsent(record, now = Date.now()) {
  return Boolean(
    record &&
    record.version === POLICY_VERSION &&
    record.necessary === true &&
    ["functional", "analytics", "marketing"].every(
      (key) => typeof record[key] === "boolean",
    ) &&
    Number.isFinite(Date.parse(record.timestamp)) &&
    now >= Date.parse(record.timestamp) &&
    now - Date.parse(record.timestamp) < 180 * 86400000,
  );
}
export function initConsent() {
  const root = document.querySelector("#cookie-root");
  let record;
  try {
    record = JSON.parse(localStorage.getItem(CONSENT_KEY));
  } catch {
    /* Storage unavailable: ask again next visit. */
  }
  let previousFocus;
  function open(custom = false) {
    previousFocus = document.activeElement;
    root.innerHTML = `<dialog aria-labelledby="consent-title"><p class="eyebrow">YOUR PRIVACY, YOUR CALL</p><h2 id="consent-title">A moment for your preferences.</h2><p>We use necessary storage for secure login. Optional categories are off until you choose. This demo has no optional trackers.</p><div id="preferences" ${custom ? "" : "hidden"}><label class="check"><input type="checkbox" checked disabled> Strictly Necessary (always on)</label>${["Functional", "Analytics", "Marketing"].map((category) => `<label class="check"><input type="checkbox" name="${category.toLowerCase()}" ${record?.[category.toLowerCase()] === true ? "checked" : ""}> ${category}</label>`).join("")}</div><div class="consent-actions"><button data-choice="all">Accept All</button><button class="secondary" data-choice="reject">Reject Optional</button><button class="secondary" data-choice="custom">Customize</button><button data-choice="save" ${custom ? "" : "hidden"}>Save preferences</button></div><p><a href="/cookies">Cookie Policy</a></p><p id="consent-status" role="status"></p></dialog>`;
    const dialog = root.querySelector("dialog");
    dialog.addEventListener("cancel", (event) => event.preventDefault());
    root.querySelectorAll("[data-choice]").forEach((button) =>
      button.addEventListener("click", () => {
        const choice = button.dataset.choice;
        if (choice === "custom") {
          root.querySelector("#preferences").hidden = false;
          root.querySelector('[data-choice="save"]').hidden = false;
          return;
        }
        record = {
          necessary: true,
          functional:
            choice === "all" ||
            (choice === "save" &&
              root.querySelector('[name="functional"]').checked),
          analytics:
            choice === "all" ||
            (choice === "save" &&
              root.querySelector('[name="analytics"]').checked),
          marketing:
            choice === "all" ||
            (choice === "save" &&
              root.querySelector('[name="marketing"]').checked),
          timestamp: new Date().toISOString(),
          version: POLICY_VERSION,
        };
        try {
          localStorage.setItem(CONSENT_KEY, JSON.stringify(record));
        } catch {
          root.querySelector("#consent-status").textContent =
            "Preferences apply for this page, but browser storage is unavailable.";
        }
        window.dispatchEvent(
          new CustomEvent("consentchange", { detail: record }),
        );
        dialog.close();
        previousFocus?.focus();
      }),
    );
    dialog.showModal();
  }
  document
    .querySelectorAll("[data-cookie-settings]")
    .forEach((button) => button.addEventListener("click", () => open(true)));
  if (!validConsent(record)) {
    record = null;
    open();
  }
}
