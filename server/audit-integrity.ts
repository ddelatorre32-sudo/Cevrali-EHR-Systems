import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

type AuditRow = { id: number; user_id: string; action: string; resource: string; created_at: string };
type ChainRow = { sequence: number; audit_id: number; previous_mac: string; mac: string };
type State = { schema: number; chain_id: string; key_verifier: string; records: number; head: string };
export type AuditAnchor = { schema: 1; chain_id: string; records: number; head: string };
export type AuditIntegrityReport = { ok: boolean; records: number; anchor?: AuditAnchor; issues: string[] };

const stateName = 'audit_integrity_state';
const chainName = 'audit_integrity';
const hex = /^[a-f0-9]{64}$/;
const triggers: Record<string, string> = {
  cevrali_audit_append: `CREATE TRIGGER cevrali_audit_append AFTER INSERT ON audit BEGIN
    SELECT CASE WHEN NEW.id <= coalesce((SELECT max(audit_id) FROM audit_integrity), 0)
      THEN RAISE(ABORT, 'Audit identifiers must increase') END;
    INSERT INTO audit_integrity(sequence,audit_id,previous_mac,mac)
      SELECT records+1,NEW.id,head,
        cevrali_audit_sign(chain_id,records+1,head,NEW.id,NEW.user_id,NEW.action,NEW.resource,NEW.created_at)
      FROM audit_integrity_state WHERE singleton=1;
    SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'Audit integrity state is unavailable') END;
    UPDATE audit_integrity_state SET records=records+1,
      head=(SELECT mac FROM audit_integrity WHERE audit_id=NEW.id) WHERE singleton=1;
  END`,
  cevrali_audit_no_update: `CREATE TRIGGER cevrali_audit_no_update BEFORE UPDATE ON audit BEGIN
    SELECT RAISE(ABORT, 'Audit records are append only'); END`,
  cevrali_audit_no_delete: `CREATE TRIGGER cevrali_audit_no_delete BEFORE DELETE ON audit BEGIN
    SELECT RAISE(ABORT, 'Audit records are append only'); END`,
  cevrali_audit_chain_no_update: `CREATE TRIGGER cevrali_audit_chain_no_update BEFORE UPDATE ON audit_integrity BEGIN
    SELECT RAISE(ABORT, 'Audit signatures are append only'); END`,
  cevrali_audit_chain_no_delete: `CREATE TRIGGER cevrali_audit_chain_no_delete BEFORE DELETE ON audit_integrity BEGIN
    SELECT RAISE(ABORT, 'Audit signatures are append only'); END`,
  cevrali_audit_state_no_delete: `CREATE TRIGGER cevrali_audit_state_no_delete BEFORE DELETE ON audit_integrity_state BEGIN
    SELECT RAISE(ABORT, 'Audit state cannot be deleted'); END`,
  cevrali_audit_state_advance: `CREATE TRIGGER cevrali_audit_state_advance BEFORE UPDATE ON audit_integrity_state BEGIN
    SELECT CASE WHEN NEW.singleton != OLD.singleton OR NEW.schema != OLD.schema OR NEW.chain_id != OLD.chain_id
      OR NEW.key_verifier != OLD.key_verifier OR NEW.records != OLD.records+1
      OR NEW.head IS NOT (SELECT mac FROM audit_integrity WHERE sequence=NEW.records)
      THEN RAISE(ABORT, 'Audit state can only advance with a signed record') END; END`,
};

