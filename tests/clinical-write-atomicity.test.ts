import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createDatabase } from '../server/database.js';
import { createApp } from '../server/app.js';
import { initializeAuditIntegrity, verifyAuditIntegrity } from '../server/audit-integrity.js';
import { loadWorkflow } from '../server/workflows.js';

async function fixture() {
  const db = createDatabase(':memory:');
  const server = createApp(db).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let cookie = '';
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
  };
  const login = await call('/auth/login', 'POST', { email: 'alex@cevrali.demo', password: 'CevraliDemo2026!' });
  assert.equal(login.status, 200);
  cookie = login.cookie;
  const patient = await call('/patients', 'POST', { first_name: 'SyntheticAtomic', last_name: 'Encounter', dob: '1990-01-01', sex: 'Unknown', phone: '555-0100' });
  assert.equal(patient.status, 201);
  const received = await call('/workflow/operations/incoming-faxes', 'POST', {
    external_id: 'synthetic-atomic-report', sender: 'Synthetic laboratory', filename: 'report.txt', format: 'text',
    text: 'Patient Name: SyntheticAtomic Encounter\nDOB: 1990-01-01\nDocument Type: Lab report\nSynthetic result for transaction testing only.',
  });
  assert.equal(received.status, 200);
  assert.equal(received.data.status, 'Filed');
  assert.equal(loadWorkflow(db).operations.note_results.length, 0);
  const key = randomBytes(32);
  initializeAuditIntegrity(db, key, { allowLegacyBaseline: true });
  const payload = { patient_id: patient.data.id, chief_complaint: 'Synthetic transaction test' };
  const count = () => Number(db.prepare('SELECT count(*) n FROM encounters').get()!.n);
  const document = () => db.prepare('SELECT document FROM workflow_state WHERE id=1').get()!.document;
  const anchor = () => verifyAuditIntegrity(db, key).anchor;
  return { db, call, patientId: patient.data.id, payload, count, document, anchor, key, close: async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close(); key.fill(0);
  } };
}

test('failed encounter audit rolls back the new note, copied results, workflow and audit chain, and a retry succeeds once', async () => {
  const f = await fixture();
  try {
    const count = f.count(), document = f.document(), anchor = f.anchor();
    f.db.exec("CREATE TRIGGER synthetic_encounter_audit_failure BEFORE INSERT ON audit WHEN NEW.action='Created encounter' BEGIN SELECT RAISE(ABORT,'Synthetic encounter audit failure'); END");
    const failed = await f.call('/encounters', 'POST', f.payload);
    assert.equal(failed.status, 500);
    assert.equal(f.count(), count);
    assert.equal(f.document(), document);
    assert.equal(verifyAuditIntegrity(f.db, f.key).ok, true);
    assert.deepEqual(f.anchor(), anchor);
    assert.equal(f.db.prepare("SELECT count(*) n FROM audit WHERE action='Populated draft note with source-linked outside results'").get()!.n, 0);
    f.db.exec('DROP TRIGGER synthetic_encounter_audit_failure');
    const retried = await f.call('/encounters', 'POST', f.payload);
    assert.equal(retried.status, 201);
    assert.equal(f.count(), count + 1);
    const results = loadWorkflow(f.db).operations.note_results;
    assert.equal(results.length, 1);
    assert.equal(results[0].encounter_id, retried.data.id);
    assert.equal(f.db.prepare("SELECT count(*) n FROM audit WHERE action='Created encounter' AND resource=?").get(retried.data.id)!.n, 1);
    assert.equal(verifyAuditIntegrity(f.db, f.key).ok, true);
  } finally { await f.close(); }
});

test('failed workflow persistence rolls back the encounter and its earlier result-link audit', async () => {
  const f = await fixture();
  try {
    const count = f.count(), document = f.document(), anchor = f.anchor();
    f.db.exec("CREATE TRIGGER synthetic_encounter_workflow_failure BEFORE UPDATE ON workflow_state WHEN EXISTS(SELECT 1 FROM encounters WHERE chief_complaint='Synthetic transaction test') BEGIN SELECT RAISE(ABORT,'Synthetic encounter workflow failure'); END");
    assert.equal((await f.call('/encounters', 'POST', f.payload)).status, 500);
    assert.equal(f.count(), count);
    assert.equal(f.document(), document);
    assert.equal(verifyAuditIntegrity(f.db, f.key).ok, true);
    assert.deepEqual(f.anchor(), anchor);
  } finally { await f.close(); }
});

test('appointment encounter retries return the committed note without duplicating source links or audits', async () => {
  const f = await fixture();
  try {
    const scheduled = await f.call('/appointments', 'POST', { patient_id: f.patientId, date: '2099-01-15', time: '08:00', duration: 30, type: 'Consultation', reason: 'Synthetic transaction test', provider_id: 'usr-clinician' });
    assert.equal(scheduled.status, 201);
    const payload = { ...f.payload, appointment_id: scheduled.data.id };
    const created = await f.call('/encounters', 'POST', payload);
    assert.equal(created.status, 201);
    const count = f.count(), document = f.document(), anchor = f.anchor();
    const retried = await f.call('/encounters', 'POST', payload);
    assert.equal(retried.status, 200);
    assert.equal(retried.data.id, created.data.id);
    assert.equal(f.count(), count);
    assert.equal(f.document(), document);
    assert.deepEqual(f.anchor(), anchor);
  } finally { await f.close(); }
});

