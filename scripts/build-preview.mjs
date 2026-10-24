import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { createDatabase, clinicDate } from '../server/database.ts';
import { readJson } from '../server/patient-accounts.ts';

// Only use an isolated in-memory seed. Never export an existing patient database.
const db = createDatabase(':memory:');
let seed;
try {
  seed = {
    today: clinicDate(),
    users: db
      .prepare('SELECT id, name, email, role, is_admin FROM users')
      .all(),
    patients: db
      .prepare('SELECT * FROM patients')
      .all()
      .map((p) => ({
        ...p,
        allergies: JSON.parse(p.allergies),
        conditions: JSON.parse(p.conditions),
        medications: JSON.parse(p.medications),
      })),
    appointments: db
      .prepare(
        'SELECT a.*, p.first_name, p.last_name, p.dob, p.sex, u.name provider FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN users u ON u.id = a.provider_id',
      )
      .all(),
    encounters: db
      .prepare(
        'SELECT e.*, p.first_name, p.last_name, u.name author FROM encounters e JOIN patients p ON p.id = e.patient_id JOIN users u ON u.id = e.author_id',
      )
      .all()
      .map((e) => ({
        ...e,
        wc_documentation: readJson(e.wc_documentation, null),
        billing_account_snapshot: readJson(e.billing_account_snapshot, null),
      })),
    tasks: db
      .prepare(
        'SELECT t.*, p.first_name, p.last_name FROM tasks t LEFT JOIN patients p ON p.id = t.patient_id',
      )
      .all(),
    labs: db
      .prepare(
        'SELECT l.*, p.first_name, p.last_name FROM labs l JOIN patients p ON p.id = l.patient_id',
      )
      .all(),
  };
} finally {
  db.close();
}

const result = await build({
  configFile: false,
  mode: 'standalone-preview',
  plugins: [react()],
  assetsInclude: ['**/*.pdf'],
  define: {
    __CEVRALI_PREVIEW_SEED__: JSON.stringify(seed),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    write: false,
    emptyOutDir: false,
    cssCodeSplit: false,
    lib: {
      entry: resolve('src/main.tsx'),
      name: 'CevraliPreview',
      formats: ['iife'],
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const output = Array.isArray(result) ? result[0].output : result.output;
const js = output
  .filter((item) => item.type === 'chunk')
  .map((item) => item.code)
  .join('\n');
const css = output
  .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
  .map((item) => String(item.source))
  .join('\n');
if (!js || !css)
  throw new Error('Standalone preview is missing JavaScript or styles');
const html = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cevrali — Interactive Preview</title><style>${css}</style></head>
<body><div id="root"></div><noscript>This interactive preview requires JavaScript.</noscript><script>${js.replaceAll(/<\/script/gi, '<\\/script')}</script></body></html>`;
await mkdir('preview', { recursive: true });
const target = resolve('preview/cevrali-preview.html');
await writeFile(target, html);
await writeFile(resolve('preview/cevrali-account-setup-preview.html'), html);
await writeFile(resolve('preview/cevrali-workers-comp-preview.html'), html);
await writeFile(resolve('preview/cevrali-rfa-fax-preview.html'), html);
await writeFile(resolve('preview/cevrali-connected-care-preview.html'), html);
await writeFile(resolve('preview/cevrali-calendar-preview.html'), html);
await writeFile(resolve('preview/cevrali-practice-efficiency-preview.html'), html);
await writeFile(resolve('preview/cevrali-system-fixes-preview.html'), html);
await writeFile(resolve('preview/cevrali-settings-preview.html'), html);
await writeFile(resolve('preview/cevrali-registration-preview.html'), html);
await writeFile(resolve('preview/cevrali-patient-profile-preview.html'), html);
await writeFile(resolve('preview/cevrali-efficiency-preview.html'), html);
await writeFile(resolve('preview/cevrali-billing-preview.html'), html);
await writeFile(
  resolve('preview/cevrali-revenue-workflows-preview.html'),
  html,
);
await writeFile(
  resolve('preview/cevrali-patient-workflows-preview.html'),
  html,
);
console.log(
  `Standalone preview: ${target} (${Math.round(Buffer.byteLength(html) / 1024)} KiB). No server or external assets required.`,
);
