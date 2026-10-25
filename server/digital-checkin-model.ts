export type CheckInContact = {
  phone: string; email: string; address: string; address_unit: string;
  city: string; state: string; zip_code: string;
};
export type ConsentForm = {
  id: string; title: string; text: string; version: number; revision: number;
  archived: boolean; created_at: string; updated_at: string;
  client_id?: string; created_by?: string;
};
export type CheckInConsent = {
  id: string; form_id: string; title: string; text: string; version: number;
  sha256: string;
  signature?: {
    signer_name: string; signer_role: "Patient" | "Representative";
    relationship: string; signed_at: string; client_id: string;
  };
};
export type CheckInFile = {
  id: string; side: "Front" | "Back"; name: string;
  mime_type: "image/png" | "image/jpeg"; size: number; sha256: string;
  uploaded_at: string; superseded_at?: string;
};
export type CheckInBillingAccount = { id: string; name: string; kind: string };
export type CheckInPacket = {
  id: string; patient_id: string; appointment_id: string;
  status: "Requested" | "Submitted" | "Reviewed";
  revision: number; created_at: string;
  practice_name?: string;
  billing_account: CheckInBillingAccount;
  contact: CheckInContact | null;
  files: (CheckInFile & { data_base64: string; client_id: string })[];
  consents: CheckInConsent[];
  no_card_reason: string;
  submitted_at?: string;
  reviewed_at?: string; reviewed_by?: string; reviewed_by_name?: string;
  review_reason?: string; demographics_applied?: boolean;
  account_mismatch_acknowledged?: boolean;
  reviewed_billing_account?: CheckInBillingAccount;
  requests: { action: string; client_id: string; fingerprint: string }[];
};
export type DigitalCheckInState = { forms: ConsentForm[]; packets: CheckInPacket[] };
export type CheckInListItem = {
  id: string; patient_id: string; appointment_id: string;
  patient_name: string; status: CheckInPacket["status"];
  created_at: string; submitted_at?: string; reviewed_at?: string;
  appointment: { date: string; time: string; status: string };
  intake_status: string; link_expired: boolean;
  billing_account: CheckInBillingAccount;
  account_mismatch: boolean; card_count: number;
  signed_consent_count: number; consent_count: number;
};
export type CheckInPacketView = CheckInListItem & {
  revision: number; practice_name: string;
  contact: CheckInContact | null;
  files: CheckInFile[]; consents: CheckInConsent[]; no_card_reason: string;
  expires_at: string;
  reviewed_by_name?: string; review_reason?: string; demographics_applied?: boolean;
  current_contact?: CheckInContact;
  demographics_revision?: number;
  current_billing_account?: CheckInBillingAccount;
};
