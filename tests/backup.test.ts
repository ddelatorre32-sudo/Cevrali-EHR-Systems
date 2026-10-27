import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase } from "../server/database.js";
import { createPlatformApp } from "../server/platform.js";
import { tokenHash } from "../server/accounts.js";
import { initializeAccessSecurity } from "../server/access-security.js";
import { loadWorkflow, saveWorkflow } from "../server/workflows.js";
import {
  acquireServiceLock, createEncryptedBackup, restoreEncryptedBackup, verifyEncryptedBackup,
} from "../server/backup.js";

const patientId = "pat-backup-synthetic";
const encounterId = "enc-backup-synthetic";
const patientMarker = "SYNTHETIC-PATIENT-BACKUP-PRIVATE-MARKER";
const noteMarker = "Synthetic signed plan retained by the encrypted restore drill.";

function envelope(archive: Buffer) {
  const firstLine = archive.indexOf(10), lastHeaderByte = archive.indexOf(10, firstLine + 1);
  assert.ok(firstLine > 0 && lastHeaderByte > firstLine);
  return { magic: archive.subarray(0, firstLine + 1), header: archive.subarray(0, lastHeaderByte + 1),
    metadata: JSON.parse(archive.subarray(firstLine + 1, lastHeaderByte).toString("utf8")) as { cipher: string; nonce: string } };
}

