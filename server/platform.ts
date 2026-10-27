import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { scryptSync } from 'node:crypto';
import { z } from 'zod';
import { createApp } from './app.js';
import { AccountStore, authenticateOrChallenge, sessionCookie } from './accounts.js';
import { accountError } from './account-model.js';
import { loadRuntimeConfig, readRuntimeKeyFile, type RuntimeConfig } from './runtime-config.js';
import { validateStartup } from './readiness.js';
import { initializeAuditIntegrity } from './audit-integrity.js';

export function createPlatformApp(
  demoDb: DatabaseSync,
  directory: string,
  options: { runtime?: RuntimeConfig; authKey?: Uint8Array } = {},
) {
  const runtime = options.runtime || loadRuntimeConfig();
  validateStartup(runtime);
  const authKey = options.authKey || (runtime.authEncryptionKeyFile ? readRuntimeKeyFile(runtime.authEncryptionKeyFile, 'authentication') : undefined);
  const store = new AccountStore(directory, demoDb, {
    demoEnabled: runtime.demoEnabled,
    initializeDatabase: !runtime.demoEnabled && authKey ? db => initializeAuditIntegrity(db, authKey) : undefined,
  });
  const apps = new Map<string, Express>();
  const workspace = (practiceId: string) => {
    let app = apps.get(practiceId);
    if (!app) {
      app = createApp(store.db(practiceId), { store, practiceId, runtime, authKey });
      apps.set(practiceId, app);
    }
    return app;
  };
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', (req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      ...(runtime.secureCookies ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      let validOrigin = true;
      if (origin) {
        try { validOrigin = new URL(origin).host === req.get('host'); }
        catch { validOrigin = false; }
      }
      if (!validOrigin)
        return next(
          Object.assign(new Error('Cross-origin request rejected'), {
            status: 403,
          }),
        );
      if (!req.is('application/json'))
        return next(
          Object.assign(new Error('Content-Type must be application/json'), {
            status: 415,
          }),
        );
    }
    next();
  });
  app.use(express.json({ limit: '3mb' }));
  app.get('/api/runtime', (_req, res) => res.json({
    mode: runtime.mode,
    demo_enabled: runtime.demoEnabled,
    public_signup_enabled: runtime.publicSignupEnabled,
    mfa_required: runtime.requireMfa,
    clinical_use_allowed: false,
  }));
  app.get('/api/health', (_req, res) => {
    // This liveness check remains available before a practice session exists.
    // It deliberately reveals neither record counts nor tenant identifiers.
    demoDb.prepare('SELECT 1').get();
    store.registry.prepare('SELECT 1').get();
    res.json({ status: 'ok', mode: runtime.mode, clinical_use_allowed: false });
  });
  const registrations = new Map<string, { count: number; until: number }>();
  app.post('/api/accounts/signup', (req, res) => {
    if (!runtime.publicSignupEnabled)
      accountError(403, 'Public practice signup is disabled. Contact the system operator.');
    const key = req.ip || 'local';
    const previous = registrations.get(key);
    if (previous && previous.until > Date.now() && previous.count >= 20)
      accountError(429, 'Too many account creations. Try again later.');
    registrations.set(key, {
      count: previous && previous.until > Date.now() ? previous.count + 1 : 1,
      until: Date.now() + 900000,
    });
    const created = store.signup(req.body);
    res.status(201).json(
      authenticateOrChallenge(store.db(created.practice.id), created.user, res, {
        store,
        practiceId: created.practice.id,
        runtime,
        authKey,
      }),
    );
  });
  app.get('/api/accounts/invitations/:token', (req, res) =>
    res.json(store.invitationView(String(req.params.token))),
  );
  app.post('/api/accounts/invitations/:token/accept', (req, res) => {
    const accepted = store.accept(String(req.params.token), req.body);
    res.status(201).json(
      authenticateOrChallenge(store.db(accepted.practiceId), accepted.user, res, {
        store,
        practiceId: accepted.practiceId,
        runtime,
        authKey,
      }),
    );
  });
  // A protected server has many tenant apps. Keep an additional password-failure
  // budget here so cycling unknown emails or practices cannot reset the limit.
  const loginFailures = new Map<string, { count: number; until: number }>();
  app.post('/api/auth/login', (req, res, next) => {
    if (runtime.demoEnabled) return next();
    const now = Date.now();
    for (const [key, value] of loginFailures) if (value.until <= now) loginFailures.delete(key);
    const address = req.ip || 'local';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const keys = [{ key: JSON.stringify(['address', address]), limit: 100 }, { key: JSON.stringify(['account', address, email]), limit: 10 }];
    if (keys.some(({ key, limit }) => (loginFailures.get(key)?.count || 0) >= limit))
      return next(Object.assign(new Error('Too many sign-in attempts. Try again in 15 minutes.'), { status: 429 }));
    res.once('finish', () => {
      if (res.statusCode === 200) loginFailures.delete(keys[1].key);
      if (res.statusCode !== 401) return;
      for (const { key } of keys) {
        const previous = loginFailures.get(key);
        loginFailures.set(key, { count: (previous?.count || 0) + 1, until: Date.now() + 900000 });
      }
    });
    next();
  });
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    let practiceId: string | undefined;
    const publicAuthentication = req.method === 'POST' && /^\/api\/auth\/(?:login|mfa\/(?:setup|complete|enroll))$/.test(req.path);
    if (publicAuthentication)
      practiceId =
        typeof req.body?.email === 'string'
          ? store.membership(req.body.email)?.practice_id
          : undefined;
    else {
      const token = sessionCookie(req.headers.cookie);
      if (token) practiceId = store.sessionPractice(token);
    }
    const intake = req.path.match(
      /^\/api\/intake-links\/([a-f0-9]{64})(?:\/|$)/,
    );
    if (intake) {
      practiceId = store.intakePractice(intake[1]);
      if (!practiceId && !runtime.demoEnabled)
        return next(Object.assign(new Error('This intake link is unavailable.'), { status: 404 }));
    }
    if (!practiceId && !runtime.demoEnabled) {
      if (publicAuthentication && req.path === '/api/auth/login') {
        const input = z.object({ email: z.string().trim().email().transform(value => value.toLowerCase()), password: z.string().min(1).max(200) }).parse(req.body);
        // Match the actual password verifier's work even when no membership
        // exists. No demo app or demo identity is consulted in protected mode.
        scryptSync(input.password, 'unrecognized', 64);
      }
      const message = !publicAuthentication ? 'Sign in to continue.' : req.path === '/api/auth/login'
        ? 'Email or password is incorrect' : 'This authentication challenge is unavailable. Sign in again.';
      return next(Object.assign(new Error(message), { status: 401 }));
    }
    const expected = req.get('X-Cevrali-Practice');
    if (
      expected &&
      !intake &&
      !publicAuthentication &&
      expected !== (practiceId || 'demo-practice')
    )
      return next(
        Object.assign(
          new Error('Your practice session changed. Sign in again.'),
          { status: 401 },
        ),
      );
    workspace(practiceId || 'demo-practice')(req, res, next);
  });
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError)
      return res.status(400).json({
        error: error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
      });
    const status = error.status || 500;
    if (status >= 500) console.error('Account request failed:', error.message);
    res.status(status).json({
      error: status >= 500 ? 'An unexpected error occurred' : error.message,
    });
  });
  return { app, store };
}
