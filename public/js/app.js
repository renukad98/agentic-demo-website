import { initConsent } from "./cookieConsent.js";
let csrf;
async function api(path, options = {}) {
  if (options.method && options.method !== "GET") {
    if (!csrf) {
      const response = await fetch("/api/csrf");
      if (!response.ok)
        throw new Error("Unable to establish a secure session.");
      csrf = (await response.json()).token;
    }
    options.headers = {
      ...options.headers,
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json",
    };
  }
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 403) csrf = undefined;
    const fields = data.error?.fields;
    throw new Error(
      fields
        ? Object.entries(fields)
            .map(([key, value]) => `${key}: ${value.join(", ")}`)
            .join(" ")
        : data.error?.message || "Request failed.",
    );
  }
  return data;
}
const header = document.querySelector("#site-header");
header.innerHTML =
  '<a class="brand" href="/" aria-label="Agentic home"><span class="brand-mark">a.</span> agentic<span class="demo-tag">DEMO</span></a><nav aria-label="Main navigation"><a href="/">Home</a><span id="auth-nav" aria-live="polite">Loading…</span></nav>';
document.querySelector("#site-footer").innerHTML =
  `<div><a class="brand" href="/">agentic<span class="demo-tag">DEMO</span></a><p>A simple space. Built around you.</p></div><nav aria-label="Footer navigation"><a href="/">Home</a><a href="/privacy">Privacy Notice</a><a href="/cookies">Cookie Policy</a><a href="/terms">Terms of Service</a><a href="/contact">Contact Us</a><button class="text-button" data-cookie-settings>Cookie Settings</button></nav><p class="copyright">© ${new Date().getFullYear()} Agentic Demo. For demonstration purposes.</p>`;
initConsent();
let user;
try {
  const response = await fetch("/api/auth/me");
  if (response.ok) user = (await response.json()).user;
  else if (response.status !== 401) throw new Error("Session unavailable");
  document.querySelector("#auth-nav").innerHTML = user
    ? '<a href="/tasks">Tasks</a><a href="/profile">User Information</a><button id="logout" class="text-button">Logout</button>'
    : '<a href="/login">Login</a><a class="nav-register" href="/register">Register ↗</a>';
} catch {
  document.querySelector("#auth-nav").textContent =
    "Session unavailable. Refresh to retry.";
}
document.querySelector("#logout")?.addEventListener("click", async (event) => {
  event.target.disabled = true;
  try {
    await api("/api/auth/logout", { method: "POST" });
    location.assign("/");
  } catch (error) {
    event.target.disabled = false;
    event.target.textContent = error.message;
  }
});
if (user && document.querySelector("#home-actions"))
  document.querySelector("#home-actions").innerHTML =
    '<a class="button" href="/profile">View your information ↗</a>';
const profile = document.querySelector("#profile-form");
if (profile && user)
  for (const field of ["fullName", "email", "phone", "address"])
    profile.elements.namedItem(field).value = user[field];
if (profile && !user) location.assign("/login");
for (const kind of ["login", "register", "profile"]) {
  const form = document.querySelector(`#${kind}-form`);
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    const status = form.querySelector("#status");
    button.disabled = true;
    status.textContent = "Please wait…";
    const data = Object.fromEntries(new FormData(form));
    if (kind === "register") {
      data.termsAccepted = form.elements.namedItem("termsAccepted").checked;
      data.privacyAcknowledged = form.elements.namedItem(
        "privacyAcknowledged",
      ).checked;
    }
    if (kind === "profile") delete data.email;
    try {
      const result = await api(
        kind === "profile" ? "/api/users/me" : `/api/auth/${kind}`,
        {
          method: kind === "profile" ? "PUT" : "POST",
          body: JSON.stringify(data),
        },
      );
      if (kind === "login") {
        csrf = undefined;
        location.assign("/profile");
      } else {
        status.textContent =
          kind === "register"
            ? result.message
            : "Your information has been saved.";
        if (kind === "register") {
          form.reset();
          const link = document.createElement("a");
          link.href = "/login";
          link.textContent = " Log in now →";
          status.append(link);
        }
      }
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}
