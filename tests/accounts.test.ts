import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDatabase, clinicDate } from '../server/database.js';
import { createPlatformApp } from '../server/platform.js';
import { tokenHash } from '../server/accounts.js';
import { loadWorkflow } from '../server/workflows.js';

const temp = mkdtempSync(join(tmpdir(), 'cevrali-accounts-'));
let db = createDatabase(join(temp, 'demo.sqlite'));
let platform = createPlatformApp(db, join(temp, 'accounts'));
let server: Server;
let base: string;
const password = 'SyntheticAccount2026!';
async function listen() {
  server = platform.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}
const stop = () =>
  new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
async function call(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = '',
  headers: Record<string, string> = {},
) {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return {
    status: response.status,
    data,
    cookie: response.headers.get('set-cookie')?.split(';')[0] || '',
    headers: response.headers,
  };
}
const signup = (email: string, clinical_access = false) =>
  call('/accounts/signup', 'POST', {
    owner_name: 'Synthetic Owner',
    email,
    password,
    clinical_access,
    practice: {
      name: email.startsWith('alpha') ? 'Alpha Practice' : 'Beta Practice',
      phone: '555-0100',
      address: 'Synthetic test address',
      fax_provider_name: 'Synthetic preferred fax provider',
      fax_from_number: '+14155550123',
    },
  });
let alpha: string,
  beta: string,
  alphaId: string,
  betaId: string,
  ownerId: string,
  patientId: string,
  staffCookie: string,
  staffId: string,
  clinicianCookie: string,
  clinicianId: string,
  inviteToken: string;
before(listen);
after(async () => {
  await stop();
  platform.store.close();
  db.close();
  rmSync(temp, { recursive: true, force: true });
});

