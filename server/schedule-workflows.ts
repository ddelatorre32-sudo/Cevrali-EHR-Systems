import { z } from 'zod';
import type {
  CareReminder,
  WorkflowContext,
  WorkflowState,
} from './workflow-engine.js';
import { addCalendarDays, schedulingDate } from './scheduling.js';
import {
  defaultPatientAccountId,
  ensurePatientAccounts,
  patientAccount,
} from './patient-accounts.js';
import {
  saveVisitPlan,
  visitPlanInput,
  type VisitPlan,
} from './operations-engine.js';

type Row = Record<string, any>;
type PlanInput = z.infer<typeof visitPlanInput>;
export type ScheduleHistory = {
  id: string;
  appointment_id: string;
  action: string;
  reason: string;
  actor: string;
  at: string;
  before: Row | null;
  after: Row | null;
  reminder_updates?: {
    id: string;
    before: CareReminder;
    after: CareReminder;
  }[];
};
export type RecurringSeries = {
  id: string;
  patient_id: string;
  billing_account_id: string;
  interval: 'Weekly' | 'Biweekly';
  count: number;
  appointment_ids: string[];
  created_at: string;
  created_by: string;
};
export type WaitlistEntry = {
  id: string;
  revision: number;
  patient_id: string;
  billing_account_id: string;
  provider_id: string;
  appointment_id: string;
  appointment_snapshot: string;
  earliest_date: string;
  latest_date: string;
  earliest_time: string;
  latest_time: string;
  duration: number;
  type: string;
  reason: string;
  priority: 'Routine' | 'High';
  visit_plan: PlanInput | null;
  status: 'Waiting' | 'Offered' | 'Booked' | 'Cancelled';
  created_at: string;
  created_by: string;
  booked_appointment_id: string;
};
export type WaitlistOffer = {
  id: string;
  waitlist_id: string;
  slot_id: string;
  slot_snapshot: string;
  status: 'Active' | 'Booked' | 'Cancelled' | 'Expired';
  created_at: string;
  created_by: string;
  expires_at: string;
  booked_appointment_id: string;
};
export type SchedulingState = {
  appointment_revisions: Record<string, number>;
  history: ScheduleHistory[];
  series: RecurringSeries[];
  waitlist: WaitlistEntry[];
  offers: WaitlistOffer[];
};
export const emptySchedulingState = (): SchedulingState => ({
  appointment_revisions: {},
  history: [],
  series: [],
  waitlist: [],
  offers: [],
});
function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
const short = z.string().trim().min(1).max(200);
const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a valid visit time');
const visitType = z.enum([
  'Consultation',
  'Follow-up',
  'Annual physical',
  'Procedure',
]);
const appointmentInput = z.object({
  patient_id: short,
  billing_account_id: short,
  provider_id: short,
  date: schedulingDate,
  time,
  duration: z.number().int().min(15).max(120),
  type: visitType,
  reason: z.string().trim().min(1).max(1000),
});
const waitlistInput = z.object({
  patient_id: short,
  billing_account_id: short,
  provider_id: z.string().trim().max(200).default(''),
  appointment_id: z.string().trim().max(200).default(''),
  earliest_date: schedulingDate,
  latest_date: schedulingDate,
  earliest_time: time.default('08:00'),
  latest_time: time.default('17:00'),
  duration: z.number().int().min(15).max(120),
  type: visitType,
  reason: z.string().trim().min(1).max(1000),
  priority: z.enum(['Routine', 'High']).default('Routine'),
  visit_plan: visitPlanInput.nullable().optional(),
});
const accountId = (a: Row) =>
  a.billing_account_id || defaultPatientAccountId(a.patient_id);
const minutes = (value: string) =>
  Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
const active = (a: Row) => !['Cancelled', 'No-show'].includes(a.status);
const patient = (ctx: WorkflowContext, id: string) =>
  ctx.patients.find((p) => p.id === id) || fail(404, 'Patient not found');
const appointment = (ctx: WorkflowContext, id: string) =>
  ctx.appointments.find((a) => a.id === id) ||
  fail(404, 'Appointment not found');
