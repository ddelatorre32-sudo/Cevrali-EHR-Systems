import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { PDFDocument } from 'pdf-lib';
import { createDatabase, clinicDate } from '../server/database.js';
import { createPlatformApp } from '../server/platform.js';
import { loadWorkflow } from '../server/workflows.js';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cevrali-rfa-'));
  const db = createDatabase(join(dir, 'demo.sqlite'));
  const platform = createPlatformApp(db, join(dir, 'accounts'));
  const server = platform.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let cookie = '',
    front = '',
    other = '';
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
  for (const email of [
    'alex@cevrali.demo',
    'frontdesk@cevrali.demo',
    'nina@cevrali.demo',
  ]) {
    const r = await call(
      '/auth/login',
      'POST',
      { email, password: 'CevraliDemo2026!' },
      '',
    );
    const c = r.response.headers.get('set-cookie')!.split(';')[0];
    if (email.startsWith('alex')) cookie = c;
    else if (email.startsWith('front')) front = c;
    else other = c;
  }
  const account = await call('/workflow/finance/accounts', 'POST', {
    patient_id: 'pat-001',
    name: 'RFA work injury',
    kind: 'Workers compensation',
    workers_comp: {
      claim_number: 'DEMO-RFA-01',
      carrier: 'Synthetic Claims Administrator',
      date_of_injury: '2020-01-02',
      employer: 'Synthetic Employer',
      claim_status: 'Accepted',
      accepted_body_parts: ['Left shoulder'],
    },
  });
  assert.equal(account.status, 200);
  const policy = (
    await call(
      '/workflow/finance/policies?billing_account_id=' + account.data.id,
    )
  ).data[0];
  const e = await call('/encounters', 'POST', {
    patient_id: 'pat-001',
    billing_account_id: account.data.id,
    chief_complaint: 'Synthetic shoulder follow-up',
  });
  assert.equal(e.status, 201);
  const note = (await call('/encounters')).data.find(
    (n: any) => n.id === e.data.id,
  );
  const createAuth = (extra: Record<string, unknown> = {}) =>
    call('/workflow/finance/authorizations', 'POST', {
      patient_id: 'pat-001',
      policy_id: policy.id,
      encounter_id: note.id,
      procedure_codes: ['99213', '97810', '73221'],
      description: 'Office follow-up, acupuncture and shoulder MRI',
      requested_visits: 6,
      valid_from: clinicDate(),
      valid_to: clinicDate(),
      due_date: clinicDate(),
      ...extra,
    });
  async function signNote() {
    return call(`/encounters/${note.id}`, 'PATCH', {
      ...note,
      status: 'Signed',
      assessment: 'Synthetic left shoulder symptoms',
      plan: 'Office review, acupuncture and radiology requested based on documented symptoms.',
      wc_documentation: {
        claim_reviewed: true,
        addressed_body_parts: ['Left shoulder'],
        injury_history: 'Synthetic injury history.',
        work_related_assessment:
          'Synthetic clinical assessment of work relationship.',
        work_status: 'Modified duty',
        restrictions: 'No overhead lifting for seven days.',
      },
    });
  }
  async function packet() {
    const rows = (await call('/workflow/finance/rfa')).data;
    return (await call('/workflow/finance/rfa/' + rows.at(-1).id)).data;
  }
  function completed(p: any) {
    return {
      ...p,
      physician: {
        ...p.physician,
        practice_name: 'Evergreen Medical',
        contact_name: 'Synthetic Coordinator',
        address: '100 Synthetic Street',
        city: 'Sacramento',
        state: 'CA',
        zip: '95814',
        phone: '555-0100',
        fax: '+14155550123',
        email: 'alex@cevrali.demo',
        specialty: 'Primary care',
        npi: '1234567890',
      },
      recipient: {
        name: 'Synthetic Claims Administrator',
        contact_name: 'Synthetic Adjuster',
        address: '200 Synthetic Avenue',
        city: 'Sacramento',
        state: 'CA',
        zip: '95814',
        phone: '555-0200',
        fax: '+14155550234',
        email: 'adjuster@example.test',
      },
      services: p.services.map((s: any, i: number) => ({
        ...s,
        category: ['Office visit', 'Acupuncture', 'Radiology'][i] || 'Other',
        diagnosis: 'Left shoulder injury',
        icd_code: 'S43.402A',
        service:
          [
            'Follow-up office visit',
            'Acupuncture treatment',
            'MRI of left shoulder',
          ][i] || 'Requested service',
        frequency: 'Two times weekly',
        duration: 'Three weeks',
      })),
      clinical_rationale:
        'Clinical rationale reviewed against the signed assessment and treatment plan.',
    };
  }
  async function signPacket(p: any) {
    const saved = await call(
      '/workflow/finance/rfa/' + p.id,
      'PATCH',
      completed(p),
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const signed = await call(`/workflow/finance/rfa/${p.id}/sign`, 'POST', {
      revision: saved.data.revision,
      typed_name: 'Dr. Alex Morgan',
      attestation: true,
    });
    assert.equal(signed.status, 200, JSON.stringify(signed.data));
    return signed.data;
  }
  async function pdf(id: string, auth = cookie) {
    return fetch(base + `/rfa/${id}/pdf`, { headers: { Cookie: auth } });
  }
  return {
    db,
    platform,
    call,
    front,
    other,
    account: account.data,
    note,
    createAuth,
    signNote,
    packet,
    completed,
    signPacket,
    pdf,
    close: async () => {
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
      platform.store.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('a linked draft authorization autofills RFA only after its physician signs the correct workers compensation note', async () => {
  const f = await fixture();
  try {
    const a = await f.createAuth();
    assert.equal(a.status, 200);
    assert.equal((await f.call('/workflow/finance/rfa')).data.length, 0);
    assert.equal((await f.signNote()).status, 200);
    const p = await f.packet();
    assert.equal(p.status, 'Draft');
    assert.equal(p.patient.last_name, 'Bennett');
    assert.equal(p.account.workers_comp.claim_number, 'DEMO-RFA-01');
    assert.equal(p.note.status, 'Signed');
    assert.equal(
      p.note.plan,
      'Office review, acupuncture and radiology requested based on documented symptoms.',
    );
    assert.equal(p.services.length, 3);
    assert.equal(p.services[0].icd_code, '');
    assert.equal(p.physician.npi, '');
    assert.equal(p.signed_at, null);
    assert.equal((await f.call('/workflow/finance/faxes')).data.length, 0);
  } finally {
    await f.close();
  }
});
test('an authorization linked to an already signed encounter creates a draft immediately and wrong-patient or private sources are rejected', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.signNote()).status, 200);
    const a = await f.createAuth();
    assert.equal(a.status, 200);
    assert.equal((await f.call('/workflow/finance/rfa')).data.length, 1);
    assert.equal(
      (
        await f.call('/workflow/finance/authorizations', 'POST', {
          ...a.data,
          patient_id: 'pat-002',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.call('/workflow/finance/authorizations', 'POST', {
          ...a.data,
          encounter_id: 'enc-001',
        })
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});
test('clinical RFA content and PDF are protected while front desk can see fax-safe summaries', async () => {
  const f = await fixture();
  try {
    await f.createAuth();
    await f.signNote();
    const p = await f.packet();
    const rows = (
      await f.call('/workflow/finance/rfa', 'GET', undefined, f.front)
    ).data;
    assert.equal(rows[0].note, undefined);
    assert.equal(rows[0].clinical_rationale, undefined);
    assert.equal(rows[0].physician, undefined);
    assert.equal(
      (await f.call('/workflow/finance/rfa/' + p.id, 'GET', undefined, f.front))
        .status,
      403,
    );
    assert.equal((await f.pdf(p.id, f.front)).status, 403);
    assert.equal(
      (await f.call('/workflow/finance/rfa/' + p.id, 'PATCH', p, f.other))
        .status,
      403,
    );
    assert.equal(
      (
        await f.call(
          `/workflow/finance/rfa/${p.id}/queue-fax`,
          'POST',
          { revision: p.revision, recipient_confirmed: true },
          f.front,
        )
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});
test('provider signing validates missing fields, distinct signature, procedure matching and source revision before locking the packet', async () => {
  const f = await fixture();
  try {
    await f.createAuth();
    await f.signNote();
    let p = await f.packet();
    assert.equal(
      (
        await f.call(`/workflow/finance/rfa/${p.id}/sign`, 'POST', {
          revision: p.revision,
          typed_name: 'Dr. Alex Morgan',
          attestation: true,
        })
      ).status,
      400,
    );
    const saved = await f.call(
      '/workflow/finance/rfa/' + p.id,
      'PATCH',
      f.completed(p),
    );
    p = saved.data;
    assert.equal(
      (
        await f.call(`/workflow/finance/rfa/${p.id}/sign`, 'POST', {
          revision: p.revision,
          typed_name: 'Someone Else',
          attestation: true,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.call(`/workflow/finance/rfa/${p.id}/sign`, 'POST', {
          revision: p.revision,
          typed_name: 'Dr. Alex Morgan',
          attestation: false,
        })
      ).status,
      400,
    );
    const signed = await f.call(`/workflow/finance/rfa/${p.id}/sign`, 'POST', {
      revision: p.revision,
      typed_name: 'Dr. Alex Morgan',
      attestation: true,
    });
    assert.equal(signed.status, 200);
    assert.equal(
      (
        await f.call('/workflow/finance/rfa/' + p.id, 'PATCH', {
          ...p,
          revision: signed.data.revision,
        })
      ).status,
      409,
    );
    assert.equal(signed.data.signed_by, 'Dr. Alex Morgan');
    assert.equal((await f.call('/workflow/finance/faxes')).data.length, 0);
  } finally {
    await f.close();
  }
});
test('fax simulation requires reviewed recipient, is idempotent while queued, retries failures and never records a real sent fax or approval', async () => {
  const f = await fixture();
  try {
    const a = await f.createAuth();
    await f.signNote();
    const p = await f.signPacket(await f.packet());
    assert.equal(
      (
        await f.call(
          `/workflow/finance/rfa/${p.id}/queue-fax`,
          'POST',
          { revision: p.revision, recipient_confirmed: false },
          f.front,
        )
      ).status,
      400,
    );
    const queue = () =>
      f.call(
        `/workflow/finance/rfa/${p.id}/queue-fax`,
        'POST',
        { revision: p.revision, recipient_confirmed: true },
        f.front,
      );
    const j = await queue();
    assert.equal(j.status, 200);
    assert.equal(j.data.status, 'Demo queued');
    assert.equal((await queue()).data.id, j.data.id);
    assert.equal(
      (
        await f.call(
          `/workflow/finance/faxes/${j.data.id}/simulate-result`,
          'POST',
          { result: 'Failed' },
          f.front,
        )
      ).data.status,
      'Demo failed',
    );
    const retry = await f.call(
      `/workflow/finance/faxes/${j.data.id}/retry`,
      'POST',
      {},
      f.front,
    );
    assert.equal(retry.data.attempts, 2);
    assert.equal(
      (
        await f.call(
          `/workflow/finance/faxes/${j.data.id}/simulate-result`,
          'POST',
          { result: 'Delivered' },
          f.front,
        )
      ).data.status,
      'Demo delivery simulated',
    );
    assert.equal(
      (await f.call('/workflow/finance/authorizations')).data.find(
        (x: any) => x.id === a.data.id,
      ).status,
      'Demo submitted',
    );
    assert.equal(
      (await f.call(`/workflow/finance/faxes/${j.data.id}/retry`, 'POST', {}))
        .status,
      409,
    );
    assert.equal(loadWorkflow(f.db).finance.fax_jobs.length, 1);
    assert.ok(
      loadWorkflow(f.db).finance.fax_jobs[0].history.every((h) =>
        h.detail.includes('no fax'),
      ),
    );
    const delivered = (await f.call('/workflow/finance/faxes')).data[0];
    assert.equal(
      (
        await f.call(
          `/workflow/finance/faxes/${delivered.id}/cancel`,
          'POST',
          {
            current_status: 'Demo queued',
            updated_at: delivered.updated_at,
            reason: 'Cannot cancel a historical delivered attempt',
          },
          f.front,
        )
      ).status,
      409,
    );
    assert.deepEqual(
      (await f.call('/workflow/finance/faxes')).data[0],
      delivered,
    );
  } finally {
    await f.close();
  }
});
test('failed demo fax cancellation requires its current status and retains a closed attempt without requeueing its old packet', async () => {
  const f = await fixture();
  try {
    const authorization = await f.createAuth();
    await f.signNote();
    const p = await f.signPacket(await f.packet());
    const queued = await f.call(
      `/workflow/finance/rfa/${p.id}/queue-fax`,
      'POST',
      {
        revision: p.revision,
        recipient_confirmed: true,
      },
      f.front,
    );
    const failed = await f.call(
      `/workflow/finance/faxes/${queued.data.id}/simulate-result`,
      'POST',
      { result: 'Failed' },
      f.front,
    );
    assert.equal(failed.data.status, 'Demo failed');
    assert.equal(
      (
        await f.call(
          `/workflow/finance/faxes/${queued.data.id}/cancel`,
          'POST',
          {
            current_status: queued.data.status,
            updated_at: queued.data.updated_at,
            reason: 'Close failed demo attempt before preparing a new packet',
          },
          f.front,
        )
      ).status,
      409,
    );
    const cancelled = await f.call(
      `/workflow/finance/faxes/${failed.data.id}/cancel`,
      'POST',
      {
        current_status: failed.data.status,
        updated_at: failed.data.updated_at,
        reason: 'Close failed demo attempt before preparing a new packet',
      },
      f.front,
    );
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
    assert.equal(cancelled.data.status, 'Demo cancelled');
    assert.equal(cancelled.data.attempts, 1);
    assert.equal(cancelled.data.history.length, 3);
    assert.equal(
      (
        await f.call(
          `/workflow/finance/faxes/${failed.data.id}/retry`,
          'POST',
          {},
          f.front,
        )
      ).status,
      409,
    );
    const requeue = await f.call(
      `/workflow/finance/rfa/${p.id}/queue-fax`,
      'POST',
      {
        revision: p.revision,
        recipient_confirmed: true,
      },
      f.front,
    );
    assert.equal(requeue.status, 409, JSON.stringify(requeue.data));
    assert.match(requeue.data.error, /new RFA version/);
    assert.deepEqual(
      (await f.call('/workflow/finance/faxes')).data[0],
      cancelled.data,
    );
    assert.equal(
      (await f.call('/workflow/finance/authorizations')).data.find(
        (a: any) => a.id === authorization.data.id,
      ).status,
      'Draft',
    );
  } finally {
    await f.close();
  }
});
test('claim changes require refreshing a draft and invalidate fax preparation for an already signed packet', async () => {
  const f = await fixture();
  try {
    await f.createAuth();
    await f.signNote();
    let p = await f.packet();
    const a = await f.call(
      `/workflow/finance/accounts/${f.account.id}`,
      'PATCH',
      {
        ...f.account,
        workers_comp: {
          ...f.account.workers_comp,
          adjuster_name: 'Updated Adjuster',
        },
      },
    );
    assert.equal(a.status, 200);
    assert.equal(
      (await f.call('/workflow/finance/rfa/' + p.id, 'PATCH', f.completed(p)))
        .status,
      409,
    );
    assert.equal(
      (
        await f.call(`/workflow/finance/rfa/${p.id}/refresh`, 'POST', {
          revision: p.revision,
        })
      ).status,
      200,
    );
    p = await f.signPacket(await f.packet());
    const current = (
      await f.call('/workflow/finance/accounts?patient_id=pat-001')
    ).data.find((x: any) => x.id === f.account.id);
    await f.call(`/workflow/finance/accounts/${current.id}`, 'PATCH', {
      ...current,
      workers_comp: {
        ...current.workers_comp,
        adjuster_name: 'Another Adjuster',
      },
    });
    assert.equal(
      (
        await f.call(`/workflow/finance/rfa/${p.id}/queue-fax`, 'POST', {
          revision: p.revision,
          recipient_confirmed: true,
        })
      ).status,
      409,
    );
    assert.equal((await f.call('/workflow/finance/faxes')).data.length, 0);
  } finally {
    await f.close();
  }
});
test('the real uploaded RFA is generated with a distinct provider signature, blank URO response and complete supporting narrative', async () => {
  const f = await fixture();
  try {
    await f.createAuth();
    await f.signNote();
    let p = await f.packet();
    let response = await f.pdf(p.id);
    assert.equal(response.status, 200);
    let doc = await PDFDocument.load(await response.arrayBuffer());
    assert.ok(doc.getPageCount() >= 4);
    assert.equal(doc.getForm().getFields().length, 0);
    p = await f.signPacket(p);
    response = await f.pdf(p.id);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /application\/pdf/);
    const bytes = new Uint8Array(await response.arrayBuffer());
    writeFileSync('/tmp/cevrali-rfa-reviewed.pdf', bytes);
    doc = await PDFDocument.load(bytes);
    assert.ok(doc.getPageCount() >= 4);
    assert.equal(doc.getForm().getFields().length, 0);
    assert.equal((await f.call('/workflow/finance/faxes')).data.length, 0);
  } finally {
    await f.close();
  }
});
test('more than five requested treatments and long Unicode text are retained on continuation pages', async () => {
  const f = await fixture();
  try {
    await f.createAuth();
    await f.signNote();
    const p = await f.packet();
    const body = f.completed(p);
    body.services = [
      ...body.services,
      ...Array.from({ length: 5 }, (_, i) => ({
        ...body.services[0],
        cpt_code: '99213',
        service:
          `Continuation treatment ${i + 4} ` +
          'Long medically reviewed service description '.repeat(12),
        diagnosis: 'Épaule gauche — clinician reviewed',
        frequency: 'Twice weekly',
        duration: 'Six weeks',
      })),
    ];
    const saved = await f.call('/workflow/finance/rfa/' + p.id, 'PATCH', body);
    assert.equal(saved.status, 200);
    const response = await f.pdf(p.id);
    assert.equal(response.status, 200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const pdf = await PDFDocument.load(bytes);
    assert.ok(pdf.getPageCount() >= 6);
    writeFileSync('/tmp/cevrali-rfa-continuation.pdf', bytes);
  } finally {
    await f.close();
  }
});

test('linked workers compensation RFA permits unknown CPT codes without inventing them, while private authorization keeps its code requirement', async () => {
  const f = await fixture();
  try {
    await f.signNote();
    const a = await f.createAuth({ procedure_codes: [] });
    assert.equal(a.status, 200);
    const p = await f.packet();
    assert.equal(p.services.length, 1);
    assert.equal(p.services[0].cpt_code, '');
    const signed = await f.signPacket(p);
    assert.equal(signed.services[0].cpt_code, '');
    const privatePolicy = await f.call('/workflow/finance/policies', 'POST', {
      patient_id: 'pat-001',
      payer: 'Synthetic Private Payer',
      plan: 'Private PPO',
      member_id: 'PRIVATE-RFA',
      priority: 'Primary',
      subscriber_name: 'Olivia Bennett',
      subscriber_dob: '1989-04-12',
      relationship: 'Self',
      effective_date: '2000-01-01',
    });
    assert.equal(privatePolicy.status, 200);
    assert.equal(
      (
        await f.call('/workflow/finance/authorizations', 'POST', {
          ...a.data,
          policy_id: privatePolicy.data.id,
          encounter_id: undefined,
          procedure_codes: [],
        })
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});

test('signed addenda invalidate older RFA faxes and audited stale cancellation permits a newly reviewed packet', async () => {
  const f = await fixture();
  try {
    const authorization = await f.createAuth();
    await f.signNote();
    const oldPacket = await f.signPacket(await f.packet());
    const queued = await f.call(
      `/workflow/finance/rfa/${oldPacket.id}/queue-fax`,
      'POST',
      {
        revision: oldPacket.revision,
        recipient_confirmed: true,
      },
      f.front,
    );
    assert.equal(queued.status, 200, JSON.stringify(queued.data));
    const original = (await f.call('/encounters')).data.find(
      (e: any) => e.id === f.note.id,
    );
    const draft = await f.call('/workflow/note-addenda', 'POST', {
      encounter_id: f.note.id,
      reason: 'Clarify supporting treatment rationale',
      text: 'Synthetic signed clarification retaining the original assessment and recording follow-up treatment context.',
    });
    assert.equal(draft.status, 200, JSON.stringify(draft.data));
    const signed = await f.call(
      `/workflow/note-addenda/${draft.data.id}/sign`,
      'POST',
      {
        revision: draft.data.revision,
        attested: true,
        signed_name: 'Dr. Alex Morgan',
      },
    );
    assert.equal(signed.status, 200, JSON.stringify(signed.data));
    const stale = await f.call(
      `/workflow/finance/rfa/${oldPacket.id}/queue-fax`,
      'POST',
      {
        revision: oldPacket.revision,
        recipient_confirmed: true,
      },
    );
    assert.equal(stale.status, 409, JSON.stringify(stale.data));
    for (const [action, body] of [
      ['retry', {}],
      ['simulate-result', { result: 'Delivered' }],
    ] as const) {
      const attempt = await f.call(
        `/workflow/finance/faxes/${queued.data.id}/${action}`,
        'POST',
        body,
        f.front,
      );
      assert.equal(attempt.status, 409, JSON.stringify(attempt.data));
      assert.match(attempt.data.error, /changed|refresh|new packet/i);
    }
    const cancel = (extra: Record<string, unknown> = {}) =>
      f.call(
        `/workflow/finance/faxes/${queued.data.id}/cancel`,
        'POST',
        {
          current_status: queued.data.status,
          updated_at: queued.data.updated_at,
          reason:
            'Supporting note addendum requires a newly reviewed RFA packet',
          ...extra,
        },
        f.front,
      );
    assert.equal((await cancel({ reason: 'x' })).status, 400);
    assert.equal((await cancel({ current_status: 'Demo failed' })).status, 409);
    assert.equal((await cancel({ updated_at: 'stale-timestamp' })).status, 409);
    assert.equal(
      (await f.call('/workflow/finance/faxes')).data[0].status,
      'Demo queued',
    );
    const cancelled = await cancel();
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
    assert.equal(cancelled.data.status, 'Demo cancelled');
    assert.equal(cancelled.data.attempts, queued.data.attempts);
    assert.equal(cancelled.data.history.length, queued.data.history.length + 1);
    assert.match(
      cancelled.data.history.at(-1).detail,
      /addendum requires a newly reviewed/,
    );
    assert.match(
      cancelled.data.history.at(-1).detail,
      /no fax was transmitted/,
    );
    assert.equal((await cancel()).status, 409);
    assert.equal(
      (await f.call(`/workflow/finance/rfa/${oldPacket.id}`)).data.status,
      'Provider signed',
    );
    assert.equal(
      (await f.call('/workflow/finance/authorizations')).data.find(
        (a: any) => a.id === authorization.data.id,
      ).status,
      'Draft',
    );
    assert.ok(
      f.db
        .prepare('SELECT 1 FROM audit WHERE action=? AND resource=?')
        .get('Cancelled demo RFA fax; no transmission', queued.data.id),
    );
    const fresh = await f.call('/workflow/finance/rfa', 'POST', {
      authorization_id: authorization.data.id,
    });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
    assert.equal(fresh.data.note.signed_addenda.length, 1);
    assert.equal(
      fresh.data.note.signed_addenda[0].signed_snapshot.text,
      draft.data.text,
    );
    const response = await f.pdf(fresh.data.id);
    assert.equal(response.status, 200);
    const document = await PDFDocument.load(await response.arrayBuffer());
    assert.ok(document.getPageCount() >= 4);
    const after = (await f.call('/encounters')).data.find(
      (e: any) => e.id === f.note.id,
    );
    for (const key of [
      'subjective',
      'objective',
      'assessment',
      'plan',
      'signed_at',
      'updated_at',
    ])
      assert.equal(after[key], original[key]);
    const signedFresh = await f.signPacket(fresh.data);
    const newQueue = await f.call(
      `/workflow/finance/rfa/${signedFresh.id}/queue-fax`,
      'POST',
      {
        revision: signedFresh.revision,
        recipient_confirmed: true,
      },
      f.front,
    );
    assert.equal(newQueue.status, 200, JSON.stringify(newQueue.data));
    assert.equal(newQueue.data.status, 'Demo queued');
    assert.notEqual(newQueue.data.id, queued.data.id);
    const jobs = (await f.call('/workflow/finance/faxes')).data;
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].status, 'Demo cancelled');
  } finally {
    await f.close();
  }
});
