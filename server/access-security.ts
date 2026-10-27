import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  AccessSecurityStatus, AuthenticationComplete, AuthenticationStart, AuthenticatorSetup,
  EnrollmentSetup, SecurityFailure, SecurityUser,
} from "./access-security-model.js";

type Row = Record<string, any>;
type Key = Uint8Array | undefined;
type Challenge = {
  token_hash: string; user_id: string; purpose: "login" | "enroll" | "account-enroll";
  credential_version: string; secret_ciphertext: string | null;
  created_at: number; expires_at: number;
};
const challengeInput = z.object({
  email: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
  challenge_token: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const completionInput = challengeInput.extend({ code: z.string().trim().min(1).max(128) }).strict();
const reauthenticationInput = z.object({ password: z.string().min(1).max(200), code: z.string().trim().min(1).max(128) }).strict();
const stepMilliseconds = 30_000;
const challengeMilliseconds = 5 * 60_000;
const failureMilliseconds = 15 * 60_000;
const userColumns = "id,name,email,role,is_admin,is_active";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }
function validKey(key: Key): Uint8Array {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32)
    fail(503, "Authenticator security is unavailable. Contact the practice administrator.");
  return key;
}
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail(400, "Enter the required authentication information in the correct format.");
  return parsed.data;
}
function atomic<T>(db: DatabaseSync, operation: () => T): T {
  const name = `access_${randomBytes(8).toString("hex")}`;
  db.exec(`SAVEPOINT ${name}`);
  try { const result = operation(); db.exec(`RELEASE ${name}`); return result; }
  catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; }
}

