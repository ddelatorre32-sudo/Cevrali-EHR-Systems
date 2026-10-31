import {
  signedAddendaForNote,
  pendingSignedSourceCorrections,
} from "./note-addenda.js";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { clinicDate, synchronizeNoShowStatuses } from "./database.js";
import { matchingPatients } from "./registration.js";
import { patientAddressFields } from "./patient-demographics.js";
import { getPatientAllergyProfile, initializePatientProfile } from "./patient-profile-engine.js";
import { readAppointmentRange } from "./scheduling.js";
import { syncRfaDrafts } from "./rfa-engine.js";
import {
  syncDocumentResults,
  validateNoteResultsForSignature,
  receivedResultsForNote,
} from "./note-results.js";
import {
  visitPlanInput,
  saveVisitPlan,
  releaseVisitPlanForAccountChange,
  guardVisitAccountChange,
} from "./operations-engine.js";
import { financeRequest } from "./finance-engine.js";
import { generateRfaPdf } from "./rfa-pdf.js";
import type { RfaPacket } from "./rfa-engine.js";
import {
  publicUser,
  authenticateOrChallenge,
  registerAccountRoutes,
  type AccountContext,
} from "./accounts.js";
import { initializeAccessSecurity } from "./access-security.js";
import { registerPublicAccessRoutes, registerAccountAccessRoutes } from "./access-routes.js";
import { loadRuntimeConfig } from "./runtime-config.js";
import { readinessReport } from "./readiness.js";
import {
  registerPublicIntake,
  registerWorkflowRoutes,
  loadWorkflow,
  syncAppointmentWorkflow,
  registerPatientInsurance,
  saveWorkflow,
  context as workflowContext,
} from "./workflows.js";
import {
  ensurePatientAccounts,
  patientAccount,
  encounterAccountFields,
  readJson,
} from "./patient-accounts.js";

