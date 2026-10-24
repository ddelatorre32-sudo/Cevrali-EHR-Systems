import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createDatabase, clinicDate } from '../server/database.js';
import { createApp } from '../server/app.js';
import { loadWorkflow, saveWorkflow } from '../server/workflows.js';

async function fixture(filename = ':memory:') {
  const db = createDatabase(filename);
  const server = createApp(db).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let cookie = '';
  let front = '';
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
    return { status: response.status, data: await response.json(), response };
  }
  for (const email of ['alex@cevrali.demo', 'frontdesk@cevrali.demo']) {
    const login = await call(
      '/auth/login',
      'POST',
      { email, password: 'CevraliDemo2026!' },
      '',
    );
    const c = login.response.headers.get('set-cookie')!.split(';')[0];
    if (email.startsWith('alex')) cookie = c;
    else front = c;
  }
  const coverage = {
    patient_id: 'pat-001',
    payer: 'Demo payer',
    plan: 'Demo PPO',
    member_id: 'DEMO-MEMBER-1',
    group_number: 'DEMO-GROUP',
    priority: 'Primary',
    subscriber_name: 'Olivia Bennett',
    subscriber_dob: '1985-03-14',
    relationship: 'Self',
    effective_date: '2000-01-01',
    end_date: '',
  };
  const lines = [
    {
      code: '99213',
      description: 'Staff-reviewed office visit',
      diagnosis: 'I10',
      units: 1,
      unit_cents: 15000,
    },
  ];
  async function policy() {
    const p = await call('/workflow/finance/policies', 'POST', coverage);
    assert.equal(p.status, 200);
    return p.data;
  }
  async function verify(id: string, scenario = 'Active') {
    return call(`/workflow/finance/policies/${id}/verify`, 'POST', {
      service_date: clinicDate(),
      scenario,
    });
  }
  async function bill(
    policyId = '',
    encounterId = 'enc-001',
    mode = 'Insurance',
  ) {
    const created = await call('/workflow/finance/bills', 'POST', {
      encounter_id: encounterId,
      mode,
    });
    assert.equal(created.status, 200);
    const saved = await call(
      `/workflow/finance/bills/${created.data.id}`,
      'PATCH',
      { revision: 1, policy_id: policyId, lines },
    );
    assert.equal(saved.status, 200);
    return saved.data;
  }
  async function claim() {
    const p = await policy();
    assert.equal((await verify(p.id)).status, 200);
    const b = await bill(p.id);
    const c = await call('/workflow/finance/claims', 'POST', { bill_id: b.id });
    assert.equal(c.status, 200);
    return { p, b, c: c.data };
  }
  async function close() {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    db.close();
  }
  return {
    db,
    call,
    front,
    coverage,
    lines,
    policy,
    verify,
    bill,
    claim,
    close,
  };
}

