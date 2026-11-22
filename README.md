# Agentic Demo Website

## Agentic development and QA framework

Phase 2B adds Codex repository instructions and eleven specialized reusable skills. See the [agent framework guide](docs/agent-framework/README.md) for role invocation, workflow gates, artifact templates, approval policy, traceability, MCP limitations and validation. KAN-25 Task Management is implemented locally during Phase 4B; its evidence and remaining limits are recorded under `artifacts/qa/KAN-25/`.

Offline framework tests generate synthetic reports and identity bindings in temporary directories. Live Xray creation and result publication use the registered evidence under the local `artifacts/` directory. Keep that evidence and its operation journal on the original machine. A fresh checkout can run the offline tests. Live commands that require the registered evidence stop when it is missing.

A standalone Node.js / Express / strict TypeScript application, serving HTML5, CSS3 and vanilla JavaScript. No frontend framework, template engine, database, email service, or external trackers. No commits or pushes are required to run it.

## Run locally

Requires Node.js 22 or newer and npm. From this repository:

```powershell
npm ci
Copy-Item .env.example .env
# Replace SESSION_SECRET in .env with a cryptographically random secret (32+ characters).
# Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
npm run dev
```

Visit http://localhost:3000. For compiled execution: `npm run build`, then `npm start`. Run from the repository root so public assets and the data path resolve correctly.

The seeded account is `demo@example.com` / `DemoAccount!2026`. This is a public demo credential, never a production account. `npm run seed` creates it if absent without overwriting existing users. New accounts are immediately active; no verification email is sent.

## Quality commands

```text
npm run lint
npm run format:check
npm run typecheck
npm run typecheck:tests
npm test
npm run build
npm run test:e2e
```

`npm run format` formats source. Tests use isolated temporary data and do not alter the demo users file. Integration tests cover authentication, legal acceptance, validation, password hashing, CSRF, session rotation, logout, protected pages/API, profile updates, concurrent duplicate prevention, persistence across application instances, public pages, and consent-record validation.

## Structure

```text
src/
  app.ts                 Express middleware, validation, authentication and routes
  index.ts               Environment configuration and server bootstrap
  seed.ts                Idempotent demo seed
  data/userStore.ts      Typed, queued atomic JSON persistence
  types/user.ts          User model and safe public projection
public/
  index.html             Landing page
  login.html
  register.html
  cookies.html
  privacy.html
  terms.html
  css/styles.css
  js/app.js              Shared header/footer, authentication and form behavior
  js/cookieConsent.js    Consent dialog and versioned preference persistence
data/users.json
views/profile.html       Served only through authenticated /profile
tests/app.test.ts
.env.example
eslint.config.js
tsconfig.json
package.json
package-lock.json
```

## API

Responses are JSON. Errors use `{ "error": { "code": "...", "message": "...", "fields": {} } }`; `fields` is present for validation errors. Invalid input returns 400, unauthorized access 401, invalid CSRF 403, duplicate email 409, throttling 429.

| Method | Endpoint           | Behavior                                   |
| ------ | ------------------ | ------------------------------------------ |
| GET    | /api/csrf          | Establish necessary session; obtain token  |
| POST   | /api/auth/register | Create activated account (does not log in) |
| POST   | /api/auth/login    | Authenticate and regenerate session        |
| POST   | /api/auth/logout   | Destroy session and clear cookie           |
| GET    | /api/auth/me       | Authenticated public user or 401           |
| GET    | /api/users/me      | Authenticated public user or 401           |
| PUT    | /api/users/me      | Edit fullName, phone, address only         |

All writes require `X-CSRF-Token` obtained from `/api/csrf` with the same session cookie. Obtain a fresh token after login, which rotates the session. No bulk-user or admin endpoint exists. Password hashes are never returned. Registration requires fullName, email, password, confirmPassword, phone and address strings (the last two can be empty), plus `termsAccepted: true` and `privacyAcknowledged: true`.

## Task Management (KAN-25)

Signed-in active users can open `/tasks` from Tasks navigation to create, view, edit, complete, reopen, and permanently delete their own tasks. Deletion requires confirmation and has no undo. Completed tasks can be edited without reopening them. New tasks start Pending with Medium priority; Low/High are also supported. The list is newest-created first with an ascending ID tie-break. Search, filters and pagination are outside this iteration.

Titles are trimmed and require 1–200 UTF-16 code units. Optional plain-text descriptions preserve whitespace and line breaks, up to 2,000 UTF-16 code units. Optional real Gregorian `YYYY-MM-DD` dates allow past dates. Omit an optional field on edit to preserve it; an empty description/date clears it. Request `null` values are rejected; an absent stored due date is `null`. Only the dedicated status endpoint changes Pending/Completed. No-op edits/status requests retain `updatedAt`; genuine changes advance it even within one clock tick or after clock rollback.

| Method | Task endpoint         | Behavior                                        |
| ------ | --------------------- | ----------------------------------------------- |
| GET    | /api/tasks            | Owner-filtered list                             |
| POST   | /api/tasks            | Create task                                     |
| PATCH  | /api/tasks/:id        | Partial title/description/priority/dueDate edit |
| PATCH  | /api/tasks/:id/status | Complete or reopen using a required status      |
| DELETE | /api/tasks/:id        | Permanent deletion                              |

