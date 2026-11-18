import "dotenv/config";
import { createApp } from "./app.js";
const production = process.env.NODE_ENV === "production";
if (production)
  throw new Error(
    "Production requires a durable session store. Configure one before deployment; the demo uses MemoryStore.",
  );
const app = createApp({
  secret: process.env.SESSION_SECRET ?? "",
  userFile: process.env.USER_FILE ?? "data/users.json",
  taskFile: process.env.TASK_FILE,
  production,
  trustProxy: process.env.TRUST_PROXY === "1",
});
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () =>
  console.info(`Agentic Demo running at http://localhost:${port}`),
);
