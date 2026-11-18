import bcrypt from "bcrypt";
import { UserStore } from "./data/userStore.js";
import { randomUUID } from "node:crypto";
const hash = await bcrypt.hash("DemoAccount!2026", 12);
await new UserStore("data/users.json").mutate((users) => {
  if (!users.some((u) => u.email === "demo@example.com")) {
    const now = new Date().toISOString();
    users.push({
      id: randomUUID(),
      fullName: "Alex Morgan",
      email: "demo@example.com",
      passwordHash: hash,
      phone: "+1 555 0100",
      address: "Demo City",
      createdAt: now,
      updatedAt: now,
      isActive: true,
      termsAcceptedAt: now,
      privacyAcknowledgedAt: now,
      legalVersion: "1.0",
    });
  }
});
