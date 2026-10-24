import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, clinicDate } from '../server/database.js';
import { createApp } from '../server/app.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const temp = mkdtempSync(join(tmpdir(), 'cevrali-api-'));
const filename = join(temp, 'test.sqlite');
let db = createDatabase(filename);
let server: Server;
let base: string;
let cookie = '';
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  auth = cookie,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: auth, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { response, data };
}
async function listen() {
  server = createApp(db).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}
async function stop() {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
}
before(listen);
after(async () => {
  await stop();
  db.close();
  rmSync(temp, { recursive: true, force: true });
});

test('health checks exercise SQLite and private routes require a session', async () => {
  assert.equal(
    (await request('/health', 'GET', undefined, '')).data.status,
    'ok',
  );
  assert.equal(
    (await request('/patients', 'GET', undefined, '')).response.status,
    401,
  );
});
test('login rejects bad credentials and creates an HttpOnly session', async () => {
  assert.equal(
    (
      await request('/auth/login', 'POST', {
        email: 'alex@cevrali.demo',
        password: 'wrong',
      })
    ).response.status,
    401,
  );
  const { response, data } = await request('/auth/login', 'POST', {
    email: 'alex@cevrali.demo',
    password: 'CevraliDemo2026!',
  });
  assert.equal(response.status, 200);
  assert.equal(data.role, 'clinician');
  const value = response.headers.get('set-cookie')!;
  assert.match(value, /HttpOnly/);
  assert.match(value, /SameSite=Strict/);
  cookie = value.split(';')[0];
  assert.equal((await request('/auth/me')).data.email, 'alex@cevrali.demo');
});
test('foreign origins and invalid calendar dates are rejected', async () => {
  const payload = {
    first_name: 'Test',
    last_name: 'Patient',
    dob: '1990-02-30',
    sex: 'Unknown',
    phone: '555-0100',
  };
  assert.equal(
    (await request('/patients', 'POST', payload)).response.status,
    400,
  );
  assert.equal(
    (
      await request(
        '/patients',
        'POST',
        { ...payload, dob: '1990-02-28' },
        cookie,
        { Origin: 'https://foreign.example' },
      )
    ).response.status,
    403,
  );
});
let patientId: string;
let appointmentId: string;
let encounterId: string;
test('registers and retrieves a patient chart without exposing clinical data in the directory', async () => {
  const { response, data } = await request('/patients', 'POST', {
    first_name: 'Avery',
    last_name: 'Testcase',
    dob: '1990-02-28',
    sex: 'Other',
    phone: '555-0109',
    allergies: ['Penicillin'],
    conditions: ['Asthma'],
  });
  assert.equal(response.status, 201);
  patientId = data.id;
  const chart = (await request(`/patients/${patientId}`)).data;
  assert.deepEqual(chart.allergies, ['Penicillin']);
  assert.deepEqual(chart.conditions, ['Asthma']);
  const directory = (await request('/patients?q=Avery')).data;
  assert.equal(directory.length, 1);
  assert.equal(directory[0].id, patientId);
  assert.equal(directory[0].allergies, undefined);
});
test('books appointments, rejects overlaps and non-existing patients, and enforces transitions', async () => {
  const payload = {
    patient_id: patientId,
    date: clinicDate(),
    time: '15:00',
    duration: 30,
    type: 'Consultation',
    reason: 'Test visit',
  };
  const { response, data } = await request('/appointments', 'POST', payload);
  assert.equal(response.status, 201);
  appointmentId = data.id;
  assert.equal(
    (await request('/appointments', 'POST', { ...payload, time: '15:15' }))
      .response.status,
    409,
  );
  assert.equal(
    (
      await request('/appointments', 'POST', {
        ...payload,
        patient_id: 'not-a-patient',
        time: '16:00',
      })
    ).response.status,
    404,
  );
  assert.equal(
    (
      await request(`/appointments/${appointmentId}`, 'PATCH', {
        status: 'Completed',
      })
    ).response.status,
    409,
  );
  assert.equal(
    (
      await request(`/appointments/${appointmentId}`, 'PATCH', {
        status: 'Checked in',
      })
    ).response.status,
    200,
  );
  assert.equal(
    (
      await request(`/appointments/${appointmentId}`, 'PATCH', {
        status: 'In progress',
      })
    ).response.status,
    200,
  );
});
test('encounters belong to the appointment patient and repeated starts reuse the note', async () => {
  assert.equal(
    (
      await request('/encounters', 'POST', {
        patient_id: 'pat-001',
        appointment_id: appointmentId,
        chief_complaint: 'Wrong patient',
      })
    ).response.status,
    400,
  );
  const input = {
    patient_id: patientId,
    appointment_id: appointmentId,
    chief_complaint: 'Routine consultation',
  };
  const result = await request('/encounters', 'POST', input);
  assert.equal(result.response.status, 201);
  encounterId = result.data.id;
  assert.equal(
    (await request('/encounters', 'POST', input)).data.id,
    encounterId,
  );
});
test('drafts persist, stale updates are rejected, and signed notes are immutable', async () => {
  let e = (await request('/encounters')).data.find(
    (v: any) => v.id === encounterId,
  );
  const values = {
    chief_complaint: 'Routine consultation',
    subjective: 'Patient reports no acute symptoms.',
    objective: 'Well appearing.',
    assessment: '',
    plan: '',
    bp: '120/80',
    pulse: '72',
    temperature: '36.7',
    status: 'Signed',
    updated_at: e.updated_at,
  };
  assert.equal(
    (await request(`/encounters/${encounterId}`, 'PATCH', values)).response
      .status,
    400,
  );
  const saved = await request(`/encounters/${encounterId}`, 'PATCH', {
    ...values,
    status: 'Draft',
    assessment: 'Routine preventive care',
    plan: 'Follow up in 6 months',
  });
  assert.equal(saved.response.status, 200);
  assert.equal(
    (
      await request(`/encounters/${encounterId}`, 'PATCH', {
        ...values,
        status: 'Draft',
      })
    ).response.status,
    409,
  );
  const signed = await request(`/encounters/${encounterId}`, 'PATCH', {
    ...values,
    assessment: 'Routine preventive care',
    plan: 'Follow up in 6 months',
    updated_at: saved.data.updated_at,
  });
  assert.equal(signed.response.status, 200);
  assert.equal(
    (
      await request(`/encounters/${encounterId}`, 'PATCH', {
        ...values,
        updated_at: signed.data.updated_at,
      })
    ).response.status,
    409,
  );
  e = (await request('/encounters')).data.find(
    (v: any) => v.id === encounterId,
  );
  assert.equal(e.status, 'Signed');
  assert.ok(e.signed_at);
  assert.equal(e.plan, 'Follow up in 6 months');
});
test('task updates, audit events, and lab results are available', async () => {
  assert.equal(
    (await request('/tasks/task-001', 'PATCH', { done: true })).response.status,
    200,
  );
  assert.equal(
    (await request('/tasks')).data.find((t: any) => t.id === 'task-001').done,
    1,
  );
  assert.ok(
    (await request('/labs')).data.some((l: any) => l.name === 'Hemoglobin A1c'),
  );
  const events = (await request('/audit')).data;
  assert.ok(
    events.some(
      (e: any) => e.action === 'Signed encounter' && e.resource === encounterId,
    ),
  );
  assert.ok(
    events.some(
      (e: any) =>
        e.action === 'Opened patient chart' && e.resource === patientId,
    ),
  );
});
test('front desk role can schedule and register but cannot access clinical endpoints or advance visits', async () => {
  const login = await request('/auth/login', 'POST', {
    email: 'frontdesk@cevrali.demo',
    password: 'CevraliDemo2026!',
  });
  const front = login.response.headers.get('set-cookie')!.split(';')[0];
  assert.equal(
    (await request('/patients', 'GET', undefined, front)).response.status,
    200,
  );
  for (const path of [
    `/patients/${patientId}`,
    '/encounters',
    '/labs',
    '/tasks',
    '/audit',
  ])
    assert.equal(
      (await request(path, 'GET', undefined, front)).response.status,
      403,
    );
  assert.equal(
    (
      await request(
        `/appointments/${appointmentId}`,
        'PATCH',
        { status: 'Completed' },
        front,
      )
    ).response.status,
    403,
  );
  assert.equal(
    (
      await request(
        '/patients',
        'POST',
        {
          first_name: 'Front',
          last_name: 'Desk',
          dob: '2000-01-01',
          sex: 'Unknown',
          phone: '555-0199',
          conditions: ['Restricted'],
        },
        front,
      )
    ).response.status,
    403,
  );
  assert.equal(
    (await request('/overview', 'GET', undefined, front)).data.drafts,
    null,
  );
});
test('database contents and sessions survive an application restart', async () => {
  assert.equal(
    (
      await request(`/appointments/${appointmentId}`, 'PATCH', {
        status: 'Completed',
      })
    ).response.status,
    200,
  );
  await stop();
  db.close();
  db = createDatabase(filename);
  await listen();
  const chart = await request(`/patients/${patientId}`);
  assert.equal(chart.response.status, 200);
  assert.equal(chart.data.encounters[0].status, 'Signed');
  assert.equal(
    (await request('/appointments')).data.find(
      (a: any) => a.id === appointmentId,
    ).status,
    'Completed',
  );
});
test('logout invalidates the server session and unknown routes return JSON', async () => {
  assert.equal((await request('/unknown')).response.status, 404);
  assert.equal(
    (await request('/auth/logout', 'POST', {})).response.status,
    200,
  );
  assert.equal((await request('/auth/me')).response.status, 401);
});

