import { z } from "zod";
import type { WorkflowContext } from "./workflow-engine.js";
import {
  createRfaDraft,
  rfaRequest,
  faxRequest,
  type RfaPacket,
  type FaxJob,
} from "./rfa-engine.js";
import {
  ensurePatientAccounts,
  patientAccount,
  patientAccountsRequest,
  readJson,
  type PatientBillingAccount,
} from "./patient-accounts.js";

export type Policy = {
  billing_account_id?: string;
  id: string;
  patient_id: string;
  payer: string;
  plan: string;
  member_id: string;
  group_number: string;
  priority: "Primary" | "Secondary";
  subscriber_name: string;
  subscriber_dob: string;
  relationship: "Self" | "Spouse" | "Child" | "Other";
  effective_date: string;
  end_date: string;
  revision: number;
  updated_at: string;
};
export type Verification = {
  id: string;
  policy_id: string;
  policy_revision: number;
  service_date: string;
  status: "Active" | "Inactive" | "Needs review";
  source: "Demo payer" | "Demo workers compensation review";
  copay_cents: number | null;
  deductible_remaining_cents: number | null;
  coinsurance_percent: number | null;
  reference: string;
  checked_at: string;
  checked_by: string;
};
export type ChargeLine = {
  code: string;
  description: string;
  diagnosis: string;
  units: number;
  unit_cents: number;
};
export type Bill = {
  billing_account_id?: string;
  id: string;
  patient_id: string;
  encounter_id: string;
  service_date: string;
  mode: "Insurance" | "Self-pay";
  policy_id: string;
  lines: ChargeLine[];
  revision: number;
  created_at: string;
  finalized_at: string | null;
  authorization_required?: boolean;
  authorization_id?: string;
  voided_at?: string;
};
export type Claim = {
  billing_account?: PatientBillingAccount;
  id: string;
  bill_id: string;
  status:
    | "Prepared"
    | "Demo submitted"
    | "Demo denied"
    | "Demo adjudicated"
    | "Demo replaced"
    | "Demo voided"
    | "Superseded draft";
  kind?: "Original" | "Replacement";
  replaces_claim_id?: string;
  authorization?: PriorAuthorization | null;
  policy: Policy;
  verification: Verification;
  lines: ChargeLine[];
  total_cents: number;
  created_at: string;
  submitted_at: string | null;
  attempts: number;
  denial_reason: string;
  correction_note: string;
  previous_coverage: {
    policy: Policy;
    verification: Verification;
    replaced_at: string;
  }[];
};
export type LedgerEntry = {
  id: string;
  bill_id: string;
  type:
    | "Insurer payment"
    | "Contractual adjustment"
    | "Patient payment"
    | "Payment reversal"
    | "Insurer payment reversal"
    | "Adjustment reversal";
  amount_cents: number;
  reference: string;
  note: string;
  created_at: string;
  actor: string;
  reverses_id?: string;
};
export type Remittance = {
  id: string;
  claim_id: string;
  reference: string;
  outcome: "Approved" | "Denied";
  payer_paid_cents: number;
  adjustment_cents: number;
  patient_responsibility_cents: number;
  denial_reason: string;
  created_at: string;
  attempt: number;
};
export type FinanceState = {
  rfa_packets: RfaPacket[];
  fax_jobs: FaxJob[];
  billing_accounts: PatientBillingAccount[];
  policies: Policy[];
  verifications: Verification[];
  bills: Bill[];
  claims: Claim[];
  ledger: LedgerEntry[];
  remittances: Remittance[];
  authorizations: PriorAuthorization[];
  corrections: ClaimCorrection[];
};
export type PriorAuthorization = {
  encounter_id?: string;
  id: string;
  patient_id: string;
  policy_id: string;
  policy_revision: number;
  procedure_codes: string[];
  description: string;
  requested_visits: number;
  valid_from: string;
  valid_to: string;
  due_date: string;
  owner_id: string;
  revision: number;
  status:
    "Draft" | "Demo submitted" | "Demo approved" | "Demo denied" | "Cancelled";
  approval_number: string;
  approved_visits: number;
  decision_note: string;
  created_at: string;
  updated_at: string;
  history: { action: string; note: string; actor: string; at: string }[];
};
export type ClaimCorrection = {
  id: string;
  bill_id: string;
  claim_id: string;
  kind: "Draft revision" | "Replacement" | "Void";
  status:
    | "Draft"
    | "Demo submitted"
    | "Applied"
    | "Demo accepted"
    | "Demo rejected"
    | "Cancelled";
  reason: string;
  lines: ChargeLine[];
  policy_id: string;
  authorization_required: boolean;
  authorization_id: string;
  original_bill: Bill;
  original_claim: Claim;
  created_at: string;
  actor: string;
  response_note: string;
  response_reference: string;
  result_claim_id?: string;
  history: { action: string; note: string; actor: string; at: string }[];
};
export const emptyFinanceState = (): FinanceState => ({
  rfa_packets: [],
  fax_jobs: [],
  billing_accounts: [],
  policies: [],
  verifications: [],
  bills: [],
  claims: [],
  ledger: [],
  remittances: [],
  authorizations: [],
  corrections: [],
});
export function readFinanceState(saved?: Partial<FinanceState>): FinanceState {
  return { ...emptyFinanceState(), ...saved };
}
export function captureRegistrationInsurance(
  state: FinanceState,
  ctx: WorkflowContext,
  patientId: string,
  value: unknown,
) {
  const input = z
    .object({
      policy: z.record(z.unknown()),
      verification: z
        .object({
          service_date: z.string(),
          scenario: z.enum(["Active", "Inactive", "Needs review"]),
        })
        .optional(),
    })
    .parse(value);
  const policy = financeRequest(
    state,
    ctx,
    "POST",
    new URL("https://finance.invalid/finance/policies"),
    { ...input.policy, patient_id: patientId },
  ) as Policy;
  if (input.verification)
    financeRequest(
      state,
      ctx,
      "POST",
      new URL(`https://finance.invalid/finance/policies/${policy.id}/verify`),
      input.verification,
    );
}
function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
const text = z.string().trim().min(1).max(200);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const parsed = new Date(`${v}T12:00:00Z`);
    return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
  }, "Enter a valid calendar date");
const cents = z.number().int().min(0).max(100_000_000);
const policyInput = z
  .object({
    patient_id: text,
    billing_account_id: text.optional(),
    payer: text,
    plan: text,
    member_id: z.string().trim().min(2).max(80),
    group_number: z.string().trim().max(80).default(""),
    priority: z.enum(["Primary", "Secondary"]),
    subscriber_name: text,
    subscriber_dob: date,
    relationship: z.enum(["Self", "Spouse", "Child", "Other"]),
    effective_date: date,
    end_date: z.union([date, z.literal("")]).default(""),
  })
  .refine(
    (p) => !p.end_date || p.end_date >= p.effective_date,
    "Coverage end must follow its effective date",
  );
