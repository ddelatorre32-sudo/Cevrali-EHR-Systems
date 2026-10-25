import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { clinicDate } from "./database.js";
import { prepareIncomingDocument } from "./incoming-document.js";
import { localPdfOcr } from "./ocr-local.js";
import {
  signedAddendaForNote,
  pendingSignedSourceCorrections,
} from "./note-addenda.js";
import { receivedResultsForNote } from "./note-results.js";
import { patientDemographicKeys } from "./patient-profile-model.js";
import {
  captureRegistrationInsurance,
  financeRequest,
} from "./finance-engine.js";
import {
  readWorkflowState,
  runAutomation,
  workflowRequest,
  recordVisitStatus,
  type WorkflowUser,
  type WorkflowContext,
  type WorkflowState,
} from "./workflow-engine.js";

type Row = Record<string, any>;
export function initializeWorkflows(db: DatabaseSync) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS workflow_state (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)",
  );
  db.prepare("INSERT OR IGNORE INTO workflow_state VALUES (1, ?)").run(
    JSON.stringify(readWorkflowState()),
  );
}
export function loadWorkflow(db: DatabaseSync): WorkflowState {
  return readWorkflowState(
    (
      db.prepare("SELECT document FROM workflow_state WHERE id=1").get() as
        Row | undefined
    )?.document,
  );
}
export function saveWorkflow(db: DatabaseSync, state: WorkflowState) {
  db.prepare("UPDATE workflow_state SET document=? WHERE id=1").run(
    JSON.stringify(state),
  );
}
export function syncAppointmentWorkflow(
  db: DatabaseSync,
  appointment: Row,
  status: string,
) {
  const state = loadWorkflow(db);
  recordVisitStatus(state, appointment, status, new Date().toISOString());
  saveWorkflow(db, state);
}
export function context(db: DatabaseSync, user: WorkflowUser): WorkflowContext {
  const currentState = loadWorkflow(db);
  return {
    user,
    users: db
      .prepare("SELECT id, name, email, role,is_active FROM users")
      .all() as WorkflowUser[],
    patients: (db.prepare("SELECT * FROM patients").all() as Row[]).map(
      (p) => ({
        ...p,
        allergies: JSON.parse(p.allergies),
        conditions: JSON.parse(p.conditions),
        medications: JSON.parse(p.medications),
      }),
    ),
    appointments: db
      .prepare(
        "SELECT a.*, u.name provider FROM appointments a JOIN users u ON u.id=a.provider_id",
      )
      .all(),
    encounters: (db.prepare("SELECT * FROM encounters").all() as Row[]).map(
      (e) => ({
        ...e,
        received_results: receivedResultsForNote(currentState, e.id),
        signed_addenda: signedAddendaForNote(currentState, e.id),
        source_corrections: pendingSignedSourceCorrections(currentState, e.id),
      }),
    ),
    tasks: db.prepare("SELECT * FROM tasks").all(),
    labs: db.prepare("SELECT * FROM labs").all(),
    now: new Date().toISOString(),
    today: clinicDate(),
    local_time: new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Los_Angeles",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date()),
    id: (prefix) => `${prefix}-${randomUUID()}`,
    audit: (action, resource) => {
      db.prepare(
        "INSERT INTO audit (user_id, action, resource) VALUES (?, ?, ?)",
      ).run(user.id, action, resource);
    },
    makeToken: () => {
      const token = randomBytes(32).toString("hex");
      return { token, hash: hashToken(token) };
    },
  };
}
// Called inside the registration transaction so all records and audit entries commit together.
export function registerPatientInsurance(
  db: DatabaseSync,
  user: WorkflowUser,
  patientId: string,
  input: unknown,
  workersComp?: unknown,
) {
  const state = loadWorkflow(db);
  financeRequest(
    state.finance,
    context(db, user),
    "GET",
    new URL("https://finance.invalid/finance/accounts"),
    {},
  );
  if (input !== undefined)
    captureRegistrationInsurance(
      state.finance,
      context(db, user),
      patientId,
      input,
    );
  if (workersComp !== undefined)
    financeRequest(
      state.finance,
      context(db, user),
      "POST",
      new URL("https://finance.invalid/finance/accounts"),
      {
        ...(workersComp as object),
        patient_id: patientId,
        kind: "Workers compensation",
      },
    );
  saveWorkflow(db, state);
}
const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function executeWorkflow(
  db: DatabaseSync,
  user: WorkflowUser,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  practice?: WorkflowContext["practice"],
) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const state = loadWorkflow(db);
    const ctx = context(db, user);
    ctx.practice = practice;
    if (token) ctx.tokenHash = hashToken(token);
    const beforePatients = new Map(
      ctx.patients.map((p) => [
        p.id,
        JSON.stringify([p.allergies, p.medications, ...patientDemographicKeys.map((key) => p[key])]),
      ]),
    );
    const beforeAppointments = new Map(
      ctx.appointments.map((a) => [a.id, JSON.stringify(a)]),
    );
    runAutomation(state, ctx);
    const result = workflowRequest(state, ctx, method, path, body);
    for (const p of ctx.patients)
      if (
        beforePatients.get(p.id) !==
        JSON.stringify([p.allergies, p.medications, ...patientDemographicKeys.map((key) => p[key])])
      )
        db.prepare(
          `UPDATE patients SET allergies=?, medications=?, ${patientDemographicKeys.map((key) => `${key}=?`).join(",")} WHERE id=?`,
        ).run(JSON.stringify(p.allergies), JSON.stringify(p.medications), ...patientDemographicKeys.map((key) => p[key] || ""), p.id);
    for (const a of ctx.appointments) {
      const values = [
        a.patient_id,
        a.date,
        a.time,
        a.duration,
        a.type,
        a.reason || "",
        a.status,
        a.provider_id,
        a.billing_account_id || "",
        a.id,
      ];
      if (!beforeAppointments.has(a.id))
        db.prepare(
          "INSERT INTO appointments (patient_id,date,time,duration,type,reason,status,provider_id,billing_account_id,id) VALUES (?,?,?,?,?,?,?,?,?,?)",
        ).run(...values);
      else if (beforeAppointments.get(a.id) !== JSON.stringify(a))
        db.prepare(
          "UPDATE appointments SET patient_id=?,date=?,time=?,duration=?,type=?,reason=?,status=?,provider_id=?,billing_account_id=? WHERE id=?",
        ).run(...values);
    }
    saveWorkflow(db, state);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function registerPublicIntake(
  app: Express,
  db: DatabaseSync,
  practice?: () => WorkflowContext["practice"],
) {
  function handler(req: Request, res: Response) {
    const token = String(req.params.token);
    if (!/^[a-f0-9]{64}$/.test(token))
      return res.status(404).json({ error: "This intake link is invalid" });
    const state = loadWorkflow(db);
    const intake = state.intakes.find((i) => i.token_hash === hashToken(token));
    if (!intake)
      return res.status(404).json({ error: "This intake link is invalid" });
    const user = db
      .prepare("SELECT id, name, email, role FROM users WHERE id=?")
      .get(intake.issuer_id) as WorkflowUser;
    if (!user)
      return res.status(410).json({ error: "This intake link is unavailable. Please contact the practice." });
    res.json(
      executeWorkflow(
        db,
        user,
        req.method,
        `/public-intake/link${req.path === "/" ? "" : req.path}`,
        req.body,
        token,
        practice?.(),
      ),
    );
  }
  // Preserve the full suffix so unknown actions cannot become appointment changes.
  app.use("/api/intake-links/:token", handler);
}
export function registerWorkflowRoutes(
  app: Express,
  db: DatabaseSync,
  onIntake?: (token: string, expires: string) => void,
) {
  app.use("/api/workflow", async (req, res) => {
    const body =
      req.method === "POST" &&
      /^\/operations\/incoming-faxes\/?$/.test(req.path)
        ? await prepareIncomingDocument(req.body, { ocrPdf: localPdfOcr })
        : req.body;
    const result = executeWorkflow(
      db,
      res.locals.user,
      req.method,
      req.url,
      body,
      undefined,
      res.locals.practice,
    );
    if (req.method === "POST" && /^\/intake-links(?:\/[^/]+\/renew)?\/?$/.test(req.path) && result.token)
      onIntake?.(result.token, result.expires_at);
    res.json(result);
  });
  for (const method of ["get", "post"] as const)
    app[method]("/api/tasks", (req, res) =>
      res.json(
        executeWorkflow(db, res.locals.user, req.method, "/tasks", req.body),
      ),
    );
  app.patch("/api/tasks/:id", (req, res) =>
    res.json(
      executeWorkflow(
        db,
        res.locals.user,
        "PATCH",
        `/tasks/${String(req.params.id)}`,
        req.body,
      ),
    ),
  );
  app.get("/api/labs", (_req, res) => {
    if (res.locals.user.role !== "clinician")
      return res.status(403).json({ error: "Clinical access required" });
    const results = loadWorkflow(db).results;
    const existing = db
      .prepare(
        "SELECT l.*, p.first_name, p.last_name FROM labs l JOIN patients p ON p.id=l.patient_id ORDER BY l.date DESC, l.id",
      )
      .all();
    const lookup = db.prepare(
      "SELECT first_name, last_name FROM patients WHERE id=?",
    );
    db.prepare(
      "INSERT INTO audit (user_id, action, resource) VALUES (?, ?, ?)",
    ).run(res.locals.user.id, "Viewed lab results", "labs");
    res.json([
      ...results.map((r) => ({ ...r, ...(lookup.get(r.patient_id) as Row) })),
      ...existing,
    ]);
  });
}
export function automationTick(db: DatabaseSync) {
  const user = db
    .prepare(
      "SELECT id, name, email, role FROM users WHERE role='clinician' AND is_active=1 ORDER BY CASE WHEN id='usr-clinician' THEN 0 ELSE 1 END LIMIT 1",
    )
    .get() as WorkflowUser | undefined;
  if (user) executeWorkflow(db, user, "POST", "/automation");
}
