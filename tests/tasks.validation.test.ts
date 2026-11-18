import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTaskSchema,
  updateTaskSchema,
  taskStatusSchema,
  taskIdSchema,
  isGregorianDate,
} from "../src/tasks/taskValidation.js";

test("TM-TC-01 TM-TC-08: create defaults and exact priority enums", () => {
  assert.deepEqual(createTaskSchema.parse({ title: "  Task  " }), {
    title: "Task",
    description: "",
    priority: "Medium",
    dueDate: null,
  });
  for (const priority of ["Low", "Medium", "High"])
    assert.equal(
      createTaskSchema.parse({ title: "a", priority }).priority,
      priority,
    );
  for (const priority of ["low", "", "Highest", null, 1])
    assert.equal(
      createTaskSchema.safeParse({ title: "a", priority }).success,
      false,
    );
});
test("TM-TC-06: title boundaries count UTF-16 and trim edges only", () => {
  for (const title of [undefined, null, 1, "", " \t\n", "a".repeat(201)])
    assert.equal(createTaskSchema.safeParse({ title }).success, false);
  for (const title of ["a", "a".repeat(200), "😀".repeat(100)])
    assert.equal(createTaskSchema.parse({ title }).title, title);
  assert.equal(
    createTaskSchema.safeParse({ title: "😀".repeat(101) }).success,
    false,
  );
  assert.equal(createTaskSchema.parse({ title: " a  b " }).title, "a  b");
});
test("TM-TC-07: description keeps plain text whitespace and length boundaries", () => {
  for (const description of [
    "",
    " \n<script>literal</script>\n ",
    "a".repeat(2000),
  ])
    assert.equal(
      createTaskSchema.parse({ title: "a", description }).description,
      description,
    );
  for (const description of [null, {}, 1, "a".repeat(2001), "😀".repeat(1001)])
    assert.equal(
      createTaskSchema.safeParse({ title: "a", description }).success,
      false,
    );
});
test("TM-TC-10: real Gregorian dates including century and early-year boundaries", () => {
  for (const value of [
    "0001-01-01",
    "0099-02-28",
    "2000-02-29",
    "2024-02-29",
    "9999-12-31",
    "1900-01-01",
  ])
    assert.equal(isGregorianDate(value), true, value);
  for (const value of [
    "0000-01-01",
    "1900-02-29",
    "2100-02-29",
    "2023-02-29",
    "2024-04-31",
    "2024-00-01",
    "2024-13-01",
    "2024-01-00",
    "2024-1-01",
    "2024-01-01T00:00:00Z",
    "x",
  ])
    assert.equal(isGregorianDate(value), false, value);
});
test("TM-TC-03 TM-TC-10: due-date omission and clearing preserve partial semantics", () => {
  assert.equal(createTaskSchema.parse({ title: "a" }).dueDate, null);
  assert.equal(
    createTaskSchema.parse({ title: "a", dueDate: "" }).dueDate,
    null,
  );
  assert.deepEqual(updateTaskSchema.parse({ title: "a" }), { title: "a" });
  assert.deepEqual(updateTaskSchema.parse({ dueDate: "" }), { dueDate: null });
  for (const dueDate of [null, 1, "2025-02-29"]) {
    assert.equal(
      createTaskSchema.safeParse({ title: "a", dueDate }).success,
      false,
    );
    assert.equal(updateTaskSchema.safeParse({ dueDate }).success, false);
  }
});
test("TM-TC-09 TM-TC-14 TM-TC-27: strict detail/status contracts reject mass assignment", () => {
  for (const key of [
    "id",
    "ownerId",
    "createdAt",
    "updatedAt",
    "status",
    "unknown",
  ]) {
    assert.equal(
      createTaskSchema.safeParse({ title: "a", [key]: "Completed" }).success,
      false,
    );
    assert.equal(
      updateTaskSchema.safeParse({ title: "a", [key]: "Completed" }).success,
      false,
    );
  }
  assert.equal(updateTaskSchema.safeParse({}).success, false);
  for (const status of ["Pending", "Completed"])
    assert.equal(taskStatusSchema.parse({ status }).status, status);
  for (const value of [
    {},
    { status: null },
    { status: "pending" },
    { status: "Done" },
    { status: "Completed", title: "a" },
  ])
    assert.equal(taskStatusSchema.safeParse(value).success, false);
  assert.equal(taskIdSchema.safeParse("not-an-id").success, false);
});
