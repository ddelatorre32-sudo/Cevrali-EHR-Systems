import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { getPatientAllergyProfile } from "./patient-profile-engine.js";
import { patientDemographicKeys } from "./patient-profile-model.js";
import { defaultPatientAccountId, ensurePatientAccounts, patientAccount, readJson } from "./patient-accounts.js";
import type { WorkflowContext, WorkflowState } from "./workflow-engine.js";
import type {
  DemoPrescriber, Prescription, PrescriptionAccount, PrescriptionFields, PrescriptionSignResult,
  PrescriptionSnapshot, PrescriptionView, PrescribingSettingsView, PrescribingState,
  PrescribingWorkspace, RefillRequest, RefillRequestView,
} from "./prescribing-model.js";

const text = (max: number) => z.string().trim().max(max);
const short = text(200).min(1);
const clientId = text(100).min(8);
const revision = z.number().int().positive();
const prescriptionFields = z.object({
  medication_name: short, strength: text(100).min(1), dose: text(200).min(1),
  route: text(100).min(1), frequency: text(200).min(1), instructions: text(3000).min(1),
  quantity: z.number().finite().positive().max(100000), quantity_unit: text(100).min(1),
  days_supply: z.number().int().positive().max(365), refills: z.number().int().min(0).max(99),
  pharmacy: z.object({ name: short, address: text(500).min(1), phone: text(40).min(1) }).strict(),
  controlled_schedule: z.enum(["Non-controlled", "II", "III", "IV", "V"]),
}).strict();
const createInput = prescriptionFields.extend({
  patient_id: short, encounter_id: short.nullable().default(null), billing_account_id: short,
  refill_request_id: short.optional(), client_id: clientId,
}).strict();
const patchInput = prescriptionFields.partial().extend({ revision }).strict()
  .refine(input => Object.keys(input).some(key => key !== "revision"), "Include a prescription change");
const digest = (value: unknown) => Array.from(sha256(new TextEncoder().encode(JSON.stringify(value))),
  byte => byte.toString(16).padStart(2, "0")).join("");
function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
const copied = <T>(value: T): T => structuredClone(value);

