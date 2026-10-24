import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  emptyWorkflowState,
  runAutomation,
  type WorkflowContext,
} from '../server/workflow-engine.js';
import {
  emptySchedulingState,
  scheduleWorkflowRequest,
} from '../server/schedule-workflows.js';
import { saveVisitPlan } from '../server/operations-engine.js';
import { createDatabase } from '../server/database.js';
import { createPlatformApp } from '../server/platform.js';
import { loadWorkflow } from '../server/workflows.js';

function fixture() {
  const state = Object.assign(emptyWorkflowState(), {
    scheduling: emptySchedulingState(),
  });
  const audits: { action: string; resource: string }[] = [];
  let sequence = 0;
  const ctx: WorkflowContext = {
    user: {
      id: 'front',
      name: 'Synthetic Front Desk',
      email: 'front@example.test',
      role: 'receptionist',
    },
    users: [
      {
        id: 'doctor-1',
        name: 'Dr. One',
        email: 'one@example.test',
        role: 'clinician',
        is_active: true,
      },
      {
        id: 'doctor-2',
        name: 'Dr. Two',
        email: 'two@example.test',
        role: 'clinician',
        is_active: true,
      },
    ],
    patients: [
      {
        id: 'patient-1',
        first_name: 'Synthetic',
        last_name: 'One',
        dob: '1980-01-01',
        phone: '555-0101',
        address: '1 Test Street',
      },
      {
        id: 'patient-2',
        first_name: 'Synthetic',
        last_name: 'Two',
        dob: '1981-01-01',
        phone: '555-0102',
        address: '2 Test Street',
      },
    ],
    appointments: [],
    encounters: [],
    tasks: [],
    labs: [],
    now: '2030-01-01T16:00:00.000Z',
    today: '2030-01-01',
    local_time: '08:00',
    id: (prefix) => `${prefix}-schedule-${++sequence}`,
    audit: (action, resource) => audits.push({ action, resource }),
  };
  for (const p of ctx.patients) {
    state.finance.billing_accounts.push({
      id: `pba-private-${p.id}`,
      patient_id: p.id,
      name: 'Synthetic private account',
      kind: 'Private insurance',
      status: 'Active',
      workers_comp: null,
      revision: 1,
      created_at: ctx.now,
      updated_at: ctx.now,
    });
    state.finance.policies.push({
      id: `policy-${p.id}`,
      patient_id: p.id,
      billing_account_id: `pba-private-${p.id}`,
      payer: 'Synthetic payer',
      plan: 'Synthetic coverage',
      member_id: `member-${p.id}`,
      group_number: '',
      priority: 'Primary',
      subscriber_name: `${p.first_name} ${p.last_name}`,
      subscriber_dob: p.dob,
      relationship: 'Self',
      effective_date: '2029-01-01',
      end_date: '2031-12-31',
      revision: 1,
      updated_at: ctx.now,
    });
  }
  function call(path = '', method = 'GET', body?: unknown): any {
    return scheduleWorkflowRequest(
      state,
      ctx,
      method,
      new URL(`http://example.test/scheduling${path}`),
      body,
    );
  }
  function appointment(
    overrides: Record<string, unknown> = {},
  ): Record<string, any> {
    const a = {
      id: `appointment-${ctx.appointments.length + 1}`,
      patient_id: 'patient-1',
      billing_account_id: 'pba-private-patient-1',
      date: '2030-01-07',
      time: '09:00',
      duration: 30,
      type: 'Follow-up',
      reason: 'Synthetic follow-up',
      status: 'Scheduled',
      provider_id: 'doctor-1',
      ...overrides,
    };
    ctx.appointments.push(a);
    return a;
  }
  function approve(quantity = 3, end = '2030-12-31') {
    state.finance.authorizations.push({
      id: 'authorization-1',
      patient_id: 'patient-1',
      policy_id: 'policy-patient-1',
      policy_revision: 1,
      procedure_codes: ['99213'],
      description: 'Synthetic office reviews',
      requested_visits: quantity,
      approved_visits: quantity,
      valid_from: '2030-01-01',
      valid_to: end,
      due_date: '2030-01-01',
      owner_id: 'doctor-1',
      revision: 1,
      status: 'Demo approved',
      approval_number: 'DEMO-AUTH-1',
      decision_note: 'Synthetic approval',
      created_at: ctx.now,
      updated_at: ctx.now,
      history: [],
    });
    state.operations.service_approvals.push({
      id: 'approval-1',
      authorization_id: 'authorization-1',
      patient_id: 'patient-1',
      billing_account_id: 'pba-private-patient-1',
      policy_id: 'policy-patient-1',
      policy_revision: 1,
      procedure_code: '99213',
      category: 'Office visit',
      description: 'Office review',
      unit: 'Visits',
      approved_quantity: quantity,
      revision: 1,
      history: [],
    });
    return {
      authorization_required: true,
      coverage_mode: 'Insurance' as const,
      services: [
        { approval_id: 'approval-1', procedure_code: '99213', quantity: 1 },
      ],
    };
  }
  const reviewedPlan = {
    authorization_required: false,
    coverage_mode: 'Insurance' as const,
    services: [],
  };
  function reschedule(id: string, extra: Record<string, unknown> = {}) {
    const current = call(`/appointments/${id}`);
    return call(`/appointments/${id}/reschedule`, 'POST', {
      snapshot: current.snapshot,
      revision: current.revision,
      date: '2030-01-08',
      time: '10:00',
      provider_id: 'doctor-2',
      reason: 'Patient requested another time',
      ...extra,
    });
  }
  function waitlist(extra: Record<string, unknown> = {}) {
    return call('/waitlist', 'POST', {
      patient_id: 'patient-1',
      billing_account_id: 'pba-private-patient-1',
      provider_id: '',
      earliest_date: '2030-01-02',
      latest_date: '2030-01-31',
      earliest_time: '08:00',
      latest_time: '17:00',
      duration: 30,
      type: 'Follow-up',
      reason: 'Synthetic waitlist request',
      priority: 'Routine',
      appointment_id: '',
      visit_plan: reviewedPlan,
      ...extra,
    });
  }
  function snapshot() {
    return JSON.stringify({
      state,
      appointments: ctx.appointments,
      audits,
    });
  }
  return {
    state,
    ctx,
    audits,
    call,
    appointment,
    approve,
    reviewedPlan,
    reschedule,
    waitlist,
    snapshot,
  };
}

