import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createDatabase } from '../server/database.js';
import { createPlatformApp } from '../server/platform.js';
import { assertProtectedDataPaths } from '../server/startup.js';
import { loadRuntimeConfig } from '../server/runtime-config.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cevrali-protected-platform-'));
  const auth = join(directory, 'auth.key'), backup = join(directory, 'backup.key');
  const key = randomBytes(32);
  writeFileSync(auth, key.toString('base64'), { mode: 0o600 });
  writeFileSync(backup, randomBytes(32).toString('base64'), { mode: 0o600 });
  const databasePath = join(directory, 'cevrali.sqlite'), accountsPath = join(directory, 'accounts');
  const runtime = loadRuntimeConfig({ CEVRALI_MODE: 'pilot', COOKIE_SECURE: 'true', PUBLIC_BASE_URL: 'https://pilot.example.test',
    DATABASE_PATH: databasePath, ACCOUNTS_PATH: accountsPath,
    CEVRALI_AUTH_ENCRYPTION_KEY_FILE: auth, CEVRALI_BACKUP_KEY_FILE: backup });
  return { directory, databasePath, accountsPath, runtime, key, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('pilot startup inspects existing data before migrations and rejects the demo data set without changing it', () => {
  const f = fixture();
  try {
    assert.doesNotThrow(() => assertProtectedDataPaths(f.databasePath, f.accountsPath));
    assert.equal(existsSync(f.databasePath), false);
    const db = createDatabase(f.databasePath);
    db.close();
    const before = readFileSync(f.databasePath);
    assert.throws(() => assertProtectedDataPaths(f.databasePath, f.accountsPath), /separate pilot data directory/);
    assert.deepEqual(readFileSync(f.databasePath), before);
  } finally { f.close(); }
});

test('pilot startup accepts an empty schema and rejects a registry containing a demo practice', () => {
  const f = fixture();
  let db: ReturnType<typeof createDatabase> | undefined;
  let platform: ReturnType<typeof createPlatformApp> | undefined;
  try {
    db = createDatabase(f.databasePath, { seedDemo: false });
    assert.doesNotThrow(() => assertProtectedDataPaths(f.databasePath, f.accountsPath));
    platform = createPlatformApp(db, f.accountsPath, { runtime: f.runtime, authKey: f.key });
    platform.store.registry.prepare('INSERT INTO practices VALUES (?,?)').run('demo-practice', JSON.stringify({ is_demo: true }));
    assert.throws(() => assertProtectedDataPaths(f.databasePath, f.accountsPath), /separate pilot data directory/);
  } finally { platform?.store.close(); db?.close(); f.close(); }
});

test('a missing registered pilot database is rejected instead of silently creating an empty replacement', () => {
  const f = fixture(), db = createDatabase(f.databasePath, { seedDemo: false });
  let platform = createPlatformApp(db, f.accountsPath, { runtime: f.runtime, authKey: f.key });
  try {
    const created = platform.store.signup({ owner_name: 'Synthetic owner', email: 'missing@example.test', password: 'SyntheticAccount2026!', practice: { name: 'Synthetic missing database' } });
    const path = join(f.accountsPath, `${created.practice.id}.sqlite`);
    platform.store.close();
    rmSync(path);
    platform = createPlatformApp(db, f.accountsPath, { runtime: f.runtime, authKey: f.key });
    assert.throws(() => platform.store.db(created.practice.id), /registered practice database is missing/);
    assert.equal(existsSync(path), false);
  } finally { platform.store.close(); db.close(); f.key.fill(0); f.close(); }
});

test('pilot exposes safe runtime and health metadata while blocking signup, demo login, and unauthenticated tenant fallback', async () => {
  const f = fixture(), db = createDatabase(f.databasePath, { seedDemo: false });
  const platform = createPlatformApp(db, f.accountsPath, { runtime: f.runtime, authKey: f.key });
  const server = platform.app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(origin + '/api' + path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
  };
  try {
    const metadata = await call('/runtime');
    assert.equal(metadata.status, 200);
    assert.deepEqual(metadata.body, { mode: 'pilot', demo_enabled: false, public_signup_enabled: false, mfa_required: true, clinical_use_allowed: false });
    assert.equal(JSON.stringify(metadata.body).includes(f.directory), false);
    assert.equal((await call('/health')).body.status, 'ok');
    assert.equal((await call('/accounts/signup', {})).status, 403);
    const demoLogin = await call('/auth/login', { email: 'alex@cevrali.demo', password: 'CevraliDemo2026!' });
    assert.equal(demoLogin.status, 401);
    assert.equal(demoLogin.body.error, 'Email or password is incorrect');
    const unknownMfa = await call('/auth/mfa/setup', { email: 'alex@cevrali.demo', challenge_token: 'a'.repeat(64) });
    assert.equal(unknownMfa.status, 401);
    assert.equal(unknownMfa.body.error, 'This authentication challenge is unavailable. Sign in again.');
    assert.equal((await call('/patients')).status, 401);
    assert.equal((await call(`/intake-links/${'a'.repeat(64)}`)).status, 404);
    assert.equal((platform.store.registry.prepare('SELECT count(*) n FROM practices').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT count(*) n FROM users').get() as { n: number }).n, 0);
    const created = platform.store.signup({ owner_name: 'Synthetic pilot owner', email: 'pilot-owner@example.test', password: 'SyntheticAccount2026!',
      practice: { name: 'Synthetic pilot', phone: '555-0100', address: 'Synthetic address' } });
    const result = await call('/auth/login', { email: created.user.email, password: 'SyntheticAccount2026!' });
    assert.equal(result.status, 200);
    assert.equal(result.cookie, null);
    assert.equal(result.body.kind, 'mfa');
    assert.equal(result.body.enrollment_required, true);
    assert.equal((platform.store.db(created.practice.id).prepare('SELECT count(*) n FROM sessions').get() as { n: number }).n, 0);
    assert.equal((await call('/auth/mfa/setup', { email: created.user.email, challenge_token: result.body.challenge_token })).status, 200);
    for (let attempt = 0; attempt < 10; attempt++)
      assert.equal((await call('/auth/login', { email: 'unknown@example.test', password: 'incorrect' })).status, 401);
    assert.equal((await call('/auth/login', { email: 'unknown@example.test', password: 'incorrect' })).status, 429);
    // One mistyped account does not use the larger shared-address budget.
    assert.equal((await call('/auth/login', { email: created.user.email, password: 'SyntheticAccount2026!' })).status, 200);
    for (let attempt = 0; attempt < 89; attempt++)
      assert.equal((await call('/auth/login', { email: `cycled-${attempt}@example.test`, password: 'incorrect' })).status, 401);
    assert.equal((await call('/auth/login', { email: created.user.email, password: 'SyntheticAccount2026!' })).status, 429);
  } finally {
    await new Promise<void>((r, j) => server.close(error => error ? j(error) : r()));
    platform.store.close(); db.close(); f.key.fill(0); f.close();
  }
});

test('the server entrypoint blocks invalid and production startup before data files or service locks are created', () => {
  const f = fixture();
  try {
    const env = { ...process.env, CEVRALI_MODE: 'production', COOKIE_SECURE: 'true', PUBLIC_BASE_URL: 'https://pilot.example.test',
      DATABASE_PATH: f.databasePath, ACCOUNTS_PATH: f.accountsPath,
      CEVRALI_AUTH_ENCRYPTION_KEY_FILE: join(f.directory, 'auth.key'), CEVRALI_BACKUP_KEY_FILE: join(f.directory, 'backup.key') };
    for (const settings of [env, { ...env, CEVRALI_MODE: 'pilot', COOKIE_SECURE: 'false' }]) {
      const child = spawnSync(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: settings, encoding: 'utf8', timeout: 15000 });
      assert.notEqual(child.status, 0);
      assert.match(child.stderr, /startup blocked|COOKIE_SECURE/);
      assert.equal(existsSync(f.databasePath), false);
      assert.equal(existsSync(f.accountsPath), false);
      assert.equal(existsSync(`${f.databasePath}.service.lock`), false);
      assert.equal(existsSync(`${f.accountsPath}.service.lock`), false);
    }
  } finally { f.close(); }
});

test('the server entrypoint refuses a demo data directory and releases its service locks', () => {
  const f = fixture();
  try {
    const db = createDatabase(f.databasePath); db.close();
    const before = readFileSync(f.databasePath);
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      env: { ...process.env, CEVRALI_MODE: 'pilot', COOKIE_SECURE: 'true', PUBLIC_BASE_URL: 'https://pilot.example.test',
        DATABASE_PATH: f.databasePath, ACCOUNTS_PATH: f.accountsPath,
        CEVRALI_AUTH_ENCRYPTION_KEY_FILE: join(f.directory, 'auth.key'), CEVRALI_BACKUP_KEY_FILE: join(f.directory, 'backup.key') },
      encoding: 'utf8', timeout: 15000,
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /separate pilot data directory/);
    assert.deepEqual(readFileSync(f.databasePath), before);
    assert.equal(existsSync(`${f.databasePath}.service.lock`), false);
    assert.equal(existsSync(`${f.accountsPath}.service.lock`), false);
  } finally { f.close(); }
});

test('a valid synthetic pilot starts without demo data and releases service locks after graceful shutdown', async () => {
  const f = fixture();
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, CEVRALI_MODE: 'pilot', COOKIE_SECURE: 'true', PUBLIC_BASE_URL: 'https://pilot.example.test', PORT: '0',
      DATABASE_PATH: f.databasePath, ACCOUNTS_PATH: f.accountsPath,
      CEVRALI_AUTH_ENCRYPTION_KEY_FILE: join(f.directory, 'auth.key'), CEVRALI_BACKUP_KEY_FILE: join(f.directory, 'backup.key') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '', started = false;
  const close = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  child.stderr.on('data', chunk => { errors += String(chunk); });
  child.stdout.on('data', chunk => {
    output += String(chunk);
    if (!started && output.includes('synthetic-staff-pilot')) {
      started = true;
      assert.equal(existsSync(`${f.databasePath}.service.lock`), true);
      assert.equal(existsSync(`${f.accountsPath}.service.lock`), true);
      child.kill('SIGTERM');
    }
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    assert.equal(await close, 0, errors);
    assert.equal(started, true, errors);
    assert.equal(existsSync(`${f.databasePath}.service.lock`), false);
    assert.equal(existsSync(`${f.accountsPath}.service.lock`), false);
    assert.equal(statSync(f.databasePath).mode & 0o077, 0);
    assert.equal(statSync(f.accountsPath).mode & 0o077, 0);
    assert.equal(statSync(join(f.accountsPath, 'accounts.sqlite')).mode & 0o077, 0);
    const db = createDatabase(f.databasePath, { seedDemo: false });
    try { assert.equal((db.prepare('SELECT count(*) n FROM users').get() as { n: number }).n, 0); }
    finally { db.close(); }
  } finally { clearTimeout(timeout); child.kill('SIGKILL'); f.close(); }
});