async function isolatedLogins(
  run: (
    login: (email: string, password?: string) => Promise<Response>,
  ) => Promise<void>,
) {
  const isolatedServer = createApp(db).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => isolatedServer.once('listening', resolve));
  const address = isolatedServer.address() as AddressInfo;
  const login = (email: string, password = 'incorrect-synthetic-password') =>
    fetch(`http://127.0.0.1:${address.port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  try {
    await run(login);
  } finally {
    await new Promise<void>((resolve, reject) =>
      isolatedServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test('login throttles one normalized account without locking out another account sharing its address', async () => {
  await isolatedLogins(async (login) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const email = attempt % 2 ? ' ALEX@CEVRALI.DEMO ' : 'alex@cevrali.demo';
      assert.equal((await login(email)).status, 401);
    }
    assert.equal(
      (await login('alex@cevrali.demo', 'CevraliDemo2026!')).status,
      429,
    );
    assert.equal(
      (await login(' FRONTDESK@CEVRALI.DEMO ', 'CevraliDemo2026!')).status,
      200,
    );
    assert.equal(
      (await login(' ALEX@CEVRALI.DEMO ', 'CevraliDemo2026!')).status,
      429,
    );

    // A successful login clears only that account's earlier failures.
    for (let attempt = 0; attempt < 9; attempt++)
      assert.equal((await login('frontdesk@cevrali.demo')).status, 401);
    assert.equal(
      (await login('frontdesk@cevrali.demo', 'CevraliDemo2026!')).status,
      200,
    );
    assert.equal((await login(' FRONTDESK@CEVRALI.DEMO ')).status, 401);
    assert.equal(
      (await login('frontdesk@cevrali.demo', 'CevraliDemo2026!')).status,
      200,
    );
  });
});

test('login keeps an address-wide failure limit when emails change or another account signs in', async () => {
  await isolatedLogins(async (login) => {
    for (let attempt = 0; attempt < 90; attempt++)
      assert.equal((await login(`synthetic-${attempt}@example.test`)).status, 401);
    assert.equal(
      (await login('frontdesk@cevrali.demo', 'CevraliDemo2026!')).status,
      200,
    );
    for (let attempt = 90; attempt < 100; attempt++)
      assert.equal((await login(`synthetic-${attempt}@example.test`)).status, 401);
    assert.equal(
      (await login('alex@cevrali.demo', 'CevraliDemo2026!')).status,
      429,
    );
    assert.equal((await login('another-account@example.test')).status, 429);
  });
});