function conflict(fn: () => unknown, text?: RegExp) {
  assert.throws(fn, (e: any) => {
    assert.equal(e.status, 409, e.message);
    if (text) assert.match(e.message, text);
    return true;
  });
}

test('rescheduling preserves the appointment, account, intake and treatment reservation while retaining a staff audit', () => {
  const f = fixture();
  const original = f.appointment();
  saveVisitPlan(f.state, f.ctx, original, f.approve());
  f.state.intakes.push({
    id: 'intake-1',
    patient_id: 'patient-1',
    appointment_id: original.id,
    status: 'Reviewed',
    token_hash: 'synthetic-hash',
    expires_at: '2030-01-31T00:00:00.000Z',
    created_at: f.ctx.now,
    issuer_id: 'front',
  });
  const stale = f.call(`/appointments/${original.id}`);
  f.reschedule(original.id);
  const saved = f.ctx.appointments.find((a) => a.id === original.id)!;
  assert.equal(f.ctx.appointments.length, 1);
  assert.equal(saved.date, '2030-01-08');
  assert.equal(saved.time, '10:00');
  assert.equal(saved.provider_id, 'doctor-2');
  assert.equal(saved.billing_account_id, original.billing_account_id);
  assert.equal(saved.reason, 'Synthetic follow-up');
  assert.equal(saved.type, 'Follow-up');
  assert.equal(saved.snapshot, undefined);
  assert.equal(saved.revision, undefined);
  assert.equal(f.state.intakes[0].appointment_id, original.id);
  assert.equal(f.state.operations.visit_plans.length, 1);
  assert.equal(
    f.state.operations.visit_plans[0].services[0].approval_id,
    'approval-1',
  );
  assert.ok(f.audits.some((a) => /reschedul/i.test(a.action)));
  const before = f.snapshot();
  conflict(() =>
    f.call(`/appointments/${original.id}/reschedule`, 'POST', {
      snapshot: stale.snapshot,
      revision: stale.revision,
      date: '2030-01-09',
      time: '11:00',
      provider_id: 'doctor-1',
      reason: 'Stale browser tab attempted to overwrite a move',
    }),
  );
  assert.equal(f.snapshot(), before);
});

