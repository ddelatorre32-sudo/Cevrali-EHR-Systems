import { PDFDocument } from 'pdf-lib';

/** A real image-only PDF for exercising local OCR. These words are rendered
 * into pixels; the resulting PDF deliberately has no searchable text layer. */
export async function scannedFaxExample(patient: {
  id: string;
  first_name: string;
  last_name: string;
  dob: string;
}) {
  const canvas = document.createElement('canvas');
  canvas.width = 1700;
  canvas.height = 2200;
  const context = canvas.getContext('2d');
  if (!context) throw Error('This browser cannot create the scanned example');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000';
  context.font = '30px Arial, sans-serif';
  const lines = [
    'SYNTHETIC LABORATORY REPORT - DEMONSTRATION ONLY',
    '',
    `Patient Name: ${patient.first_name} ${patient.last_name}`,
    `DOB: ${patient.dob}`,
    'Document Type: Lab report',
    '',
    'Synthetic result: 4.2 mmol/L',
    'This example does not contain a clinical finding.',
    'Compare all extracted text with this original image.',
    'Provider review is required before chart filing.',
  ];
  lines.forEach((line, index) => context.fillText(line, 90, 140 + index * 62));
  const png = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),
    (character) => character.charCodeAt(0));
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(png);
  pdf.addPage([612, 792]).drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  const bytes = await pdf.save();
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