const provider = (ctx: WorkflowContext, id: string) =>
  ctx.users.find(
    (u) =>
      u.id === id &&
      u.role === 'clinician' &&
      u.is_active !== false &&
      u.is_active !== 0,
  ) || fail(400, 'Choose an active clinician');
const scheduling = (state: WorkflowState): SchedulingState =>
  (state as WorkflowState & { scheduling: SchedulingState }).scheduling;

/** Snapshot includes the visit account and status, which can change outside this module. */
export function appointmentScheduleSnapshot(a: Row) {
  return JSON.stringify([
    a.id,
    a.patient_id,
    a.date,
    a.time,
    a.duration,
    a.provider_id,
    a.status,
    accountId(a),
    a.type,
    a.reason,
  ]);
}
function future(ctx: WorkflowContext, date: string, visitTime: string) {
  if (
    date < ctx.today ||
    (date === ctx.today && visitTime < ctx.local_time.slice(0, 5))
  )
    fail(409, 'Choose a future visit date and time');
}
function beforeVisit(state: WorkflowState, ctx: WorkflowContext, a: Row) {
  if (
    a.status !== 'Scheduled' ||
    (state.visits[a.id] && state.visits[a.id].stage !== 'Scheduled')
  )
    fail(
      409,
      'Rescheduling is available only before check-in or the visit starts',
    );
  if (
    ctx.encounters.some((e) => e.appointment_id === a.id) ||
    state.finance.bills.some((b) => (b as Row).appointment_id === a.id)
  )
    fail(409, 'A visit with an encounter or billing cannot be rescheduled');
}
function availability(ctx: WorkflowContext, a: Row, except = '') {
  const start = minutes(a.time),
    end = start + a.duration;
  if (end > 24 * 60)
    fail(400, 'The appointment must finish on its scheduled date');
  if (
    ctx.appointments.some(
      (other) =>
        other.id !== except &&
        active(other) &&
        other.date === a.date &&
        (other.provider_id === a.provider_id ||
          other.patient_id === a.patient_id) &&
        start < minutes(other.time) + other.duration &&
        end > minutes(other.time),
    )
  )
    fail(
      409,
      'This time overlaps an existing appointment for the clinician or patient',
    );
}
function coverage(
  state: WorkflowState,
  a: Row,
  plan: PlanInput | null | undefined,
) {
  const account = patientAccount(
    state.finance,
    a.patient_id,
    accountId(a),
    true,
  );
  if (plan?.coverage_mode === 'Self-pay') {
    if (account.kind === 'Workers compensation')
      fail(409, 'Workers compensation cannot use patient self-pay');
    return;
  }
  const policies = state.finance.policies.filter(
    (p) =>
      p.patient_id === a.patient_id &&
      (p.billing_account_id || defaultPatientAccountId(p.patient_id)) ===
        account.id &&
      p.effective_date <= a.date &&
      (!p.end_date || p.end_date >= a.date),
  );
  if (!policies.length)
    fail(
      409,
      'No insurance policy covers the new service date; review the visit account or self-pay plan',
    );
  if (
    policies.every(
      (p) =>
        [...state.finance.verifications]
          .reverse()
          .find(
            (v) =>
              v.policy_id === p.id &&
              v.policy_revision === p.revision &&
              v.service_date === a.date,
          )?.status === 'Inactive',
    )
  )
    fail(
      409,
      'Insurance is inactive for this service date; verify coverage before scheduling',
    );
}
function validatePlan(
  state: WorkflowState,
  ctx: WorkflowContext,
  a: Row,
  input: PlanInput | null | undefined,
) {
  coverage(state, a, input);
  if (!input) return;
  if (
    input.authorization_required &&
    input.services.some((s) => !s.approval_id)
  )
    fail(
      409,
      'Reserve an approved authorization for every required service before scheduling',
    );
  const old = state.operations.visit_plans.find(
    (p) => p.appointment_id === a.id,
  );
  if (old && (old.released || old.billing_account_id !== accountId(a)))
    fail(
      409,
      'Visit insurance changed; review its treatment plan before rescheduling',
    );
  saveVisitPlan(state, ctx, a, { ...input, revision: old?.revision });
}
function record(
  state: WorkflowState,
  ctx: WorkflowContext,
  a: Row,
  before: Row | null,
  action: string,
  reason: string,
  reminderUpdates: ScheduleHistory['reminder_updates'] = [],
) {
  const s = scheduling(state);
  s.appointment_revisions[a.id] = (s.appointment_revisions[a.id] || 0) + 1;
  s.history.push({
    id: ctx.id('sch'),
    appointment_id: a.id,
    action,
    reason,
    actor: ctx.user.name,
    at: ctx.now,
    before: before ? structuredClone(before) : null,
    after: structuredClone(a),
    ...(reminderUpdates.length ? { reminder_updates: reminderUpdates } : {}),
  });
  ctx.audit(`${action}: ${reason}`, a.id);
}
function move(
  state: WorkflowState,
  ctx: WorkflowContext,
  a: Row,
  target: { date: string; time: string; provider_id: string },
  reason: string,
) {
  beforeVisit(state, ctx, a);
  future(ctx, target.date, target.time);
  const clinician = provider(ctx, target.provider_id),
    before = structuredClone(a);
  const next = {
    ...a,
    date: target.date,
    time: target.time,
    provider_id: target.provider_id,
    provider: clinician.name,
  };
  if (appointmentScheduleSnapshot(next) === appointmentScheduleSnapshot(a))
    fail(400, 'Choose a different date, time or clinician');
  availability(ctx, next, a.id);
  const plan = state.operations.visit_plans.find(
    (p) => p.appointment_id === a.id,
  );
  validatePlan(state, ctx, next, plan);
  Object.assign(a, next);
  const reminderUpdates: NonNullable<ScheduleHistory['reminder_updates']> = [];
  const shiftedDays = Math.round(
    (Date.parse(`${a.date}T12:00:00Z`) -
      Date.parse(`${before.date}T12:00:00Z`)) /
      86400000,
  );
  // Outreach already recorded remains historical; clinical task follow-ups keep their own due dates.
  for (const reminder of state.reminders) {
    if (
      reminder.appointment_id !== a.id ||
      !['Scheduled', 'Ready'].includes(reminder.status)
    )
      continue;
    const previous = structuredClone(reminder);
    if (
      reminder.kind === 'Appointment confirmation' ||
      reminder.source_key === `appointment:${a.id}`
    ) {
      reminder.due_date = addCalendarDays(a.date, -1);
      reminder.message = `Please confirm your appointment on ${a.date} at ${a.time} Pacific time. Contact the practice if you need to make a change.`;
    } else {
      // Preserve the relative timing of any manually planned appointment outreach.
      reminder.due_date = addCalendarDays(reminder.due_date, shiftedDays);
      reminder.message = reminder.message
        .replaceAll(before.date, a.date)
        .replaceAll(before.time, a.time);
    }
    reminder.status = reminder.due_date <= ctx.today ? 'Ready' : 'Scheduled';
    reminderUpdates.push({
      id: reminder.id,
      before: previous,
      after: structuredClone(reminder),
    });
    ctx.audit(
      'Updated pending appointment reminder after rescheduling',
      reminder.id,
    );
  }
  record(
    state,
    ctx,
    a,
    before,
    'Rescheduled appointment',
    reason,
    reminderUpdates,
  );
  return a;
}
function getSource(
  state: WorkflowState,
  ctx: WorkflowContext,
  e: WaitlistEntry,
) {
  if (!e.appointment_id) return null;
  const a = appointment(ctx, e.appointment_id);
  beforeVisit(state, ctx, a);
  if (appointmentScheduleSnapshot(a) !== e.appointment_snapshot)
    fail(
      409,
      'The original appointment changed; cancel and recreate this waitlist request',
    );
  if (a.patient_id !== e.patient_id || accountId(a) !== e.billing_account_id)
    fail(409, 'The waitlist account no longer matches the original visit');
  return a;
}
function proposedVisit(
  state: WorkflowState,
  ctx: WorkflowContext,
  e: WaitlistEntry,
  slot: Row,
) {
  const source = getSource(state, ctx, e);
  return {
    source,
    plan: source
      ? state.operations.visit_plans.find((p) => p.appointment_id === source.id)
      : e.visit_plan,
    visit: {
      ...(source || {}),
      id: source?.id || `waitlist-preview-${e.id}`,
      patient_id: e.patient_id,
      billing_account_id: e.billing_account_id,
      date: slot.date,
      time: slot.time,
      duration: e.duration,
      provider_id: slot.provider_id,
      type: e.type,
      reason: e.reason,
      status: 'Scheduled',
    },
  };
}
function preferenceIssues(e: WaitlistEntry, slot: Row) {
  const issues: string[] = [];
  if (slot.date < e.earliest_date || slot.date > e.latest_date)
    issues.push('Outside preferred dates');
  if (e.provider_id && e.provider_id !== slot.provider_id)
    issues.push('Clinician does not match the preference');
  if (
    slot.time < e.earliest_time ||
    minutes(slot.time) + e.duration > minutes(e.latest_time)
  )
    issues.push('Outside preferred time window');
  if (slot.duration < e.duration) issues.push('Slot is too short');
  return issues;
}
function readyCandidate(
  state: WorkflowState,
  ctx: WorkflowContext,
  e: WaitlistEntry,
  slot: Row,
) {
  const blockers = preferenceIssues(e, slot),
    warnings: string[] = [];
  const p = patient(ctx, e.patient_id);
  try {
    const { visit, plan, source } = proposedVisit(state, ctx, e, slot);
    if (!plan)
      fail(409, 'Treatment authorization requirement has not been reviewed');
    provider(ctx, visit.provider_id);
    future(ctx, visit.date, visit.time);
    availability(ctx, visit, source?.id);
    // Preview reservations in isolation so GET and failed offers cannot reserve units.
    const staged = structuredClone(state),
      stagedCtx = {
        ...ctx,
        appointments: structuredClone(ctx.appointments),
        audit: () => {},
      };
    validatePlan(staged, stagedCtx, visit, plan);
    const account = patientAccount(
      state.finance,
      e.patient_id,
      e.billing_account_id,
      true,
    );
    if (
      account.workers_comp &&
      (account.workers_comp.claim_status !== 'Accepted' ||
        !account.workers_comp.accepted_body_parts.length)
    )
      warnings.push(
        'Workers compensation acceptance / accepted body parts need review',
      );
    if (plan.coverage_mode !== 'Self-pay') {
      const current = state.finance.policies.some(
        (policy) =>
          policy.patient_id === e.patient_id &&
          (policy.billing_account_id ||
            defaultPatientAccountId(e.patient_id)) === e.billing_account_id &&
          policy.effective_date <= slot.date &&
          (!policy.end_date || policy.end_date >= slot.date) &&
          (() => {
            const v = [...state.finance.verifications]
              .reverse()
              .find(
                (v) =>
                  v.policy_id === policy.id &&
                  v.policy_revision === policy.revision &&
                  v.service_date === slot.date,
              );
            return (
              v?.status === 'Active' &&
              Date.parse(ctx.now) - Date.parse(v.checked_at) <= 7 * 86400000
            );
          })(),
      );
      if (!current)
        warnings.push('Current service-date eligibility check needed');
    }
    const intake =
      source &&
      [...state.intakes]
        .reverse()
        .find((i) => i.appointment_id === source.id && i.status !== 'Revoked');
    if (!intake || !['Submitted', 'Reviewed'].includes(intake.status))
      warnings.push('Pre-visit intake not submitted');
    if (!p.phone || !p.address)
      warnings.push('Patient contact details incomplete');
    if (
      state.operations.incoming_faxes.some(
        (f) =>
          f.status === 'Filed' &&
          f.patient_id === e.patient_id &&
          (!f.billing_account_id ||
            f.billing_account_id === e.billing_account_id) &&
          !f.reviewed_at,
      )
    )
      warnings.push('Outside documents await clinician review');
  } catch (error) {
    blockers.push((error as Error).message);
  }
  return {
    waitlist_id: e.id,
    revision: e.revision,
    patient_name: `${p.first_name} ${p.last_name}`,
    priority: e.priority,
    ready: !blockers.length && !warnings.length,
    blockers: [...new Set(blockers)],
    warnings,
    issues: [...new Set([...blockers, ...warnings])],
  };
}
function validOffer(ctx: WorkflowContext, offer: WaitlistOffer) {
  return (
    offer.status === 'Active' &&
    Date.parse(offer.expires_at) > Date.parse(ctx.now)
  );
}
function slotAppointment(ctx: WorkflowContext, id: string, snapshot?: string) {
  const slot = appointment(ctx, id);
  if (slot.status !== 'Cancelled')
    fail(409, 'The cancellation slot is no longer available');
  if (snapshot !== undefined && appointmentScheduleSnapshot(slot) !== snapshot)
    fail(409, 'The cancellation slot changed; refresh available slots');
  future(ctx, slot.date, slot.time);
  provider(ctx, slot.provider_id);
  return slot;
}
function slotRows(state: WorkflowState, ctx: WorkflowContext) {
  const s = scheduling(state);
  return ctx.appointments
    .filter(
      (a) =>
        a.status === 'Cancelled' &&
        (a.date > ctx.today ||
          (a.date === ctx.today && a.time >= ctx.local_time.slice(0, 5))),
    )
    .filter((slot) => {
      try {
        slotAppointment(ctx, slot.id);
        // A replacement booking closes the entire cancellation slot.
        const probe = { ...slot, patient_id: '', status: 'Scheduled' };
        availability(ctx, probe);
        return !s.offers.some(
          (o) => o.slot_id === slot.id && o.status === 'Booked',
        );
      } catch {
        return false;
      }
    })
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
    .map((slot) => ({
      id: slot.id,
      date: slot.date,
      time: slot.time,
      duration: slot.duration,
      provider_id: slot.provider_id,
      provider: ctx.users.find((u) => u.id === slot.provider_id)?.name || '',
      snapshot: appointmentScheduleSnapshot(slot),
      offer:
        s.offers.find((o) => o.slot_id === slot.id && validOffer(ctx, o)) ||
        null,
      candidates: s.waitlist
        .filter(
          (e) =>
            e.status === 'Waiting' ||
            (e.status === 'Offered' &&
              !s.offers.some(
                (o) => o.waitlist_id === e.id && validOffer(ctx, o),
              )),
        )
        .map((e) => readyCandidate(state, ctx, e, slot))
        .filter(
          (c) =>
            !c.blockers.some((x) =>
              [
                'Outside preferred dates',
                'Clinician does not match the preference',
                'Outside preferred time window',
                'Slot is too short',
              ].includes(x),
            ),
        )
        .sort(
          (a, b) =>
            Number(b.ready) - Number(a.ready) ||
            Number(a.blockers.length > 0) - Number(b.blockers.length > 0) ||
            Number(b.priority === 'High') - Number(a.priority === 'High') ||
            a.patient_name.localeCompare(b.patient_name),
        ),
    }));
}
function expireOffers(state: WorkflowState, ctx: WorkflowContext) {
  const s = scheduling(state);
  for (const o of s.offers) {
    if (o.status !== 'Active') continue;
    const a = ctx.appointments.find((a) => a.id === o.slot_id);
    if (
      Date.parse(o.expires_at) <= Date.parse(ctx.now) ||
      !a ||
      a.status !== 'Cancelled' ||
      appointmentScheduleSnapshot(a) !== o.slot_snapshot ||
      a.date < ctx.today ||
      (a.date === ctx.today && a.time < ctx.local_time.slice(0, 5))
    ) {
      o.status = 'Expired';
      const e = s.waitlist.find((e) => e.id === o.waitlist_id);
      if (e?.status === 'Offered') e.status = 'Waiting';
      ctx.audit('Expired stale cancellation slot offer', o.id);
    }
  }
}
function reviewedWaitlistInput(
  state: WorkflowState,
  ctx: WorkflowContext,
  body: unknown,
  exceptId = '',
) {
  const v = waitlistInput.parse(body);
  patient(ctx, v.patient_id);
  patientAccount(state.finance, v.patient_id, v.billing_account_id, true);
  if (v.provider_id) provider(ctx, v.provider_id);
  if (
    v.latest_date < v.earliest_date ||
    v.latest_date > addCalendarDays(v.earliest_date, 365) ||
    v.latest_date < ctx.today
  )
    fail(400, 'Choose a current waitlist date range of no more than one year');
  if (minutes(v.latest_time) - minutes(v.earliest_time) < v.duration)
    fail(400, 'The preferred time window must fit the visit duration');
  let source: Row | null = null;
  if (v.appointment_id) {
    source = appointment(ctx, v.appointment_id);
    beforeVisit(state, ctx, source);
    if (
      source.patient_id !== v.patient_id ||
      accountId(source) !== v.billing_account_id
    )
      fail(
        400,
        'The original visit must match the patient and billing account',
      );
    if (
      source.duration !== v.duration ||
      source.type !== v.type ||
      source.reason !== v.reason
    )
      fail(
        400,
        'Keep the original visit duration, type and reason when joining its waitlist',
      );
    if (
      scheduling(state).waitlist.some(
        (e) =>
          e.id !== exceptId &&
          e.appointment_id === source!.id &&
          ['Waiting', 'Offered'].includes(e.status),
      )
    )
      fail(409, 'This appointment already has an active waitlist request');
  }
  return {
    ...v,
    visit_plan: v.visit_plan || null,
    appointment_snapshot: source ? appointmentScheduleSnapshot(source) : '',
  };
}
function dispatch(
  state: WorkflowState,
  ctx: WorkflowContext,
  method: string,
  url: URL,
  body: unknown,
): unknown {
  const [, resource, id, action] = url.pathname.split('/').filter(Boolean);
  const s = scheduling(state);
  if (method === 'GET' && !resource)
    return {
      ...s,
      waitlist: s.waitlist.map((e) => ({
        ...e,
        status:
          e.status === 'Offered' &&
          !s.offers.some((o) => o.waitlist_id === e.id && validOffer(ctx, o))
            ? 'Waiting'
            : e.status,
        patient_name: (() => {
          const p = patient(ctx, e.patient_id);
          return `${p.first_name} ${p.last_name}`;
        })(),
        account_name:
          state.finance.billing_accounts.find(
            (a) => a.id === e.billing_account_id,
          )?.name || 'Visit account',
      })),
      offers: s.offers.map((o) => {
        const entry = s.waitlist.find((e) => e.id === o.waitlist_id),
          slot = ctx.appointments.find((a) => a.id === o.slot_id);
        return {
          ...o,
          status:
            o.status === 'Active' && !validOffer(ctx, o) ? 'Expired' : o.status,
          readiness:
            entry && slot && validOffer(ctx, o)
              ? readyCandidate(state, ctx, entry, slot)
              : null,
        };
      }),
      slots: slotRows(state, ctx),
      appointments: ctx.appointments
        .filter((a) => a.status === 'Scheduled')
        .map((a) => ({
          ...a,
          ...(() => {
            const p = patient(ctx, a.patient_id);
            return { first_name: p.first_name, last_name: p.last_name };
          })(),
        })),
    };
  if (resource === 'appointments') {
    const a = appointment(ctx, id);
    if (method === 'GET' && !action)
      return {
        appointment: a,
        snapshot: appointmentScheduleSnapshot(a),
        revision: s.appointment_revisions[a.id] || 0,
        plan:
          state.operations.visit_plans.find((p) => p.appointment_id === a.id) ||
          null,
        history: s.history.filter((h) => h.appointment_id === a.id),
      };
    if (method === 'POST' && action === 'reschedule') {
      const v = z
        .object({
          snapshot: z.string(),
          revision: z.number().int().nonnegative(),
          date: schedulingDate,
          time,
          provider_id: short,
          reason: z.string().trim().min(5).max(1000),
        })
        .parse(body);
      if (
        v.revision !== (s.appointment_revisions[a.id] || 0) ||
        v.snapshot !== appointmentScheduleSnapshot(a)
      )
        fail(409, 'Appointment changed; reload before rescheduling');
      return move(state, ctx, a, v, v.reason);
    }
  }
  if (resource === 'series' && method === 'POST' && !id) {
    const v = appointmentInput
      .extend({
        count: z.number().int().min(2).max(24),
        interval: z.enum(['Weekly', 'Biweekly']),
        visit_plan: visitPlanInput,
      })
      .parse(body);
    const p = patient(ctx, v.patient_id),
      clinician = provider(ctx, v.provider_id);
    patientAccount(state.finance, p.id, v.billing_account_id, true);
    const series: RecurringSeries = {
      id: ctx.id('series'),
      patient_id: p.id,
      billing_account_id: v.billing_account_id,
      interval: v.interval,
      count: v.count,
      appointment_ids: [],
      created_at: ctx.now,
      created_by: ctx.user.name,
    };
    for (let i = 0; i < v.count; i++) {
      const a = {
        id: ctx.id('apt'),
        patient_id: p.id,
        billing_account_id: v.billing_account_id,
        provider_id: clinician.id,
        provider: clinician.name,
        date: addCalendarDays(v.date, i * (v.interval === 'Weekly' ? 7 : 14)),
        time: v.time,
        duration: v.duration,
        type: v.type,
        reason: v.reason,
        status: 'Scheduled',
      };
      future(ctx, a.date, a.time);
      availability(ctx, a);
      validatePlan(state, ctx, a, v.visit_plan);
      ctx.appointments.push(a);
      series.appointment_ids.push(a.id);
      record(
        state,
        ctx,
        a,
        null,
        'Created recurring appointment',
        `Series ${series.id}, occurrence ${i + 1} of ${v.count}`,
      );
    }
    s.series.push(series);
    ctx.audit('Created reviewed recurring appointment series', series.id);
    return series;
  }
  if (resource === 'waitlist') {
    if (method === 'POST' && !id) {
      const entry: WaitlistEntry = {
        ...reviewedWaitlistInput(state, ctx, body),
        id: ctx.id('wait'),
        revision: 1,
        created_at: ctx.now,
        created_by: ctx.user.name,
        status: 'Waiting',
        booked_appointment_id: '',
      };
      s.waitlist.push(entry);
      ctx.audit('Added patient to manual cancellation waitlist', entry.id);
      return entry;
    }
    const e =
      s.waitlist.find((e) => e.id === id) ||
      fail(404, 'Waitlist request not found');
    const expected = z
      .object({ revision: z.number().int().positive() })
      .parse(body);
    if (expected.revision !== e.revision)
      fail(409, 'Waitlist request changed; refresh before continuing');
    if (method === 'PATCH' && !action) {
      if (!(body && typeof body === 'object' && 'status' in body)) {
        if (e.status !== 'Waiting')
          fail(
            409,
            'Only waiting requests can be updated; cancel and recreate a request with an active offer',
          );
        Object.assign(e, reviewedWaitlistInput(state, ctx, body, e.id));
        e.revision++;
        ctx.audit(
          'Reviewed and updated cancellation waitlist preferences and service plan',
          e.id,
        );
        return e;
      }
      const v = z.object({ status: z.literal('Cancelled') }).parse(body);
      if (!['Waiting', 'Offered'].includes(e.status))
        fail(409, 'This waitlist request is already closed');
      e.status = v.status;
      e.revision++;
      for (const offer of s.offers.filter(
        (o) => o.waitlist_id === e.id && o.status === 'Active',
      ))
        offer.status = 'Cancelled';
      ctx.audit(
        'Cancelled manual waitlist request and released its offer',
        e.id,
      );
      return e;
    }
    if (method === 'POST' && action === 'offer') {
      const v = z
        .object({ slot_id: short, slot_snapshot: z.string() })
        .parse(body);
      if (!['Waiting', 'Offered'].includes(e.status))
        fail(409, 'The waitlist request is no longer waiting');
      const slot = slotAppointment(ctx, v.slot_id, v.slot_snapshot);
      if (
        s.offers.some(
          (o) =>
            validOffer(ctx, o) &&
            (o.slot_id === slot.id || o.waitlist_id === e.id),
        )
      )
        fail(409, 'The slot or patient already has an active offer');
      if (s.offers.some((o) => o.slot_id === slot.id && o.status === 'Booked'))
        fail(409, 'This cancellation slot has already been booked');
      const candidate = readyCandidate(state, ctx, e, slot);
      if (candidate.blockers.length) fail(409, candidate.blockers.join('; '));
      const o: WaitlistOffer = {
        id: ctx.id('offer'),
        waitlist_id: e.id,
        slot_id: slot.id,
        slot_snapshot: v.slot_snapshot,
        status: 'Active',
        created_at: ctx.now,
        created_by: ctx.user.name,
        expires_at: new Date(Date.parse(ctx.now) + 48 * 3600000).toISOString(),
        booked_appointment_id: '',
      };
      e.status = 'Offered';
      e.revision++;
      s.offers.push(o);
      ctx.audit('Recorded manual demo slot offer; no message sent', o.id);
      return o;
    }
    if (method === 'POST' && action === 'book') {
      const v = z
        .object({
          offer_id: short,
          readiness_acknowledged: z.boolean().default(false),
        })
        .parse(body);
      const offer =
        s.offers.find((o) => o.id === v.offer_id && o.waitlist_id === e.id) ||
        fail(404, 'Waitlist offer not found');
      if (!validOffer(ctx, offer) || e.status !== 'Offered')
        fail(
          409,
          'The offer expired or was already handled; refresh the waitlist',
        );
      const slot = slotAppointment(ctx, offer.slot_id, offer.slot_snapshot);
      if (
        s.offers.some(
          (o) =>
            o.slot_id === slot.id &&
            o.id !== offer.id &&
            (validOffer(ctx, o) || o.status === 'Booked'),
        )
      )
        fail(409, 'Another offer or booking now holds this slot');
      const candidate = readyCandidate(state, ctx, e, slot);
      if (candidate.blockers.length) fail(409, candidate.blockers.join('; '));
      if (candidate.warnings.length && !v.readiness_acknowledged)
        fail(
          409,
          'Review and acknowledge the outstanding readiness items before booking',
        );
      const { source, plan, visit } = proposedVisit(state, ctx, e, slot);
      let booked: Row;
      if (source)
        booked = move(
          state,
          ctx,
          source,
          visit as { date: string; time: string; provider_id: string },
          'Patient accepted manual cancellation waitlist offer',
        );
      else {
        booked = {
          ...visit,
          id: ctx.id('apt'),
          provider: provider(ctx, visit.provider_id).name,
        };
        availability(ctx, booked);
        validatePlan(state, ctx, booked, plan);
        ctx.appointments.push(booked);
        record(
          state,
          ctx,
          booked,
          null,
          'Booked cancellation waitlist appointment',
          'Staff confirmed patient acceptance of the manual offer',
        );
      }
      e.status = 'Booked';
      e.revision++;
      e.booked_appointment_id = booked.id;
      offer.status = 'Booked';
      offer.booked_appointment_id = booked.id;
      ctx.audit(
        candidate.warnings.length
          ? 'Confirmed manual waitlist booking with readiness follow-up acknowledged'
          : 'Confirmed manual waitlist booking',
        booked.id,
      );
      return booked;
    }
  }
  fail(404, 'Scheduling workflow not found');
}

