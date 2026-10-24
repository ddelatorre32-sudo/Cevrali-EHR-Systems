import { z } from "zod";
import { patientAddressFields } from "./patient-demographics.js";

const short = z.string().trim().min(1).max(100);
export const profileCalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T12:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Enter a valid calendar date");

export const demographicFields = z.object({
  first_name: short,
  last_name: short,
  dob: profileCalendarDate,
  sex: z.enum(["Female", "Male", "Other", "Unknown"]),
  phone: z.string().trim().min(1).max(40),
  email: z.union([z.string().trim().email().max(254), z.literal("")]),
  ...patientAddressFields.shape,
});
export const demographicsPatch = demographicFields.partial().extend({
  revision: z.number().int().min(1),
  reason: z.string().trim().min(1).max(500),
  duplicate_acknowledged: z.boolean().optional(),
}).strict();

export const allergyRecordSchema = z.object({
  id: short,
  name: z.string().trim().min(1).max(200),
  type: z.enum(["Allergy", "Intolerance", "Unconfirmed"]),
  reaction: z.string().trim().max(500),
  severity: z.enum(["Unknown", "Mild", "Moderate", "Severe", "Life-threatening"]),
  source: z.enum(["Patient reported", "Caregiver reported", "Outside record", "Clinician documented", "Unknown"]),
  onset_date: z.union([z.literal(""), profileCalendarDate]),
  notes: z.string().trim().max(1000),
  status: z.enum(["Active", "Inactive", "Entered in error"]),
}).strict();
export type AllergyRecord = z.infer<typeof allergyRecordSchema>;
export const allergyStatusSchema = z.enum(["Not reviewed", "No known allergies", "Allergies recorded"]);
export const allergiesPatch = z.object({
  revision: z.number().int().min(1),
  reason: z.string().trim().min(1).max(500),
  status: allergyStatusSchema,
  records: z.array(allergyRecordSchema).max(200),
  reviewed: z.boolean(),
}).strict();

export type AllergyProfile = {
  revision: number;
  status: z.infer<typeof allergyStatusSchema>;
  records: AllergyRecord[];
  reviewed_at: string | null;
  reviewed_by: string | null;
  reviewed_by_name?: string | null;
};
export type ProfileChange = {
  id: string;
  section: "Demographics" | "Allergies";
  actor_id: string;
  actor_name: string;
  at: string;
  reason: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};
export type DemographicPatient = z.infer<typeof demographicFields> & { id: string; created_at: string };
export type PatientProfileView = {
  patient: DemographicPatient;
  demographics_revision: number;
  allergy?: AllergyProfile;
  history: ProfileChange[];
};
export type StoredPatientProfile = {
  demographics_revision: number;
  allergy: AllergyProfile;
  history: ProfileChange[];
};
export type PatientProfilesState = Record<string, StoredPatientProfile>;
export const patientDemographicKeys = [
  "first_name", "last_name", "dob", "sex", "phone", "email", "address",
  "address_unit", "city", "state", "zip_code",
] as const;
