import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createDatabase, clinicDate } from '../server/database.js';
import { createApp } from '../server/app.js';
import { loadWorkflow, saveWorkflow } from '../server/workflows.js';
import {
  emptyWorkflowState,
  type WorkflowContext,
} from '../server/workflow-engine.js';
import {
  operationsRequest,
  guardServiceCancellation,
  guardVisitAccountChange,
  releaseVisitPlanForAccountChange,
} from '../server/operations-engine.js';
import {
  treatmentReconciliationRows,
  validateTreatmentForBill,
} from '../server/treatment-rules.js';
import type { Bill } from '../server/finance-engine.js';

const day = '2026-10-21';
function fixture() {
  const state = emptyWorkflowState();
  const ctx: WorkflowContext = {
    user: {
      id: 'provider',
      name: 'Provider',
      email: 'provider@example.test',
      role: 'clinician',
    },
    users: [],
    patients: [
      { id: 'patient', first_name: 'Synthetic', last_name: 'Patient' },
    ],
    appointments: [
      {
        id: 'appointment',
        patient_id: 'patient',
        billing_account_id: 'account',
        provider_id: 'provider',
        date: day,
        time: '09:00',
        status: 'Completed',
      },
    ],
    encounters: [
      {
        id: 'encounter',
        patient_id: 'patient',
        appointment_id: 'appointment',
        billing_account_id: 'account',
        author_id: 'provider',
        status: 'Signed',
      },
    ],
    tasks: [],
    labs: [],
    now: `${day}T17:00:00.000Z`,
    today: day,
    local_time: '10:00',
    id: (prefix) => `${prefix}-test`,
    audit: () => {},
  };
  state.operations.visit_plans.push({
    appointment_id: 'appointment',
    patient_id: 'patient',
    billing_account_id: 'account',
    revision: 1,
    authorization_required: true,
    coverage_mode: 'Insurance',
    services: [
      { approval_id: 'service', procedure_code: '97810', quantity: 3 },
    ],
    history: [],
  });
  state.finance.policies.push({
    id: 'policy',
    patient_id: 'patient',
    billing_account_id: 'account',
    revision: 1,
  } as any);
  state.finance.authorizations.push({
    id: 'authorization',
    patient_id: 'patient',
    policy_id: 'policy',
    policy_revision: 1,
    status: 'Demo approved',
    valid_from: '2020-01-01',
    valid_to: '2099-01-01',
    procedure_codes: ['97810'],
    approved_visits: 2,
  } as any);
  state.operations.service_approvals.push({
    id: 'service',
    authorization_id: 'authorization',
    patient_id: 'patient',
    billing_account_id: 'account',
    policy_id: 'policy',
    policy_revision: 1,
    procedure_code: '97810',
    approved_quantity: 6,
    revision: 1,
    category: 'Acupuncture',
    description: 'Synthetic treatment',
    unit: 'Units',
    history: [],
  });
  const call = (path: string, method = 'GET', body?: unknown) =>
    operationsRequest(
      state,
      ctx,
      method,
      new URL(`http://localhost/operations/${path}`),
      body,
    ) as any;
  function actual(performed = 2, deferred = 1, cancelled = 0, revision = 0) {
    return call('treatments?appointment_id=appointment', 'POST', {
      revision,
      plan_revision: 1,
      reason: 'Reviewed actual clinical services',
      services: [{ procedure_code: '97810', performed, deferred, cancelled }],
    });
  }
  const bill: Bill = {
    id: 'bill',
    patient_id: 'patient',
    encounter_id: 'encounter',
    billing_account_id: 'account',
    service_date: day,
    mode: 'Insurance',
    policy_id: 'policy',
    authorization_required: true,
    authorization_id: 'authorization',
    lines: [
      {
        code: '97810',
        description: 'Treatment',
        diagnosis: 'M25.512',
        units: 2,
        unit_cents: 1000,
      },
    ],
    revision: 1,
    created_at: ctx.now,
    finalized_at: null,
  };
  return { state, ctx, call, actual, bill };
}

