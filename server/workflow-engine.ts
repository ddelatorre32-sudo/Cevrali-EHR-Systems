import { z } from "zod";
import { emptyPrescribingState, prescribingRequest } from "./prescribing-engine.js";
import type { PrescribingState } from "./prescribing-model.js";
import { digitalCheckInRequest, emptyDigitalCheckInState, ensureCheckInPacket } from "./digital-checkin-engine.js";
import type { DigitalCheckInState } from "./digital-checkin-model.js";
import { staffTaskRequest } from "./staff-task-engine.js";
import { myWorkRequest } from "./my-work-engine.js";
import { emptyStaffCommunicationState, staffCommunicationRequest } from "./staff-communication.js";
import type { StaffCommunicationState } from "./staff-communication-model.js";
import { templateLibraryRequest } from "./template-library.js";
import { patientProfileRequest, reconcileIntakeAllergies } from "./patient-profile-engine.js";
import type { PatientProfilesState } from "./patient-profile-model.js";
import {
  defaultWorkspaceSettings,
  workspaceSettingsPatch,
  type WorkspaceSettings,
} from "./settings-model.js";
import {
  emptySchedulingState,
  scheduleWorkflowRequest,
  type SchedulingState,
} from "./schedule-workflows.js";
import {
  emptyNoteAddendaState,
  noteAddendaRequest,
  guardCorrectionTaskCompletion,
  type NoteAddendaState,
} from "./note-addenda.js";
import { validateTreatmentForBill } from "./treatment-rules.js";
import { syncStructuredNoteResults } from "./note-results.js";
import {
  emptyOperationsState,
  operationsRequest,
  guardServiceCancellation,
  type OperationsState,
} from "./operations-engine.js";
import {
  emptyFinanceState,
  financeRequest,
  readFinanceState,
  type FinanceState,
} from "./finance-engine.js";

export type WorkflowUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  is_active?: number | boolean;
  is_admin?: number | boolean;
};
type RecordRow = Record<string, any>;
export type VisitStage =
  | "Scheduled"
  | "Waiting"
  | "Roomed"
  | "Ready"
  | "With clinician"
  | "Checkout"
  | "Done"
  | "No-show"
  | "Cancelled";
