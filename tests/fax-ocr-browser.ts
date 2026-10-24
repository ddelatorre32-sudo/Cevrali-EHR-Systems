import { expect, type Page } from '@playwright/test';

/** Shared connected/offline flow. The same real image-only PDF exercises
 * Tesseract on the server and the explicit manual-transcription fallback in
 * standalone preview; this helper makes no network requests of its own. */
export async function exerciseFaxOcr(page: Page) {
  page.setDefaultTimeout(15000);
  const name = 'OcrReview Patient';
  await page.getByRole('button', { name: 'New patient', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Register a patient', exact: true });
  for (const [label, value] of [
    ['First name', 'OcrReview'], ['Last name', 'Patient'],
    ['Date of birth', '1991-05-06'], ['Phone number', '555-0195'],
  ]) await dialog.getByLabel(label, { exact: true }).fill(value);
  await dialog.getByRole('button', { name: 'Register patient', exact: true }).click();
  const chart = page.getByRole('dialog', { name: 'Patient chart', exact: true });
  await chart.getByRole('button', { name: 'New encounter', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Start an encounter', exact: true });
  await dialog.getByLabel('Chief complaint', { exact: true }).fill('Synthetic scanned result review');
  await dialog.getByRole('button', { name: 'Create encounter', exact: true }).click();
  let note = page.getByRole('dialog', { name: 'Document encounter', exact: true });
  await note.locator('.soap-label').filter({ hasText: 'Assessment' }).locator('textarea')
    .fill('Independent clinician assessment.');
  await note.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(note.getByText('All changes saved', { exact: true })).toBeVisible();
  await note.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await page.getByRole('button', { name: 'Fax inbox', exact: true }).click();
  await page.getByRole('button', { name: 'Receive demo fax', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Receive a demo fax', exact: true });
  const examplePatient = dialog.getByRole('combobox', { name: 'Example patient', exact: true });
  await examplePatient.selectOption({ label: name });
  const patientId = await examplePatient.inputValue();
  await dialog.getByRole('button', { name: 'Receive scanned PDF example', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const fax = page.locator('.finance-card').filter({ hasText: 'Synthetic OCR Demonstration Facility' });
  await expect(fax).toContainText('Needs review');
  await expect(fax).not.toContainText('Saved to chart');
  await fax.getByRole('button', { name: 'Review received fax', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Received fax document', exact: true });
  await expect(dialog.getByRole('button', { name: 'Download original document', exact: true })).toBeEnabled();
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download original document', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
  const standalone = await dialog.getByText(/standalone preview requires manual transcription/).first().isVisible();
  if (standalone) {
    await expect(dialog.locator('.ops-document-text')).toContainText('No readable text');
  } else {
    await expect(dialog).toContainText('Local Tesseract');
    await expect(dialog.locator('.ops-document-text')).toContainText('4.2 mmol/L');
    await expect(dialog).toContainText('OCR confidence');
  }
  await expect(dialog.getByRole('button', { name: 'Confirm and file document', exact: true })).toBeDisabled();
  await dialog.getByRole('combobox', { name: 'Document type', exact: true }).selectOption('Lab report');
  const verifiedText = [
    'SYNTHETIC LABORATORY REPORT - DEMONSTRATION ONLY', '',
    `Patient Name: ${name}`, 'DOB: 1991-05-06', 'Document Type: Lab report', '',
    'Synthetic result: 4.2 mmol/L',
    'This example does not contain a clinical finding.',
    'Compare all extracted text with this original image.',
    'Provider review is required before chart filing.',
  ].join('\n');
  await dialog.getByRole('textbox', { name: 'Verified extracted text / manual transcription', exact: true }).fill(verifiedText);
  await dialog.getByRole('textbox', { name: 'Review / correction reason', exact: true })
    .fill('Compared original image, patient identity, decimal value, units and document classification.');
  const identity = dialog.getByLabel('I reviewed the original and verified patient identifiers.', { exact: true });
  const values = dialog.getByLabel('I compared every original page and verified all text, values, units and document type.', { exact: true });
  await identity.check();
  await expect(values).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Save verified classification and text', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Confirm and file document', exact: true })).toBeDisabled();
  await values.check();
  await dialog.getByRole('button', { name: 'Save verified classification and text', exact: true }).click();
  await expect(dialog.locator('.inline-success').filter({ hasText: /^Extraction verified by Dr\./ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Confirm and file document', exact: true })).toBeEnabled();
  await dialog.getByRole('combobox', { name: 'File to patient', exact: true }).selectOption(patientId);
  await dialog.getByLabel('Filing / correction reason', { exact: true })
    .fill('Original identifiers and private patient chart confirmed.');
  await dialog.getByLabel('I reviewed the original and verified the patient and claim.', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Confirm and file document', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(fax).toContainText('Saved to chart');
  await expect(fax).toContainText(name);

  await page.getByRole('button', { name: 'Encounters', exact: true }).click();
  await page.getByRole('row').filter({ hasText: name })
    .getByRole('button', { name: 'Continue note', exact: true }).click();
  note = page.getByRole('dialog', { name: 'Document encounter', exact: true });
  await expect(note.locator('.received-note-results')).toContainText('4.2 mmol/L');
  await expect(note.locator('.received-note-results')).toContainText('Pending review');
  await expect(note.locator('.soap-label').filter({ hasText: 'Assessment' }).locator('textarea'))
    .toHaveValue('Independent clinician assessment.');
  await note.getByRole('button', { name: 'Review and include report', exact: true }).click();
  await expect(note.locator('.received-note-results').getByText('Included', { exact: true })).toBeVisible();
  await note.getByRole('button', { name: 'Close dialog', exact: true }).click();
}