test('rescheduling refreshes pending confirmation details and readiness while preserving completed outreach and clinical follow-ups', () => {
  const f = fixture(),
    original = f.appointment({ date: '2030-01-02' });
  saveVisitPlan(f.state, f.ctx, original, f.reviewedPlan);
  runAutomation(f.state, f.ctx);
  const reminder = f.state.reminders.find(
    (r) => r.source_key === `appointment:${original.id}`,
  )!;
  assert.equal(reminder.due_date, '2030-01-01');
  assert.equal(reminder.status, 'Ready');
  assert.match(reminder.message, /2030-01-02 at 09:00/);
  f.state.reminders.push(
    {
      ...structuredClone(reminder),
      id: 'completed-confirmation',
      source_key: 'completed-outreach',
      status: 'Manual outreach recorded',
      completed_at: f.ctx.now,
    },
    {
      ...structuredClone(reminder),
      id: 'cancelled-confirmation',
      source_key: 'cancelled-outreach',
      status: 'Cancelled',
      completed_at: f.ctx.now,
    },
    {
      ...structuredClone(reminder),
      id: 'clinical-followup',
      appointment_id: undefined,
      task_id: 'clinical-task',
      kind: 'Follow-up',
      source_key: 'followup:clinical-task',
      due_date: '2030-01-05',
      message: 'Clinical follow-up agreed for January 5',
      status: 'Scheduled',
    },
    {
      ...structuredClone(reminder),
      id: 'custom-outreach',
      kind: 'Manual appointment outreach',
      source_key: 'custom:appointment',
      due_date: '2030-01-04',
      message: 'Call about 2030-01-02 at 09:00',
      status: 'Scheduled',
    },
  );
  const untouched = structuredClone(
    f.state.reminders.filter((r) =>
      [
        'completed-confirmation',
        'cancelled-confirmation',
        'clinical-followup',
      ].includes(r.id),
    ),
  );
  f.reschedule(original.id);
  const refreshed = f.state.reminders.find((r) => r.id === reminder.id)!;
  assert.equal(refreshed.due_date, '2030-01-07');
  assert.equal(refreshed.status, 'Scheduled');
  assert.match(refreshed.message, /2030-01-08 at 10:00 Pacific time/);
  assert.doesNotMatch(refreshed.message, /2030-01-02|09:00/);
  assert.equal(refreshed.channel, reminder.channel);
  assert.equal(refreshed.source_key, reminder.source_key);
  assert.deepEqual(
    f.state.reminders.filter((r) => untouched.some((old) => old.id === r.id)),
    untouched,
  );
  const custom = f.state.reminders.find((r) => r.id === 'custom-outreach')!;
  assert.equal(custom.due_date, '2030-01-10');
  assert.equal(custom.message, 'Call about 2030-01-08 at 10:00');
  assert.equal(custom.status, 'Scheduled');
  const history = f.state.scheduling.history.at(-1)!;
  assert.equal(history.reminder_updates?.length, 2);
  assert.equal(
    history.reminder_updates?.find((r) => r.id === reminder.id)?.before.status,
    'Ready',
  );
  assert.equal(
    history.reminder_updates?.find((r) => r.id === reminder.id)?.after.due_date,
    '2030-01-07',
  );
  assert.ok(
    f.audits.some(
      (a) =>
        a.resource === reminder.id &&
        /updated pending appointment reminder/i.test(a.action),
    ),
  );
  const count = f.state.reminders.length;
  runAutomation(f.state, f.ctx);
  assert.equal(f.state.reminders.length, count);
  assert.match(
    f.state.reminders.find((r) => r.id === reminder.id)!.message,
    /2030-01-08 at 10:00/,
  );
  // Moving closer makes the same retained confirmation due now again.
  f.reschedule(original.id, { date: '2030-01-02', time: '11:00' });
  const ready = f.state.reminders.find((r) => r.id === reminder.id)!;
  assert.equal(ready.due_date, '2030-01-01');
  assert.equal(ready.status, 'Ready');
  assert.match(ready.message, /2030-01-02 at 11:00/);
});

test('rescheduling detects changed calendar data and partial provider overlap without leaving mutations', () => {
  const f = fixture();
  const a = f.appointment();
  const old = f.call(`/appointments/${a.id}`);
  f.ctx.appointments[0].billing_account_id = 'account-changed-elsewhere';
  const changed = f.snapshot();
  conflict(() =>
    f.call(`/appointments/${a.id}/reschedule`, 'POST', {
      snapshot: old.snapshot,
      revision: old.revision,
      date: '2030-01-08',
      time: '10:00',
      provider_id: 'doctor-2',
      reason: 'Patient requested another time',
    }),
  );
  assert.equal(f.snapshot(), changed);
  f.ctx.appointments[0].billing_account_id = 'pba-private-patient-1';
  f.appointment({
    patient_id: 'patient-2',
    billing_account_id: 'pba-private-patient-2',
    date: '2030-01-08',
    time: '10:15',
    provider_id: 'doctor-2',
  });
  const before = f.snapshot();
  conflict(() => f.reschedule(a.id), /overlap|available|booked/i);
  assert.equal(f.snapshot(), before);
});

test('encounters and started visit stages prevent moving clinical work to a different service date', () => {
  for (const startedBy of ['encounter', 'stage', 'status']) {
    const f = fixture();
    const a = f.appointment();
    if (startedBy === 'encounter')
      f.ctx.encounters.push({
        id: 'encounter-1',
        appointment_id: a.id,
        patient_id: a.patient_id,
        status: 'Draft',
      });
    else if (startedBy === 'stage')
      f.state.visits[a.id] = {
        stage: 'With clinician',
        room: '1',
        entered_at: f.ctx.now,
        started_at: f.ctx.now,
      };
    else a.status = 'In progress';
    const before = f.snapshot();
    conflict(() => f.reschedule(a.id), /start|encounter|visit|reschedul/i);
    assert.equal(f.snapshot(), before, startedBy);
  }
});

test('moving a visit revalidates authorization dates and the current billing account coverage', () => {
  for (const invalidation of ['authorization', 'policy', 'account']) {
    const f = fixture();
    const a = f.appointment();
    saveVisitPlan(
      f.state,
      f.ctx,
      a,
      f.approve(3, invalidation === 'authorization' ? a.date : '2030-12-31'),
    );
    if (invalidation === 'policy')
      f.state.finance.policies[0].end_date = a.date;
    if (invalidation === 'account')
      f.state.finance.billing_accounts[0].status = 'Closed';
    const before = f.snapshot();
    conflict(() => f.reschedule(a.id));
    assert.equal(f.snapshot(), before, invalidation);
  }
});

