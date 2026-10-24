export type User = {
  id: string;
  name: string;
  email: string;
  role: 'clinician' | 'receptionist';
  is_admin?: boolean;
  practice?: {
    id: string;
    name: string;
    is_demo: boolean;
    setup_completed_at: string | null;
  };
};
export type Patient = {
  id: string;
  first_name: string;
  last_name: string;
  dob: string;
  sex: string;
  phone: string;
  email: string;
  address: string;
  address_unit?: string;
  city?: string;
  state?: string;
  zip_code?: string;
  created_at: string;
  allergies?: string[];
  allergy_profile?: import('../server/patient-profile-model').AllergyProfile;
  conditions?: string[];
  medications?: { name: string; dose: string; frequency: string }[];
  encounters?: Encounter[];
  labs?: Lab[];
};
export type Appointment = {
  billing_account_claim_number?: string;
  billing_account_payer?: string;
  billing_account_id?: string;
  billing_account_name?: string;
  provider_id?: string;
  id: string;
  patient_id: string;
  first_name: string;
  last_name: string;
  dob: string;
  sex: string;
  date: string;
  time: string;
  duration: number;
  type: string;
  reason: string;
  status: string;
  provider: string;
};
export type Encounter = {
  received_results?: import('../server/note-results').NoteResult[];
  billing_account_id?: string;
  billing_account_snapshot?:
    import('../server/patient-accounts').PatientBillingAccount | null;
  wc_documentation?:
    import('../server/patient-accounts').WcDocumentation | null;
  id: string;
  patient_id: string;
  appointment_id: string | null;
  first_name?: string;
  last_name?: string;
  chief_complaint: string;
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
  bp: string;
  pulse: string;
  temperature: string;
  status: string;
  created_at: string;
  updated_at: string;
  signed_at: string | null;
  author: string;
};
export type Task = {
  id: string;
  patient_id: string;
  first_name: string;
  last_name: string;
  title: string;
  category: string;
  priority: string;
  done: number;
};
export type Lab = {
  id: string;
  patient_id: string;
  first_name?: string;
  last_name?: string;
  name: string;
  value: string;
  unit: string;
  reference_range: string;
  flag: string;
  date: string;
};
export type Overview = {
  today: string;
  patients: number;
  appointments: number;
  completed: number;
  waiting: number;
  drafts: number | null;
};
export type Audit = {
  id: number;
  actor: string;
  action: string;
  resource: string;
  created_at: string;
};
