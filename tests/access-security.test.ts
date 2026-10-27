import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { createDatabase } from "../server/database.js";
import {
  initializeAccessSecurity, beginAuthentication, authenticationSetup,
  completeAuthentication, beginEnrollment, confirmEnrollment,
  accessSecurityStatus, regenerateRecoveryCodes, disableMfa,
} from "../server/access-security.js";

const password = "CevraliDemo2026!";
const now = Date.UTC(2026, 9, 26, 12, 0, 0);
const key = Buffer.alloc(32, 7);
type User = {
  id: string; name: string; email: string; role: "clinician" | "receptionist";
  is_admin: number; is_active: number;
};

// Independent RFC 6238 implementation: no application generator is imported.
function totp(secret: string, at = now) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret.toUpperCase().replace(/=+$/, "")) {
    const index = alphabet.indexOf(character);
    assert.ok(index >= 0, "Enrollment secret must use Base32");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, index) =>
    Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const digest = createHmac("sha1", bytes).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
}
function wrongCode(secret: string, at = now) {
  const accepted = new Set([-30000, 0, 30000].map(offset => totp(secret, at + offset)));
  let value = 0;
  while (accepted.has(String(value).padStart(6, "0"))) value++;
  return String(value).padStart(6, "0");
}
function statusError(...statuses: number[]) {
  return (error: unknown) => Boolean(error && typeof error === "object" &&
    "status" in error && statuses.includes(Number(error.status)));
}
function fixture() {
  const db = createDatabase(":memory:");
  initializeAccessSecurity(db);
  const user = db.prepare("SELECT id,name,email,role,is_admin,is_active FROM users WHERE id='usr-clinician'").get() as User;
  const colleague = db.prepare("SELECT id,name,email,role,is_admin,is_active FROM users WHERE id='usr-colleague'").get() as User;
  const start = (at = now) => {
    const pending = beginAuthentication(db, user, { requireMfa: true, key, practiceName: "Synthetic MFA Practice", now: at });
    assert.equal(pending.kind, "mfa");
    if (pending.kind !== "mfa") throw new Error("MFA challenge required");
    return pending;
  };
  const enroll = () => {
    const pending = start();
    const setup = authenticationSetup(db, { email: user.email, challenge_token: pending.challenge_token }, key, "Synthetic MFA Practice", now);
    const completed = completeAuthentication(db, { email: user.email, challenge_token: pending.challenge_token, code: totp(setup.secret) }, key, now);
    assert.equal(completed.ok, true);
    if (!completed.ok) throw new Error("Expected enrollment success");
    assert.equal(completed.recovery_codes?.length, 10);
    return { pending, setup, completed, recoveryCodes: completed.recovery_codes! };
  };
  const addSession = () => {
    const token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions VALUES (?,?,?)").run(token, user.id, now + 3600000);
    return token;
  };
  const persisted = () => {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    return JSON.stringify(tables.map(({ name }) => ({ name,
      rows: db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
    })));
  };
  return { db, user, colleague, start, enroll, addSession, persisted };
}

test("optional MFA preserves existing sign-in while required MFA fails closed without encryption material", () => {
  const f = fixture();
  try {
    const result = beginAuthentication(f.db, f.user, { requireMfa: false, now });
    assert.equal(result.kind, "authenticated");
    assert.equal(Object.hasOwn(result, "password"), false);
    if (result.kind === "authenticated") assert.equal(Object.hasOwn(result.user, "password"), false);
    const status = accessSecurityStatus(f.db, f.user, { required: false });
    assert.equal(status.available, false);
    assert.equal(status.mfa_enabled, false);
    assert.equal(status.recovery_codes_remaining, 0);
    assert.throws(() => beginAuthentication(f.db, f.user, { requireMfa: true, now }), statusError(503));
    assert.throws(() => beginAuthentication(f.db, f.user, { requireMfa: true, key: Buffer.alloc(31), now }), statusError(503));
    assert.equal(f.db.prepare("SELECT count(*) count FROM sessions").get()!.count, 0);
  } finally { f.db.close(); }
});

