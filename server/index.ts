import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import express from 'express';
import { createDatabase } from './database.js';
import { createPlatformApp } from './platform.js';
import { automationTick } from './workflows.js';
import { acquireServiceLock } from './backup.js';
import { loadRuntimeConfig, readRuntimeKeyFile } from './runtime-config.js';
import { validateStartup } from './readiness.js';
import { assertProtectedDataPaths } from './startup.js';
import { initializeAuditIntegrity } from './audit-integrity.js';

// Validate the mode and mounted keys before opening or migrating any data.
const runtime = loadRuntimeConfig();
const readiness = validateStartup(runtime);
if (!runtime.demoEnabled) process.umask(0o077);
const releaseLock = acquireServiceLock(runtime.databasePath, runtime.accountsPath);
let db: ReturnType<typeof createDatabase> | undefined;
let store: ReturnType<typeof createPlatformApp>['store'] | undefined;
let authKey: Buffer | undefined;
let cleaned = false;
let automation: ReturnType<typeof setInterval> | undefined;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  if (automation) clearInterval(automation);
  try { store?.close(); }
  finally {
    try { db?.close(); }
    finally { authKey?.fill(0); releaseLock(); }
  }
};
process.once('exit', cleanup);
let platform: ReturnType<typeof createPlatformApp>;
try {
  if (!runtime.demoEnabled) assertProtectedDataPaths(runtime.databasePath, runtime.accountsPath);
  mkdirSync(dirname(runtime.databasePath), { recursive: true, mode: 0o700 });
  db = createDatabase(runtime.databasePath, { seedDemo: runtime.demoEnabled });
  authKey = runtime.authEncryptionKeyFile ? readRuntimeKeyFile(runtime.authEncryptionKeyFile, 'authentication') : undefined;
  if (!runtime.demoEnabled && authKey) initializeAuditIntegrity(db, authKey);
  platform = createPlatformApp(db, runtime.accountsPath, { runtime, authKey });
  store = platform.store;
} catch (error) { cleanup(); throw error; }
const { app } = platform;
for (const practiceDb of store.allDatabases()) automationTick(practiceDb);
automation = setInterval(() => {
  try {
    for (const practiceDb of store!.allDatabases()) automationTick(practiceDb);
  } catch (error) {
    console.error('Reminder processing failed:', (error as Error).message);
  }
}, 60000);
automation.unref();
const dist = resolve('dist');
if (existsSync(dist)) {
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      ...(runtime.secureCookies ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    });
    next();
  });
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
}
const port = Number(process.env.PORT || 3001);
const server = app.listen(port, '0.0.0.0', () =>
  console.log(`Cevrali API listening on port ${port} (${readiness.scope}; synthetic patients only)`),
);
server.once('error', () => cleanup());
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () =>
    server.close(() => {
      cleanup();
      process.exit(0);
    }),
  );