test('a recurring series creates separately reserved service plans on exact weekly dates', () => {
  const f = fixture();
  const plan = f.approve(3);
  const result = f.call('/series', 'POST', {
    patient_id: 'patient-1',
    billing_account_id: 'pba-private-patient-1',
    provider_id: 'doctor-1',
    date: '2030-01-07',
    time: '09:00',
    duration: 30,
    type: 'Follow-up',
    reason: 'Three synthetic authorized office reviews',
    count: 3,
    interval: 'Weekly',
    visit_plan: plan,
  });
  assert.equal(result.appointment_ids.length, 3);
  assert.deepEqual(
    f.ctx.appointments.map((a) => a.date),
    ['2030-01-07', '2030-01-14', '2030-01-21'],
  );
  assert.equal(new Set(result.appointment_ids).size, 3);
  assert.equal(f.state.operations.visit_plans.length, 3);
  for (const p of f.state.operations.visit_plans) {
    assert.ok(result.appointment_ids.includes(p.appointment_id));
    assert.equal(p.billing_account_id, 'pba-private-patient-1');
    assert.deepEqual(p.services, plan.services);
  }
  const before = f.snapshot();
  conflict(
    () =>
      f.call('/series', 'POST', {
        patient_id: 'patient-1',
        billing_account_id: 'pba-private-patient-1',
        provider_id: 'doctor-2',
        date: '2030-02-01',
        time: '09:00',
        duration: 30,
        type: 'Follow-up',
        reason: 'Attempt to reserve treatments already held by this series',
        count: 2,
        interval: 'Biweekly',
        visit_plan: plan,
      }),
    /approv|remain|quantity|reserve/i,
  );
  assert.equal(f.snapshot(), before);
});

test('recurring booking rolls back every occurrence when later authorization units or a later calendar slot fail', () => {
  for (const problem of ['units', 'overlap', 'coverage']) {
    const f = fixture();
    const plan = f.approve(problem === 'units' ? 2 : 3);
    if (problem === 'overlap')
      f.appointment({
        patient_id: 'patient-2',
        billing_account_id: 'pba-private-patient-2',
        date: '2030-01-21',
        time: '09:15',
      });
    if (problem === 'coverage')
      f.state.finance.policies[0].end_date = '2030-01-15';
    const before = f.snapshot();
    conflict(() =>
      f.call('/series', 'POST', {
        patient_id: 'patient-1',
        billing_account_id: 'pba-private-patient-1',
        provider_id: 'doctor-1',
        date: '2030-01-07',
        time: '09:00',
        duration: 30,
        type: 'Follow-up',
        reason: 'Atomic recurring reservation test',
        count: 3,
        interval: 'Weekly',
        visit_plan: plan,
      }),
    );
    assert.equal(f.snapshot(), before, problem);
  }
});

test('series sizes and unsupported intervals are bounded before any appointments are saved', () => {
  for (const values of [
    { count: 25, interval: 'Weekly' },
    { count: 0, interval: 'Weekly' },
    { count: 3, interval: 'Daily' },
  ]) {
    const f = fixture();
    const before = f.snapshot();
    assert.throws(() =>
      f.call('/series', 'POST', {
        patient_id: 'patient-1',
        billing_account_id: 'pba-private-patient-1',
        provider_id: 'doctor-1',
        date: '2030-01-07',
        time: '09:00',
        duration: 30,
        type: 'Follow-up',
        reason: 'Invalid recurrence',
        visit_plan: f.reviewedPlan,
        ...values,
      }),
    );
    assert.equal(f.snapshot(), before);
  }
});

test('cancellation offers are explicit, protect a slot from competing offers and never send messages', () => {
  const f = fixture();
  f.appointment({
    id: 'cancelled-slot',
    patient_id: 'patient-2',
    billing_account_id: 'pba-private-patient-2',
    status: 'Cancelled',
  });
  const first = f.waitlist({ priority: 'High' });
  const second = f.waitlist();
  const slot = f.call().slots[0];
  assert.ok(slot, 'A future cancelled appointment exposes a replacement slot');
  assert.equal(f.ctx.appointments.length, 1, 'Listing candidates never books');
  const offered = f.call(`/waitlist/${first.id}/offer`, 'POST', {
    revision: first.revision,
    slot_id: slot.id,
    slot_snapshot: slot.snapshot,
  });
  assert.ok(offered.id);
  const before = f.snapshot();
  conflict(() =>
    f.call(`/waitlist/${second.id}/offer`, 'POST', {
      revision: second.revision,
      slot_id: slot.id,
      slot_snapshot: slot.snapshot,
    }),
  );
  assert.equal(f.snapshot(), before);
  const current = f.call().waitlist.find((w: any) => w.id === first.id);
  conflict(
    () =>
      f.call(`/waitlist/${first.id}/book`, 'POST', {
        revision: current.revision,
        offer_id: offered.id,
      }),
    /readiness|review|acknowledg|intake|coverage/i,
  );
  const booked = f.call(`/waitlist/${first.id}/book`, 'POST', {
    revision: current.revision,
    offer_id: offered.id,
    readiness_acknowledged: true,
  });
  const created = f.ctx.appointments.find(
    (a) => a.id === (booked.appointment_id || booked.id),
  );
  assert.ok(
    created,
    'Only explicit staff confirmation creates the appointment',
  );
  assert.equal(created.patient_id, first.patient_id);
  assert.equal(created.date, slot.date);
  assert.equal(created.time, slot.time);
  assert.equal(created.billing_account_id, first.billing_account_id);
  assert.equal(f.state.reminders.length, 0);
  assert.equal(f.state.finance.fax_jobs.length, 0);
  const afterBooking = f.snapshot();
  conflict(() =>
    f.call(`/waitlist/${first.id}/book`, 'POST', {
      revision: current.revision,
      offer_id: offered.id,
      readiness_acknowledged: true,
    }),
  );
  assert.equal(f.snapshot(), afterBooking);
});