const charge = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^(\d{5}|[A-Z]\d{4})$/, "Enter a five-character CPT or HCPCS code"),
  description: text,
  diagnosis: z
    .string()
    .trim()
    .toUpperCase()
    .regex(
      /^[A-Z][0-9][A-Z0-9](\.[A-Z0-9]{1,4})?$/,
      "Enter an ICD-10-CM diagnosis code",
    ),
  units: z.number().int().min(1).max(100),
  unit_cents: cents.refine((v) => v > 0, "Charge must be greater than zero"),
});
export const chargeTotal = (lines: ChargeLine[]) =>
  lines.reduce((sum, l) => sum + l.units * l.unit_cents, 0);
function patient(ctx: WorkflowContext, id: string) {
  return (
    ctx.patients.find((p) => p.id === id) || fail(404, "Patient not found")
  );
}
function find<T extends { id: string }>(
  rows: T[],
  id: string | undefined,
  name: string,
): T {
  return rows.find((r) => r.id === id) || fail(404, `${name} not found`);
}
function visitDate(ctx: WorkflowContext, e: Record<string, any>) {
  // SQLite datetime('now') is UTC without an offset. Normalize it before parsing
  // so the offline preview produces the same service date in every browser zone.
  const createdAt = /^\d{4}-\d{2}-\d{2} \d{2}:/.test(e.created_at)
    ? `${e.created_at.replace(" ", "T")}Z`
    : e.created_at;
  return (
    ctx.appointments.find((a) => a.id === e.appointment_id)?.date ||
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
    }).format(new Date(createdAt))
  );
}
function signed(ctx: WorkflowContext, bill: Bill) {
  const e = find(
    ctx.encounters as { id: string; status: string }[],
    bill.encounter_id,
    "Encounter",
  );
  if (e.status !== "Signed")
    fail(
      409,
      "Sign the encounter before finalizing billing or preparing a claim",
    );
  if (!bill.lines.length) fail(409, "Add at least one reviewed charge line");
  if (bill.service_date > ctx.today)
    fail(409, "A future visit cannot be finalized for billing");
}
const currentClaim = (state: FinanceState, billId: string) =>
  [...state.claims].reverse().find((c) => c.bill_id === billId);
const pendingCorrection = (state: FinanceState, billId: string) =>
  state.corrections.find(
    (c) =>
      c.bill_id === billId && ["Draft", "Demo submitted"].includes(c.status),
  );
function noPendingCorrection(state: FinanceState, billId: string) {
  if (pendingCorrection(state, billId))
    fail(
      409,
      "A claim correction is in progress. Complete or cancel it before changing this billing record.",
    );
}
function reservedVisits(
  state: FinanceState,
  authorizationId: string,
  excludingBill = "",
) {
  return new Set(
    state.claims
      .filter(
        (c) =>
          c.authorization?.id === authorizationId &&
          c.bill_id !== excludingBill &&
          !["Demo replaced", "Demo voided", "Superseded draft"].includes(
            c.status,
          ),
      )
      .map((c) => c.bill_id),
  ).size;
}
function authorizationForBill(
  state: FinanceState,
  ctx: WorkflowContext,
  bill: Bill,
  policy: Policy,
) {
  if (!bill.authorization_required) return null;
  const a = find(
    state.authorizations,
    bill.authorization_id,
    "Prior authorization",
  );
  if (a.patient_id !== bill.patient_id || a.policy_id !== policy.id)
    fail(409, "Authorization does not match this patient and policy");
  if (a.policy_revision !== policy.revision)
    fail(
      409,
      "Authorization uses an older policy version; obtain a new demo authorization",
    );
  if (a.status !== "Demo approved")
    fail(409, "An approved demo authorization is required");
  if (bill.service_date < a.valid_from || bill.service_date > a.valid_to)
    fail(409, "Service date is outside the authorization approval period");
  if (!bill.lines.every((l) => a.procedure_codes.includes(l.code)))
    fail(
      409,
      "Authorization does not cover every procedure on the charge sheet",
    );
  if (reservedVisits(state, a.id, bill.id) >= a.approved_visits)
    fail(409, "Authorization has no approved visits remaining");
  return structuredClone(a);
}
export function billTotals(state: FinanceState, bill: Bill) {
  const entries = state.ledger.filter((e) => e.bill_id === bill.id);
  const paid = entries.reduce(
    (sum, e) =>
      sum +
      (["Contractual adjustment", "Adjustment reversal"].includes(e.type)
        ? 0
        : ["Payment reversal", "Insurer payment reversal"].includes(e.type)
          ? -e.amount_cents
          : e.amount_cents),
    0,
  );
  const adjustments = entries
    .filter((e) =>
      ["Contractual adjustment", "Adjustment reversal"].includes(e.type),
    )
    .reduce(
      (sum, e) =>
        sum +
        (e.type === "Adjustment reversal" ? -e.amount_cents : e.amount_cents),
      0,
    );
  const total = bill.voided_at ? 0 : chargeTotal(bill.lines);
  const claim = currentClaim(state, bill.id);
  const remit =
    claim &&
    !bill.voided_at &&
    state.remittances.find(
      (r) => r.claim_id === claim.id && r.outcome === "Approved",
    );
  const allocated = Boolean(
    remit || bill.voided_at || (bill.mode === "Self-pay" && bill.finalized_at),
  );
  const patientPaid = entries.reduce(
    (sum, e) =>
      sum +
      (e.type === "Patient payment"
        ? e.amount_cents
        : e.type === "Payment reversal"
          ? -e.amount_cents
          : 0),
    0,
  );
  const patientDue = allocated
    ? Math.max(
        0,
        (remit ? remit.patient_responsibility_cents : total) - patientPaid,
      )
    : null;
  return {
    charges_cents: total,
    paid_cents: paid,
    adjustment_cents: adjustments,
    balance_cents: Math.max(0, total - paid - adjustments),
    credit_cents: Math.max(0, paid + adjustments - total),
    patient_credit_cents: allocated
      ? Math.max(
          0,
          patientPaid - (remit ? remit.patient_responsibility_cents : total),
        )
      : 0,
    unapplied_patient_cents: allocated ? 0 : patientPaid,
    patient_balance_cents: patientDue,
    unallocated_cents: allocated ? 0 : Math.max(0, total - paid - adjustments),
  };
}
function enrichBill(state: FinanceState, ctx: WorkflowContext, bill: Bill) {
  const p = patient(ctx, bill.patient_id);
  const claim = currentClaim(state, bill.id);
  return {
    ...bill,
    billing_account: patientAccount(
      state,
      bill.patient_id,
      bill.billing_account_id,
    ),
    first_name: p.first_name,
    last_name: p.last_name,
    ...billTotals(state, bill),
    claim: claim || null,
    status: bill.voided_at
      ? "Demo voided"
      : claim?.status || (bill.finalized_at ? "Self-pay finalized" : "Draft"),
    age_days: Math.max(
      0,
      Math.floor(
        (Date.parse(`${ctx.today}T12:00:00Z`) -
          Date.parse(`${bill.service_date}T12:00:00Z`)) /
          86400000,
      ),
    ),
    ledger: state.ledger.filter((l) => l.bill_id === bill.id),
    remittances: state.remittances.filter((r) =>
      state.claims.some((c) => c.bill_id === bill.id && c.id === r.claim_id),
    ),
    claim_history: state.claims.filter((c) => c.bill_id === bill.id),
    corrections: state.corrections.filter((c) => c.bill_id === bill.id),
  };
}
export type BillView = ReturnType<typeof enrichBill>;
function activeVerification(
  state: FinanceState,
  ctx: WorkflowContext,
  policy: Policy,
  serviceDate: string,
) {
  const v = [...state.verifications]
    .reverse()
    .find(
      (v) =>
        v.policy_id === policy.id &&
        v.policy_revision === policy.revision &&
        v.service_date === serviceDate,
    );
  if (!v || v.status !== "Active")
    fail(
      409,
      "Run an active demo coverage check for this policy and service date before preparing a claim",
    );
  if (Date.parse(ctx.now) - Date.parse(v.checked_at) > 7 * 86400000)
    fail(409, "Coverage check is older than seven days; verify again");
  if (
    serviceDate < policy.effective_date ||
    (policy.end_date && serviceDate > policy.end_date)
  )
    fail(409, "Service date falls outside the coverage period");
  return v;
}