export function emptyPrescribingState(): PrescribingState {
  return {
    prescriptions: [], refills: [], challenges: [], auth_failures: [], auth_locks: [], preferred_pharmacies: {},
    settings: { revision: 1, prescribers: ["usr-clinician", "usr-colleague"].map(user_id => ({
      user_id, can_prescribe_demo: true, can_prescribe_controlled_demo: true,
    })) },
  };
}
function prescribing(state: WorkflowState): PrescribingState {
  const result = state.prescribing ||= emptyPrescribingState();
  result.auth_locks ||= [];
  result.preferred_pharmacies ||= {};
  return result;
}
function requireStaff(ctx: WorkflowContext) {
  const member = ctx.users.find(user => user.id === ctx.user.id);
  if (!member || !["clinician", "receptionist"].includes(member.role) || member.role !== ctx.user.role ||
    member.is_active === false || member.is_active === 0 || ctx.user.is_active === false || ctx.user.is_active === 0)
    fail(403, "Active practice staff access required");
}
function requireClinical(ctx: WorkflowContext) {
  requireStaff(ctx);
  if (ctx.user.role !== "clinician") fail(403, "Clinical access required");
}
function person(ctx: WorkflowContext, id: string) {
  return ctx.users.find(user => user.id === id)?.name || "Former practice member";
}
function patient(ctx: WorkflowContext, id: string) {
  return ctx.patients.find(row => row.id === id) || fail(404, "Patient not found");
}
function patientName(ctx: WorkflowContext, id: string) {
  const row = patient(ctx, id);
  return `${row.first_name} ${row.last_name}`;
}
function access(state: PrescribingState, userId: string): DemoPrescriber {
  return copied(state.settings.prescribers.find(row => row.user_id === userId) || {
    user_id: userId, can_prescribe_demo: false, can_prescribe_controlled_demo: false,
  });
}
function requirePrescriber(state: PrescribingState, ctx: WorkflowContext, controlled = false) {
  requireClinical(ctx);
  const grant = access(state, ctx.user.id);
  if (!grant.can_prescribe_demo || (controlled && !grant.can_prescribe_controlled_demo))
    fail(403, controlled ? "Controlled-medication demo authorization is not enabled for this prescriber" :
      "Demo prescribing permission is required. Ask a practice administrator to enable it.");
}
function validateFields(fields: PrescriptionFields) {
  if (fields.controlled_schedule === "II" && fields.refills !== 0)
    fail(400, "Schedule II prescriptions cannot include refills");
  if (["III", "IV"].includes(fields.controlled_schedule) && (fields.refills > 5 || fields.days_supply > 180))
    fail(400, "Schedule III and IV demo prescriptions allow at most five refills and 180 days supplied");
}
function fieldsOf(rx: PrescriptionFields): PrescriptionFields {
  return prescriptionFields.parse(Object.fromEntries(Object.keys(prescriptionFields.shape).map(key =>
    [key, rx[key as keyof PrescriptionFields]])));
}
function accountSnapshot(state: WorkflowState, ctx: WorkflowContext, patientId: string, accountId: string): PrescriptionAccount {
  ensurePatientAccounts(state.finance, ctx);
  const account = patientAccount(state.finance, patientId, accountId, true);
  return { id: account.id, revision: account.revision, name: account.name, kind: account.kind,
    claim_number: account.workers_comp?.claim_number || "" };
}
function contextData(state: WorkflowState, ctx: WorkflowContext, rx: Pick<Prescription, "patient_id" | "encounter_id" | "billing_account">) {
  const row = patient(ctx, rx.patient_id);
  const selected = state.finance.billing_accounts.find(account => account.id === rx.billing_account.id && account.patient_id === row.id);
  if (!selected || selected.status !== "Active") fail(409, "The prescription billing account is no longer active. Prepare a new draft after reviewing the visit account.");
  const encounter = rx.encounter_id ? ctx.encounters.find(item => item.id === rx.encounter_id && item.patient_id === row.id) : null;
  if (rx.encounter_id && !encounter) fail(409, "The prescription encounter is no longer available");
  if (encounter && (encounter.billing_account_id || defaultPatientAccountId(row.id)) !== rx.billing_account.id)
    fail(409, "The visit insurance account changed. Cancel this local draft and prepare a new prescription for the selected account.");
  return {
    patient: Object.fromEntries(patientDemographicKeys.map(key => [key, row[key] || ""])),
    medications: readJson(row.medications, []), allergy: getPatientAllergyProfile(state, row),
    account: copied(selected),
    policies: state.finance.policies.filter(policy => policy.patient_id === row.id &&
      (policy.billing_account_id || defaultPatientAccountId(row.id)) === selected.id),
    encounter: encounter ? { id: encounter.id, patient_id: encounter.patient_id,
      billing_account_id: encounter.billing_account_id || defaultPatientAccountId(row.id),
      author_id: encounter.author_id, status: encounter.status,
      chief_complaint: encounter.chief_complaint, subjective: encounter.subjective,
      objective: encounter.objective, assessment: encounter.assessment, plan: encounter.plan } : null,
  };
}
function currentReview(state: WorkflowState, ctx: WorkflowContext, rx: Prescription) {
  if (!rx.review) return false;
  try { return rx.review.context_fingerprint === digest(contextData(state, ctx, rx)); }
  catch { return false; }
}
function view(state: WorkflowState, ctx: WorkflowContext, rx: Prescription): PrescriptionView {
  const { requests: _requests, ...details } = rx;
  const mutable = rx.author_id === ctx.user.id && ["Draft", "Ready for demo signing"].includes(rx.status);
  const grant = access(prescribing(state), ctx.user.id);
  const review_current = currentReview(state, ctx, rx);
  return copied({ ...details, patient_name: patientName(ctx, rx.patient_id), author_name: person(ctx, rx.author_id),
    can_edit: mutable, can_review: mutable && grant.can_prescribe_demo &&
      (rx.controlled_schedule === "Non-controlled" || grant.can_prescribe_controlled_demo),
    can_sign: mutable && rx.status === "Ready for demo signing" && review_current && grant.can_prescribe_demo &&
      (rx.controlled_schedule === "Non-controlled" || grant.can_prescribe_controlled_demo),
    review_current, pharmacy_transmitted: false as const });
}
function checkRevision(rx: Prescription, expected: number) {
  if (rx.revision !== expected) fail(409, "Prescription changed. Reload it before continuing.");
}
function requireAuthor(ctx: WorkflowContext, rx: Prescription) {
  requireClinical(ctx);
  if (rx.author_id !== ctx.user.id) fail(403, "Only the authoring prescriber can change or authorize this prescription");
}
function requireDraft(ctx: WorkflowContext, rx: Prescription, expected: number) {
  requireAuthor(ctx, rx); checkRevision(rx, expected);
  if (!["Draft", "Ready for demo signing"].includes(rx.status))
    fail(409, "This prescription is finalized locally and cannot be edited");
}
function history(ctx: WorkflowContext, rx: Prescription, action: string, detail: string) {
  rx.history.push({ id: ctx.id("prescription-history"), action, at: ctx.now,
    actor_id: ctx.user.id, actor_name: ctx.user.name, revision: rx.revision, detail });
  ctx.audit(action, rx.id);
}
function repeated(rx: Prescription, action: string, id: string, fingerprint: string) {
  const found = rx.requests.find(request => request.client_id === id);
  if (!found) return false;
  if (found.action !== action || found.fingerprint !== fingerprint)
    fail(409, "This prescription request identifier was already used for different information");
  return true;
}
function clearChallenges(state: PrescribingState, rx: Prescription, now: string) {
  for (const challenge of state.challenges)
    if (challenge.prescription_id === rx.id && !challenge.consumed_at) challenge.consumed_at = now;
}
function requireReviewed(state: WorkflowState, ctx: WorkflowContext, rx: Prescription) {
  if (rx.status !== "Ready for demo signing" || !rx.review)
    fail(409, "Review the prescription before demo signing");
  // Context includes current patient identity, detailed allergies, medications,
  // selected payer/claim, and encounter. Review cannot survive changes to them.
  const fingerprint = digest(contextData(state, ctx, rx));
  if (rx.review.context_fingerprint !== fingerprint)
    fail(409, "Patient, medication, allergy, or visit information changed. Review the prescription again before signing.");
  return fingerprint;
}