test("required enrollment encrypts the authenticator secret, hashes challenge and recovery values, and creates no session", () => {
  const f = fixture();
  try {
    const pending = f.start();
    assert.equal(pending.enrollment_required, true);
    assert.equal(pending.email, f.user.email);
    assert.match(pending.challenge_token, /^[a-f0-9]{64}$/);
    assert.equal(Date.parse(pending.expires_at) - now, 5 * 60000);
    const setup = authenticationSetup(f.db, { email: f.user.email, challenge_token: pending.challenge_token }, key, "Synthetic MFA Practice", now);
    assert.match(setup.secret, /^[A-Z2-7]+$/);
    const uri = new URL(setup.otpauth_uri);
    assert.equal(uri.protocol, "otpauth:");
    assert.equal(uri.hostname, "totp");
    assert.equal(uri.searchParams.get("secret"), setup.secret);
    assert.equal(uri.searchParams.get("issuer"), "Synthetic MFA Practice");
    const repeated = authenticationSetup(f.db, { email: f.user.email, challenge_token: pending.challenge_token }, key, "Synthetic MFA Practice", now + 1000);
    assert.equal(repeated.secret, setup.secret);
    assert.equal(f.persisted().includes(setup.secret), false);
    assert.equal(f.persisted().includes(pending.challenge_token), false);
    const completed = completeAuthentication(f.db, { email: f.user.email, challenge_token: pending.challenge_token, code: totp(setup.secret) }, key, now);
    assert.equal(completed.ok, true);
    if (!completed.ok) return;
    assert.equal(completed.user.id, f.user.id);
    assert.equal(Object.hasOwn(completed.user, "password"), false);
    assert.equal(completed.recovery_codes?.length, 10);
    assert.equal(new Set(completed.recovery_codes).size, 10);
    for (const code of completed.recovery_codes!) {
      assert.ok(code.length >= 16);
      assert.equal(f.persisted().includes(code), false);
    }
    assert.equal(f.persisted().includes(setup.secret), false);
    assert.equal(f.db.prepare("SELECT count(*) count FROM sessions").get()!.count, 0);
    const status = accessSecurityStatus(f.db, f.user, { required: true, key });
    assert.equal(status.mfa_enabled, true);
    assert.equal(status.recovery_codes_remaining, 10);
    assert.equal(Object.hasOwn(status, "secret"), false);
  } finally { f.db.close(); }
});

test("an enrolled account requires MFA even when enrollment is optional and rejects reused TOTP steps and consumed challenges", () => {
  const f = fixture();
  try {
    const { setup } = f.enroll();
    const next = now + 30000;
    const pending = beginAuthentication(f.db, f.user, { requireMfa: false, key, now: next });
    assert.equal(pending.kind, "mfa");
    if (pending.kind !== "mfa") return;
    assert.equal(pending.enrollment_required, false);
    const completed = completeAuthentication(f.db, { email: f.user.email, challenge_token: pending.challenge_token, code: totp(setup.secret, next) }, key, next);
    assert.equal(completed.ok, true);
    if (completed.ok) assert.equal(completed.recovery_codes, undefined);
    assert.throws(() => completeAuthentication(f.db, { email: f.user.email, challenge_token: pending.challenge_token, code: totp(setup.secret, next) }, key, next), statusError(401, 409, 410));
    const replay = f.start(next);
    const rejected = completeAuthentication(f.db, { email: f.user.email, challenge_token: replay.challenge_token, code: totp(setup.secret, next) }, key, next);
    assert.equal(rejected.ok, false);
    const fresh = completeAuthentication(f.db, { email: f.user.email, challenge_token: replay.challenge_token, code: totp(setup.secret, next + 30000) }, key, next + 30000);
    assert.equal(fresh.ok, true);
  } finally { f.db.close(); }
});

test("TOTP accepts only the bounded clock window and a future accepted step cannot be replayed when time catches up", () => {
  const f = fixture();
  try {
    const { setup } = f.enroll();
    const at = now + 120000;
    const pending = f.start(at);
    const tooOld = completeAuthentication(f.db, { email: f.user.email, challenge_token: pending.challenge_token, code: totp(setup.secret, at - 90000) }, key, at);
    assert.equal(tooOld.ok, false);
    const future = completeAuthentication(f.db, { email: f.user.email, challenge_token: pending.challenge_token, code: totp(setup.secret, at + 30000) }, key, at);
    assert.equal(future.ok, true);
    const replay = f.start(at + 30000);
    const rejected = completeAuthentication(f.db, { email: f.user.email, challenge_token: replay.challenge_token, code: totp(setup.secret, at + 30000) }, key, at + 30000);
    assert.equal(rejected.ok, false);
    const valid = completeAuthentication(f.db, { email: f.user.email, challenge_token: replay.challenge_token, code: totp(setup.secret, at + 60000) }, key, at + 60000);
    assert.equal(valid.ok, true);
  } finally { f.db.close(); }
});