export function initializeAccessSecurity(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_mfa (
      user_id TEXT PRIMARY KEY REFERENCES users(id), secret_ciphertext TEXT NOT NULL,
      enabled_at INTEGER NOT NULL, last_step INTEGER NOT NULL DEFAULT -1
    );
    CREATE TABLE IF NOT EXISTS access_challenges (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      purpose TEXT NOT NULL CHECK(purpose IN ('login','enroll','account-enroll')),
      credential_version TEXT NOT NULL, secret_ciphertext TEXT,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS access_challenges_user ON access_challenges(user_id, created_at);
    CREATE TABLE IF NOT EXISTS access_recovery_codes (
      code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL, used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS access_recovery_user ON access_recovery_codes(user_id, used_at);
    CREATE TABLE IF NOT EXISTS access_auth_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id), at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS access_failures_user ON access_auth_failures(user_id, at);
    CREATE TABLE IF NOT EXISTS access_auth_locks (
      user_id TEXT PRIMARY KEY REFERENCES users(id), locked_until INTEGER NOT NULL
    );
  `);
}
function ready(db: DatabaseSync) { initializeAccessSecurity(db); }
function currentUser(db: DatabaseSync, id: string): SecurityUser {
  const row = db.prepare(`SELECT ${userColumns} FROM users WHERE id=? AND is_active=1`).get(id) as SecurityUser | undefined;
  return row || fail(401, "This staff account is unavailable. Sign in again.");
}
function passwordRow(db: DatabaseSync, id: string) {
  const row = db.prepare("SELECT password FROM users WHERE id=? AND is_active=1").get(id) as Row | undefined;
  return String(row?.password || "");
}
function passwordMatches(password: string, stored: string) {
  const [salt, expected] = stored.split(":");
  const actual = scryptSync(password, salt || "unrecognized", 64);
  return Boolean(expected && /^[a-f0-9]{128}$/.test(expected) && timingSafeEqual(actual, Buffer.from(expected, "hex")));
}
function audit(db: DatabaseSync, userId: string, action: string) {
  db.prepare("INSERT INTO audit(user_id,action,resource) VALUES(?,?,?)").run(userId, action, "account-security");
}
function locked(db: DatabaseSync, userId: string, now: number) {
  return Boolean(db.prepare("SELECT 1 FROM access_auth_locks WHERE user_id=? AND locked_until>?").get(userId, now));
}
function failures(db: DatabaseSync, userId: string, now: number) {
  return Number((db.prepare("SELECT count(*) count FROM access_auth_failures WHERE user_id=? AND at>?").get(userId, now - failureMilliseconds) as Row).count);
}
function authenticationFailure(db: DatabaseSync, userId: string, now: number): SecurityFailure {
  db.prepare("DELETE FROM access_auth_failures WHERE at<=?").run(now - failureMilliseconds);
  db.prepare("INSERT INTO access_auth_failures(user_id,at) VALUES(?,?)").run(userId, now);
  const attempts_remaining = Math.max(0, 5 - failures(db, userId, now));
  if (!attempts_remaining) db.prepare("INSERT OR REPLACE INTO access_auth_locks VALUES(?,?)").run(userId, now + failureMilliseconds);
  audit(db, userId, "Failed staff multi-factor authentication");
  return { ok: false, error: attempts_remaining ? "The authentication code is incorrect or has already been used." :
    "Authentication is locked for 15 minutes after repeated unsuccessful attempts.", attempts_remaining };
}
function lockFailure(): SecurityFailure {
  return { ok: false, error: "Authentication is locked for 15 minutes after repeated unsuccessful attempts.", attempts_remaining: 0 };
}
function clearFailures(db: DatabaseSync, userId: string) {
  db.prepare("DELETE FROM access_auth_failures WHERE user_id=?").run(userId);
  db.prepare("DELETE FROM access_auth_locks WHERE user_id=?").run(userId);
}
export function revokeAccessSecurityChallenges(db: DatabaseSync, userId: string) {
  ready(db);
  db.prepare("DELETE FROM access_challenges WHERE user_id=?").run(userId);
}
function revokeSessions(db: DatabaseSync, userId: string) {
  db.prepare("DELETE FROM sessions WHERE user_id=?").run(userId);
  db.prepare("DELETE FROM access_challenges WHERE user_id=?").run(userId);
}

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(bytes: Uint8Array) {
  let value = 0, bits = 0, output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += base32Alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) output += base32Alphabet[(value << (5 - bits)) & 31];
  return output;
}
function base32Bytes(value: string) {
  let buffer = 0, bits = 0; const bytes: number[] = [];
  for (const char of value) {
    const digit = base32Alphabet.indexOf(char);
    if (digit < 0) fail(503, "Authenticator security is unavailable. Contact the practice administrator.");
    buffer = (buffer << 5) | digit; bits += 5;
    if (bits >= 8) { bytes.push((buffer >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}
function totp(secret: string, step: number) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32Bytes(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
function matchingStep(secret: string, input: string, now: number, lastStep: number): number | null {
  const code = input.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / stepMilliseconds);
  for (const candidate of [step, step - 1, step + 1]) {
    if (candidate < 0 || candidate <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(totp(secret, candidate)), Buffer.from(code))) return candidate;
  }
  return null;
}
function encryptSecret(secret: string, userId: string, key: Uint8Array) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`cevrali-authenticator:v1:${userId}`));
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
function decryptSecret(value: string, userId: string, key: Uint8Array) {
  try {
    const parts = value.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Invalid encrypted secret");
    const iv = Buffer.from(parts[1], "base64url"), tag = Buffer.from(parts[2], "base64url");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted secret");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(`cevrali-authenticator:v1:${userId}`)); decipher.setAuthTag(tag);
    const secret = Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
    if (!/^[A-Z2-7]{32}$/.test(secret)) throw new Error("Invalid authenticator secret");
    return secret;
  } catch { fail(503, "Authenticator security is unavailable. Contact the practice administrator."); }
}
function setup(secret: string, email: string, practiceName: string, expires: number): AuthenticatorSetup {
  const issuer = practiceName.trim().slice(0, 160) || "Cevrali";
  const query = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return { secret, otpauth_uri: `otpauth://totp/${encodeURIComponent(`${issuer}:${email}`)}?${query}`, expires_at: new Date(expires).toISOString() };
}
function issue(db: DatabaseSync, user: SecurityUser, purpose: Challenge["purpose"], now: number) {
  db.prepare("DELETE FROM access_challenges WHERE expires_at<?").run(now - failureMilliseconds);
  const recent = Number((db.prepare("SELECT count(*) count FROM access_challenges WHERE user_id=? AND created_at>?").get(user.id, now - challengeMilliseconds) as Row).count);
  if (recent >= 10) fail(429, "Too many authentication attempts. Wait five minutes before signing in again.");
  // Existing challenges become unusable, but remain briefly for issuance throttling.
  db.prepare("UPDATE access_challenges SET expires_at=min(expires_at,?) WHERE user_id=?").run(now, user.id);
  const token = randomBytes(32).toString("hex"), expires_at = now + challengeMilliseconds;
  db.prepare("INSERT INTO access_challenges VALUES(?,?,?,?,?,?,?)").run(hash(token), user.id, purpose,
    hash(passwordRow(db, user.id)), null, now, expires_at);
  return { token, expires_at };
}
function challenge(db: DatabaseSync, token: string, email: string | null, now: number, purpose?: Challenge["purpose"]) {
  const found = db.prepare("SELECT * FROM access_challenges WHERE token_hash=?").get(hash(token)) as Challenge | undefined;
  if (!found || found.expires_at <= now || (purpose && found.purpose !== purpose))
    fail(401, "This authentication challenge is unavailable. Sign in again.");
  const user = currentUser(db, found.user_id);
  if ((email && user.email.toLowerCase() !== email) || found.credential_version !== hash(passwordRow(db, user.id)))
    fail(401, "This authentication challenge is unavailable. Sign in again.");
  return { challenge: found, user };
}
function recoveryHash(userId: string, code: string, key: Uint8Array) {
  return createHmac("sha256", key).update(`cevrali-recovery:v1:${userId}:${code}`).digest("hex");
}
function recoveryCodes(db: DatabaseSync, userId: string, key: Uint8Array, now: number) {
  db.prepare("DELETE FROM access_recovery_codes WHERE user_id=?").run(userId);
  const codes = Array.from({ length: 10 }, () => randomBytes(16).toString("hex").toUpperCase().match(/.{8}/g)!.join("-"));
  const insert = db.prepare("INSERT INTO access_recovery_codes VALUES(?,?,?,NULL)");
  for (const code of codes) insert.run(recoveryHash(userId, code.replaceAll("-", ""), key), userId, now);
  return codes;
}
function finishEnrollment(db: DatabaseSync, found: Challenge, user: SecurityUser, code: string, key: Uint8Array, now: number): AuthenticationComplete {
  if (db.prepare("SELECT 1 FROM access_mfa WHERE user_id=?").get(user.id))
    fail(409, "An authenticator was already enrolled. Sign in again to use it.");
  if (!found.secret_ciphertext) fail(400, "Set up your authenticator before confirming its code.");
  const secret = decryptSecret(found.secret_ciphertext, user.id, key);
  const accepted = matchingStep(secret, code, now, -1);
  if (accepted === null) return authenticationFailure(db, user.id, now);
  db.prepare("INSERT INTO access_mfa VALUES(?,?,?,?)").run(user.id, found.secret_ciphertext, now, accepted);
  const codes = recoveryCodes(db, user.id, key, now);
  revokeSessions(db, user.id); clearFailures(db, user.id);
  audit(db, user.id, "Enrolled staff authenticator and issued one-time recovery codes");
  return { ok: true, user, recovery_codes: codes, sessions_revoked: true };
}

export function beginAuthentication(db: DatabaseSync, user: { id: string }, options: {
  requireMfa: boolean; key?: Uint8Array; practiceName?: string; now?: number;
}): AuthenticationStart {
  ready(db);
  return atomic(db, () => {
    const member = currentUser(db, user.id), now = options.now ?? Date.now();
    const enabled = Boolean(db.prepare("SELECT 1 FROM access_mfa WHERE user_id=?").get(member.id));
    if (!enabled && !options.requireMfa) return { kind: "authenticated", user: member };
    validKey(options.key);
    if (locked(db, member.id, now)) fail(429, "Authentication is locked for 15 minutes after repeated unsuccessful attempts.");
    const pending = issue(db, member, enabled ? "login" : "enroll", now);
    return { kind: "mfa", email: member.email, challenge_token: pending.token,
      expires_at: new Date(pending.expires_at).toISOString(), enrollment_required: !enabled };
  });
}

export function authenticationSetup(db: DatabaseSync, value: unknown, keyValue: Key, practiceName = "Cevrali", now = Date.now()): AuthenticatorSetup {
  ready(db); const input = parse(challengeInput, value), key = validKey(keyValue);
  return atomic(db, () => {
    const found = challenge(db, input.challenge_token, input.email, now, "enroll");
    if (locked(db, found.user.id, now)) fail(429, "Authentication is locked for 15 minutes after repeated unsuccessful attempts.");
    if (db.prepare("SELECT 1 FROM access_mfa WHERE user_id=?").get(found.user.id)) fail(409, "An authenticator is already enrolled. Sign in again.");
    let encrypted = found.challenge.secret_ciphertext;
    if (!encrypted) {
      encrypted = encryptSecret(base32(randomBytes(20)), found.user.id, key);
      db.prepare("UPDATE access_challenges SET secret_ciphertext=? WHERE token_hash=?").run(encrypted, found.challenge.token_hash);
    }
    return setup(decryptSecret(encrypted, found.user.id, key), found.user.email, practiceName, found.challenge.expires_at);
  });
}

export function completeAuthentication(db: DatabaseSync, value: unknown, keyValue: Key, now = Date.now()): AuthenticationComplete {
  ready(db); const input = parse(completionInput, value), key = validKey(keyValue);
  return atomic(db, () => {
    const found = challenge(db, input.challenge_token, input.email, now);
    if (found.challenge.purpose === "account-enroll") fail(401, "Use the authenticated account enrollment action.");
    if (locked(db, found.user.id, now)) return lockFailure();
    if (found.challenge.purpose === "enroll") return finishEnrollment(db, found.challenge, found.user, input.code, key, now);
    const mfa = db.prepare("SELECT * FROM access_mfa WHERE user_id=?").get(found.user.id) as Row | undefined;
    if (!mfa) fail(401, "Authenticator settings changed. Sign in again.");
    const secret = decryptSecret(mfa.secret_ciphertext, found.user.id, key);
    const accepted = matchingStep(secret, input.code, now, Number(mfa.last_step));
    let recoveryUsed = false;
    if (accepted === null) {
      const code = input.code.toUpperCase().replace(/[-\s]/g, "");
      if (/^[A-F0-9]{32}$/.test(code)) {
        const result = db.prepare("UPDATE access_recovery_codes SET used_at=? WHERE code_hash=? AND user_id=? AND used_at IS NULL")
          .run(now, recoveryHash(found.user.id, code, key), found.user.id);
        recoveryUsed = Number(result.changes) === 1;
      }
      if (!recoveryUsed) return authenticationFailure(db, found.user.id, now);
    } else db.prepare("UPDATE access_mfa SET last_step=? WHERE user_id=?").run(accepted, found.user.id);
    db.prepare("DELETE FROM access_challenges WHERE token_hash=?").run(found.challenge.token_hash);
    clearFailures(db, found.user.id);
    if (recoveryUsed) revokeSessions(db, found.user.id);
    audit(db, found.user.id, recoveryUsed ? "Authenticated staff with one-time recovery code; previous sessions revoked" : "Authenticated staff with authenticator code");
    return { ok: true, user: found.user, ...(recoveryUsed ? { sessions_revoked: true as const } : {}) };
  });
}

export function beginEnrollment(db: DatabaseSync, user: { id: string }, password: string, keyValue: Key,
  practiceName = "Cevrali", now = Date.now()): EnrollmentSetup | SecurityFailure {
  ready(db); const key = validKey(keyValue);
  const parsedPassword = parse(z.string().min(1).max(200), password);
  return atomic(db, () => {
    const member = currentUser(db, user.id);
    if (locked(db, member.id, now)) fail(429, "Authentication is locked for 15 minutes after repeated unsuccessful attempts.");
    if (!passwordMatches(parsedPassword, passwordRow(db, member.id))) {
      return authenticationFailure(db, member.id, now);
    }
    if (db.prepare("SELECT 1 FROM access_mfa WHERE user_id=?").get(member.id)) fail(409, "An authenticator is already enrolled.");
    const pending = issue(db, member, "account-enroll", now), secret = base32(randomBytes(20));
    db.prepare("UPDATE access_challenges SET secret_ciphertext=? WHERE token_hash=?").run(encryptSecret(secret, member.id, key), hash(pending.token));
    audit(db, member.id, "Started staff authenticator enrollment after password verification");
    return { enrollment_id: pending.token, ...setup(secret, member.email, practiceName, pending.expires_at) };
  });
}

export function confirmEnrollment(db: DatabaseSync, user: { id: string }, value: unknown, keyValue: Key, now = Date.now()): AuthenticationComplete {
  ready(db); const key = validKey(keyValue);
  const input = parse(z.object({ enrollment_id: z.string().regex(/^[a-f0-9]{64}$/), code: z.string().trim().min(1).max(128) }).strict(), value);
  return atomic(db, () => {
    const member = currentUser(db, user.id), found = challenge(db, input.enrollment_id, member.email.toLowerCase(), now, "account-enroll");
    if (found.user.id !== member.id) fail(401, "This enrollment is unavailable.");
    if (locked(db, member.id, now)) return lockFailure();
    return finishEnrollment(db, found.challenge, member, input.code, key, now);
  });
}

export function accessSecurityStatus(db: DatabaseSync, user: { id: string }, options: { required: boolean; key?: Uint8Array }): AccessSecurityStatus {
  ready(db); currentUser(db, user.id);
  return { available: options.key instanceof Uint8Array && options.key.byteLength === 32, required: options.required,
    mfa_enabled: Boolean(db.prepare("SELECT 1 FROM access_mfa WHERE user_id=?").get(user.id)),
    recovery_codes_remaining: Number((db.prepare("SELECT count(*) count FROM access_recovery_codes WHERE user_id=? AND used_at IS NULL").get(user.id) as Row).count) };
}

function verifySensitiveAction(db: DatabaseSync, user: SecurityUser, input: z.infer<typeof reauthenticationInput>, key: Uint8Array, now: number): SecurityFailure | null {
  if (locked(db, user.id, now)) return lockFailure();
  const mfa = db.prepare("SELECT * FROM access_mfa WHERE user_id=?").get(user.id) as Row | undefined;
  if (!mfa) fail(409, "Enroll an authenticator before changing recovery codes.");
  const accepted = matchingStep(decryptSecret(mfa.secret_ciphertext, user.id, key), input.code, now, Number(mfa.last_step));
  if (!passwordMatches(input.password, passwordRow(db, user.id)) || accepted === null) return authenticationFailure(db, user.id, now);
  db.prepare("UPDATE access_mfa SET last_step=? WHERE user_id=?").run(accepted, user.id); clearFailures(db, user.id);
  return null;
}
export function regenerateRecoveryCodes(db: DatabaseSync, user: { id: string }, value: unknown, keyValue: Key, now = Date.now()):
  { ok: true; recovery_codes: string[]; sessions_revoked: true } | SecurityFailure {
  ready(db); const input = parse(reauthenticationInput, value), key = validKey(keyValue);
  return atomic(db, () => {
    const member = currentUser(db, user.id), error = verifySensitiveAction(db, member, input, key, now);
    if (error) return error;
    const codes = recoveryCodes(db, member.id, key, now); revokeSessions(db, member.id);
    audit(db, member.id, "Replaced one-time recovery codes and revoked previous sessions");
    return { ok: true, recovery_codes: codes, sessions_revoked: true };
  });
}
export function disableMfa(db: DatabaseSync, user: { id: string }, value: unknown, keyValue: Key, options: { required: boolean; now?: number }):
  { ok: true; sessions_revoked: true } | SecurityFailure {
  ready(db); const input = parse(reauthenticationInput, value), key = validKey(keyValue);
  if (options.required) fail(403, "This deployment requires multi-factor authentication and it cannot be disabled.");
  return atomic(db, () => {
    const member = currentUser(db, user.id), error = verifySensitiveAction(db, member, input, key, options.now ?? Date.now());
    if (error) return error;
    db.prepare("DELETE FROM access_mfa WHERE user_id=?").run(member.id);
    db.prepare("DELETE FROM access_recovery_codes WHERE user_id=?").run(member.id);
    revokeSessions(db, member.id); audit(db, member.id, "Disabled optional authenticator after password and fresh-code verification");
    return { ok: true, sessions_revoked: true };
  });
}
