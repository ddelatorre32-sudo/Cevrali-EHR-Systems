import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfig, readRuntimeKeyFile } from "../server/runtime-config.js";
import { readinessReport, RELEASE_APPROVAL_AREAS, validateStartup } from "../server/readiness.js";

const now = new Date("2026-10-26T10:00:00.000Z");
const commit = "1".repeat(40);
function mountedFixture() {
  const directory = mkdtempSync(join(tmpdir(), "cevrali-runtime-"));
  const auth = join(directory, "auth.key"), backup = join(directory, "backup.key");
  writeFileSync(auth, randomBytes(32).toString("base64") + "\n", { mode: 0o600 });
  writeFileSync(backup, randomBytes(32).toString("base64") + "\n", { mode: 0o600 });
  return {
    directory, auth, backup,
    env: { CEVRALI_MODE: "pilot", COOKIE_SECURE: "true", PUBLIC_BASE_URL: "https://pilot.example.test",
      CEVRALI_AUTH_ENCRYPTION_KEY_FILE: auth, CEVRALI_BACKUP_KEY_FILE: backup },
    close() { rmSync(directory, { recursive: true, force: true }); },
  };
}

test("demo remains the default even in a production Node process, and configuration is immutable", () => {
  const config = loadRuntimeConfig({ NODE_ENV: "production" });
  assert.equal(config.mode, "demo");
  assert.equal(config.demoEnabled, true);
  assert.equal(config.publicSignupEnabled, true);
  assert.equal(config.requireMfa, false);
  assert.equal(Object.isFrozen(config), true);
  const report = validateStartup(config);
  assert.equal(report.startup_allowed, true);
  assert.equal(report.clinical_use_allowed, false);
  assert.equal(report.scope, "synthetic-demo");
});

test("unknown modes and ambiguous boolean values fail without echoing environment values", () => {
  const sensitive = "credential-that-must-not-appear";
  for (const env of [
    { CEVRALI_MODE: sensitive },
    { COOKIE_SECURE: sensitive },
    { CEVRALI_PUBLIC_SIGNUP: sensitive },
  ]) {
    assert.throws(() => loadRuntimeConfig(env), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(sensitive), false);
      return true;
    });
  }
});

test("protected modes require HTTPS, secure cookies, and operator-only practice provisioning", () => {
  for (const mode of ["pilot", "production"]) {
    assert.throws(() => loadRuntimeConfig({ CEVRALI_MODE: mode }), /COOKIE_SECURE/);
    assert.throws(() => loadRuntimeConfig({ CEVRALI_MODE: mode, COOKIE_SECURE: "true" }), /PUBLIC_BASE_URL/);
    assert.throws(() => loadRuntimeConfig({ CEVRALI_MODE: mode, COOKIE_SECURE: "true", PUBLIC_BASE_URL: "http://example.test" }), /HTTPS/);
    assert.throws(() => loadRuntimeConfig({ CEVRALI_MODE: mode, COOKIE_SECURE: "true", PUBLIC_BASE_URL: "https://example.test", CEVRALI_PUBLIC_SIGNUP: "true" }), /Public practice signup/);
    const config = loadRuntimeConfig({ CEVRALI_MODE: mode, COOKIE_SECURE: "true", PUBLIC_BASE_URL: "https://example.test/" });
    assert.equal(config.publicBaseUrl, "https://example.test");
    assert.equal(config.demoEnabled, false);
    assert.equal(config.publicSignupEnabled, false);
    assert.equal(config.requireMfa, true);
  }
});

test("website origins reject credentials, paths, fragments, and non-web schemes without disclosing input", () => {
  for (const value of ["https://user:secret@example.test", "https://example.test/path", "https://example.test/?token=secret", "https://example.test/#secret", "javascript:secret", "invalid-secret"]) {
    assert.throws(() => loadRuntimeConfig({ PUBLIC_BASE_URL: value }), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(value), false);
      assert.equal(error.message.includes("secret"), false);
      return true;
    });
  }
});