test("five wrong codes persist a user lockout across new pending challenges and permit fresh verification after the lock expires", () => {
  const f = fixture();
  try {
    const { setup } = f.enroll();
    const at = now + 30000;
    let pending = f.start(at);
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (attempt === 3) pending = f.start(at + 1000);
      const result = completeAuthentication(f.db, { email: f.user.email, challenge_token: pending.challenge_token, code: wrongCode(setup.secret, at) }, key, at + 1000);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.attempts_remaining, 5 - attempt);
    }
    assert.throws(() => f.start(at + 2000), statusError(429));
    assert.equal(accessSecurityStatus(f.db, f.user, { required: true, key }).mfa_enabled, true);
    const unlockedAt = at + 16 * 60000;
    const fresh = f.start(unlockedAt);
    assert.equal(completeAuthentication(f.db, { email: f.user.email, challenge_token: fresh.challenge_token, code: totp(setup.secret, unlockedAt) }, key, unlockedAt).ok, true);
  } finally { f.db.close(); }
});

test("pending challenges expire and are scoped to their active user and tenant database", () => {
  const f = fixture(), other = fixture();
  try {
    const pending = f.start();
    assert.throws(() => authenticationSetup(f.db, { email: f.colleague.email, challenge_token: pending.challenge_token }, key, "Synthetic", now), statusError(401, 404));
    assert.throws(() => authenticationSetup(other.db, { email: f.user.email, challenge_token: pending.challenge_token }, key, "Synthetic", now), statusError(401, 404));
    assert.throws(() => authenticationSetup(f.db, { email: f.user.email, challenge_token: pending.challenge_token }, key, "Synthetic", now + 6 * 60000), statusError(401, 410));
    const fresh = f.start(now + 7 * 60000);
    const setup = authenticationSetup(f.db, { email: f.user.email, challenge_token: fresh.challenge_token }, key, "Synthetic", now + 7 * 60000);
    f.db.prepare("UPDATE users SET is_active=0 WHERE id=?").run(f.user.id);
    assert.throws(() => completeAuthentication(f.db, { email: f.user.email, challenge_token: fresh.challenge_token, code: totp(setup.secret, now + 7 * 60000) }, key, now + 7 * 60000), statusError(401, 403));
  } finally { f.db.close(); other.db.close(); }
});

test("the wrong encryption key never exposes enrollment state or finalizes authentication", () => {
  const f = fixture();
  try {
    const pending = f.start();
    const setup = authenticationSetup(f.db, { email: f.user.email, challenge_token: pending.challenge_token }, key, "Synthetic", now);
    const otherKey = Buffer.alloc(32, 8);
    assert.throws(() => authenticationSetup(f.db, { email: f.user.email, challenge_token: pending.challenge_token }, otherKey, "Synthetic", now), statusError(503));
    assert.throws(() => completeAuthentication(f.db, { email: f.user.email, challenge_token: pending.challenge_token, code: totp(setup.secret) }, otherKey, now), statusError(503));
    assert.equal(accessSecurityStatus(f.db, f.user, { required: true, key }).mfa_enabled, false);
    assert.equal(completeAuthentication(f.db, { email: f.user.email, challenge_token: pending.challenge_token, code: totp(setup.secret) }, key, now).ok, true);
  } finally { f.db.close(); }
});

test("single-use recovery codes revoke old sessions and do not reveal the remaining codes", () => {
  const f = fixture();
  try {
    const { recoveryCodes } = f.enroll();
    f.addSession(); f.addSession();
    const pending = f.start(now + 30000);
    const recovered = completeAuthentication(f.db, { email: f.user.email, challenge_token: pending.challenge_token, code: recoveryCodes[0] }, key, now + 30000);
    assert.equal(recovered.ok, true);
    if (recovered.ok) {
      assert.equal(recovered.sessions_revoked, true);
      assert.equal(recovered.recovery_codes, undefined);
    }
    assert.equal(f.db.prepare("SELECT count(*) count FROM sessions WHERE user_id=?").get(f.user.id)!.count, 0);
    assert.equal(accessSecurityStatus(f.db, f.user, { required: true, key }).recovery_codes_remaining, 9);
    const replay = f.start(now + 60000);
    assert.equal(completeAuthentication(f.db, { email: f.user.email, challenge_token: replay.challenge_token, code: recoveryCodes[0] }, key, now + 60000).ok, false);
    assert.equal(f.persisted().includes(recoveryCodes[0]), false);
  } finally { f.db.close(); }
});

