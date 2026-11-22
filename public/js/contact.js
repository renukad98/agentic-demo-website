const form = document.querySelector("#contact-form");
const submit = form.querySelector('button[type="submit"]');
const error = document.querySelector("#contact-error");
const status = document.querySelector("#contact-status");
const names = ["name", "email", "message"];

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  const data = Object.fromEntries(new FormData(form));
  for (const name of names) {
    form.elements.namedItem(name).removeAttribute("aria-invalid");
    document.querySelector("#contact-" + name + "-error").textContent = "";
  }
  error.textContent = "";
  status.textContent = "";
  submit.disabled = true;
  try {
    const csrf = await fetch("/api/csrf", { cache: "no-store" });
    if (!csrf.ok) throw new Error("Unable to start a secure submission.");
    const { token } = await csrf.json();
    const result = await fetch("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify(data),
    });
    const body = await result.json();
    if (!result.ok) {
      for (const name of names) {
        const messages = body.error?.fields?.[name];
        if (!messages?.length) continue;
        form.elements.namedItem(name).setAttribute("aria-invalid", "true");
        document.querySelector("#contact-" + name + "-error").textContent =
          messages.join(" ");
      }
      error.textContent = body.error?.message ?? "Unable to send your message.";
      form.querySelector('[aria-invalid="true"]')?.focus();
      return;
    }
    form.reset();
    status.textContent = body.message;
  } catch {
    error.textContent = "Unable to send your message. Please try again.";
  } finally {
    submit.disabled = false;
  }
});