const authInput = z
  .object({
    encounter_id: z.string().optional(),
    patient_id: text,
    policy_id: text,
    procedure_codes: z
      .array(
        z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^(\d{5}|[A-Z]\d{4})$/),
      )
      .max(30),
    description: text,
    requested_visits: z.number().int().min(1).max(1000),
    valid_from: date,
    valid_to: date,
    due_date: date,
    owner_id: text.optional(),
  })
  .refine(
    (v) => v.valid_to >= v.valid_from,
    "Authorization end must follow its start date",
  );
function authHistory(
  a: PriorAuthorization,
  ctx: WorkflowContext,
  action: string,
  note: string,
) {
  a.history.push({ action, note, actor: ctx.user.name, at: ctx.now });
  a.updated_at = ctx.now;
  a.revision++;
}
function authorizationRequest(
  state: FinanceState,
  ctx: WorkflowContext,
  method: string,
  url: URL,
  body: unknown,
  id?: string,
  action?: string,
) {
  if (method === "GET" && !id) {
    ctx.audit("Viewed prior authorization worklist", "authorizations");
    return state.authorizations
      .filter(
        (a) =>
          !url.searchParams.get("patient_id") ||
          a.patient_id === url.searchParams.get("patient_id"),
      )
      .map((a) => {
        const p = patient(ctx, a.patient_id);
        const policy = find(state.policies, a.policy_id, "Policy");
        const used = reservedVisits(state, a.id);
        const days = Math.floor(
          (Date.parse(`${a.valid_to}T12:00:00Z`) -
            Date.parse(`${ctx.today}T12:00:00Z`)) /
            86400000,
        );
        return {
          ...a,
          first_name: p.first_name,
          last_name: p.last_name,
          payer: policy.payer,
          owner_name:
            ctx.users.find((u) => u.id === a.owner_id)?.name || "Unassigned",
          used_visits: used,
          remaining_visits: Math.max(0, a.approved_visits - used),
          expired: days < 0,
          expiring: days >= 0 && days <= 14,
          followup_due:
            ["Draft", "Demo submitted"].includes(a.status) &&
            a.due_date <= ctx.today,
          policy_changed: policy.revision !== a.policy_revision,
        };
      });
  }
  if ((method === "POST" && !id) || (method === "PATCH" && id && !action)) {
    const input = authInput.parse(body);
    patient(ctx, input.patient_id);
    const policy = find(state.policies, input.policy_id, "Policy");
    if (policy.patient_id !== input.patient_id)
      fail(400, "Insurance policy belongs to another patient");
    if (
      !input.procedure_codes.length &&
      !(
        input.encounter_id &&
        patientAccount(state, input.patient_id, policy.billing_account_id)
          .kind === "Workers compensation"
      )
    )
      fail(
        400,
        "Enter procedure codes, or link a workers compensation encounter for an RFA with unknown CPT/HCPCS codes",
      );
    if (input.encounter_id) {
      const e = ctx.encounters.find((e) => e.id === input.encounter_id);
      if (
        !e ||
        e.patient_id !== input.patient_id ||
        e.billing_account_id !== policy.billing_account_id
      )
        fail(
          400,
          "Supporting encounter must use the authorization’s patient and workers compensation account",
        );
      if (
        patientAccount(state, input.patient_id, policy.billing_account_id)
          .kind !== "Workers compensation"
      )
        fail(
          400,
          "RFA source encounters are for workers compensation authorizations",
        );
    }
    const previous = id
      ? find(state.authorizations, id, "Authorization")
      : undefined;
    if (
      previous &&
      (previous.status !== "Draft" || previous.patient_id !== input.patient_id)
    )
      fail(409, "Only draft authorizations for this patient can be edited");
    if (
      previous &&
      z.object({ revision: z.number().int() }).parse(body).revision !==
        previous.revision
    )
      fail(409, "Authorization changed; reload before saving");
    const owner = input.owner_id || previous?.owner_id || ctx.user.id;
    if (
      !ctx.users.some(
        (u) => u.id === owner && u.is_active !== 0 && u.is_active !== false,
      )
    )
      fail(400, "Select a valid staff owner");
    const a: PriorAuthorization = {
      ...input,
      encounter_id: input.encounter_id || undefined,
      procedure_codes: [...new Set(input.procedure_codes)],
      id: previous?.id || ctx.id("authz"),
      owner_id: owner,
      policy_revision: policy.revision,
      status: "Draft",
      approval_number: "",
      approved_visits: 0,
      decision_note: "",
      created_at: previous?.created_at || ctx.now,
      updated_at: ctx.now,
      revision: previous?.revision || 0,
      history: previous?.history || [],
    };
    authHistory(
      a,
      ctx,
      previous ? "Draft updated" : "Created",
      "No request has been transmitted.",
    );
    if (previous) Object.assign(previous, a);
    else state.authorizations.push(a);
    if (
      a.encounter_id &&
      ctx.encounters.find((e) => e.id === a.encounter_id)?.status === "Signed"
    )
      createRfaDraft(state, ctx, a);
    ctx.audit(
      previous ? "Updated authorization draft" : "Created authorization draft",
      a.id,
    );
    return a;
  }
  const a = find(state.authorizations, id, "Authorization");
  if (method === "POST" && action === "submit") {
    if (a.status !== "Draft")
      fail(409, "Only draft authorizations can be submitted");
    if (a.encounter_id)
      fail(
        409,
        "Use the reviewed RFA and demo fax outbox for this linked workers compensation request",
      );
    const policy = find(state.policies, a.policy_id, "Policy");
    if (policy.revision !== a.policy_revision)
      fail(
        409,
        "Policy changed; edit and review the authorization draft before submission",
      );
    a.status = "Demo submitted";
    authHistory(a, ctx, "Demo submitted", "No request was transmitted.");
    ctx.audit("Simulated prior authorization submission", a.id);
    return a;
  }
  if (method === "POST" && action === "decision") {
    if (a.status !== "Demo submitted")
      fail(409, "Submit the demo authorization before recording a decision");
    const input = z
      .object({
        outcome: z.enum(["Approved", "Denied"]),
        note: z.string().trim().min(5).max(1000),
        approval_number: z.string().trim().max(100),
        approved_visits: z.number().int().min(0).max(1000),
        valid_from: date,
        valid_to: date,
      })
      .parse(body);
    if (input.valid_to < input.valid_from)
      fail(400, "Approval end must follow its start date");
    if (input.outcome === "Approved") {
      if (
        !input.approval_number ||
        input.approved_visits < 1 ||
        input.approved_visits > a.requested_visits
      )
        fail(
          400,
          "Record an approval number and a visit allowance within the requested limit",
        );
      if (input.valid_from < a.valid_from || input.valid_to > a.valid_to)
        fail(400, "Approval dates must be within the requested service period");
      if (
        state.authorizations.some(
          (other) =>
            other.id !== a.id &&
            other.policy_id === a.policy_id &&
            other.approval_number.toLowerCase() ===
              input.approval_number.toLowerCase(),
        )
      )
        fail(409, "This approval number is already recorded for the policy");
      Object.assign(a, {
        approval_number: input.approval_number,
        approved_visits: input.approved_visits,
        valid_from: input.valid_from,
        valid_to: input.valid_to,
      });
    } else if (input.approved_visits || input.approval_number)
      fail(
        400,
        "Denied authorizations cannot include approved visits or an approval number",
      );
    a.status = input.outcome === "Approved" ? "Demo approved" : "Demo denied";
    a.decision_note = input.note;
    authHistory(a, ctx, a.status, input.note);
    ctx.audit(`Recorded prior authorization: ${a.status}`, a.id);
    return a;
  }
  if (method === "POST" && action === "cancel") {
    if (["Cancelled", "Demo denied"].includes(a.status))
      fail(409, "Authorization is already closed");
    if (reservedVisits(state, a.id))
      fail(
        409,
        "Authorization is reserved by a claim; replace or void the claim before cancellation",
      );
    const input = z
      .object({ reason: z.string().trim().min(5).max(500) })
      .parse(body);
    a.status = "Cancelled";
    authHistory(a, ctx, "Cancelled", input.reason);
    ctx.audit("Cancelled demo prior authorization", a.id);
    return a;
  }
  fail(404, "Authorization workflow not found");
}
function correctionHistory(
  c: ClaimCorrection,
  ctx: WorkflowContext,
  action: string,
  note: string,
) {
  c.history.push({ action, note, actor: ctx.user.name, at: ctx.now });
}
function correctionBill(state: FinanceState, c: ClaimCorrection): Bill {
  const b = find(state.bills, c.bill_id, "Charge sheet");
  if (
    b.revision !== c.original_bill.revision ||
    currentClaim(state, b.id)?.id !== c.claim_id
  )
    fail(
      409,
      "The source claim or charge sheet changed; prepare a new correction",
    );
  return {
    ...b,
    lines: c.lines,
    policy_id: c.policy_id,
    authorization_required: c.authorization_required,
    authorization_id: c.authorization_id,
  };
}
function validateCorrection(
  state: FinanceState,
  ctx: WorkflowContext,
  c: ClaimCorrection,
) {
  const b = correctionBill(state, c);
  if (c.kind === "Void")
    return {
      bill: b,
      policy: c.original_claim.policy,
      verification: c.original_claim.verification,
      authorization: c.original_claim.authorization || null,
    };
  signed(ctx, b);
  ctx.validateTreatment?.(b);
  const policy = find(state.policies, c.policy_id, "Policy");
  if (policy.patient_id !== b.patient_id || policy.priority !== "Primary")
    fail(400, "Select primary coverage for the same patient");
  if (policy.billing_account_id !== b.billing_account_id)
    fail(400, "Correction coverage must belong to the visit’s billing account");
  return {
    bill: b,
    policy,
    verification: activeVerification(state, ctx, policy, b.service_date),
    authorization: authorizationForBill(state, ctx, b, policy),
  };
}
function applyCorrection(
  state: FinanceState,
  ctx: WorkflowContext,
  c: ClaimCorrection,
) {
  const reviewed = validateCorrection(state, ctx, c);
  const b = find(state.bills, c.bill_id, "Charge sheet");
  const original = find(state.claims, c.claim_id, "Claim");
  // Reverse insurer postings with new ledger entries; patient receipts remain available
  // as unapplied payments/credits until the replacement is adjudicated or refunded externally.
  for (const entry of [...state.ledger].filter(
    (e) =>
      e.bill_id === b.id &&
      ["Insurer payment", "Contractual adjustment"].includes(e.type),
  )) {
    if (state.ledger.some((e) => e.reverses_id === entry.id)) continue;
    state.ledger.push({
      id: ctx.id("ledger"),
      bill_id: b.id,
      type:
        entry.type === "Insurer payment"
          ? "Insurer payment reversal"
          : "Adjustment reversal",
      amount_cents: entry.amount_cents,
      reference: c.id,
      note: `Demo ${c.kind.toLowerCase()} accepted: ${c.reason}`,
      created_at: ctx.now,
      actor: ctx.user.name,
      reverses_id: entry.id,
    });
  }
  if (c.kind === "Void") {
    original.status = "Demo voided";
    b.voided_at = ctx.now;
  } else {
    original.status =
      c.kind === "Draft revision" ? "Superseded draft" : "Demo replaced";
    Object.assign(b, {
      lines: structuredClone(c.lines),
      policy_id: c.policy_id,
      authorization_id: c.authorization_id,
      authorization_required: c.authorization_required,
    });
    const next: Claim = {
      id: ctx.id("claim"),
      bill_id: b.id,
      status: c.kind === "Draft revision" ? "Prepared" : "Demo submitted",
      kind: c.kind === "Draft revision" ? "Original" : "Replacement",
      replaces_claim_id: original.id,
      policy: structuredClone(reviewed.policy),
      verification: structuredClone(reviewed.verification),
      authorization: reviewed.authorization,
      lines: structuredClone(c.lines),
      total_cents: chargeTotal(c.lines),
      created_at: ctx.now,
      submitted_at: c.kind === "Draft revision" ? null : ctx.now,
      attempts: c.kind === "Draft revision" ? 0 : 1,
      denial_reason: "",
      correction_note: c.reason,
      previous_coverage: [],
      billing_account: structuredClone(
        c.original_claim.billing_account ||
          patientAccount(state, b.patient_id, b.billing_account_id),
      ),
    };
    state.claims.push(next);
    c.result_claim_id = next.id;
  }
  b.revision++;
  c.status = c.kind === "Draft revision" ? "Applied" : "Demo accepted";
  correctionHistory(c, ctx, c.status, c.response_note || c.reason);
  ctx.audit(`Claim correction ${c.status}: ${c.kind}`, c.id);
}
function correctionRequest(
  state: FinanceState,
  ctx: WorkflowContext,
  method: string,
  url: URL,
  body: unknown,
  id?: string,
  action?: string,
) {
  if (method === "GET" && !id) {
    ctx.audit("Viewed claim corrections", "corrections");
    return state.corrections.filter(
      (c) =>
        !url.searchParams.get("patient_id") ||
        find(state.bills, c.bill_id, "Charge sheet").patient_id ===
          url.searchParams.get("patient_id"),
    );
  }
  if (method === "POST" && !id) {
    const input = z
      .object({
        bill_id: text,
        revision: z.number().int(),
        kind: z.enum(["Draft revision", "Replacement", "Void"]),
        reason: z.string().trim().min(5).max(1000),
        lines: z.array(charge).max(30),
        policy_id: text,
        authorization_required: z.boolean().default(false),
        authorization_id: z.string().max(200).default(""),
      })
      .parse(body);
    const b = find(state.bills, input.bill_id, "Charge sheet");
    const claim = currentClaim(state, b.id);
    if (!claim || b.mode !== "Insurance" || b.voided_at)
      fail(409, "Select an active insurance claim to correct");
    if (b.revision !== input.revision)
      fail(409, "Charge sheet changed; reload before preparing a correction");
    noPendingCorrection(state, b.id);
    if (
      input.kind === "Draft revision"
        ? claim.status !== "Prepared"
        : !claim.submitted_at
    )
      fail(
        409,
        "Use draft revision before submission, or replacement/void after demo submission",
      );
    if (
      input.kind !== "Void" &&
      (!input.lines.length || chargeTotal(input.lines) > 100_000_000)
    )
      fail(400, "Enter reviewed correction charges within the supported limit");
    const c: ClaimCorrection = {
      ...input,
      id: ctx.id("correction"),
      claim_id: claim.id,
      status: "Draft",
      original_bill: structuredClone(b),
      original_claim: structuredClone(claim),
      created_at: ctx.now,
      actor: ctx.user.name,
      response_note: "",
      response_reference: "",
      history: [],
    };
    validateCorrection(state, ctx, c);
    correctionHistory(c, ctx, "Draft", c.reason);
    state.corrections.push(c);
    ctx.audit("Prepared audited claim correction", c.id);
    return c;
  }
  const c = find(state.corrections, id, "Correction");
  if (method === "POST" && action === "cancel") {
    if (c.status !== "Draft")
      fail(409, "Only unsubmitted corrections can be cancelled");
    c.status = "Cancelled";
    correctionHistory(
      c,
      ctx,
      "Cancelled",
      "Draft withdrawn; original billing is unchanged.",
    );
    ctx.audit("Cancelled claim correction draft", c.id);
    return c;
  }
  if (method === "POST" && action === "apply") {
    if (c.kind !== "Draft revision" || c.status !== "Draft")
      fail(409, "Only an unsubmitted draft revision can be applied locally");
    applyCorrection(state, ctx, c);
    return c;
  }
  if (method === "POST" && action === "submit") {
    if (c.kind === "Draft revision" || c.status !== "Draft")
      fail(409, "Select an unsubmitted replacement or void correction");
    validateCorrection(state, ctx, c);
    c.status = "Demo submitted";
    correctionHistory(c, ctx, "Demo submitted", "Nothing was transmitted.");
    ctx.audit("Simulated corrected claim submission", c.id);
    return c;
  }
  if (method === "POST" && action === "decision") {
    if (c.status !== "Demo submitted")
      fail(409, "Correction is not awaiting a demo response");
    const input = z
      .object({
        outcome: z.enum(["Accepted", "Rejected"]),
        reference: text,
        note: z.string().trim().min(5).max(1000),
      })
      .parse(body);
    if (
      state.corrections.some(
        (other) =>
          other.id !== c.id &&
          other.response_reference.toLowerCase() ===
            input.reference.toLowerCase(),
      )
    )
      fail(409, "Correction response reference already recorded");
    if (input.outcome === "Accepted") validateCorrection(state, ctx, c);
    c.response_note = input.note;
    c.response_reference = input.reference;
    if (input.outcome === "Accepted") applyCorrection(state, ctx, c);
    else {
      c.status = "Demo rejected";
      correctionHistory(c, ctx, c.status, input.note);
      ctx.audit("Recorded demo correction rejection", c.id);
    }
    return c;
  }
  fail(404, "Correction workflow not found");
}

