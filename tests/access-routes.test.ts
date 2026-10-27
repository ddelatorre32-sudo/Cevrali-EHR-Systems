import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createDatabase } from '../server/database.js';
import { createPlatformApp } from '../server/platform.js';
import { loadRuntimeConfig } from '../server/runtime-config.js';
import { tokenHash } from '../server/accounts.js';

const password = 'SyntheticPilot2026!';
function totp(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret].map(c => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
  const bytes = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', bytes).update(counter).digest();
  return String((digest.readUInt32BE(digest[digest.length - 1] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
}
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cevrali-access-routes-'));
  const db = createDatabase(join(directory, 'base.sqlite'), { seedDemo: false });
  const authKey = randomBytes(32);
  writeFileSync(join(directory, 'auth.key'), authKey.toString('base64'), { mode: 0o600 });
  writeFileSync(join(directory, 'backup.key'), randomBytes(32).toString('base64'), { mode: 0o600 });
  const runtime = loadRuntimeConfig({ CEVRALI_MODE: 'pilot', COOKIE_SECURE: 'true', PUBLIC_BASE_URL: 'https://pilot.example.test', DATABASE_PATH: join(directory, 'base.sqlite'), ACCOUNTS_PATH: join(directory, 'accounts'), CEVRALI_AUTH_ENCRYPTION_KEY_FILE: join(directory, 'auth.key'), CEVRALI_BACKUP_KEY_FILE: join(directory, 'backup.key') });
  const platform = createPlatformApp(db, join(directory, 'accounts'), { runtime, authKey });
  const created = platform.store.signup({ owner_name: 'Synthetic Pilot Owner', email: 'pilot@example.test', password, clinical_access: true, practice: { name: 'Synthetic Pilot' } });
  const tenant = platform.store.db(created.practice.id);
  const server = platform.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (path: string, method = 'GET', body?: unknown, cookie = '') => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] || '', headers: response.headers };
  };
  const login = () => call('/auth/login', 'POST', { email: created.user.email, password });
  const enroll = async () => {
    const pending = await login();
    assert.equal(pending.data.kind, 'mfa');
    assert.equal(pending.cookie, '');
    const challenge = { email: pending.data.email, challenge_token: pending.data.challenge_token };
    const setup = await call('/auth/mfa/setup', 'POST', challenge);
    assert.equal(setup.status, 200);
    const complete = await call('/auth/mfa/enroll', 'POST', { ...challenge, code: totp(setup.data.secret) });
    assert.equal(complete.data.ok, true, JSON.stringify(complete.data));
    return { complete, challenge, setup };
  };
  return { platform, tenant, created, call, login, enroll, close: async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    platform.store.close(); db.close(); rmSync(directory, { recursive: true, force: true });
  } };
}

test('pilot password verification creates only an expiring challenge; MFA creates the secure usable session', async () => {
  const f = await fixture();
  try {
    const pending = await f.login();
    assert.equal(pending.status, 200);
    assert.equal(pending.cookie, '');
    assert.equal(pending.data.enrollment_required, true);
    assert.equal(f.tenant.prepare('SELECT count(*) n FROM sessions').get()!.n, 0);
    assert.equal((await f.call('/patients')).status, 401);
    const { complete, challenge } = await f.enroll();
    assert.match(complete.headers.get('set-cookie')!, /Secure/);
    assert.match(complete.headers.get('set-cookie')!, /HttpOnly/);
    assert.equal(complete.data.user.practice.id, f.created.practice.id);
    assert.equal(complete.data.recovery_codes.length, 10);
    assert.equal((await f.call('/patients', 'GET', undefined, complete.cookie)).status, 200);
    assert.equal((await f.call('/auth/mfa/enroll', 'POST', { ...challenge, code: '123456' })).status, 401);
    assert.equal((await f.call('/account/mfa/disable', 'POST', { password, code: '123456' }, complete.cookie)).status, 403);
  } finally { await f.close(); }
});

test('the protected API rejects an indexed session that has not completed MFA', async () => {
  const f = await fixture();
  try {
    const token = randomBytes(32).toString('hex'), hash = tokenHash(token), expiry = Date.now() + 60000;
    f.tenant.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash, f.created.user.id, expiry);
    f.platform.store.indexSession(hash, f.created.practice.id, f.created.user.id, expiry);
    const response = await f.call('/patients', 'GET', undefined, `cevrali_session=${token}`);
    assert.equal(response.status, 401);
    assert.match(response.data.error, /multi-factor/);
    // An old marker cannot replace required enrollment after a mode change.
    f.tenant.prepare('INSERT INTO mfa_sessions VALUES(?,?)').run(hash, new Date().toISOString());
    assert.equal((await f.call('/patients', 'GET', undefined, `cevrali_session=${token}`)).status, 401);
  } finally { await f.close(); }
});

test('recovery login consumes one code and revokes previous sessions and pending challenges', async () => {
  const f = await fixture();
  try {
    const { complete } = await f.enroll();
    const pending = await f.login();
    assert.equal(pending.data.enrollment_required, false);
    const challenge = { email: pending.data.email, challenge_token: pending.data.challenge_token };
    const recovered = await f.call('/auth/mfa/complete', 'POST', { ...challenge, code: complete.data.recovery_codes[0] });
    assert.equal(recovered.data.ok, true);
    assert.equal((await f.call('/patients', 'GET', undefined, complete.cookie)).status, 401);
    assert.equal((await f.call('/patients', 'GET', undefined, recovered.cookie)).status, 200);
    const status = await f.call('/account/mfa', 'GET', undefined, recovered.cookie);
    assert.equal(status.data.recovery_codes_remaining, 9);
    const next = await f.login();
    const reused = await f.call('/auth/mfa/complete', 'POST', { email: next.data.email, challenge_token: next.data.challenge_token, code: complete.data.recovery_codes[0] });
    assert.equal(reused.data.ok, false);
    assert.equal(reused.cookie, '');
  } finally { await f.close(); }
});

test('password rotation preserves verified MFA for its new session and invalidates pending sign-ins', async () => {
  const f = await fixture();
  try {
    const { complete } = await f.enroll();
    const pending = await f.login();
    const changed = await f.call('/account/password', 'POST', { current_password: password, password: 'ReplacementSynthetic2026!' }, complete.cookie);
    assert.equal(changed.status, 200);
    assert.equal((await f.call('/patients', 'GET', undefined, changed.cookie)).status, 200);
    assert.equal((await f.call('/patients', 'GET', undefined, complete.cookie)).status, 401);
    assert.equal((await f.call('/auth/mfa/complete', 'POST', { email: pending.data.email, challenge_token: pending.data.challenge_token, code: complete.data.recovery_codes[0] })).status, 401);
  } finally { await f.close(); }
});