test('an offered cancellation slot is rechecked at confirmation after another calendar change', () => {
  const f = fixture();
  f.appointment({ id: 'cancelled-slot', status: 'Cancelled' });
  const waiting = f.waitlist();
  const slot = f.call().slots[0];
  const offered = f.call(`/waitlist/${waiting.id}/offer`, 'POST', {
    revision: waiting.revision,
    slot_id: slot.id,
    slot_snapshot: slot.snapshot,
  });
  const current = f.call().waitlist.find((w: any) => w.id === waiting.id);
  f.appointment({
    id: 'booked-by-another-user',
    patient_id: 'patient-2',
    billing_account_id: 'pba-private-patient-2',
    date: slot.date,
    time: slot.time,
    provider_id: slot.provider_id,
  });
  const before = f.snapshot();
  conflict(
    () =>
      f.call(`/waitlist/${waiting.id}/book`, 'POST', {
        revision: current.revision,
        offer_id: offered.id,
        readiness_acknowledged: true,
      }),
    /slot|overlap|available|booked/i,
  );
  assert.equal(f.snapshot(), before);
});

test('waitlist readiness uses the account and service date rather than a different insurance account', () => {
  const f = fixture();
  f.appointment({ id: 'cancelled-slot', status: 'Cancelled' });
  const waiting = f.waitlist();
  f.state.finance.policies[0].end_date = '2030-01-06';
  const slot = f.call().slots[0];
  const before = f.snapshot();
  conflict(
    () =>
      f.call(`/waitlist/${waiting.id}/offer`, 'POST', {
        revision: waiting.revision,
        slot_id: slot.id,
        slot_snapshot: slot.snapshot,
      }),
    /cover|insurance|policy|ready/i,
  );
  assert.equal(f.snapshot(), before);
});

test('a ready waitlist candidate moves its original visit and retains submitted intake and reserved treatment', () => {
  const f = fixture();
  f.appointment({
    id: 'cancelled-slot',
    patient_id: 'patient-2',
    billing_account_id: 'pba-private-patient-2',
    status: 'Cancelled',
  });
  const source = f.appointment({
    id: 'source-visit',
    date: '2030-01-21',
  });
  saveVisitPlan(f.state, f.ctx, source, f.approve(1));
  f.state.intakes.push({
    id: 'source-intake',
    patient_id: source.patient_id,
    appointment_id: source.id,
    status: 'Submitted',
    token_hash: 'synthetic-hash',
    expires_at: '2030-01-31T00:00:00.000Z',
    created_at: f.ctx.now,
    issuer_id: 'front',
    answers: {
      concern: 'Original submitted concern',
      symptoms: 'Synthetic patient report',
      allergies: [],
      medications: [],
      reminder_consent: false,
    },
  });
  f.state.finance.verifications.push({
    id: 'target-date-eligibility',
    policy_id: 'policy-patient-1',
    policy_revision: 1,
    service_date: '2030-01-07',
    status: 'Active',
    source: 'Demo payer',
    copay_cents: 0,
    deductible_remaining_cents: 0,
    coinsurance_percent: 0,
    reference: 'DEMO-ELIGIBILITY',
    checked_at: f.ctx.now,
    checked_by: f.ctx.user.name,
  });
  const waiting = f.waitlist({
    appointment_id: source.id,
    reason: source.reason,
  });
  const slot = f.call().slots[0];
  const candidate = slot.candidates.find(
    (c: any) => c.waitlist_id === waiting.id,
  );
  assert.equal(candidate.ready, true);
  assert.deepEqual(candidate.blockers, []);
  assert.deepEqual(candidate.warnings, []);
  const offer = f.call(`/waitlist/${waiting.id}/offer`, 'POST', {
    revision: waiting.revision,
    slot_id: slot.id,
    slot_snapshot: slot.snapshot,
  });
  const refreshed = f.call().waitlist.find((w: any) => w.id === waiting.id);
  const moved = f.call(`/waitlist/${waiting.id}/book`, 'POST', {
    revision: refreshed.revision,
    offer_id: offer.id,
  });
  assert.equal(moved.id, source.id);
  assert.equal(moved.date, slot.date);
  assert.equal(f.ctx.appointments.length, 2);
  assert.equal(f.state.operations.visit_plans.length, 1);
  assert.equal(f.state.operations.visit_plans[0].appointment_id, source.id);
  assert.equal(f.state.operations.visit_plans[0].services[0].quantity, 1);
  assert.equal(f.state.intakes[0].appointment_id, source.id);
  assert.equal(
    f.state.intakes[0].answers?.concern,
    'Original submitted concern',
  );
});

