import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createDatabase, clinicDate } from '../server/database.js';
import { createApp } from '../server/app.js';
import { loadWorkflow } from '../server/workflows.js';

async function fixture(filename = ':memory:') {
  const db = createDatabase(filename);
  const server = createApp(db).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let cookie = '',
    front = '';
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
    const r = await call(
      '/auth/login',
      'POST',
      { email, password: 'CevraliDemo2026!' },
      '',
    );
    const c = r.response.headers.get('set-cookie')!.split(';')[0];
    if (email.startsWith('alex')) cookie = c;
    else front = c;
  }
  const wc = {
    claim_number: 'SYNTHETIC-WC-01',
    carrier: 'Demo Work Carrier',
    date_of_injury: '2020-01-02',
    employer: 'Synthetic Employer',
    claim_status: 'Accepted',
    accepted_body_parts: ['Left shoulder', 'Left wrist'],
  };
  const privateCoverage = {
    patient_id: 'pat-001',
    payer: 'Private Demo Payer',
    plan: 'Personal PPO',
    member_id: 'PRIVATE-01',
    priority: 'Primary',
    subscriber_name: 'Olivia Bennett',
    subscriber_dob: '1985-03-14',
    relationship: 'Self',
    effective_date: '2000-01-01',
  };
  const lines = [
    {
      code: '99213',
      description: 'Reviewed office visit',
      diagnosis: 'S43.402A',
      units: 1,
      unit_cents: 15000,
    },
  ];
  const docs = {
    claim_reviewed: true,
    addressed_body_parts: ['Left shoulder'],
    injury_history: 'Synthetic injury while lifting at work.',
    work_related_assessment:
      'Clinician assessed the documented shoulder symptoms in relation to the reported injury.',
    work_status: 'Modified duty',
    restrictions: 'No overhead lifting with left arm for seven days.',
    next_review_date: '',
  };
  async function account(extra: Record<string, unknown> = {}) {
    const r = await call('/workflow/finance/accounts', 'POST', {
      patient_id: 'pat-001',
      name: 'Work injury claim',
      kind: 'Workers compensation',
      workers_comp: wc,
      ...extra,
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  }
  async function encounter(accountId: string) {
    const r = await call('/encounters', 'POST', {
      patient_id: 'pat-001',
      billing_account_id: accountId,
      chief_complaint: 'Synthetic injury follow-up',
    });
    assert.equal(r.status, 201);
    return (await call('/encounters')).data.find(
      (e: any) => e.id === r.data.id,
    );
  }
  async function save(e: any, extra: Record<string, unknown> = {}) {
    return call(`/encounters/${e.id}`, 'PATCH', {
      ...e,
      assessment: 'Synthetic clinical assessment',
      plan: 'Reviewed treatment plan and follow-up',
      status: 'Signed',
      wc_documentation: docs,
      ...extra,
    });
  }
  async function charge(e: any, policyId?: string) {
    const b = await call('/workflow/finance/bills', 'POST', {
      encounter_id: e.id,
      mode: 'Insurance',
    });
    assert.equal(b.status, 200, JSON.stringify(b.data));
    const saved = await call(`/workflow/finance/bills/${b.data.id}`, 'PATCH', {
      revision: 1,
      policy_id: policyId || b.data.policy_id,
      lines,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    return saved.data;
  }
  return {
    db,
    call,
    front,
    wc,
    privateCoverage,
    docs,
    lines,
    account,
    encounter,
    save,
    charge,
    close: async () => {
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
      db.close();
    },
  };
}

test('registration creates private and workers compensation accounts together and rolls back malformed claim data', async () => {
  const f = await fixture();
  try {
    const body = {
      first_name: 'Synthetic',
      last_name: 'Worker',
      dob: '1990-01-01',
      sex: 'Unknown',
      phone: '555-0123',
      insurance: {
        policy: {
          ...f.privateCoverage,
          patient_id: undefined,
          subscriber_name: 'Synthetic Worker',
          subscriber_dob: '1990-01-01',
        },
      },
      workers_comp: { name: 'New work claim', workers_comp: f.wc },
    };
    const r = await f.call('/patients', 'POST', body, f.front);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const accounts = (
      await f.call(`/workflow/finance/accounts?patient_id=${r.data.id}`)
    ).data;
    assert.equal(accounts.length, 2);
    assert.ok(accounts.some((a: any) => a.kind === 'Private insurance'));
    assert.ok(
      accounts.some(
        (a: any) => a.workers_comp?.claim_number === f.wc.claim_number,
      ),
    );
    const policies = (
      await f.call(`/workflow/finance/policies?patient_id=${r.data.id}`)
    ).data;
    assert.equal(policies.length, 2);
    assert.notEqual(
      policies[0].billing_account_id,
      policies[1].billing_account_id,
    );
    const before = JSON.stringify(loadWorkflow(f.db).finance);
    const patients = (await f.call('/patients')).data.length;
    for (const workers_comp of [
      null,
      {
        name: 'Bad claim',
        workers_comp: { ...f.wc, date_of_injury: '2020-02-30' },
      },
      {
        name: 'Bad acceptance',
        workers_comp: { ...f.wc, accepted_body_parts: [] },
      },
    ])
      assert.equal(
        (
          await f.call('/patients', 'POST', {
            ...body,
            first_name: 'Invalid',
            workers_comp,
          })
        ).status,
        400,
      );
    assert.equal((await f.call('/patients')).data.length, patients);
    assert.equal(JSON.stringify(loadWorkflow(f.db).finance), before);
  } finally {
    await f.close();
  }
});
test('one patient can retain private coverage plus multiple distinct injury claims without overlapping primary conflicts', async () => {
  const f = await fixture();
  try {
    const privatePolicy = await f.call(
      '/workflow/finance/policies',
      'POST',
      f.privateCoverage,
    );
    assert.equal(privatePolicy.status, 200);
    const a = await f.account();
    const b = await f.account({
      name: 'Second injury',
      workers_comp: { ...f.wc, claim_number: 'SYNTHETIC-WC-02' },
    });
    assert.notEqual(a.id, b.id);
    assert.equal(
      (await f.call('/workflow/finance/policies?patient_id=pat-001')).data
        .length,
      3,
    );
    assert.equal(
      (
        await f.call('/workflow/finance/accounts', 'POST', {
          ...a,
          id: undefined,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call('/workflow/finance/policies', 'POST', {
          ...f.privateCoverage,
          billing_account_id: a.id,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call(`/workflow/finance/accounts/${a.id}`, 'PATCH', {
          ...a,
          revision: 0,
        })
      ).status,
      409,
    );
    assert.equal(
      (await f.call('/workflow/finance/accounts?patient_id=pat-002')).data.some(
        (a: any) => a.workers_comp,
      ),
      false,
    );
    assert.equal(
      (
        await f.call(`/workflow/finance/accounts/${a.id}`, 'PATCH', {
          ...a,
          patient_id: 'pat-002',
        })
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});
test('scheduling selects the visit account, supports day-of-visit changes, and carries it into the encounter', async () => {
  const f = await fixture();
  try {
    const a = await f.account();
    const privateId = 'pba-private-pat-001';
    const booked = await f.call(
      '/appointments',
      'POST',
      {
        patient_id: 'pat-001',
        billing_account_id: a.id,
        date: clinicDate(),
        time: '20:00',
        duration: 30,
        type: 'Follow-up',
        reason: 'Work injury review',
      },
      f.front,
    );
    assert.equal(booked.status, 201);
    const path = `/appointments/${booked.data.id}/billing-account`;
    const change = (next: string, previous: string) =>
      f.call(
        path,
        'PATCH',
        { billing_account_id: next, previous_billing_account_id: previous },
        f.front,
      );
    assert.equal((await change(privateId, a.id)).status, 200);
    assert.equal((await change(a.id, a.id)).status, 409);
    assert.equal((await change(a.id, privateId)).status, 200);
    const appt = (await f.call('/appointments')).data.find(
      (v: any) => v.id === booked.data.id,
    );
    assert.equal(appt.billing_account_id, a.id);
    assert.equal(appt.billing_account_name, a.name);
    const e = await f.call('/encounters', 'POST', {
      patient_id: 'pat-001',
      appointment_id: appt.id,
      chief_complaint: 'Work follow-up',
    });
    assert.equal(e.status, 201);
    const note = (await f.call('/encounters')).data.find(
      (note: any) => note.appointment_id === appt.id,
    );
    assert.equal(note.billing_account_id, a.id);
    assert.equal(
      note.billing_account_snapshot.workers_comp.claim_number,
      f.wc.claim_number,
    );
    assert.equal((await change(privateId, a.id)).status, 409);
    assert.equal(
      (
        await f.call(`/workflow/finance/accounts/${a.id}`, 'PATCH', {
          ...a,
          workers_comp: { ...a.workers_comp, claim_number: 'CHANGED' },
        })
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});
test('visit account selection rejects another patient and closed accounts without changing scheduled care', async () => {
  const f = await fixture();
  try {
    const a = await f.account();
    const closed = await f.call(`/workflow/finance/accounts/${a.id}`, 'PATCH', {
      ...a,
      status: 'Closed',
    });
    assert.equal(closed.status, 200);
    const appt = {
      patient_id: 'pat-001',
      date: clinicDate(),
      time: '20:00',
      duration: 30,
      type: 'Follow-up',
      reason: 'Synthetic test',
    };
    assert.equal(
      (
        await f.call('/appointments', 'POST', {
          ...appt,
          billing_account_id: a.id,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call('/appointments', 'POST', {
          ...appt,
          billing_account_id: 'pba-private-pat-002',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.call('/encounters', 'POST', {
          patient_id: 'pat-001',
          chief_complaint: 'Synthetic',
          billing_account_id: a.id,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call(
          '/workflow/finance/policies?patient_id=pat-002&billing_account_id=' +
            a.id,
        )
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});
test('workers compensation signature requires reviewed accepted body parts, injury assessment and explicit work restrictions', async () => {
  const f = await fixture();
  try {
    const a = await f.account();
    const e = await f.encounter(a.id);
    for (const docs of [
      {},
      { ...f.docs, claim_reviewed: false },
      { ...f.docs, addressed_body_parts: ['Right knee'] },
      { ...f.docs, restrictions: '' },
      { ...f.docs, injury_history: '' },
      { ...f.docs, work_status: 'Not assessed' },
    ])
      assert.equal(
        (await f.save(e, { wc_documentation: docs })).status,
        400,
        JSON.stringify(docs),
      );
    assert.equal(
      (
        await f.save(e, {
          wc_documentation: { ...f.docs, account_revision: 0 },
        })
      ).status,
      409,
    );
    assert.equal((await f.save(e)).status, 200);
    const signed = (await f.call('/encounters')).data.find(
      (v: any) => v.id === e.id,
    );
    assert.deepEqual(signed.wc_documentation.addressed_body_parts, [
      'Left shoulder',
    ]);
    assert.equal(
      signed.billing_account_snapshot.workers_comp.claim_number,
      f.wc.claim_number,
    );
    assert.equal(
      (await f.save(signed, { billing_account_id: 'pba-private-pat-001' }))
        .status,
      409,
    );
    assert.equal(
      (await f.call(`/encounters/${e.id}`, 'PATCH', signed, f.front)).status,
      403,
    );
  } finally {
    await f.close();
  }
});
test('draft account changes are explicit and allowed only before billing; private notes require no work-comp documentation', async () => {
  const f = await fixture();
  try {
    const a = await f.account();
    const e = await f.encounter(a.id);
    const changed = await f.save(e, {
      status: 'Draft',
      billing_account_id: 'pba-private-pat-001',
      wc_documentation: null,
    });
    assert.equal(changed.status, 200);
    const draft = (await f.call('/encounters')).data.find(
      (v: any) => v.id === e.id,
    );
    assert.equal(draft.wc_documentation, null);
    assert.equal((await f.save(draft, { wc_documentation: null })).status, 200);
    const e2 = await f.encounter(a.id);
    await f.charge(e2);
    assert.equal(
      (
        await f.save(e2, {
          status: 'Draft',
          billing_account_id: 'pba-private-pat-001',
        })
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});
test('workers compensation billing selects its carrier, protects corrections and never assigns private-plan benefits or patient liability', async () => {
  const f = await fixture();
  try {
    const privatePolicy = (
      await f.call('/workflow/finance/policies', 'POST', f.privateCoverage)
    ).data;
    const a = await f.account();
    const e = await f.encounter(a.id);
    assert.equal((await f.save(e)).status, 200);
    const b = await f.charge(e);
    assert.ok(b.policy_id);
    assert.equal(
      (
        await f.call(`/workflow/finance/bills/${b.id}`, 'PATCH', {
          revision: b.revision,
          policy_id: privatePolicy.id,
          lines: f.lines,
        })
      ).status,
      400,
    );
    assert.equal(
      (await f.call('/workflow/finance/claims', 'POST', { bill_id: b.id }))
        .status,
      409,
    );
    const checked = await f.call(
      `/workflow/finance/policies/${b.policy_id}/verify`,
      'POST',
      { service_date: clinicDate(), scenario: 'Active' },
    );
    assert.equal(checked.status, 200);
    assert.equal(checked.data.copay_cents, null);
    assert.equal(checked.data.deductible_remaining_cents, null);
    assert.equal(checked.data.coinsurance_percent, null);
    assert.match(checked.data.source, /workers compensation/);
    const claim = await f.call('/workflow/finance/claims', 'POST', {
      bill_id: b.id,
    });
    assert.equal(claim.status, 200);
    assert.equal(claim.data.policy.payer, f.wc.carrier);
    assert.equal(
      claim.data.billing_account.workers_comp.claim_number,
      f.wc.claim_number,
    );
    assert.equal(
      (await f.call(`/workflow/finance/claims/${claim.data.id}/export`)).data
        .claim.billing_account.id,
      a.id,
    );
    assert.equal(
      (
        await f.call('/workflow/finance/corrections', 'POST', {
          bill_id: b.id,
          revision: b.revision,
          kind: 'Draft revision',
          reason: 'Wrong payer attempt',
          policy_id: privatePolicy.id,
          lines: f.lines,
          authorization_required: false,
          authorization_id: '',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.call(
          `/workflow/finance/claims/${claim.data.id}/submit`,
          'POST',
          {},
        )
      ).status,
      200,
    );
    const remit = {
      reference: 'SYNTHETIC-REMIT',
      outcome: 'Approved',
      payer_paid_cents: 12500,
      adjustment_cents: 0,
      patient_responsibility_cents: 2500,
      denial_reason: '',
    };
    assert.equal(
      (
        await f.call(
          `/workflow/finance/claims/${claim.data.id}/remittance`,
          'POST',
          remit,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await f.call(
          `/workflow/finance/claims/${claim.data.id}/remittance`,
          'POST',
          {
            ...remit,
            payer_paid_cents: 15000,
            patient_responsibility_cents: 0,
          },
        )
      ).status,
      200,
    );
    assert.equal(
      (await f.call('/workflow/finance/bills?billing_account_id=' + a.id))
        .data[0].patient_balance_cents,
      0,
    );
  } finally {
    await f.close();
  }
});
test('claim-detail edits preserve signed snapshots and later unrelated visits can use private insurance again', async () => {
  const f = await fixture();
  try {
    const a = await f.account();
    const e = await f.encounter(a.id);
    assert.equal((await f.save(e)).status, 200);
    assert.equal(
      (
        await f.call(`/workflow/finance/accounts/${a.id}`, 'PATCH', {
          ...a,
          workers_comp: {
            ...a.workers_comp,
            accepted_body_parts: ['Left shoulder', 'Left wrist', 'Left elbow'],
            adjuster_name: 'New adjuster',
          },
        })
      ).status,
      200,
    );
    const signed = (await f.call('/encounters')).data.find(
      (v: any) => v.id === e.id,
    );
    assert.deepEqual(
      signed.billing_account_snapshot.workers_comp.accepted_body_parts,
      ['Left shoulder', 'Left wrist'],
    );
    const privateVisit = await f.encounter('pba-private-pat-001');
    assert.equal(
      (await f.save(privateVisit, { wc_documentation: null })).status,
      200,
    );
    const p = (
      await f.call('/workflow/finance/policies', 'POST', f.privateCoverage)
    ).data;
    await f.call(`/workflow/finance/policies/${p.id}/verify`, 'POST', {
      service_date: clinicDate(),
      scenario: 'Active',
    });
    const bill = await f.charge(privateVisit, p.id);
    const claim = await f.call('/workflow/finance/claims', 'POST', {
      bill_id: bill.id,
    });
    assert.equal(claim.status, 200);
    assert.equal(claim.data.policy.payer, 'Private Demo Payer');
    assert.equal(claim.data.billing_account.workers_comp, null);
    const frontVisits = (
      await f.call(
        '/workflow/finance/visits?patient_id=pat-001',
        'GET',
        undefined,
        f.front,
      )
    ).data;
    assert.equal(
      frontVisits.find((v: any) => v.id === e.id).wc_documentation,
      undefined,
    );
    assert.equal(
      frontVisits.find((v: any) => v.id === e.id).subjective,
      undefined,
    );
  } finally {
    await f.close();
  }
});
test('pending claims remain drafts until acceptance and accepted body parts are recorded', async () => {
  const f = await fixture();
  try {
    const a = await f.account({
      workers_comp: {
        ...f.wc,
        claim_status: 'Pending',
        accepted_body_parts: [],
      },
    });
    const e = await f.encounter(a.id);
    assert.equal((await f.save(e)).status, 400);
    assert.equal((await f.save(e, { status: 'Draft' })).status, 200);
    const p = (
      await f.call('/workflow/finance/policies?billing_account_id=' + a.id)
    ).data[0];
    assert.equal(
      (
        await f.call(`/workflow/finance/policies/${p.id}/verify`, 'POST', {
          service_date: clinicDate(),
          scenario: 'Active',
        })
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});
test('account migration and workers compensation records survive database restart while legacy signed notes retain private billing', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'cevrali-patient-accounts-'));
  const file = join(temp, 'test.sqlite');
  let f = await fixture(file);
  let id: string;
  try {
    const a = await f.account();
    id = a.id;
    const e = await f.encounter(a.id);
    assert.equal((await f.save(e)).status, 200);
    await f.close();
    f = await fixture(file);
    assert.ok(
      (await f.call('/workflow/finance/accounts?patient_id=pat-001')).data.some(
        (a: any) => a.id === id,
      ),
    );
    const old = (await f.call('/encounters')).data.find(
      (e: any) => e.id === 'enc-001',
    );
    assert.equal(old.billing_account_id, 'pba-private-pat-001');
    assert.equal(old.wc_documentation, null);
    assert.ok(
      (await f.call('/encounters')).data.some(
        (e: any) => e.billing_account_id === id && e.status === 'Signed',
      ),
    );
  } finally {
    await f.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
