import { test } from "node:test";
import assert from "node:assert/strict";
import { taskTimestamp } from "../src/tasks/taskTime.js";

test("TM-TC-26 TM-TC-27: genuine changes advance within a clock tick or clock rollback", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const previous = taskTimestamp(now);
  assert.equal(previous, "2026-01-01T00:00:00.000Z");
  assert.equal(taskTimestamp(now, previous), "2026-01-01T00:00:00.001Z");
  assert.equal(
    taskTimestamp(now - 10_000, previous),
    "2026-01-01T00:00:00.001Z",
  );
  assert.equal(
    taskTimestamp(now + 10_000, previous),
    "2026-01-01T00:00:10.000Z",
  );
});
test("TM-TC-26: invalid clocks and timestamp overflow fail closed", () => {
  for (const now of [NaN, Infinity, -Infinity, 8.64e15 + 1])
    assert.throws(() => taskTimestamp(now));
  assert.throws(() => taskTimestamp(1, "not-a-date"));
  assert.throws(() => taskTimestamp(8.64e15, new Date(8.64e15).toISOString()));
});