Task endpoints retain session-bound CSRF on writes, active-user checks, no-store and JSON error conventions. Missing and other-owner task IDs return the same generic 404. Unknown/server-managed fields are rejected. No single-task GET or POST completion endpoint is provided.

Task data uses a separate JSON file, defaulting to `tasks.json` beside the configured user file; `TASK_FILE` can override it. A missing file is empty, invalid/corrupt data fails closed, and writes replace a unique sibling temp file atomically. Queues are shared by canonical path across stores in one Node process. Same-field conflicts use the last successfully serialized write; partial updates retain unrelated fields. This is not multi-process coordination or a power-failure durability guarantee. Default Windows path matching assumes a case-insensitive directory; programmatic `caseSensitivePaths: true` supports explicitly case-sensitive directories. Hard-link aliases and symlink changes during operation are unsupported. Existing user storage is unchanged.

Playwright uses repository-local Chromium in `.playwright-browsers`, isolated temporary users/tasks and test-scoped loopback servers. Install its matching runtime when needed with `PLAYWRIGHT_BROWSERS_PATH` set to that directory, then run `npm run test:e2e`. The tests do not load `.env`, seed or modify real demo data. Run the existing quality commands above; source and test type checking are separate. Browser automation covers Chromium only and is not a complete assistive-technology audit.

## Data and security (existing account storage)

`data/users.json` is an array of `{id, fullName, email, passwordHash, phone, address, createdAt, updatedAt, isActive, termsAcceptedAt, privacyAcknowledgedAt, legalVersion}`. IDs are UUIDs; timestamps are ISO strings; emails are normalized to lowercase and unique; passwords are bcrypt hashes with cost 12. Passwords require 12 characters and at most 72 UTF-8 bytes. No plaintext passwords are persisted or logged.

Read-modify-write operations share an in-process promise queue. Writes use a uniquely named temporary file and atomic rename. This prevents lost updates and concurrent duplicate emails inside one Node process. It is **not** a multi-process lock or power-failure durability guarantee. Never run multiple app instances against this JSON file. Back up user data securely; Windows ACLs govern access on Windows (POSIX mode is best effort). A malformed JSON file fails closed rather than silently resetting data.

Helmet applies a restrictive CSP, browser security headers and no external assets. Server-side Zod validation, a 16 KB body limit, constant-time session-bound CSRF comparison, generic login failures, bcrypt, auth throttling (50 requests / 15 minutes / IP), and HttpOnly SameSite=Lax session cookies are included. Eight-hour server-side sessions use Express MemoryStore for local demonstration; restart logs users out. Application data and responses use no-store on APIs and protected profile pages. Only set TRUST_PROXY=1 behind a single trusted HTTPS reverse proxy.

**Deployment limitation:** bootstrap refuses NODE_ENV=production until a durable production session store is implemented. The app factory configures Secure cookies in production, but MemoryStore is not suitable for production. JSON users, demo credentials and incomplete controller details also require review before real deployment. No password reset, email verification, MFA, account deletion UI or audit trail is implemented.

## Cookie consent and GDPR scope

The first visit opens an accessible native dialog with Accept All, Reject Optional, Customize, and granular Functional / Analytics / Marketing preferences. Necessary storage stays enabled. Preferences are kept in `agentic.consent` localStorage with timestamp and policy version for 180 days; expired or obsolete records prompt again. Cookie Settings in every shared footer allows changes and withdrawal. If storage is blocked, preferences work for the current page but cannot persist. Consent is exposed through the localStorage record and the `consentchange` browser event.

`agentic.sid` is the necessary authentication/CSRF cookie with eight-hour lifetime. Consent is necessary browser localStorage rather than a cookie. No optional cookies, third-party requests, pixels, analytics or marketing integrations exist, regardless of preferences. Any future integration must gate loading and storage on its category and clear its storage on withdrawal.

Covered demo mechanisms: affirmative granular optional choices, equal reject access, necessary-cookie classification, versioned consent, withdrawal settings, cookie inventory, privacy disclosure, separate legal acceptance and acknowledgment. The privacy checkbox acknowledges notice and is not a blanket consent legal basis for account processing.

This is GDPR-oriented behavior, **not a compliance certification**. Real controller identity/contact, jurisdiction-specific legal review, retention enforcement, data-subject request operations, deletion/export, incident response, processor agreements, lawful-basis assessment and international-transfer review remain operator responsibilities. No DPO, data-processing agreement or regulatory workflow is supplied. Legal pages deliberately state incomplete controller details and direct demo users to the installation operator. Supply real details before public use.

## Verification limits

Automated tests exercise HTTP flows, consent validation and DOM interactions for accepting, rejecting, customizing, persisting and withdrawing consent. DOM tests emulate native dialog open/close methods because JSDOM does not render layouts. Responsive layouts, native dialog focus behavior and assistive technology behavior should also be checked manually in target browsers. No hosted deployment is created by this project.

The lint tool's nested minimatch dependency is overridden to a patched 11.x version to address its glob-processing denial-of-service advisory. Lint validation covers the override's compatibility; this package is development-only.

## Reusable agent framework

See [Phase 5D framework](docs/agent-framework/phase5d-framework.md) for Story-driven orchestration, isolated artifacts, automation identities, mock-tested Xray proposals and fail-closed approvals. Run npm run test:framework and npm run typecheck:tools for the local framework. Remote publication is disabled.