test('practice signup creates an empty isolated workspace and hashes credentials and sessions', async () => {
  const a = await signup('alpha@example.test');
  const b = await signup('beta@example.test', true);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  alpha = a.cookie;
  beta = b.cookie;
  alphaId = a.data.practice.id;
  betaId = b.data.practice.id;
  ownerId = a.data.id;
  assert.notEqual(alphaId, betaId);
  assert.equal(a.data.is_admin, true);
  assert.equal(a.data.role, 'receptionist');
  assert.equal(a.data.password, undefined);
  assert.equal(a.data.practice.is_demo, false);
  const configured = (await call('/account', 'GET', undefined, alpha)).data
    .practice;
  assert.equal(
    configured.fax_provider_name,
    'Synthetic preferred fax provider',
  );
  assert.equal(configured.fax_from_number, '+14155550123');
  assert.deepEqual(
    (await call('/workflow/finance/faxes', 'GET', undefined, alpha)).data,
    [],
  );
  assert.match(a.headers.get('set-cookie')!, /HttpOnly/);
  assert.match(a.headers.get('set-cookie')!, /SameSite=Strict/);
  for (const cookie of [alpha, beta]) {
    assert.deepEqual(
      (await call('/patients', 'GET', undefined, cookie)).data,
      [],
    );
    assert.equal(
      (await call('/account', 'GET', undefined, cookie)).data.members.length,
      1,
    );
    assert.deepEqual(
      (await call('/workflow/finance/bills', 'GET', undefined, cookie)).data,
      [],
    );
  }
  const local = platform.store.db(alphaId);
  const u = local
    .prepare('SELECT password FROM users WHERE id=?')
    .get(ownerId)!;
  assert.notEqual(u.password, password);
  assert.match(String(u.password), /^[a-f0-9]+:[a-f0-9]{128}$/);
  const raw = alpha.split('=')[1];
  assert.equal(
    local.prepare('SELECT token FROM sessions').get()!.token,
    tokenHash(raw),
  );
  assert.equal(platform.store.sessionPractice(raw), alphaId);
  assert.ok(
    (
      await call('/auth/login', 'POST', {
        email: 'alex@cevrali.demo',
        password,
      })
    ).status !== 200,
  );
});
test('signup validation rejects weak passwords, duplicate normalized emails and cross-origin writes', async () => {
  assert.equal((await signup('ALPHA@example.test')).status, 409);
  assert.equal(
    (
      await call('/accounts/signup', 'POST', {
        owner_name: 'Owner',
        email: 'weak@example.test',
        password: 'short',
        practice: { name: 'Weak' },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        '/accounts/signup',
        'POST',
        {
          owner_name: 'Owner',
          email: 'foreign@example.test',
          password,
          practice: { name: 'Foreign' },
        },
        '',
        { Origin: 'https://foreign.example' },
      )
    ).status,
    403,
  );
  assert.equal((await call('/patients')).status, 401);
});
test('practice administrators can finish setup with revision protection while clinical access stays separate', async () => {
  const p = (await call('/account', 'GET', undefined, alpha)).data.practice;
  assert.equal(
    (
      await call(
        '/account/practice',
        'PATCH',
        { ...p, phone: '', complete_setup: true },
        alpha,
      )
    ).status,
    400,
  );
  const saved = await call(
    '/account/practice',
    'PATCH',
    { ...p, legal_name: 'Synthetic Alpha LLC', complete_setup: true },
    alpha,
  );
  assert.equal(saved.status, 200);
  assert.ok(saved.data.setup_completed_at);
  assert.equal(
    (await call('/account/practice', 'PATCH', p, alpha)).status,
    409,
  );
  assert.equal(
    (await call('/encounters', 'GET', undefined, alpha)).status,
    403,
  );
  assert.equal(
    (await call('/auth/me', 'GET', undefined, alpha)).data.practice
      .setup_completed_at,
    saved.data.setup_completed_at,
  );
});
test('staff invitations contain hashed expiring single-use tokens and no automatic delivery', async () => {
  const i = await call(
    '/account/invitations',
    'POST',
    { email: 'staff@example.test', role: 'receptionist' },
    alpha,
  );
  assert.equal(i.status, 200);
  inviteToken = i.data.token;
  assert.match(inviteToken, /^[a-f0-9]{64}$/);
  assert.match(i.data.delivery, /no email sent/);
  const row = platform.store.registry
    .prepare('SELECT * FROM invitations WHERE id=?')
    .get(i.data.id)!;
  assert.equal(row.token_hash, tokenHash(inviteToken));
  assert.ok(!JSON.stringify(row).includes(inviteToken));
  const view = await call(`/accounts/invitations/${inviteToken}`);
  assert.equal(view.data.practice_name, 'Alpha Practice');
  assert.equal(view.data.email, 'staff@example.test');
  assert.equal(view.data.members, undefined);
  const accepted = await call(
    `/accounts/invitations/${inviteToken}/accept`,
    'POST',
    { name: 'Synthetic Staff', password },
  );
  assert.equal(accepted.status, 201);
  staffCookie = accepted.cookie;
  staffId = accepted.data.id;
  assert.equal(accepted.data.is_admin, false);
  assert.equal(accepted.data.practice.id, alphaId);
  assert.equal(
    (
      await call(`/accounts/invitations/${inviteToken}/accept`, 'POST', {
        name: 'Replay',
        password,
      })
    ).status,
    409,
  );
  const account = (await call('/account', 'GET', undefined, alpha)).data;
  assert.ok(!JSON.stringify(account).includes(inviteToken));
  assert.equal(account.invitations[0].status, 'Accepted');
});
test('front desk staff cannot manage practice settings, invitations, staff or clinical records', async () => {
  const a = (await call('/account', 'GET', undefined, staffCookie)).data;
  assert.equal(a.is_admin, false);
  assert.deepEqual(a.members, []);
  assert.deepEqual(a.invitations, []);
  assert.equal(
    (await call('/account/practice', 'PATCH', a.practice, staffCookie)).status,
    403,
  );
  assert.equal(
    (
      await call(
        '/account/invitations',
        'POST',
        { email: 'forbidden@example.test', role: 'clinician' },
        staffCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        `/account/members/${ownerId}`,
        'PATCH',
        { role: 'clinician', is_admin: true, is_active: true },
        staffCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (await call('/encounters', 'GET', undefined, staffCookie)).status,
    403,
  );
});
test('invitation revocation, replacement, expiry and practice scoping are enforced', async () => {
  const first = await call(
    '/account/invitations',
    'POST',
    { email: 'waiting@example.test', role: 'clinician' },
    alpha,
  );
  const second = await call(
    '/account/invitations',
    'POST',
    { email: 'waiting@example.test', role: 'clinician' },
    alpha,
  );
  assert.equal(
    (await call(`/accounts/invitations/${first.data.token}`)).status,
    409,
  );
  assert.equal(
    (
      await call(
        `/account/invitations/${second.data.id}/revoke`,
        'POST',
        {},
        beta,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await call(
        `/account/invitations/${second.data.id}/revoke`,
        'POST',
        {},
        alpha,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call(`/accounts/invitations/${second.data.token}`)).status,
    409,
  );
  const expiring = await call(
    '/account/invitations',
    'POST',
    { email: 'expired@example.test', role: 'clinician' },
    alpha,
  );
  platform.store.registry
    .prepare('UPDATE invitations SET expires_at=? WHERE id=?')
    .run('2020-01-01T00:00:00.000Z', expiring.data.id);
  assert.equal(
    (await call(`/accounts/invitations/${expiring.data.token}`)).status,
    410,
  );
  assert.equal(
    (
      await call(
        '/account/invitations',
        'POST',
        { email: 'beta@example.test', role: 'clinician' },
        alpha,
      )
    ).status,
    409,
  );
});
test('staff access changes revoke sessions, prevent owner lockout and reject cross-practice member IDs', async () => {
  assert.equal(
    (
      await call(
        `/account/members/${ownerId}`,
        'PATCH',
        { role: 'receptionist', is_admin: true, is_active: true },
        alpha,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        `/account/members/${staffId}`,
        'PATCH',
        { role: 'receptionist', is_admin: false, is_active: false },
        beta,
      )
    ).status,
    404,
  );
  const update = await call(
    `/account/members/${staffId}`,
    'PATCH',
    { role: 'receptionist', is_admin: true, is_active: true },
    alpha,
  );
  assert.equal(update.status, 200);
  assert.equal(
    (await call('/auth/me', 'GET', undefined, staffCookie)).status,
    401,
  );
  staffCookie = (
    await call('/auth/login', 'POST', { email: 'staff@example.test', password })
  ).cookie;
  assert.equal(
    (
      await call(
        `/account/members/${ownerId}`,
        'PATCH',
        { role: 'receptionist', is_admin: false, is_active: false },
        staffCookie,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        `/account/members/${staffId}`,
        'PATCH',
        { role: 'receptionist', is_admin: false, is_active: false },
        alpha,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call('/auth/me', 'GET', undefined, staffCookie)).status,
    401,
  );
  assert.equal(
    (
      await call('/auth/login', 'POST', {
        email: 'staff@example.test',
        password,
      })
    ).status,
    401,
  );
});
test('new patient registration stays in its practice and scheduling requires an active local clinician', async () => {
  const created = await call(
    '/patients',
    'POST',
    {
      first_name: 'Synthetic',
      last_name: 'Alpha Patient',
      dob: '1990-01-01',
      sex: 'Unknown',
      phone: '555-0100',
    },
    alpha,
  );
  assert.equal(created.status, 201);
  patientId = created.data.id;
  assert.equal(
    (await call('/patients', 'GET', undefined, alpha)).data.length,
    1,
  );
  assert.deepEqual((await call('/patients', 'GET', undefined, beta)).data, []);
  assert.equal(
    (await call(`/patients/${patientId}`, 'GET', undefined, beta)).status,
    404,
  );
  assert.equal(
    (
      await call(
        `/workflow/finance/patients/${patientId}`,
        'GET',
        undefined,
        beta,
      )
    ).status,
    404,
  );
  const input = {
    patient_id: patientId,
    date: clinicDate(),
    time: '18:00',
    duration: 30,
    type: 'Follow-up',
    reason: 'Synthetic account test',
  };
  assert.equal((await call('/appointments', 'POST', input, alpha)).status, 400);
  const invited = await call(
    '/account/invitations',
    'POST',
    { email: 'clinician@example.test', role: 'clinician' },
    alpha,
  );
  const accepted = await call(
    `/accounts/invitations/${invited.data.token}/accept`,
    'POST',
    { name: 'Synthetic Clinician', password },
  );
  clinicianCookie = accepted.cookie;
  clinicianId = accepted.data.id;
  const booked = await call(
    '/appointments',
    'POST',
    { ...input, provider_id: clinicianId },
    alpha,
  );
  assert.equal(booked.status, 201);
  const appt = (
    await call(`/appointments?date=${clinicDate()}`, 'GET', undefined, alpha)
  ).data[0];
  assert.equal(appt.provider_id, clinicianId);
  assert.equal(appt.provider, 'Synthetic Clinician');
  assert.equal(
    (
      await call(
        '/appointments',
        'POST',
        {
          ...input,
          time: '19:00',
          provider_id: (await call('/auth/me', 'GET', undefined, beta)).data.id,
        },
        alpha,
      )
    ).status,
    400,
  );
  assert.equal(
    (await call('/workflow/team', 'GET', undefined, alpha)).data.some(
      (u: any) => u.id === 'usr-clinician',
    ),
    false,
  );
});
test('body/query/header practice selectors cannot bypass cookie routing and expected-practice headers reject switched sessions', async () => {
  assert.equal(
    (await call(`/patients?practice_id=${alphaId}`, 'GET', undefined, beta))
      .data.length,
    0,
  );
  assert.equal(
    (
      await call('/patients', 'GET', undefined, beta, {
        'X-Cevrali-Practice': alphaId,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await call('/patients', 'GET', undefined, alpha, {
        'X-Cevrali-Practice': alphaId,
      })
    ).data.length,
    1,
  );
  const demo = await call('/auth/login', 'POST', {
    email: 'alex@cevrali.demo',
    password: 'CevraliDemo2026!',
  });
  assert.equal(demo.status, 200);
  assert.ok(
    (await call('/patients', 'GET', undefined, demo.cookie)).data.length > 1,
  );
});
test('public intake links route to the correct practice without a cookie and assign review to its clinician', async () => {
  const appt = (
    await call(`/appointments?date=${clinicDate()}`, 'GET', undefined, alpha)
  ).data[0];
  const issued = await call(
    '/workflow/intake-links',
    'POST',
    { appointment_id: appt.id },
    alpha,
  );
  assert.equal(issued.status, 200);
  assert.equal(platform.store.intakePractice(issued.data.token), alphaId);
  const publicView = await call(`/intake-links/${issued.data.token}`);
  assert.equal(publicView.status, 200);
  assert.equal(publicView.data.patient_name, 'Synthetic Alpha Patient');
  assert.equal(publicView.data.members, undefined);
  assert.equal(
    (
      await call(
        `/intake-links/${issued.data.token}/appointment`,
        'PATCH',
        { action: 'confirm' },
        beta,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(`/intake-links/${issued.data.token}`, 'POST', {
        concern: 'Synthetic follow-up',
        symptoms: 'None',
        allergies: [],
        medications: [],
        reminder_consent: false,
        attested: true,
      })
    ).status,
    200,
  );
  assert.ok(
    loadWorkflow(platform.store.db(alphaId)).tasks.some(
      (t) => t.category === 'Intake review' && t.owner_id === clinicianId,
    ),
  );
  assert.equal(loadWorkflow(platform.store.db(betaId)).intakes.length, 0);
});
test('password change verifies the old password, signs out other sessions and keeps the new session active', async () => {
  const other = await call('/auth/login', 'POST', {
    email: 'alpha@example.test',
    password,
  });
  assert.equal(other.status, 200);
  assert.equal(
    (
      await call(
        '/account/password',
        'POST',
        { current_password: 'incorrect', password: 'ChangedSynthetic2026!' },
        alpha,
      )
    ).status,
    400,
  );
  const changed = await call(
    '/account/password',
    'POST',
    { current_password: password, password: 'ChangedSynthetic2026!' },
    alpha,
  );
  assert.equal(changed.status, 200);
  assert.equal(
    (await call('/auth/me', 'GET', undefined, other.cookie)).status,
    401,
  );
  assert.equal((await call('/auth/me', 'GET', undefined, alpha)).status, 401);
  alpha = changed.cookie;
  assert.equal((await call('/auth/me', 'GET', undefined, alpha)).status, 200);
  assert.equal(
    (
      await call('/auth/login', 'POST', {
        email: 'alpha@example.test',
        password,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await call('/auth/login', 'POST', {
        email: 'alpha@example.test',
        password: 'ChangedSynthetic2026!',
      })
    ).status,
    200,
  );
});
test('practice profiles, membership, session routing and patient separation survive restart without synthetic reseeding', async () => {
  await stop();
  platform.store.close();
  db.close();
  db = createDatabase(join(temp, 'demo.sqlite'));
  platform = createPlatformApp(db, join(temp, 'accounts'));
  await listen();
  assert.equal(
    (await call('/auth/me', 'GET', undefined, alpha)).data.practice.id,
    alphaId,
  );
  assert.equal(
    (await call('/patients', 'GET', undefined, alpha)).data.length,
    1,
  );
  assert.deepEqual((await call('/patients', 'GET', undefined, beta)).data, []);
  assert.equal(
    (await call('/account', 'GET', undefined, alpha)).data.practice.legal_name,
    'Synthetic Alpha LLC',
  );
  assert.equal(
    (await call('/auth/me', 'GET', undefined, clinicianCookie)).data.id,
    clinicianId,
  );
  assert.equal(
    platform.store.db(betaId).prepare('SELECT COUNT(*) n FROM users').get()!.n,
    1,
  );
});