export type Visit = {
  stage: VisitStage;
  room: string;
  entered_at: string | null;
  checked_in_at?: string;
  roomed_at?: string;
  ready_at?: string;
  started_at?: string;
  completed_at?: string;
  no_show_at?: string;
  confirmation?: string;
};
export type Intake = {
  id: string;
  patient_id: string;
  appointment_id: string;
  status: "Requested" | "Submitted" | "Reviewed" | "Revoked";
  token_hash: string;
  expires_at: string;
  created_at: string;
  submitted_at?: string;
  reviewed_at?: string;
  reviewed_by?: string;
  issuer_id: string;
  answers?: {
    concern: string;
    symptoms: string;
    allergies: string[];
    medications: { name: string; dose: string; frequency: string }[];
    reminder_consent: boolean;
  };
};
export type CareTask = {
  id: string;
  patient_id: string | null;
  title: string;
  category: string;
  priority: "High" | "Normal";
  done: number;
  owner_id: string;
  due_date: string;
  created_at: string;
  completed_at: string | null;
  source_key?: string;
};
export type CareOrder = {
  id: string;
  patient_id: string;
  encounter_id: string | null;
  kind: "Lab" | "Referral" | "Medication";
  name: string;
  details: string;
  status: "Draft" | "Prepared" | "Result received" | "Reviewed" | "Cancelled";
  created_at: string;
  author_id: string;
  external_id: string;
};
export type CareReminder = {
  id: string;
  patient_id: string;
  appointment_id?: string;
  task_id?: string;
  kind: string;
  channel: "Manual" | "Email" | "SMS";
  due_date: string;
  status: "Scheduled" | "Ready" | "Manual outreach recorded" | "Cancelled";
  message: string;
  created_at: string;
  completed_at?: string;
  source_key: string;
};
export type NoteTemplate = {
  id: string;
  name: string;
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
  owner_id?: string;
  visibility?: "personal" | "practice";
  revision?: number;
  archived?: boolean;
  can_edit?: boolean;
};
export type WorkflowState = {
  version: 1;
  operations: OperationsState;
  finance: FinanceState;
  scheduling: SchedulingState;
  note_addenda: NoteAddendaState;
  visits: Record<string, Visit>;
  intakes: Intake[];
  tasks: CareTask[];
  task_meta: Record<string, Partial<CareTask>>;
  orders: CareOrder[];
  results: RecordRow[];
  reminders: CareReminder[];
  templates: NoteTemplate[];
  phrases: {
    id: string;
    shortcut: string;
    text: string;
    owner_id?: string;
    visibility?: "personal" | "practice";
    revision?: number;
    archived?: boolean;
    can_edit?: boolean;
  }[];
  preferences: Record<
    string,
    {
      favorites: string[];
      recent: string[];
      filters: { name: string; query: string }[];
    }
  >;
  consent: Record<string, boolean>;
  user_settings: Record<string, WorkspaceSettings>;
  patient_profiles: PatientProfilesState;
  staff_communication: StaffCommunicationState;
  digital_checkin: DigitalCheckInState;
  prescribing: PrescribingState;
  settings: {
    lab_provider: string;
    pharmacy_provider: string;
    messaging_provider: string;
    reminder_channel: "Manual" | "Email" | "SMS";
  };
};
export type WorkflowContext = {
  practice?: {
    name: string;
    address: string;
    phone: string;
    email: string;
    specialty: string;
    fax_provider_name?: string;
    fax_from_number?: string;
  };
  user: WorkflowUser;
  users: WorkflowUser[];
  patients: RecordRow[];
  appointments: RecordRow[];
  encounters: RecordRow[];
  tasks: RecordRow[];
  labs: RecordRow[];
  now: string;
  today: string;
  local_time: string;
  id: (prefix: string) => string;
  audit: (action: string, resource: string) => void;
  makeToken?: () => { token: string; hash: string };
  tokenHash?: string;
  prescribing_session_id?: string;
  verifyPrescribingPassword?: (password: string) => boolean;
  validateTreatment?: (bill: import("./finance-engine.js").Bill) => void;
};
export function workflowError(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
const short = z.string().trim().min(1).max(200);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T12:00:00Z`);
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Enter a valid calendar date");
const baselineTemplates: NoteTemplate[] = [
  {
    id: "template-preventive",
    name: "Annual preventive visit",
    subjective:
      "Patient goals: [[document goals]]\nInterval history: [[review history]]\nMedication and allergy review: [[document reconciliation]]",
    objective:
      "Vitals: [[review recorded vitals]]\nExamination: [[document findings actually observed]]",
    assessment: "Preventive care assessment: [[document assessment]]",
    plan: "Screening and prevention: [[document shared plan]]\nFollow-up: [[specify interval and reasons to return]]",
  },
  {
    id: "template-followup",
    name: "Chronic condition follow-up",
    subjective:
      "Condition being followed: [[specify]]\nSymptoms and interval changes: [[document]]\nMedication use and concerns: [[review with patient]]",
    objective: "Relevant examination and results: [[document findings]]",
    assessment: "Current status: [[document clinical assessment]]",
    plan: "Agreed next steps: [[document plan]]\nMonitoring: [[specify]]\nFollow-up: [[specify interval]]",
  },
  {
    id: "template-acute",
    name: "Focused concern",
    subjective:
      "Concern and onset: [[document]]\nAssociated symptoms: [[document]]\nRelevant history: [[document]]",
    objective: "Focused examination: [[document observed findings]]",
    assessment: "Assessment and differential: [[document]]",
    plan: "Plan and discussion: [[document]]\nReturn precautions: [[document discussion]]\nFollow-up: [[specify]]",
  },
];
export function emptyWorkflowState(): WorkflowState {
  return {
    version: 1,
    operations: emptyOperationsState(),
    finance: emptyFinanceState(),
    scheduling: emptySchedulingState(),
    note_addenda: emptyNoteAddendaState(),
    visits: {},
    intakes: [],
    tasks: [],
    task_meta: {},
    orders: [],
    results: [],
    reminders: [],
    templates: structuredClone(baselineTemplates),
    phrases: [
      {
        id: "phrase-followup",
        shortcut: ".followup",
        text: "Follow-up interval: [[specify]]. Reasons to return sooner: [[document discussion]].",
      },
      {
        id: "phrase-reconcile",
        shortcut: ".medreview",
        text: "Medication reconciliation: [[document patient-reported use, changes, and clinician review]].",
      },
    ],
    preferences: {},
    consent: {},
    user_settings: {},
    patient_profiles: {},
    staff_communication: emptyStaffCommunicationState(),
    digital_checkin: emptyDigitalCheckInState(),
    prescribing: emptyPrescribingState(),
    settings: {
      lab_provider: "",
      pharmacy_provider: "",
      messaging_provider: "",
      reminder_channel: "Manual",
    },
  };
}
export function readWorkflowState(value?: string): WorkflowState {
  if (!value) return emptyWorkflowState();
  const saved = JSON.parse(value);
  if (saved.version !== 1)
    workflowError(500, "Unsupported workflow data version");
  return {
    ...emptyWorkflowState(),
    ...saved,
    finance: readFinanceState(saved.finance),
    operations: { ...emptyOperationsState(), ...saved.operations },
    scheduling: { ...emptySchedulingState(), ...saved.scheduling },
    note_addenda: { ...emptyNoteAddendaState(), ...saved.note_addenda },
    staff_communication: { ...emptyStaffCommunicationState(), ...saved.staff_communication },
    digital_checkin: { ...emptyDigitalCheckInState(), ...saved.digital_checkin },
    prescribing: { ...emptyPrescribingState(), ...saved.prescribing },
  };
}
export function baseVisit(appointment: RecordRow): Visit {
  const stages: Record<string, VisitStage> = {
    Scheduled: "Scheduled",
    "Checked in": "Waiting",
    "In progress": "With clinician",
    Completed: "Done",
    Cancelled: "Cancelled",
    "No-show": "No-show",
  };
  return {
    stage: stages[appointment.status] || "Scheduled",
    room: "",
    entered_at: null,
  };
}
export function recordVisitStatus(
  state: WorkflowState,
  appointment: RecordRow,
  status: string,
  now: string,
) {
  const old = state.visits[appointment.id] || baseVisit(appointment);
  if (old.stage === "No-show" && status !== "No-show")
    workflowError(409, "This appointment was marked as a no-show");
  const visit: Visit = {
    ...old,
    stage: baseVisit({ status }).stage,
    entered_at: now,
  };
  if (status === "Checked in") visit.checked_in_at = now;
  if (status === "In progress") visit.started_at = now;
  if (status === "Completed") visit.completed_at = now;
  if (status === "No-show") visit.no_show_at = old.no_show_at || now;
  state.visits[appointment.id] = visit;
  if (["Cancelled", "Completed", "No-show"].includes(status))
    for (const r of state.reminders)
      if (
        r.appointment_id === appointment.id &&
        ["Scheduled", "Ready"].includes(r.status)
      )
        r.status = "Cancelled";
}
/** Older records stored no-show only in the queue; reconcile it with the appointment's terminal status. */
export function normalizeAppointmentStatus(
  state: WorkflowState,
  appointment: RecordRow,
) {
  const visit = state.visits[appointment.id];
  if (appointment.status !== "No-show" && visit?.stage !== "No-show")
    return false;
  let changed = false;
  if (appointment.status !== "No-show") {
    appointment.status = "No-show";
    changed = true;
  }
  if (
    !visit ||
    visit.stage !== "No-show" ||
    (!visit.no_show_at && visit.entered_at)
  ) {
    state.visits[appointment.id] = {
      ...(visit || baseVisit(appointment)),
      stage: "No-show",
      ...(visit?.no_show_at || visit?.entered_at
        ? { no_show_at: visit.no_show_at || visit.entered_at! }
        : {}),
    };
    changed = true;
  }
  for (const reminder of state.reminders)
    if (
      reminder.appointment_id === appointment.id &&
      ["Scheduled", "Ready"].includes(reminder.status)
    ) {
      reminder.status = "Cancelled";
      changed = true;
    }
  return changed;
}
export function normalizeAppointmentStatuses(
  state: WorkflowState,
  appointments: RecordRow[],
) {
  let changed = false;
  for (const appointment of appointments)
    if (normalizeAppointmentStatus(state, appointment)) changed = true;
  return changed;
}
export function allCareTasks(
  state: WorkflowState,
  ctx: WorkflowContext,
): Array<
  CareTask & { first_name: string; last_name: string; owner_name: string }
> {
  return [
    ...ctx.tasks.map((t) => ({
      ...t,
      owner_id: "usr-clinician",
      due_date: "",
      created_at: "",
      completed_at: null,
      ...state.task_meta[t.id],
    })),
    ...state.tasks,
  ].map((t) => ({
    ...t,
    first_name:
      ctx.patients.find((p) => p.id === t.patient_id)?.first_name || "",
    last_name: ctx.patients.find((p) => p.id === t.patient_id)?.last_name || "",
    owner_name:
      ctx.users.find((u) => u.id === t.owner_id)?.name || "Unassigned",
  })) as Array<
    CareTask & { first_name: string; last_name: string; owner_name: string }
  >;
}
function patient(ctx: WorkflowContext, id: string) {
  return (
    ctx.patients.find((p) => p.id === id) ||
    workflowError(404, "Patient not found")
  );
}
function clinical(ctx: WorkflowContext) {
  if (ctx.user.role !== "clinician")
    workflowError(403, "Clinical access required");
}
function clinicalOwner(ctx: WorkflowContext, preferred?: string) {
  return (
    ctx.users.find(
      (u) =>
        u.id === preferred &&
        u.role === "clinician" &&
        u.is_active !== 0 &&
        u.is_active !== false,
    )?.id ||
    ctx.users.find(
      (u) =>
        u.role === "clinician" && u.is_active !== 0 && u.is_active !== false,
    )?.id ||
    workflowError(409, "An active clinician is needed for care-task ownership")
  );
}
function createTask(
  state: WorkflowState,
  ctx: WorkflowContext,
  input: Omit<CareTask, "id" | "created_at" | "completed_at" | "done">,
) {
  if (input.source_key) {
    const old = state.tasks.find((t) => t.source_key === input.source_key);
    if (old) return old;
  }
  const task: CareTask = {
    ...input,
    id: ctx.id("task"),
    done: 0,
    created_at: ctx.now,
    completed_at: null,
  };
  state.tasks.push(task);
  ctx.audit("Created care task", task.id);
  return task;
}
function createReminder(
  state: WorkflowState,
  ctx: WorkflowContext,
  input: Omit<CareReminder, "id" | "created_at" | "status" | "channel">,
) {
  const existing = state.reminders.find(
    (r) => r.source_key === input.source_key,
  );
  if (existing) return existing;
  const reminder: CareReminder = {
    ...input,
    id: ctx.id("reminder"),
    created_at: ctx.now,
    channel: state.settings.reminder_channel,
    status: input.due_date <= ctx.today ? "Ready" : "Scheduled",
  };
  state.reminders.push(reminder);
  return reminder;
}
export function runAutomation(state: WorkflowState, ctx: WorkflowContext) {
  normalizeAppointmentStatuses(state, ctx.appointments);
  for (const a of ctx.appointments) {
    if (a.date < ctx.today) continue;
    if (
      ["Completed", "Cancelled", "No-show"].includes(a.status) ||
      state.visits[a.id]?.stage === "No-show"
    )
      continue;
    const previous = new Date(`${a.date}T12:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    createReminder(state, ctx, {
      patient_id: a.patient_id,
      appointment_id: a.id,
      kind: "Appointment confirmation",
      due_date: previous.toISOString().slice(0, 10),
      message: `Please confirm your appointment on ${a.date} at ${a.time} Pacific time. Contact the practice if you need to make a change.`,
      source_key: `appointment:${a.id}`,
    });
  }
  for (const e of ctx.encounters) {
    const created = Date.parse(
      e.created_at.includes("T")
        ? e.created_at
        : `${e.created_at.replace(" ", "T")}Z`,
    );
    if (e.status === "Draft" && Date.parse(ctx.now) - created >= 86400000)
      createTask(state, ctx, {
        patient_id: e.patient_id,
        title: `Complete unsigned note: ${e.chief_complaint}`,
        category: "Documentation",
        priority: "Normal",
        owner_id: clinicalOwner(ctx, e.author_id),
        due_date: ctx.today,
        source_key: `unsigned:${e.id}`,
      });
    if (e.status === "Signed") {
      const task = state.tasks.find((t) => t.source_key === `unsigned:${e.id}`);
      if (task && !task.done) {
        task.done = 1;
        task.completed_at = ctx.now;
      }
    }
  }
  for (const r of state.reminders)
    if (r.status === "Scheduled" && r.due_date <= ctx.today) r.status = "Ready";
}
function publicIntake(state: WorkflowState, ctx: WorkflowContext) {
  const intake =
    state.intakes.find((i) => i.token_hash === ctx.tokenHash) ||
    workflowError(404, "This intake link is invalid");
  if (intake.status === "Revoked" || intake.expires_at <= ctx.now)
    workflowError(
      410,
      "This intake link has expired. Please contact the practice.",
    );
  return intake;
}
export function workflowRequest(
  state: WorkflowState,
  ctx: WorkflowContext,
  method: string,
  path: string,
  body: unknown = {},
): any {
  normalizeAppointmentStatuses(state, ctx.appointments);
  const url = new URL(path, "https://workflows.invalid");
  const [resource, id, command] = url.pathname.split("/").filter(Boolean);
  if (resource === "prescribing")
    return prescribingRequest(state, ctx, method, url, body);
  if (resource === "digital-checkin")
    return digitalCheckInRequest(state, ctx, method, url, body);
  if (resource === "staff-tasks")
    return staffTaskRequest(state.staff_communication, ctx, method, url, body);
  if (resource === "my-work")
    return myWorkRequest(state, ctx, method, url, body);
  if (resource === "staff")
    return staffCommunicationRequest(state.staff_communication, ctx, method, url, body);
  if (resource === "patient-profiles")
    return patientProfileRequest(state, ctx, method, url, body);
  if (resource === "scheduling")
    return scheduleWorkflowRequest(state, ctx, method, url, body);
  if (resource === "note-addenda")
    return noteAddendaRequest(state, ctx, method, url, body, id, command);
  if (resource === "operations")
    return operationsRequest(state, ctx, method, url, body);
  if (resource === "finance") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      method === "POST" &&
      parts[1] === "authorizations" &&
      parts[3] === "cancel"
    )
      guardServiceCancellation(state, ctx, parts[2]);
    return financeRequest(
      state.finance,
      {
        ...ctx,
        validateTreatment: (bill) =>
          validateTreatmentForBill(state, ctx, bill, bill.id),
      },
      method,
      url,
      body,
    );
  }
  if (resource === "public-intake") {
    const intake = publicIntake(state, ctx);
    if (id !== "link") workflowError(404, "Intake route not found");
    if (command === "registration")
      return digitalCheckInRequest(state, ctx, method, url, body);
    if (url.pathname.split("/").filter(Boolean).length > 3 ||
      (command && command !== "appointment"))
      workflowError(404, "Intake route not found");
    const p = patient(ctx, intake.patient_id);
    const a =
      ctx.appointments.find((a) => a.id === intake.appointment_id) ||
      workflowError(404, "Appointment not found");
    if (method === "GET" && !command)
      return {
        id: intake.id,
        practice_name: ctx.practice?.name || "Your practice",
        patient_name: `${p.first_name} ${p.last_name}`,
        appointment: {
          date: a.date,
          time: a.time,
          status: a.status,
          confirmed: state.visits[a.id]?.confirmation === "Confirmed",
        },
        status: intake.status,
        expires_at: intake.expires_at,
      };
    if (command === "appointment" && method === "PATCH") {
      const input = z
        .object({ action: z.enum(["confirm", "cancel"]) })
        .parse(body);
      if (a.status !== "Scheduled")
        workflowError(
          409,
          "Please contact the practice to change a visit that has already started",
        );
      const visit = state.visits[a.id] || baseVisit(a);
      if (input.action === "confirm")
        state.visits[a.id] = { ...visit, confirmation: "Confirmed" };
      else {
        recordVisitStatus(state, a, "Cancelled", ctx.now);
        a.status = "Cancelled";
      }
      ctx.audit(
        `Patient self-service: appointment ${input.action === "confirm" ? "confirmed" : "cancelled"}`,
        a.id,
      );
      return { ok: true };
    }
    if (method === "POST" && !command) {
      if (intake.status !== "Requested")
        workflowError(409, "This form has already been submitted");
      if (["Cancelled", "Completed", "No-show"].includes(a.status))
        workflowError(
          409,
          "This appointment is closed; contact the practice about intake",
        );
      const answers = z
        .object({
          concern: short,
          symptoms: z.string().trim().max(4000),
          allergies: z.array(short).max(30),
          medications: z
            .array(
              z.object({
                name: short,
                dose: z.string().max(100),
                frequency: z.string().max(200),
              }),
            )
            .max(50),
          reminder_consent: z.boolean(),
          attested: z.literal(true),
        })
        .parse(body);
      const { attested: _a, ...reported } = answers;
      intake.answers = reported;
      intake.status = "Submitted";
      intake.submitted_at = ctx.now;
      state.consent[intake.patient_id] = answers.reminder_consent;
      createTask(state, ctx, {
        patient_id: p.id,
        title: "Review patient-submitted intake",
        category: "Intake review",
        priority: "Normal",
        owner_id: clinicalOwner(ctx, a.provider_id),
        due_date: a.date,
        source_key: `intake:${intake.id}`,
      });
      ctx.audit("Patient self-service: submitted intake", intake.id);
      return { ok: true };
    }
    workflowError(404, "Intake route not found");
  }
  if (resource === "team" && method === "GET")
    return ctx.users
      .filter((u) => u.is_active !== 0 && u.is_active !== false)
      .map(({ id, name, role }) => ({ id, name, role }));
  if (resource === "queue") {
    const selected = day.parse(url.searchParams.get("date") || ctx.today);
    return ctx.appointments
      .filter((a) => a.date === selected)
      .sort((a, b) => a.time.localeCompare(b.time))
      .map((a) => {
        const p = patient(ctx, a.patient_id);
        const visit = state.visits[a.id] || baseVisit(a);
        const intake = state.intakes.find((entry) => entry.appointment_id === a.id && entry.status !== "Revoked");
        const registration = state.digital_checkin.packets.find((packet) => packet.id === intake?.id);
        return {
          ...a,
          first_name: p.first_name,
          last_name: p.last_name,
          ...visit,
          wait_minutes:
            visit.checked_in_at &&
            !visit.started_at &&
            !["Cancelled", "No-show", "Done"].includes(visit.stage)
              ? Math.max(
                  0,
                  Math.floor(
                    (Date.parse(ctx.now) - Date.parse(visit.checked_in_at)) /
                      60000,
                  ),
                )
              : null,
          intake_status: intake?.status || "Not requested",
          intake_id: intake?.id,
          intake_expired: Boolean(intake && intake.expires_at <= ctx.now),
          registration_status: registration?.status || "Not requested",
        };
      });
  }
  if (resource === "visits" && method === "PATCH") {
    const a =
      ctx.appointments.find((a) => a.id === id) ||
      workflowError(404, "Appointment not found");
    const input = z
      .object({
        stage: z.enum([
          "Waiting",
          "Roomed",
          "Ready",
          "With clinician",
          "Checkout",
          "Done",
          "No-show",
        ]),
        room: z.string().trim().max(30).optional(),
      })
      .parse(body);
    const visit = state.visits[a.id] || baseVisit(a);
    const transitions: Record<string, string[]> = {
      Scheduled: ["Waiting", "No-show"],
      Waiting: ["Roomed"],
      Roomed: ["Ready"],
      Ready: ["With clinician"],
      "With clinician": ["Checkout"],
      Checkout: ["Done"],
      Done: [],
      "No-show": [],
      Cancelled: [],
    };
    if (
      input.stage !== visit.stage &&
      !transitions[visit.stage].includes(input.stage)
    )
      workflowError(409, `Cannot move ${visit.stage} to ${input.stage}`);
    if (["With clinician", "Checkout", "Done"].includes(input.stage))
      clinical(ctx);
    if (
      input.stage === "No-show" &&
      (a.date > ctx.today || (a.date === ctx.today && a.time > ctx.local_time))
    )
      workflowError(400, "A future appointment cannot be marked as a no-show");
    const changed = input.stage !== visit.stage;
    const next: Visit = {
      ...visit,
      stage: input.stage,
      room: input.room ?? visit.room,
      entered_at: changed ? ctx.now : visit.entered_at,
    };
    if (changed) {
      if (input.stage === "Waiting") {
        next.checked_in_at = ctx.now;
        a.status = "Checked in";
      }
      if (input.stage === "Roomed") next.roomed_at = ctx.now;
      if (input.stage === "Ready") next.ready_at = ctx.now;
      if (input.stage === "With clinician") {
        next.started_at = ctx.now;
        a.status = "In progress";
      }
      if (input.stage === "Done") {
        next.completed_at = ctx.now;
        a.status = "Completed";
      }
      if (input.stage === "No-show") {
        next.no_show_at = ctx.now;
        a.status = "No-show";
      }
      if (["Done", "No-show"].includes(input.stage))
        for (const r of state.reminders)
          if (
            r.appointment_id === id &&
            ["Ready", "Scheduled"].includes(r.status)
          )
            r.status = "Cancelled";
    }
    state.visits[a.id] = next;
    ctx.audit(`Queue: ${next.stage}`, a.id);
    return { ok: true };
  }
  if (resource === "user-settings") {
    if (id) workflowError(404, "Settings route not found");
    if (!["GET", "PATCH"].includes(method))
      workflowError(405, "Use GET or PATCH for personal settings");
    const current = {
      ...defaultWorkspaceSettings(),
      ...state.user_settings[ctx.user.id],
    };
    if (method === "GET") return current;
    const changes = workspaceSettingsPatch.parse(body);
    const next = { ...current, ...changes };
    state.user_settings[ctx.user.id] = next;
    ctx.audit("Updated personal workspace settings", ctx.user.id);
    return next;
  }
  if (resource === "preferences") {
    const pref = (state.preferences[ctx.user.id] ||= {
      favorites: [],
      recent: [],
      filters: [],
    });
    if (method === "GET") return pref;
    if (method === "PATCH") {
      const input = z
        .object({
          favorites: z.array(short).max(30).optional(),
          recent_patient: short.optional(),
          filters: z
            .array(z.object({ name: short, query: z.string().max(200) }))
            .max(20)
            .optional(),
        })
        .parse(body);
      if (input.favorites) {
        for (const id of input.favorites) patient(ctx, id);
        pref.favorites = [...new Set(input.favorites)];
      }
      if (input.recent_patient) {
        patient(ctx, input.recent_patient);
        pref.recent = [
          input.recent_patient,
          ...pref.recent.filter((id) => id !== input.recent_patient),
        ].slice(0, 8);
      }
      if (input.filters) pref.filters = input.filters;
      return pref;
    }
  }
  if (resource === "intake-links" && method === "POST" && id && command === "renew" && url.pathname.split("/").filter(Boolean).length === 3) {
    z.object({}).strict().parse(body);
    const intake = state.intakes.find((entry) => entry.id === id && entry.status !== "Revoked") || workflowError(404, "Intake not found");
    const appointment = ctx.appointments.find((entry) => entry.id === intake.appointment_id) || workflowError(404, "Appointment not found");
    if (["Cancelled", "Completed", "No-show"].includes(appointment.status)) workflowError(409, "Choose an active appointment");
    if (!ctx.makeToken) workflowError(500, "Intake links are unavailable");
    const token = ctx.makeToken();
    intake.token_hash = token.hash;
    intake.expires_at = new Date(Date.parse(ctx.now) + 72 * 3600000).toISOString();
    ctx.audit("Renewed patient intake link; previous link revoked", intake.id);
    return { id: intake.id, token: token.token, expires_at: intake.expires_at };
  }
  if (resource === "intake-links" && method === "POST" && !id) {
    const input = z.object({ appointment_id: short }).parse(body);
    const a =
      ctx.appointments.find((a) => a.id === input.appointment_id) ||
      workflowError(404, "Appointment not found");
    if (["Cancelled", "Completed", "No-show"].includes(a.status))
      workflowError(409, "Choose an active appointment");
    if (!ctx.makeToken) workflowError(500, "Intake links are unavailable");
    const token = ctx.makeToken();
    for (const old of state.intakes)
      if (old.appointment_id === a.id && old.status === "Requested")
        old.status = "Revoked";
    if (
      state.intakes.some(
        (i) =>
          i.appointment_id === a.id &&
          ["Submitted", "Reviewed"].includes(i.status),
      )
    )
      workflowError(
        409,
        "An intake has already been submitted for this appointment",
      );
    const intake: Intake = {
      id: ctx.id("intake"),
      patient_id: a.patient_id,
      appointment_id: a.id,
      status: "Requested",
      token_hash: token.hash,
      expires_at: new Date(Date.parse(ctx.now) + 72 * 3600000).toISOString(),
      created_at: ctx.now,
      issuer_id: ctx.user.id,
    };
    state.intakes.unshift(intake);
    ensureCheckInPacket(state, ctx, intake);
    ctx.audit("Created patient intake link", intake.id);
    return { id: intake.id, token: token.token, expires_at: intake.expires_at };
  }
  if (resource === "intakes") {
    clinical(ctx);
    if (method === "GET")
      return state.intakes
        .filter((i) => i.status !== "Revoked")
        .map(({ token_hash: _hash, ...i }) => ({
          ...i,
          first_name: patient(ctx, i.patient_id).first_name,
          last_name: patient(ctx, i.patient_id).last_name,
        }));
    if (method === "PATCH" && command === "review") {
      const input = z.object({ reconcile: z.boolean() }).parse(body);
      const intake =
        state.intakes.find((i) => i.id === id) ||
        workflowError(404, "Intake not found");
      if (intake.status !== "Submitted")
        workflowError(409, "Only submitted forms can be reviewed");
      if (input.reconcile && intake.answers) {
        const p = patient(ctx, intake.patient_id);
        reconcileIntakeAllergies(state, ctx, p, intake.answers.allergies, intake.id);
        p.medications = intake.answers.medications;
      }
      intake.status = "Reviewed";
      intake.reviewed_at = ctx.now;
      intake.reviewed_by = ctx.user.id;
      const task = state.tasks.find((t) => t.source_key === `intake:${id}`);
      if (task) {
        task.done = 1;
        task.completed_at = ctx.now;
      }
      ctx.audit(
        input.reconcile
          ? "Reviewed and reconciled intake"
          : "Reviewed intake without reconciliation",
        intake.id,
      );
      return { ok: true };
    }
  }
  if (resource === "templates" || resource === "phrases") {
    return templateLibraryRequest(state, ctx, method, url, body);
  }
  if (resource === "tasks") {
    clinical(ctx);
    if (method === "GET") return allCareTasks(state, ctx);
    if (method === "POST") {
      const input = z
        .object({
          patient_id: short.nullable(),
          title: short,
          category: z.enum([
            "Lab review",
            "Follow-up",
            "Documentation",
            "Intake review",
            "Referral",
            "Refill",
            "Other",
          ]),
          priority: z.enum(["High", "Normal"]).default("Normal"),
          owner_id: short,
          due_date: day,
        })
        .parse(body);
      if (input.patient_id) patient(ctx, input.patient_id);
      if (
        !ctx.users.some(
          (u) =>
            u.id === input.owner_id &&
            u.role === "clinician" &&
            u.is_active !== 0 &&
            u.is_active !== false,
        )
      )
        workflowError(400, "Choose a clinical task owner");
      return createTask(state, ctx, input);
    }
    if (method === "PATCH") {
      const input = z
        .object({
          done: z.boolean().optional(),
          owner_id: short.optional(),
          due_date: day.optional(),
          priority: z.enum(["High", "Normal"]).optional(),
        })
        .refine((v) => Object.keys(v).length > 0)
        .parse(body);
      const task =
        allCareTasks(state, ctx).find((t) => t.id === id) ||
        workflowError(404, "Task not found");
      if (
        input.owner_id &&
        !ctx.users.some(
          (u) =>
            u.id === input.owner_id &&
            u.role === "clinician" &&
            u.is_active !== 0 &&
            u.is_active !== false,
        )
      )
        workflowError(400, "Choose a clinical task owner");
      guardCorrectionTaskCompletion(state, id, input.done);
      const change = {
        ...input,
        ...(input.done !== undefined
          ? {
              done: Number(input.done),
              completed_at: input.done ? ctx.now : null,
            }
          : {}),
      };
      const added = state.tasks.find((t) => t.id === id);
      if (added) Object.assign(added, change);
      else
        state.task_meta[id] = {
          ...state.task_meta[id],
          ...change,
        } as Partial<CareTask>;
      ctx.audit(
        input.done === undefined
          ? "Updated task assignment"
          : input.done
            ? "Completed task"
            : "Reopened task",
        task.id,
      );
      return { ok: true };
    }
  }
  if (resource === "followups" && method === "POST") {
    clinical(ctx);
    const input = z
      .object({
        patient_id: short,
        encounter_id: short,
        due_date: day,
        title: short,
      })
      .parse(body);
    patient(ctx, input.patient_id);
    if (
      !ctx.encounters.some(
        (e) => e.id === input.encounter_id && e.patient_id === input.patient_id,
      )
    )
      workflowError(400, "Encounter does not belong to this patient");
    const task = createTask(state, ctx, {
      patient_id: input.patient_id,
      title: input.title,
      due_date: input.due_date,
      owner_id: ctx.user.id,
      category: "Follow-up",
      priority: "Normal",
      source_key: `followup:${input.encounter_id}:${input.due_date}`,
    });
    createReminder(state, ctx, {
      patient_id: input.patient_id,
      task_id: task.id,
      kind: "Follow-up",
      due_date: input.due_date,
      message:
        "Your care team has a follow-up reminder for you. Please contact the practice.",
      source_key: `followup:${task.id}`,
    });
    return task;
  }
  if (resource === "reminders") {
    if (method === "GET")
      return state.reminders.map((r) => ({
        ...r,
        first_name: patient(ctx, r.patient_id).first_name,
        last_name: patient(ctx, r.patient_id).last_name,
        consent: Boolean(state.consent[r.patient_id]),
        delivery:
          r.channel === "Manual"
            ? "Manual outreach"
            : !state.consent[r.patient_id]
              ? "Consent required"
              : "Provider not connected",
      }));
    if (method === "PATCH") {
      const input = z
        .object({ action: z.enum(["record-manual", "cancel"]) })
        .parse(body);
      const reminder =
        state.reminders.find((r) => r.id === id) ||
        workflowError(404, "Reminder not found");
      if (!["Ready", "Scheduled"].includes(reminder.status))
        workflowError(409, "This reminder has already been handled");
      reminder.status =
        input.action === "cancel" ? "Cancelled" : "Manual outreach recorded";
      reminder.completed_at = ctx.now;
      ctx.audit(
        input.action === "cancel"
          ? "Cancelled reminder"
          : "Recorded manual reminder outreach",
        id,
      );
      return { ok: true };
    }
  }
  if (resource === "orders") {
    clinical(ctx);
    if (method === "GET" && !id)
      return state.orders
        .filter(
          (o) =>
            !url.searchParams.get("patient_id") ||
            o.patient_id === url.searchParams.get("patient_id"),
        )
        .map((o) => ({
          ...o,
          first_name: patient(ctx, o.patient_id).first_name,
          last_name: patient(ctx, o.patient_id).last_name,
        }));
    if (method === "POST") {
      const input = z
        .object({
          patient_id: short,
          encounter_id: short.nullable().default(null),
          kind: z.enum(["Lab", "Referral", "Medication"]),
          name: short,
          details: z.string().trim().min(1).max(3000),
        })
        .parse(body);
      patient(ctx, input.patient_id);
      if (
        input.encounter_id &&
        !ctx.encounters.some(
          (e) =>
            e.id === input.encounter_id && e.patient_id === input.patient_id,
        )
      )
        workflowError(400, "Encounter does not belong to this patient");
      const order: CareOrder = {
        ...input,
        id: ctx.id("order"),
        status: "Draft",
        created_at: ctx.now,
        author_id: ctx.user.id,
        external_id: "",
      };
      state.orders.unshift(order);
      ctx.audit("Created draft order", order.id);
      return order;
    }
    const order =
      state.orders.find((o) => o.id === id) ||
      workflowError(404, "Order not found");
    if (command === "fhir" && method === "GET") {
      const p = patient(ctx, order.patient_id);
      ctx.audit("Exported draft FHIR order", order.id);
      return {
        resourceType: "Bundle",
        type: "collection",
        entry: [
          {
            resource: {
              resourceType: "Patient",
              id: p.id,
              name: [{ family: p.last_name, given: [p.first_name] }],
              birthDate: p.dob,
            },
          },
          {
            resource: {
              resourceType:
                order.kind === "Medication"
                  ? "MedicationRequest"
                  : "ServiceRequest",
              id: order.id,
              status: "draft",
              intent: "order",
              subject: { reference: `Patient/${p.id}` },
              ...(order.kind === "Medication"
                ? {
                    medicationCodeableConcept: { text: order.name },
                    dosageInstruction: [{ text: order.details }],
                  }
                : {
                    code: { text: order.name },
                    note: [{ text: order.details }],
                  }),
              authoredOn: order.created_at,
              ...(order.encounter_id
                ? {
                    encounter: { reference: `Encounter/${order.encounter_id}` },
                  }
                : {}),
            },
          },
        ],
      };
    }
    if (method === "PATCH") {
      const input = z
        .object({ status: z.enum(["Prepared", "Cancelled"]) })
        .parse(body);
      if (
        order.status !== "Draft" &&
        !(input.status === "Cancelled" && order.status === "Prepared")
      )
        workflowError(409, "This order cannot change to that status");
      order.status = input.status;
      ctx.audit(`Order ${input.status.toLowerCase()}`, id);
      return { ok: true };
    }
  }
  if (resource === "results" && method === "POST") {
    clinical(ctx);
    const input = z
      .object({
        order_id: short,
        name: short,
        value: short,
        unit: z.string().max(80),
        reference_range: z.string().max(200),
        flag: z.enum(["Normal", "High", "Low", "Abnormal"]),
        external_id: short,
        patient_reference: short,
      })
      .parse(body);
    const order =
      state.orders.find((o) => o.id === input.order_id && o.kind === "Lab") ||
      workflowError(404, "Lab order not found");
    if (order.status !== "Prepared")
      workflowError(409, "Prepare the lab order before recording a result");
    if (input.patient_reference !== `Patient/${order.patient_id}`)
      workflowError(400, "Result patient reference does not match the order");
    if (state.results.some((r) => r.external_id === input.external_id))
      workflowError(409, "This external result has already been imported");
    const result = {
      ...input,
      id: ctx.id("lab"),
      patient_id: order.patient_id,
      date: ctx.today,
      recorded_at: ctx.now,
      reviewed_at: null,
      reviewed_by: null,
    };
    state.results.unshift(result);
    order.status = "Result received";
    order.external_id = input.external_id;
    createTask(state, ctx, {
      patient_id: order.patient_id,
      title: `Review result: ${input.name}`,
      category: "Lab review",
      priority: input.flag === "Normal" ? "Normal" : "High",
      owner_id: order.author_id,
      due_date: ctx.today,
      source_key: `result:${result.id}`,
    });
    ctx.audit("Recorded external lab result", result.id);
    syncStructuredNoteResults(state, ctx);
    return result;
  }
  if (resource === "results" && method === "PATCH" && command === "review") {
    clinical(ctx);
    const result =
      state.results.find((r) => r.id === id) ||
      workflowError(404, "Imported result not found");
    if (result.reviewed_at)
      workflowError(409, "This result has already been reviewed");
    result.reviewed_at = ctx.now;
    result.reviewed_by = ctx.user.id;
    const order = state.orders.find((o) => o.id === result.order_id);
    if (order) order.status = "Reviewed";
    const task = state.tasks.find((t) => t.source_key === `result:${id}`);
    if (task) {
      task.done = 1;
      task.completed_at = ctx.now;
    }
    ctx.audit("Acknowledged lab result", id);
    return { ok: true };
  }
  if (resource === "integrations") {
    if (id) workflowError(404, "Integration settings route not found");
    if (!["GET", "PATCH"].includes(method))
      workflowError(405, "Use GET or PATCH for integration settings");
    if (method === "PATCH") {
      if (!ctx.user.is_admin)
        workflowError(403, "Practice administrator access required");
      state.settings = z
        .object({
          lab_provider: z.string().trim().max(150),
          pharmacy_provider: z.string().trim().max(150),
          messaging_provider: z.string().trim().max(150),
          reminder_channel: z.enum(["Manual", "Email", "SMS"]),
        })
        .strict()
        .parse(body);
      ctx.audit("Updated integration preferences", "integrations");
    }
    return {
      ...state.settings,
      can_manage: Boolean(ctx.user.is_admin),
      lab_connected: false,
      pharmacy_connected: false,
      messaging_connected: false,
      supported: [
        "FHIR R4 draft order export",
        "Matched lab result recording",
        "Reminder outbox and manual outreach",
      ],
      requirement:
        "Vendor-specific transport, credentials, and validation are required for live delivery. Draft exports do not transmit prescriptions or orders.",
    };
  }
  if (resource === "automation" && method === "POST") {
    clinical(ctx);
    runAutomation(state, ctx);
    return { ok: true, reminders: state.reminders.length };
  }
  if (resource === "metrics") {
    clinical(ctx);
    const from = day.parse(url.searchParams.get("from") || ctx.today);
    const to = day.parse(url.searchParams.get("to") || ctx.today);
    if (from > to || Date.parse(to) - Date.parse(from) > 366 * 86400000)
      workflowError(400, "Choose an ordered date range of up to one year");
    const selected = ctx.appointments.filter(
      (a) => a.date >= from && a.date <= to,
    );
    const active = selected.filter((a) => a.status !== "Cancelled");
    const waits = active
      .map((a) => state.visits[a.id])
      .filter((v) => v?.checked_in_at && v.started_at)
      .map(
        (v) =>
          (Date.parse(v.started_at!) - Date.parse(v.checked_in_at!)) / 60000,
      )
      .filter((n) => n >= 0);
    const tasks = allCareTasks(state, ctx);
    const completedTasks = tasks.filter(
      (t) =>
        t.completed_at &&
        t.completed_at.slice(0, 10) >= from &&
        t.completed_at.slice(0, 10) <= to &&
        t.created_at,
    );
    const turnaround = completedTasks
      .map(
        (t) =>
          (Date.parse(t.completed_at!) - Date.parse(t.created_at)) / 3600000,
      )
      .filter((v) => v >= 0);
    return {
      from,
      to,
      appointments: active.length,
      completed: active.filter((a) => a.status === "Completed").length,
      no_shows: active.filter((a) => a.status === "No-show").length,
      cancelled: selected.length - active.length,
      average_wait_minutes: waits.length
        ? waits.reduce((a, b) => a + b, 0) / waits.length
        : null,
      measured_visits: waits.length,
      unsigned_notes: ctx.encounters.filter((e) => e.status === "Draft").length,
      overdue_tasks: tasks.filter(
        (t) => !t.done && t.due_date && t.due_date < ctx.today,
      ).length,
      overdue_followups: tasks.filter(
        (t) =>
          !t.done &&
          t.category === "Follow-up" &&
          t.due_date &&
          t.due_date < ctx.today,
      ).length,
      average_task_hours: turnaround.length
        ? turnaround.reduce((a, b) => a + b, 0) / turnaround.length
        : null,
      measured_tasks: turnaround.length,
      ready_reminders: state.reminders.filter((r) => r.status === "Ready")
        .length,
      statuses: [
        "Scheduled",
        "Waiting",
        "Roomed",
        "Ready",
        "With clinician",
        "Checkout",
        "Done",
        "No-show",
      ].map((stage) => ({
        stage,
        count: active.filter(
          (a) => (state.visits[a.id] || baseVisit(a)).stage === stage,
        ).length,
      })),
    };
  }
  workflowError(404, "Workflow route not found");
}
