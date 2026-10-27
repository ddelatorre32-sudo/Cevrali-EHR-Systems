import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase } from '../server/database.js';
import { initializeAuditIntegrity, verifyAuditIntegrity } from '../server/audit-integrity.js';

const key = Buffer.alloc(32, 19);
const differentKey = Buffer.alloc(32, 20);
function fixture() {
  const db = createDatabase(':memory:');
  const append = (action = 'Reviewed a synthetic record') => db.prepare('INSERT INTO audit(user_id,action,resource) VALUES(?,?,?)')
    .run('usr-clinician', action, 'patient:synthetic');
  return { db, append };
}

test('explicit legacy migration backfills audit and signs new records from ordinary writers', () => {
  const f = fixture();
  try {
    f.append('Before migration');
    const before = Number(f.db.prepare('SELECT count(*) n FROM audit').get()!.n);
    assert.throws(() => initializeAuditIntegrity(f.db, key), /Audit integrity verification failed/);
    assert.equal(initializeAuditIntegrity(f.db, key, { allowLegacyBaseline: true }).ok, true);
    const first = verifyAuditIntegrity(f.db, key);
    assert.equal(first.records, before);
    f.append(); f.append('Prescribed a synthetic medication');
    const after = verifyAuditIntegrity(f.db, key, first.anchor);
    assert.equal(after.ok, true);
    assert.equal(after.records, before + 2);
    assert.notEqual(after.anchor!.head, first.anchor!.head);
    assert.equal(JSON.stringify(after).includes('synthetic'), false);
    assert.equal(initializeAuditIntegrity(f.db, key).ok, true);
  } finally { f.db.close(); }
});

