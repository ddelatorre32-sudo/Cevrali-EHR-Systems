import type { AllergyRecord } from "./patient-profile-model.js";

export type ControlledSchedule = "Non-controlled" | "II" | "III" | "IV" | "V";
export type PrescriptionFields = {
  medication_name: string; strength: string; dose: string; route: string;
  frequency: string; instructions: string; quantity: number; quantity_unit: string;
  days_supply: number; refills: number;
  pharmacy: { name: string; address: string; phone: string };
  controlled_schedule: ControlledSchedule;
};
export type PrescriptionAccount = {
  id: string; revision: number; name: string; kind: string;
  claim_number: string;
};
export type PrescriptionReview = {
  reviewed_at: string; reviewed_by: string; context_fingerprint: string;
  allergies_reviewed: true; medications_reviewed: true; classification_confirmed: true;
  pdmp_reviewed: boolean; safety_note: string;
};
export type PrescriptionHistory = {
  id: string; action: string; at: string; actor_id: string; actor_name: string;
  revision: number; detail: string;
};
export type PrescriptionSnapshot = {
  fields: PrescriptionFields;
  patient: { id: string; first_name: string; last_name: string; dob: string };
  encounter_id: string | null; billing_account: PrescriptionAccount;
  prescriber: { id: string; name: string };
  reviewed_at: string; safety_note: string;
  demo_authorized_at: string;
  authentication: "Demo review confirmation" | "Demo password and displayed code";
  pharmacy_transmitted: false;
};
export type Prescription = PrescriptionFields & {
  id: string; patient_id: string; encounter_id: string | null; billing_account: PrescriptionAccount;
  author_id: string; created_at: string; updated_at: string; revision: number;
  status: "Draft" | "Ready for demo signing" | "Simulated — not sent" | "Cancelled locally";
  review?: PrescriptionReview; snapshot?: PrescriptionSnapshot;
  cancellation_reason?: string; cancelled_at?: string;
  refill_request_id?: string;
  history: PrescriptionHistory[];
  requests: { action: string; client_id: string; fingerprint: string }[];
};
export type PrescriptionView = Omit<Prescription, "requests"> & {
  patient_name: string; author_name: string; can_edit: boolean; can_review: boolean;
  can_sign: boolean; review_current: boolean; pharmacy_transmitted: false;
};
export type DemoPrescriber = {
  user_id: string; can_prescribe_demo: boolean; can_prescribe_controlled_demo: boolean;
};
export type PrescribingSettingsView = {
  revision: number; mode: "Demo only"; pharmacy_connected: false; epcs_connected: false;
  prescribers: (DemoPrescriber & { name: string; is_active: boolean })[];
};
export type RefillRequest = {
  id: string; patient_id: string; medication_name: string; notes: string;
  requested_by: string; requested_by_name: string; created_at: string; revision: number;
  status: "Requested" | "Reviewed" | "Declined";
  resolution_note?: string; resolved_at?: string; resolved_by?: string;
  prescription_id?: string;
  client_id: string; initial_fingerprint: string;
};
export type RefillRequestView = Omit<RefillRequest, "client_id" | "initial_fingerprint" | "resolution_note" | "prescription_id"> & {
  patient_name: string; resolution_note?: string; prescription_id?: string;
};
export type PrescribingChallenge = {
  id: string; prescription_id: string; revision: number; user_id: string; session_id: string;
  context_fingerprint: string; code_hash: string; created_at: string; expires_at: string;
  failed_attempts: number; consumed_at?: string;
};
export type PrescribingState = {
  prescriptions: Prescription[]; refills: RefillRequest[];
  settings: { revision: number; prescribers: DemoPrescriber[] };
  challenges: PrescribingChallenge[];
  auth_failures: { user_id: string; session_id: string; at: string }[];
  auth_locks: { user_id: string; locked_until: string }[];
  preferred_pharmacies: Record<string, { revision: number; pharmacy: PrescriptionFields["pharmacy"] }>;
};
export type PrescribingWorkspace = {
  patient: { id: string; first_name: string; last_name: string; dob: string;
    allergies: string[]; allergy_status: string;
    active_allergy_records: AllergyRecord[];
    medications: { name: string; dose: string; frequency: string }[] };
  encounter_id: string | null;
  billing_accounts: PrescriptionAccount[];
  selected_billing_account_id: string;
  prescriptions: PrescriptionView[];
  access: DemoPrescriber;
  mode: "Demo only"; pharmacy_connected: false; epcs_connected: false;
  interaction_checks_available: false;
  preferred_pharmacy: { revision: number; pharmacy: PrescriptionFields["pharmacy"] } | null;
};
export type PrescribingChallengeView = {
  challenge_id: string; demo_code: string; expires_at: string; revision: number;
};
export type PrescribingReviewContext = {
  prescription: PrescriptionView;
  workspace: PrescribingWorkspace;
  context_fingerprint: string | null;
};
export type PrescriptionSignResult = { ok: true; prescription: PrescriptionView } |
  { ok: false; error: string; attempts_remaining: number };