function workspace(state: WorkflowState, ctx: WorkflowContext, url: URL): PrescribingWorkspace {
  const query = z.object({ patient_id: short, encounter_id: short.optional() }).strict().parse(Object.fromEntries(url.searchParams));
  const row = patient(ctx, query.patient_id);
  ensurePatientAccounts(state.finance, ctx);
  const encounter = query.encounter_id ? ctx.encounters.find(item => item.id === query.encounter_id && item.patient_id === row.id) : null;
  if (query.encounter_id && !encounter) fail(404, "Encounter does not belong to this patient");
  const allergy = getPatientAllergyProfile(state, row);
  const accounts = state.finance.billing_accounts.filter(account => account.patient_id === row.id && account.status === "Active")
    .map(account => accountSnapshot(state, ctx, row.id, account.id));
  return copied({
    patient: { id: row.id, first_name: row.first_name, last_name: row.last_name, dob: row.dob,
      allergies: allergy.records.filter(record => record.status === "Active").map(record => record.name),
      allergy_status: allergy.status, active_allergy_records: allergy.records.filter(record => record.status === "Active"),
      medications: readJson(row.medications, []) },
    encounter_id: encounter?.id || null, billing_accounts: accounts,
    selected_billing_account_id: encounter?.billing_account_id || defaultPatientAccountId(row.id),
    prescriptions: prescribing(state).prescriptions.filter(rx => rx.patient_id === row.id).map(rx => view(state, ctx, rx)),
    access: access(prescribing(state), ctx.user.id), mode: "Demo only" as const,
    pharmacy_connected: false as const, epcs_connected: false as const, interaction_checks_available: false as const,
    preferred_pharmacy: prescribing(state).preferred_pharmacies[row.id] || null,
  });
}
function settingsView(state: PrescribingState, ctx: WorkflowContext): PrescribingSettingsView {
  return {
    revision: state.settings.revision, mode: "Demo only", pharmacy_connected: false, epcs_connected: false,
    prescribers: ctx.users.filter(user => user.role === "clinician").map(user => ({
      ...access(state, user.id), name: user.name, is_active: user.is_active !== 0 && user.is_active !== false,
    })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
function settingsRequest(state: WorkflowState, ctx: WorkflowContext, method: string, body: unknown) {
  const current = prescribing(state);
  if (method === "GET") return settingsView(current, ctx);
  if (method !== "PATCH") fail(405, "Use GET or PATCH for prescribing settings");
  if (!ctx.user.is_admin) fail(403, "Practice administrator access required");
  const input = z.object({ revision, prescribers: z.array(z.object({
    user_id: short, can_prescribe_demo: z.boolean(), can_prescribe_controlled_demo: z.boolean(),
  }).strict()).max(300) }).strict().parse(body);
  if (input.revision !== current.settings.revision) fail(409, "Prescribing permissions changed. Reload settings before saving.");
  const ids = new Set<string>();
  for (const grant of input.prescribers) {
    if (ids.has(grant.user_id)) fail(400, "Include each prescriber only once");
    ids.add(grant.user_id);
    const user = ctx.users.find(member => member.id === grant.user_id && member.role === "clinician");
    if (!user) fail(400, "Choose clinicians in this practice");
    if ((user.is_active === false || user.is_active === 0) && (grant.can_prescribe_demo || grant.can_prescribe_controlled_demo))
      fail(400, "Inactive clinicians cannot receive prescribing permissions");
    if (grant.can_prescribe_controlled_demo && !grant.can_prescribe_demo)
      fail(400, "Controlled-medication demo access also requires ordinary demo prescribing access");
  }
  current.settings = { revision: current.settings.revision + 1, prescribers: copied(input.prescribers) };
  // Permission changes invalidate outstanding authorization challenges immediately.
  for (const challenge of current.challenges) if (!challenge.consumed_at) challenge.consumed_at = ctx.now;
  ctx.audit("Updated demo prescribing permissions; external prescribing remains disconnected", "prescribing-settings");
  return settingsView(current, ctx);
}
function refillView(ctx: WorkflowContext, request: RefillRequest): RefillRequestView {
  const { client_id: _client, initial_fingerprint: _fingerprint, resolution_note, prescription_id, ...safe } = request;
  return copied({ ...safe, patient_name: patientName(ctx, request.patient_id),
    ...(ctx.user.role === "clinician" ? { resolution_note, prescription_id } : {}) });
}
function refillRequest(state: WorkflowState, ctx: WorkflowContext, method: string, parts: string[], url: URL, body: unknown) {
  const current = prescribing(state);
  if (method === "GET" && parts.length === 2) {
    const query = z.object({ patient_id: short.optional() }).strict().parse(Object.fromEntries(url.searchParams));
    return current.refills.filter(request => (!query.patient_id || request.patient_id === query.patient_id) &&
      (ctx.user.role === "clinician" || request.requested_by === ctx.user.id)).map(request => refillView(ctx, request));
  }
  if (method === "POST" && parts.length === 2) {
    const input = z.object({ patient_id: short, medication_name: short, notes: text(2000).min(1), client_id: clientId }).strict().parse(body);
    patient(ctx, input.patient_id);
    const fingerprint = digest({ patient_id: input.patient_id, medication_name: input.medication_name, notes: input.notes });
    const existing = current.refills.find(request => request.requested_by === ctx.user.id && request.client_id === input.client_id);
    if (existing) {
      if (existing.initial_fingerprint !== fingerprint) fail(409, "This refill request identifier was already used for different information");
      return refillView(ctx, existing);
    }
    const request: RefillRequest = { id: ctx.id("refill-request"), patient_id: input.patient_id,
      medication_name: input.medication_name, notes: input.notes, requested_by: ctx.user.id,
      requested_by_name: ctx.user.name, created_at: ctx.now, revision: 1, status: "Requested",
      client_id: input.client_id, initial_fingerprint: fingerprint };
    current.refills.unshift(request);
    ctx.audit("Submitted medication refill request for prescriber review", request.id);
    return refillView(ctx, request);
  }
  if (method === "POST" && parts.length === 4 && parts[3] === "resolve") {
    requireClinical(ctx);
    const input = z.object({ revision, resolution: z.enum(["Reviewed", "Declined"]),
      note: text(2000).min(1), prescription_id: short.optional() }).strict().parse(body);
    const request = current.refills.find(item => item.id === parts[2]) || fail(404, "Refill request not found");
    if (request.revision !== input.revision || request.status !== "Requested") fail(409, "This refill request changed. Reload it before reviewing.");
    if (input.prescription_id) {
      const rx = current.prescriptions.find(item => item.id === input.prescription_id && item.patient_id === request.patient_id &&
        item.refill_request_id === request.id && item.author_id === ctx.user.id);
      if (!rx || !rx.snapshot || !["Simulated — not sent"].includes(rx.status))
        fail(400, "Link a locally finalized demo prescription for this patient and refill request");
      if (input.resolution === "Declined") fail(400, "A declined request cannot link a demo prescription");
    }
    request.status = input.resolution; request.resolution_note = input.note;
    request.resolved_at = ctx.now; request.resolved_by = ctx.user.id;
    request.prescription_id = input.prescription_id; request.revision++;
    ctx.audit(`Refill request ${input.resolution.toLowerCase()}; no prescription transmitted`, request.id);
    return refillView(ctx, request);
  }
  fail(404, "Refill route not found");
}
function lockRemaining(state: PrescribingState, ctx: WorkflowContext) {
  return state.auth_locks.some(lock => lock.user_id === ctx.user.id && lock.locked_until > ctx.now);
}
function failureCount(state: PrescribingState, ctx: WorkflowContext) {
  return state.auth_failures.filter(failure => failure.user_id === ctx.user.id &&
    Date.parse(failure.at) > Date.parse(ctx.now) - 15 * 60000).length;
}
function authenticationFailure(state: PrescribingState, ctx: WorkflowContext,
  rx: Prescription, challenge: PrescribingState["challenges"][number] | undefined): PrescriptionSignResult {
  if (challenge) challenge.failed_attempts++;
  state.auth_failures = state.auth_failures.filter(failure => Date.parse(failure.at) > Date.parse(ctx.now) - 15 * 60000);
  state.auth_failures.push({ user_id: ctx.user.id, session_id: ctx.prescribing_session_id || "", at: ctx.now });
  const remaining = Math.max(0, 5 - failureCount(state, ctx));
  if (!remaining) {
    const until = new Date(Date.parse(ctx.now) + 15 * 60000).toISOString();
    state.auth_locks = state.auth_locks.filter(lock => lock.user_id !== ctx.user.id);
    state.auth_locks.push({ user_id: ctx.user.id, locked_until: until });
  }
  ctx.audit("Failed controlled-medication demo authorization", rx.id);
  return { ok: false, error: remaining ? "The password or demo authorization code is incorrect." :
    "Demo authorization is locked for 15 minutes after repeated unsuccessful attempts.", attempts_remaining: remaining };
}
function sign(state: WorkflowState, ctx: WorkflowContext, rx: Prescription, body: unknown): PrescriptionSignResult {
  const input = z.object({ revision, client_id: clientId, password: z.string().max(200).optional(),
    challenge_id: short.optional(), code: z.string().max(20).optional() }).strict().parse(body);
  const current = prescribing(state);
  requireAuthor(ctx, rx);
  requirePrescriber(current, ctx, rx.controlled_schedule !== "Non-controlled");
  const fingerprint = digest({ revision: input.revision, action: "sign" });
  if (repeated(rx, "sign", input.client_id, fingerprint)) return { ok: true, prescription: view(state, ctx, rx) };
  requireDraft(ctx, rx, input.revision);
  const contextFingerprint = requireReviewed(state, ctx, rx);
  if (rx.controlled_schedule !== "Non-controlled") {
    if (lockRemaining(current, ctx)) return { ok: false, error: "Demo authorization is locked for 15 minutes after repeated unsuccessful attempts.", attempts_remaining: 0 };
    if (!ctx.prescribing_session_id || !ctx.verifyPrescribingPassword)
      fail(503, "The demo authorization service is unavailable. No prescription was finalized.");
    const challenge = current.challenges.find(item => item.id === input.challenge_id && item.prescription_id === rx.id &&
      item.user_id === ctx.user.id && item.session_id === ctx.prescribing_session_id && item.revision === rx.revision &&
      item.context_fingerprint === contextFingerprint && !item.consumed_at);
    if (!challenge || challenge.expires_at <= ctx.now)
      return { ok: false, error: "The demo authorization code is unavailable or expired. Request a new code.", attempts_remaining: Math.max(0, 5 - failureCount(current, ctx)) };
    if (challenge.failed_attempts >= 5)
      return { ok: false, error: "This demo authorization code has reached its attempt limit.", attempts_remaining: 0 };
    if (!input.password || !input.code || !ctx.verifyPrescribingPassword(input.password) ||
      digest({ id: challenge.id, code: input.code }) !== challenge.code_hash)
      return authenticationFailure(current, ctx, rx, challenge);
    challenge.consumed_at = ctx.now;
    current.auth_failures = current.auth_failures.filter(failure => failure.user_id !== ctx.user.id);
    current.auth_locks = current.auth_locks.filter(lock => lock.user_id !== ctx.user.id);
  }
  const row = patient(ctx, rx.patient_id);
  const snapshot: PrescriptionSnapshot = {
    fields: copied(fieldsOf(rx)), patient: { id: row.id, first_name: row.first_name, last_name: row.last_name, dob: row.dob },
    encounter_id: rx.encounter_id, billing_account: copied(rx.billing_account),
    prescriber: { id: ctx.user.id, name: ctx.user.name }, reviewed_at: rx.review!.reviewed_at,
    safety_note: rx.review!.safety_note, demo_authorized_at: ctx.now,
    authentication: rx.controlled_schedule === "Non-controlled" ? "Demo review confirmation" : "Demo password and displayed code",
    pharmacy_transmitted: false,
  };
  rx.snapshot = snapshot; rx.status = "Simulated — not sent"; rx.revision++; rx.updated_at = ctx.now;
  rx.requests.push({ action: "sign", client_id: input.client_id, fingerprint });
  clearChallenges(current, rx, ctx.now);
  history(ctx, rx, "Finalized demo prescription; not transmitted", "Local simulation only. Pharmacy delivery and EPCS remain disconnected.");
  return { ok: true, prescription: view(state, ctx, rx) };
}

export function prescribingRequest(state: WorkflowState, ctx: WorkflowContext,
  method: string, url: URL, body: unknown = {}): unknown {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "prescribing") fail(404, "Prescribing route not found");
  requireStaff(ctx);
  const current = prescribing(state);
  if (parts[1] === "settings" && parts.length === 2) return settingsRequest(state, ctx, method, body);
  if (parts[1] === "refills") return refillRequest(state, ctx, method, parts, url, body);
  requireClinical(ctx);
  if (parts[1] === "patients" && parts.length === 4 && parts[3] === "pharmacy" && method === "PATCH") {
    patient(ctx, parts[2]);
    const input = z.object({ revision: z.number().int().min(0), pharmacy: prescriptionFields.shape.pharmacy }).strict().parse(body);
    const previous = current.preferred_pharmacies[parts[2]];
    if ((previous?.revision || 0) !== input.revision) fail(409, "Preferred pharmacy changed. Reload it before saving.");
    const saved = { revision: input.revision + 1, pharmacy: copied(input.pharmacy) };
    current.preferred_pharmacies[parts[2]] = saved;
    ctx.audit("Updated preferred pharmacy for future prescription drafts", parts[2]);
    return copied(saved);
  }
  if (parts.length === 1 && method === "GET") return workspace(state, ctx, url);
  if (parts.length === 2 && parts[1] === "queue" && method === "GET") {
    if ([...url.searchParams.keys()].length) fail(400, "Open a patient workspace to filter prescription history");
    return current.prescriptions.map(rx => view(state, ctx, rx));
  }
  if (parts.length === 1 && method === "POST") {
    const input = createInput.parse(body);
    patient(ctx, input.patient_id); validateFields(input);
    const { client_id, patient_id, encounter_id, billing_account_id, refill_request_id, ...fields } = input;
    const fingerprint = digest({ patient_id, encounter_id, billing_account_id, refill_request_id, fields });
    const existing = current.prescriptions.find(rx => rx.author_id === ctx.user.id &&
      rx.requests.some(request => request.action === "create" && request.client_id === client_id));
    if (existing) {
      repeated(existing, "create", client_id, fingerprint);
      return view(state, ctx, existing);
    }
    const billing_account = accountSnapshot(state, ctx, patient_id, billing_account_id);
    if (encounter_id) {
      const encounter = ctx.encounters.find(row => row.id === encounter_id && row.patient_id === patient_id);
      if (!encounter) fail(400, "Encounter does not belong to this patient");
      if ((encounter.billing_account_id || defaultPatientAccountId(patient_id)) !== billing_account_id)
        fail(409, "Use the insurance account selected for this encounter");
    }
    if (refill_request_id) {
      const request = current.refills.find(row => row.id === refill_request_id && row.patient_id === patient_id && row.status === "Requested");
      if (!request) fail(400, "Choose an open refill request for this patient");
    }
    const rx: Prescription = { ...fields, id: ctx.id("prescription"), patient_id, encounter_id,
      billing_account, refill_request_id, author_id: ctx.user.id, created_at: ctx.now, updated_at: ctx.now,
      revision: 1, status: "Draft", history: [], requests: [{ action: "create", client_id, fingerprint }] };
    current.prescriptions.unshift(rx);
    history(ctx, rx, "Created prescription draft", "Local draft only; no pharmacy delivery.");
    return view(state, ctx, rx);
  }
  if (parts.length < 2 || parts.length > 3) fail(404, "Prescribing route not found");
  const rx = current.prescriptions.find(item => item.id === parts[1]) || fail(404, "Prescription not found");
  if (parts.length === 2 && method === "GET") {
    ctx.audit("Viewed prescription record", rx.id);
    return view(state, ctx, rx);
  }
  if (parts.length === 3 && parts[2] === "review-context" && method === "GET") {
    const query = new URL("/prescribing", url);
    query.searchParams.set("patient_id", rx.patient_id);
    if (rx.encounter_id) query.searchParams.set("encounter_id", rx.encounter_id);
    const contextWorkspace = workspace(state, ctx, query);
    contextWorkspace.selected_billing_account_id = rx.billing_account.id;
    const context_fingerprint = ["Draft", "Ready for demo signing"].includes(rx.status)
      ? digest(contextData(state, ctx, rx)) : null;
    ctx.audit("Viewed current patient context for prescription review", rx.id);
    return { prescription: view(state, ctx, rx), workspace: contextWorkspace, context_fingerprint };
  }
  if (parts.length === 2 && method === "PATCH") {
    const { revision: expected, ...changes } = patchInput.parse(body);
    requireDraft(ctx, rx, expected);
    const fields = prescriptionFields.parse({ ...fieldsOf(rx), ...changes }); validateFields(fields);
    Object.assign(rx, fields); delete rx.review;
    rx.status = "Draft"; rx.revision++; rx.updated_at = ctx.now;
    clearChallenges(current, rx, ctx.now);
    history(ctx, rx, "Updated prescription draft", "Safety review and demo authorization must be repeated after an edit.");
    return view(state, ctx, rx);
  }
  if (parts.length === 3 && parts[2] === "review" && method === "POST") {
    const input = z.object({ revision, context_fingerprint: z.string().regex(/^[a-f0-9]{64}$/), allergies_reviewed: z.literal(true), medications_reviewed: z.literal(true),
      classification_confirmed: z.literal(true), pdmp_reviewed: z.boolean().default(false), safety_note: text(2000).min(1) }).strict().parse(body);
    requireDraft(ctx, rx, input.revision);
    requirePrescriber(current, ctx, rx.controlled_schedule !== "Non-controlled");
    if (rx.controlled_schedule !== "Non-controlled" && !input.pdmp_reviewed)
      fail(400, "Explicitly confirm the controlled-medication PDMP review step for this demonstration");
    validateFields(rx);
    const context_fingerprint = digest(contextData(state, ctx, rx));
    if (input.context_fingerprint !== context_fingerprint)
      fail(409, "Patient, medication, allergy, or visit information changed after it was displayed. Reload the review context and review the current information.");
    // Refresh only the same account's metadata after an explicit current-context review.
    rx.billing_account = accountSnapshot(state, ctx, rx.patient_id, rx.billing_account.id);
    rx.review = { reviewed_at: ctx.now, reviewed_by: ctx.user.id, context_fingerprint,
      allergies_reviewed: true, medications_reviewed: true, classification_confirmed: true,
      pdmp_reviewed: input.pdmp_reviewed, safety_note: input.safety_note };
    rx.status = "Ready for demo signing"; rx.revision++; rx.updated_at = ctx.now;
    clearChallenges(current, rx, ctx.now);
    history(ctx, rx, "Reviewed prescription for demo signing", "Manual clinician review recorded. Automated interaction and PDMP services are not connected.");
    return view(state, ctx, rx);
  }
  if (parts.length === 3 && parts[2] === "challenge" && method === "POST") {
    const input = z.object({ revision }).strict().parse(body);
    requireDraft(ctx, rx, input.revision);
    requirePrescriber(current, ctx, true);
    if (rx.controlled_schedule === "Non-controlled") fail(400, "A demo authorization code is used only for controlled medications");
    const context_fingerprint = requireReviewed(state, ctx, rx);
    if (!ctx.prescribing_session_id || !ctx.verifyPrescribingPassword) fail(503, "The demo authorization service is unavailable");
    if (lockRemaining(current, ctx)) fail(429, "Demo authorization is locked for 15 minutes after repeated unsuccessful attempts.");
    if (current.challenges.filter(challenge => challenge.user_id === ctx.user.id &&
      Date.parse(challenge.created_at) > Date.parse(ctx.now) - 5 * 60000).length >= 5)
      fail(429, "Too many demo authorization codes were requested. Wait five minutes before requesting another.");
    clearChallenges(current, rx, ctx.now);
    const random = new Uint32Array(1); crypto.getRandomValues(random);
    const demo_code = String(random[0] % 1000000).padStart(6, "0");
    const id = ctx.id("prescribing-challenge"), expires_at = new Date(Date.parse(ctx.now) + 5 * 60000).toISOString();
    current.challenges.push({ id, prescription_id: rx.id, revision: rx.revision, user_id: ctx.user.id,
      session_id: ctx.prescribing_session_id, context_fingerprint, code_hash: digest({ id, code: demo_code }),
      created_at: ctx.now, expires_at, failed_attempts: 0 });
    ctx.audit("Created displayed demo authorization code; not EPCS authentication", rx.id);
    return { challenge_id: id, demo_code, expires_at, revision: rx.revision };
  }
  if (parts.length === 3 && parts[2] === "sign" && method === "POST") return sign(state, ctx, rx, body);
  if (parts.length === 3 && parts[2] === "cancel" && method === "POST") {
    const input = z.object({ revision, reason: text(1000).min(1) }).strict().parse(body);
    requireAuthor(ctx, rx); checkRevision(rx, input.revision);
    if (rx.status === "Cancelled locally") fail(409, "This prescription is already cancelled locally");
    rx.status = "Cancelled locally"; rx.cancellation_reason = input.reason; rx.cancelled_at = ctx.now;
    rx.revision++; rx.updated_at = ctx.now; clearChallenges(current, rx, ctx.now);
    history(ctx, rx, "Cancelled local prescription record", input.reason);
    return view(state, ctx, rx);
  }
  fail(404, "Prescribing route not found");
}
