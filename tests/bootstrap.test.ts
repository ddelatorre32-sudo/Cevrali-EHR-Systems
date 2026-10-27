import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bootstrapPilotPractice } from '../server/bootstrap.js';
import { acquireServiceLock } from '../server/backup.js';
import { createDatabase } from '../server/database.js';
import { loadRuntimeConfig } from '../server/runtime-config.js';
import { verifyAuditIntegrity } from '../server/audit-integrity.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cevrali-bootstrap-'));
  const auth = join(directory, 'auth.key'), backup = join(directory, 'backup.key');
  const profileFile = join(directory, 'practice.json'), passwordFile = join(directory, 'password');
  writeFileSync(auth, randomBytes(32).toString('base64'), { mode: 0o600 });
  writeFileSync(backup, randomBytes(32).toString('base64'), { mode: 0o600 });
  writeFileSync(profileFile, JSON.stringify({ owner_name: 'Pilot Owner', email: 'pilot@example.test', practice: { name: 'Synthetic Pilot Practice' } }), { mode: 0o600 });
  writeFileSync(passwordFile, 'SyntheticPilot2026!\n', { mode: 0o600 });
  const config = loadRuntimeConfig({ CEVRALI_MODE: 'pilot', COOKIE_SECURE: 'true', PUBLIC_BASE_URL: 'https://pilot.example.test', CEVRALI_AUTH_ENCRYPTION_KEY_FILE: auth, CEVRALI_BACKUP_KEY_FILE: backup, DATABASE_PATH: join(directory, 'pilot', 'cevrali.sqlite'), ACCOUNTS_PATH: join(directory, 'pilot', 'accounts') });
  return { directory, config, profileFile, passwordFile, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('offline bootstrap creates a private practice without demo users, patients, or sign-in sessions', () => {
  const f = fixture();
  try {
    const result = bootstrapPilotPractice(f.config, f);
    assert.equal(result.scope, 'synthetic-staff-pilot');
    assert.equal(result.mfa_enrollment_required, true);
    for (const path of [f.config.databasePath, f.config.accountsPath, join(f.config.accountsPath, 'accounts.sqlite'), join(f.config.accountsPath, `${result.practice_id}.sqlite`)])
      assert.equal(lstatSync(path).mode & 0o077, 0, 'New pilot storage must be private to its owner');
    const db = new DatabaseSync(join(f.config.accountsPath, `${result.practice_id}.sqlite`), { readOnly: true });
    const registry = new DatabaseSync(join(f.config.accountsPath, 'accounts.sqlite'), { readOnly: true });
    try {
      const user = db.prepare('SELECT * FROM users').get()!;
      assert.equal(user.id, result.user_id);
      assert.equal(user.email, 'pilot@example.test');
      assert.equal(user.is_admin, 1);
      assert.equal(user.role, 'receptionist');
      assert.notEqual(user.password, 'SyntheticPilot2026!');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM patients').get()!.count, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()!.count, 0);
      assert.equal(registry.prepare('SELECT COUNT(*) AS count FROM session_index').get()!.count, 0);
      assert.equal(registry.prepare("SELECT COUNT(*) AS count FROM practices WHERE id='demo-practice'").get()!.count, 0);
      const key = Buffer.from(readFileSync(f.config.authEncryptionKeyFile!, 'utf8').trim(), 'base64');
      const integrity = verifyAuditIntegrity(db, key);
      assert.equal(integrity.ok, true);
      assert.equal(integrity.records, 1);
      assert.equal(db.prepare('SELECT action FROM audit').get()!.action, 'Created practice account');
      key.fill(0);
    } finally { db.close(); registry.close(); }
    assert.throws(() => bootstrapPilotPractice(f.config, f), /already exists/);
    assert.equal(existsSync(`${f.config.databasePath}.service.lock`), false);
  } finally { f.close(); }
});

test('bootstrap rejects demo mode, active service locks, existing demo data, and invalid readiness', () => {
  const f = fixture();
  try {
    assert.throws(() => bootstrapPilotPractice(loadRuntimeConfig({}), f), /requires CEVRALI_MODE=pilot/);
    const release = acquireServiceLock(f.config.databasePath, f.config.accountsPath);
    try { assert.throws(() => bootstrapPilotPractice(f.config, f), /service lock/); }
    finally { release(); }
    const db = createDatabase(f.config.databasePath); db.close();
    assert.throws(() => bootstrapPilotPractice(f.config, f), /without demo/);
    assert.throws(() => bootstrapPilotPractice({ ...f.config, authEncryptionKeyFile: null }, f), /startup blocked/);
  } finally { f.close(); }
});

test('bootstrap restores the process umask after success and failure, including separate account storage', () => {
  const f = fixture();
  const before = process.umask(0o022);
  try {
    const config = { ...f.config, accountsPath: join(f.directory, 'separate-accounts') };
    const result = bootstrapPilotPractice(config, f);
    assert.equal(process.umask(), 0o022);
    for (const path of [config.accountsPath, join(config.accountsPath, 'accounts.sqlite'), join(config.accountsPath, `${result.practice_id}.sqlite`)])
      assert.equal(lstatSync(path).mode & 0o077, 0);
    assert.throws(() => bootstrapPilotPractice(config, f), /already exists/);
    assert.equal(process.umask(), 0o022);
    const release = acquireServiceLock(config.databasePath, config.accountsPath);
    try { assert.throws(() => bootstrapPilotPractice(config, f), /service lock/); }
    finally { release(); }
    assert.equal(process.umask(), 0o022);
  } finally { process.umask(before); f.close(); }
});

test('bootstrap rejects public, linked, malformed, or password-containing input before making a database', () => {
  const f = fixture();
  try {
    chmodSync(f.passwordFile, 0o644);
    assert.throws(() => bootstrapPilotPractice(f.config, f), /private regular files/);
    chmodSync(f.passwordFile, 0o600);
    symlinkSync(f.passwordFile, join(f.directory, 'password-link'));
    assert.throws(() => bootstrapPilotPractice(f.config, { ...f, passwordFile: join(f.directory, 'password-link') }), /private regular files/);
    writeFileSync(f.profileFile, '{invalid-json');
    assert.throws(() => bootstrapPilotPractice(f.config, f), /valid JSON/);
    writeFileSync(f.profileFile, JSON.stringify({ owner_name: 'Owner', email: 'owner@example.test', password: 'DoNotPermitHere!', practice: { name: 'Pilot' } }));
    assert.throws(() => bootstrapPilotPractice(f.config, f), /must not contain a password/);
    assert.equal(existsSync(f.config.databasePath), false);
  } finally { f.close(); }
});

test('key initialization creates separate private keys without printing key material or replacing a directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cevrali-init-keys-'));
  const keys = join(directory, 'keys');
  try {
    const script = resolve('scripts/init-pilot.mjs');
    const stdout = execFileSync(process.execPath, [script, '--directory', keys], { encoding: 'utf8' });
    const auth = readFileSync(join(keys, 'authentication.key'), 'utf8').trim();
    const backup = readFileSync(join(keys, 'backup.key'), 'utf8').trim();
    assert.equal(Buffer.from(auth, 'base64').length, 32);
    assert.notEqual(auth, backup);
    assert.equal(lstatSync(keys).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(keys, 'authentication.key')).mode & 0o777, 0o600);
    assert.equal(lstatSync(join(keys, 'backup.key')).mode & 0o777, 0o600);
    assert.equal(stdout.includes(auth), false);
    assert.equal(stdout.includes(backup), false);
    const duplicate = spawnSync(process.execPath, [script, '--directory', keys], { encoding: 'utf8' });
    assert.equal(duplicate.status, 1);
    assert.equal(readFileSync(join(keys, 'authentication.key'), 'utf8').trim(), auth);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