function fail(): never {
  throw Object.assign(new Error('Audit integrity verification failed. Keep the service offline and investigate the database.'), { status: 503 });
}
function keyMaterial(key: Uint8Array) {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) fail();
  return Buffer.from(hkdfSync('sha256', key, Buffer.from('cevrali-audit-integrity:v1'), Buffer.from('audit-record-signing'), 32));
}
function signature(key: Uint8Array, value: unknown[]) {
  return createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
}
function genesis(key: Uint8Array, chainId: string) { return signature(key, ['cevrali-audit-genesis', 1, chainId]); }
function verifier(key: Uint8Array, chainId: string) { return signature(key, ['cevrali-audit-key-verifier', 1, chainId]); }
function recordSignature(key: Uint8Array, chainId: string, sequence: number, previous: string, row: AuditRow) {
  return signature(key, ['cevrali-audit-record', 1, chainId, sequence, previous,
    row.id, row.user_id, row.action, row.resource, row.created_at]);
}
function matches(a: unknown, b: unknown) {
  return typeof a === 'string' && typeof b === 'string' && hex.test(a) && hex.test(b) &&
    timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function normalizedSql(sql: string) { return sql.trim().replace(/;$/, '').replace(/\s+/g, ' '); }
function tables(db: DatabaseSync) {
  return new Set((db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as { name: string }[]).map(row => row.name));
}
function validAudit(row: AuditRow) {
  return Number.isSafeInteger(row.id) && row.id > 0 && [row.user_id, row.action, row.resource, row.created_at].every(value => typeof value === 'string');
}

/**
 * Checks local signatures without returning audit contents. Keep an independently stored
 * anchor to detect replacement with an older, otherwise valid database. A local chain
 * alone cannot prove that the entire database and its state were never rolled back.
 */
export function verifyAuditIntegrity(db: DatabaseSync, key: Uint8Array, expectedAnchor?: AuditAnchor): AuditIntegrityReport {
  let records = 0;
  try {
    const material = keyMaterial(key), present = tables(db);
    if (!present.has(stateName) || !present.has(chainName)) return { ok: false, records, issues: ['Audit integrity metadata is missing.'] };
    const states = db.prepare('SELECT schema,chain_id,key_verifier,records,head FROM audit_integrity_state').all() as State[];
    if (states.length !== 1) return { ok: false, records, issues: ['Audit integrity state is invalid.'] };
    const state = states[0];
    if (state.schema !== 1 || !/^[a-f0-9]{32}$/.test(state.chain_id) || !Number.isSafeInteger(state.records) || state.records < 0 ||
      !matches(state.key_verifier, verifier(material, state.chain_id)))
      return { ok: false, records, issues: ['Audit integrity key or state does not match.'] };
    const actualTriggers = new Map((db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all() as { name: string; sql: string }[]).map(row => [row.name, row.sql]));
    if (Object.entries(triggers).some(([name, sql]) => normalizedSql(actualTriggers.get(name) || '') !== normalizedSql(sql)))
      return { ok: false, records, issues: ['Audit integrity guards are missing or changed.'] };
    const audit = db.prepare('SELECT id,user_id,action,resource,created_at FROM audit ORDER BY id').all() as AuditRow[];
    const chain = db.prepare('SELECT sequence,audit_id,previous_mac,mac FROM audit_integrity ORDER BY sequence').all() as ChainRow[];
    if (audit.length !== chain.length || chain.length !== state.records)
      return { ok: false, records: audit.length, issues: ['Audit records and signatures have different lengths.'] };
    let previous = genesis(material, state.chain_id), lastId = 0;
    const heads = [previous];
    for (let index = 0; index < audit.length; index++) {
      const row = audit[index], link = chain[index], sequence = index + 1;
      if (!validAudit(row) || row.id <= lastId || link.sequence !== sequence || link.audit_id !== row.id ||
        !matches(link.previous_mac, previous) || !matches(link.mac, recordSignature(material, state.chain_id, sequence, previous, row)))
        return { ok: false, records, issues: ['Audit signature or order does not match.'] };
      records++; lastId = row.id; previous = link.mac; heads.push(previous);
    }
    if (!matches(previous, state.head)) return { ok: false, records, issues: ['Audit head does not match.'] };
    if (expectedAnchor && (expectedAnchor.schema !== 1 || expectedAnchor.chain_id !== state.chain_id ||
      !Number.isSafeInteger(expectedAnchor.records) || expectedAnchor.records < 0 || expectedAnchor.records > records ||
      !matches(expectedAnchor.head, heads[expectedAnchor.records])))
      return { ok: false, records, issues: ['Audit chain does not include the independently stored anchor.'] };
    return { ok: true, records, anchor: { schema: 1, chain_id: state.chain_id, records, head: previous }, issues: [] };
  } catch { return { ok: false, records, issues: ['Audit integrity could not be verified.'] }; }
}

/**
 * Initialize before any protected audit writers. A nonempty unsigned log requires an
 * explicit, operator-reviewed migration; normal startup must never re-sign a log whose
 * integrity metadata could have been removed. Empty/full snapshot replacement still
 * requires an independently retained anchor to detect.
 */
export function initializeAuditIntegrity(db: DatabaseSync, key: Uint8Array, options: { allowLegacyBaseline?: boolean } = {}) {
  const material = keyMaterial(key), present = tables(db);
  if (!present.has('audit') || present.has(stateName) !== present.has(chainName)) fail();
  if (!present.has(stateName) && options.allowLegacyBaseline !== true && db.prepare('SELECT 1 FROM audit LIMIT 1').get()) fail();
  if (present.has(stateName) && !verifyAuditIntegrity(db, key).ok) fail();
  db.function('cevrali_audit_sign', { deterministic: true, varargs: true }, (...args: SQLOutputValue[]) => {
    if (args.length !== 8) fail();
    const [chainId, sequence, previous, id, userId, action, resource, createdAt] = args;
    const row = { id: Number(id), user_id: userId, action, resource, created_at: createdAt } as AuditRow;
    if (typeof chainId !== 'string' || !/^[a-f0-9]{32}$/.test(chainId) || !Number.isSafeInteger(sequence) ||
      Number(sequence) < 1 || typeof previous !== 'string' || !hex.test(previous) || !validAudit(row)) fail();
    return recordSignature(material, chainId, Number(sequence), previous, row);
  });
  if (present.has(stateName)) return verifyAuditIntegrity(db, key);
  db.exec('SAVEPOINT audit_integrity_initialize');
  try {
    db.exec(`CREATE TABLE audit_integrity_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema INTEGER NOT NULL CHECK(schema=1),
      chain_id TEXT NOT NULL, key_verifier TEXT NOT NULL, records INTEGER NOT NULL CHECK(records>=0), head TEXT NOT NULL);
      CREATE TABLE audit_integrity (
        sequence INTEGER NOT NULL UNIQUE CHECK(sequence>0), audit_id INTEGER PRIMARY KEY REFERENCES audit(id),
        previous_mac TEXT NOT NULL, mac TEXT NOT NULL);`);
    const chainId = randomBytes(16).toString('hex');
    let previous = genesis(material, chainId), records = 0;
    const insert = db.prepare('INSERT INTO audit_integrity(sequence,audit_id,previous_mac,mac) VALUES(?,?,?,?)');
    for (const row of db.prepare('SELECT id,user_id,action,resource,created_at FROM audit ORDER BY id').all() as AuditRow[]) {
      if (!validAudit(row)) fail();
      const mac = recordSignature(material, chainId, ++records, previous, row);
      insert.run(records, row.id, previous, mac); previous = mac;
    }
    db.prepare('INSERT INTO audit_integrity_state VALUES(1,1,?,?,?,?)').run(chainId, verifier(material, chainId), records, previous);
    for (const sql of Object.values(triggers)) db.exec(sql);
    db.exec('RELEASE audit_integrity_initialize');
  } catch (error) {
    db.exec('ROLLBACK TO audit_integrity_initialize; RELEASE audit_integrity_initialize');
    throw error;
  }
  return verifyAuditIntegrity(db, key);
}
