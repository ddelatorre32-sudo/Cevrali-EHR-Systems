import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { OcrPageResult, PdfOcr } from './incoming-document.js';

const execute = promisify(execFile);
const engine = 'Local Tesseract · English';
const maxOcrPages = 10;

/** Parse Tesseract's word-level TSV, retaining line boundaries and a word
 * confidence average. Confidence is extraction quality, never a clinical
 * correctness or patient-matching score. */
export function parseOcrTsv(tsv: string) {
  const lines: string[] = [];
  const confidences: number[] = [];
  let lineKey = '';
  let words: string[] = [];
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    const fields = row.split('\t');
    if (fields.length < 12 || fields[0] !== '5') continue;
    const word = fields.slice(11).join('\t').trim();
    if (!word) continue;
    const key = fields.slice(1, 5).join(':');
    if (lineKey && key !== lineKey) {
      lines.push(words.join(' '));
      words = [];
    }
    lineKey = key;
    words.push(word);
    const confidence = Number(fields[10]);
    if (Number.isFinite(confidence) && confidence >= 0 && confidence <= 100)
      confidences.push(confidence);
  }
  if (words.length) lines.push(words.join(' '));
  return {
    text: lines.join('\n').slice(0, 100000),
    confidence: confidences.length
      ? Math.round(
          (confidences.reduce((sum, value) => sum + value, 0) /
            confidences.length) *
            10,
        ) / 10
      : null,
  };
}

/** Local tools only: no document, image, or extracted text leaves this process
 * for a remote OCR provider. Originals and rendered pages live in a private
 * temporary directory which is deleted even after tool errors. */
export const localPdfOcr: PdfOcr = async (bytes, requestedPages) => {
  const directory = await mkdtemp(join(tmpdir(), 'cevrali-fax-ocr-'));
  const pages: OcrPageResult[] = [];
  const started = Date.now();
  try {
    const input = join(directory, 'received.pdf');
    await writeFile(input, bytes, { mode: 0o600 });
    for (const [index, page] of requestedPages.entries()) {
      if (index >= maxOcrPages || Date.now() - started > 45000) {
        pages.push({
          page,
          text: '',
          confidence: null,
          issue: 'OCR processing limit reached; manually review this page',
        });
        continue;
      }
      try {
        const output = join(directory, `page-${page}`);
        // Bounded raster dimensions protect against unusually large PDF pages.
        await execute(
          'pdftoppm',
          [
            '-f', String(page), '-l', String(page), '-scale-to', '2400',
            '-gray', '-png', '-singlefile', input, output,
          ],
          { timeout: 15000, maxBuffer: 1024 * 1024 },
        );
        const result = await execute(
          'tesseract',
          [`${output}.png`, 'stdout', '-l', 'eng', '--psm', '3', 'tsv'],
          {
            timeout: 15000,
            maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, OMP_THREAD_LIMIT: '1' },
          },
        );
        const parsed = parseOcrTsv(result.stdout);
        pages.push({
          page,
          ...parsed,
          ...(!parsed.text.trim()
            ? { issue: 'No readable words detected; manually review this page' }
            : {}),
        });
      } catch {
        pages.push({
          page,
          text: '',
          confidence: null,
          issue: 'Local OCR unavailable or page unreadable; manually review this page',
        });
      }
    }
    return { engine, pages };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
