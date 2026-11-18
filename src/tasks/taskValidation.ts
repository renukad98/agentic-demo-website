import { z } from "zod";

export function isGregorianDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

export const taskIdSchema = z.string().uuid();
const title = z
  .string()
  .trim()
  .min(1)
  .refine((s) => s.length <= 200, "Use at most 200 UTF-16 code units.");
const description = z
  .string()
  .refine((s) => s.length <= 2000, "Use at most 2000 UTF-16 code units.");
const priority = z.enum(["Low", "Medium", "High"]);
const status = z.enum(["Pending", "Completed"]);
const dueDateInput = z
  .string()
  .refine((s) => s === "" || isGregorianDate(s), {
    message: "Use a real date in YYYY-MM-DD format.",
  })
  .transform((s) => (s === "" ? null : s));

export const createTaskSchema = z
  .object({
    title,
    description: description.default(""),
    priority: priority.default("Medium"),
    dueDate: dueDateInput.optional().transform((s) => s ?? null),
  })
  .strict();

export const updateTaskSchema = z
  .object({
    title: title.optional(),
    description: description.optional(),
    priority: priority.optional(),
    dueDate: dueDateInput.optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((value) => value !== undefined), {
    message: "Provide at least one editable field.",
  });
export const taskStatusSchema = z.object({ status }).strict();

// Store inputs are already normalized: null is valid storage clearing, unlike a raw request.
const normalizedDetails = z
  .object({
    title,
    description,
    priority,
    dueDate: z.string().refine(isGregorianDate).nullable(),
  })
  .strict();
export const normalizedTaskCreateSchema = normalizedDetails;
export const normalizedTaskUpdateSchema = normalizedDetails
  .partial()
  .refine(
    (v) => Object.values(v).some((s) => s !== undefined),
    "Provide at least one editable field.",
  );

const timestamp = z.string().refine((s) => {
  const n = Date.parse(s);
  return Number.isFinite(n) && new Date(n).toISOString() === s;
}, "Invalid stored timestamp.");

export const storedTaskSchema = z
  .object({
    id: taskIdSchema,
    ownerId: taskIdSchema,
    title: z
      .string()
      .min(1)
      .refine((s) => s.length <= 200)
      .refine((s) => s.trim() === s),
    description,
    priority,
    status,
    dueDate: z.string().refine(isGregorianDate).nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict()
  .refine((v) => Date.parse(v.updatedAt) >= Date.parse(v.createdAt), {
    message: "Updated timestamp precedes creation.",
  });

export const storedTasksSchema = z
  .array(storedTaskSchema)
  .refine(
    (tasks) => new Set(tasks.map((task) => task.id)).size === tasks.length,
    "Duplicate stored task IDs.",
  );
export type TaskCreate = z.output<typeof createTaskSchema>;
export type TaskUpdate = z.output<typeof updateTaskSchema>;
