import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';

const incomingInput = z.object({
  external_id: z.string().trim().min(1).max(150),
  sender: z.string().trim().min(1).max(200),
  filename: z.string().trim().min(1).max(150),
  format: z.enum(['text', 'pdf']),
  text: z.string().max(100000).optional(),
  original_base64: z.string().max(2800000).optional(),
});
const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { status: 400 });
};
export type OcrPageResult = {
  page: number;
  text: string;
  confidence: number | null;
  issue?: string;
};
export type PdfOcr = (
  bytes: Uint8Array,
  pages: number[],
) => Promise<{ engine: string; pages: OcrPageResult[] }>;
export type IncomingDocumentOptions = { ocrPdf?: PdfOcr };

/** Extraction never changes the received bytes. OCR remains untrusted until a
 * clinician compares patient identity and clinical values with the original. */
export async function prepareIncomingDocument(
  body: unknown,
  options: IncomingDocumentOptions = {},
) {
  const v = incomingInput.parse(body);
  let bytes: Uint8Array;
  let extracted_text = '';
  let pages = 0;
  let extraction_issue = '';
  let extraction_method: 'text' | 'pdf-text' | 'ocr' | 'mixed' | 'unreadable' =
    v.format === 'text' ? 'text' : 'pdf-text';
  let ocr_confidence: number | null = null;
  let ocr_engine = '';
  let ocr_pages: number[] = [];
  if (v.format === 'text') {
    if (!v.text?.trim()) invalid('Enter the received document text');
    bytes = new TextEncoder().encode(v.text);
    extracted_text = v.text!;
    pages = 1;
  } else {
    if (!v.original_base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.original_base64))
      invalid('Attach a base64 PDF document');
    bytes = Uint8Array.from(atob(v.original_base64!), (c) => c.charCodeAt(0));
    if (bytes.length > 2000000) invalid('PDF must be no larger than 2 MB');
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-')
      invalid('The attached file is not a PDF');
    try {
      const { getDocumentProxy, getResolvedPDFJS } = await import('unpdf');
      const pdf = await getDocumentProxy(bytes.slice(), {
        useSystemFonts: false,
      });
      try {
        pages = pdf.numPages;
        if (pages > 50) invalid('Use a PDF with no more than 50 pages');
        const pageTexts: string[] = [];
        const imagePages: number[] = [];
        const { OPS } = await getResolvedPDFJS();
        const imageOps = new Set([
          OPS.paintImageXObject,
          OPS.paintInlineImageXObject,
          OPS.paintImageXObjectRepeat,
          OPS.paintImageMaskXObject,
          OPS.paintImageMaskXObjectRepeat,
          OPS.paintSolidColorImageMask,
        ]);
        for (let n = 1; n <= pages; n++) {
          const page = await pdf.getPage(n);
          const content = await page.getTextContent();
          const lines: string[] = [];
          let line = '';
          let pageText = '';
          for (const item of content.items) {
            if ('str' in item) {
              line += item.str + ' ';
              pageText += item.str;
              if (item.hasEOL) {
                lines.push(line.trim());
                line = '';
              }
            }
          }
          if (line.trim()) lines.push(line.trim());
          pageTexts.push(lines.join('\n'));
          // A PDF can have a searchable header over a scanned report. Treat any
          // image-bearing page conservatively so that header cannot silently
          // hide unread clinical content from the review queue.
          const operators = await page.getOperatorList();
          if (
            !pageText.trim() ||
            operators.fnArray.some((operation) => imageOps.has(operation))
          )
            imagePages.push(n);
        }
        if (imagePages.length) {
          const hadPdfText = pageTexts.some((text) => text.trim());
          if (options.ocrPdf) {
            try {
              const result = await options.ocrPdf(bytes.slice(), imagePages);
              ocr_engine = result.engine;
              ocr_pages = result.pages.filter((p) => p.text.trim()).map((p) => p.page);
              const confidences: number[] = [];
              for (const pageNumber of imagePages) {
                const resultPage = result.pages.find((p) => p.page === pageNumber);
                if (resultPage?.text.trim()) {
                  pageTexts[pageNumber - 1] = resultPage.text.trim();
                  if (resultPage.confidence !== null)
                    confidences.push(resultPage.confidence);
                }
              }
              ocr_confidence = confidences.length
                ? Math.round(
                    (confidences.reduce((sum, value) => sum + value, 0) /
                      confidences.length) *
                      10,
                  ) / 10
                : null;
              const incompletePages = imagePages.filter((n) => {
                const page = result.pages.find((p) => p.page === n);
                return !page?.text.trim() || Boolean(page.issue);
              });
              extraction_method = hadPdfText ? 'mixed' : 'ocr';
              extraction_issue = incompletePages.length
                ? `OCR is incomplete or unreadable on pages ${incompletePages.join(', ')}. Local OCR processes up to 10 scanned pages within its time limit. Review every original page, manually transcribe missing text and verify identity and values before filing.`
                : 'OCR text requires clinician comparison with every original page, patient identity and clinical values before filing.';
            } catch {
              extraction_method = hadPdfText ? 'mixed' : 'unreadable';
              extraction_issue =
                'Local OCR could not process this PDF. Review the original and enter verified text manually before filing.';
            }
          } else {
            extraction_method = hadPdfText ? 'mixed' : 'unreadable';
            extraction_issue =
              'Scanned pages need clinician review. Local OCR runs on the connected server; this standalone preview requires manual transcription from the original.';
          }
        }
        extracted_text = pageTexts.join('\n\n');
        if (extracted_text.length > 100000)
          invalid('Extracted document text is too long');
        if (!extracted_text.trim() && !extraction_issue)
          extraction_issue =
            'No readable text; scanned documents need OCR and manual identity review';
      } finally {
        await pdf.loadingTask.destroy();
      }
    } catch (error) {
      if ((error as any).status === 400) throw error;
      extraction_method = 'unreadable';
      extraction_issue =
        'PDF text could not be read; manual document review required';
    }
  }
  const digest = Array.from(sha256(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return {
    external_id: v.external_id,
    sender: v.sender,
    filename: v.filename,
    format: v.format,
    original_base64: btoa(binary),
    extracted_text,
    digest,
    pages,
    extraction_issue,
    extraction_method,
    ocr_confidence,
    ocr_engine,
    ocr_pages,
  };
}