test('legacy completed appointments retain planned reservations until actual treatment is explicitly reviewed', () => {
  const f = fixture();
  const before = f.call('service-approvals')[0];
  assert.deepEqual(
    [before.reserved, before.completed, before.remaining],
    [3, 0, 3],
  );
  assert.match(
    treatmentReconciliationRows(f.state, f.ctx)[0].issues[0],
    /Actual treatment review required/,
  );
  assert.throws(
    () => validateTreatmentForBill(f.state, f.ctx, f.bill),
    /actual performed/,
  );
  f.actual(1, 1, 1);
  const after = f.call('service-approvals')[0];
  assert.deepEqual(
    [after.reserved, after.completed, after.remaining],
    [0, 1, 5],
  );
});

test('shared insurance switch guard leaves planned and reviewed visits unchanged in server and preview contexts', () => {
  for (const reviewed of [false, true]) {
    const f = fixture();
    if (reviewed) f.actual();
    for (const ctx of [
      f.ctx,
      structuredClone({ ...f.ctx, id: undefined, audit: undefined }),
    ]) {
      const previewContext = {
        ...ctx,
        id: f.ctx.id,
        audit: f.ctx.audit,
      } as WorkflowContext;
      const before = JSON.stringify({
        state: f.state,
        appointments: previewContext.appointments,
        encounters: previewContext.encounters,
      });
      assert.throws(
        () =>
          guardVisitAccountChange(
            f.state,
            previewContext,
            'appointment',
            'other-account',
          ),
        (e: any) =>
          e.status === 409 && /planned treatment visit starts/.test(e.message),
      );
      assert.doesNotThrow(() =>
        guardVisitAccountChange(
          f.state,
          previewContext,
          'appointment',
          'account',
        ),
      );
      assert.equal(
        JSON.stringify({
          state: f.state,
          appointments: previewContext.appointments,
          encounters: previewContext.encounters,
        }),
        before,
      );
    }
  }
});

test('prestart insurance switches release only reservations and unplanned draft switches remain available', () => {
  for (const status of ['Scheduled', 'Checked in']) {
    const f = fixture();
    f.ctx.appointments[0].status = status;
    f.ctx.encounters = [];
    assert.doesNotThrow(() =>
      guardVisitAccountChange(f.state, f.ctx, 'appointment', 'other-account'),
    );
    releaseVisitPlanForAccountChange(
      f.state,
      f.ctx,
      'appointment',
      'other-account',
    );
    assert.equal(f.state.operations.visit_plans[0].released, true);
    assert.equal(f.state.operations.visit_plans[0].revision, 2);
    const row = f.call('service-approvals')[0];
    assert.deepEqual([row.reserved, row.completed, row.remaining], [0, 0, 6]);
  }
  const f = fixture();
  f.state.operations.visit_plans = [];
  assert.doesNotThrow(() =>
    guardVisitAccountChange(f.state, f.ctx, 'appointment', 'other-account'),
  );
  f.state.operations.visit_plans.push({
    appointment_id: 'appointment',
    patient_id: 'patient',
    billing_account_id: 'account',
    revision: 1,
    authorization_required: false,
    coverage_mode: 'Insurance',
    services: [],
    history: [],
  });
  assert.doesNotThrow(() =>
    guardVisitAccountChange(f.state, f.ctx, 'appointment', 'other-account'),
  );
});