/** Stage a complete command so late conflicts never leave partial recurring bookings or reservations. */
export function scheduleWorkflowRequest(
  state: WorkflowState,
  ctx: WorkflowContext,
  method: string,
  url: URL,
  body: unknown = {},
) {
  if (!['clinician', 'receptionist'].includes(ctx.user.role))
    fail(403, 'Practice staff access required');
  if (url.pathname.split('/').filter(Boolean)[0] !== 'scheduling')
    fail(404, 'Scheduling workflow not found');
  const staged = structuredClone(state);
  (staged as WorkflowState & { scheduling: SchedulingState }).scheduling = {
    ...emptySchedulingState(),
    ...structuredClone(scheduling(state) || {}),
  };
  const audits: [string, string][] = [];
  const stagedCtx = {
    ...ctx,
    appointments: structuredClone(ctx.appointments),
    audit: (action: string, resource: string) =>
      audits.push([action, resource]),
  };
  ensurePatientAccounts(staged.finance, stagedCtx);
  if (method !== 'GET') expireOffers(staged, stagedCtx);
  const result = dispatch(staged, stagedCtx, method, url, body);
  if (method !== 'GET') {
    Object.assign(state, staged);
    ctx.appointments.splice(
      0,
      ctx.appointments.length,
      ...stagedCtx.appointments,
    );
    for (const [action, resource] of audits) ctx.audit(action, resource);
  }
  return structuredClone(result);
}
