import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { prepareIncomingDocument } from '../server/incoming-document.js';
import { localPdfOcr, parseOcrTsv } from '../server/ocr-local.js';
import { createDatabase } from '../server/database.js';
import { createPlatformApp } from '../server/platform.js';

async function scanPdf({ mixed = false, blank = false } = {}) {
  const pdf = await PDFDocument.create();
  if (mixed) {
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText('Searchable cover sheet', { x: 30, y: 740, font });
  }
  const image = await pdf.embedPng(await readFile(new URL('./fixtures/ocr-synthetic.png', import.meta.url)));
  pdf.addPage([612, 792]).drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  if (blank) pdf.addPage();
  return Buffer.from(await pdf.save()).toString('base64');
}
const input = (original_base64: string) => ({
  external_id: 'SYNTHETIC-SCAN', sender: 'Synthetic Facility',
  filename: 'scanned-report.pdf', format: 'pdf', original_base64,
  text: 'Client-provided text is not a trusted PDF extraction',
});

test('real local OCR reads an image-only PDF, preserves exact original bytes and holds recognized values for clinician review', async () => {
  const original = await scanPdf();
  const document = await prepareIncomingDocument(input(original), { ocrPdf: localPdfOcr });
  assert.match(document.extracted_text, /Patient Name: Olivia Bennett/);
  assert.match(document.extracted_text, /1989-04-12/);
  assert.match(document.extracted_text, /4\.2 mmol\/L/);
  assert.equal(document.original_base64, original);
  assert.equal(document.extraction_method, 'ocr');
  assert.deepEqual(document.ocr_pages, [1]);
  assert.ok(document.ocr_confidence !== null && document.ocr_confidence > 70);
  assert.match(document.ocr_engine, /Local Tesseract/);
  assert.match(document.extraction_issue, /clinician.*identity.*values/);
  assert.doesNotMatch(document.extracted_text, /Client-provided/);
});

test('mixed readable and scanned pages retain both sources and unreadable pages stay held; standalone preview explicitly requires manual transcription', async () => {
  const original = await scanPdf({ mixed: true, blank: true });
  const document = await prepareIncomingDocument(input(original), { ocrPdf: localPdfOcr });
  assert.match(document.extracted_text, /Searchable cover sheet/);
  assert.match(document.extracted_text, /4\.2 mmol\/L/);
  assert.equal(document.extraction_method, 'mixed');
  assert.deepEqual(document.ocr_pages, [2]);
  assert.match(document.extraction_issue, /incomplete or unreadable/);
  const preview = await prepareIncomingDocument(input(original));
  assert.match(preview.extracted_text, /Searchable cover sheet/);
  assert.match(preview.extraction_issue, /standalone preview requires manual transcription/);
  assert.equal(preview.ocr_confidence, null);
  assert.equal(preview.original_base64, original);
});

test('TSV confidence excludes layout records and preserves line boundaries', () => {
  const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
  const result = parseOcrTsv([
    header,
    '4\t1\t1\t1\t1\t0\t0\t0\t0\t0\t-1\t',
    '5\t1\t1\t1\t1\t1\t0\t0\t0\t0\t90\tResult:',
    '5\t1\t1\t1\t1\t2\t0\t0\t0\t0\t80\t4.2',
    '5\t1\t1\t1\t2\t1\t0\t0\t0\t0\t100\tReviewed',
  ].join('\n'));
  assert.deepEqual(result, { text: 'Result: 4.2\nReviewed', confidence: 90 });
});

test('fax OCR and type correction require clinician original review; reception sees metadata and original bytes remain unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cevrali-ocr-test-'));
  const db = createDatabase(join(directory, 'demo.sqlite'));
  const platform = createPlatformApp(db, join(directory, 'accounts'));
  const server = platform.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  async function call(path: string, method = 'GET', body?: unknown, cookie = '') {
    const response = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
  }
  try {
    const clinician = (await call('/auth/login', 'POST', {
      email: 'alex@cevrali.demo', password: 'CevraliDemo2026!',
    })).cookie;
    const reception = (await call('/auth/login', 'POST', {
      email: 'frontdesk@cevrali.demo', password: 'CevraliDemo2026!',
    })).cookie;
    const original = await scanPdf();
    const receipt = await call('/workflow/operations/incoming-faxes', 'POST', input(original), reception);
    assert.equal(receipt.status, 200, JSON.stringify(receipt.data));
    assert.equal(receipt.data.status, 'Needs review');
    assert.equal(receipt.data.extraction_method, 'ocr');
    assert.equal(receipt.data.original_base64, undefined);
    assert.equal(receipt.data.extracted_text, undefined);
    const route = `/workflow/operations/incoming-faxes/${receipt.data.id}`;
    assert.equal((await call(route, 'GET', undefined, reception)).status, 403);
    const detail = (await call(route, 'GET', undefined, clinician)).data;
    assert.match(detail.extracted_text, /4\.2 mmol\/L/);
    const filing = {
      revision: detail.revision, patient_id: 'pat-001', billing_account_id: '',
      identity_confirmed: true, reason: 'Compared original patient identifiers',
    };
    assert.equal((await call(`${route}/file`, 'POST', filing, clinician)).status, 409);
    const correction = {
      revision: detail.revision, kind: 'Lab report', text: detail.extracted_text,
      identity_confirmed: true, values_confirmed: true,
      reason: 'Compared every page, identity, result, decimal and unit with original',
    };
    assert.equal((await call(`${route}/review-extraction`, 'POST', correction, reception)).status, 403);
    assert.equal((await call(`${route}/review-extraction`, 'POST', { ...correction, values_confirmed: false }, clinician)).status, 400);
    const reviewed = await call(`${route}/review-extraction`, 'POST', correction, clinician);
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
    assert.equal(reviewed.data.extraction_issue, '');
    assert.equal(reviewed.data.original_base64, original);
    assert.equal(reviewed.data.extraction_revisions[0].text, detail.extracted_text);
    assert.equal((await call(`${route}/review-extraction`, 'POST', correction, clinician)).status, 400);
    const filed = await call(`${route}/file`, 'POST', { ...filing, revision: reviewed.data.revision }, clinician);
    assert.equal(filed.status, 200, JSON.stringify(filed.data));
    const corrected = await call(`${route}/review-extraction`, 'POST', {
      ...correction, revision: filed.data.revision, kind: 'Specialist note',
      reason: 'Corrected document classification after original review',
    }, clinician);
    assert.equal(corrected.status, 200, JSON.stringify(corrected.data));
    assert.equal(corrected.data.kind, 'Specialist note');
    assert.equal(corrected.data.reviewed_at, null);
    assert.equal(corrected.data.original_base64, original);
    const metadata = (await call('/workflow/operations/incoming-faxes', 'GET', undefined, reception)).data;
    assert.ok(!JSON.stringify(metadata).includes('4.2 mmol/L'));
    assert.ok(!JSON.stringify(metadata).includes(correction.reason));
    assert.ok(!JSON.stringify(metadata).includes('extraction_revisions'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    platform.store.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
