import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import express from 'express';
import { createDatabase } from './database.js';
import { createPlatformApp } from './platform.js';
import { automationTick } from './workflows.js';

const dbPath = resolve(process.env.DATABASE_PATH || '.data/cevrali.sqlite');
mkdirSync(dirname(dbPath), { recursive: true });
const db = createDatabase(dbPath);
const { app, store } = createPlatformApp(
  db,
  resolve(process.env.ACCOUNTS_PATH || `${dbPath}.accounts`),
);
for (const practiceDb of store.allDatabases()) automationTick(practiceDb);
const automation = setInterval(() => {
  try {
    for (const practiceDb of store.allDatabases()) automationTick(practiceDb);
  } catch (error) {
    console.error('Reminder processing failed:', (error as Error).message);
  }
}, 60000);
automation.unref();
const dist = resolve('dist');
if (existsSync(dist)) {
  app.use(
    express.static(dist, {
      setHeaders: (res) =>
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
        ),
    }),
  );
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
}
const port = Number(process.env.PORT || 3001);
const server = app.listen(port, '0.0.0.0', () =>
  console.log(`Cevrali API listening on port ${port} (synthetic demo)`),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () =>
    server.close(() => {
      clearInterval(automation);
      store.close();
      db.close();
      process.exit(0);
    }),
  );
