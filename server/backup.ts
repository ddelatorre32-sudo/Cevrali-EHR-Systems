import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  appendFileSync, chmodSync, closeSync, constants, copyFileSync, createReadStream, createWriteStream, existsSync,
  fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const format = "cevrali-encrypted-backup-v1" as const;
const magic = Buffer.from("CEVRALI-ENCRYPTED-BACKUP/1\n");
const maxManifestBytes = 1024 * 1024;
const maxArchiveBytes = 128 * 1024 ** 3;
const safeDatabaseName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}\.sqlite$/;
type ArchiveFile = { path: string; size: number; sha256: string };
type Manifest = { format: typeof format; created_at: string; files: ArchiveFile[] };
export type BackupSummary = {
  format: typeof format; created_at: string; database_count: number;
  archive_sha256: string; encrypted: true;
};
type BackupInput = { databasePath: string; accountsPath: string; outputPath: string; keyFile: string };
type ReadInput = { backupPath: string; keyFile: string };

function fail(message: string): never { throw Object.assign(new Error(message), { code: "CEVRALI_BACKUP_ERROR" }); }
function rejectSymlinks(path: string, allowMissing = false) {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    try { if (lstatSync(current).isSymbolicLink()) fail("Symbolic links are not allowed in backup, key, or restore paths"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return;
      throw error;
    }
  }
}
function regularFile(path: string) {
  rejectSymlinks(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1) fail("Backup inputs must be regular, non-linked files");
  return stat;
}
function readKey(path: string): Buffer {
  const stat = regularFile(path);
  if ((stat.mode & 0o077) !== 0) fail("Backup key permissions must prevent access by other users (chmod 600)");
  if (stat.size > 128) fail("Backup key file must contain a base64-encoded 32-byte key");
  const encoded = readFileSync(path, "utf8").trim(), key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded || new Set(key).size < 8)
    fail("Backup key file must contain 32 random bytes encoded as base64");
  return key;
}
function privateStage(parent = tmpdir()) {
  rejectSymlinks(parent);
  const path = mkdtempSync(join(parent, ".cevrali-backup-"));
  chmodSync(path, 0o700);
  return path;
}

/** The service and offline backup commands must use the same canonical paths.
 * Stale locks fail closed; operators verify the service has stopped before
 * removing a lock left behind after a crash. This does not use PID guessing. */
