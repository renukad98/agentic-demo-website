import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import session from "express-session";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import bcrypt from "bcrypt";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { UserStore } from "./data/userStore.js";
import { publicUser } from "./types/user.js";
import { TaskStore, type TaskStoreOptions } from "./data/taskStore.js";
import {
  createTaskSchema,
  updateTaskSchema,
  taskStatusSchema,
  taskIdSchema,
} from "./tasks/taskValidation.js";

declare module "express-session" {
  interface SessionData {
    userId?: string;
    csrf?: string;
  }
}
const details = z.object({
  fullName: z.string().trim().min(2).max(100),
  phone: z
    .string()
    .trim()
    .max(30)
    .regex(/^[+\d\s().-]*$/),
  address: z.string().trim().max(500),
});
const email = z.string().trim().toLowerCase().email().max(254);
const password = z
  .string()
  .min(12)
  .max(72)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= 72,
    "Password must be at most 72 UTF-8 bytes",
  );
const registration = details
  .extend({
    email,
    password,
    confirmPassword: z.string(),
    termsAccepted: z.literal(true),
    privacyAcknowledged: z.literal(true),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: "Passwords must match",
    path: ["confirmPassword"],
  });
export function createApp(options: {
  secret: string;
  userFile: string;
  taskFile?: string;
  taskStoreOptions?: TaskStoreOptions;
  production?: boolean;
  trustProxy?: boolean;
}) {
  if (options.secret.length < 32)
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  const app = express();
  const store = new UserStore(options.userFile);
  // Derive the default from the injected user path so temporary app instances stay isolated.
  const tasks = new TaskStore(
    options.taskFile ?? join(dirname(options.userFile), "tasks.json"),
    options.taskStoreOptions,
  );
  app.disable("x-powered-by");
  if (options.trustProxy) app.set("trust proxy", 1);
  app.use(helmet());
  // Parser errors occur before the normal API middleware; task errors must also be non-cacheable.
  app.use("/api/tasks", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "16kb" }));
  app.use(
    session({
      name: "agentic.sid",
      secret: options.secret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: options.production ?? false,
        maxAge: 1000 * 60 * 60 * 8,
      },
    }),
  );
  const fail = (res: Response, status: number, code: string, message: string) =>
    res.status(status).json({ error: { code, message } });
  app.get("/api/csrf", (req, res) => {
    req.session.csrf ??= randomBytes(32).toString("hex");
    res.set("Cache-Control", "no-store").json({ token: req.session.csrf });
  });
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const token = req.get("X-CSRF-Token");
    const expected = req.session.csrf;
    if (
      !token ||
      !expected ||
      Buffer.byteLength(token) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
    )
      return fail(res, 403, "CSRF_INVALID", "Refresh the page and try again.");
    next();
  });
  app.use(
    "/api/auth",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 50,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: {
        error: {
          code: "RATE_LIMITED",
          message: "Too many attempts. Try again later.",
        },
      },
    }),
  );
  app.post("/api/auth/register", async (req, res) => {
    const body = registration.parse(req.body);
    const passwordHash = await bcrypt.hash(body.password, 12);
    const now = new Date().toISOString();
    const user = await store.mutate((users) => {
      if (users.some((u) => u.email === body.email)) return null;
      // Demo accounts are immediately active; no email or verification flow exists.
      const user = {
        id: randomUUID(),
        fullName: body.fullName,
        email: body.email,
        passwordHash,
        phone: body.phone,
        address: body.address,
        createdAt: now,
        updatedAt: now,
        isActive: true,
        termsAcceptedAt: now,
        privacyAcknowledgedAt: now,
        legalVersion: "1.0",
      };
      users.push(user);
      return user;
    });
    if (!user)
      return fail(
        res,
        409,
        "EMAIL_EXISTS",
        "An account with that email already exists.",
      );
    res.status(201).json({
      user: publicUser(user),
      message: "Account is active — you can log in now",
    });
  });
  app.post("/api/auth/login", async (req, res, next) => {
    const body = z
      .object({ email, password: z.string().min(1).max(200) })
      .parse(req.body);
    const user = (await store.read()).find((u) => u.email === body.email);
    const valid = await bcrypt.compare(
      body.password,
      user?.passwordHash ??
        "$2b$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy",
    );
    if (!user || !valid || !user.isActive)
      return fail(
        res,
        401,
        "INVALID_CREDENTIALS",
        "Email or password is incorrect.",
      );
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.userId = user.id;
      req.session.csrf = randomBytes(32).toString("hex");
      req.session.save((error) => {
        if (error) return next(error);
        res.json({ user: publicUser(user) });
      });
    });
  });
  app.post("/api/auth/logout", (req, res, next) => {
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie("agentic.sid", {
        httpOnly: true,
        sameSite: "lax",
        secure: options.production ?? false,
      });
      res.json({ message: "Logged out" });
    });
  });
  const protectedRoute = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    const user = (await store.read()).find(
      (u) => u.id === req.session.userId && u.isActive,
    );
    if (!user) return fail(res, 401, "UNAUTHENTICATED", "Please log in.");
    res.locals.user = user;
    next();
  };
  app.get(["/api/auth/me", "/api/users/me"], protectedRoute, (_req, res) =>
    res.json({ user: publicUser(res.locals.user) }),
  );
  app.put("/api/users/me", protectedRoute, async (req, res) => {
    const body = details.parse(req.body);
    const user = await store.mutate((users) => {
      const user = users.find((u) => u.id === req.session.userId && u.isActive);
      if (!user) return null;
      Object.assign(user, body, { updatedAt: new Date().toISOString() });
      return user;
    });
    if (!user) return fail(res, 401, "UNAUTHENTICATED", "Please log in.");
    res.json({ user: publicUser(user) });
  });
  app.use("/api/tasks", protectedRoute, (req, _res, next) => {
    z.object({}).strict().parse(req.query);
    next();
  });
  const taskMissing = (res: Response) =>
    fail(res, 404, "NOT_FOUND", "Task not found.");
  app.get("/api/tasks", async (req, res) => {
    res.json({ tasks: await tasks.list(req.session.userId!) });
  });
  app.post("/api/tasks", async (req, res) => {
    const body = createTaskSchema.parse(req.body);
    res
      .status(201)
      .json({ task: await tasks.create(req.session.userId!, body) });
  });
  app.patch("/api/tasks/:id", async (req, res) => {
    const id = taskIdSchema.parse(req.params.id);
    const body = updateTaskSchema.parse(req.body);
    const task = await tasks.update(req.session.userId!, id, body);
    if (!task) return taskMissing(res);
    res.json({ task });
  });
  app.patch("/api/tasks/:id/status", async (req, res) => {
    const id = taskIdSchema.parse(req.params.id);
    const { status } = taskStatusSchema.parse(req.body);
    const task = await tasks.setStatus(req.session.userId!, id, status);
    if (!task) return taskMissing(res);
    res.json({ task });
  });
  app.delete("/api/tasks/:id", async (req, res) => {
    const id = taskIdSchema.parse(req.params.id);
    z.object({})
      .strict()
      .parse(req.body === undefined ? {} : req.body);
    if (!(await tasks.delete(req.session.userId!, id))) return taskMissing(res);
    res.json({ message: "Task permanently deleted." });
  });
  app.use("/api", (_req, res) =>
    fail(res, 404, "NOT_FOUND", "Endpoint not found."),
  );
  app.get("/profile.html", (_req, res) =>
    fail(res, 404, "NOT_FOUND", "Page not found."),
  );
  app.get("/tasks.html", (_req, res) =>
    fail(res, 404, "NOT_FOUND", "Page not found."),
  );
  app.get("/tasks", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const user = (await store.read()).find(
      (u) => u.id === req.session.userId && u.isActive,
    );
    if (!user) return res.redirect("/login");
    res.sendFile(resolve("views/tasks.html"));
  });
  app.get("/profile", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const user = (await store.read()).find(
      (u) => u.id === req.session.userId && u.isActive,
    );
    if (!user) return res.redirect("/login");
    res.sendFile(resolve("views/profile.html"));
  });
  for (const page of ["login", "register", "cookies", "privacy", "terms"])
    app.get(`/${page}`, (_req, res) =>
      res.sendFile(resolve(`public/${page}.html`)),
    );
  app.use(
    express.static(resolve("public"), { extensions: [], index: "index.html" }),
  );
  app.use((_req, res) => fail(res, 404, "NOT_FOUND", "Page not found."));
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof z.ZodError)
        return res.status(400).json({
          error: {
            code: "VALIDATION_ERROR",
            message: "Check the form fields.",
            fields: error.flatten().fieldErrors,
          },
        });
      if (error instanceof SyntaxError)
        return fail(res, 400, "INVALID_JSON", "Invalid JSON body.");
      if ((error as { status?: number }).status === 413)
        return fail(res, 413, "BODY_TOO_LARGE", "Request body is too large.");
      return fail(
        res,
        500,
        "INTERNAL_ERROR",
        "Something went wrong. Please try again.",
      );
    },
  );
  return app;
}