test('insurance records validate dates, prevent overlapping coverage, preserve verification history, and isolate public access', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.call('/workflow/finance/policies', 'GET', undefined, '')).status,
      401,
    );
    assert.equal(
      (
        await f.call('/workflow/finance/policies', 'POST', {
          ...f.coverage,
          effective_date: '2026-02-30',
        })
      ).status,
      400,
    );
    const p = await f.policy();
    assert.equal(
      (await f.call('/workflow/finance/policies', 'POST', f.coverage)).status,
      409,
    );
    const active = await f.verify(p.id);
    assert.equal(active.data.status, 'Active');
    assert.equal(active.data.source, 'Demo payer');
    const updated = await f.call(
      `/workflow/finance/policies/${p.id}`,
      'PATCH',
      { ...f.coverage, revision: 1, member_id: 'DEMO-CHANGED' },
    );
    assert.equal(updated.data.revision, 2);
    assert.equal(
      (
        await f.call(`/workflow/finance/policies/${p.id}`, 'PATCH', {
          ...f.coverage,
          revision: 1,
        })
      ).status,
      409,
    );
    const rows = await f.call('/workflow/finance/policies');
    assert.equal(rows.data[0].verifications[0].policy_revision, 1);
    const wrongDate = await f.call(
      `/workflow/finance/policies/${p.id}/verify`,
      'POST',
      { service_date: '1999-01-01', scenario: 'Active' },
    );
    assert.equal(wrongDate.data.status, 'Inactive');
    const b = await f.bill(p.id);
    assert.equal(
      (await f.call('/workflow/finance/claims', 'POST', { bill_id: b.id }))
        .status,
      409,
    );
    assert.equal(
      (await f.verify(p.id, 'Needs review')).data.status,
      'Needs review',
    );
  } finally {
    await f.close();
  }
});
test('claim preparation enforces signed notes, patient matching, primary coverage, fresh service-date verification and unique charges', async () => {
  const f = await fixture();
  try {
    const p = await f.policy();
    await f.verify(p.id);
    const b = await f.bill(p.id);
    assert.equal(
      (
        await f.call('/workflow/finance/bills', 'POST', {
          encounter_id: 'enc-001',
          mode: 'Insurance',
        })
      ).status,
      409,
    );
    const other = await f.call('/workflow/finance/bills', 'POST', {
      encounter_id: 'enc-002',
      mode: 'Insurance',
    });
    assert.equal(
      (
        await f.call(`/workflow/finance/bills/${other.data.id}`, 'PATCH', {
          revision: 1,
          policy_id: p.id,
          lines: f.lines,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.call(`/workflow/finance/bills/${other.data.id}`, 'PATCH', {
          revision: 1,
          policy_id: '',
          lines: f.lines,
        })
      ).status,
      200,
    );
    assert.match(
      (
        await f.call('/workflow/finance/claims', 'POST', {
          bill_id: other.data.id,
        })
      ).data.error,
      /Sign the encounter/,
    );
    const state = loadWorkflow(f.db);
    state.finance.verifications[0].checked_at = '2000-01-01T00:00:00Z';
    saveWorkflow(f.db, state);
    assert.match(
      (await f.call('/workflow/finance/claims', 'POST', { bill_id: b.id })).data
        .error,
      /seven days/,
    );
    await f.verify(p.id);
    const c = await f.call('/workflow/finance/claims', 'POST', {
      bill_id: b.id,
    });
    assert.equal(c.status, 200);
    assert.equal(
      (await f.call('/workflow/finance/claims', 'POST', { bill_id: b.id }))
        .status,
      409,
    );
    assert.equal(
      (
        await f.call(`/workflow/finance/bills/${b.id}`, 'PATCH', {
          revision: 2,
          policy_id: p.id,
          lines: [],
        })
      ).status,
      409,
    );
    const exported = await f.call(
      `/workflow/finance/claims/${c.data.id}/export`,
    );
    assert.equal(exported.data.transmitted, false);
    assert.match(exported.data.document_type, /not an X12 837/);
  } finally {
    await f.close();
  }
});
test('charge validation rejects fractional cents, invalid codes, stale edits and excessive totals', async () => {
  const f = await fixture();
  try {
    const b = await f.bill('', 'enc-001', 'Self-pay');
    for (const change of [
      { unit_cents: 100.5 },
      { units: 0 },
      { code: 'anything' },
      { diagnosis: 'BAD!' },
      { unit_cents: 100_000_000, units: 2 },
    ]) {
      const result = await f.call(`/workflow/finance/bills/${b.id}`, 'PATCH', {
        revision: 2,
        policy_id: '',
        lines: [{ ...f.lines[0], ...change }],
      });
      assert.equal(result.status, 400);
    }
    assert.equal(
      (
        await f.call(`/workflow/finance/bills/${b.id}`, 'PATCH', {
          revision: 1,
          policy_id: '',
          lines: f.lines,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call(`/workflow/finance/bills/${b.id}/payments`, 'POST', {
          amount_cents: 1,
          reference: 'premature',
        })
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});
test('demo denial follow-up and remittance reconcile insurer payments, adjustments and patient responsibility exactly once', async () => {
  const f = await fixture();
  try {
    const { b, c } = await f.claim();
    const route = `/workflow/finance/claims/${c.id}`;
    const response = {
      reference: 'REMIT-1',
      outcome: 'Approved',
      payer_paid_cents: 10000,
      adjustment_cents: 2500,
      patient_responsibility_cents: 2500,
      denial_reason: '',
    };
    assert.equal(
      (await f.call(`${route}/remittance`, 'POST', response)).status,
      409,
    );
    assert.equal((await f.call(`${route}/submit`, 'POST', {})).status, 200);
    assert.equal((await f.call(`${route}/submit`, 'POST', {})).status, 409);
    assert.equal(
      (
        await f.call(`${route}/remittance`, 'POST', {
          ...response,
          payer_paid_cents: 10001,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.call(`${route}/remittance`, 'POST', {
          ...response,
          outcome: 'Denied',
          denial_reason: 'Member review required',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.call(`${route}/remittance`, 'POST', {
          ...response,
          outcome: 'Denied',
          payer_paid_cents: 0,
          adjustment_cents: 0,
          patient_responsibility_cents: 0,
          denial_reason: 'Member review required',
        })
      ).status,
      200,
    );
    const denied = (await f.call('/workflow/finance/bills')).data[0];
    assert.equal(denied.patient_balance_cents, null);
    assert.equal(denied.balance_cents, 15000);
    assert.equal(denied.ledger.length, 0);
    assert.equal((await f.call(`${route}/submit`, 'POST', {})).status, 400);
    assert.equal(
      (
        await f.call(`${route}/submit`, 'POST', {
          correction_note: 'Confirmed subscriber details with patient',
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.call(`${route}/remittance`, 'POST', response)).status,
      409,
    );
    assert.equal(
      (
        await f.call(`${route}/remittance`, 'POST', {
          ...response,
          reference: 'REMIT-2',
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.call(`${route}/remittance`, 'POST', {
          ...response,
          reference: 'REMIT-3',
        })
      ).status,
      409,
    );
    const posted = (await f.call('/workflow/finance/bills')).data.find(
      (x: any) => x.id === b.id,
    );
    assert.equal(posted.paid_cents, 10000);
    assert.equal(posted.adjustment_cents, 2500);
    assert.equal(posted.patient_balance_cents, 2500);
    assert.equal(posted.balance_cents, 2500);
    assert.equal(posted.unallocated_cents, 0);
    assert.equal(posted.remittances.length, 2);
  } finally {
    await f.close();
  }
});
test('manual patient payments reject overpayments and duplicates and preserve reversible immutable ledger entries', async () => {
  const f = await fixture();
  try {
    const b = await f.bill('', 'enc-001', 'Self-pay');
    await f.call(`/workflow/finance/bills/${b.id}/finalize`, 'POST', {});
    const route = `/workflow/finance/bills/${b.id}/payments`;
    assert.equal(
      (await f.call(route, 'POST', { amount_cents: 15001, reference: 'over' }))
        .status,
      409,
    );
    const payment = await f.call(route, 'POST', {
      amount_cents: 2500,
      reference: 'RECEIPT-001',
      note: 'Received externally',
    });
    assert.equal(payment.status, 200);
    assert.equal(
      (
        await f.call(route, 'POST', {
          amount_cents: 2500,
          reference: 'receipt-001',
        })
      ).status,
      409,
    );
    let row = (await f.call('/workflow/finance/bills')).data[0];
    assert.equal(row.patient_balance_cents, 12500);
    const reversal = `/workflow/finance/payments/${payment.data.id}/reverse`;
    assert.equal(
      (await f.call(reversal, 'POST', { reason: 'Correcting entry error' }))
        .status,
      200,
    );
    assert.equal(
      (await f.call(reversal, 'POST', { reason: 'Correcting entry error' }))
        .status,
      409,
    );
    row = (await f.call('/workflow/finance/bills')).data[0];
    assert.equal(row.patient_balance_cents, 15000);
    assert.equal(row.ledger.length, 2);
    assert.equal(row.ledger[0].amount_cents, 2500);
    await f.call(route, 'POST', {
      amount_cents: 15000,
      reference: 'RECEIPT-002',
    });
    const statement = await f.call(`/workflow/finance/bills/${b.id}/statement`);
    assert.equal(statement.data.patient_balance_cents, 0);
    assert.equal(statement.data.charges_cents, 15000);
  } finally {
    await f.close();
  }
});
test('policy changes require explicit claim coverage refresh and preserve the previous snapshot', async () => {
  const f = await fixture();
  try {
    const { p, c } = await f.claim();
    const route = `/workflow/finance/claims/${c.id}`;
    await f.call(`/workflow/finance/policies/${p.id}`, 'PATCH', {
      ...f.coverage,
      member_id: 'UPDATED-MEMBER',
      revision: 1,
    });
    assert.equal((await f.call(`${route}/submit`, 'POST', {})).status, 409);
    assert.equal(
      (await f.call(`${route}/refresh-coverage`, 'POST', {})).status,
      409,
    );
    await f.verify(p.id);
    const refreshed = await f.call(`${route}/refresh-coverage`, 'POST', {});
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.data.policy.member_id, 'UPDATED-MEMBER');
    assert.equal(
      refreshed.data.previous_coverage[0].policy.member_id,
      f.coverage.member_id,
    );
    assert.equal((await f.call(`${route}/submit`, 'POST', {})).status, 200);
  } finally {
    await f.close();
  }
});
test('front desk can manage finance without access to clinical note content and finance migrates existing workflow data', async () => {
  const f = await fixture();
  try {
    const state = loadWorkflow(f.db);
    delete (state as any).finance;
    saveWorkflow(f.db, state);
    const migrated = loadWorkflow(f.db);
    assert.deepEqual(migrated.finance.bills, []);
    const visits = await f.call(
      '/workflow/finance/visits',
      'GET',
      undefined,
      f.front,
    );
    assert.equal(visits.status, 200);
    assert.ok(visits.data.length >= 3);
    assert.ok(!('assessment' in visits.data[0]));
    assert.ok(!('subjective' in visits.data[0]));
    f.db
      .prepare(
        "UPDATE encounters SET appointment_id=NULL,created_at='2026-06-15 10:00:00' WHERE id='enc-002'",
      )
      .run();
    const originalZone = process.env.TZ;
    try {
      process.env.TZ = 'Pacific/Auckland';
      const dated = await f.call('/workflow/finance/visits');
      assert.equal(
        dated.data.find((v: any) => v.id === 'enc-002').service_date,
        '2026-06-15',
      );
    } finally {
      if (originalZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalZone;
    }
    const p = await f.call(
      '/workflow/finance/policies',
      'POST',
      f.coverage,
      f.front,
    );
    assert.equal(p.status, 200);
    assert.equal(
      (await f.call('/encounters', 'GET', undefined, f.front)).status,
      403,
    );
    const b = await f.bill(p.data.id);
    const summary = (await f.call('/workflow/finance/summary')).data;
    assert.equal(summary.unallocated_cents, 15000);
    assert.equal(summary.patient_balance_cents, 0);
    assert.equal(summary.clearinghouse_connected, false);
    assert.equal(loadWorkflow(f.db).finance.bills[0].id, b.id);
    assert.ok(
      f.db
        .prepare("SELECT * FROM audit WHERE action='Added insurance policy'")
        .get(),
    );
  } finally {
    await f.close();
  }
});

test('finance records and posted ledger survive a database reopen without reseeding', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cevrali-finance-'));
  const filename = join(directory, 'finance.sqlite');
  const f = await fixture(filename);
  try {
    const b = await f.bill('', 'enc-001', 'Self-pay');
    assert.equal(
      (await f.call(`/workflow/finance/bills/${b.id}/finalize`, 'POST', {}))
        .status,
      200,
    );
    assert.equal(
      (
        await f.call(`/workflow/finance/bills/${b.id}/payments`, 'POST', {
          amount_cents: 1234,
          reference: 'REOPEN-RECEIPT',
        })
      ).status,
      200,
    );
  } finally {
    await f.close();
  }
  try {
    const reopened = createDatabase(filename);
    try {
      const saved = loadWorkflow(reopened).finance;
      assert.equal(saved.bills.length, 1);
      assert.equal(saved.ledger[0].amount_cents, 1234);
      assert.equal(saved.bills[0].lines[0].unit_cents, 15000);
      assert.ok(saved.bills[0].finalized_at);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('registration atomically saves patient coverage and a demo check for the new patient', async () => {
  const f = await fixture();
  try {
    const result = await f.call(
      '/patients',
      'POST',
      {
        first_name: 'Registration',
        last_name: 'Insured',
        dob: '1992-03-04',
        sex: 'Unknown',
        phone: '555-0150',
        insurance: {
          policy: {
            ...f.coverage,
            patient_id: 'pat-001',
            subscriber_name: 'Registration Insured',
            subscriber_dob: '1992-03-04',
          },
          verification: { service_date: clinicDate(), scenario: 'Active' },
        },
      },
      f.front,
    );
    assert.equal(result.status, 201);
    const rows = (
      await f.call(`/workflow/finance/policies?patient_id=${result.data.id}`)
    ).data;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].patient_id, result.data.id);
    assert.equal(rows[0].verifications[0].status, 'Active');
    assert.equal(
      (await f.call('/workflow/finance/policies?patient_id=pat-001')).data
        .length,
      0,
    );
    assert.equal(
      (await f.call(`/patients/${result.data.id}`, 'GET', undefined, f.front))
        .status,
      403,
    );
    const state = loadWorkflow(f.db);
    assert.equal(state.finance.policies[0].id, rows[0].id);
  } finally {
    await f.close();
  }
});
test('invalid registration insurance or verification rolls back patient, policy, and audit writes', async () => {
  const f = await fixture();
  try {
    const before = f.db.prepare('SELECT COUNT(*) n FROM patients').get()!.n;
    const auditBefore = f.db.prepare('SELECT COUNT(*) n FROM audit').get()!.n;
    for (const insurance of [
      { policy: { ...f.coverage, end_date: '1990-01-01' } },
      {
        policy: f.coverage,
        verification: { service_date: '2026-02-30', scenario: 'Active' },
      },
      {
        policy: f.coverage,
        verification: {
          service_date: clinicDate(),
          scenario: 'Not a response',
        },
      },
      null,
    ]) {
      const failed = await f.call('/patients', 'POST', {
        first_name: 'Rollback',
        last_name: 'Example',
        dob: '1990-01-01',
        sex: 'Unknown',
        phone: '555-0151',
        insurance,
      });
      assert.equal(failed.status, 400);
      assert.equal(
        f.db.prepare('SELECT COUNT(*) n FROM patients').get()!.n,
        before,
      );
      assert.equal(loadWorkflow(f.db).finance.policies.length, 0);
      assert.equal(loadWorkflow(f.db).finance.verifications.length, 0);
      assert.equal(
        f.db.prepare('SELECT COUNT(*) n FROM audit').get()!.n,
        auditBefore,
      );
    }
  } finally {
    await f.close();
  }
});
test('patient-scoped finance lists, visit selection and totals exclude other patients and reject mismatched encounters', async () => {
  const f = await fixture();
  try {
    await f.policy();
    await f.bill('', 'enc-001', 'Self-pay');
    await f.bill('', 'enc-002', 'Self-pay');
    const result = await f.call('/workflow/finance/summary?patient_id=pat-001');
    assert.equal(result.data.charges_cents, 15000);
    assert.equal(
      (await f.call('/workflow/finance/summary')).data.charges_cents,
      30000,
    );
    for (const path of ['bills', 'policies', 'visits']) {
      const response = await f.call(
        `/workflow/finance/${path}?patient_id=pat-001`,
      );
      assert.equal(response.status, 200);
      assert.ok(response.data.length > 0);
      assert.ok(response.data.every((r: any) => r.patient_id === 'pat-001'));
    }
    assert.equal(
      (
        await f.call('/workflow/finance/bills', 'POST', {
          patient_id: 'pat-001',
          encounter_id: 'enc-003',
          mode: 'Self-pay',
        })
      ).status,
      400,
    );
    assert.equal(
      (await f.call('/workflow/finance/summary?patient_id=missing')).status,
      404,
    );
  } finally {
    await f.close();
  }
});

async function approvedAuthorization(
  f: Awaited<ReturnType<typeof fixture>>,
  policyId: string,
  visits = 1,
) {
  const created = await f.call('/workflow/finance/authorizations', 'POST', {
    patient_id: 'pat-001',
    policy_id: policyId,
    procedure_codes: ['99213'],
    description: 'Office visits',
    requested_visits: visits,
    valid_from: `${clinicDate().slice(0, 4)}-01-01`,
    valid_to: `${clinicDate().slice(0, 4)}-12-31`,
    due_date: clinicDate(),
  });
  assert.equal(created.status, 200);
  const route = `/workflow/finance/authorizations/${created.data.id}`;
  assert.equal((await f.call(`${route}/submit`, 'POST', {})).status, 200);
  assert.equal(
    (
      await f.call(`${route}/decision`, 'POST', {
        outcome: 'Approved',
        note: 'Demo approval reviewed by staff',
        approval_number: `APPROVAL-${created.data.id}`,
        approved_visits: visits,
        valid_from: created.data.valid_from,
        valid_to: created.data.valid_to,
      })
    ).status,
    200,
  );
  return created.data.id;
}
async function postedClaim(f: Awaited<ReturnType<typeof fixture>>) {
  const source = await f.claim();
  const route = `/workflow/finance/claims/${source.c.id}`;
  await f.call(`${route}/submit`, 'POST', {});
  assert.equal(
    (
      await f.call(`${route}/remittance`, 'POST', {
        reference: 'SOURCE-REMIT',
        outcome: 'Approved',
        payer_paid_cents: 10000,
        adjustment_cents: 2500,
        patient_responsibility_cents: 2500,
        denial_reason: '',
      })
    ).status,
    200,
  );
  const payment = await f.call(
    `/workflow/finance/bills/${source.b.id}/payments`,
    'POST',
    { amount_cents: 2500, reference: 'SOURCE-PAYMENT' },
  );
  assert.equal(payment.status, 200);
  return { ...source, payment: payment.data };
}
async function prepareCorrection(
  f: Awaited<ReturnType<typeof fixture>>,
  billId: string,
  kind = 'Replacement',
  amount = 12000,
) {
  const b = (await f.call('/workflow/finance/bills')).data.find(
    (b: any) => b.id === billId,
  );
  return f.call('/workflow/finance/corrections', 'POST', {
    bill_id: b.id,
    revision: b.revision,
    kind,
    reason: 'Correcting reviewed office visit charge',
    lines: kind === 'Void' ? [] : [{ ...f.lines[0], unit_cents: amount }],
    policy_id: b.policy_id,
    authorization_required: Boolean(b.authorization_required),
    authorization_id: b.authorization_id || '',
  });
}
test('prior authorizations validate coverage, approval limits, lifecycle and immutable decision history', async () => {
  const f = await fixture();
  try {
    const p = await f.policy();
    const authId = await approvedAuthorization(f, p.id, 2);
    const a = (
      await f.call('/workflow/finance/authorizations?patient_id=pat-001')
    ).data[0];
    assert.equal(a.approved_visits, 2);
    assert.equal(a.history.length, 3);
    assert.equal(a.remaining_visits, 2);
    assert.equal(
      (
        await f.call(
          `/workflow/finance/authorizations/${authId}/submit`,
          'POST',
          {},
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call(
          `/workflow/finance/authorizations/${authId}/decision`,
          'POST',
          {},
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call(`/workflow/finance/authorizations/${authId}`, 'PATCH', {
          ...a,
          revision: a.revision,
          requested_visits: 3,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call('/workflow/finance/authorizations', 'POST', {
          ...a,
          patient_id: 'pat-002',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.call(
          `/workflow/finance/authorizations/${authId}/cancel`,
          'POST',
          { reason: 'Service no longer planned' },
        )
      ).status,
      200,
    );
    assert.equal(
      (await f.call('/workflow/finance/authorizations')).data[0].history.length,
      4,
    );
    assert.equal(
      (await f.call('/workflow/finance/authorizations', 'GET', undefined, ''))
        .status,
      401,
    );
  } finally {
    await f.close();
  }
});
test('required authorization enforces matching dates, procedures, policy and a shared visit allowance', async () => {
  const f = await fixture();
  try {
    const p = await f.policy();
    await f.verify(p.id);
    const b = await f.bill(p.id);
    const id = await approvedAuthorization(f, p.id);
    assert.equal(
      (
        await f.call(`/workflow/finance/bills/${b.id}`, 'PATCH', {
          revision: 2,
          policy_id: p.id,
          lines: f.lines,
          authorization_required: true,
          authorization_id: id,
        })
      ).status,
      200,
    );
    const state = loadWorkflow(f.db);
    state.finance.authorizations[0].procedure_codes = ['93000'];
    saveWorkflow(f.db, state);
    assert.match(
      (await f.call('/workflow/finance/claims', 'POST', { bill_id: b.id })).data
        .error,
      /every procedure/,
    );
    state.finance.authorizations[0].procedure_codes = ['99213'];
    state.finance.authorizations[0].valid_to = '2000-01-01';
    saveWorkflow(f.db, state);
    assert.match(
      (await f.call('/workflow/finance/claims', 'POST', { bill_id: b.id })).data
        .error,
      /approval period/,
    );
    state.finance.authorizations[0].valid_to = `${clinicDate().slice(0, 4)}-12-31`;
    saveWorkflow(f.db, state);
    assert.equal(
      (await f.call('/workflow/finance/claims', 'POST', { bill_id: b.id }))
        .status,
      200,
    );
    assert.equal(
      (
        await f.call(`/workflow/finance/authorizations/${id}/cancel`, 'POST', {
          reason: 'Attempt to cancel reserved approval',
        })
      ).status,
      409,
    );
    const created = await f.call('/encounters', 'POST', {
      patient_id: 'pat-001',
      chief_complaint: 'Another reviewed visit',
    });
    assert.equal(created.status, 201);
    const note = (await f.call('/encounters')).data.find(
      (e: any) => e.id === created.data.id,
    );
    assert.equal(
      (
        await f.call(`/encounters/${note.id}`, 'PATCH', {
          ...note,
          assessment: 'Reviewed condition',
          plan: 'Follow-up plan',
          status: 'Signed',
        })
      ).status,
      200,
    );
    const other = await f.bill(p.id, note.id);
    await f.call(`/workflow/finance/bills/${other.id}`, 'PATCH', {
      revision: 2,
      policy_id: p.id,
      lines: f.lines,
      authorization_required: true,
      authorization_id: id,
    });
    assert.match(
      (await f.call('/workflow/finance/claims', 'POST', { bill_id: other.id }))
        .data.error,
      /no approved visits remaining/,
    );
    const listed = (await f.call('/workflow/finance/authorizations')).data[0];
    assert.equal(listed.used_visits, 1);
    assert.equal(listed.remaining_visits, 0);
  } finally {
    await f.close();
  }
});
test('draft claim revisions preserve original charges and source claim without payer transmission', async () => {
  const f = await fixture();
  try {
    const { b, c } = await f.claim();
    const correction = await prepareCorrection(
      f,
      b.id,
      'Draft revision',
      14000,
    );
    assert.equal(correction.status, 200);
    assert.equal(
      (
        await f.call(
          `/workflow/finance/corrections/${correction.data.id}/apply`,
          'POST',
          {},
        )
      ).status,
      200,
    );
    const bill = (await f.call('/workflow/finance/bills')).data[0];
    assert.equal(bill.charges_cents, 14000);
    assert.equal(bill.claim.status, 'Prepared');
    assert.equal(bill.claim.submitted_at, null);
    assert.equal(bill.claim_history[0].total_cents, 15000);
    assert.equal(bill.claim_history[0].status, 'Superseded draft');
    assert.equal(bill.claim.replaces_claim_id, c.id);
    assert.equal(bill.ledger.length, 0);
    assert.equal(bill.corrections[0].original_bill.lines[0].unit_cents, 15000);
    assert.equal(
      (
        await f.call(
          `/workflow/finance/corrections/${correction.data.id}/apply`,
          'POST',
          {},
        )
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});
test('accepted replacement appends insurer reversals, preserves patient receipts and produces a reconciled patient credit', async () => {
  const f = await fixture();
  try {
    const { b, c } = await postedClaim(f);
    const original = loadWorkflow(f.db).finance.ledger;
    const correction = await prepareCorrection(f, b.id);
    assert.equal(correction.status, 200);
    const route = `/workflow/finance/corrections/${correction.data.id}`;
    assert.equal((await f.call(`${route}/submit`, 'POST', {})).status, 200);
    assert.equal(
      (
        await f.call(`${route}/decision`, 'POST', {
          outcome: 'Accepted',
          reference: 'CORRECTION-ACCEPT',
          note: 'Corrected charge accepted in demo',
        })
      ).status,
      200,
    );
    let bill = (await f.call('/workflow/finance/bills')).data[0];
    assert.equal(bill.charges_cents, 12000);
    assert.equal(bill.paid_cents, 2500);
    assert.equal(bill.adjustment_cents, 0);
    assert.equal(bill.patient_balance_cents, null);
    assert.equal(bill.unapplied_patient_cents, 2500);
    assert.equal(bill.claim.replaces_claim_id, c.id);
    assert.equal(bill.claim_history[0].status, 'Demo replaced');
    assert.deepEqual(bill.ledger.slice(0, 3), original);
    const current = bill.claim.id;
    assert.equal(
      (await f.call(`/workflow/finance/claims/${c.id}/remittance`, 'POST', {}))
        .status,
      409,
    );
    assert.equal(
      (
        await f.call(`/workflow/finance/claims/${current}/remittance`, 'POST', {
          reference: 'REPLACEMENT-REMIT',
          outcome: 'Approved',
          payer_paid_cents: 8000,
          adjustment_cents: 2000,
          patient_responsibility_cents: 2000,
          denial_reason: '',
        })
      ).status,
      200,
    );
    bill = (await f.call('/workflow/finance/bills')).data[0];
    assert.equal(bill.balance_cents, 0);
    assert.equal(bill.credit_cents, 500);
    assert.equal(bill.patient_credit_cents, 500);
    assert.equal(bill.patient_balance_cents, 0);
    assert.equal(
      (
        await f.call(`/workflow/finance/bills/${b.id}/payments`, 'POST', {
          amount_cents: 1,
          reference: 'OVER-CREDIT',
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call(`${route}/decision`, 'POST', {
          outcome: 'Accepted',
          reference: 'AGAIN',
          note: 'Trying again',
        })
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});
test('accepted void retains patient credit and releases the reserved authorization visit', async () => {
  const f = await fixture();
  try {
    const p = await f.policy();
    await f.verify(p.id);
    const authId = await approvedAuthorization(f, p.id);
    const b = await f.bill(p.id);
    await f.call(`/workflow/finance/bills/${b.id}`, 'PATCH', {
      revision: 2,
      policy_id: p.id,
      lines: f.lines,
      authorization_required: true,
      authorization_id: authId,
    });
    const claim = (
      await f.call('/workflow/finance/claims', 'POST', { bill_id: b.id })
    ).data;
    await f.call(`/workflow/finance/claims/${claim.id}/submit`, 'POST', {});
    await f.call(`/workflow/finance/claims/${claim.id}/remittance`, 'POST', {
      reference: 'VOID-REMIT',
      outcome: 'Approved',
      payer_paid_cents: 10000,
      adjustment_cents: 2500,
      patient_responsibility_cents: 2500,
      denial_reason: '',
    });
    await f.call(`/workflow/finance/bills/${b.id}/payments`, 'POST', {
      amount_cents: 2500,
      reference: 'VOID-PATIENT-RECEIPT',
    });
    const correction = await prepareCorrection(f, b.id, 'Void');
    assert.equal(correction.status, 200);
    const route = `/workflow/finance/corrections/${correction.data.id}`;
    await f.call(`${route}/submit`, 'POST', {});
    assert.equal(
      (
        await f.call(`${route}/decision`, 'POST', {
          outcome: 'Accepted',
          reference: 'VOID-ACCEPTED',
          note: 'Demo void acknowledged by payer',
        })
      ).status,
      200,
    );
    const bill = (await f.call('/workflow/finance/bills')).data[0];
    assert.equal(bill.charges_cents, 0);
    assert.equal(bill.credit_cents, 2500);
    assert.equal(bill.balance_cents, 0);
    assert.equal(bill.status, 'Demo voided');
    const auth = (await f.call('/workflow/finance/authorizations')).data[0];
    assert.equal(auth.used_visits, 0);
    assert.equal(auth.remaining_visits, 1);
    assert.equal(
      (
        await f.call(
          `/workflow/finance/authorizations/${authId}/cancel`,
          'POST',
          { reason: 'Approval no longer needed' },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.call(`/workflow/finance/bills/${b.id}/payments`, 'POST', {
          amount_cents: 1,
          reference: 'VOID-EXTRA',
        })
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});
test('correction review blocks competing postings and a rejection preserves the original ledger', async () => {
  const f = await fixture();
  try {
    const { b, c, payment } = await postedClaim(f);
    const before = loadWorkflow(f.db).finance.ledger;
    const correction = await prepareCorrection(f, b.id);
    const route = `/workflow/finance/corrections/${correction.data.id}`;
    assert.equal((await prepareCorrection(f, b.id)).status, 409);
    assert.equal(
      (
        await f.call(
          `/workflow/finance/payments/${payment.id}/reverse`,
          'POST',
          { reason: 'Cannot change while correction pending' },
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call(
          `/workflow/finance/claims/${c.id}/refresh-coverage`,
          'POST',
          {},
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call(`/workflow/finance/bills/${b.id}/payments`, 'POST', {
          amount_cents: 1,
          reference: 'BLOCKED',
        })
      ).status,
      409,
    );
    await f.call(`${route}/submit`, 'POST', {});
    assert.equal((await f.call(`${route}/cancel`, 'POST', {})).status, 409);
    assert.equal(
      (
        await f.call(`${route}/decision`, 'POST', {
          outcome: 'Rejected',
          reference: 'REJECT-1',
          note: 'Please review corrected coding details',
        })
      ).status,
      200,
    );
    assert.deepEqual(loadWorkflow(f.db).finance.ledger, before);
    assert.equal(
      (await f.call('/workflow/finance/bills')).data[0].charges_cents,
      15000,
    );
    assert.equal(
      (
        await f.call(
          `/workflow/finance/payments/${payment.id}/reverse`,
          'POST',
          { reason: 'Entry correction after review closed' },
        )
      ).status,
      200,
    );
  } finally {
    await f.close();
  }
});
test('new patient duplicate review uses name and birth date without exposing clinical data', async () => {
  const f = await fixture();
  try {
    const p = (await f.call('/patients')).data.find(
      (p: any) => p.id === 'pat-001',
    );
    const query = new URLSearchParams({
      first_name: p.first_name.toUpperCase(),
      last_name: ` ${p.last_name} `,
      dob: p.dob,
    });
    const matches = await f.call(
      `/patients/matches?${query}`,
      'GET',
      undefined,
      f.front,
    );
    assert.equal(matches.status, 200);
    assert.equal(matches.data[0].id, p.id);
    assert.ok(!('allergies' in matches.data[0]));
    assert.ok(!('conditions' in matches.data[0]));
    const payload = {
      first_name: p.first_name,
      last_name: p.last_name,
      dob: p.dob,
      sex: p.sex,
      phone: p.phone,
    };
    const count = f.db.prepare('SELECT COUNT(*) n FROM patients').get()!.n;
    assert.equal((await f.call('/patients', 'POST', payload)).status, 409);
    assert.equal(
      f.db.prepare('SELECT COUNT(*) n FROM patients').get()!.n,
      count,
    );
    const created = await f.call(
      '/patients',
      'POST',
      { ...payload, duplicate_acknowledged: true },
      f.front,
    );
    assert.equal(created.status, 201);
    assert.notEqual(created.data.id, p.id);
    assert.ok(
      f.db
        .prepare(
          "SELECT * FROM audit WHERE action='Confirmed separate patient after duplicate review'",
        )
        .get(),
    );
  } finally {
    await f.close();
  }
});
test('additive finance migration preserves existing bills and initializes authorization and correction history', async () => {
  const f = await fixture();
  try {
    const { b } = await f.claim();
    const state = loadWorkflow(f.db);
    delete (state.finance as any).authorizations;
    delete (state.finance as any).corrections;
    saveWorkflow(f.db, state);
    const loaded = loadWorkflow(f.db);
    assert.deepEqual(loaded.finance.authorizations, []);
    assert.deepEqual(loaded.finance.corrections, []);
    assert.equal(loaded.finance.bills[0].id, b.id);
    assert.equal(
      (await f.call('/workflow/finance/bills')).data[0].charges_cents,
      15000,
    );
  } finally {
    await f.close();
  }
});