test('legacy released or revised plans retain recorded actual usage and prevent authorization cancellation', () => {
  const f = fixture();
  f.actual(2, 1, 0);
  const originalReview = JSON.stringify(f.state.operations.treatment_reviews);
  const plan = f.state.operations.visit_plans[0];
  plan.released = true;
  plan.revision++;
  f.ctx.appointments[0].billing_account_id = 'other-account';
  let row = f.call('service-approvals')[0];
  assert.deepEqual([row.reserved, row.completed, row.remaining], [0, 2, 4]);
  assert.throws(
    () => guardServiceCancellation(f.state, f.ctx, 'authorization'),
    /completed services/,
  );
  assert.equal(
    JSON.stringify(f.state.operations.treatment_reviews),
    originalReview,
  );
  // A legacy administrative revision without a release still retains actuals;
  // only the outstanding planned quantity is held, without counting it twice.
  plan.released = false;
  f.ctx.appointments[0].billing_account_id = 'account';
  row = f.call('service-approvals')[0];
  assert.deepEqual([row.reserved, row.completed, row.remaining], [1, 2, 3]);
});

test('authoritative missed-visit status releases only unperformed holds and preserves recorded treatment usage', () => {
  for (const reviewed of [false, true]) {
    const f = fixture();
    if (reviewed) f.actual(2, 1, 0);
    f.ctx.appointments[0].status = 'No-show';
    delete f.state.visits.appointment;
    const row = f.call('service-approvals')[0];
    assert.deepEqual(
      [row.reserved, row.completed, row.remaining],
      reviewed ? [0, 2, 4] : [0, 0, 6],
    );
  }
});

test('late reservation release cannot bypass the insurance switch guard using a mutated preview appointment', () => {
  const f = fixture();
  f.actual();
  f.ctx.appointments[0].billing_account_id = 'other-account';
  const before = JSON.stringify(f.state);
  assert.throws(
    () =>
      releaseVisitPlanForAccountChange(
        f.state,
        f.ctx,
        'appointment',
        'other-account',
      ),
    /Insurance cannot change/,
  );
  assert.equal(JSON.stringify(f.state), before);
});

test('review requires the encounter author, exact planned dispositions and current revisions; staff view hides review narrative', () => {
  const f = fixture();
  f.ctx.user = { ...f.ctx.user, id: 'other-clinician' };
  assert.throws(() => f.actual(), /encounter author/);
  f.ctx.user = { ...f.ctx.user, id: 'provider' };
  assert.throws(() => f.actual(4, 0, 0), /total 3 planned/);
  assert.throws(() => f.actual(1, 0, 0), /total 3 planned/);
  f.actual();
  assert.throws(() => f.actual(), /changed; reload/);
  const oldHistory = JSON.stringify(
    f.state.operations.treatment_reviews[0].history[0],
  );
  f.actual(1, 0, 2, 1);
  assert.equal(f.state.operations.treatment_reviews[0].revision, 2);
  assert.equal(
    JSON.stringify(f.state.operations.treatment_reviews[0].history[0]),
    oldHistory,
  );
  f.ctx.user = { ...f.ctx.user, role: 'front_desk' };
  const view = f.call('treatments?encounter_id=encounter');
  assert.equal(view.review.reason, '');
  assert.equal(view.review.history[0].reason, '');
  assert.equal(view.can_review, false);
  assert.throws(() => f.actual(1, 0, 2, 2), /encounter author/);
});

test('charges cannot exceed actual quantities including repeated lines and other charge sheets for the same visit', () => {
  const f = fixture();
  f.actual();
  assert.doesNotThrow(() => validateTreatmentForBill(f.state, f.ctx, f.bill));
  assert.doesNotThrow(() =>
    validateTreatmentForBill(f.state, f.ctx, {
      ...f.bill,
      lines: [{ ...f.bill.lines[0], units: 1 }],
    }),
  );
  assert.throws(
    () =>
      validateTreatmentForBill(f.state, f.ctx, {
        ...f.bill,
        lines: [{ ...f.bill.lines[0], units: 3 }],
      }),
    /charge units exceed 2/,
  );
  assert.throws(
    () =>
      validateTreatmentForBill(f.state, f.ctx, {
        ...f.bill,
        lines: [f.bill.lines[0], f.bill.lines[0]],
      }),
    /charge units exceed 2/,
  );
  f.state.finance.bills.push({ ...structuredClone(f.bill), id: 'duplicate' });
  assert.throws(
    () => validateTreatmentForBill(f.state, f.ctx, f.bill),
    /charge units exceed 2/,
  );
  assert.doesNotThrow(() =>
    validateTreatmentForBill(f.state, f.ctx, f.bill, 'duplicate'),
  );
  assert.throws(
    () =>
      validateTreatmentForBill(f.state, f.ctx, {
        ...f.bill,
        lines: [{ ...f.bill.lines[0], code: '99213' }],
      }),
    /outside the reviewed/,
  );
});

