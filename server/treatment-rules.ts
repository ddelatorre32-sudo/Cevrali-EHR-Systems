import { z } from 'zod';
import type { Bill } from './finance-engine.js';
import type { VisitPlan } from './operations-engine.js';
import type { WorkflowContext, WorkflowState } from './workflow-engine.js';

export type TreatmentActual = {
  procedure_code: string;
  approval_id: string;
  planned: number;
  performed: number;
  deferred: number;
  cancelled: number;
};
export type TreatmentRevision = {
  revision: number;
  plan_revision: number;
  at: string;
  actor_id: string;
  actor: string;
  reason: string;
  services: TreatmentActual[];
};
export type TreatmentReview = {
  id: string;
  appointment_id: string;
  encounter_id: string;
  patient_id: string;
  billing_account_id: string;
  plan_revision: number;
  revision: number;
  reviewed_at: string;
  reviewed_by: string;
  reviewed_by_name: string;
  reason: string;
  services: TreatmentActual[];
  history: TreatmentRevision[];
};

const fail = (status: number, message: string): never => {
  throw Object.assign(new Error(message), { status });
};
const accountId = (a: Record<string, any>) =>
  a.billing_account_id || `pba-private-${a.patient_id}`;
const currentReview = (state: WorkflowState, p: VisitPlan) =>
  (state.operations.treatment_reviews || []).find(
    (r) =>
      r.appointment_id === p.appointment_id &&
      r.patient_id === p.patient_id &&
      r.billing_account_id === p.billing_account_id &&
      r.plan_revision === p.revision,
  );

/** Unreviewed legacy completions retain their reservation; no actuals are invented. */
export function treatmentUsageForPlan(
  state: WorkflowState,
  ctx: WorkflowContext,
  p: VisitPlan,
  approvalId: string,
) {
  // Actual treatment belongs to its recorded service approval. Releasing or
  // revising an administrative plan cannot release treatment already delivered.
  const recorded = (state.operations.treatment_reviews || []).find(
    (r) =>
      r.appointment_id === p.appointment_id && r.patient_id === p.patient_id,
  );
  const completed = (recorded?.services || [])
    .filter((s) => s.approval_id === approvalId)
    .reduce((n, s) => n + s.performed, 0);
  if (currentReview(state, p))
    return {
      reserved: 0,
      completed,
    };
  const a = ctx.appointments.find((a) => a.id === p.appointment_id);
  const released =
    p.released ||
    !a ||
    a.status === 'Cancelled' ||
    a.status === 'No-show' ||
    state.visits[a.id]?.stage === 'No-show' ||
    accountId(a) !== p.billing_account_id;
  return {
    reserved: released
      ? 0
      : Math.max(
          0,
          p.services
            .filter((s) => s.approval_id === approvalId)
            .reduce((n, s) => n + s.quantity, 0) - completed,
        ),
    completed,
  };
}

function sums(lines: { code: string; units: number }[]) {
  const totals = new Map<string, number>();
  for (const line of lines)
    totals.set(line.code, (totals.get(line.code) || 0) + line.units);
  return totals;
}
function appointmentBills(
  state: WorkflowState,
  ctx: WorkflowContext,
  id: string,
) {
  const encounters = new Set(
    ctx.encounters.filter((e) => e.appointment_id === id).map((e) => e.id),
  );
  return state.finance.bills.filter(
    (b) => !b.voided_at && encounters.has(b.encounter_id),
  );
}
function checkApproval(
  state: WorkflowState,
  p: VisitPlan,
  service: { procedure_code: string; approval_id: string },
  date: string,
) {
  if (!service.approval_id) {
    if (p.authorization_required)
      fail(
        409,
        `${service.procedure_code}: approved service allowance is required`,
      );
    return null;
  }
  const s = state.operations.service_approvals.find(
    (s) => s.id === service.approval_id,
  );
  const a = state.finance.authorizations.find(
    (a) => a.id === s?.authorization_id,
  );
  const policy = state.finance.policies.find((v) => v.id === s?.policy_id);
  if (
    !s ||
    !a ||
    !policy ||
    s.patient_id !== p.patient_id ||
    s.billing_account_id !== p.billing_account_id ||
    s.procedure_code !== service.procedure_code ||
    a.patient_id !== p.patient_id ||
    a.policy_id !== policy.id ||
    accountId(policy) !== p.billing_account_id ||
    a.status !== 'Demo approved' ||
    policy.revision !== s.policy_revision ||
    policy.revision !== a.policy_revision ||
    date < a.valid_from ||
    date > a.valid_to ||
    !a.procedure_codes.includes(service.procedure_code)
  )
    fail(
      409,
      `${service.procedure_code}: approval is inactive, changed or outside the service date`,
    );
  return { service: s!, authorization: a!, policy: policy! };
}