// Pure shared rules: the authenticated server persists these atomically; the offline preview uses memory.
export function financeRequest(
  state: FinanceState,
  ctx: WorkflowContext,
  method: string,
  url: URL,
  body: unknown,
) {
  if (!["clinician", "receptionist"].includes(ctx.user.role))
    fail(403, "Staff access required");
  ensurePatientAccounts(state, ctx);
  const [, resource, id, action] = url.pathname.split("/").filter(Boolean);
  const patientId = url.searchParams.get("patient_id");
  if (patientId) patient(ctx, patientId);
  const accountId = url.searchParams.get("billing_account_id");
  if (accountId) {
    const a =
      state.billing_accounts.find((a) => a.id === accountId) ||
      fail(404, "Patient billing account not found");
    if (patientId && a.patient_id !== patientId)
      fail(400, "Billing account belongs to another patient");
  }
  if (resource === "accounts")
    return patientAccountsRequest(state, ctx, method, id, url, body);
  if (resource === "rfa")
    return rfaRequest(state, ctx, method, url, body, id, action);
  if (resource === "faxes")
    return faxRequest(state, ctx, method, url, body, id, action);
  if (resource === "authorizations")
    return authorizationRequest(state, ctx, method, url, body, id, action);
  if (resource === "corrections")
    return correctionRequest(state, ctx, method, url, body, id, action);
  const named = (patientId: string) => {
    const p = patient(ctx, patientId);
    return { first_name: p.first_name, last_name: p.last_name };
  };
  if (resource === "policies") {
    if (method === "GET") {
      ctx.audit("Viewed insurance coverage", "insurance");
      return state.policies
        .filter((p) => !accountId || p.billing_account_id === accountId)
        .filter(
          (p) =>
            !url.searchParams.get("patient_id") ||
            p.patient_id === url.searchParams.get("patient_id"),
        )
        .map((p) => ({
          ...p,
          billing_account_name: patientAccount(
            state,
            p.patient_id,
            p.billing_account_id,
          ).name,
          billing_account_kind: patientAccount(
            state,
            p.patient_id,
            p.billing_account_id,
          ).kind,
          ...named(p.patient_id),
          verifications: state.verifications.filter(
            (v) => v.policy_id === p.id,
          ),
        }));
    }
    if ((method === "POST" && !id) || (method === "PATCH" && id)) {
      const input = policyInput.parse(body);
      patient(ctx, input.patient_id);
      if (input.subscriber_dob > ctx.today)
        fail(400, "Subscriber birth date cannot be in the future");
      const previous = id ? find(state.policies, id, "Policy") : undefined;
      const billingAccount = patientAccount(
        state,
        input.patient_id,
        input.billing_account_id || previous?.billing_account_id,
        true,
      );
      if (billingAccount.kind === "Workers compensation")
        fail(
          409,
          "Manage the workers compensation carrier and claim in Billing accounts",
        );
      if (previous && previous.billing_account_id !== billingAccount.id)
        fail(409, "Coverage cannot be moved between billing accounts");
      if (previous && previous.patient_id !== input.patient_id)
        fail(409, "A policy cannot be moved to another patient");
      if (
        previous &&
        z.object({ revision: z.number().int() }).parse(body).revision !==
          previous.revision
      )
        fail(409, "Policy changed; reload before saving");
      if (
        state.policies.some(
          (p) =>
            p.id !== id &&
            p.patient_id === input.patient_id &&
            p.billing_account_id === billingAccount.id &&
            p.priority === input.priority &&
            (!p.end_date || p.end_date >= input.effective_date) &&
            (!input.end_date || input.end_date >= p.effective_date),
        )
      )
        fail(
          409,
          `Overlapping ${input.priority.toLowerCase()} coverage already exists; edit its dates first`,
        );
      const p: Policy = {
        ...input,
        billing_account_id: billingAccount.id,
        id: previous?.id || ctx.id("policy"),
        revision: (previous?.revision || 0) + 1,
        updated_at: ctx.now,
      };
      if (previous) Object.assign(previous, p);
      else state.policies.push(p);
      ctx.audit(
        previous ? "Updated insurance policy" : "Added insurance policy",
        p.id,
      );
      return p;
    }
    if (method === "POST" && action === "verify") {
      const p = find(state.policies, id, "Policy");
      const input = z
        .object({
          service_date: date,
          scenario: z.enum(["Active", "Inactive", "Needs review"]),
        })
        .parse(body);
      const covered =
        input.service_date >= p.effective_date &&
        (!p.end_date || input.service_date <= p.end_date);
      const status = covered ? input.scenario : "Inactive";
      const account = patientAccount(state, p.patient_id, p.billing_account_id);
      const wc = account.kind === "Workers compensation";
      if (
        wc &&
        (account.workers_comp?.claim_status !== "Accepted" ||
          !account.workers_comp.accepted_body_parts.length)
      )
        fail(
          409,
          "Record the accepted claim and accepted body parts before an active workers compensation review",
        );
      const v: Verification = {
        id: ctx.id("eligibility"),
        policy_id: p.id,
        policy_revision: p.revision,
        service_date: input.service_date,
        status,
        source: wc ? "Demo workers compensation review" : "Demo payer",
        copay_cents: !wc && status === "Active" ? 2500 : null,
        deductible_remaining_cents: !wc && status === "Active" ? 50000 : null,
        coinsurance_percent: !wc && status === "Active" ? 20 : null,
        reference: ctx.id("DEMO"),
        checked_at: ctx.now,
        checked_by: ctx.user.name,
      };
      state.verifications.push(v);
      ctx.audit(`Demo insurance verification: ${status}`, p.id);
      return v;
    }
  }
  if (resource === "visits" && method === "GET") {
    // Billing staff receive encounter identifiers/status only, never SOAP notes or laboratory data.
    return ctx.encounters
      .filter((e) => !patientId || e.patient_id === patientId)
      .map((e) => ({
        id: e.id,
        patient_id: e.patient_id,
        billing_account_id: patientAccount(
          state,
          e.patient_id,
          e.billing_account_id,
        ).id,
        billing_account_name: patientAccount(
          state,
          e.patient_id,
          e.billing_account_id,
        ).name,
        ...named(e.patient_id),
        service_date: visitDate(ctx, e),
        status: e.status,
        bill_id: state.bills.find((b) => b.encounter_id === e.id)?.id || null,
      }));
  }
  if (resource === "summary" && method === "GET") {
    const bills = state.bills.filter(
      (b) =>
        (!patientId || b.patient_id === patientId) &&
        (!accountId || b.billing_account_id === accountId),
    );
    const totals = bills.map((b) => billTotals(state, b));
    return {
      charges_cents: totals.reduce((s, t) => s + t.charges_cents, 0),
      paid_cents: totals.reduce((s, t) => s + t.paid_cents, 0),
      balance_cents: totals.reduce((s, t) => s + t.balance_cents, 0),
      patient_balance_cents: totals.reduce(
        (s, t) => s + (t.patient_balance_cents || 0),
        0,
      ),
      unallocated_cents: totals.reduce((s, t) => s + t.unallocated_cents, 0),
      credit_cents: totals.reduce((s, t) => s + t.credit_cents, 0),
      denied_claims: state.claims.filter(
        (c) =>
          c.status === "Demo denied" && bills.some((b) => b.id === c.bill_id),
      ).length,
      payer_connected: false,
      clearinghouse_connected: false,
    };
  }
  if (resource === "bills") {
    if (method === "GET" && !id) {
      ctx.audit("Viewed billing ledger", "billing");
      return state.bills
        .filter((b) => !accountId || b.billing_account_id === accountId)
        .filter(
          (b) =>
            !url.searchParams.get("patient_id") ||
            b.patient_id === url.searchParams.get("patient_id"),
        )
        .map((b) => enrichBill(state, ctx, b));
    }
    if (method === "POST" && !id) {
      const input = z
        .object({
          encounter_id: text,
          mode: z.enum(["Insurance", "Self-pay"]),
          patient_id: text.optional(),
        })
        .parse(body);
      const e = find(
        ctx.encounters as {
          id: string;
          patient_id: string;
          billing_account_id?: string;
        }[],
        input.encounter_id,
        "Encounter",
      );
      if (input.patient_id && e.patient_id !== input.patient_id)
        fail(400, "Encounter belongs to another patient");
      if (state.bills.some((b) => b.encounter_id === e.id))
        fail(409, "This encounter already has a charge sheet");
      const account = patientAccount(state, e.patient_id, e.billing_account_id);
      if (account.kind === "Workers compensation" && input.mode !== "Insurance")
        fail(409, "Workers compensation visits must bill their claim carrier");
      const b: Bill = {
        id: ctx.id("bill"),
        patient_id: e.patient_id,
        encounter_id: e.id,
        billing_account_id: account.id,
        service_date: visitDate(ctx, e),
        mode: input.mode,
        policy_id:
          account.kind === "Workers compensation"
            ? state.policies.find((p) => p.billing_account_id === account.id)
                ?.id || ""
            : "",
        lines: [],
        revision: 1,
        created_at: ctx.now,
        finalized_at: null,
      };
      state.bills.push(b);
      ctx.audit("Created charge sheet", b.id);
      return b;
    }
    if (method === "PATCH" && id && !action) {
      const b = find(state.bills, id, "Charge sheet");
      if (b.finalized_at || state.claims.some((c) => c.bill_id === b.id))
        fail(
          409,
          "Finalized billing is locked; posted entries cannot be silently changed",
        );
      const input = z
        .object({
          revision: z.number().int(),
          policy_id: z.string().max(200),
          lines: z.array(charge).max(30),
          authorization_required: z.boolean().optional(),
          authorization_id: z.string().max(200).optional(),
        })
        .parse(body);
      if (input.revision !== b.revision)
        fail(409, "Charge sheet changed; reload before saving");
      if (chargeTotal(input.lines) > 100_000_000)
        fail(400, "Charge sheet exceeds the supported limit");
      if (input.policy_id) {
        const p = find(state.policies, input.policy_id, "Policy");
        if (p.patient_id !== b.patient_id)
          fail(400, "Insurance policy belongs to another patient");
        if (p.billing_account_id !== b.billing_account_id)
          fail(
            400,
            "Insurance policy belongs to a different billing account than this visit",
          );
      }
      if (b.mode === "Self-pay" && input.policy_id)
        fail(400, "Self-pay charge sheets cannot use an insurance policy");
      Object.assign(b, {
        policy_id: input.policy_id,
        lines: input.lines,
        revision: b.revision + 1,
        authorization_required:
          input.authorization_required ?? b.authorization_required ?? false,
        authorization_id: input.authorization_id ?? b.authorization_id ?? "",
      });
      ctx.audit("Updated charge sheet", b.id);
      return b;
    }
    if (method === "POST" && action === "finalize") {
      const b = find(state.bills, id, "Charge sheet");
      if (b.mode !== "Self-pay")
        fail(409, "Prepare an insurance claim for an insured visit");
      if (b.finalized_at) fail(409, "Charge sheet already finalized");
      signed(ctx, b);
      ctx.validateTreatment?.(b);
      b.finalized_at = ctx.now;
      b.revision++;
      ctx.audit("Finalized self-pay charge sheet", b.id);
      return b;
    }
    if (method === "POST" && action === "payments") {
      const b = find(state.bills, id, "Charge sheet");
      noPendingCorrection(state, b.id);
      if (b.voided_at) fail(409, "Voided billing cannot receive payments");
      const input = z
        .object({
          amount_cents: cents.refine((v) => v > 0),
          reference: text,
          note: z.string().trim().max(500).default(""),
        })
        .parse(body);
      const due = billTotals(state, b).patient_balance_cents;
      if (due === null)
        fail(
          409,
          "Patient responsibility has not been assigned; finalize self-pay or record a demo remittance first",
        );
      if (input.amount_cents > due)
        fail(409, "Payment exceeds the outstanding patient balance");
      if (
        state.ledger.some(
          (l) =>
            l.type === "Patient payment" &&
            l.reference.toLowerCase() === input.reference.toLowerCase(),
        )
      )
        fail(409, "Payment reference already recorded");
      const entry: LedgerEntry = {
        ...input,
        id: ctx.id("payment"),
        bill_id: b.id,
        type: "Patient payment",
        created_at: ctx.now,
        actor: ctx.user.name,
      };
      state.ledger.push(entry);
      ctx.audit("Recorded manual patient payment", b.id);
      return entry;
    }
    if (method === "GET" && action === "statement") {
      const b = find(state.bills, id, "Charge sheet");
      const t = billTotals(state, b);
      if (t.patient_balance_cents === null)
        fail(409, "Patient responsibility has not been assigned");
      ctx.audit("Exported demo patient statement", b.id);
      return {
        document_type:
          "DEMO PATIENT STATEMENT — no delivery or payment processing",
        patient: named(b.patient_id),
        service_date: b.service_date,
        lines: b.lines,
        ...t,
        ledger: state.ledger.filter((l) => l.bill_id === b.id),
        generated_at: ctx.now,
      };
    }
  }
  if (resource === "claims") {
    if (method === "POST" && !id) {
      const input = z.object({ bill_id: text }).parse(body);
      const b = find(state.bills, input.bill_id, "Charge sheet");
      if (b.mode !== "Insurance")
        fail(409, "Self-pay visits do not create insurance claims");
      if (state.claims.some((c) => c.bill_id === b.id))
        fail(409, "A claim already exists for this charge sheet");
      signed(ctx, b);
      ctx.validateTreatment?.(b);
      if (!b.policy_id)
        fail(400, "Select primary insurance coverage before preparing a claim");
      const p = find(state.policies, b.policy_id, "Policy");
      if (
        p.patient_id !== b.patient_id ||
        p.billing_account_id !== b.billing_account_id
      )
        fail(400, "Coverage must belong to this visit’s billing account");
      const account = patientAccount(state, b.patient_id, b.billing_account_id);
      const encounter = ctx.encounters.find((e) => e.id === b.encounter_id)!;
      const snapshot = readJson<PatientBillingAccount | null>(
        encounter.billing_account_snapshot,
        null,
      );
      if (
        account.kind === "Workers compensation" &&
        (!snapshot ||
          snapshot.id !== account.id ||
          account.workers_comp?.claim_status !== "Accepted")
      )
        fail(
          409,
          "A signed workers compensation note and accepted claim are required",
        );
      if (p.priority !== "Primary")
        fail(
          409,
          "Prepare the primary claim first; secondary claim coordination is not available in this demo",
        );
      const v = activeVerification(state, ctx, p, b.service_date);
      const authorization = authorizationForBill(state, ctx, b, p);
      const c: Claim = {
        id: ctx.id("claim"),
        bill_id: b.id,
        status: "Prepared",
        policy: structuredClone(p),
        verification: structuredClone(v),
        lines: structuredClone(b.lines),
        total_cents: chargeTotal(b.lines),
        created_at: ctx.now,
        submitted_at: null,
        attempts: 0,
        denial_reason: "",
        correction_note: "",
        previous_coverage: [],
        authorization,
        kind: "Original",
        billing_account: structuredClone(
          account.kind === "Workers compensation" ? snapshot! : account,
        ),
      };
      state.claims.push(c);
      ctx.audit("Prepared demo claim", c.id);
      return c;
    }
    if (method === "GET" && action === "export") {
      const c = find(state.claims, id, "Claim");
      ctx.audit("Exported demo claim draft", c.id);
      return {
        document_type: "DEMO CLAIM DRAFT — not an X12 837 file",
        transmitted: false,
        claim: c,
      };
    }
    if (method === "POST" && action === "refresh-coverage") {
      const c = find(state.claims, id, "Claim");
      noPendingCorrection(state, c.bill_id);
      if (!["Prepared", "Demo denied"].includes(c.status))
        fail(
          409,
          "Coverage can only be refreshed before submission or after a denial",
        );
      const b = find(state.bills, c.bill_id, "Charge sheet");
      const p = find(state.policies, c.policy.id, "Policy");
      if (p.priority !== "Primary")
        fail(409, "Primary coverage is required for this demo claim");
      const v = activeVerification(state, ctx, p, b.service_date);
      const input = z
        .object({
          authorization_required: z.boolean().optional(),
          authorization_id: z.string().max(200).optional(),
        })
        .parse(body);
      const review = {
        ...b,
        authorization_required:
          input.authorization_required ?? b.authorization_required,
        authorization_id: input.authorization_id ?? b.authorization_id,
      };
      ctx.validateTreatment?.(review);
      const authorization = authorizationForBill(state, ctx, review, p);
      c.previous_coverage.push({
        policy: structuredClone(c.policy),
        verification: structuredClone(c.verification),
        replaced_at: ctx.now,
      });
      c.policy = structuredClone(p);
      c.verification = structuredClone(v);
      b.authorization_id = review.authorization_id;
      b.authorization_required = review.authorization_required;
      c.authorization = authorization;
      ctx.audit("Refreshed demo claim coverage snapshot", c.id);
      return c;
    }
    if (method === "POST" && action === "submit") {
      const c = find(state.claims, id, "Claim");
      noPendingCorrection(state, c.bill_id);
      if (c.status !== "Prepared" && c.status !== "Demo denied")
        fail(409, "Claim is already submitted or adjudicated");
      const b = find(state.bills, c.bill_id, "Charge sheet");
      const p = find(state.policies, c.policy.id, "Policy");
      if (p.revision !== c.policy.revision)
        fail(
          409,
          "Policy changed after preparation; verify it again and refresh claim coverage",
        );
      c.verification = structuredClone(
        activeVerification(state, ctx, p, b.service_date),
      );
      ctx.validateTreatment?.(b);
      c.authorization = authorizationForBill(state, ctx, b, p);
      if (c.status === "Demo denied")
        c.correction_note = z
          .object({ correction_note: z.string().trim().min(5).max(500) })
          .parse(body).correction_note;
      c.status = "Demo submitted";
      c.submitted_at = ctx.now;
      c.attempts++;
      c.denial_reason = "";
      ctx.audit("Simulated claim submission; no transmission", c.id);
      return c;
    }
    if (method === "POST" && action === "remittance") {
      const c = find(state.claims, id, "Claim");
      noPendingCorrection(state, c.bill_id);
      if (c.status !== "Demo submitted")
        fail(409, "Submit the demo claim before recording its response");
      const input = z
        .object({
          reference: text,
          outcome: z.enum(["Approved", "Denied"]),
          payer_paid_cents: cents,
          adjustment_cents: cents,
          patient_responsibility_cents: cents,
          denial_reason: z.string().trim().max(500),
        })
        .parse(body);
      if (
        c.billing_account?.kind === "Workers compensation" &&
        input.patient_responsibility_cents
      )
        fail(
          400,
          "Workers compensation responses cannot assign patient responsibility in this demo; resolve disputed liability separately",
        );
      if (
        state.remittances.some(
          (r) => r.reference.toLowerCase() === input.reference.toLowerCase(),
        )
      )
        fail(409, "Remittance reference already recorded");
      if (input.outcome === "Denied") {
        if (input.denial_reason.length < 5)
          fail(400, "Record a denial reason for follow-up");
        if (
          input.payer_paid_cents ||
          input.adjustment_cents ||
          input.patient_responsibility_cents
        )
          fail(
            400,
            "Denied responses cannot post payments or patient responsibility",
          );
      } else if (
        input.payer_paid_cents +
          input.adjustment_cents +
          input.patient_responsibility_cents !==
        c.total_cents
      )
        fail(
          400,
          "Insurer payment, adjustment, and patient responsibility must equal the claim charges",
        );
      const r: Remittance = {
        ...input,
        id: ctx.id("remittance"),
        claim_id: c.id,
        attempt: c.attempts,
        created_at: ctx.now,
      };
      state.remittances.push(r);
      c.status =
        input.outcome === "Denied" ? "Demo denied" : "Demo adjudicated";
      c.denial_reason = input.denial_reason;
      if (input.outcome === "Approved") {
        for (const [type, amount] of [
          ["Insurer payment", input.payer_paid_cents],
          ["Contractual adjustment", input.adjustment_cents],
        ] as const)
          if (amount)
            state.ledger.push({
              id: ctx.id("ledger"),
              bill_id: c.bill_id,
              type,
              amount_cents: amount,
              reference: r.reference,
              note: "Simulated remittance",
              created_at: ctx.now,
              actor: ctx.user.name,
            });
      }
      ctx.audit(`Recorded demo remittance: ${input.outcome}`, c.id);
      return r;
    }
  }
  if (resource === "payments" && method === "POST" && action === "reverse") {
    const e = find(state.ledger, id, "Payment");
    noPendingCorrection(state, e.bill_id);
    const input = z
      .object({ reason: z.string().trim().min(5).max(500) })
      .parse(body);
    if (e.type !== "Patient payment")
      fail(
        409,
        "Only manually recorded patient payment entries can be reversed here",
      );
    if (state.ledger.some((l) => l.reverses_id === e.id))
      fail(409, "Payment entry already reversed");
    const reversal: LedgerEntry = {
      id: ctx.id("reversal"),
      bill_id: e.bill_id,
      type: "Payment reversal",
      amount_cents: e.amount_cents,
      reference: e.reference,
      note: input.reason,
      created_at: ctx.now,
      actor: ctx.user.name,
      reverses_id: e.id,
    };
    state.ledger.push(reversal);
    ctx.audit("Reversed manual payment entry; no refund issued", e.id);
    return reversal;
  }
  fail(404, "Finance workflow not found");
}