function acquireLocks(paths: string[]): () => void {
  const nonce = randomBytes(24).toString("hex"), acquired: string[] = [];
  const release = () => {
    for (const path of acquired.reverse()) {
      try {
        const saved = JSON.parse(readFileSync(path, "utf8"));
        if (saved.nonce === nonce) rmSync(path);
      } catch { /* Never remove a lock that no longer belongs to this process. */ }
    }
  };
  try {
    for (const path of paths) {
      rejectSymlinks(path, true);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), nonce })); fsyncSync(fd); }
      finally { closeSync(fd); }
      acquired.push(path);
    }
  } catch (error) {
    release();
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      fail("The application or another backup operation holds the service lock. Stop the service before backing up or restoring.");
    throw error;
  }
  let released = false;
  return () => { if (!released) { released = true; release(); } };
}
export function acquireServiceLock(databasePath: string, accountsPath: string): () => void {
  const paths = [...new Set([`${resolve(databasePath)}.service.lock`, `${resolve(accountsPath)}.service.lock`])].sort();
  const guards = [...new Set([dirname(resolve(databasePath)), dirname(resolve(accountsPath))])].map(path => `${path}.restore.lock`);
  const checkRestoring = () => { if (guards.some(path => existsSync(path))) fail("A restore operation holds the service lock. Wait for recovery to finish before starting the application."); };
  checkRestoring();
  const release = acquireLocks(paths);
  try { checkRestoring(); return release; } catch (error) { release(); throw error; }
}
function validateDatabase(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const check = db.prepare("PRAGMA quick_check").all();
    if (check.length !== 1 || Object.values(check[0])[0] !== "ok" || db.prepare("PRAGMA foreign_key_check").all().length)
      fail("A database failed integrity checks; the backup or restore was stopped");
  } finally { db.close(); }
}
function validateLayout(stage: string) {
  const registry = new DatabaseSync(join(stage, "accounts", "accounts.sqlite"), { readOnly: true });
  const opened = new Map<string, DatabaseSync>();
  try {
    const practices = registry.prepare("SELECT id FROM practices").all() as { id: string }[];
    for (const practice of practices) {
      if (practice.id !== "demo-practice" && !/^practice-[a-f0-9-]{36}$/.test(practice.id))
        fail("The accounts registry contains an invalid practice identifier");
      const path = practice.id === "demo-practice" ? join(stage, "cevrali.sqlite") : join(stage, "accounts", `${practice.id}.sqlite`);
      if (!existsSync(path)) fail("The accounts registry references a missing practice database");
      opened.set(practice.id, new DatabaseSync(path, { readOnly: true }));
    }
    const memberships = registry.prepare("SELECT practice_id,user_id FROM memberships").all() as { practice_id: string; user_id: string }[];
    for (const member of memberships) {
      const practice = opened.get(member.practice_id);
      if (!practice || !practice.prepare("SELECT id FROM users WHERE id=?").get(member.user_id))
        fail("The accounts registry references missing practice membership data");
    }
  } finally { for (const db of opened.values()) db.close(); registry.close(); }
}
async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function syncFile(path: string) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function sources(databasePath: string, accountsPath: string) {
  regularFile(databasePath); rejectSymlinks(accountsPath);
  if (!statSync(accountsPath).isDirectory()) fail("The accounts path must be a directory");
  const rows = [{ source: resolve(databasePath), path: "cevrali.sqlite" }];
  for (const entry of readdirSync(accountsPath, { withFileTypes: true })) {
    const source = join(accountsPath, entry.name);
    regularFile(source);
    if (safeDatabaseName.test(entry.name)) rows.push({ source, path: `accounts/${entry.name}` });
    else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,190}\.sqlite-(wal|shm)$/.test(entry.name))
      fail("The accounts directory contains an unsupported file. Back it up separately before proceeding.");
  }
  if (!rows.some(row => row.path === "accounts/accounts.sqlite")) fail("The accounts registry is missing");
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
async function* archiveContent(manifest: Manifest, stage: string) {
  const encoded = Buffer.from(JSON.stringify(manifest)), length = Buffer.alloc(4);
  length.writeUInt32BE(encoded.length);
  yield length; yield encoded;
  for (const file of manifest.files) for await (const chunk of createReadStream(join(stage, file.path))) yield chunk;
}

