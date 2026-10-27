export type SecurityUser = {
  id: string;
  name: string;
  email: string;
  role: "clinician" | "receptionist";
  is_admin: number | boolean;
  is_active: number | boolean;
};

export type AuthenticationPending = {
  kind: "mfa";
  email: string;
  challenge_token: string;
  expires_at: string;
  enrollment_required: boolean;
};

export type AuthenticationStart = { kind: "authenticated"; user: SecurityUser } | AuthenticationPending;
export type SecurityFailure = { ok: false; error: string; attempts_remaining: number };
export type AuthenticationComplete = {
  ok: true;
  user: SecurityUser;
  recovery_codes?: string[];
  sessions_revoked?: true;
} | SecurityFailure;

export type AuthenticatorSetup = {
  secret: string;
  otpauth_uri: string;
  expires_at: string;
};

export type EnrollmentSetup = AuthenticatorSetup & { enrollment_id: string };
export type AccessSecurityStatus = {
  available: boolean;
  required: boolean;
  mfa_enabled: boolean;
  recovery_codes_remaining: number;
};