test('actual corrections cannot silently reduce charged quantities; voiding charges permits an audited correction', () => {
  const f = fixture();
  f.actual();
  f.state.finance.bills.push(structuredClone(f.bill));
  assert.throws(() => f.actual(1, 2, 0, 1), /correct or void charge sheets/);
  assert.equal(f.state.operations.treatment_reviews[0].history.length, 1);
  f.state.finance.bills[0].voided_at = f.ctx.now;
  f.actual(1, 2, 0, 1);
  assert.equal(
    f.state.operations.treatment_reviews[0].services[0].performed,
    1,
  );
  assert.equal(f.state.operations.treatment_reviews[0].history.length, 2);
});

test('service allowance, parent visit limit and current policy all apply in addition to performed quantities', () => {
  const f = fixture();
  f.actual();
  f.state.operations.service_approvals[0].approved_quantity = 1;
  assert.throws(
    () => validateTreatmentForBill(f.state, f.ctx, f.bill),
    /service allowance/,
  );
  f.state.operations.service_approvals[0].approved_quantity = 6;
  f.state.finance.authorizations[0].approved_visits = 1;
  f.state.finance.claims.push({
    id: 'prior',
    bill_id: 'another-bill',
    status: 'Demo submitted',
    authorization: f.state.finance.authorizations[0],
  } as any);
  assert.throws(
    () => validateTreatmentForBill(f.state, f.ctx, f.bill),
    /no approved visits remaining/,
  );
  f.state.finance.claims[0].status = 'Demo replaced';
  assert.doesNotThrow(() => validateTreatmentForBill(f.state, f.ctx, f.bill));
  f.state.finance.policies[0].revision = 2;
  assert.throws(
    () => validateTreatmentForBill(f.state, f.ctx, f.bill),
    /approval is inactive, changed/,
  );
});

test('revised actuals cannot consume units already reserved by another visit, and billed discrepancies are visible', () => {
  const f = fixture();
  f.actual(1, 2, 0);
  f.state.operations.service_approvals[0].approved_quantity = 3;
  f.ctx.appointments.push({
    ...f.ctx.appointments[0],
    id: 'next',
    status: 'Scheduled',
  });
  f.state.operations.visit_plans.push({
    ...structuredClone(f.state.operations.visit_plans[0]),
    appointment_id: 'next',
    services: [
      { approval_id: 'service', procedure_code: '97810', quantity: 2 },
    ],
  });
  assert.throws(() => f.actual(2, 1, 0, 1), /not enough approved units/);
  assert.ok(
    treatmentReconciliationRows(f.state, f.ctx)[0].issues.includes(
      '97810: 1 performed / 0 charged',
    ),
  );
  f.state.operations.visit_plans.length = 0;
  assert.doesNotThrow(() => validateTreatmentForBill(f.state, f.ctx, f.bill));
});

test('actuals preserve visit account boundaries and unlinked notes have no treatment form', () => {
  const f = fixture();
  f.state.operations.service_approvals[0].billing_account_id = 'other-account';
  assert.throws(() => f.actual(), /approval is inactive, changed/);
  f.state.operations.service_approvals[0].billing_account_id = 'account';
  f.actual();
  assert.throws(
    () =>
      validateTreatmentForBill(f.state, f.ctx, {
        ...f.bill,
        billing_account_id: 'other-account',
      }),
    /does not match/,
  );
  assert.throws(
    () =>
      validateTreatmentForBill(f.state, f.ctx, {
        ...f.bill,
        authorization_required: false,
      }),
    /must use the treatment plan/,
  );
  f.ctx.encounters.push({
    id: 'unlinked',
    patient_id: 'patient',
    appointment_id: null,
  });
  assert.equal(f.call('treatments?encounter_id=unlinked').plan, null);
});

