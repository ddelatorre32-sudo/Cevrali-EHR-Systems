import { DatabaseSync } from 'node:sqlite';
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Express, Response } from 'express';
import { z } from 'zod';
import { createDatabase, hashPassword } from './database.js';
import {
  accountError,
  accountPassword,
  inviteInput,
  joinInput,
  practiceFields,
  profileComplete,
  signupInput,
  type Practice,
} from './account-model.js';

type Row = Record<string, any>;
export type AccountContext = { store: AccountStore; practiceId: string };
export const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export const sessionCookie = (headers: string | undefined) =>
  (headers || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('cevrali_session='))
    ?.slice('cevrali_session='.length);
const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: process.env.COOKIE_SECURE === 'true',
  path: '/',
});
export function passwordMatches(password: string, stored: string) {
  const [salt, expected] = stored.split(':');
  const actual = scryptSync(password, salt || 'unrecognized', 64);
  return Boolean(
    expected &&
    /^[a-f0-9]{128}$/.test(expected) &&
    timingSafeEqual(actual, Buffer.from(expected, 'hex')),
  );
}
export function publicUser(user: Row, account?: AccountContext) {
  const p = account?.store.practice(account.practiceId);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    is_admin: Boolean(user.is_admin),
    ...(p
      ? {
          practice: {
            id: p.id,
            name: p.name,
            is_demo: p.is_demo,
            setup_completed_at: p.setup_completed_at,
          },
        }
      : {}),
  };
}
export function startSession(
  db: DatabaseSync,
  user: Row,
  res: Response,
  account?: AccountContext,
) {
  const token = randomBytes(32).toString('hex');
  const hash = tokenHash(token);
  const expires = Date.now() + 8 * 3600000;
  db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash, user.id, expires);
  if (account)
    account.store.indexSession(hash, account.practiceId, user.id, expires);
  res.cookie('cevrali_session', token, {
    ...cookieOptions(),
    maxAge: 8 * 3600000,
  });
  return publicUser(user, account);
}
export class AccountStore {
  readonly registry: DatabaseSync;
  private databases = new Map<string, DatabaseSync>();
  constructor(
    readonly directory: string,
    readonly demoDb: DatabaseSync,
  ) {
    mkdirSync(directory, { recursive: true });
    this.registry = new DatabaseSync(resolve(directory, 'accounts.sqlite'));
    this.registry.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS practices(id TEXT PRIMARY KEY,document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memberships(email TEXT PRIMARY KEY,practice_id TEXT NOT NULL REFERENCES practices(id),user_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_index(hash TEXT PRIMARY KEY,practice_id TEXT NOT NULL REFERENCES practices(id),user_id TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY,practice_id TEXT NOT NULL REFERENCES practices(id),email TEXT NOT NULL,role TEXT NOT NULL,is_admin INTEGER NOT NULL,token_hash TEXT NOT NULL UNIQUE,status TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS public_links(hash TEXT PRIMARY KEY,practice_id TEXT NOT NULL REFERENCES practices(id),expires TEXT NOT NULL);
    `);
    this.databases.set('demo-practice', demoDb);
    const owner = demoDb
      .prepare('SELECT id FROM users WHERE is_admin=1 ORDER BY id LIMIT 1')
      .get() as Row | undefined;
    const p: Practice = {
      id: 'demo-practice',
      owner_id: owner?.id || 'usr-clinician',
      name: 'Evergreen Medical',
      legal_name: 'Evergreen Medical',
      specialty: 'Primary care',
      phone: '(415) 555-0100',
      email: 'hello@cevrali.demo',
      address: 'Synthetic demo practice',
      fax_provider_name:'Demo fax',fax_from_number:'',
      npi: '',
      created_at: new Date().toISOString(),
      setup_completed_at: new Date().toISOString(),
      is_demo: true,
      revision: 1,
      time_zone: 'America/Los_Angeles',
    };
    this.registry
      .prepare('INSERT OR IGNORE INTO practices VALUES (?,?)')
      .run(p.id, JSON.stringify(p));
    for (const user of demoDb
      .prepare('SELECT id,email FROM users')
      .all() as Row[])
      this.registry
        .prepare('INSERT OR IGNORE INTO memberships VALUES (?,?,?)')
        .run(user.email.toLowerCase(), p.id, user.id);
    for (const s of demoDb
      .prepare('SELECT * FROM sessions WHERE expires>?')
      .all(Date.now()) as Row[])
      this.indexSession(s.token, p.id, s.user_id, s.expires);
  }
  practice(id: string): Practice {
    const row = this.registry
      .prepare('SELECT document FROM practices WHERE id=?')
      .get(id) as Row | undefined;
    return row
      ? JSON.parse(row.document)
      : accountError(404, 'Practice account not found');
  }
  savePractice(p: Practice) {
    this.registry
      .prepare('UPDATE practices SET document=? WHERE id=?')
      .run(JSON.stringify(p), p.id);
  }
  db(id: string) {
    let db = this.databases.get(id);
    if (db) return db;
    this.practice(id);
    if (!/^practice-[a-f0-9-]{36}$/.test(id))
      accountError(500, 'Invalid practice identifier');
    db = createDatabase(resolve(this.directory, `${id}.sqlite`), {
      seedDemo: false,
    });
    this.databases.set(id, db);
    return db;
  }
  membership(email: string) {
    return this.registry
      .prepare('SELECT * FROM memberships WHERE email=?')
      .get(email.trim().toLowerCase()) as Row | undefined;
  }
  indexSession(
    hash: string,
    practiceId: string,
    userId: string,
    expires: number,
  ) {
    this.registry
      .prepare('DELETE FROM session_index WHERE expires<?')
      .run(Date.now());
    this.registry
      .prepare('INSERT OR REPLACE INTO session_index VALUES (?,?,?,?)')
      .run(hash, practiceId, userId, expires);
  }
  sessionPractice(token: string) {
    return (
      this.registry
        .prepare(
          'SELECT practice_id FROM session_index WHERE hash=? AND expires>?',
        )
        .get(tokenHash(token), Date.now()) as Row | undefined
    )?.practice_id as string | undefined;
  }
  removeSession(token: string) {
    this.registry
      .prepare('DELETE FROM session_index WHERE hash=?')
      .run(tokenHash(token));
  }
  indexIntake(practiceId: string, token: string, expires: string) {
    this.registry
      .prepare('INSERT OR REPLACE INTO public_links VALUES (?,?,?)')
      .run(tokenHash(token), practiceId, expires);
  }
  intakePractice(token: string) {
    return (
      this.registry
        .prepare(
          'SELECT practice_id FROM public_links WHERE hash=? AND expires>?',
        )
        .get(tokenHash(token), new Date().toISOString()) as Row | undefined
    )?.practice_id as string | undefined;
  }
  revokeSessions(practiceId: string, userId: string) {
    this.db(practiceId)
      .prepare('DELETE FROM sessions WHERE user_id=?')
      .run(userId);
    this.registry
      .prepare('DELETE FROM session_index WHERE practice_id=? AND user_id=?')
      .run(practiceId, userId);
  }
  audit(practiceId: string, userId: string, action: string, resource: string) {
    this.db(practiceId)
      .prepare('INSERT INTO audit(user_id,action,resource) VALUES(?,?,?)')
      .run(userId, action, resource);
  }
  signup(value: unknown) {
    const input = signupInput.parse(value);
    if (this.membership(input.email))
      accountError(
        409,
        'An account already exists for this email. Sign in instead.',
      );
    const id = `practice-${randomUUID()}`;
    const userId = `usr-${randomUUID()}`;
    const created = new Date().toISOString();
    const p: Practice = {
      ...input.practice,
      email: input.practice.email || input.email,
      id,
      owner_id: userId,
      created_at: created,
      setup_completed_at: null,
      is_demo: false,
      revision: 1,
      time_zone: 'America/Los_Angeles',
    };
    this.registry.exec('BEGIN IMMEDIATE');
    let db: DatabaseSync | undefined;
    try {
      if (this.membership(input.email))
        accountError(
          409,
          'An account already exists for this email. Sign in instead.',
        );
      this.registry
        .prepare('INSERT INTO practices VALUES (?,?)')
        .run(id, JSON.stringify(p));
      db = createDatabase(resolve(this.directory, `${id}.sqlite`), {
        seedDemo: false,
      });
      db.prepare(
        'INSERT INTO users(id,name,email,password,role,is_admin,is_active) VALUES(?,?,?,?,?,1,1)',
      ).run(
        userId,
        input.owner_name,
        input.email,
        hashPassword(input.password),
        input.clinical_access ? 'clinician' : 'receptionist',
      );
      db.prepare(
        'INSERT INTO audit(user_id,action,resource) VALUES(?,?,?)',
      ).run(userId, 'Created practice account', id);
      this.registry
        .prepare('INSERT INTO memberships VALUES (?,?,?)')
        .run(input.email, id, userId);
      this.registry.exec('COMMIT');
      this.databases.set(id, db);
      return {
        practice: p,
        user: db.prepare('SELECT * FROM users WHERE id=?').get(userId) as Row,
      };
    } catch (error) {
      this.registry.exec('ROLLBACK');
      db?.close();
      for (const suffix of ['', '-wal', '-shm'])
        rmSync(resolve(this.directory, `${id}.sqlite${suffix}`), {
          force: true,
        });
      throw error;
    }
  }
  invitation(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token))
      accountError(404, 'Invitation not found');
    const invite = this.registry
      .prepare('SELECT * FROM invitations WHERE token_hash=?')
      .get(tokenHash(token)) as Row | undefined;
    if (!invite) accountError(404, 'Invitation not found');
    if (invite.status !== 'Pending')
      accountError(409, 'This invitation has already been used or revoked');
    if (invite.expires_at <= new Date().toISOString())
      accountError(
        410,
        'This invitation has expired. Ask your practice administrator for a new link.',
      );
    return invite;
  }
  invitationView(token: string) {
    const invite = this.invitation(token);
    const p = this.practice(invite.practice_id);
    return {
      practice_name: p.name,
      email: invite.email,
      role: invite.role,
      is_admin: Boolean(invite.is_admin),
      expires_at: invite.expires_at,
    };
  }
  accept(token: string, value: unknown) {
    const input = joinInput.parse(value);
    const invite = this.invitation(token);
    if (this.membership(invite.email))
      accountError(
        409,
        'An account already exists for this email. Contact your practice administrator.',
      );
    const db = this.db(invite.practice_id);
    const userId = `usr-${randomUUID()}`;
    this.registry.exec('BEGIN IMMEDIATE');
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.invitation(token);
      if (this.membership(current.email))
        accountError(409, 'This email already has an account');
      db.prepare(
        'INSERT INTO users(id,name,email,password,role,is_admin,is_active) VALUES(?,?,?,?,?,?,1)',
      ).run(
        userId,
        input.name,
        current.email,
        hashPassword(input.password),
        current.role,
        current.is_admin,
      );
      this.registry
        .prepare('INSERT INTO memberships VALUES(?,?,?)')
        .run(current.email, current.practice_id, userId);
      this.registry
        .prepare("UPDATE invitations SET status='Accepted' WHERE id=?")
        .run(current.id);
      db.prepare(
        'INSERT INTO audit(user_id,action,resource) VALUES(?,?,?)',
      ).run(userId, 'Accepted staff invitation', current.id);
      this.registry.exec('COMMIT');
      db.exec('COMMIT');
      return {
        practiceId: current.practice_id,
        user: db.prepare('SELECT * FROM users WHERE id=?').get(userId) as Row,
      };
    } catch (error) {
      if (this.registry.isTransaction) this.registry.exec('ROLLBACK');
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
  allDatabases() {
    return [
      ...(this.registry.prepare('SELECT id FROM practices').all() as {
        id: string;
      }[]),
    ].map((p) => this.db(p.id));
  }
  close() {
    for (const [id, db] of this.databases)
      if (id !== 'demo-practice') db.close();
    this.databases.clear();
    this.registry.close();
  }
}
export function registerAccountRoutes(
  app: Express,
  db: DatabaseSync,
  account: AccountContext,
) {
  const { store, practiceId } = account;
  const admin = (user: Row) => {
    if (!user.is_admin)
      accountError(403, 'Practice administrator access required');
  };
  app.get('/api/account', (_req, res) => {
    const user = res.locals.user;
    const p = store.practice(practiceId);
    const members = user.is_admin
      ? (
          db
            .prepare(
              'SELECT id,name,email,role,is_admin,is_active FROM users ORDER BY name',
            )
            .all() as Row[]
        ).map((u) => ({
          ...u,
          is_admin: Boolean(u.is_admin),
          is_active: Boolean(u.is_active),
        }))
      : [];
    const invitations = user.is_admin
      ? (
          store.registry
            .prepare(
              'SELECT id,email,role,is_admin,status,created_at,expires_at FROM invitations WHERE practice_id=? ORDER BY created_at DESC',
            )
            .all(practiceId) as Row[]
        ).map((i) => ({
          ...i,
          is_admin: Boolean(i.is_admin),
          status:
            i.status === 'Pending' && i.expires_at <= new Date().toISOString()
              ? 'Expired'
              : i.status,
        }))
      : [];
    res.json({
      practice: p,
      members,
      invitations,
      is_admin: Boolean(user.is_admin),
      patient_count: (
        db.prepare('SELECT COUNT(*) n FROM patients').get() as Row
      ).n,
    });
  });
  app.patch('/api/account/practice', (req, res) => {
    admin(res.locals.user);
    const input = practiceFields
      .extend({
        revision: z.number().int(),
        complete_setup: z.boolean().optional(),
      })
      .parse(req.body);
    const p = store.practice(practiceId);
    if (input.revision !== p.revision)
      accountError(409, 'Practice settings changed; reload before saving');
    const { complete_setup, ...fields } = input;
    const next = { ...p, ...fields, revision: p.revision + 1 };
    if (input.complete_setup && !profileComplete(next))
      accountError(
        400,
        'Add the practice name, contact email, phone, and address before finishing setup',
      );
    if (input.complete_setup)
      next.setup_completed_at = new Date().toISOString();
    if (!profileComplete(next)) next.setup_completed_at = null;
    store.savePractice(next);
    store.audit(
      practiceId,
      res.locals.user.id,
      'Updated practice settings',
      practiceId,
    );
    res.json(next);
  });
  app.post('/api/account/invitations', (req, res) => {
    admin(res.locals.user);
    const input = inviteInput.parse(req.body);
    if (store.membership(input.email))
      accountError(
        409,
        'This email already has an account. Each staff account belongs to one practice.',
      );
    const token = randomBytes(32).toString('hex');
    const id = `invite-${randomUUID()}`;
    const created = new Date().toISOString();
    const expires = new Date(Date.now() + 72 * 3600000).toISOString();
    store.registry.exec('BEGIN IMMEDIATE');
    try {
      store.registry
        .prepare(
          "UPDATE invitations SET status='Revoked' WHERE practice_id=? AND email=? AND status='Pending'",
        )
        .run(practiceId, input.email);
      store.registry
        .prepare('INSERT INTO invitations VALUES(?,?,?,?,?,?,?,?,?)')
        .run(
          id,
          practiceId,
          input.email,
          input.role,
          Number(input.is_admin),
          tokenHash(token),
          'Pending',
          created,
          expires,
        );
      store.registry.exec('COMMIT');
    } catch (error) {
      store.registry.exec('ROLLBACK');
      throw error;
    }
    store.audit(practiceId, res.locals.user.id, 'Created staff invitation', id);
    res.json({
      id,
      token,
      expires_at: expires,
      delivery: 'Manual link; no email sent',
    });
  });
  app.post('/api/account/invitations/:id/revoke', (req, res) => {
    admin(res.locals.user);
    const invite = store.registry
      .prepare('SELECT * FROM invitations WHERE id=? AND practice_id=?')
      .get(String(req.params.id), practiceId) as Row | undefined;
    if (!invite) accountError(404, 'Invitation not found');
    if (invite.status !== 'Pending')
      accountError(409, 'Invitation is already closed');
    store.registry
      .prepare("UPDATE invitations SET status='Revoked' WHERE id=?")
      .run(invite.id);
    store.audit(
      practiceId,
      res.locals.user.id,
      'Revoked staff invitation',
      invite.id,
    );
    res.json({ ok: true });
  });
  app.patch('/api/account/members/:id', (req, res) => {
    admin(res.locals.user);
    const input = z
      .object({
        role: z.enum(['clinician', 'receptionist']),
        is_admin: z.boolean(),
        is_active: z.boolean(),
      })
      .parse(req.body);
    const member = db
      .prepare('SELECT * FROM users WHERE id=?')
      .get(String(req.params.id)) as Row | undefined;
    if (!member) accountError(404, 'Staff member not found');
    if (member.id === res.locals.user.id)
      accountError(409, 'Ask another administrator to change your access');
    const p = store.practice(practiceId);
    if (member.id === p.owner_id && (!input.is_admin || !input.is_active))
      accountError(409, 'The practice owner must retain administrator access');
    db.prepare('UPDATE users SET role=?,is_admin=?,is_active=? WHERE id=?').run(
      input.role,
      Number(input.is_admin),
      Number(input.is_active),
      member.id,
    );
    store.revokeSessions(practiceId, member.id);
    store.audit(
      practiceId,
      res.locals.user.id,
      'Updated staff access',
      member.id,
    );
    res.json({ ok: true });
  });
  app.post('/api/account/password', (req, res) => {
    const input = z
      .object({
        current_password: z.string().min(1).max(200),
        password: accountPassword,
      })
      .parse(req.body);
    const user = db
      .prepare('SELECT * FROM users WHERE id=?')
      .get(res.locals.user.id) as Row;
    if (!passwordMatches(input.current_password, user.password))
      accountError(400, 'Current password is incorrect');
    db.prepare('UPDATE users SET password=? WHERE id=?').run(
      hashPassword(input.password),
      user.id,
    );
    store.revokeSessions(practiceId, user.id);
    store.audit(practiceId, user.id, 'Changed account password', user.id);
    res.json(startSession(db, user, res, account));
  });
}