test('normal startup refuses a nonempty edited audit after both integrity tables and guards are removed', () => {
  const f = fixture();
  try {
    initializeAuditIntegrity(f.db, key); f.append('Original action');
    for (const row of f.db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'cevrali_audit_%'").all() as { name: string }[])
      f.db.exec(`DROP TRIGGER "${row.name}"`);
    f.db.exec('DROP TABLE audit_integrity; DROP TABLE audit_integrity_state');
    f.db.exec("UPDATE audit SET action='Altered offline'");
    const before = JSON.stringify(f.db.prepare('SELECT * FROM sqlite_schema ORDER BY type,name').all());
    assert.throws(() => initializeAuditIntegrity(f.db, key), /Audit integrity verification failed/);
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM sqlite_schema ORDER BY type,name').all()), before);
    assert.equal(f.db.prepare("SELECT count(*) count FROM sqlite_schema WHERE name IN ('audit_integrity','audit_integrity_state')").get()!.count, 0);
    assert.equal(f.db.prepare('SELECT action FROM audit').get()!.action, 'Altered offline');
    assert.equal(verifyAuditIntegrity(f.db, key).ok, false);
  } finally { f.db.close(); }
});

test('ordinary audit and signature updates/deletes are rejected', () => {
  const f = fixture();
  try {
    initializeAuditIntegrity(f.db, key); f.append();
    for (const sql of ["UPDATE audit SET action='Changed'", 'DELETE FROM audit',
      "UPDATE audit_integrity SET mac='Changed'", 'DELETE FROM audit_integrity',
      'DELETE FROM audit_integrity_state', 'UPDATE audit_integrity_state SET records=0'])
      assert.throws(() => f.db.exec(sql), /Audit/);
    assert.equal(verifyAuditIntegrity(f.db, key).ok, true);
  } finally { f.db.close(); }
});

test('signatures distinguish field boundaries and detect changed audit values', () => {
  const f = fixture();
  try {
    initializeAuditIntegrity(f.db, key); f.append('a|b');
    // Simulate an offline attacker bypassing ordinary SQL guards.
    const guard = String(f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='cevrali_audit_no_update'").get()!.sql);
    f.db.exec('DROP TRIGGER cevrali_audit_no_update');
    f.db.exec("UPDATE audit SET action='a',resource='b|patient:synthetic'");
    f.db.exec(guard);
    assert.deepEqual(verifyAuditIntegrity(f.db, key).issues, ['Audit signature or order does not match.']);
    assert.throws(() => initializeAuditIntegrity(f.db, key), /Audit integrity verification failed/);
  } finally { f.db.close(); }
});

test('audit guard changes fail verification even before records are altered', () => {
  const f = fixture();
  try {
    initializeAuditIntegrity(f.db, key);
    f.db.exec('DROP TRIGGER cevrali_audit_no_delete');
    assert.equal(verifyAuditIntegrity(f.db, key).ok, false);
    assert.throws(() => initializeAuditIntegrity(f.db, key), /Audit integrity verification failed/);
  } finally { f.db.close(); }
});

test('wrong keys and missing links fail closed without reinitializing state', () => {
  const f = fixture();
  try {
    initializeAuditIntegrity(f.db, key); f.append(); f.append();
    const before = JSON.stringify(f.db.prepare('SELECT * FROM audit_integrity_state').get());
    assert.equal(verifyAuditIntegrity(f.db, differentKey).ok, false);
    assert.throws(() => initializeAuditIntegrity(f.db, differentKey), /Audit integrity verification failed/);
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM audit_integrity_state').get()), before);
    const guard = String(f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='cevrali_audit_chain_no_delete'").get()!.sql);
    f.db.exec('DROP TRIGGER cevrali_audit_chain_no_delete; DELETE FROM audit_integrity WHERE sequence=1');
    f.db.exec(guard);
    assert.deepEqual(verifyAuditIntegrity(f.db, key).issues, ['Audit records and signatures have different lengths.']);
  } finally { f.db.close(); }
});

test('explicit non-increasing identifiers cannot be appended', () => {
  const f = fixture();
  try {
    initializeAuditIntegrity(f.db, key);
    f.db.prepare('INSERT INTO audit(id,user_id,action,resource) VALUES(?,?,?,?)').run(10000, 'usr-clinician', 'A', 'B');
    assert.throws(() => f.db.prepare('INSERT INTO audit(id,user_id,action,resource) VALUES(?,?,?,?)')
      .run(9999, 'usr-clinician', 'A', 'B'), /Audit identifiers must increase/);
    assert.equal(verifyAuditIntegrity(f.db, key).ok, true);
  } finally { f.db.close(); }
});

test('transaction rollback also rolls back its signatures and head', () => {
  const f = fixture();
  try {
    initializeAuditIntegrity(f.db, key);
    const before = verifyAuditIntegrity(f.db, key);
    f.db.exec('BEGIN'); f.append(); f.db.exec('ROLLBACK');
    assert.deepEqual(verifyAuditIntegrity(f.db, key), before);
    f.append();
    assert.equal(verifyAuditIntegrity(f.db, key, before.anchor).ok, true);
  } finally { f.db.close(); }
});

test('reopened protected database requires the process signing function to append', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cevrali-audit-'));
  const path = join(directory, 'practice.sqlite');
  let db = createDatabase(path);
  try {
    initializeAuditIntegrity(db, key); db.close();
    db = new DatabaseSync(path);
    assert.equal(verifyAuditIntegrity(db, key).ok, true);
    assert.throws(() => db.prepare('INSERT INTO audit(user_id,action,resource) VALUES(?,?,?)').run('usr-clinician', 'A', 'B'), /function/);
    initializeAuditIntegrity(db, key);
    db.prepare('INSERT INTO audit(user_id,action,resource) VALUES(?,?,?)').run('usr-clinician', 'A', 'B');
    assert.equal(verifyAuditIntegrity(db, key).ok, true);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('independent anchor detects rollback of the entire otherwise valid database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cevrali-audit-anchor-'));
  const path = join(directory, 'practice.sqlite'), old = join(directory, 'older.sqlite');
  let db = createDatabase(path);
  try {
    initializeAuditIntegrity(db, key);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    copyFileSync(path, old);
    db.prepare('INSERT INTO audit(user_id,action,resource) VALUES(?,?,?)').run('usr-clinician', 'A', 'B');
    const newer = verifyAuditIntegrity(db, key).anchor!;
    const older = new DatabaseSync(old, { readOnly: true });
    try {
      // Local cryptography alone accepts an intact older snapshot.
      assert.equal(verifyAuditIntegrity(older, key).ok, true);
      assert.equal(verifyAuditIntegrity(older, key, newer).ok, false);
    } finally { older.close(); }
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('integrity initialization requires a full key and never silently replaces a partial chain', () => {
  const f = fixture();
  try {
    assert.throws(() => initializeAuditIntegrity(f.db, Buffer.alloc(31)), /Audit integrity verification failed/);
    f.db.exec('CREATE TABLE audit_integrity_state(singleton INTEGER)');
    assert.throws(() => initializeAuditIntegrity(f.db, key), /Audit integrity verification failed/);
  } finally { f.db.close(); }
});