type User = {
  id: string;
  name: string;
  email: string;
  role: "clinician" | "receptionist";
};
type Row = Record<string, any>;
const text = (max = 500) => z.string().trim().max(max);
const nonempty = (max = 100) => text(max).min(1);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const d = new Date(`${value}T12:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }, "Enter a valid calendar date");
const patientSchema = z.object({
  first_name: nonempty(),
  last_name: nonempty(),
  dob: date.refine(
    (v) => v >= "1900-01-01" && v <= clinicDate(),
    "Birth date must be between 1900 and today",
  ),
  sex: z.enum(["Female", "Male", "Other", "Unknown"]),
  phone: nonempty(40),
  email: z.union([z.string().email().max(254), z.literal("")]).default(""),
  ...patientAddressFields.shape,
  allergies: z.array(nonempty()).max(30).default([]),
  conditions: z.array(nonempty()).max(50).default([]),
  duplicate_acknowledged: z.boolean().default(false),
});
const appointmentSchema = z.object({
  service_plan: visitPlanInput.optional(),
  billing_account_id: nonempty().optional(),
  patient_id: nonempty(),
  date,
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  duration: z.number().int().min(15).max(120).default(30),
  type: z.enum(["Consultation", "Follow-up", "Annual physical", "Procedure"]),
  reason: nonempty(500),
});
const encounterFields = z.object({
  chief_complaint: nonempty(500),
  subjective: text(10000),
  objective: text(10000),
  assessment: text(10000),
  plan: text(10000),
  bp: z.union([
    z.literal(""),
    z.string().regex(/^\d{2,3}\/\d{2,3}$/, "Use systolic/diastolic format"),
  ]),
  pulse: z.union([z.literal(""), z.string().regex(/^\d{1,3}$/)]),
  temperature: z.union([z.literal(""), z.string().regex(/^\d{2}(\.\d)?$/)]),
});
const sessionHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const patientRow = (p: Row) => ({
  ...p,
  allergies: JSON.parse(p.allergies),
  conditions: JSON.parse(p.conditions),
  medications: JSON.parse(p.medications),
});
function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
const idParam = (req: Request) => String(req.params.id);

export function createApp(db: DatabaseSync, account?: AccountContext) {
  const runtime = account?.runtime || loadRuntimeConfig();
  if (!runtime.demoEnabled && !account)
    throw new Error('Protected workspaces require a configured practice account context.');
  initializeAccessSecurity(db);
  db.exec('CREATE TABLE IF NOT EXISTS mfa_sessions(token TEXT PRIMARY KEY REFERENCES sessions(token) ON DELETE CASCADE, verified_at TEXT NOT NULL)');
  const app = express();
  const billingState = (user: User) => {
    const state = loadWorkflow(db);
    const ctx = workflowContext(db, user);
    if (account) ctx.practice = account.store.practice(account.practiceId);
    ensurePatientAccounts(state.finance, ctx);
    return { state, ctx };
  };
  const encounterRow = (e: Row) => ({
    ...e,
    received_results: receivedResultsForNote(loadWorkflow(db), e.id),
    signed_addenda: signedAddendaForNote(loadWorkflow(db), e.id),
    source_corrections: pendingSignedSourceCorrections(loadWorkflow(db), e.id),
    billing_account_id: e.billing_account_id || `pba-private-${e.patient_id}`,
    wc_documentation: readJson(e.wc_documentation, null),
    billing_account_snapshot: readJson(e.billing_account_snapshot, null),
  });
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
    });
    next();
  });
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", (req, _res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("origin");
      if (origin && new URL(origin).host !== req.get("host"))
        return next(
          Object.assign(new Error("Cross-origin request rejected"), {
            status: 403,
          }),
        );
      if (!req.is("application/json"))
        return next(
          Object.assign(new Error("Content-Type must be application/json"), {
            status: 415,
          }),
        );
    }
    next();
  });
  app.use(express.json({ limit: "3mb" }));
  const audit = (user: User, action: string, resource: string) =>
    db
      .prepare("INSERT INTO audit (user_id, action, resource) VALUES (?, ?, ?)")
      .run(user.id, action, resource);
  const requireClinical = (_req: Request, res: Response, next: NextFunction) =>
    res.locals.user.role === "clinician"
      ? next()
      : next(
          Object.assign(new Error("Clinical access required"), { status: 403 }),
        );
  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: runtime.secureCookies,
    path: "/",
  };
  app.get("/api/health", (_req, res) => {
    db.prepare("SELECT 1").get();
    res.json({ status: "ok", mode: runtime.demoEnabled ? "synthetic-demo" : "synthetic-staff-pilot" });
  });
  // A shared proxy address must not let one account's mistakes lock out every
  // other account. Keep a larger address-wide limit for repeated account cycling.
  const attempts = new Map<string, { count: number; until: number }>();
  const addressAttempts = new Map<string, { count: number; until: number }>();
  app.post("/api/auth/login", (req, res) => {
    const input = z
      .object({
        email: z
          .string()
          .trim()
          .email()
          .transform((value) => value.toLowerCase()),
        password: z.string().min(1).max(200),
      })
      .parse(req.body);
    const ip = req.ip || "local";
    const key = JSON.stringify([ip, input.email]);
    const attempt = attempts.get(key);
    const addressAttempt = addressAttempts.get(ip);
    const now = Date.now();
    if (
      (attempt && attempt.until > now && attempt.count >= 10) ||
      (addressAttempt && addressAttempt.until > now && addressAttempt.count >= 100)
    )
      fail(429, "Too many sign-in attempts. Try again in 15 minutes.");
    const user = db
      .prepare("SELECT * FROM users WHERE email = ? AND is_active=1")
      .get(input.email) as Row | undefined;
    const [salt, expected] = String(user?.password || "unrecognized:").split(
      ":",
    );
    const actual = scryptSync(input.password, salt, 64);
    if (
      !user ||
      !expected || !/^[a-f0-9]{128}$/.test(expected) ||
      !timingSafeEqual(actual, Buffer.from(expected, "hex"))
    ) {
      attempts.set(key, {
        count: attempt && attempt.until > now ? attempt.count + 1 : 1,
        until: now + 900000,
      });
      addressAttempts.set(ip, {
        count:
          addressAttempt && addressAttempt.until > now
            ? addressAttempt.count + 1
            : 1,
        until: now + 900000,
      });
      fail(401, "Email or password is incorrect");
    }
    attempts.delete(key);
    const signedIn = authenticateOrChallenge(db, user, res, account);
    audit(user as User, 'kind' in signedIn ? "Verified password; awaiting staff MFA" : "Signed in", "workspace");
    res.json(signedIn);
  });
  registerPublicAccessRoutes(app, db, account, runtime, account?.authKey);
  registerPublicIntake(app, db, account ? () => account.store.practice(account.practiceId) : undefined);
  app.use("/api", (req, res, next) => {
    const token = (req.headers.cookie || "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("cevrali_session="))
      ?.slice("cevrali_session=".length);
    if (!token)
      return next(
        Object.assign(new Error("Please sign in to continue"), { status: 401 }),
      );
    const user = db
      .prepare(
        "SELECT u.id, u.name, u.email, u.role,u.is_admin FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token = ? AND s.expires > ? AND u.is_active=1",
      )
      .get(sessionHash(token), Date.now()) as Row | undefined;
    if (!user)
      return next(
        Object.assign(
          new Error("Your session has expired. Please sign in again."),
          { status: 401 },
        ),
      );
    const mfaVerified = Boolean(db.prepare('SELECT 1 FROM mfa_sessions WHERE token=?').get(sessionHash(token)));
    const mfaEnrolled = Boolean(db.prepare('SELECT 1 FROM access_mfa WHERE user_id=?').get(user.id));
    const mfaRequired = runtime.requireMfa || mfaEnrolled;
    if ((runtime.requireMfa && !mfaEnrolled) || (mfaRequired && !mfaVerified))
      return next(Object.assign(new Error('Complete multi-factor authentication to sign in.'), { status: 401 }));
    if (
      (req.get("X-Cevrali-User") !== undefined &&
        req.get("X-Cevrali-User") !== user.id) ||
      (req.get("X-Cevrali-Role") !== undefined &&
        req.get("X-Cevrali-Role") !== user.role) ||
      (req.get("X-Cevrali-Admin") !== undefined &&
        req.get("X-Cevrali-Admin") !== String(Boolean(user.is_admin)))
    )
      return next(
        Object.assign(
          new Error("Your account session changed. Sign in again."),
          { status: 401 },
        ),
      );
    res.locals.user = user;
    res.locals.mfa_verified = mfaVerified;
    res.locals.prescribing_session_id = sessionHash(token);
    if (account)
      res.locals.practice = account.store.practice(account.practiceId);
    next();
  });
  if (account) registerAccountRoutes(app, db, account);
  registerAccountAccessRoutes(app, db, account, runtime, account?.authKey);
  app.get('/api/admin/readiness', (_req, res) => {
    if (!res.locals.user.is_admin) fail(403, 'Practice administrator access required');
    res.json(readinessReport(runtime));
  });
  app.get("/api/rfa/:id/pdf", requireClinical, async (req, res) => {
    const { state, ctx } = billingState(res.locals.user);
    const packet = financeRequest(
      state.finance,
      ctx,
      "GET",
      new URL(`https://finance.invalid/finance/rfa/${idParam(req)}`),
      {},
    ) as RfaPacket;
    const [template, font] = await Promise.all([
      readFile(new URL("./templates/dwc-rfa-2014.pdf", import.meta.url)),
      readFile(new URL("./templates/rfa-font.ttf", import.meta.url)),
    ]);
    const bytes = await generateRfaPdf(packet, template, font);
    audit(
      res.locals.user,
      "Downloaded DWC RFA PDF and supporting narrative",
      packet.id,
    );
    res
      .set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${packet.id}-rfa.pdf"`,
      })
      .send(Buffer.from(bytes));
  });
  registerWorkflowRoutes(
    app,
    db,
    account
      ? (token, expires) =>
          account.store.indexIntake(account.practiceId, token, expires)
      : undefined,
  );
  app.get("/api/auth/me", (_req, res) =>
    res.json(publicUser(res.locals.user, account)),
  );
  app.post("/api/auth/logout", (req, res) => {
    const token = (req.headers.cookie || "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("cevrali_session="))
      ?.slice("cevrali_session=".length);
    if (token)
      db.prepare("DELETE FROM sessions WHERE token = ?").run(
        sessionHash(token),
      );
    if (token && account) account.store.removeSession(token);
    audit(res.locals.user, "Signed out", "workspace");
    res.clearCookie("cevrali_session", cookieOptions).json({ ok: true });
  });
  app.get("/api/overview", (_req, res) => {
    synchronizeNoShowStatuses(db);
    const today = clinicDate();
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    res.json({
      today,
      patients: count("SELECT COUNT(*) n FROM patients"),
      appointments: (
        db
          .prepare(
            "SELECT COUNT(*) n FROM appointments WHERE date = ? AND status != 'Cancelled'",
          )
          .get(today) as { n: number }
      ).n,
      completed: (
        db
          .prepare(
            "SELECT COUNT(*) n FROM appointments WHERE date = ? AND status = 'Completed'",
          )
          .get(today) as { n: number }
      ).n,
      waiting: (
        db
          .prepare(
            "SELECT COUNT(*) n FROM appointments WHERE date = ? AND status = 'Checked in'",
          )
          .get(today) as { n: number }
      ).n,
      drafts:
        res.locals.user.role === "clinician"
          ? count("SELECT COUNT(*) n FROM encounters WHERE status = 'Draft'")
          : null,
    });
  });
  app.get("/api/patients", (req, res) => {
    const q = z
      .string()
      .max(200)
      .parse(req.query.q || "");
    const rows = db
      .prepare(
        "SELECT * FROM patients WHERE first_name || ' ' || last_name LIKE ? OR id LIKE ? ORDER BY last_name, first_name",
      )
      .all(`%${q}%`, `%${q}%`) as Row[];
    audit(res.locals.user, "Viewed patient directory", "patients");
    res.json(
      rows.map((p) => {
        const {
          allergies: _a,
          conditions: _c,
          medications: _m,
          ...demographics
        } = p;
        return demographics;
      }),
    );
  });
  app.get("/api/patients/matches", (req, res) => {
    const input = z
      .object({ first_name: nonempty(), last_name: nonempty(), dob: date })
      .parse(req.query);
    const rows = db
      .prepare(
        "SELECT id,first_name,last_name,dob,phone FROM patients WHERE dob=?",
      )
      .all(input.dob) as Row[];
    audit(res.locals.user, "Reviewed possible duplicate patients", "patients");
    res.json(matchingPatients(rows, input));
  });
  app.post("/api/patients", (req, res) => {
    const p = patientSchema.parse(req.body);
    if (
      res.locals.user.role !== "clinician" &&
      (p.allergies.length || p.conditions.length)
    )
      fail(403, "Clinical access required for allergies or conditions");
    const id = `pat-${randomUUID().slice(0, 8)}`;
    db.exec("BEGIN IMMEDIATE");
    try {
      const matches = matchingPatients(
        db
          .prepare(
            "SELECT id,first_name,last_name,dob,phone FROM patients WHERE dob=?",
          )
          .all(p.dob) as Row[],
        p,
      );
      if (matches.length && !p.duplicate_acknowledged)
        fail(
          409,
          "A patient with the same name and birth date already exists. Review the existing record or confirm a separate patient.",
        );
      db.prepare(
        "INSERT INTO patients (id, first_name, last_name, dob, sex, phone, email, address, address_unit, city, state, zip_code, allergies, conditions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        p.first_name,
        p.last_name,
        p.dob,
        p.sex,
        p.phone,
        p.email,
        p.address,
        p.address_unit,
        p.city,
        p.state,
        p.zip_code,
        JSON.stringify(p.allergies),
        JSON.stringify(p.conditions),
      );
      registerPatientInsurance(
        db,
        res.locals.user,
        id,
        req.body.insurance,
        req.body.workers_comp,
      );
      const profileState = loadWorkflow(db);
      initializePatientProfile(
        profileState,
        workflowContext(db, res.locals.user),
        { ...p, id },
      );
      saveWorkflow(db, profileState);
      audit(res.locals.user, "Registered patient", id);
      if (matches.length)
        audit(
          res.locals.user,
          "Confirmed separate patient after duplicate review",
          id,
        );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    res.status(201).json({ id });
  });
  app.get("/api/patients/:id", requireClinical, (req, res) => {
    const p = db
      .prepare("SELECT * FROM patients WHERE id = ?")
      .get(idParam(req)) as Row | undefined;
    if (!p) fail(404, "Patient not found");
    const encounters = db
      .prepare(
        "SELECT e.*, u.name author FROM encounters e JOIN users u ON e.author_id = u.id WHERE patient_id = ? ORDER BY e.created_at DESC",
      )
      .all(p.id);
    const labs = db
      .prepare("SELECT * FROM labs WHERE patient_id = ? ORDER BY date DESC")
      .all(p.id);
    audit(res.locals.user, "Opened patient chart", p.id);
    res.json({
      ...patientRow(p),
      allergy_profile: getPatientAllergyProfile(loadWorkflow(db), patientRow(p)),
      encounters: encounters.map((e) => encounterRow(e as Row)),
      labs: [
        ...loadWorkflow(db).results.filter((r) => r.patient_id === p.id),
        ...labs,
      ],
    });
  });
  app.use("/api/appointments", (_req, _res, next) => {
    synchronizeNoShowStatuses(db);
    next();
  });
  app.get("/api/appointments", (req, res) => {
    const range = readAppointmentRange(req.query, clinicDate());
    const finance = loadWorkflow(db).finance;
    const accounts = finance.billing_accounts;
    res.json(
      db
        .prepare(
          "SELECT a.*, p.first_name, p.last_name, p.dob, p.sex, u.name provider FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN users u ON u.id = a.provider_id WHERE a.date BETWEEN ? AND ? ORDER BY a.date,a.time,a.id",
        )
        .all(range.start, range.end)
        .map((a) => {
          const row = a as Row;
          const id = row.billing_account_id || `pba-private-${row.patient_id}`;
          const account = accounts.find((a) => a.id === id);
          return {
            ...row,
            billing_account_id: id,
            billing_account_claim_number:
              account?.workers_comp?.claim_number || "",
            billing_account_payer:
              account?.workers_comp?.carrier ||
              finance.policies.find(
                (p) =>
                  p.billing_account_id === id &&
                  p.priority === "Primary" &&
                  p.effective_date <= row.date &&
                  (!p.end_date || p.end_date >= row.date),
              )?.payer ||
              "",
            billing_account_name:
              accounts.find((a) => a.id === id)?.name ||
              "Private insurance / personal care",
          };
        }),
    );
  });
  app.post("/api/appointments", (req, res) => {
    const a = appointmentSchema.parse(req.body);
    const requested = z
      .object({ provider_id: z.string().optional() })
      .parse(req.body).provider_id;
    const provider = requested
      ? (db
          .prepare(
            "SELECT id FROM users WHERE id=? AND role='clinician' AND is_active=1",
          )
          .get(requested) as Row | undefined)
      : (db
          .prepare(
            "SELECT id FROM users WHERE role='clinician' AND is_active=1 ORDER BY CASE WHEN id=? THEN 0 WHEN id='usr-clinician' THEN 1 ELSE 2 END,name LIMIT 1",
          )
          .get(res.locals.user.id) as Row | undefined);
    if (!provider)
      fail(
        400,
        "Select an active clinician. Practice administrators can invite clinical staff from Account setup.",
      );
    if (!db.prepare("SELECT id FROM patients WHERE id = ?").get(a.patient_id))
      fail(404, "Patient not found");
    const start = Number(a.time.slice(0, 2)) * 60 + Number(a.time.slice(3));
    if (start + a.duration > 1440)
      fail(400, "Appointment must end on the same day");
    const id = `apt-${randomUUID().slice(0, 8)}`;
    const { state, ctx } = billingState(res.locals.user);
    const billingAccount = patientAccount(
      state.finance,
      a.patient_id,
      a.billing_account_id,
      true,
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db
        .prepare(
          "SELECT time, duration FROM appointments WHERE date = ? AND (provider_id = ? OR patient_id = ?) AND status NOT IN ('Cancelled','No-show')",
        )
        .all(a.date, provider.id, a.patient_id) as Row[];
      if (
        existing.some((v) => {
          const s = Number(v.time.slice(0, 2)) * 60 + Number(v.time.slice(3));
          return start < s + v.duration && start + a.duration > s;
        })
      )
        fail(
          409,
          "This time overlaps another appointment. Choose an available time.",
        );
      if (a.service_plan)
        saveVisitPlan(
          state,
          ctx,
          {
            ...a,
            id,
            status: "Scheduled",
            billing_account_id: billingAccount.id,
          },
          a.service_plan,
        );
      db.prepare(
        "INSERT INTO appointments (id, patient_id, date, time, duration, type, reason, provider_id,billing_account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?,?)",
      ).run(
        id,
        a.patient_id,
        a.date,
        a.time,
        a.duration,
        a.type,
        a.reason,
        provider.id,
        billingAccount.id,
      );
      saveWorkflow(db, state);
      audit(res.locals.user, "Scheduled appointment", id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    res.status(201).json({ id });
  });
  app.patch("/api/appointments/:id/billing-account", (req, res) => {
    const input = z
      .object({
        billing_account_id: nonempty(),
        previous_billing_account_id: z.string(),
      })
      .parse(req.body);
    const a = db
      .prepare("SELECT * FROM appointments WHERE id=?")
      .get(idParam(req)) as Row | undefined;
    if (!a) fail(404, "Appointment not found");
    if (
      !["Scheduled", "Checked in"].includes(a.status) ||
      db.prepare("SELECT id FROM encounters WHERE appointment_id=?").get(a.id)
    )
      fail(
        409,
        "The visit has already started. Its billing account must be reviewed in the draft encounter.",
      );
    if (
      input.previous_billing_account_id !==
      (a.billing_account_id || `pba-private-${a.patient_id}`)
    )
      fail(409, "Visit billing account changed; reload before saving");
    db.exec("BEGIN IMMEDIATE");
    try {
      const { state } = billingState(res.locals.user);
      const selected = patientAccount(
        state.finance,
        a.patient_id,
        input.billing_account_id,
        true,
      );
      releaseVisitPlanForAccountChange(
        state,
        workflowContext(db, res.locals.user),
        a.id,
        selected.id,
      );
      db.prepare("UPDATE appointments SET billing_account_id=? WHERE id=?").run(
        selected.id,
        a.id,
      );
      saveWorkflow(db, state);
      audit(
        res.locals.user,
        `Changed scheduled visit billing account to ${selected.name}`,
        a.id,
      );
      db.exec("COMMIT");
      res.json({ ok: true });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  app.patch("/api/appointments/:id", (req, res) => {
    const { status } = z
      .object({
        status: z.enum([
          "Scheduled",
          "Checked in",
          "In progress",
          "Completed",
          "Cancelled",
        ]),
      })
      .parse(req.body);
    const a = db
      .prepare("SELECT * FROM appointments WHERE id = ?")
      .get(idParam(req)) as Row | undefined;
    if (!a) fail(404, "Appointment not found");
    const transitions: Record<string, string[]> = {
      Scheduled: ["Checked in", "Cancelled"],
      "Checked in": ["In progress", "Cancelled"],
      "In progress": ["Completed"],
      Completed: [],
      Cancelled: [],
      "No-show": [],
    };
    if (!(transitions[a.status] || []).includes(status))
      fail(
        409,
        `Cannot change ${a.status.toLowerCase()} appointment to ${status.toLowerCase()}`,
      );
    if (
      ["In progress", "Completed"].includes(status) &&
      res.locals.user.role !== "clinician"
    )
      fail(403, "Clinical access required");
    db.exec("BEGIN IMMEDIATE");
    try {
      syncAppointmentWorkflow(db, a, status);
      db.prepare("UPDATE appointments SET status = ? WHERE id = ?").run(
        status,
        a.id,
      );
      audit(res.locals.user, `Appointment: ${status}`, a.id);
      db.exec("COMMIT");
      res.json({ ok: true });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  app.get("/api/encounters", requireClinical, (_req, res) => {
    audit(res.locals.user, "Viewed encounter records", "encounters");
    res.json(
      db
        .prepare(
          "SELECT e.*, p.first_name, p.last_name, u.name author FROM encounters e JOIN patients p ON p.id = e.patient_id JOIN users u ON u.id = e.author_id ORDER BY e.created_at DESC",
        )
        .all()
        .map((e) => encounterRow(e as Row)),
    );
  });
  app.post("/api/encounters", requireClinical, (req, res) => {
    synchronizeNoShowStatuses(db);
    const input = z
      .object({
        patient_id: nonempty(),
        appointment_id: nonempty().optional(),
        chief_complaint: nonempty(500),
        billing_account_id: nonempty().optional(),
      })
      .parse(req.body);
    if (
      !db.prepare("SELECT id FROM patients WHERE id = ?").get(input.patient_id)
    )
      fail(404, "Patient not found");
    let scheduledAccount: string | undefined;
    if (input.appointment_id) {
      const appointment = db
        .prepare("SELECT * FROM appointments WHERE id = ?")
        .get(input.appointment_id) as Row | undefined;
      if (!appointment || appointment.patient_id !== input.patient_id)
        fail(400, "Appointment does not belong to this patient");
      if (["Cancelled", "No-show"].includes(appointment.status))
        fail(409, "Cannot start a cancelled or no-show appointment");
      scheduledAccount =
        appointment.billing_account_id || `pba-private-${input.patient_id}`;
      if (
        input.billing_account_id &&
        input.billing_account_id !== scheduledAccount
      )
        fail(409, "Encounter must use the scheduled visit’s billing account");
      const existing = db
        .prepare("SELECT id FROM encounters WHERE appointment_id = ?")
        .get(input.appointment_id);
      if (existing) return res.json(existing);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const id = `enc-${randomUUID().slice(0, 8)}`;
      const { state, ctx } = billingState(res.locals.user);
      const selected = patientAccount(
        state.finance,
        input.patient_id,
        scheduledAccount || input.billing_account_id,
        true,
      );
      const fields = encounterAccountFields(
        state.finance,
        ctx,
        { id, patient_id: input.patient_id, billing_account_id: selected.id },
        { billing_account_id: selected.id, status: "Draft" },
      );
      db.prepare(
        "INSERT INTO encounters (id, patient_id, appointment_id, author_id, chief_complaint,billing_account_id,billing_account_snapshot,wc_documentation) VALUES (?, ?, ?, ?, ?,?,?,?)",
      ).run(
        id,
        input.patient_id,
        input.appointment_id || null,
        res.locals.user.id,
        input.chief_complaint,
        fields.billing_account_id,
        JSON.stringify(fields.billing_account_snapshot),
        JSON.stringify(fields.wc_documentation),
      );
      ctx.encounters = db.prepare("SELECT * FROM encounters").all();
      syncDocumentResults(state, ctx);
      saveWorkflow(db, state);
      audit(res.locals.user, "Created encounter", id);
      db.exec("COMMIT");
      res.status(201).json({ id });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  app.patch("/api/encounters/:id", requireClinical, (req, res) => {
    const input = encounterFields
      .extend({ status: z.enum(["Draft", "Signed"]), updated_at: nonempty() })
      .parse(req.body);
    const e = db
      .prepare("SELECT * FROM encounters WHERE id = ?")
      .get(idParam(req)) as Row | undefined;
    if (!e) fail(404, "Encounter not found");
    if (e.status === "Signed")
      fail(409, "Signed notes are locked and cannot be edited");
    if (e.author_id !== res.locals.user.id)
      fail(403, "Only the author can edit this encounter");
    if (e.updated_at !== input.updated_at)
      fail(
        409,
        "This note was updated elsewhere. Close and reopen it before editing.",
      );
    const { state, ctx } = billingState(res.locals.user);
    const billingFields = encounterAccountFields(state.finance, ctx, e, {
      ...req.body,
      ...input,
    });
    if (e.appointment_id)
      guardVisitAccountChange(
        state,
        ctx,
        e.appointment_id,
        billingFields.billing_account_id,
      );
    if (input.status === "Signed")
      validateNoteResultsForSignature(
        state,
        ctx,
        e,
        req.body,
        billingFields.billing_account_id,
      );
    if (input.status === "Signed" && (!input.assessment || !input.plan))
      fail(400, "Assessment and plan are required to sign a note");
    if (
      input.status === "Signed" &&
      [input.subjective, input.objective, input.assessment, input.plan].some(
        (value) => value.includes("[["),
      )
    )
      fail(400, "Resolve all template placeholders before signing");
    const updatedAt = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "UPDATE encounters SET chief_complaint=?, subjective=?, objective=?, assessment=?, plan=?, bp=?, pulse=?, temperature=?, status=?, signed_at=?, updated_at=?,billing_account_id=?,billing_account_snapshot=?,wc_documentation=? WHERE id=?",
      ).run(
        input.chief_complaint,
        input.subjective,
        input.objective,
        input.assessment,
        input.plan,
        input.bp,
        input.pulse,
        input.temperature,
        input.status,
        input.status === "Signed" ? updatedAt : null,
        updatedAt,
        billingFields.billing_account_id,
        JSON.stringify(billingFields.billing_account_snapshot),
        JSON.stringify(billingFields.wc_documentation),
        e.id,
      );
      if (
        (e.billing_account_id || `pba-private-${e.patient_id}`) !==
        billingFields.billing_account_id
      )
        audit(res.locals.user, "Changed draft visit billing account", e.id);
      if (e.appointment_id) {
        releaseVisitPlanForAccountChange(
          state,
          ctx,
          e.appointment_id,
          billingFields.billing_account_id,
        );
        db.prepare(
          "UPDATE appointments SET billing_account_id=? WHERE id=?",
        ).run(billingFields.billing_account_id, e.appointment_id);
      }
      if (input.status === "Signed") {
        ctx.encounters = (
          db.prepare("SELECT * FROM encounters").all() as Row[]
        ).map((e) => ({
          ...e,
          received_results: receivedResultsForNote(state, e.id),
          signed_addenda: signedAddendaForNote(state, e.id),
          source_corrections: pendingSignedSourceCorrections(state, e.id),
        }));
        ctx.now = updatedAt;
        syncRfaDrafts(state.finance, ctx);
      }
      saveWorkflow(db, state);
      audit(
        res.locals.user,
        input.status === "Signed"
          ? "Signed encounter"
          : "Saved encounter draft",
        e.id,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    res.json({ ok: true, updated_at: updatedAt });
  });
  app.get("/api/audit", requireClinical, (_req, res) =>
    res.json(
      db
        .prepare(
          "SELECT a.*, u.name actor FROM audit a JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 100",
        )
        .all(),
    ),
  );
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "API route not found" }),
  );
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError)
      return res.status(400).json({
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
    const status = error.status || 500;
    if (status >= 500) console.error("Request failed:", error.message);
    return res.status(status).json({
      error: status >= 500 ? "An unexpected error occurred" : error.message,
    });
  });
  return app;
}