async function httpFixture() {
  const db = createDatabase(':memory:');
  const server = createApp(db).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let cookie = '';
  async function call(path: string, method = 'GET', body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json(), response: res };
  }
  cookie = (
    await call('/auth/login', 'POST', {
      email: 'alex@cevrali.demo',
      password: 'CevraliDemo2026!',
    })
  ).response.headers
    .get('set-cookie')!
    .split(';')[0];
  const state = loadWorkflow(db);
  state.operations.visit_plans.push({
    appointment_id: 'apt-001',
    patient_id: 'pat-001',
    billing_account_id: 'pba-private-pat-001',
    revision: 1,
    authorization_required: false,
    coverage_mode: 'Insurance',
    services: [{ procedure_code: '99213', approval_id: '', quantity: 3 }],
    history: [],
  });
  saveWorkflow(db, state);
  const actual = (performed = 2, revision = 0) =>
    call('/workflow/operations/treatments?encounter_id=enc-001', 'POST', {
      revision,
      plan_revision: 1,
      reason: 'Clinical treatment confirmed',
      services: [
        {
          procedure_code: '99213',
          performed,
          deferred: 3 - performed,
          cancelled: 0,
        },
      ],
    });
  return {
    db,
    call,
    actual,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
    },
  };
}

test('HTTP self-pay finalization checks actuals and preserves state after a rejected mismatch', async () => {
  const f = await httpFixture();
  try {
    let b = (
      await f.call('/workflow/finance/bills', 'POST', {
        encounter_id: 'enc-001',
        mode: 'Self-pay',
      })
    ).data;
    const line = {
      code: '99213',
      description: 'Reviewed synthetic treatment',
      diagnosis: 'I10',
      units: 3,
      unit_cents: 1000,
    };
    b = (
      await f.call(`/workflow/finance/bills/${b.id}`, 'PATCH', {
        revision: b.revision,
        policy_id: '',
        lines: [line],
      })
    ).data;
    assert.equal(
      (await f.call(`/workflow/finance/bills/${b.id}/finalize`, 'POST', {}))
        .status,
      409,
    );
    // Recording actuals below an existing draft charge requires correcting the draft first.
    assert.equal((await f.actual()).status, 409);
    b = (
      await f.call(`/workflow/finance/bills/${b.id}`, 'PATCH', {
        revision: b.revision,
        policy_id: '',
        lines: [{ ...line, units: 2 }],
      })
    ).data;
    assert.equal((await f.actual()).status, 200);
    assert.equal(
      (await f.call(`/workflow/finance/bills/${b.id}/finalize`, 'POST', {}))
        .status,
      200,
    );
    assert.equal((await f.actual(1, 1)).status, 409);
    assert.equal(
      loadWorkflow(f.db).operations.treatment_reviews[0].history.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('HTTP claim preparation, correction and submission use actual treatment reconciliation', async () => {
  const f = await httpFixture();
  try {
    assert.equal((await f.actual()).status, 200);
    const p = (
      await f.call('/workflow/finance/policies', 'POST', {
        patient_id: 'pat-001',
        payer: 'Synthetic payer',
        plan: 'PPO',
        member_id: 'TREATMENT',
        group_number: 'DEMO',
        priority: 'Primary',
        subscriber_name: 'Olivia Bennett',
        subscriber_dob: '1985-03-14',
        relationship: 'Self',
        effective_date: '2000-01-01',
        end_date: '',
      })
    ).data;
    assert.equal(
      (
        await f.call(`/workflow/finance/policies/${p.id}/verify`, 'POST', {
          service_date: clinicDate(),
          scenario: 'Active',
        })
      ).status,
      200,
    );
    let b = (
      await f.call('/workflow/finance/bills', 'POST', {
        encounter_id: 'enc-001',
        mode: 'Insurance',
      })
    ).data;
    const line = {
      code: '99213',
      description: 'Reviewed treatment',
      diagnosis: 'I10',
      units: 3,
      unit_cents: 1000,
    };
    b = (
      await f.call(`/workflow/finance/bills/${b.id}`, 'PATCH', {
        revision: b.revision,
        policy_id: p.id,
        lines: [line],
      })
    ).data;
    assert.equal(
      (await f.call('/workflow/finance/claims', 'POST', { bill_id: b.id }))
        .status,
      409,
    );
    assert.equal(loadWorkflow(f.db).finance.claims.length, 0);
    b = (
      await f.call(`/workflow/finance/bills/${b.id}`, 'PATCH', {
        revision: b.revision,
        policy_id: p.id,
        lines: [{ ...line, units: 2 }],
      })
    ).data;
    const c = await f.call('/workflow/finance/claims', 'POST', {
      bill_id: b.id,
    });
    assert.equal(c.status, 200, JSON.stringify(c.data));
    const correction = await f.call('/workflow/finance/corrections', 'POST', {
      bill_id: b.id,
      revision: b.revision,
      kind: 'Draft revision',
      reason: 'Invalid duplicate quantity correction',
      policy_id: p.id,
      lines: [line],
    });
    assert.equal(correction.status, 409);
    assert.equal((await f.actual(1, 1)).status, 409);
    const decrease = await f.call('/workflow/finance/corrections', 'POST', {
      bill_id: b.id,
      revision: b.revision,
      kind: 'Draft revision',
      reason: 'Audited quantity correction before actual review revision',
      policy_id: p.id,
      lines: [{ ...line, units: 1 }],
    });
    assert.equal(decrease.status, 200, JSON.stringify(decrease.data));
    assert.equal(
      (
        await f.call(
          `/workflow/finance/corrections/${decrease.data.id}/apply`,
          'POST',
          {},
        )
      ).status,
      200,
    );
    assert.equal((await f.actual(1, 1)).status, 200);
    // Simulate an imported historic inconsistency and verify submission rechecks it.
    const state = loadWorkflow(f.db);
    state.operations.treatment_reviews[0].services[0].performed = 0;
    const currentClaim = state.finance.claims.at(-1)!;
    saveWorkflow(f.db, state);
    assert.equal(
      (
        await f.call(
          `/workflow/finance/claims/${currentClaim.id}/submit`,
          'POST',
          {},
        )
      ).status,
      409,
    );
    assert.equal(loadWorkflow(f.db).finance.claims.at(-1)!.status, 'Prepared');
  } finally {
    await f.close();
  }
});

async function insuranceSwitchAccount(
  f: Awaited<ReturnType<typeof httpFixture>>,
  patientId: string,
) {
  const created = await f.call('/workflow/finance/accounts', 'POST', {
    patient_id: patientId,
    name: 'Insurance switch regression claim',
    kind: 'Workers compensation',
    workers_comp: {
      claim_number: `SWITCH-${patientId}`,
      carrier: 'Synthetic switch carrier',
      date_of_injury: '2020-01-01',
      employer: 'Synthetic employer',
      claim_status: 'Accepted',
      accepted_body_parts: ['Left shoulder'],
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  return created.data;
}

async function insuranceSwitchPlan(f: Awaited<ReturnType<typeof httpFixture>>) {
  const account = await insuranceSwitchAccount(f, 'pat-005');
  const policies = await f.call(
    `/workflow/finance/policies?billing_account_id=${account.id}`,
  );
  const created = await f.call('/workflow/finance/authorizations', 'POST', {
    patient_id: 'pat-005',
    policy_id: policies.data[0].id,
    procedure_codes: ['99213'],
    description: 'Synthetic insurance switch treatment',
    requested_visits: 2,
    valid_from: clinicDate(),
    valid_to: '2099-01-01',
    due_date: clinicDate(),
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const authorizationId = created.data.id;
  assert.equal(
    (
      await f.call(
        `/workflow/finance/authorizations/${authorizationId}/submit`,
        'POST',
        {},
      )
    ).status,
    200,
  );
  const approved = await f.call(
    `/workflow/finance/authorizations/${authorizationId}/decision`,
    'POST',
    {
      outcome: 'Approved',
      note: 'Synthetic two-unit approval reviewed',
      approval_number: 'SWITCH-APPROVED',
      approved_visits: 2,
      valid_from: clinicDate(),
      valid_to: '2099-01-01',
    },
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  const service = await f.call(
    '/workflow/operations/service-approvals',
    'POST',
    {
      authorization_id: authorizationId,
      procedure_code: '99213',
      category: 'Office visit',
      description: 'Synthetic reviewed office treatment',
      unit: 'Units',
      approved_quantity: 2,
      decision_note: 'Synthetic service allowance approved',
    },
  );
  assert.equal(service.status, 200, JSON.stringify(service.data));
  const changed = await f.call(
    '/appointments/apt-005/billing-account',
    'PATCH',
    {
      billing_account_id: account.id,
      previous_billing_account_id: 'pba-private-pat-005',
    },
  );
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  const plan = await f.call(
    '/workflow/operations/visit-plans/apt-005',
    'POST',
    {
      authorization_required: true,
      services: [
        {
          approval_id: service.data.id,
          procedure_code: '99213',
          quantity: 2,
        },
      ],
    },
  );
  assert.equal(plan.status, 200, JSON.stringify(plan.data));
  return { account, authorizationId, service: service.data, plan: plan.data };
}

test('HTTP insurance switch cannot change reviewed treatment accounts or partially save the rejected note', async () => {
  const f = await httpFixture();
  try {
    const { account, authorizationId, service, plan } =
      await insuranceSwitchPlan(f);
    for (const status of ['Checked in', 'In progress'])
      assert.equal(
        (await f.call('/appointments/apt-005', 'PATCH', { status })).status,
        200,
      );
    const created = await f.call('/encounters', 'POST', {
      patient_id: 'pat-005',
      appointment_id: 'apt-005',
      chief_complaint: 'Synthetic claim treatment',
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const note = (await f.call('/encounters')).data.find(
      (e: any) => e.id === created.data.id,
    );
    const reviewed = await f.call(
      `/workflow/operations/treatments?encounter_id=${note.id}`,
      'POST',
      {
        revision: 0,
        plan_revision: plan.revision,
        reason: 'Clinician confirmed two units were performed',
        services: [
          {
            procedure_code: '99213',
            performed: 2,
            deferred: 0,
            cancelled: 0,
          },
        ],
      },
    );
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
    const beforeState = loadWorkflow(f.db);
    const beforeEncounter = f.db
      .prepare('SELECT * FROM encounters WHERE id=?')
      .get(note.id);
    const beforeAppointment = f.db
      .prepare('SELECT * FROM appointments WHERE id=?')
      .get('apt-005');
    const beforePlan = JSON.stringify(
      beforeState.operations.visit_plans.find(
        (p) => p.appointment_id === 'apt-005',
      ),
    );
    const beforeReview = JSON.stringify(
      beforeState.operations.treatment_reviews.find(
        (r) => r.appointment_id === 'apt-005',
      ),
    );
    const beforeAudit = f.db.prepare('SELECT COUNT(*) AS n FROM audit').get();
    const changed = await f.call(`/encounters/${note.id}`, 'PATCH', {
      ...note,
      status: 'Draft',
      billing_account_id: 'pba-private-pat-005',
      subjective: 'Rejected account switch must not save this SOAP change',
    });
    assert.equal(changed.status, 409, JSON.stringify(changed.data));
    assert.deepEqual(
      f.db.prepare('SELECT * FROM encounters WHERE id=?').get(note.id),
      beforeEncounter,
      'Rejected account switch must preserve SOAP, timestamps and account snapshot',
    );
    assert.deepEqual(
      f.db.prepare('SELECT * FROM appointments WHERE id=?').get('apt-005'),
      beforeAppointment,
    );
    const afterState = loadWorkflow(f.db);
    assert.equal(
      JSON.stringify(
        afterState.operations.visit_plans.find(
          (p) => p.appointment_id === 'apt-005',
        ),
      ),
      beforePlan,
    );
    assert.equal(
      JSON.stringify(
        afterState.operations.treatment_reviews.find(
          (r) => r.appointment_id === 'apt-005',
        ),
      ),
      beforeReview,
    );
    assert.deepEqual(
      f.db.prepare('SELECT COUNT(*) AS n FROM audit').get(),
      beforeAudit,
    );
    const allowance = (
      await f.call(
        `/workflow/operations/service-approvals?authorization_id=${authorizationId}`,
      )
    ).data.find((s: any) => s.id === service.id);
    assert.deepEqual(
      [allowance.reserved, allowance.completed, allowance.remaining],
      [0, 2, 0],
    );
    assert.equal(
      (
        await f.call(
          `/workflow/finance/authorizations/${authorizationId}/cancel`,
          'POST',
          {
            reason: 'Cannot release authorization for performed treatment',
          },
        )
      ).status,
      409,
    );
    const saved = await f.call(`/encounters/${note.id}`, 'PATCH', {
      ...note,
      status: 'Draft',
      billing_account_id: account.id,
      subjective: 'Same-account SOAP documentation remains editable',
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(
      (
        f.db
          .prepare('SELECT subjective FROM encounters WHERE id=?')
          .get(note.id) as any
      ).subjective,
      'Same-account SOAP documentation remains editable',
    );
  } finally {
    await f.close();
  }
});

test('HTTP insurance switch remains available for ordinary unplanned draft notes', async () => {
  const f = await httpFixture();
  try {
    const account = await insuranceSwitchAccount(f, 'pat-006');
    const created = await f.call('/encounters', 'POST', {
      patient_id: 'pat-006',
      appointment_id: 'apt-006',
      chief_complaint: 'Synthetic unplanned visit',
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const note = (await f.call('/encounters')).data.find(
      (e: any) => e.id === created.data.id,
    );
    const changed = await f.call(`/encounters/${note.id}`, 'PATCH', {
      ...note,
      status: 'Draft',
      billing_account_id: account.id,
      subjective: 'Ordinary draft note insurance selection corrected',
      wc_documentation: {},
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    assert.equal(
      (
        f.db
          .prepare('SELECT billing_account_id FROM encounters WHERE id=?')
          .get(note.id) as any
      ).billing_account_id,
      account.id,
    );
    assert.equal(
      (
        f.db
          .prepare('SELECT billing_account_id FROM appointments WHERE id=?')
          .get('apt-006') as any
      ).billing_account_id,
      account.id,
    );
  } finally {
    await f.close();
  }
});

test('HTTP insurance switch before treatment starts still releases scheduled reservations', async () => {
  const f = await httpFixture();
  try {
    const { account, authorizationId, service, plan } =
      await insuranceSwitchPlan(f);
    const changed = await f.call(
      '/appointments/apt-005/billing-account',
      'PATCH',
      {
        billing_account_id: 'pba-private-pat-005',
        previous_billing_account_id: account.id,
      },
    );
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    const released = loadWorkflow(f.db).operations.visit_plans.find(
      (p) => p.appointment_id === 'apt-005',
    )!;
    assert.equal(released.released, true);
    assert.equal(released.revision, plan.revision + 1);
    const allowance = (
      await f.call(
        `/workflow/operations/service-approvals?authorization_id=${authorizationId}`,
      )
    ).data.find((s: any) => s.id === service.id);
    assert.deepEqual(
      [allowance.reserved, allowance.completed, allowance.remaining],
      [0, 0, 2],
    );
  } finally {
    await f.close();
  }
});
