import { z } from 'zod';
import type { FinanceState } from './finance-engine.js';
import type { WorkflowContext } from './workflow-engine.js';

const short = z.string().trim().min(1).max(200);
const calendar = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T12:00:00Z`);
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Enter a valid calendar date');
const parts = z
  .array(short)
  .max(30)
  .refine(
    (v) => new Set(v.map((s) => s.toLowerCase())).size === v.length,
    'Body parts must be unique',
  );
export const workersCompInput = z.object({
  claim_number: short,
  date_of_injury: calendar,
  employer: short,
  carrier: short,
  jurisdiction: z.string().trim().max(100).default(''),
  adjuster_name: z.string().trim().max(200).default(''),
  adjuster_phone: z.string().trim().max(40).default(''),
  adjuster_email: z
    .union([z.string().trim().email().max(254), z.literal('')])
    .default(''),
  claim_status: z.enum(['Pending', 'Accepted', 'Denied']).default('Pending'),
  accepted_body_parts: parts.default([]),
});
export const patientAccountInput = z
  .object({
    patient_id: short,
    name: short,
    kind: z.enum(['Private insurance', 'Workers compensation']),
    status: z.enum(['Active', 'Closed']).default('Active'),
    workers_comp: workersCompInput.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'Workers compensation' && !v.workers_comp)
      ctx.addIssue({
        code: 'custom',
        message: 'Workers compensation claim details are required',
      });
    if (v.kind === 'Private insurance' && v.workers_comp)
      ctx.addIssue({
        code: 'custom',
        message:
          'Private insurance accounts cannot contain workers compensation claim details',
      });
  });
export type PatientBillingAccount = z.infer<typeof patientAccountInput> & {
  id: string;
  revision: number;
  created_at: string;
  updated_at: string;
};
export const wcDocumentationInput = z.object({
  account_revision: z.number().int().optional(),
  claim_reviewed: z.boolean().default(false),
  addressed_body_parts: parts.default([]),
  injury_history: z.string().trim().max(5000).default(''),
  work_related_assessment: z.string().trim().max(5000).default(''),
  work_status: z
    .enum(['Not assessed', 'Full duty', 'Modified duty', 'Off work'])
    .default('Not assessed'),
  restrictions: z.string().trim().max(5000).default(''),
  next_review_date: z.union([calendar, z.literal('')]).default(''),
});
export type WcDocumentation = z.infer<typeof wcDocumentationInput>;
export const defaultPatientAccountId = (patientId: string) =>
  `pba-private-${patientId}`;
function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
export function ensurePatientAccounts(
  state: FinanceState,
  ctx: WorkflowContext,
) {
  for (const p of ctx.patients)
    if (
      !state.billing_accounts.some(
        (a) => a.id === defaultPatientAccountId(p.id),
      )
    )
      state.billing_accounts.push({
        id: defaultPatientAccountId(p.id),
        patient_id: p.id,
        name: 'Private insurance / personal care',
        kind: 'Private insurance',
        status: 'Active',
        workers_comp: null,
        revision: 1,
        created_at: p.created_at || ctx.now,
        updated_at: p.created_at || ctx.now,
      });
  for (const p of state.policies)
    p.billing_account_id ||= defaultPatientAccountId(p.patient_id);
  for (const b of state.bills)
    b.billing_account_id ||= defaultPatientAccountId(b.patient_id);
}
export function patientAccount(
  state: FinanceState,
  patientId: string,
  id?: string,
  active = false,
) {
  const a =
    state.billing_accounts.find(
      (a) => a.id === (id || defaultPatientAccountId(patientId)),
    ) || fail(404, 'Patient billing account not found');
  if (a.patient_id !== patientId)
    fail(400, 'Billing account belongs to another patient');
  if (active && a.status !== 'Active')
    fail(409, 'Choose an active patient billing account');
  return a;
}
export function readJson<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return (value ?? fallback) as T;
}
export function encounterAccountFields(
  state: FinanceState,
  ctx: WorkflowContext,
  encounter: Record<string, any>,
  input: Record<string, any>,
) {
  ensurePatientAccounts(state, ctx);
  const previous =
    encounter.billing_account_id ||
    defaultPatientAccountId(encounter.patient_id);
  const a = patientAccount(
    state,
    encounter.patient_id,
    input.billing_account_id || previous,
    input.billing_account_id && input.billing_account_id !== previous,
  );
  if (
    a.id !== previous &&
    state.bills.some((b) => b.encounter_id === encounter.id)
  )
    fail(
      409,
      'This visit already has billing. Its billing account cannot be changed.',
    );
  const wc =
    a.kind === 'Workers compensation'
      ? wcDocumentationInput.parse(
          input.wc_documentation ?? readJson(encounter.wc_documentation, {}),
        )
      : null;
  if (wc?.account_revision !== undefined && wc.account_revision !== a.revision)
    fail(
      409,
      'Claim details changed. Reload the billing accounts before saving this note.',
    );
  if (input.status === 'Signed' && wc) {
    const claim = a.workers_comp!;
    if (claim.claim_status !== 'Accepted' || !claim.accepted_body_parts.length)
      fail(
        400,
        'Record the accepted claim and accepted body parts before signing a workers compensation note',
      );
    if (
      !wc.claim_reviewed ||
      !wc.addressed_body_parts.length ||
      !wc.injury_history ||
      !wc.work_related_assessment ||
      wc.work_status === 'Not assessed'
    )
      fail(
        400,
        'Review the claim, select addressed accepted body parts, and document injury history, work-related assessment, and work status before signing',
      );
    if (
      wc.addressed_body_parts.some(
        (p) => !claim.accepted_body_parts.includes(p),
      )
    )
      fail(
        400,
        'Addressed body parts must match this claim’s accepted body parts',
      );
    if (wc.work_status !== 'Full duty' && !wc.restrictions)
      fail(400, 'Document restrictions for modified duty or off-work status');
    if (wc.next_review_date && wc.next_review_date < ctx.today)
      fail(400, 'Next work-status review cannot be in the past');
    if (
      [wc.injury_history, wc.work_related_assessment, wc.restrictions].some(
        (v) => v.includes('[['),
      )
    )
      fail(
        400,
        'Resolve workers compensation documentation placeholders before signing',
      );
  }
  return {
    billing_account_id: a.id,
    billing_account_snapshot: structuredClone(a),
    wc_documentation: wc ? { ...wc, account_revision: a.revision } : null,
  };
}
export function patientAccountsRequest(
  state: FinanceState,
  ctx: WorkflowContext,
  method: string,
  id: string | undefined,
  url: URL,
  body: unknown,
) {
  if (method === 'GET')
    return state.billing_accounts
      .filter(
        (a) =>
          !url.searchParams.get('patient_id') ||
          a.patient_id === url.searchParams.get('patient_id'),
      )
      .map((a) => ({
        ...a,
        policy_count: state.policies.filter(
          (p) => p.billing_account_id === a.id,
        ).length,
      }));
  if ((method === 'POST' && !id) || (method === 'PATCH' && id)) {
    const input = patientAccountInput.parse(body);
    const p =
      ctx.patients.find((p) => p.id === input.patient_id) ||
      fail(404, 'Patient not found');
    const previous = id
      ? patientAccount(state, input.patient_id, id)
      : undefined;
    if (previous) {
      if (
        z.object({ revision: z.number().int() }).parse(body).revision !==
        previous.revision
      )
        fail(409, 'Billing account changed; reload before saving');
      if (previous.kind !== input.kind)
        fail(
          409,
          'Account type cannot be changed; create a separate billing account',
        );
    }
    const claim = input.workers_comp;
    if (claim && claim.date_of_injury > ctx.today)
      fail(400, 'Date of injury cannot be in the future');
    if (claim?.claim_status === 'Accepted' && !claim.accepted_body_parts.length)
      fail(400, 'List the accepted body parts for an accepted claim');
    if (
      claim &&
      state.billing_accounts.some(
        (a) =>
          a.id !== id &&
          a.patient_id === p.id &&
          a.workers_comp?.claim_number.toLowerCase() ===
            claim.claim_number.toLowerCase() &&
          a.workers_comp.carrier.toLowerCase() === claim.carrier.toLowerCase(),
      )
    )
      fail(
        409,
        'This patient already has an account for that carrier and claim number',
      );
    if (
      previous?.workers_comp &&
      claim &&
      (ctx.encounters.some((e) => e.billing_account_id === id) ||
        ctx.appointments.some((a) => a.billing_account_id === id) ||
        state.bills.some((b) => b.billing_account_id === id)) &&
      ['claim_number', 'carrier', 'date_of_injury', 'employer'].some(
        (k) => (previous.workers_comp as any)[k] !== (claim as any)[k],
      )
    )
      fail(
        409,
        'Used claim identity cannot be changed. Create a separate claim account to preserve visit history.',
      );
    const a: PatientBillingAccount = {
      ...input,
      workers_comp: claim || null,
      id: previous?.id || ctx.id('pba'),
      revision: (previous?.revision || 0) + 1,
      created_at: previous?.created_at || ctx.now,
      updated_at: ctx.now,
    };
    if (previous) Object.assign(previous, a);
    else state.billing_accounts.push(a);
    if (claim) {
      let policy = state.policies.find((p) => p.billing_account_id === a.id);
      if (!policy) {
        policy = {
          id: ctx.id('policy'),
          patient_id: p.id,
          billing_account_id: a.id,
          payer: claim.carrier,
          plan: 'Workers compensation',
          member_id: claim.claim_number,
          group_number: '',
          priority: 'Primary',
          subscriber_name: `${p.first_name} ${p.last_name}`,
          subscriber_dob: p.dob,
          relationship: 'Self',
          effective_date: claim.date_of_injury,
          end_date: '',
          revision: 1,
          updated_at: ctx.now,
        };
        state.policies.push(policy);
      } else if (
        policy.payer !== claim.carrier ||
        policy.member_id !== claim.claim_number ||
        policy.effective_date !== claim.date_of_injury
      ) {
        Object.assign(policy, {
          payer: claim.carrier,
          member_id: claim.claim_number,
          effective_date: claim.date_of_injury,
          revision: policy.revision + 1,
          updated_at: ctx.now,
        });
      }
    }
    ctx.audit(
      previous
        ? 'Updated patient billing account'
        : 'Created patient billing account',
      a.id,
    );
    return a;
  }
  fail(404, 'Patient billing account workflow not found');
}