for (const failure of ['audit', 'appointment update'] as const) {
  test(`appointment status changes roll back visit state and reminders after a failed ${failure}`, async () => {
    const f = await fixture();
    try {
      const scheduled = await f.call('/appointments', 'POST', { patient_id: f.patientId, date: '2099-01-15', time: '08:00', duration: 30, type: 'Consultation', reason: 'Synthetic transaction test', provider_id: 'usr-clinician' });
      assert.equal(scheduled.status, 201);
      assert.equal((await f.call('/workflow/reminders')).status, 200);
      assert.ok(loadWorkflow(f.db).reminders.some(reminder => reminder.appointment_id === scheduled.data.id && reminder.status === 'Scheduled'));
      const document = f.document(), anchor = f.anchor();
      f.db.exec(failure === 'audit'
        ? "CREATE TRIGGER synthetic_status_failure BEFORE INSERT ON audit WHEN NEW.action='Appointment: Cancelled' BEGIN SELECT RAISE(ABORT,'Synthetic appointment status audit failure'); END"
        : "CREATE TRIGGER synthetic_status_failure BEFORE UPDATE ON appointments WHEN NEW.status='Cancelled' BEGIN SELECT RAISE(ABORT,'Synthetic appointment status update failure'); END");
      assert.equal((await f.call(`/appointments/${scheduled.data.id}`, 'PATCH', { status: 'Cancelled' })).status, 500);
      assert.equal(f.db.prepare('SELECT status FROM appointments WHERE id=?').get(scheduled.data.id)!.status, 'Scheduled');
      assert.equal(f.document(), document);
      assert.equal(verifyAuditIntegrity(f.db, f.key).ok, true);
      assert.deepEqual(f.anchor(), anchor);
      f.db.exec('DROP TRIGGER synthetic_status_failure');
      assert.equal((await f.call(`/appointments/${scheduled.data.id}`, 'PATCH', { status: 'Cancelled' })).status, 200);
      assert.equal(f.db.prepare('SELECT status FROM appointments WHERE id=?').get(scheduled.data.id)!.status, 'Cancelled');
      assert.equal(loadWorkflow(f.db).visits[scheduled.data.id].stage, 'Cancelled');
      assert.ok(loadWorkflow(f.db).reminders.filter(reminder => reminder.appointment_id === scheduled.data.id).every(reminder => reminder.status === 'Cancelled'));
      assert.equal(verifyAuditIntegrity(f.db, f.key).ok, true);
    } finally { await f.close(); }
  });
}

for (const failure of ['audit', 'workflow save'] as const) {
  test(`visit account changes roll back the appointment, treatment release and audit chain after a failed ${failure}`, async () => {
    const f = await fixture();
    try {
      const scheduled = await f.call('/appointments', 'POST', {
        patient_id: f.patientId, date: '2099-01-15', time: '08:00', duration: 30, type: 'Consultation',
        reason: 'Synthetic transaction test', provider_id: 'usr-clinician',
        service_plan: { authorization_required: false, coverage_mode: 'Self-pay', services: [{ approval_id: '', procedure_code: '99213', quantity: 1 }] },
      });
      assert.equal(scheduled.status, 201);
      const account = await f.call('/workflow/finance/accounts', 'POST', { patient_id: f.patientId, name: 'Synthetic alternative private account', kind: 'Private insurance' });
      assert.equal(account.status, 200);
      const previous = `pba-private-${f.patientId}`;
      const document = f.document(), anchor = f.anchor();
      assert.equal(loadWorkflow(f.db).operations.visit_plans.find(plan => plan.appointment_id === scheduled.data.id)!.released, false);
      f.db.exec(failure === 'audit'
        ? "CREATE TRIGGER synthetic_account_failure BEFORE INSERT ON audit WHEN NEW.action LIKE 'Changed scheduled visit billing account to %' BEGIN SELECT RAISE(ABORT,'Synthetic visit account audit failure'); END"
        : "CREATE TRIGGER synthetic_account_failure BEFORE UPDATE ON workflow_state BEGIN SELECT RAISE(ABORT,'Synthetic visit account workflow failure'); END");
      const payload = { billing_account_id: account.data.id, previous_billing_account_id: previous };
      assert.equal((await f.call(`/appointments/${scheduled.data.id}/billing-account`, 'PATCH', payload)).status, 500);
      assert.equal(f.db.prepare('SELECT billing_account_id FROM appointments WHERE id=?').get(scheduled.data.id)!.billing_account_id, previous);
      assert.equal(f.document(), document);
      assert.equal(verifyAuditIntegrity(f.db, f.key).ok, true);
      assert.deepEqual(f.anchor(), anchor);
      f.db.exec('DROP TRIGGER synthetic_account_failure');
      assert.equal((await f.call(`/appointments/${scheduled.data.id}/billing-account`, 'PATCH', payload)).status, 200);
      assert.equal(f.db.prepare('SELECT billing_account_id FROM appointments WHERE id=?').get(scheduled.data.id)!.billing_account_id, account.data.id);
      assert.equal(loadWorkflow(f.db).operations.visit_plans.find(plan => plan.appointment_id === scheduled.data.id)!.released, true);
      assert.equal(f.db.prepare("SELECT count(*) n FROM audit WHERE action='Released visit treatment reservations after insurance change' AND resource=?").get(scheduled.data.id)!.n, 1);
      assert.equal(verifyAuditIntegrity(f.db, f.key).ok, true);
    } finally { await f.close(); }
  });
}