export async function createEncryptedBackup(input: BackupInput): Promise<BackupSummary> {
  const databasePath = resolve(input.databasePath), accountsPath = resolve(input.accountsPath), output = resolve(input.outputPath);
  rejectSymlinks(output, true); rejectSymlinks(dirname(output));
  if (existsSync(output)) fail("The backup output already exists; backups are never overwritten");
  if (output === databasePath || output.startsWith(`${accountsPath}/`)) fail("Store encrypted backups outside the live database and accounts directory");
  const key = readKey(input.keyFile);
  let release: (() => void) | undefined, stage: string | undefined, wroteOutput = false;
  try {
    release = acquireServiceLock(databasePath, accountsPath);
    const inputFiles = sources(databasePath, accountsPath);
    stage = privateStage(); mkdirSync(join(stage, "accounts"), { mode: 0o700 });
    const files: ArchiveFile[] = [];
    for (const row of inputFiles) {
      const target = join(stage, row.path), db = new DatabaseSync(row.source, { readOnly: true });
      try { await sqliteBackup(db, target); } finally { db.close(); }
      chmodSync(target, 0o600); validateDatabase(target);
      files.push({ path: row.path, size: statSync(target).size, sha256: await hashFile(target) });
    }
    validateLayout(stage);
    if (files.length > 10000 || files.reduce((sum, file) => sum + file.size, 0) > maxArchiveBytes)
      fail("This deployment exceeds the supported backup size");
    const manifest: Manifest = { format, created_at: new Date().toISOString(), files };
    const manifestBytes = Buffer.byteLength(JSON.stringify(manifest));
    if (manifestBytes > maxManifestBytes) fail("The backup manifest exceeds the supported size");
    const nonce = randomBytes(12), header = Buffer.concat([magic,
      Buffer.from(JSON.stringify({ cipher: "aes-256-gcm", nonce: nonce.toString("base64") }) + "\n")]);
    const cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(header);
    const fd = openSync(output, "wx", 0o600);
    try { writeFileSync(fd, header); wroteOutput = true; } finally { closeSync(fd); }
    await pipeline(Readable.from(archiveContent(manifest, stage)), cipher, createWriteStream(output, { flags: "a", mode: 0o600 }));
    appendFileSync(output, cipher.getAuthTag()); syncFile(output);
    return { format, created_at: manifest.created_at, database_count: files.length,
      archive_sha256: await hashFile(output), encrypted: true };
  } catch (error) {
    if (wroteOutput) rmSync(output, { force: true });
    throw error;
  } finally {
    key.fill(0);
    try { if (stage) rmSync(stage, { recursive: true, force: true }); }
    finally { release?.(); }
  }
}
function manifestOf(raw: Buffer): Manifest {
  let value: unknown;
  try { value = JSON.parse(raw.toString("utf8")); } catch { fail("Backup manifest is invalid"); }
  const candidate = value as Manifest;
  if (!candidate || candidate.format !== format || typeof candidate.created_at !== "string" ||
    !Number.isFinite(Date.parse(candidate.created_at)) || !Array.isArray(candidate.files) || !candidate.files.length || candidate.files.length > 10000)
    fail("Backup manifest is invalid");
  const seen = new Set<string>(); let total = 0;
  for (const file of candidate.files) {
    if (!file || typeof file.path !== "string" || (file.path !== "cevrali.sqlite" &&
      !(file.path.startsWith("accounts/") && safeDatabaseName.test(file.path.slice("accounts/".length)) && file.path.split("/").length === 2)) ||
      isAbsolute(file.path) || file.path.includes("\\") || file.path.split("/").some(part => part === "." || part === "..") || seen.has(file.path) ||
      !Number.isSafeInteger(file.size) || file.size < 512 || file.size > maxArchiveBytes || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256))
      fail("Backup manifest contains an invalid database entry");
    seen.add(file.path); total += file.size;
  }
  if (!seen.has("cevrali.sqlite") || !seen.has("accounts/accounts.sqlite") || total > maxArchiveBytes)
    fail("Backup manifest is incomplete or exceeds the supported size");
  return candidate;
}
function headerOf(path: string) {
  const stat = regularFile(path);
  if (stat.size < magic.length + 32 || stat.size > maxArchiveBytes + 2 * maxManifestBytes) fail("Backup archive size is invalid");
  const fd = openSync(path, "r"), prefix = Buffer.alloc(Math.min(4096, stat.size));
  try { readSync(fd, prefix, 0, prefix.length, 0); } finally { closeSync(fd); }
  if (!prefix.subarray(0, magic.length).equals(magic)) fail("Backup archive format is invalid");
  const end = prefix.indexOf(10, magic.length);
  if (end < 0 || end + 17 >= stat.size) fail("Backup archive header is invalid");
  let parsed: { cipher?: string; nonce?: string };
  try { parsed = JSON.parse(prefix.subarray(magic.length, end).toString("utf8")); }
  catch { fail("Backup archive header is invalid"); }
  const nonce = Buffer.from(parsed.nonce || "", "base64");
  if (parsed.cipher !== "aes-256-gcm" || nonce.length !== 12 || nonce.toString("base64") !== parsed.nonce || Object.keys(parsed).length !== 2)
    fail("Backup archive header is invalid");
  const tag = Buffer.alloc(16), tagFd = openSync(path, "r");
  try { readSync(tagFd, tag, 0, 16, stat.size - 16); } finally { closeSync(tagFd); }
  return { size: stat.size, header: prefix.subarray(0, end + 1), nonce, tag };
}
async function authenticatedStage(input: ReadInput) {
  const source = resolve(input.backupPath), metadata = headerOf(source), key = readKey(input.keyFile);
  let stage: string | undefined;
  try {
    stage = privateStage();
    const payload = join(stage, "payload");
    const decipher = createDecipheriv("aes-256-gcm", key, metadata.nonce);
    decipher.setAAD(metadata.header); decipher.setAuthTag(metadata.tag);
    try {
      await pipeline(createReadStream(source, { start: metadata.header.length, end: metadata.size - 17 }), decipher,
        createWriteStream(payload, { flags: "wx", mode: 0o600 }));
    } catch { fail("Backup authentication failed; the key or archive is invalid"); }
    const fd = openSync(payload, "r"), length = Buffer.alloc(4);
    let manifest: Manifest;
    try {
      if (readSync(fd, length, 0, 4, 0) !== 4 || length.readUInt32BE() > maxManifestBytes) fail("Backup manifest length is invalid");
      const raw = Buffer.alloc(length.readUInt32BE());
      if (readSync(fd, raw, 0, raw.length, 4) !== raw.length) fail("Backup manifest is incomplete");
      manifest = manifestOf(raw);
      if (4 + raw.length + manifest.files.reduce((sum, file) => sum + file.size, 0) !== fstatSync(fd).size)
        fail("Backup archive length does not match its manifest");
      let offset = 4 + raw.length;
      mkdirSync(join(stage, "databases"), { mode: 0o700 });
      mkdirSync(join(stage, "databases", "accounts"), { mode: 0o700 });
      for (const file of manifest.files) {
        const target = join(stage, "databases", file.path);
        await pipeline(createReadStream(payload, { start: offset, end: offset + file.size - 1 }), createWriteStream(target, { flags: "wx", mode: 0o600 }));
        if (await hashFile(target) !== file.sha256) fail("A database checksum does not match the authenticated manifest");
        validateDatabase(target); offset += file.size;
      }
      validateLayout(join(stage, "databases"));
    } finally { closeSync(fd); }
    rmSync(payload);
    return { stage, manifest, archive_sha256: await hashFile(source) };
  } catch (error) { if (stage) rmSync(stage, { recursive: true, force: true }); throw error; }
  finally { key.fill(0); }
}
export async function verifyEncryptedBackup(input: ReadInput): Promise<BackupSummary> {
  const result = await authenticatedStage(input);
  try { return { format, created_at: result.manifest.created_at, database_count: result.manifest.files.length,
    archive_sha256: result.archive_sha256, encrypted: true }; }
  finally { rmSync(result.stage, { recursive: true, force: true }); }
}
function revokeTransientAccess(path: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec("BEGIN IMMEDIATE");
    const tables = new Set((db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as { name: string }[]).map(row => row.name));
    for (const table of ["mfa_sessions", "sessions", "session_index", "public_links", "access_challenges", "access_recovery_codes", "auth_challenges", "mfa_challenges", "password_reset_tokens"])
      if (tables.has(table)) db.exec(`DELETE FROM "${table}"`);
    // Historical archives must not revive invitations or single-use recovery
    // codes that may already have been consumed after the snapshot was taken.
    if (tables.has("invitations")) db.exec("UPDATE invitations SET status='Revoked' WHERE status='Pending'");
    if (tables.has("workflow_state")) {
      const rows = db.prepare("SELECT id,document FROM workflow_state").all() as { id: number; document: string }[];
      for (const row of rows) {
        const state = JSON.parse(row.document);
        if (state.prescribing) state.prescribing.challenges = [];
        // Reissue expiring patient links after recovery rather than restoring old access.
        for (const intake of state.intakes || []) {
          intake.token_hash = randomBytes(32).toString("hex");
          intake.expires_at = "1970-01-01T00:00:00.000Z";
        }
        db.prepare("UPDATE workflow_state SET document=? WHERE id=?").run(JSON.stringify(state), row.id);
      }
    }
    db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  finally { db.close(); }
}
export async function restoreEncryptedBackup(input: ReadInput & { destinationPath: string }) {
  const destination = resolve(input.destinationPath);
  rejectSymlinks(destination, true); rejectSymlinks(dirname(destination));
  if (existsSync(destination)) fail("Restore destination must not exist; existing patient data is never overwritten");
  const release = acquireLocks([`${destination}.restore.lock`]);
  let result: Awaited<ReturnType<typeof authenticatedStage>> | undefined, staging: string | undefined;
  try {
    if (existsSync(destination)) fail("Restore destination must not exist; existing patient data is never overwritten");
    result = await authenticatedStage(input);
    staging = privateStage(dirname(destination));
    mkdirSync(join(staging, "accounts"), { mode: 0o700 });
    for (const file of result.manifest.files) {
      const target = join(staging, file.path);
      copyFileSync(join(result.stage, "databases", file.path), target, constants.COPYFILE_EXCL);
      chmodSync(target, 0o600);
      revokeTransientAccess(target); validateDatabase(target); syncFile(target);
    }
    // The service checks the sibling restore guard before opening databases.
    // Publish every validated database together while that guard is held.
    if (existsSync(destination)) fail("Restore destination changed while recovery was running");
    renameSync(staging, destination); staging = undefined;
    return { destination_path: destination, database_path: join(destination, "cevrali.sqlite"),
      accounts_path: join(destination, "accounts"), database_count: result.manifest.files.length, sessions_revoked: true as const };
  } finally {
    release(); if (result) rmSync(result.stage, { recursive: true, force: true });
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}
