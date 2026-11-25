# Agentic Demo Website

Agentic Demo Website is a standalone web application for demonstrating account management, personal tasks, and a Story-driven development and QA workflow. Ten reusable Codex skills show how requirements are traced through implementation, automated tests, review, and approved delivery.

## Website features

| Feature                     | What to demonstrate                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Home and Welcome Page       | Open the standalone welcome page and select **Go to Home** to return to the landing page.                                      |
| Registration and login      | Register with separate terms acceptance and privacy acknowledgment. Show or hide the password on the login page.               |
| Profile                     | Sign in, open the protected profile, and edit your name, phone number, and address.                                            |
| Task management             | Create and edit personal tasks, search by title, complete or reopen tasks, delete individual tasks, and clear completed tasks. |
| Contact Us                  | Submit a validated message that is stored locally outside the public directory.                                                |
| Privacy and cookie settings | Review the legal pages and accept, reject, customize, or withdraw optional consent from the shared footer.                     |

## Stack and architecture

The server uses Node.js, Express, and strict TypeScript. The browser uses HTML5, CSS3, and vanilla JavaScript. Express serves static assets and authenticated pages and exposes a JSON API. Zod validates requests, Helmet applies browser security headers, and bcrypt hashes passwords. Local JSON files store application data. Express MemoryStore holds demo sessions.

```text
Browser
  └─ Public pages, authenticated views, and JSON API
       └─ Express + TypeScript
            ├─ Request validation, security middleware, and sessions
            └─ Private local account, task, and contact data

Repository QA workflow
  └─ Ten Codex skills, local evidence, and automated checks
       ├─ Jira and Xray through supported MCP and local routes
       ├─ Playwright Chromium
       └─ GitHub pull requests and GitHub Actions
```

The website runs locally without a frontend framework, template engine, database, email service, external trackers, or GitHub activity. Jira, Xray, and GitHub integrations serve the development and QA workflow outside the website request path.

## Local setup

Use Node.js 22 or newer and npm. Run from the repository root. Copy the environment template only when setting up a new `.env`.

```powershell
npm ci
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Set `SESSION_SECRET` in `.env` to a cryptographically random value of at least 32 characters. Keep `.env` private.

```powershell
npm run dev
```

Open `http://localhost:3000`. For compiled execution, run `npm run build` and then `npm start` from the repository root so public assets and data paths resolve correctly.

The public demo account is `demo@example.com` / `DemoAccount!2026`. Use it only for demonstrations. `npm run seed` creates it if absent and preserves existing users. Newly registered accounts are immediately active and receive no verification email.

## Repository layout

```text
.agents/skills/          Ten reusable Codex role skills
.github/workflows/      GitHub Actions CI
docs/agent-framework/  Workflow guide, approval policy, templates, and phase references
qa/                    Pipeline mapping, active Story pointer, and per-Story records
tools/agentic/         QA coordinator and command helpers
tools/xray/            Xray helpers and adapters
artifacts/qa/          Local QA runs and registered evidence, when present
src/
  app.ts               Express middleware, validation, authentication, and routes
  index.ts             Configuration and server bootstrap
  seed.ts              Idempotent demo seed
  data/                Account, task, and contact persistence
  types/user.ts        User model and safe public projection
public/                Public HTML pages, shared CSS, and browser JavaScript
views/                 Authenticated profile and task HTML
data/                  Local data, including users.json
tests/                 Application, DOM, Playwright, and framework tests
.env.example           Local environment template
eslint.config.js       Lint configuration
tsconfig.json          Application TypeScript configuration
package.json           Commands and dependencies
package-lock.json      Locked dependencies
```

## Testing and quality

| Command                   | Purpose                                            |
| ------------------------- | -------------------------------------------------- |
| `npm run lint`            | Run ESLint.                                        |
| `npm run format:check`    | Check formatting. `npm run format` rewrites files. |
| `npm run typecheck`       | Check application TypeScript.                      |
| `npm run typecheck:tests` | Check test TypeScript.                             |
| `npm run typecheck:tools` | Check framework and tool TypeScript.               |
| `npm test`                | Run application tests.                             |
| `npm run test:framework`  | Run the offline framework suite.                   |
| `npm run build`           | Compile the application.                           |
| `npm run test:e2e`        | Run the Playwright browser suite.                  |

Playwright uses repository-local Chromium, isolated temporary users and tasks, and test-scoped loopback servers. If Chromium provisioning is needed, set `PLAYWRIGHT_BROWSERS_PATH` to the repository's `.playwright-browsers` directory and install the matching Chromium runtime before running the suite. Tests use isolated data and do not load `.env`, seed, or modify real demo data.

