import { ApiError } from "./api";
import { captureRegistrationInsurance } from "../server/finance-engine";
import { matchingPatients } from "../server/registration";
import { patientAddressFields } from "../server/patient-demographics";
import { getPatientAllergyProfile, initializePatientProfile } from "../server/patient-profile-engine";
import { readAppointmentRange } from "../server/scheduling";
import { syncRfaDrafts } from "../server/rfa-engine";
import {
  syncDocumentResults,
  validateNoteResultsForSignature,
  receivedResultsForNote,
} from "../server/note-results";
import {
  signedAddendaForNote,
  pendingSignedSourceCorrections,
} from "../server/note-addenda";
import { prepareIncomingDocument } from "../server/incoming-document";
import {
  saveVisitPlan,
  releaseVisitPlanForAccountChange,
  guardVisitAccountChange,
} from "../server/operations-engine";
import { financeRequest } from "../server/finance-engine";
import {
  ensurePatientAccounts,
  patientAccount,
  encounterAccountFields,
  readJson,
  defaultPatientAccountId,
} from "../server/patient-accounts";
import { z } from "zod";
import {
  signupInput,
  inviteInput,
  joinInput,
  practiceFields,
  accountPassword,
  profileComplete,
  type Practice,
  type StaffInvitation,
} from "../server/account-model";
import {
  emptyWorkflowState,
  workflowRequest,
  runAutomation,
  recordVisitStatus,
  normalizeAppointmentStatuses,
  type WorkflowContext,
} from "../server/workflow-engine";
import type {
  Appointment,
  Audit,
  Encounter,
  Lab,
  Patient,
  Task,
  User,
} from "./types";

type PreviewPatient = Patient & {
  allergies: string[];
  conditions: string[];
  medications: NonNullable<Patient["medications"]>;
};
type PreviewEncounter = Encounter & { author_id: string };
declare const __CEVRALI_PREVIEW_SEED__: {
  today: string;
  users: User[];
  patients: PreviewPatient[];
  appointments: Appointment[];
  encounters: PreviewEncounter[];
  tasks: Task[];
  labs: Lab[];
};

// Built exclusively from a fresh synthetic database, never the application database.
// All changes stay in this page's memory and are discarded when it reloads.
const seed = __CEVRALI_PREVIEW_SEED__;
type Staff = User & { is_active: boolean };
type Workspace = {
  practice: Practice;
  users: Staff[];
  passwords: Map<string, string>;
  patients: PreviewPatient[];
  appointments: Appointment[];
  encounters: PreviewEncounter[];
  tasks: Task[];
  labs: Lab[];
  events: Audit[];
  workflows: ReturnType<typeof emptyWorkflowState>;
};
// Synthetic credentials stay only in this document's memory. Never persisted or exported.
const demoUsers = seed.users.map((u) => ({
  ...u,
  is_admin: u.id === "usr-clinician",
  is_active: true,
}));
const demoWorkspace: Workspace = {
  practice: {
    id: "demo-practice",
    owner_id: "usr-clinician",
    name: "Evergreen Medical",
    legal_name: "Evergreen Medical",
    specialty: "Primary care",
    email: "hello@cevrali.demo",
    phone: "(415) 555-0100",
    address: "Synthetic demo practice",
    fax_provider_name: "Demo fax",
    fax_from_number: "",
    npi: "",
    time_zone: "America/Los_Angeles",
    created_at: new Date().toISOString(),
    setup_completed_at: new Date().toISOString(),
    is_demo: true,
    revision: 1,
  },
  users: demoUsers,
  passwords: new Map(demoUsers.map((u) => [u.email, "CevraliDemo2026!"])),
  patients: structuredClone(seed.patients),
  appointments: structuredClone(seed.appointments),
  encounters: structuredClone(seed.encounters),
  tasks: structuredClone(seed.tasks),
  labs: structuredClone(seed.labs),
  events: [],
  workflows: emptyWorkflowState(),
};
const workspaces = new Map<string, Workspace>([
  ["demo-practice", demoWorkspace],
]);
const invitations = new Map<string, StaffInvitation & { practiceId: string }>();
let active = demoWorkspace;
let {
  patients,
  appointments,
  encounters,
  tasks,
  labs,
  events,
  workflows,
  users,
} = active;
function selectWorkspace(workspace: Workspace) {
  active = workspace;
  ({
    patients,
    appointments,
    encounters,
    tasks,
    labs,
    events,
    workflows,
    users,
  } = workspace);
}
let user: Staff | null = demoUsers.find((u) => u.role === "clinician")!;
const userView = () => {
  const p = active.practice;
  return user
    ? {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        is_admin: Boolean(user.is_admin),
        practice: {
          id: p.id,
          name: p.name,
          is_demo: p.is_demo,
          setup_completed_at: p.setup_completed_at,
        },
      }
    : null;
};
const membership = (email: string) =>
  [...workspaces.values()].find((w) =>
    w.users.some((u) => u.email === email.toLowerCase().trim()),
  );
const randomToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
function invitation(token: string) {
  const i = invitations.get(token) || fail(404, "Invitation not found");
  if (i.status !== "Pending")
    fail(409, "This invitation has already been used or revoked");
  if (i.expires_at <= new Date().toISOString())
    fail(
      410,
      "This invitation has expired. Ask your practice administrator for a new link.",
    );
  return i;
}
function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const p = schema.safeParse(value);
  if (!p.success)
    fail(
      400,
      p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  return p.data;
}
let serial = 100;
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(
    new Date(),
  );
for (const appointment of appointments)
  if (appointment.date === seed.today) appointment.date = today();
function fail(status: number, message: string): never {
  throw new ApiError(status, message);
}
const timestamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const newId = (prefix: string) => `${prefix}-preview${++serial}`;
function audit(action: string, resource: string) {
  events.unshift({
    id: ++serial,
    actor: user?.name || "Preview visitor",
    action,
    resource,
    created_at: timestamp(),
  });
}
function patientById(id: string) {
  return patients.find((p) => p.id === id) || fail(404, "Patient not found");
}
function demographics(p: Patient) {
  const {
    allergies: _a,
    allergy_profile: _ap,
    conditions: _c,
    medications: _m,
    encounters: _e,
    labs: _l,
    ...rest
  } = p;
  return rest;
}