/** Call before any finalization, preparation, submission or replacement correction. */
export function validateTreatmentForBill(
  state: WorkflowState,
  ctx: WorkflowContext,
  bill: Bill,
  excludeBill?: Bill | string,
) {
  const e = ctx.encounters.find((e) => e.id === bill.encounter_id);
  const p = state.operations.visit_plans.find(
    (p) => p.appointment_id === e?.appointment_id,
  );
  if (!p?.services.length) return;
  const a = ctx.appointments.find((a) => a.id === p.appointment_id);
  if (
    !a ||
    p.released ||
    p.patient_id !== bill.patient_id ||
    p.billing_account_id !== accountId(bill) ||
    accountId(a) !== p.billing_account_id ||
    a.date !== bill.service_date ||
    !['In progress', 'Completed'].includes(a.status)
  )
    fail(
      409,
      'Visit treatment plan does not match the active visit and billing account',
    );
  const review = currentReview(state, p);
  if (!review)
    fail(
      409,
      'Clinician must review actual performed, deferred and cancelled treatment before billing',
    );
  const excluding =
    typeof excludeBill === 'string' ? excludeBill : excludeBill?.id;
  const otherBills = appointmentBills(state, ctx, p.appointment_id).filter(
    (b) => b.id !== bill.id && b.id !== excluding,
  );
  const charged = sums([...otherBills.flatMap((b) => b.lines), ...bill.lines]);
  const codes = new Set(p.services.map((s) => s.procedure_code));
  for (const code of charged.keys())
    if (!codes.has(code))
      fail(409, `${code}: charge is outside the reviewed treatment plan`);
  for (const actual of review!.services) {
    if ((charged.get(actual.procedure_code) || 0) > actual.performed)
      fail(
        409,
        `${actual.procedure_code}: charge units exceed ${actual.performed} reviewed performed units across this visit's charge sheets`,
      );
    if (!actual.performed) continue;
    const approved = checkApproval(state, p, actual, bill.service_date);
    if (!approved) continue;
    if (
      bill.mode !== 'Insurance' ||
      !bill.authorization_required ||
      bill.authorization_id !== approved.authorization.id ||
      bill.policy_id !== approved.policy.id
    )
      fail(
        409,
        `${actual.procedure_code}: billing must use the treatment plan's authorization and policy`,
      );
    let usage = 0;
    for (const plan of state.operations.visit_plans) {
      const q = treatmentUsageForPlan(state, ctx, plan, approved.service.id);
      usage += q.reserved + q.completed;
    }
    if (usage > approved.service.approved_quantity)
      fail(
        409,
        `${actual.procedure_code}: scheduled and performed units exceed the service allowance`,
      );
    // Keep the older authorization's overall visit cap as an additional limit.
    const visits = new Set(
      state.finance.claims
        .filter(
          (c) =>
            c.authorization?.id === approved.authorization.id &&
            c.bill_id !== bill.id &&
            c.bill_id !== excluding &&
            !['Demo replaced', 'Demo voided', 'Superseded draft'].includes(
              c.status,
            ),
        )
        .map((c) => c.bill_id),
    );
    if (visits.size >= approved.authorization.approved_visits)
      fail(409, 'Authorization has no approved visits remaining');
  }
}