test('expired manual offers cannot book and a refreshed request can explicitly offer the slot again', () => {
  const f = fixture();
  f.appointment({ id: 'cancelled-slot', status: 'Cancelled' });
  const waiting = f.waitlist();
  const slot = f.call().slots[0];
  const offer = f.call(`/waitlist/${waiting.id}/offer`, 'POST', {
    revision: waiting.revision,
    slot_id: slot.id,
    slot_snapshot: slot.snapshot,
  });
  f.ctx.now = '2030-01-04T16:00:00.000Z';
  f.ctx.today = '2030-01-04';
  const refreshed = f.call();
  assert.equal(
    refreshed.offers.find((o: any) => o.id === offer.id).status,
    'Expired',
  );
  const current = refreshed.waitlist.find((w: any) => w.id === waiting.id);
  assert.equal(current.status, 'Waiting');
  const before = f.snapshot();
  conflict(
    () =>
      f.call(`/waitlist/${waiting.id}/book`, 'POST', {
        revision: current.revision,
        offer_id: offer.id,
        readiness_acknowledged: true,
      }),
    /expired|handled|refresh/i,
  );
  assert.equal(f.snapshot(), before);
  const replacement = f.call(`/waitlist/${waiting.id}/offer`, 'POST', {
    revision: current.revision,
    slot_id: slot.id,
    slot_snapshot: slot.snapshot,
  });
  assert.notEqual(replacement.id, offer.id);
  assert.equal(replacement.status, 'Active');
  assert.equal(
    f.state.scheduling.offers.find((o) => o.id === offer.id)?.status,
    'Expired',
  );
});

test('staff can complete a pending waitlist treatment review and stale edits cannot overwrite it', () => {
  const f = fixture();
  f.appointment({ id: 'cancelled-slot', status: 'Cancelled' });
  const pending = f.waitlist({ visit_plan: null });
  const { status: _status, ...input } = pending;
  const beforeReview = f
    .call()
    .slots[0].candidates.find((c: any) => c.waitlist_id === pending.id);
  assert.equal(beforeReview.ready, false);
  assert.match(beforeReview.blockers.join('; '), /authorization.*review/i);
  const reviewed = f.call(`/waitlist/${pending.id}`, 'PATCH', {
    ...input,
    revision: pending.revision,
    visit_plan: f.reviewedPlan,
  });
  assert.equal(reviewed.id, pending.id);
  assert.equal(reviewed.revision, pending.revision + 1);
  const refreshed = f
    .call()
    .slots[0].candidates.find((c: any) => c.waitlist_id === pending.id);
  assert.deepEqual(refreshed.blockers, []);
  assert.ok(
    refreshed.warnings.length,
    'Outstanding intake and eligibility stay visible',
  );
  const before = f.snapshot();
  conflict(
    () =>
      f.call(`/waitlist/${pending.id}`, 'PATCH', {
        ...input,
        revision: pending.revision,
        visit_plan: null,
      }),
    /changed|refresh/i,
  );
  assert.equal(f.snapshot(), before);
});

