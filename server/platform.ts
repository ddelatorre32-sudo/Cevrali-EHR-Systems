import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { createApp } from './app.js';
import { AccountStore, sessionCookie, startSession } from './accounts.js';
import { accountError } from './account-model.js';

export function createPlatformApp(demoDb: DatabaseSync, directory: string) {
  const store = new AccountStore(directory, demoDb);
  const apps = new Map<string, Express>();
  const workspace = (practiceId: string) => {
    let app = apps.get(practiceId);
    if (!app) {
      app = createApp(store.db(practiceId), { store, practiceId });
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
    });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if (origin && new URL(origin).host !== req.get('host'))
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
  const registrations = new Map<string, { count: number; until: number }>();
  app.post('/api/accounts/signup', (req, res) => {
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
      startSession(store.db(created.practice.id), created.user, res, {
        store,
        practiceId: created.practice.id,
      }),
    );
  });
  app.get('/api/accounts/invitations/:token', (req, res) =>
    res.json(store.invitationView(String(req.params.token))),
  );
  app.post('/api/accounts/invitations/:token/accept', (req, res) => {
    const accepted = store.accept(String(req.params.token), req.body);
    res.status(201).json(
      startSession(store.db(accepted.practiceId), accepted.user, res, {
        store,
        practiceId: accepted.practiceId,
      }),
    );
  });
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    let practiceId: string | undefined;
    if (req.method === 'POST' && req.path === '/api/auth/login')
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
    if (intake) practiceId = store.intakePractice(intake[1]) || 'demo-practice';
    const expected = req.get('X-Cevrali-Practice');
    if (
      expected &&
      !intake &&
      !(req.method === 'POST' && req.path === '/api/auth/login') &&
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
