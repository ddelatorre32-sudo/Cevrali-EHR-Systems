import { z } from 'zod';

const name = z.string().trim().min(1).max(160);
export const accountEmail = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
export const accountPassword = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(200);
export const practiceFields = z.object({
  name,
  legal_name: z.string().trim().max(200).default(''),
  specialty: z.string().trim().max(100).default('Primary care'),
  phone: z.string().trim().max(40).default(''),
  email: z.union([accountEmail, z.literal('')]).default(''),
  address: z.string().trim().max(500).default(''),
  fax_provider_name: z.string().trim().max(100).default('Demo fax'),
  fax_from_number: z
    .union([
      z.literal(''),
      z
        .string()
        .regex(
          /^\+[1-9]\d{7,14}$/,
          'Use a fax number with country code, e.g. +14155550123',
        ),
    ])
    .default(''),
  npi: z
    .union([
      z.literal(''),
      z.string().regex(/^\d{10}$/, 'Enter a 10-digit NPI'),
    ])
    .default(''),
});
export const signupInput = z.object({
  owner_name: name,
  email: accountEmail,
  password: accountPassword,
  clinical_access: z.boolean().default(false),
  practice: practiceFields,
});
export const inviteInput = z.object({
  email: accountEmail,
  role: z.enum(['clinician', 'receptionist']),
  is_admin: z.boolean().default(false),
});
export const joinInput = z.object({ name, password: accountPassword });
export type Practice = z.infer<typeof practiceFields> & {
  id: string;
  owner_id: string;
  created_at: string;
  setup_completed_at: string | null;
  is_demo: boolean;
  revision: number;
  time_zone: 'America/Los_Angeles';
};
export type AccountMember = {
  id: string;
  name: string;
  email: string;
  role: 'clinician' | 'receptionist';
  is_admin: boolean;
  is_active: boolean;
};
export type StaffInvitation = {
  id: string;
  email: string;
  role: 'clinician' | 'receptionist';
  is_admin: boolean;
  status: 'Pending' | 'Accepted' | 'Revoked' | 'Expired';
  created_at: string;
  expires_at: string;
};
export type AccountView = {
  practice: Practice;
  members: AccountMember[];
  invitations: StaffInvitation[];
  is_admin: boolean;
  patient_count: number;
};
export function profileComplete(p: Practice) {
  return Boolean(p.name && p.email && p.phone && p.address);
}
export function accountError(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