function resolveVisit(
  ctx: WorkflowContext,
  appointmentId: string,
  encounterId: string,
) {
  const encounter = encounterId
    ? ctx.encounters.find((e) => e.id === encounterId) ||
      fail(404, 'Encounter not found')
    : ctx.encounters.find((e) => e.appointment_id === appointmentId);
  const appointment =
    ctx.appointments.find(
      (a) => a.id === (appointmentId || encounter?.appointment_id),
    ) || fail(404, 'Appointment not found');
  if (encounter && encounter.appointment_id !== appointment.id)
    fail(400, 'Encounter does not belong to this appointment');
  return { appointment, encounter };
}
function canReview(
  ctx: WorkflowContext,
  a: Record<string, any>,
  e?: Record<string, any>,
) {
  return (
    ctx.user.role === 'clinician' &&
    (e ? e.author_id === ctx.user.id : a.provider_id === ctx.user.id) &&
    ['In progress', 'Completed'].includes(a.status)
  );
}
function publicReview(r: TreatmentReview | undefined, ctx: WorkflowContext) {
  if (!r) return null;
  return ctx.user.role === 'clinician'
    ? r
    : {
        ...r,
        reason: '',
        history: r.history.map((h) => ({ ...h, reason: '' })),
      };
}
function reviewView(
  state: WorkflowState,
  ctx: WorkflowContext,
  appointmentId: string,
  encounterId = '',
) {
  const { appointment: a, encounter: e } = resolveVisit(
    ctx,
    appointmentId,
    encounterId,
  );
  const plan =
    state.operations.visit_plans.find((p) => p.appointment_id === a.id) || null;
  const review = plan ? currentReview(state, plan) : undefined;
  const bills = appointmentBills(state, ctx, a.id);
  const charged = sums(bills.flatMap((b) => b.lines));
  return {
    appointment_id: a.id,
    encounter_id: e?.id || '',
    patient_id: a.patient_id,
    billing_account_id: accountId(a),
    status: a.status,
    plan,
    review: publicReview(review, ctx),
    can_review:
      canReview(ctx, a, e) && Boolean(plan?.services.length) && !plan?.released,
    services: (plan?.services || []).map((s) => ({
      ...s,
      planned: s.quantity,
      performed:
        review?.services.find((r) => r.procedure_code === s.procedure_code)
          ?.performed ?? null,
      deferred:
        review?.services.find((r) => r.procedure_code === s.procedure_code)
          ?.deferred ?? null,
      cancelled:
        review?.services.find((r) => r.procedure_code === s.procedure_code)
          ?.cancelled ?? null,
      billed: charged.get(s.procedure_code) || 0,
    })),
  };
}
export function treatmentReconciliationRows(
  state: WorkflowState,
  ctx: WorkflowContext,
) {
  return state.operations.visit_plans
    .filter((p) => p.services.length)
    .map((p) => {
      const a = ctx.appointments.find((a) => a.id === p.appointment_id);
      if (!a) return null;
      const view = reviewView(state, ctx, a.id);
      const patient = ctx.patients.find((v) => v.id === a.patient_id);
      const issues: string[] = [];
      if (['In progress', 'Completed'].includes(a.status) && !view.review)
        issues.push(
          'Actual treatment review required; planned quantities remain reserved',
        );
      if (view.review) {
        for (const s of view.services)
          if (s.billed !== s.performed)
            issues.push(
              `${s.procedure_code}: ${s.performed} performed / ${s.billed} charged`,
            );
      }
      for (const b of appointmentBills(state, ctx, a.id).filter(
        (b) => b.lines.length,
      )) {
        try {
          validateTreatmentForBill(state, ctx, b);
        } catch (e) {
          if (!issues.includes((e as Error).message))
            issues.push((e as Error).message);
        }
      }
      return {
        ...view,
        first_name: patient?.first_name || '',
        last_name: patient?.last_name || '',
        date: a.date,
        time: a.time,
        issues,
        ready: issues.length === 0,
      };
    })
    .filter((r): r is NonNullable<typeof r> => Boolean(r));
}