export async function previewApi<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const route = new URL(path, "https://cevrali-preview.invalid");
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(String(options.body)) : {};
  const parts = route.pathname.split("/").filter(Boolean);
  const [resource, id] = parts;
  let result: unknown;
  if (route.pathname === "/health")
    return { status: "ok", mode: "offline-preview" } as T;
  const workflowContext = (): WorkflowContext => ({
    practice: active.practice,
    user: user || users[0],
    users,
    patients,
    appointments,
    encounters: encounters.map((e) => ({
      ...e,
      received_results: receivedResultsForNote(workflows, e.id),
      signed_addenda: signedAddendaForNote(workflows, e.id),
      source_corrections: pendingSignedSourceCorrections(workflows, e.id),
    })),
    tasks,
    labs,
    now: new Date().toISOString(),
    today: today(),
    local_time: new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Los_Angeles",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date()),
    id: newId,
    audit,
    makeToken: () => {
      const token = Array.from(
        crypto.getRandomValues(new Uint8Array(32)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      return { token, hash: token };
    },
  });
  if (resource === "intake-links" && id) {
    const previous = active;
    const matching = [...workspaces.values()].find((w) =>
      w.workflows.intakes.some((i) => i.token_hash === id),
    );
    if (matching) selectWorkspace(matching);
    const ctx = workflowContext();
    ctx.tokenHash = id;
    try {
      return workflowRequest(
        workflows,
        ctx,
        method,
        `/public-intake/link${parts[2] ? "/appointment" : ""}`,
        body,
      ) as T;
    } finally {
      selectWorkspace(previous);
    }
  }
  if (route.pathname === "/accounts/signup" && method === "POST") {
    const input = parse(signupInput, body);
    if (membership(input.email))
      fail(409, "An account already exists for this email. Sign in instead.");
    const owner: Staff = {
      id: newId("usr"),
      name: input.owner_name,
      email: input.email,
      role: input.clinical_access ? "clinician" : "receptionist",
      is_admin: true,
      is_active: true,
    };
    const practice: Practice = {
      ...input.practice,
      email: input.practice.email || input.email,
      id: newId("practice"),
      owner_id: owner.id,
      created_at: new Date().toISOString(),
      setup_completed_at: null,
      is_demo: false,
      revision: 1,
      time_zone: "America/Los_Angeles",
    };
    const workspace: Workspace = {
      practice,
      users: [owner],
      passwords: new Map([[owner.email, input.password]]),
      patients: [],
      appointments: [],
      encounters: [],
      tasks: [],
      labs: [],
      events: [],
      workflows: emptyWorkflowState(),
    };
    workspaces.set(practice.id, workspace);
    selectWorkspace(workspace);
    user = owner;
    audit("Created practice account", practice.id);
    return structuredClone(userView()) as T;
  }
  if (resource === "accounts" && id === "invitations") {
    const invite = invitation(parts[2]);
    const workspace = workspaces.get(invite.practiceId)!;
    if (method === "GET")
      return {
        practice_name: workspace.practice.name,
        email: invite.email,
        role: invite.role,
        is_admin: invite.is_admin,
        expires_at: invite.expires_at,
      } as T;
    if (method === "POST" && parts[3] === "accept") {
      const input = parse(joinInput, body);
      if (membership(invite.email))
        fail(409, "An account already exists for this email");
      user = {
        id: newId("usr"),
        name: input.name,
        email: invite.email,
        role: invite.role,
        is_admin: invite.is_admin,
        is_active: true,
      };
      workspace.users.push(user);
      workspace.passwords.set(user.email, input.password);
      invite.status = "Accepted";
      selectWorkspace(workspace);
      audit("Accepted staff invitation", invite.id);
      return structuredClone(userView()) as T;
    }
  }
  if (route.pathname === "/auth/login" && method === "POST") {
    const workspace = membership(String(body.email));
    const candidate = workspace?.users.find(
      (u) => u.email === String(body.email).toLowerCase(),
    );
    if (
      !candidate ||
      !candidate.is_active ||
      body.password !== workspace?.passwords.get(candidate.email)
    )
      fail(401, "Email or password is incorrect");
    selectWorkspace(workspace!);
    user = candidate;
    audit("Opened preview workspace", "preview");
    return structuredClone(userView()) as T;
  }
  if (!user || !user.is_active) fail(401, "Please sign in to continue");
  normalizeAppointmentStatuses(workflows, appointments);
  ensurePatientAccounts(workflows.finance, workflowContext());
  if (route.pathname === "/auth/me") return structuredClone(userView()) as T;
  if (route.pathname === "/auth/logout") {
    user = null;
    return { ok: true } as T;
  }
  if (resource === "account") {
    const admin = () => {
      if (!user?.is_admin) fail(403, "Practice administrator access required");
    };
    if (method === "GET" && !id)
      return structuredClone({
        practice: active.practice,
        members: user.is_admin ? users : [],
        invitations: user.is_admin
          ? [...invitations.values()]
              .filter((i) => i.practiceId === active.practice.id)
              .map(({ practiceId, ...i }) => ({
                ...i,
                status:
                  i.status === "Pending" &&
                  i.expires_at <= new Date().toISOString()
                    ? "Expired"
                    : i.status,
              }))
          : [],
        is_admin: Boolean(user.is_admin),
        patient_count: patients.length,
      }) as T;
    if (id === "practice" && method === "PATCH") {
      admin();
      const input = parse(
        practiceFields.extend({
          revision: z.number().int(),
          complete_setup: z.boolean().optional(),
        }),
        body,
      );
      const p = active.practice;
      if (input.revision !== p.revision)
        fail(409, "Practice settings changed; reload before saving");
      const { complete_setup, ...fields } = input;
      const next = { ...p, ...fields, revision: p.revision + 1 };
      if (input.complete_setup && !profileComplete(next))
        fail(
          400,
          "Add the practice name, contact email, phone, and address before finishing setup",
        );
      if (input.complete_setup)
        next.setup_completed_at = new Date().toISOString();
      if (!profileComplete(next)) next.setup_completed_at = null;
      active.practice = next;
      audit("Updated practice settings", p.id);
      return structuredClone(next) as T;
    }
    if (id === "invitations" && method === "POST") {
      admin();
      if (parts[2]) {
        const i =
          [...invitations.values()].find(
            (i) => i.id === parts[2] && i.practiceId === active.practice.id,
          ) || fail(404, "Invitation not found");
        if (i.status !== "Pending") fail(409, "Invitation is already closed");
        i.status = "Revoked";
        audit("Revoked staff invitation", i.id);
        return { ok: true } as T;
      }
      const input = parse(inviteInput, body);
      if (membership(input.email))
        fail(
          409,
          "This email already has an account. Each staff account belongs to one practice.",
        );
      for (const i of invitations.values())
        if (
          i.email === input.email &&
          i.practiceId === active.practice.id &&
          i.status === "Pending"
        )
          i.status = "Revoked";
      const token = randomToken();
      const i: StaffInvitation & { practiceId: string } = {
        ...input,
        id: newId("invite"),
        practiceId: active.practice.id,
        status: "Pending",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 72 * 3600000).toISOString(),
      };
      invitations.set(token, i);
      audit("Created staff invitation", i.id);
      return {
        id: i.id,
        token,
        expires_at: i.expires_at,
        delivery: "Manual link; no email sent",
      } as T;
    }
    if (id === "members" && method === "PATCH") {
      admin();
      const input = parse(
        z.object({
          role: z.enum(["clinician", "receptionist"]),
          is_admin: z.boolean(),
          is_active: z.boolean(),
        }),
        body,
      );
      const member =
        users.find((u) => u.id === parts[2]) ||
        fail(404, "Staff member not found");
      if (member.id === user.id)
        fail(409, "Ask another administrator to change your access");
      if (
        member.id === active.practice.owner_id &&
        (!input.is_admin || !input.is_active)
      )
        fail(409, "The practice owner must retain administrator access");
      Object.assign(member, input);
      audit("Updated staff access", member.id);
      return { ok: true } as T;
    }
    if (id === "password" && method === "POST") {
      const input = parse(
        z.object({
          current_password: z.string().min(1),
          password: accountPassword,
        }),
        body,
      );
      if (input.current_password !== active.passwords.get(user.email))
        fail(400, "Current password is incorrect");
      active.passwords.set(user.email, input.password);
      audit("Changed account password", user.id);
      return structuredClone(userView()) as T;
    }
    fail(404, "Account route not found");
  }
  if (resource === "workflow" || resource === "tasks") {
    const ctx = workflowContext();
    if (
      resource === "workflow" &&
      (route.pathname.startsWith("/workflow/finance/") ||
        route.pathname.startsWith("/workflow/operations/") ||
        route.pathname.startsWith("/workflow/scheduling") ||
        route.pathname.startsWith("/workflow/note-addenda") ||
        route.pathname.startsWith("/workflow/intakes") ||
        route.pathname.startsWith("/workflow/patient-profiles"))
    ) {
      const originalWorkspace = active;
      const originalUser = user;
      const processedBody =
        method === "POST" &&
        /^\/workflow\/operations\/incoming-faxes\/?$/.test(route.pathname)
          ? await prepareIncomingDocument(body)
          : body;
      if (active !== originalWorkspace || user !== originalUser)
        fail(401, "Workspace session changed while processing the document");
      const staged = structuredClone(workflows);
      const auditEntries: [string, string][] = [];
      const stagedContext = {
        ...workflowContext(),
        patients: structuredClone(patients),
        appointments: structuredClone(appointments),
        audit: (action: string, resource: string) => {
          auditEntries.push([action, resource]);
        },
      };
      runAutomation(staged, stagedContext);
      const result = workflowRequest(
        staged,
        stagedContext,
        method,
        path.replace(/^\/workflow/, ""),
        processedBody,
      );
      Object.assign(workflows, staged);
      patients.splice(0, patients.length, ...stagedContext.patients as PreviewPatient[]);
      appointments.splice(
        0,
        appointments.length,
        ...stagedContext.appointments.map((a) => {
          const patient = patients.find((p) => p.id === a.patient_id);
          const provider = users.find((u) => u.id === a.provider_id);
          return {
            ...a,
            first_name: patient?.first_name || "",
            last_name: patient?.last_name || "",
            dob: patient?.dob || "",
            sex: patient?.sex || "",
            provider: provider?.name || a.provider,
          };
        }),
      );
      // Match current demographic joins without rewriting saved clinical text.
      for (const record of [...encounters, ...labs, ...tasks]) {
        const person = patients.find((patient) => patient.id === record.patient_id);
        if (person) {
          record.first_name = person.first_name;
          record.last_name = person.last_name;
        }
      }
      for (const [action, resource] of auditEntries) audit(action, resource);
      return structuredClone(result) as T;
    }
    runAutomation(workflows, ctx);
    return structuredClone(
      workflowRequest(
        workflows,
        ctx,
        method,
        resource === "workflow" ? path.replace(/^\/workflow/, "") : path,
        body,
      ),
    ) as T;
  }
  const clinical = user.role === "clinician";
  if (
    ["encounters", "labs", "tasks", "audit"].includes(resource) ||
    (resource === "patients" && id && id !== "matches")
  ) {
    if (!clinical) fail(403, "Clinical access required");
  }
  if (resource === "overview") {
    const day = appointments.filter(
      (a) => a.date === today() && a.status !== "Cancelled",
    );
    result = {
      today: today(),
      patients: patients.length,
      appointments: day.length,
      completed: day.filter((a) => a.status === "Completed").length,
      waiting: day.filter((a) => a.status === "Checked in").length,
      drafts: clinical
        ? encounters.filter((e) => e.status === "Draft").length
        : null,
    };
  } else if (resource === "patients") {
    if (method === "GET" && id === "matches")
      return structuredClone(
        matchingPatients(patients, {
          first_name: route.searchParams.get("first_name") || "",
          last_name: route.searchParams.get("last_name") || "",
          dob: route.searchParams.get("dob") || "",
        }),
      ) as T;
    if (method === "GET" && id) {
      result = {
        ...patientById(id),
        allergy_profile: getPatientAllergyProfile(workflows, patientById(id)),
        encounters: encounters
          .filter((e) => e.patient_id === id)
          .map((e) => ({
            ...e,
            received_results: receivedResultsForNote(workflows, e.id),
            signed_addenda: signedAddendaForNote(workflows, e.id),
            source_corrections: pendingSignedSourceCorrections(workflows, e.id),
          })),
        labs: [...workflows.results, ...labs].filter(
          (l) => l.patient_id === id,
        ),
      };
      audit("Opened patient chart", id);
    } else if (method === "GET") {
      const q = (route.searchParams.get("q") || "").toLowerCase();
      result = patients
        .filter((p) =>
          `${p.first_name} ${p.last_name} ${p.id}`.toLowerCase().includes(q),
        )
        .map(demographics)
        .sort((a, b) => a.last_name.localeCompare(b.last_name));
    } else if (method === "POST") {
      const address = parse(patientAddressFields, body);
      if (
        !body.first_name?.trim() ||
        !body.last_name?.trim() ||
        !body.dob ||
        !body.phone?.trim()
      )
        fail(400, "Name, date of birth, and phone are required");
      if (body.dob > today()) fail(400, "Birth date cannot be in the future");
      if (!clinical && (body.allergies?.length || body.conditions?.length))
        fail(403, "Clinical access required");
      if (
        matchingPatients(patients, body).length &&
        body.duplicate_acknowledged !== true
      )
        fail(
          409,
          "A patient with the same name and birth date already exists. Review the existing record or confirm a separate patient.",
        );
      const patient: PreviewPatient = {
        id: newId("pat"),
        first_name: body.first_name.trim(),
        last_name: body.last_name.trim(),
        dob: body.dob,
        sex: body.sex || "Unknown",
        phone: body.phone.trim(),
        email: body.email || "",
        ...address,
        allergies: body.allergies || [],
        conditions: body.conditions || [],
        medications: [],
        created_at: timestamp(),
      };
      // Stage all insurance writes and audit events; a failed check must not leave
      // a patient or partial coverage behind in the offline preview.
      {
        const staged = structuredClone(workflows.finance);
        const pendingAudit: [string, string][] = [];
        const ctx = workflowContext();
        const registrationContext = {
          ...ctx,
          patients: [...patients, patient],
          audit: (action: string, resource: string) => {
            pendingAudit.push([action, resource]);
          },
        };
        ensurePatientAccounts(staged, registrationContext);
        if (body.insurance !== undefined)
          captureRegistrationInsurance(
            staged,
            registrationContext,
            patient.id,
            body.insurance,
          );
        if (body.workers_comp !== undefined)
          financeRequest(
            staged,
            registrationContext,
            "POST",
            new URL("https://finance.invalid/finance/accounts"),
            {
              ...body.workers_comp,
              patient_id: patient.id,
              kind: "Workers compensation",
            },
          );
        workflows.finance = staged;
        for (const [action, resource] of pendingAudit) audit(action, resource);
      }
      patients.push(patient);
      initializePatientProfile(workflows, workflowContext(), patient);
      audit("Registered preview patient", patient.id);
      if (body.duplicate_acknowledged === true)
        audit(
          "Confirmed separate preview patient after duplicate review",
          patient.id,
        );
      result = { id: patient.id };
    }
  } else if (resource === "appointments") {
    if (method === "GET") {
      const range = readAppointmentRange(
        Object.fromEntries(route.searchParams),
        today(),
      );
      result = appointments
        .filter((a) => a.date >= range.start && a.date <= range.end)
        .sort(
          (a, b) =>
            a.date.localeCompare(b.date) ||
            a.time.localeCompare(b.time) ||
            a.id.localeCompare(b.id),
        )
        .map((a) => ({
          ...a,
          billing_account_id:
            a.billing_account_id || defaultPatientAccountId(a.patient_id),
          billing_account_claim_number:
            patientAccount(
              workflows.finance,
              a.patient_id,
              a.billing_account_id,
            ).workers_comp?.claim_number || "",
          billing_account_payer:
            patientAccount(
              workflows.finance,
              a.patient_id,
              a.billing_account_id,
            ).workers_comp?.carrier ||
            workflows.finance.policies.find(
              (p) =>
                p.billing_account_id ===
                  (a.billing_account_id ||
                    defaultPatientAccountId(a.patient_id)) &&
                p.priority === "Primary" &&
                p.effective_date <= a.date &&
                (!p.end_date || p.end_date >= a.date),
            )?.payer ||
            "",
          billing_account_name: patientAccount(
            workflows.finance,
            a.patient_id,
            a.billing_account_id,
          ).name,
        }));
    } else if (method === "POST") {
      const patient = patientById(body.patient_id);
      const providers = users.filter(
        (u) => u.role === "clinician" && u.is_active,
      );
      const provider =
        (body.provider_id
          ? providers.find((u) => u.id === body.provider_id)
          : providers.find((u) => u.id === user?.id) || providers[0]) ||
        fail(400, "Invite clinical staff in Account setup before scheduling");
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time) || !body.reason?.trim())
        fail(400, "A valid time and reason are required");
      const minutes = (value: string) =>
        Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
      const start = minutes(body.time);
      const duration = Number(body.duration);
      if (duration < 15 || duration > 120 || start + duration > 1440)
        fail(400, "Invalid appointment duration");
      if (
        appointments.some(
          (a) =>
            a.date === body.date &&
            ((a.provider_id || "usr-clinician") === provider.id ||
              a.patient_id === patient.id) &&
            !["Cancelled", "No-show"].includes(a.status) &&
            start < minutes(a.time) + a.duration &&
            start + duration > minutes(a.time),
        )
      )
        fail(
          409,
          "This time overlaps another appointment. Choose an available time.",
        );
      const appointment = {
        ...body,
        ...demographics(patient),
        id: newId("apt"),
        patient_id: patient.id,
        billing_account_id: patientAccount(
          workflows.finance,
          patient.id,
          body.billing_account_id,
          true,
        ).id,
        status: "Scheduled",
        provider: provider.name,
        provider_id: provider.id,
        date: body.date,
        time: body.time,
        duration,
        type: body.type,
        reason: body.reason,
      } as Appointment;
      if (body.service_plan)
        saveVisitPlan(
          workflows,
          workflowContext(),
          appointment,
          body.service_plan,
        );
      appointments.push(appointment);
      audit("Scheduled appointment", appointment.id);
      result = { id: appointment.id };
    } else if (method === "PATCH" && id) {
      const appointment =
        appointments.find((a) => a.id === id) ||
        fail(404, "Appointment not found");
      if (parts[2] === "billing-account") {
        if (
          !["Scheduled", "Checked in"].includes(appointment.status) ||
          encounters.some((e) => e.appointment_id === id)
        )
          fail(
            409,
            "The visit has already started. Its billing account must be reviewed in the draft encounter.",
          );
        if (
          body.previous_billing_account_id !==
          (appointment.billing_account_id ||
            defaultPatientAccountId(appointment.patient_id))
        )
          fail(409, "Visit billing account changed; reload before saving");
        const nextAccount = patientAccount(
          workflows.finance,
          appointment.patient_id,
          body.billing_account_id,
          true,
        ).id;
        releaseVisitPlanForAccountChange(
          workflows,
          workflowContext(),
          appointment.id,
          nextAccount,
        );
        appointment.billing_account_id = nextAccount;
        audit("Changed scheduled visit billing account", id);
        return { ok: true } as T;
      }
      const transitions: Record<string, string[]> = {
        Scheduled: ["Checked in", "Cancelled"],
        "Checked in": ["In progress", "Cancelled"],
        "In progress": ["Completed"],
        Completed: [],
        Cancelled: [],
        "No-show": [],
      };
      if (!(transitions[appointment.status] || []).includes(body.status))
        fail(409, "Invalid appointment status change");
      if (!clinical && ["In progress", "Completed"].includes(body.status))
        fail(403, "Clinical access required");
      recordVisitStatus(
        workflows,
        appointment,
        body.status,
        new Date().toISOString(),
      );
      appointment.status = body.status;
      audit(`Appointment: ${body.status}`, id);
      result = { ok: true };
    }
  } else if (resource === "encounters") {
    if (method === "GET")
      result = encounters.map((e) => ({
        ...e,
        received_results: receivedResultsForNote(workflows, e.id),
        signed_addenda: signedAddendaForNote(workflows, e.id),
        source_corrections: pendingSignedSourceCorrections(workflows, e.id),
      }));
    else if (method === "POST") {
      const patient = patientById(body.patient_id);
      if (!body.chief_complaint?.trim())
        fail(400, "Chief complaint is required");
      const appointment = body.appointment_id
        ? appointments.find((a) => a.id === body.appointment_id)
        : null;
      if (
        body.appointment_id &&
        (!appointment || appointment.patient_id !== patient.id)
      )
        fail(400, "Appointment does not belong to this patient");
      if (appointment && ["Cancelled", "No-show"].includes(appointment.status))
        fail(409, "Cannot start a cancelled or no-show appointment");
      const scheduledAccount =
        appointment?.billing_account_id ||
        (appointment ? defaultPatientAccountId(patient.id) : undefined);
      if (
        scheduledAccount &&
        body.billing_account_id &&
        body.billing_account_id !== scheduledAccount
      )
        fail(409, "Encounter must use the scheduled visit’s billing account");
      const existing = appointment
        ? encounters.find((e) => e.appointment_id === appointment.id)
        : null;
      if (existing) result = { id: existing.id };
      else {
        const encounter: PreviewEncounter = {
          id: newId("enc"),
          patient_id: patient.id,
          appointment_id: body.appointment_id || null,
          first_name: patient.first_name,
          last_name: patient.last_name,
          author_id: user.id,
          author: user.name,
          chief_complaint: body.chief_complaint,
          subjective: "",
          objective: "",
          assessment: "",
          plan: "",
          bp: "",
          pulse: "",
          temperature: "",
          status: "Draft",
          signed_at: null,
          created_at: timestamp(),
          updated_at: new Date().toISOString(),
        };
        const account = patientAccount(
          workflows.finance,
          patient.id,
          scheduledAccount || body.billing_account_id,
          true,
        );
        Object.assign(
          encounter,
          encounterAccountFields(
            workflows.finance,
            workflowContext(),
            { ...encounter, billing_account_id: account.id },
            { billing_account_id: account.id, status: "Draft" },
          ),
        );
        encounters.unshift(encounter);
        syncDocumentResults(workflows, workflowContext());
        audit("Created encounter", encounter.id);
        result = { id: encounter.id };
      }
    } else if (method === "PATCH" && id) {
      const encounter =
        encounters.find((e) => e.id === id) || fail(404, "Encounter not found");
      if (encounter.status === "Signed")
        fail(409, "Signed notes are locked and cannot be edited");
      if (encounter.author_id !== user.id)
        fail(403, "Only the author can edit this encounter");
      if (encounter.updated_at !== body.updated_at)
        fail(409, "This note was updated elsewhere. Close and reopen it.");
      if (!["Draft", "Signed"].includes(body.status))
        fail(400, "Invalid note status");
      if (!body.chief_complaint?.trim())
        fail(400, "Chief complaint is required");
      if (
        body.status === "Signed" &&
        (!body.assessment?.trim() || !body.plan?.trim())
      )
        fail(400, "Assessment and plan are required to sign a note");
      if (
        body.status === "Signed" &&
        [body.subjective, body.objective, body.assessment, body.plan].some(
          (value) => value?.includes("[["),
        )
      )
        fail(400, "Resolve all template placeholders before signing");
      if (body.bp && !/^\d{2,3}\/\d{2,3}$/.test(body.bp))
        fail(400, "Use systolic/diastolic format");
      const accountFields = encounterAccountFields(
        workflows.finance,
        workflowContext(),
        encounter,
        body,
      );
      if (encounter.appointment_id)
        guardVisitAccountChange(
          workflows,
          workflowContext(),
          encounter.appointment_id,
          accountFields.billing_account_id,
        );
      if (body.status === "Signed")
        validateNoteResultsForSignature(
          workflows,
          workflowContext(),
          encounter,
          body,
          accountFields.billing_account_id,
        );
      for (const key of [
        "chief_complaint",
        "subjective",
        "objective",
        "assessment",
        "plan",
        "bp",
        "pulse",
        "temperature",
        "status",
      ] as const)
        encounter[key] = body[key];
      Object.assign(encounter, accountFields);
      const scheduled = appointments.find(
        (a) => a.id === encounter.appointment_id,
      );
      if (scheduled) {
        releaseVisitPlanForAccountChange(
          workflows,
          workflowContext(),
          scheduled.id,
          accountFields.billing_account_id,
        );
        scheduled.billing_account_id = accountFields.billing_account_id;
      }
      encounter.updated_at = new Date().toISOString();
      if (body.status === "Signed") encounter.signed_at = encounter.updated_at;
      if (body.status === "Signed")
        syncRfaDrafts(workflows.finance, workflowContext());
      audit(
        body.status === "Signed" ? "Signed encounter" : "Saved encounter draft",
        id,
      );
      result = { ok: true, updated_at: encounter.updated_at };
    }
  } else if (resource === "tasks") {
    if (method === "GET") result = tasks;
    else if (method === "PATCH" && id) {
      const task =
        tasks.find((t) => t.id === id) || fail(404, "Task not found");
      task.done = Number(Boolean(body.done));
      audit(task.done ? "Completed task" : "Reopened task", id);
      result = { ok: true };
    }
  } else if (resource === "labs" && method === "GET")
    result = [
      ...workflows.results.map((r) => ({
        ...r,
        first_name: patientById(r.patient_id).first_name,
        last_name: patientById(r.patient_id).last_name,
      })),
      ...labs,
    ];
  else if (resource === "audit" && method === "GET")
    result = events.slice(0, 100);
  if (result === undefined) fail(404, "Preview route not found");
  return structuredClone(result) as T;
}
