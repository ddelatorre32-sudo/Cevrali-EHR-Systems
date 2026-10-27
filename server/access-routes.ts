import type { Express, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  accessSecurityStatus, authenticationSetup, beginEnrollment, completeAuthentication,
  confirmEnrollment, disableMfa, regenerateRecoveryCodes,
} from './access-security.js';
import { startSession, type AccountContext } from './accounts.js';
import type { RuntimeConfig } from './runtime-config.js';
import type { AuthenticationComplete, SecurityUser } from './access-security-model.js';

const challenge = z.object({ email: z.string().trim().email().max(254).transform(value => value.toLowerCase()), challenge_token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const verification = challenge.extend({ code: z.string().trim().min(1).max(100) });
const credentials = z.object({ password: z.string().min(1).max(200), code: z.string().trim().min(1).max(100) }).strict();

export function registerPublicAccessRoutes(app: Express, db: DatabaseSync, account: AccountContext | undefined,
  runtime: RuntimeConfig, authKey?: Uint8Array) {
  const key = () => authKey || (() => { throw Object.assign(new Error('Authenticator setup requires a configured secure encryption key.'), { status: 503 }); })();
  app.post('/api/auth/mfa/setup', (req, res) => {
    const input = challenge.parse(req.body);
    res.json(authenticationSetup(db, input, key(), account?.store.practice(account.practiceId).name || 'Cevrali'));
  });
  for (const route of ['complete', 'enroll']) app.post(`/api/auth/mfa/${route}`, (req, res) => {
    const result = completeAuthentication(db, verification.parse(req.body), key());
    if (!result.ok) return res.json(result);
    if (result.sessions_revoked && account) account.store.revokeSessions(account.practiceId, result.user.id);
    const user = startSession(db, result.user, res, account, { mfaVerified: true });
    res.json({ ok: true, user, ...(result.recovery_codes ? { recovery_codes: result.recovery_codes } : {}) });
  });
}

export function registerAccountAccessRoutes(app: Express, db: DatabaseSync, account: AccountContext | undefined,
  runtime: RuntimeConfig, authKey?: Uint8Array) {
  const key = () => authKey || (() => { throw Object.assign(new Error('Authenticator setup requires a configured secure encryption key.'), { status: 503 }); })();
  const currentUser = (res: Response) => db.prepare('SELECT * FROM users WHERE id=? AND is_active=1').get(res.locals.user.id) as SecurityUser;
  function completed(result: AuthenticationComplete | { ok: true; recovery_codes?: string[]; sessions_revoked: true }, res: Response, mfaVerified = true) {
    if (!result.ok) return res.json(result);
    const user = 'user' in result ? result.user : currentUser(res);
    if (result.sessions_revoked && account) account.store.revokeSessions(account.practiceId, user.id);
    const visible = startSession(db, user, res, account, { mfaVerified });
    return res.json({ ok: true, user: visible, ...(result.recovery_codes ? { recovery_codes: result.recovery_codes } : {}) });
  }
  app.get('/api/account/mfa', (_req, res) => res.json(accessSecurityStatus(db, currentUser(res), { required: runtime.requireMfa, key: authKey })));
  app.post('/api/account/mfa/setup', (req, res) => {
    const input = z.object({ password: z.string().min(1).max(200) }).strict().parse(req.body);
    res.json(beginEnrollment(db, currentUser(res), input.password, key(), account?.store.practice(account.practiceId).name || 'Cevrali'));
  });
  for (const route of ['confirm', 'enroll']) app.post(`/api/account/mfa/${route}`, (req, res) => {
    const input = z.object({ enrollment_id: z.string().min(1).max(200), code: z.string().trim().min(1).max(100) }).strict().parse(req.body);
    completed(confirmEnrollment(db, currentUser(res), input, key()), res);
  });
  app.post('/api/account/mfa/recovery-codes', (req, res) => completed(regenerateRecoveryCodes(db, currentUser(res), credentials.parse(req.body), key()), res));
  app.post('/api/account/mfa/disable', (req, res) => completed(disableMfa(db, currentUser(res), credentials.parse(req.body), key(), { required: runtime.requireMfa }), res, false));
}
