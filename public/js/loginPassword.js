export function initLoginPasswordToggle(form) {
  const password = form?.querySelector("#login-password");
  const toggle = form?.querySelector("[data-password-toggle]");
  if (!password || !toggle) return;

  toggle.addEventListener("click", () => {
    const reveal = password.type === "password";
    password.type = reveal ? "text" : "password";
    toggle.textContent = reveal ? "Hide password" : "Show password";
  });
  toggle.hidden = false;
}
