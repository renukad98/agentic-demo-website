import { randomUUID } from "node:crypto";
import { auditSchema } from "./contracts/index.js";
import { writeExclusive } from "./artifacts.js";

export async function recordAudit(
  root: string,
  event: Omit<
    ReturnType<typeof auditSchema.parse>,
    "schemaVersion" | "id" | "at"
  >,
) {
  const data = auditSchema.parse({
    ...event,
    schemaVersion: "1.0.0",
    id: randomUUID(),
    at: new Date().toISOString(),
  });
  await writeExclusive(root, `audit/${data.id}.json`, data);
  return data;
}