const actualInput = z.object({
  appointment_id: z.string().optional(),
  encounter_id: z.string().optional(),
  revision: z.number().int().min(0),
  plan_revision: z.number().int().positive(),
  reason: z.string().trim().min(3).max(1000),
  services: z
    .array(
      z.object({
        procedure_code: z.string().trim().toUpperCase(),
        performed: z.number().int().min(0).max(1000),
        deferred: z.number().int().min(0).max(1000),
        cancelled: z.number().int().min(0).max(1000),
      }),
    )
    .min(1)
    .max(20),
});
export function treatmentRequest(
  state: WorkflowState,
  ctx: WorkflowContext,
  method: string,
  url: URL,
  body: unknown,
) {
  if (url.pathname.endsWith('/treatment-reconciliation') && method === 'GET') {
    ctx.audit(
      'Viewed treatment and billing reconciliation',
      'treatment-reconciliation',
    );
    return treatmentReconciliationRows(state, ctx);
  }
  const input = method === 'POST' ? actualInput.parse(body) : null;
  const appointmentId =
    url.searchParams.get('appointment_id') || input?.appointment_id || '';
  const encounterId =
    url.searchParams.get('encounter_id') || input?.encounter_id || '';
  if (method === 'GET' && !appointmentId && encounterId) {
    const e =
      ctx.encounters.find((e) => e.id === encounterId) ||
      fail(404, 'Encounter not found');
    if (!e.appointment_id)
      return {
        appointment_id: '',
        encounter_id: e.id,
        patient_id: e.patient_id,
        billing_account_id: accountId(e),
        status: '',
        plan: null,
        review: null,
        can_review: false,
        services: [],
      };
  }
  const { appointment: a, encounter: e } = resolveVisit(
    ctx,
    appointmentId,
    encounterId,
  );
  if (method === 'GET') {
    ctx.audit('Viewed actual treatment review', a.id);
    return reviewView(state, ctx, a.id, e?.id);
  }
  if (method !== 'POST' || !input) fail(404, 'Treatment route not found');
  if (!canReview(ctx, a, e))
    fail(
      403,
      'The visit clinician or encounter author must review actual treatment after the visit starts',
    );
  const p = state.operations.visit_plans.find((p) => p.appointment_id === a.id);
  if (
    !p?.services.length ||
    p.released ||
    p.billing_account_id !== accountId(a)
  )
    fail(409, 'Review a current treatment plan for this visit account first');
  const reviews = (state.operations.treatment_reviews ||= []);
  const old = reviews.find((r) => r.appointment_id === a.id);
  if (
    input!.revision !== (old?.revision || 0) ||
    input!.plan_revision !== p!.revision
  )
    fail(409, 'Treatment plan or actual review changed; reload before saving');
  if (
    input!.services.length !== p!.services.length ||
    new Set(input!.services.map((s) => s.procedure_code)).size !==
      input!.services.length
  )
    fail(400, 'Review every planned procedure exactly once');
  const billed = sums(
    appointmentBills(state, ctx, a.id).flatMap((b) => b.lines),
  );
  const services = p!.services.map((planned) => {
    const v =
      input!.services.find(
        (s) => s.procedure_code === planned.procedure_code,
      ) || fail(400, 'Review every planned procedure exactly once');
    if (v.performed + v.deferred + v.cancelled !== planned.quantity)
      fail(
        400,
        `${planned.procedure_code}: performed, deferred and cancelled must total ${planned.quantity} planned units`,
      );
    if (v.performed < (billed.get(v.procedure_code) || 0))
      fail(
        409,
        `${v.procedure_code}: correct or void charge sheets before reducing performed units below charged units`,
      );
    if (v.performed) {
      const approved = checkApproval(state, p!, planned, a.date);
      if (approved) {
        let otherUsage = 0;
        for (const plan of state.operations.visit_plans.filter(
          (q) => q.appointment_id !== a.id,
        )) {
          const q = treatmentUsageForPlan(
            state,
            ctx,
            plan,
            approved.service.id,
          );
          otherUsage += q.reserved + q.completed;
        }
        if (otherUsage + v.performed > approved.service.approved_quantity)
          fail(409, `${v.procedure_code}: not enough approved units remain`);
      }
    }
    return {
      ...v,
      planned: planned.quantity,
      approval_id: planned.approval_id,
    };
  });
  const revision = (old?.revision || 0) + 1;
  const r: TreatmentReview = {
    id: old?.id || ctx.id('treatment'),
    appointment_id: a.id,
    encounter_id: e?.id || '',
    patient_id: a.patient_id,
    billing_account_id: p!.billing_account_id,
    plan_revision: p!.revision,
    revision,
    reviewed_at: ctx.now,
    reviewed_by: ctx.user.id,
    reviewed_by_name: ctx.user.name,
    reason: input!.reason,
    services,
    history: [
      ...(old?.history || []),
      {
        revision,
        plan_revision: p!.revision,
        at: ctx.now,
        actor_id: ctx.user.id,
        actor: ctx.user.name,
        reason: input!.reason,
        services: structuredClone(services),
      },
    ],
  };
  if (old) Object.assign(old, r);
  else reviews.push(r);
  ctx.audit(
    'Reviewed actual treatment quantities and billing reconciliation',
    a.id,
  );
  return reviewView(state, ctx, a.id, e?.id);
}