Application tests cover authentication, legal acceptance, validation, password hashing, CSRF, session rotation, logout, protected routes, profile edits, concurrent duplicate prevention, persistence across app instances, public pages, and consent-record validation. DOM tests cover accepting, rejecting, customizing, persisting, and withdrawing consent. JSDOM emulates native dialog open and close methods and does not render layouts. Check responsive layouts, native focus behavior, and assistive technology manually in target browsers as well as running the Chromium suite.

The development-only lint dependency tree overrides `minimatch` to a patched 11.x release for its glob-processing denial-of-service advisory. Lint checks the override's compatibility.

## Ten-agent QA demonstration

The roles are Jira Story, Requirements Analysis, Test Design, Test Review, Implementation, Playwright Automation, Test Execution and Reporting, Xray Test Publisher, GitHub Integration, and QA Orchestrator.

1. Open the repository in Codex. Ask `$qa-orchestrator` to inspect an existing unpaused Story. Use `qa status <STORY-KEY>` to see its state and `qa next <STORY-KEY>` to resolve one step.
2. Show how acceptance criteria become requirements, stable test cases, and a reviewed coverage plan.
3. After applicable approvals, show the implementation and developer tests, then the reviewed browser cases and their Playwright specs.
4. Review traceability, run approved checks, and inspect reports and coverage gaps.
5. Preview eligible Xray Test definitions, a Test Plan, or a mapped Playwright results import. Each route has its own prerequisites and approvals.
6. Preview scoped GitHub delivery. Review PR checks, the manual merge, and post-merge evidence before proposing Jira closeout.

The default is one agent or stage per request. The orchestrator provides the exact next command or confirmation and waits. An explicit end-to-end request can continue authorized safe stages for one Story and run. Protected operations retain separate approvals.

Jira supplies Story and issue evidence. Xray handles eligible Test definitions, links, plans, and result imports. MCP exposes the operations available in the authorized session. GitHub Actions validates the application and framework and runs Chromium. Its eligible push-to-`main` path can import mapped results into Xray under the repository policy.

Offline framework tests use synthetic reports and identity bindings in temporary directories. Keep registered live evidence and operation journals on the original machine. A fresh checkout can run offline tests. Live operations that require missing registered evidence stop at that dependency.

## API reference

API responses are JSON. Errors use `{ "error": { "code": "...", "message": "...", "fields": {} } }`. Validation errors include `fields`. Invalid input returns `400`, unauthorized access `401`, invalid CSRF `403`, duplicate email `409`, and throttling `429`.

| Method | Endpoint             | Behavior                                                 |
| ------ | -------------------- | -------------------------------------------------------- |
| GET    | `/api/csrf`          | Establish the necessary session and obtain a CSRF token. |
| POST   | `/api/auth/register` | Create an active account without signing it in.          |
| POST   | `/api/auth/login`    | Authenticate and regenerate the session.                 |
| POST   | `/api/auth/logout`   | Destroy the session and clear the cookie.                |
| GET    | `/api/auth/me`       | Return the authenticated user's public fields or `401`.  |
| GET    | `/api/users/me`      | Return the authenticated user's public fields or `401`.  |
| PUT    | `/api/users/me`      | Edit `fullName`, `phone`, and `address` only.            |
| POST   | `/api/contact`       | Validate and store a contact message.                    |

All writes require `X-CSRF-Token` from `/api/csrf` and the same session cookie. Obtain a fresh token after login rotates the session. Registration requires string fields `fullName`, `email`, `password`, `confirmPassword`, `phone`, and `address`. The last two may be empty. It also requires `termsAccepted: true` and `privacyAcknowledged: true`. The API has no bulk-user or admin endpoint and never returns password hashes.

### Task management

Signed-in active users can manage their own tasks at `/tasks` from the Tasks navigation. New tasks start Pending with Medium priority. Low and High are also supported. The list sorts newest-created first and uses ascending ID to break ties. Completed tasks can be edited without reopening. Deletion requires confirmation and is permanent. The current UI supports title search.

| Method | Endpoint                | Behavior                                                  |
| ------ | ----------------------- | --------------------------------------------------------- |
| GET    | `/api/tasks`            | List the active user's tasks.                             |
| POST   | `/api/tasks`            | Create a task.                                            |
| PATCH  | `/api/tasks/:id`        | Partially edit title, description, priority, or due date. |
| PATCH  | `/api/tasks/:id/status` | Complete or reopen a task using the required status.      |
| DELETE | `/api/tasks/completed`  | Clear completed tasks belonging to the active user.       |
| DELETE | `/api/tasks/:id`        | Permanently delete one task.                              |

Titles are trimmed and must contain 1–200 UTF-16 code units. Optional plain-text descriptions preserve whitespace and line breaks and allow up to 2,000 UTF-16 code units. Optional due dates use real Gregorian `YYYY-MM-DD` dates and may be in the past. Omitting an optional edit field preserves it. An empty description or date clears it. Requests reject `null` and unknown or server-managed fields. An absent stored due date is `null`.