test("optional account enrollment requires the actual password and confirmation revokes existing sessions", () => {
  const f = fixture();
  try {
    const failed = beginEnrollment(f.db, f.user, "wrong password", key, "Synthetic", now);
    assert.equal('ok' in failed && failed.ok, false);
    assert.equal(f.db.prepare('SELECT count(*) count FROM access_auth_failures WHERE user_id=?').get(f.user.id)!.count, 1);
    assert.equal(accessSecurityStatus(f.db, f.user, { required: false, key }).mfa_enabled, false);
    f.addSession();
    const setup = beginEnrollment(f.db, f.user, password, key, "Synthetic", now);
    if ('ok' in setup) throw new Error('Expected authenticator setup');
    assert.ok(setup.enrollment_id);
    assert.throws(() => confirmEnrollment(f.db, f.colleague, { enrollment_id: setup.enrollment_id, code: totp(setup.secret) }, key, now), statusError(401, 403, 404));
    const completed = confirmEnrollment(f.db, f.user, { enrollment_id: setup.enrollment_id, code: totp(setup.secret) }, key, now);
    assert.equal(completed.ok, true);
    if (completed.ok) {
      assert.equal(completed.sessions_revoked, true);
      assert.equal(completed.recovery_codes?.length, 10);
    }
    assert.equal(f.db.prepare("SELECT count(*) count FROM sessions").get()!.count, 0);
    assert.throws(() => beginEnrollment(f.db, f.user, password, key, "Synthetic", now + 30000), statusError(409));
  } finally { f.db.close(); }
});

test("recovery-code rotation requires password plus a fresh TOTP and invalidates all old codes and sessions", () => {
  const f = fixture();
  try {
    const { setup, recoveryCodes } = f.enroll();
    const at = now + 30000;
    const failed = regenerateRecoveryCodes(f.db, f.user, { password: "wrong password", code: totp(setup.secret, at) }, key, at);
    assert.equal(failed.ok, false);
    assert.equal(accessSecurityStatus(f.db, f.user, { required: false, key }).recovery_codes_remaining, 10);
    f.addSession();
    const result = regenerateRecoveryCodes(f.db, f.user, { password, code: totp(setup.secret, at) }, key, at);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.sessions_revoked, true);
    assert.equal(result.recovery_codes.length, 10);
    assert.equal(result.recovery_codes.some(code => recoveryCodes.includes(code)), false);
    assert.equal(f.db.prepare("SELECT count(*) count FROM sessions").get()!.count, 0);
    const pending = f.start(at + 30000);
    assert.equal(completeAuthentication(f.db, { email: f.user.email, challenge_token: pending.challenge_token, code: recoveryCodes[0] }, key, at + 30000).ok, false);
    assert.equal(completeAuthentication(f.db, { email: f.user.email, challenge_token: pending.challenge_token, code: result.recovery_codes[0] }, key, at + 30000).ok, true);
  } finally { f.db.close(); }
});

test("required MFA cannot be disabled and optional disabling requires both current credentials and a new authenticator code", () => {
  const f = fixture();
  try {
    const { setup } = f.enroll();
    const at = now + 30000;
    assert.throws(() => disableMfa(f.db, f.user, { password, code: totp(setup.secret, at) }, key, { required: true, now: at }), statusError(403));
    assert.equal(accessSecurityStatus(f.db, f.user, { required: true, key }).mfa_enabled, true);
    const wrong = disableMfa(f.db, f.user, { password, code: wrongCode(setup.secret, at) }, key, { required: false, now: at });
    assert.equal(wrong.ok, false);
    f.addSession();
    const disabled = disableMfa(f.db, f.user, { password, code: totp(setup.secret, at) }, key, { required: false, now: at });
    assert.equal(disabled.ok, true);
    assert.equal(f.db.prepare("SELECT count(*) count FROM sessions").get()!.count, 0);
    assert.equal(accessSecurityStatus(f.db, f.user, { required: false, key }).mfa_enabled, false);
    assert.equal(beginAuthentication(f.db, f.user, { requireMfa: false, key, now: at }).kind, "authenticated");
  } finally { f.db.close(); }
});