test("valid separate mounted keys allow only a synthetic staff pilot", () => {
  const fixture = mountedFixture();
  try {
    const config = loadRuntimeConfig(fixture.env);
    const report = validateStartup(config);
    assert.equal(report.mode, "pilot");
    assert.equal(report.scope, "synthetic-staff-pilot");
    assert.equal(report.startup_allowed, true);
    assert.equal(report.clinical_use_allowed, false);
    assert.ok(report.checks.find(check => check.id === "key-separation" && check.status === "passed"));
    assert.equal(report.checks.find(check => check.id === "clinical-release")?.status, "pending");
  } finally { fixture.close(); }
});

test("missing, malformed, weak, shared, or permissive key files block a pilot without leaking paths or contents", () => {
  const fixture = mountedFixture();
  try {
    const secret = "secret-runtime-key-that-must-not-be-printed";
    writeFileSync(fixture.auth, secret, { mode: 0o600 });
    const invalid = readinessReport(loadRuntimeConfig(fixture.env));
    assert.equal(invalid.startup_allowed, false);
    assert.equal(JSON.stringify(invalid).includes(secret), false);
    assert.equal(JSON.stringify(invalid).includes(fixture.directory), false);
    assert.throws(() => validateStartup(loadRuntimeConfig(fixture.env)), /startup blocked/);
    writeFileSync(fixture.auth, Buffer.alloc(32).toString("base64"));
    assert.throws(() => readRuntimeKeyFile(fixture.auth, "authentication"), /private authentication key file/);
    writeFileSync(fixture.auth, readFileSync(fixture.backup));
    assert.equal(readinessReport(loadRuntimeConfig(fixture.env)).checks.find(check => check.id === "key-separation")?.status, "blocked");
    writeFileSync(fixture.auth, randomBytes(32).toString("base64"));
    chmodSync(fixture.auth, 0o644);
    assert.equal(readinessReport(loadRuntimeConfig(fixture.env)).checks.find(check => check.id === "authentication-key")?.status, "blocked");
    const absent = readinessReport(loadRuntimeConfig({ ...fixture.env, CEVRALI_AUTH_ENCRYPTION_KEY_FILE: "" }));
    assert.equal(absent.startup_allowed, false);
  } finally { fixture.close(); }
});

test("key files require canonical Base64 and regular private files, and keys are read without being serialized", () => {
  const fixture = mountedFixture();
  try {
    const key = readRuntimeKeyFile(fixture.auth, "authentication");
    assert.equal(key.length, 32);
    assert.equal(key.toString("base64"), readFileSync(fixture.auth, "utf8").trim());
    key.fill(0);
    const link = join(fixture.directory, "key-link");
    symlinkSync(fixture.auth, link);
    assert.throws(() => readRuntimeKeyFile(link, "authentication"), /private authentication key file/);
    writeFileSync(fixture.auth, "x".repeat(1000));
    assert.throws(() => readRuntimeKeyFile(fixture.auth, "authentication"), /private authentication key file/);
    assert.throws(() => readRuntimeKeyFile(fixture.directory, "authentication"), /private authentication key file/);
  } finally { fixture.close(); }
});

test("a production approval document cannot enable missing clinical transports", () => {
  const fixture = mountedFixture();
  try {
    const evidencePath = join(fixture.directory, "release.json");
    const owner = "Private owner name not copied to report";
    const record = {
      schema_version: 1, environment: "production", release_commit: commit,
      approvals: Object.fromEntries(RELEASE_APPROVAL_AREAS.map(area => [area, {
        decision: "approved", owner, reviewed_at: "2026-10-25T10:00:00.000Z", evidence_ref: `review-record:${area}:2026`,
      }])),
      live_clinical_services: true,
    };
    writeFileSync(evidencePath, JSON.stringify(record));
    const config = loadRuntimeConfig({ ...fixture.env, CEVRALI_MODE: "production", CEVRALI_RELEASE_COMMIT: commit, CEVRALI_PRODUCTION_RELEASE_FILE: evidencePath });
    const report = readinessReport(config, { now });
    assert.equal(report.startup_allowed, false);
    assert.equal(report.clinical_use_allowed, false);
    assert.equal(report.scope, "clinical-production-blocked");
    assert.match(report.release_evidence_sha256!, /^[a-f0-9]{64}$/);
    assert.equal(report.checks.filter(check => check.id.startsWith("approval-") && check.status === "passed").length, RELEASE_APPROVAL_AREAS.length);
    assert.equal(report.checks.find(check => check.id === "live-clinical-services")?.status, "blocked");
    assert.equal(JSON.stringify(report).includes(owner), false);
    assert.equal(JSON.stringify(report).includes("review-record:"), false);
    assert.throws(() => validateStartup(config), /no live pharmacy/);
  } finally { fixture.close(); }
});