Only the dedicated status endpoint changes a task between Pending and Completed. A no-op retains `updatedAt`. A genuine change advances it even within one clock tick or after clock rollback. Task routes require an active user, set no-store, and apply the shared CSRF and JSON error rules. Missing and other-owner task IDs return the same generic `404`. There is no single-task GET or POST completion endpoint. The original KAN-25 evidence and limitations are recorded under `artifacts/qa/KAN-25/`.

## Data, authentication, and security

`data/users.json` stores an array with the fields `id`, `fullName`, `email`, `passwordHash`, `phone`, `address`, `createdAt`, `updatedAt`, `isActive`, `termsAcceptedAt`, `privacyAcknowledgedAt`, and `legalVersion`. IDs are UUIDs and timestamps are ISO strings. Emails are normalized to lowercase and unique. Passwords require at least 12 characters and allow at most 72 UTF-8 bytes. The server hashes passwords with bcrypt cost 12 and never persists or logs plaintext passwords.

User read-modify-write operations share an in-process promise queue. Writes use a unique temporary file and atomic rename. This protects against lost updates and concurrent duplicate email registration within one Node process. Run only one app instance against a given user file. The store provides neither a multi-process lock nor a power-failure durability guarantee. Back up account data securely. Windows ACLs govern access on Windows and POSIX file modes are best effort. Malformed data fails closed.

Task data defaults to `tasks.json` beside the configured user file and can be overridden with `TASK_FILE`. A missing file is treated as empty. Invalid data fails closed. Writes use a unique sibling temporary file and atomic replacement. Queues share a canonical path within a Node process. Same-field conflicts use the last successfully serialized write, while partial updates retain unrelated fields. This provides neither multi-process coordination nor a power-failure durability guarantee. Default Windows path matching assumes case-insensitive directories. The `caseSensitivePaths: true` option supports explicitly case-sensitive directories. Hard-link aliases and symlink changes during operation are unsupported. Contact messages default to `contact-messages` beside the configured user file.

Helmet applies a restrictive Content Security Policy and browser security headers. The site loads no external assets. The server uses Zod validation, a 16 KB body limit, constant-time session-bound CSRF comparison, generic login failures, bcrypt, and authentication throttling of 50 requests per 15 minutes per IP. The session cookie is HttpOnly and SameSite=Lax. Eight-hour server-side sessions use Express MemoryStore, so a restart logs users out. APIs and protected profile responses use no-store. Set `TRUST_PROXY=1` only behind one trusted HTTPS reverse proxy.

The bootstrap refuses `NODE_ENV=production` until a durable session store is implemented. The app factory configures Secure cookies in production. MemoryStore, JSON user storage, demo credentials, and incomplete controller details require review before real deployment. Password reset, email verification, MFA, account deletion UI, and an audit trail are absent. The repository creates no hosted deployment.

## Cookie consent and GDPR scope

A first visit opens an accessible native dialog with **Accept All**, **Reject Optional**, and **Customize**. Users can choose Functional, Analytics, and Marketing preferences independently. Necessary storage stays enabled. `agentic.consent` stores a timestamp and policy version in localStorage for 180 days. Expired or obsolete records prompt again. **Cookie Settings** in every shared footer lets users change or withdraw preferences. If browser storage is blocked, choices apply to the current page only. Consent is exposed through the record and the `consentchange` browser event.

`agentic.sid` is the necessary eight-hour authentication and CSRF cookie. The consent record uses necessary localStorage. The site uses no optional cookies, third-party requests, pixels, analytics, or marketing integrations regardless of preferences. Any future integration must gate loading and storage on its category and remove its storage after withdrawal.

The demo includes affirmative granular choices, equal access to rejection, necessary-cookie classification, versioned preferences, withdrawal controls, a cookie inventory, and a privacy disclosure. Terms acceptance and privacy acknowledgment are separate. Acknowledging the privacy notice supplies no blanket consent basis for account processing.

These mechanisms demonstrate GDPR-oriented behavior and carry no compliance certification. The operator remains responsible for controller identity and contact details, jurisdiction-specific review, retention enforcement, data-subject requests, deletion and export, incident response, processor agreements, lawful-basis assessment, and international-transfer review. The demo supplies no DPO, data-processing agreement, or regulatory workflow. Legal pages disclose the incomplete controller details and direct users to the installation operator. Supply actual controller details before public use.

## Further reading

- [Agent framework guide](docs/agent-framework/README.md)
- [Human approval policy](docs/agent-framework/approval-policy.md)
- [MCP integrations](docs/agent-framework/mcp-integrations.md)
- [Reusable framework and historical Phase 5D contracts](docs/agent-framework/phase5d-framework.md)
- [Framework validation reference](docs/agent-framework/validation.md)
