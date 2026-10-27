import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { AccountStore } from './accounts.js';
import { signupInput } from './account-model.js';
import { acquireServiceLock } from './backup.js';
import { createDatabase } from './database.js';
import { initializeAuditIntegrity } from './audit-integrity.js';
import { validateStartup } from './readiness.js';
import { readRuntimeKeyFile, type RuntimeConfig } from './runtime-config.js';
import { assertProtectedDataPaths } from './startup.js';

/** Operator input is read from private regular files, never command arguments.
 * This helper does not establish email ownership or grant a signed-in session. */
function privateText(path: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    const absolute = resolve(path), root = parse(absolute).root;
    let current = root;
    for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error();
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > maxBytes ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()))
      throw new Error();
    return readFileSync(fd, 'utf8');
  } catch {
    throw new Error('Provisioning inputs must be bounded, private regular files owned by the operator (chmod 600), without symbolic or hard links.');
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function bootstrapPilotPractice(config: RuntimeConfig, input: { profileFile: string; passwordFile: string }) {
  if (config.mode !== 'pilot') throw new Error('Offline practice provisioning requires CEVRALI_MODE=pilot.');
  validateStartup(config);
  let profile: unknown;
  try { profile = JSON.parse(privateText(input.profileFile, 16384)); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('The private practice profile must contain valid JSON.');
    throw error;
  }
  const parsedProfile = signupInput.omit({ password: true }).strict().safeParse(profile);
  if (!parsedProfile.success) throw new Error('The practice profile must contain owner_name, email, practice details, and optional clinical_access; it must not contain a password.');
  const password = privateText(input.passwordFile, 512).replace(/\r?\n$/, '');
  const parsed = signupInput.safeParse({ ...parsedProfile.data, password });
  if (!parsed.success) throw new Error('Use an account password of 12–200 characters in the private password file.');

  const authKey = readRuntimeKeyFile(config.authEncryptionKeyFile, 'authentication');
  const previousUmask = process.umask(0o077);
  let release: (() => void) | undefined;
  let db: ReturnType<typeof createDatabase> | undefined;
  let store: AccountStore | undefined;
  try {
    release = acquireServiceLock(config.databasePath, config.accountsPath);
    assertProtectedDataPaths(config.databasePath, config.accountsPath);
    mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
    db = createDatabase(config.databasePath, { seedDemo: false });
    initializeAuditIntegrity(db, authKey);
    store = new AccountStore(config.accountsPath, db, { demoEnabled: false, initializeDatabase: tenant => { initializeAuditIntegrity(tenant, authKey); } });
    if (store.membership(parsed.data.email)) throw new Error('An account already exists for this email. No account was changed.');
    const result = store.signup(parsed.data);
    return { practice_id: result.practice.id, user_id: result.user.id as string, mfa_enrollment_required: true as const, scope: 'synthetic-staff-pilot' as const };
  } finally {
    try { store?.close(); }
    finally {
      try { db?.close(); }
      finally { try { release?.(); } finally { authKey.fill(0); process.umask(previousUmask); } }
    }
  }
}
