import { z } from "zod";
import { matchingPatients } from "./registration.js";
import {
  allergiesPatch, demographicFields, demographicsPatch, patientDemographicKeys,
  type AllergyProfile, type AllergyRecord, type DemographicPatient,
  type PatientProfileView, type ProfileChange, type StoredPatientProfile,
} from "./patient-profile-model.js";
import type { WorkflowContext, WorkflowState } from "./workflow-engine.js";

type Row = Record<string, any>;
const normalized = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
function namesOf(patient: Row): string[] {
  const names = typeof patient.allergies === "string" ? JSON.parse(patient.allergies) : patient.allergies || [];
  const seen = new Set<string>();
  return (names as unknown[]).filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
    .map((name) => name.trim()).filter((name) => {
      const key = normalized(name);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
}
function emptyRecord(id: string, name: string, source: AllergyRecord["source"] = "Unknown"): AllergyRecord {
  return { id, name, type: "Unconfirmed", reaction: "", severity: "Unknown", source, onset_date: "", notes: "", status: "Active" };
}
function legacyProfile(patient: Row): StoredPatientProfile {
  return {
    demographics_revision: 1,
    allergy: {
      revision: 1, status: "Not reviewed",
      records: namesOf(patient).map((name, index) => emptyRecord(`${String(patient.id).slice(0, 75)}-legacy-${index + 1}`, name)),
      reviewed_at: null, reviewed_by: null, reviewed_by_name: null,
    },
    history: [],
  };
}
function storedProfile(state: WorkflowState, patient: Row): StoredPatientProfile {
  return state.patient_profiles?.[patient.id] || legacyProfile(patient);
}
export function getPatientAllergyProfile(state: WorkflowState, patient: Row): AllergyProfile {
  return structuredClone(storedProfile(state, patient).allergy);
}
export function initializePatientProfile(state: WorkflowState, _ctx: WorkflowContext, patient: Row): StoredPatientProfile {
  state.patient_profiles ||= {};
  return state.patient_profiles[patient.id] ||= legacyProfile(patient);
}
function demographics(patient: Row): DemographicPatient {
  return {
    id: patient.id, created_at: patient.created_at || "",
    ...Object.fromEntries(patientDemographicKeys.map((key) => [key, patient[key] || ""])),
  } as DemographicPatient;
}
function view(profile: StoredPatientProfile, patient: Row, ctx: WorkflowContext): PatientProfileView {
  const clinical = ctx.user.role === "clinician";
  return structuredClone({
    patient: demographics(patient), demographics_revision: profile.demographics_revision,
    ...(clinical ? { allergy: profile.allergy } : {}),
    history: profile.history.filter((change) => clinical || change.section === "Demographics"),
  });
}
function history(ctx: WorkflowContext, section: ProfileChange["section"], reason: string,
  before: Record<string, unknown>, after: Record<string, unknown>): ProfileChange {
  return structuredClone({ id: ctx.id("profile-change"), section, reason,
    actor_id: ctx.user.id, actor_name: ctx.user.name, at: ctx.now, before, after });
}
function validateRecords(records: AllergyRecord[], today: string) {
  const ids = new Set<string>(), activeNames = new Set<string>();
  let active = 0;
  for (const record of records) {
    if (ids.has(record.id)) fail(409, "Each allergy record must have a unique identifier");
    ids.add(record.id);
    if (record.onset_date && (record.onset_date < "1900-01-01" || record.onset_date > today))
      fail(400, "Allergy onset must be between 1900 and today");
    if (record.status !== "Active") continue;
    active++;
    const key = normalized(record.name);
    if (activeNames.has(key)) fail(409, "This active allergy name is already recorded");
    activeNames.add(key);
  }
  if (active > 30) fail(400, "Record at most 30 active allergies or intolerances");
  return active;
}

export function patientProfileRequest(state: WorkflowState, ctx: WorkflowContext,
  method: string, url: URL, body: unknown): PatientProfileView {
  const [resource, id, command, extra] = url.pathname.split("/").filter(Boolean);
  if (resource !== "patient-profiles" || !id || extra) fail(404, "Patient profile route not found");
  if (command === "allergies" && ctx.user.role !== "clinician") fail(403, "Clinical access required");
  const patient = ctx.patients.find((row) => row.id === id) || fail(404, "Patient not found");
  if (method === "GET" && !command) {
    const profile = initializePatientProfile(state, ctx, patient);
    ctx.audit("Viewed patient profile", id);
    return view(profile, patient, ctx);
  }
  if (method !== "PATCH" || !["demographics", "allergies"].includes(command || ""))
    fail(405, "Use the patient demographics or allergy update action");
  const previous = storedProfile(state, patient);
  if (command === "demographics") {
    const { revision, reason, duplicate_acknowledged, ...changes } = demographicsPatch.parse(body);
    if (revision !== previous.demographics_revision) fail(409, "Patient details changed. Reload them before saving.");
    if (!Object.keys(changes).length) fail(400, "Choose patient details to update");
    const nextPatient = demographicFields.parse({ ...demographics(patient), ...changes });
    if (nextPatient.dob < "1900-01-01" || nextPatient.dob > ctx.today)
      fail(400, "Birth date must be between 1900 and today");
    const changedKeys = patientDemographicKeys.filter((key) => nextPatient[key] !== (patient[key] || ""));
    if (!changedKeys.length) return view(previous, patient, ctx);
    const identityChanged = ["first_name", "last_name", "dob"].some((key) =>
      normalized(nextPatient[key as "first_name" | "last_name" | "dob"]) !== normalized(patient[key] || ""));
    const matches = identityChanged ? matchingPatients(ctx.patients.filter((row) => row.id !== id), nextPatient) : [];
    if (matches.length && duplicate_acknowledged !== true)
      fail(409, "Another patient has the same name and birth date. Review the existing record and acknowledge that these are separate patients.");
    const before = Object.fromEntries(changedKeys.map((key) => [key, patient[key] || ""]));
    const after = Object.fromEntries(changedKeys.map((key) => [key, nextPatient[key]]));
    const updated: StoredPatientProfile = {
      ...previous, demographics_revision: previous.demographics_revision + 1,
      history: [...previous.history, history(ctx, "Demographics", reason, before, after)],
    };
    state.patient_profiles ||= {};
    state.patient_profiles[id] = updated;
    Object.assign(patient, nextPatient);
    ctx.audit("Updated patient demographics", id);
    if (matches.length) ctx.audit("Confirmed separate patient after demographic duplicate review", id);
    return view(updated, patient, ctx);
  }
  const input = allergiesPatch.parse(body);
  if (input.revision !== previous.allergy.revision) fail(409, "Allergy information changed. Reload it before saving.");
  const active = validateRecords(input.records, ctx.today);
  if (previous.allergy.records.some((record) => !input.records.some((next) => next.id === record.id)))
    fail(400, "Keep existing allergy records; mark them inactive or entered in error instead of removing history");
  if (input.status === "No known allergies" && active)
    fail(400, "No known allergies requires no active allergy or intolerance records");
  if (input.status === "No known allergies" && !input.reviewed)
    fail(400, "Explicitly review the record before confirming no known allergies");
  if (input.status === "Allergies recorded" && !active)
    fail(400, "Choose Not reviewed or No known allergies when no active records remain");
  if (input.reviewed && input.status === "Not reviewed")
    fail(400, "Resolve the allergy status before marking it reviewed");
  const allergy: AllergyProfile = {
    revision: previous.allergy.revision + 1, status: input.status,
    records: structuredClone(input.records),
    reviewed_at: input.reviewed ? ctx.now : null,
    reviewed_by: input.reviewed ? ctx.user.id : null,
    reviewed_by_name: input.reviewed ? ctx.user.name : null,
  };
  const updated: StoredPatientProfile = {
    ...previous, allergy,
    history: [...previous.history, history(ctx, "Allergies", input.reason, previous.allergy, allergy)],
  };
  state.patient_profiles ||= {};
  state.patient_profiles[id] = updated;
  patient.allergies = allergy.records.filter((record) => record.status === "Active").map((record) => record.name);
  ctx.audit(input.reviewed ? "Reviewed patient allergies" : "Updated patient allergy records", id);
  return view(updated, patient, ctx);
}

/** Intake never discards detailed reaction/severity history or silently confirms absence. */
export function reconcileIntakeAllergies(state: WorkflowState, ctx: WorkflowContext,
  patient: Row, names: string[], intakeId: string): void {
  const reported = z.array(z.string().trim().min(1).max(200)).max(30).parse(names);
  const unique = [...new Map(reported.map((name) => [normalized(name), name])).values()];
  const previous = storedProfile(state, patient);
  const beforeNames = previous.allergy.records.filter((record) => record.status === "Active").map((record) => normalized(record.name));
  const afterNames = unique.map(normalized);
  if (beforeNames.length === afterNames.length && beforeNames.every((name) => afterNames.includes(name))) {
    patient.allergies = previous.allergy.records.filter((record) => record.status === "Active").map((record) => record.name);
    return;
  }
  const reportedNames = new Set(afterNames);
  const records = structuredClone(previous.allergy.records).map((record) =>
    record.status === "Active" && !reportedNames.has(normalized(record.name))
      ? { ...record, status: "Inactive" as const } : record);
  for (const name of unique) {
    if (records.some((record) => record.status === "Active" && normalized(record.name) === normalized(name))) continue;
    // A previously inactive/error entry is not silently reactivated by a new patient report.
    records.push(emptyRecord(ctx.id("allergy"), name, "Patient reported"));
  }
  if (records.length > 200) fail(409, "Review the detailed allergy record before reconciling more intake entries");
  validateRecords(records, ctx.today);
  const allergy: AllergyProfile = {
    revision: previous.allergy.revision + 1, status: "Not reviewed", records,
    reviewed_at: null, reviewed_by: null, reviewed_by_name: null,
  };
  const updated: StoredPatientProfile = {
    ...previous, allergy,
    history: [...previous.history, history(ctx, "Allergies", `Patient-reported intake reconciliation (${intakeId})`, previous.allergy, allergy)],
  };
  state.patient_profiles ||= {};
  state.patient_profiles[patient.id] = updated;
  patient.allergies = records.filter((record) => record.status === "Active").map((record) => record.name);
  ctx.audit("Reconciled patient-reported allergies without discarding prior details", patient.id);
}
