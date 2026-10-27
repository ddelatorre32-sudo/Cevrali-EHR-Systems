#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const help = `Verify protected audit records while the service is stopped.
Usage: npm run audit:verify -- [--database PATH] [--accounts PATH] [--key-file PATH]
       [--anchors PATH] [--anchor-out NEW_FILE]
Defaults: DATABASE_PATH, ACCOUNTS_PATH, CEVRALI_AUTH_ENCRYPTION_KEY_FILE.
Anchor files contain signatures and technical database names, not audit contents.
Copy new anchors to independently protected storage to detect whole-database rollback.
`;
let release, key;
try {
  const flags = new Map(), allowed = new Set(['--database', '--accounts', '--key-file', '--anchors', '--anchor-out']);
  const args = process.argv.slice(2);
  if (args.includes('--help')) { process.stdout.write(help); process.exit(0); }
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!allowed.has(flag) || flags.has(flag) || !value || value.startsWith('--')) throw new Error('arguments');
    flags.set(flag, value);
  }
  const modules = ['audit-integrity', 'runtime-config', 'backup'].map(name => resolve(`dist-server/${name}.js`));
  if (modules.some(path => !existsSync(path))) throw new Error('build');
  const [{ verifyAuditIntegrity }, { readRuntimeKeyFile }, { acquireServiceLock }] = await Promise.all(modules.map(path => import(pathToFileURL(path).href)));
  const database = resolve(flags.get('--database') || process.env.DATABASE_PATH || '.data/cevrali.sqlite');
  const accounts = resolve(flags.get('--accounts') || process.env.ACCOUNTS_PATH || `${database}.accounts`);
  key = readRuntimeKeyFile(flags.get('--key-file') || process.env.CEVRALI_AUTH_ENCRYPTION_KEY_FILE || null, 'authentication');
  release = acquireServiceLock(database, accounts);
  const regular = path => { const info = lstatSync(path); if (!info.isFile() || info.nlink !== 1) throw new Error('input'); };
  regular(database); regular(join(accounts, 'accounts.sqlite'));
  const names = [{ name: 'main', path: database }];
  const registry = new DatabaseSync(join(accounts, 'accounts.sqlite'), { readOnly: true });
  try {
    for (const { id } of registry.prepare('SELECT id FROM practices ORDER BY id').all()) {
      if (id === 'demo-practice') continue;
      if (typeof id !== 'string' || !/^practice-[a-f0-9-]{36}$/.test(id)) throw new Error('registry');
      names.push({ name: `${id}.sqlite`, path: join(accounts, `${id}.sqlite`) });
    }
  } finally { registry.close(); }
  const expectedNames = new Set(names.slice(1).map(row => row.name));
  for (const name of readdirSync(accounts))
    if (name.endsWith('.sqlite') && name !== 'accounts.sqlite' && !expectedNames.has(name)) throw new Error('unregistered');
  let expected;
  if (flags.has('--anchors')) {
    const path = resolve(flags.get('--anchors')); regular(path);
    if (lstatSync(path).size > 1024 * 1024) throw new Error('anchor');
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed.format !== 'cevrali-audit-anchors-v1' || !Array.isArray(parsed.databases) || !parsed.databases.length) throw new Error('anchor');
    expected = new Map();
    for (const entry of parsed.databases) {
      if (!entry || typeof entry.name !== 'string' || expected.has(entry.name) || !entry.anchor) throw new Error('anchor');
      expected.set(entry.name, entry.anchor);
    }
    // Additional practices may have been provisioned since an earlier trusted anchor.
    if ([...expected.keys()].some(name => !names.some(row => row.name === name))) throw new Error('missing database');
  }
  const results = [];
  for (const entry of names) {
    regular(entry.path);
    const db = new DatabaseSync(entry.path, { readOnly: true });
    try {
      const report = verifyAuditIntegrity(db, key, expected?.get(entry.name));
      if (!report.ok) throw new Error('verification');
      results.push({ name: entry.name, anchor: report.anchor });
    } finally { db.close(); }
  }
  if (flags.has('--anchor-out')) writeFileSync(resolve(flags.get('--anchor-out')), `${JSON.stringify({
    format: 'cevrali-audit-anchors-v1', created_at: new Date().toISOString(), databases: results,
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: true, databases_verified: results.length,
    independently_supplied_anchor_checked: Boolean(expected), new_anchor_written: flags.has('--anchor-out') })}\n`);
} catch {
  process.stderr.write('Audit verification failed. Build the server, stop the service, and check the protected database, key, and anchor inputs. No audit contents were printed.\n');
  process.exitCode = 1;
} finally { key?.fill(0); release?.(); }