async function httpFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cevrali-schedule-workflow-'));
  const filename = join(directory, 'demo.sqlite');
  let db = createDatabase(filename);
  let platform = createPlatformApp(db, join(directory, 'accounts'));
  let server = platform.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  let base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let cookie = '';
  async function call(
    path: string,
    method = 'GET',
    body?: unknown,
    auth = cookie,
  ) {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: auth },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0] || '',
    };
  }
  async function login(email = 'frontdesk@cevrali.demo') {
    const response = await call(
      '/auth/login',
      'POST',
      { email, password: 'CevraliDemo2026!' },
      '',
    );
    assert.equal(response.status, 200, JSON.stringify(response.data));
    cookie = response.cookie;
  }
  async function stop() {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    platform.store.close();
    db.close();
  }
  await login();
  return {
    call,
    login,
    get db() {
      return db;
    },
    restart: async () => {
      await stop();
      db = createDatabase(filename);
      platform = createPlatformApp(db, join(directory, 'accounts'));
      server = platform.app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
      await login();
    },
    cleanup: async () => {
      await stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function httpPolicy(f: Awaited<ReturnType<typeof httpFixture>>) {
  const response = await f.call('/workflow/finance/policies', 'POST', {
    patient_id: 'pat-001',
    billing_account_id: 'pba-private-pat-001',
    payer: 'Synthetic Scheduling Payer',
    plan: 'Synthetic scheduling coverage',
    member_id: 'SYNTHETIC-SCHED-001',
    priority: 'Primary',
    subscriber_name: 'Olivia Bennett',
    subscriber_dob: '1989-04-12',
    relationship: 'Self',
    effective_date: '2020-01-01',
    end_date: '2031-12-31',
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}

test('HTTP rescheduling, recurring reservations and source-visit waitlist booking persist through a complete server restart', async () => {
  const f = await httpFixture();
  const path = '/workflow/scheduling';
  const plan = {
    authorization_required: false,
    coverage_mode: 'Insurance',
    services: [],
  };
  try {
    assert.equal((await f.call(path, 'GET', undefined, '')).status, 401);
    const policy = await httpPolicy(f);
    const created = await f.call('/appointments', 'POST', {
      patient_id: 'pat-001',
      billing_account_id: 'pba-private-pat-001',
      provider_id: 'usr-clinician',
      date: '2030-03-20',
      time: '09:00',
      duration: 30,
      type: 'Follow-up',
      reason: 'HTTP source visit',
      service_plan: plan,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.id;
    const loaded = await f.call(`${path}/appointments/${id}`);
    assert.equal(loaded.status, 200, JSON.stringify(loaded.data));
    const moved = await f.call(
      `${path}/appointments/${id}/reschedule`,
      'POST',
      {
        revision: loaded.data.revision,
        snapshot: loaded.data.snapshot,
        date: '2030-03-19',
        time: '11:00',
        provider_id: 'usr-colleague',
        reason: 'Synthetic patient requested a different clinician and date',
      },
    );
    assert.equal(moved.status, 200, JSON.stringify(moved.data));
    const onNewDate = await f.call('/appointments?date=2030-03-19');
    assert.equal(onNewDate.data.find((a: any) => a.id === id)?.time, '11:00');
    assert.equal(
      onNewDate.data.find((a: any) => a.id === id)?.provider_id,
      'usr-colleague',
    );
    assert.equal(
      (await f.call('/appointments?date=2030-03-20')).data.length,
      0,
    );

    const series = await f.call(`${path}/series`, 'POST', {
      patient_id: 'pat-001',
      billing_account_id: 'pba-private-pat-001',
      provider_id: 'usr-clinician',
      date: '2030-03-01',
      time: '09:00',
      duration: 30,
      type: 'Follow-up',
      reason: 'HTTP biweekly series',
      count: 3,
      interval: 'Biweekly',
      visit_plan: plan,
    });
    assert.equal(series.status, 200, JSON.stringify(series.data));
    assert.equal(series.data.appointment_ids.length, 3);
    const seriesRows = f.db
      .prepare('SELECT id,date FROM appointments WHERE reason=? ORDER BY date')
      .all('HTTP biweekly series') as { id: string; date: string }[];
    assert.deepEqual(
      seriesRows.map((a) => a.date),
      ['2030-03-01', '2030-03-15', '2030-03-29'],
    );

    const cancelled = await f.call('/appointments', 'POST', {
      patient_id: 'pat-002',
      billing_account_id: 'pba-private-pat-002',
      provider_id: 'usr-colleague',
      date: '2030-03-12',
      time: '10:00',
      duration: 30,
      type: 'Follow-up',
      reason: 'Synthetic cancellation slot',
    });
    assert.equal(cancelled.status, 201, JSON.stringify(cancelled.data));
    assert.equal(
      (
        await f.call(`/appointments/${cancelled.data.id}`, 'PATCH', {
          status: 'Cancelled',
        })
      ).status,
      200,
    );
    const intake = await f.call('/workflow/intake-links', 'POST', {
      appointment_id: id,
    });
    assert.equal(intake.status, 200, JSON.stringify(intake.data));
    const submitted = await f.call(
      `/intake-links/${intake.data.token}`,
      'POST',
      {
        concern: 'Synthetic submitted concern retained after a move',
        symptoms: 'Patient reported update',
        allergies: [],
        medications: [],
        reminder_consent: false,
        attested: true,
      },
      '',
    );
    assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
    const eligibility = await f.call(
      `/workflow/finance/policies/${policy.id}/verify`,
      'POST',
      { service_date: '2030-03-12', scenario: 'Active' },
    );
    assert.equal(eligibility.status, 200, JSON.stringify(eligibility.data));
    const waiting = await f.call(`${path}/waitlist`, 'POST', {
      patient_id: 'pat-001',
      billing_account_id: 'pba-private-pat-001',
      provider_id: 'usr-colleague',
      appointment_id: id,
      earliest_date: '2030-03-01',
      latest_date: '2030-03-18',
      earliest_time: '08:00',
      latest_time: '17:00',
      duration: 30,
      type: 'Follow-up',
      reason: 'HTTP source visit',
      priority: 'High',
    });
    assert.equal(waiting.status, 200, JSON.stringify(waiting.data));
    const board = await f.call(path);
    assert.equal(board.status, 200, JSON.stringify(board.data));
    const slot = board.data.slots.find((s: any) => s.id === cancelled.data.id);
    assert.ok(slot);
    const candidate = slot.candidates.find(
      (c: any) => c.waitlist_id === waiting.data.id,
    );
    assert.equal(candidate.ready, true, JSON.stringify(candidate));
    const offer = await f.call(
      `${path}/waitlist/${waiting.data.id}/offer`,
      'POST',
      {
        revision: waiting.data.revision,
        slot_id: slot.id,
        slot_snapshot: slot.snapshot,
      },
    );
    assert.equal(offer.status, 200, JSON.stringify(offer.data));
    assert.equal(
      (f.db.prepare('SELECT date FROM appointments WHERE id=?').get(id) as any)
        .date,
      '2030-03-19',
      'Recording an offer must not move the patient before acceptance',
    );
    const refreshed = await f.call(path);
    const entry = refreshed.data.waitlist.find(
      (w: any) => w.id === waiting.data.id,
    );
    const booked = await f.call(`${path}/waitlist/${entry.id}/book`, 'POST', {
      revision: entry.revision,
      offer_id: offer.data.id,
    });
    assert.equal(booked.status, 200, JSON.stringify(booked.data));
    assert.equal(booked.data.id, id);
    const expected = loadWorkflow(f.db);
    assert.equal(expected.scheduling.series.length, 1);
    assert.equal(
      expected.operations.visit_plans.filter(
        (p) =>
          p.appointment_id === id ||
          series.data.appointment_ids.includes(p.appointment_id),
      ).length,
      4,
    );
    const history = expected.scheduling.history.filter(
      (h) => h.appointment_id === id,
    );
    assert.equal(history.length, 2);

    await f.restart();
    const persisted = await f.call(path);
    assert.equal(persisted.status, 200, JSON.stringify(persisted.data));
    assert.deepEqual(persisted.data.series, expected.scheduling.series);
    assert.equal(
      persisted.data.waitlist.find((w: any) => w.id === entry.id).status,
      'Booked',
    );
    assert.equal(
      persisted.data.offers.find((o: any) => o.id === offer.data.id).status,
      'Booked',
    );
    const appointments = await f.call('/appointments?date=2030-03-12');
    const saved = appointments.data.find((a: any) => a.id === id);
    assert.ok(saved);
    assert.equal(saved.time, '10:00');
    assert.equal(saved.provider_id, 'usr-colleague');
    assert.equal(saved.billing_account_id, 'pba-private-pat-001');
    const reloaded = loadWorkflow(f.db);
    assert.deepEqual(
      reloaded.operations.visit_plans,
      expected.operations.visit_plans,
    );
    assert.equal(
      reloaded.intakes.find((i) => i.id === intake.data.id)?.appointment_id,
      id,
    );
    assert.equal(
      reloaded.intakes.find((i) => i.id === intake.data.id)?.answers?.concern,
      'Synthetic submitted concern retained after a move',
    );
    assert.ok(
      (
        f.db
          .prepare('SELECT action FROM audit WHERE resource=?')
          .all(id) as any[]
      ).some((a) => /Rescheduled appointment/.test(a.action)),
    );
  } finally {
    await f.cleanup();
  }
});

test('a late HTTP recurring authorization failure rolls back appointments, workflow reservations and audit rows in one transaction', async () => {
  const f = await httpFixture();
  try {
    await f.login('alex@cevrali.demo');
    const policy = await httpPolicy(f);
    const auth = await f.call('/workflow/finance/authorizations', 'POST', {
      patient_id: 'pat-001',
      policy_id: policy.id,
      procedure_codes: ['99213'],
      description: 'Synthetic limited office authorization',
      requested_visits: 2,
      valid_from: '2030-01-01',
      valid_to: '2030-12-31',
      due_date: '2030-01-01',
    });
    assert.equal(auth.status, 200, JSON.stringify(auth.data));
    assert.equal(
      (
        await f.call(
          `/workflow/finance/authorizations/${auth.data.id}/submit`,
          'POST',
          {},
        )
      ).status,
      200,
    );
    const decision = await f.call(
      `/workflow/finance/authorizations/${auth.data.id}/decision`,
      'POST',
      {
        outcome: 'Approved',
        note: 'Synthetic approval limited to two office treatments',
        approval_number: 'DEMO-SCHED-ONLY-TWO',
        approved_visits: 2,
        valid_from: '2030-01-01',
        valid_to: '2030-12-31',
      },
    );
    assert.equal(decision.status, 200, JSON.stringify(decision.data));
    const allowance = await f.call(
      '/workflow/operations/service-approvals',
      'POST',
      {
        authorization_id: auth.data.id,
        procedure_code: '99213',
        category: 'Office visit',
        description: 'Synthetic limited office treatments',
        unit: 'Visits',
        approved_quantity: 2,
        decision_note: 'Synthetic allowance for exactly two treatments',
      },
    );
    assert.equal(allowance.status, 200, JSON.stringify(allowance.data));
    await f.call('/workflow/scheduling');
    const beforeWorkflow = JSON.stringify(loadWorkflow(f.db));
    const beforeAppointments = f.db
      .prepare('SELECT * FROM appointments ORDER BY id')
      .all();
    const beforeAudit = f.db.prepare('SELECT * FROM audit ORDER BY id').all();
    const failed = await f.call('/workflow/scheduling/series', 'POST', {
      patient_id: 'pat-001',
      billing_account_id: 'pba-private-pat-001',
      provider_id: 'usr-clinician',
      date: '2030-04-01',
      time: '09:00',
      duration: 30,
      type: 'Follow-up',
      reason: 'Third occurrence must roll back the first two',
      count: 3,
      interval: 'Weekly',
      visit_plan: {
        authorization_required: true,
        coverage_mode: 'Insurance',
        services: [
          {
            approval_id: allowance.data.id,
            procedure_code: '99213',
            quantity: 1,
          },
        ],
      },
    });
    assert.equal(failed.status, 409, JSON.stringify(failed.data));
    assert.match(failed.data.error, /approv|remain|quantity|reserve/i);
    assert.deepEqual(
      f.db.prepare('SELECT * FROM appointments ORDER BY id').all(),
      beforeAppointments,
    );
    assert.equal(JSON.stringify(loadWorkflow(f.db)), beforeWorkflow);
    assert.deepEqual(
      f.db.prepare('SELECT * FROM audit ORDER BY id').all(),
      beforeAudit,
    );
    await f.restart();
    assert.deepEqual(
      f.db.prepare('SELECT * FROM appointments ORDER BY id').all(),
      beforeAppointments,
    );
    assert.equal(JSON.stringify(loadWorkflow(f.db)), beforeWorkflow);
  } finally {
    await f.cleanup();
  }
});