test("release evidence requires matching revisions and every owner approval instead of blanket confirmation", () => {
  const fixture = mountedFixture();
  try {
    const evidencePath = join(fixture.directory, "release.json");
    const env = { ...fixture.env, CEVRALI_MODE: "production", CEVRALI_RELEASE_COMMIT: commit, CEVRALI_PRODUCTION_RELEASE_FILE: evidencePath };
    const approved = { decision: "approved", owner: "Clinical owner", reviewed_at: "2026-10-25", evidence_ref: "actual-review-id:123" };
    const approvals = Object.fromEntries(RELEASE_APPROVAL_AREAS.map(area => [area, { ...approved }]));
    approvals.clinical = { ...approved, reviewed_at: "2099-01-01" };
    approvals.security = { ...approved, evidence_ref: "pending" };
    writeFileSync(evidencePath, JSON.stringify({ schema_version: 1, environment: "production", release_commit: "2".repeat(40), approved: true, approvals }));
    const report = readinessReport(loadRuntimeConfig(env), { now });
    for (const id of ["release-revision", "approval-clinical", "approval-security"])
      assert.equal(report.checks.find(check => check.id === id)?.status, "blocked");
    writeFileSync(evidencePath, JSON.stringify({ schema_version: 1, environment: "production", release_commit: commit, approved: true }));
    assert.equal(readinessReport(loadRuntimeConfig(env), { now }).checks.filter(check => check.id.startsWith("approval-") && check.status === "blocked").length, RELEASE_APPROVAL_AREAS.length);
  } finally { fixture.close(); }
});

test("missing, oversized, wrong-environment, and malformed evidence produce sanitized blocked reports", () => {
  const fixture = mountedFixture();
  try {
    const evidencePath = join(fixture.directory, "release.json");
    const env = { ...fixture.env, CEVRALI_MODE: "production", CEVRALI_PRODUCTION_RELEASE_FILE: evidencePath };
    for (const raw of [null, "{secret: invalid json", "x".repeat(70000), JSON.stringify({ schema_version: 1, environment: "demo" })]) {
      if (raw !== null) writeFileSync(evidencePath, raw);
      const report = readinessReport(loadRuntimeConfig(env), { now });
      assert.equal(report.startup_allowed, false);
      assert.equal(report.checks.find(check => check.id === "release-evidence")?.status, "blocked");
      assert.equal(JSON.stringify(report).includes("secret:"), false);
      assert.equal(JSON.stringify(report).includes(fixture.directory), false);
    }
  } finally { fixture.close(); }
});

test("release identifiers and invalid filesystem paths reject raw input without disclosure", () => {
  assert.throws(() => loadRuntimeConfig({ CEVRALI_RELEASE_COMMIT: "secret-token" }), error => {
    assert.ok(error instanceof Error); assert.equal(error.message.includes("secret-token"), false); return true;
  });
  assert.throws(() => loadRuntimeConfig({ CEVRALI_AUTH_ENCRYPTION_KEY_FILE: "bad\0secret-path" }), error => {
    assert.ok(error instanceof Error); assert.equal(error.message.includes("secret-path"), false); return true;
  });
  assert.throws(() => loadRuntimeConfig({ DATABASE_PATH: "bad\0secret-path" }), /DATABASE_PATH/);
});

test("hand-constructed protected configurations cannot bypass MFA or re-enable demo signup", () => {
  const fixture = mountedFixture();
  try {
    const config = loadRuntimeConfig(fixture.env);
    for (const change of [{ requireMfa: false }, { publicSignupEnabled: true }, { demoEnabled: true }])
      assert.equal(readinessReport({ ...config, ...change }).startup_allowed, false);
  } finally { fixture.close(); }
});
