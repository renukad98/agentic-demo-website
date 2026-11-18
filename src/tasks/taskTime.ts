export function taskTimestamp(now: number, previous?: string): string {
  const previousMillis =
    previous === undefined ? undefined : Date.parse(previous);
  if (
    !Number.isFinite(now) ||
    (previousMillis !== undefined && !Number.isFinite(previousMillis))
  ) {
    throw new Error("Invalid task clock.");
  }
  const value =
    previousMillis === undefined
      ? Math.trunc(now)
      : Math.max(Math.trunc(now), previousMillis + 1);
  const result = new Date(value);
  if (!Number.isFinite(result.getTime()))
    throw new Error("Task timestamp overflow.");
  return result.toISOString();
}