// Produce an authenticated but malicious operator-supplied archive. These
// cases must be rejected by manifest validation, not merely by the GCM tag.
function changedManifest(archive: Buffer, keyText: string, change: (manifest: any) => void): Buffer {
  const source = envelope(archive), key = Buffer.from(keyText, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(source.metadata.nonce, "base64"));
  decipher.setAAD(source.header); decipher.setAuthTag(archive.subarray(-16));
  const plain = Buffer.concat([decipher.update(archive.subarray(source.header.length, -16)), decipher.final()]);
  const oldLength = plain.readUInt32BE(), manifest = JSON.parse(plain.subarray(4, 4 + oldLength).toString("utf8"));
  change(manifest);
  const encoded = Buffer.from(JSON.stringify(manifest)), length = Buffer.alloc(4);
  length.writeUInt32BE(encoded.length);
  const nonce = randomBytes(12), header = Buffer.concat([source.magic,
    Buffer.from(JSON.stringify({ cipher: "aes-256-gcm", nonce: nonce.toString("base64") }) + "\n")]);
  const cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(header);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([length, encoded, plain.subarray(4 + oldLength)])), cipher.final()]);
  return Buffer.concat([header, encrypted, cipher.getAuthTag()]);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cevrali-backup-test-"));
  const source = join(root, "source");
  mkdirSync(source, { mode: 0o700 });
  const databasePath = join(source, "cevrali.sqlite"), accountsPath = join(source, "accounts");
  const keyFile = join(root, "backup.key");
  const keyText = randomBytes(32).toString("base64");
  writeFileSync(keyFile, `${keyText}\n`, { mode: 0o600 });
  const db = createDatabase(databasePath);
  const platform = createPlatformApp(db, accountsPath);
  let closed = false;
  try {
    const account = platform.store.signup({
      owner_name: "Synthetic Backup Owner", email: "backup-owner@example.test",
      password: "SyntheticBackup2026!", clinical_access: true,
      practice: { name: "Synthetic Recovery Practice" },
    });
    const practiceId = account.practice.id, ownerId = String(account.user.id);
    const practiceDb = platform.store.db(practiceId);
    practiceDb.prepare("INSERT INTO patients(id,first_name,last_name,dob,sex,phone,address,address_unit,city,state,zip_code) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(patientId, patientMarker, "Synthetic", "1990-01-02", "Unknown", "555-0101", "100 Synthetic Avenue", "4B", "Boston", "MA", "02108");
    practiceDb.prepare("INSERT INTO encounters(id,patient_id,author_id,chief_complaint,assessment,plan,status,signed_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(encounterId, patientId, ownerId, "Synthetic recovery drill", "Synthetic assessment", noteMarker, "Signed", "2026-01-01T12:00:00.000Z");
    practiceDb.prepare("INSERT INTO audit(user_id,action,resource) VALUES(?,?,?)")
      .run(ownerId, "Synthetic signed note created for recovery drill", encounterId);
    const state = loadWorkflow(practiceDb);
    state.preferences[ownerId] = { favorites: [patientId], recent: [patientId], filters: [{ name: "Recovery marker", query: patientMarker }] };
    state.intakes.push({ id: "synthetic-intake", patient_id: patientId, appointment_id: "synthetic-appointment", status: "Requested",
      token_hash: tokenHash("synthetic-intake-link"), expires_at: "2099-01-01T00:00:00.000Z", created_at: "2026-01-01T12:00:00.000Z", issuer_id: ownerId });
    state.prescribing.challenges.push({ id: "synthetic-prescribing-challenge", prescription_id: "synthetic-prescription", revision: 1,
      user_id: ownerId, session_id: "synthetic-session", context_fingerprint: "synthetic-fingerprint", code_hash: tokenHash("synthetic-demo-code"),
      created_at: "2026-01-01T12:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z", failed_attempts: 0 });
    saveWorkflow(practiceDb, state);
    const expires = Date.now() + 3600000;
    const priorSession = tokenHash("synthetic-prior-tenant-session");
    practiceDb.prepare("INSERT INTO sessions VALUES(?,?,?)").run(priorSession, ownerId, expires);
    initializeAccessSecurity(practiceDb);
    practiceDb.exec("CREATE TABLE IF NOT EXISTS mfa_sessions(token TEXT PRIMARY KEY REFERENCES sessions(token) ON DELETE CASCADE,verified_at TEXT NOT NULL)");
    practiceDb.prepare("INSERT INTO mfa_sessions VALUES(?,?)").run(priorSession, "2026-01-01T12:00:00.000Z");
    practiceDb.prepare("INSERT INTO access_mfa VALUES(?,?,?,?)").run(ownerId, "synthetic-encrypted-authenticator-identity", 1, 999);
    practiceDb.prepare("INSERT INTO access_recovery_codes VALUES(?,?,?,?)").run(tokenHash("synthetic-unused-recovery-code"), ownerId, 1, null);
    practiceDb.prepare("INSERT INTO access_challenges VALUES(?,?,?,?,?,?,?)")
      .run(tokenHash("synthetic-pending-login"), ownerId, "login", "synthetic-credential-version", null, 1, expires);
    platform.store.indexSession(priorSession, practiceId, ownerId, expires);
    platform.store.registry.prepare("INSERT INTO public_links VALUES(?,?,?)").run(tokenHash("synthetic-intake-link"), practiceId, "2099-01-01T00:00:00.000Z");
    platform.store.registry.prepare("INSERT INTO invitations VALUES(?,?,?,?,?,?,?,?,?)")
      .run("synthetic-pending-invitation", practiceId, "invited@example.test", "front_desk", 0,
        tokenHash("synthetic-staff-invitation"), "Pending", "2026-01-01T12:00:00.000Z", "2099-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(tokenHash("synthetic-prior-demo-session"), "usr-clinician", expires);
    // Closing every writer before requesting the shared service lock is part of
    // the operator contract; backup itself also makes WAL-safe SQLite copies.
    platform.store.close(); db.close(); closed = true;
    const outputPath = join(root, "snapshot.cevrali-backup");
    return {
      root, databasePath, accountsPath, keyFile, keyText, outputPath, practiceId, ownerId,
      options: { databasePath, accountsPath, keyFile, outputPath },
      close: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    if (!closed) { platform.store.close(); db.close(); }
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test("encrypted backup restores the registry, patient, signed note and workflow together while revoking prior sessions", async () => {
  const f = fixture();
  try {
    await createEncryptedBackup(f.options);
    const archive = readFileSync(f.outputPath);
    assert.equal(archive.includes(Buffer.from(patientMarker)), false);
    assert.equal(archive.includes(Buffer.from(noteMarker)), false);
    assert.equal(archive.includes(Buffer.from("SQLite format 3")), false);
    assert.equal(archive.includes(Buffer.from(f.keyText)), false);
    assert.equal(lstatSync(f.outputPath).mode & 0o077, 0);
    const verified = await verifyEncryptedBackup({ backupPath: f.outputPath, keyFile: f.keyFile });
    assert.equal(verified.format, "cevrali-encrypted-backup-v1");
    assert.equal(verified.database_count, 3);
    assert.match(verified.archive_sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isFinite(Date.parse(verified.created_at)));
    const destinationPath = join(f.root, "restored");
    const restored = await restoreEncryptedBackup({ backupPath: f.outputPath, keyFile: f.keyFile, destinationPath });
    assert.equal(restored.destination_path, destinationPath);
    assert.equal(restored.sessions_revoked, true);
    assert.equal(restored.database_count, 3);
    assert.equal(lstatSync(restored.database_path).mode & 0o077, 0);
    const db = createDatabase(restored.database_path);
    const platform = createPlatformApp(db, restored.accounts_path);
    try {
      assert.equal(platform.store.membership("backup-owner@example.test")!.practice_id, f.practiceId);
      const practice = platform.store.db(f.practiceId);
      const patient = practice.prepare("SELECT * FROM patients WHERE id=?").get(patientId)!;
      assert.equal(patient.first_name, patientMarker);
      assert.equal(patient.zip_code, "02108");
      assert.equal(patient.address_unit, "4B");
      const encounter = practice.prepare("SELECT status,plan,signed_at FROM encounters WHERE id=?").get(encounterId)!;
      assert.equal(encounter.status, "Signed");
      assert.equal(encounter.plan, noteMarker);
      assert.equal(encounter.signed_at, "2026-01-01T12:00:00.000Z");
      assert.deepEqual(loadWorkflow(practice).preferences[f.ownerId].favorites, [patientId]);
      assert.equal(loadWorkflow(practice).prescribing.challenges.length, 0);
      const intake = loadWorkflow(practice).intakes.find(item => item.id === "synthetic-intake")!;
      assert.equal(intake.expires_at, "1970-01-01T00:00:00.000Z");
      assert.notEqual(intake.token_hash, tokenHash("synthetic-intake-link"));
      assert.equal(practice.prepare("SELECT count(*) n FROM audit WHERE resource=?").get(encounterId)!.n, 1);
      assert.equal(practice.prepare("SELECT count(*) n FROM sessions").get()!.n, 0);
      assert.equal(practice.prepare("SELECT count(*) n FROM mfa_sessions").get()!.n, 0);
      assert.equal(practice.prepare("SELECT count(*) n FROM access_challenges").get()!.n, 0);
      assert.equal(practice.prepare("SELECT count(*) n FROM access_recovery_codes").get()!.n, 0);
      const authenticator = practice.prepare("SELECT secret_ciphertext,last_step FROM access_mfa WHERE user_id=?").get(f.ownerId)!;
      assert.equal(authenticator.secret_ciphertext, "synthetic-encrypted-authenticator-identity");
      assert.equal(authenticator.last_step, 999);
      assert.equal(db.prepare("SELECT count(*) n FROM sessions").get()!.n, 0);
      assert.equal(platform.store.registry.prepare("SELECT count(*) n FROM session_index").get()!.n, 0);
      assert.equal(platform.store.registry.prepare("SELECT count(*) n FROM public_links").get()!.n, 0);
      assert.equal(platform.store.registry.prepare("SELECT status FROM invitations WHERE id='synthetic-pending-invitation'").get()!.status, "Revoked");
    } finally { platform.store.close(); db.close(); }
  } finally { f.close(); }
});

test("fresh backup nonces produce distinct authenticated archives and never replace an existing output", async () => {
  const f = fixture();
  try {
    await createEncryptedBackup(f.options);
    const first = readFileSync(f.outputPath);
    const second = join(f.root, "second.cevrali-backup");
    await createEncryptedBackup({ ...f.options, outputPath: second });
    assert.notDeepEqual(first, readFileSync(second));
    const firstEnvelope = envelope(first), secondEnvelope = envelope(readFileSync(second));
    assert.equal(firstEnvelope.metadata.cipher, "aes-256-gcm");
    assert.equal(Buffer.from(firstEnvelope.metadata.nonce, "base64").length, 12);
    assert.notEqual(firstEnvelope.metadata.nonce, secondEnvelope.metadata.nonce);
    await assert.rejects(() => createEncryptedBackup(f.options));
    assert.deepEqual(readFileSync(f.outputPath), first);
    assert.equal((await verifyEncryptedBackup({ backupPath: second, keyFile: f.keyFile })).database_count, 3);
  } finally { f.close(); }
});

test("wrong encryption keys and damaged ciphertext fail before a restore destination is created", async () => {
  const f = fixture();
  try {
    await createEncryptedBackup(f.options);
    const wrongKey = join(f.root, "wrong.key");
    writeFileSync(wrongKey, randomBytes(32).toString("base64"), { mode: 0o600 });
    const wrongDestination = join(f.root, "wrong-restore");
    await assert.rejects(() => verifyEncryptedBackup({ backupPath: f.outputPath, keyFile: wrongKey }));
    await assert.rejects(() => restoreEncryptedBackup({ backupPath: f.outputPath, keyFile: wrongKey, destinationPath: wrongDestination }));
    assert.equal(existsSync(wrongDestination), false);
    const damaged = readFileSync(f.outputPath);
    damaged[Math.floor(damaged.length / 2)] ^= 0x80;
    const damagedPath = join(f.root, "damaged.cevrali-backup");
    writeFileSync(damagedPath, damaged, { mode: 0o600 });
    const damagedDestination = join(f.root, "damaged-restore");
    await assert.rejects(() => verifyEncryptedBackup({ backupPath: damagedPath, keyFile: f.keyFile }));
    await assert.rejects(() => restoreEncryptedBackup({ backupPath: damagedPath, keyFile: f.keyFile, destinationPath: damagedDestination }));
    assert.equal(existsSync(damagedDestination), false);
  } finally { f.close(); }
});

test("restore refuses an existing destination and preserves its original contents", async () => {
  const f = fixture();
  try {
    await createEncryptedBackup(f.options);
    const destinationPath = join(f.root, "existing");
    mkdirSync(destinationPath);
    const sentinel = join(destinationPath, "keep-original.txt");
    writeFileSync(sentinel, "Original synthetic data must remain unchanged.");
    await assert.rejects(() => restoreEncryptedBackup({ backupPath: f.outputPath, keyFile: f.keyFile, destinationPath }));
    assert.equal(readFileSync(sentinel, "utf8"), "Original synthetic data must remain unchanged.");
    assert.equal(existsSync(join(destinationPath, "cevrali.sqlite")), false);
  } finally { f.close(); }
});

test("authenticated manifests still reject traversal, duplicate paths, and mismatched database checksums", async () => {
  const f = fixture();
  try {
    await createEncryptedBackup(f.options);
    const original = readFileSync(f.outputPath);
    const mutations: [string, (manifest: any) => void][] = [
      ["traversal", manifest => { manifest.files[0].path = "accounts/../escaped.sqlite"; }],
      ["duplicate", manifest => { manifest.files[1].path = manifest.files[0].path; }],
      ["checksum", manifest => { manifest.files[0].sha256 = "0".repeat(64); }],
    ];
    for (const [name, mutate] of mutations) {
      const backupPath = join(f.root, `${name}.cevrali-backup`), destinationPath = join(f.root, `${name}-restore`);
      writeFileSync(backupPath, changedManifest(original, f.keyText, mutate), { mode: 0o600 });
      await assert.rejects(() => verifyEncryptedBackup({ backupPath, keyFile: f.keyFile }));
      await assert.rejects(() => restoreEncryptedBackup({ backupPath, keyFile: f.keyFile, destinationPath }));
      assert.equal(existsSync(destinationPath), false);
      assert.equal(existsSync(join(f.root, "escaped.sqlite")), false);
    }
  } finally { f.close(); }
});

test("backup and restore reject an active service lock without leaving an archive or restored tree", async () => {
  const f = fixture();
  try {
    const release = acquireServiceLock(f.databasePath, f.accountsPath);
    try {
      await assert.rejects(() => createEncryptedBackup(f.options));
      assert.equal(existsSync(f.outputPath), false);
      assert.throws(() => acquireServiceLock(f.databasePath, f.accountsPath));
    } finally { release(); }
    await createEncryptedBackup(f.options);
    const destinationPath = join(f.root, "restore-locked");
    const releaseTarget = acquireServiceLock(join(destinationPath, "cevrali.sqlite"), join(destinationPath, "accounts"));
    try {
      await assert.rejects(() => restoreEncryptedBackup({ backupPath: f.outputPath, keyFile: f.keyFile, destinationPath }));
      assert.equal(existsSync(join(destinationPath, "cevrali.sqlite")), false);
    } finally { releaseTarget(); }
  } finally { f.close(); }
});

test("backup rejects symlink aliases for source databases and encryption keys", async () => {
  const f = fixture();
  try {
    const linkedDatabase = join(f.root, "linked.sqlite");
    symlinkSync(f.databasePath, linkedDatabase);
    await assert.rejects(() => createEncryptedBackup({ ...f.options, databasePath: linkedDatabase }));
    const linkedKey = join(f.root, "linked.key");
    symlinkSync(f.keyFile, linkedKey);
    await assert.rejects(() => createEncryptedBackup({ ...f.options, keyFile: linkedKey }));
    assert.equal(existsSync(f.outputPath), false);
    assert.equal(existsSync(f.databasePath), true);
  } finally { f.close(); }
});

test("a sibling restore guard prevents service startup and a competing restore before any target is created", async () => {
  const f = fixture();
  try {
    await createEncryptedBackup(f.options);
    const destinationPath = join(f.root, "active-recovery"), guard = `${destinationPath}.restore.lock`;
    const content = JSON.stringify({ pid: process.pid, nonce: "synthetic-existing-recovery-lock" });
    writeFileSync(guard, content, { mode: 0o600 });
    assert.throws(() => acquireServiceLock(join(destinationPath, "cevrali.sqlite"), join(destinationPath, "accounts")));
    await assert.rejects(() => restoreEncryptedBackup({ backupPath: f.outputPath, keyFile: f.keyFile, destinationPath }));
    assert.equal(existsSync(destinationPath), false);
    assert.equal(readFileSync(guard, "utf8"), content);
  } finally { f.close(); }
});

test("corrupt SQLite sources are rejected and release the deployment lock for a later retry", async () => {
  const f = fixture();
  try {
    const invalid = join(f.root, "invalid.sqlite");
    writeFileSync(invalid, "Not a SQLite database.", { mode: 0o600 });
    await assert.rejects(() => createEncryptedBackup({ ...f.options, databasePath: invalid }));
    assert.equal(existsSync(f.outputPath), false);
    const release = acquireServiceLock(invalid, f.accountsPath);
    release();
    await createEncryptedBackup(f.options);
    assert.equal((await verifyEncryptedBackup({ backupPath: f.outputPath, keyFile: f.keyFile })).database_count, 3);
  } finally { f.close(); }
});

test("invalid or missing key material fails without producing an output", async () => {
  const f = fixture();
  try {
    await assert.rejects(() => createEncryptedBackup({ ...f.options, keyFile: join(f.root, "missing.key") }));
    const malformed = join(f.root, "malformed.key");
    writeFileSync(malformed, "This is not a 32-byte encryption key.", { mode: 0o600 });
    await assert.rejects(() => createEncryptedBackup({ ...f.options, keyFile: malformed }));
    chmodSync(f.keyFile, 0o644);
    await assert.rejects(() => createEncryptedBackup(f.options));
    assert.equal(existsSync(f.outputPath), false);
  } finally { f.close(); }
});

test("unsupported account files and incomplete practice registries cannot produce a partial backup", async () => {
  const f = fixture();
  try {
    const extra = join(f.accountsPath, "chart-attachment.pdf");
    writeFileSync(extra, "Synthetic attachment outside the supported SQLite layout.");
    await assert.rejects(() => createEncryptedBackup(f.options));
    assert.equal(existsSync(f.outputPath), false);
    assert.equal(existsSync(extra), true);
    rmSync(extra);
    rmSync(join(f.accountsPath, `${f.practiceId}.sqlite`));
    await assert.rejects(() => createEncryptedBackup(f.options));
    assert.equal(existsSync(f.outputPath), false);
    const release = acquireServiceLock(f.databasePath, f.accountsPath);
    release();
  } finally { f.close(); }
});
