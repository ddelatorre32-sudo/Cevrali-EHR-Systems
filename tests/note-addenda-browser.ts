import { expect, type Page } from '@playwright/test';

/** Shared by the connected browser test and the standalone preview runner. */
export async function exerciseNoteAddenda(page: Page) {
  page.setDefaultTimeout(10000);
  const name = 'AddendumReview Patient';
  await page.getByRole('button', { name: 'New patient', exact: true }).click();
  let d = page.getByRole('dialog', { name: 'Register a patient', exact: true });
  for (const [label, value] of [
    ['First name', 'AddendumReview'],
    ['Last name', 'Patient'],
    ['Date of birth', '1991-04-03'],
    ['Phone number', '555-0196'],
  ])
    await d.getByLabel(label, { exact: true }).fill(value);
  await d
    .getByRole('button', { name: 'Register patient', exact: true })
    .click();
  const chart = page.getByRole('dialog', {
    name: 'Patient chart',
    exact: true,
  });
  await chart
    .getByRole('button', { name: 'New encounter', exact: true })
    .click();
  d = page.getByRole('dialog', { name: 'Start an encounter', exact: true });
  await d
    .getByLabel('Chief complaint', { exact: true })
    .fill('Synthetic addendum source review');
  await d
    .getByRole('button', { name: 'Create encounter', exact: true })
    .click();
  let note = page.getByRole('dialog', {
    name: 'Document encounter',
    exact: true,
  });
  for (const [label, value] of [
    ['Subjective', 'Synthetic original clinical history.'],
    ['Objective', 'Synthetic original examination.'],
    ['Assessment', 'Original independent assessment.'],
    ['Plan', 'Original independent follow-up plan.'],
  ])
    await note
      .locator('.soap-label')
      .filter({ hasText: label })
      .locator('textarea')
      .fill(value);
  await note.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(
    note.getByText('All changes saved', { exact: true }),
  ).toBeVisible();
  await note.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await page.getByRole('button', { name: 'Fax inbox', exact: true }).click();
  await page
    .getByRole('button', { name: 'Receive demo fax', exact: true })
    .click();
  d = page.getByRole('dialog', { name: 'Receive a demo fax', exact: true });
  await d
    .getByLabel('Sending facility', { exact: true })
    .fill('Synthetic Addendum Imaging');
  await d
    .getByLabel('Facility fax reference', { exact: true })
    .fill('ADDENDUM-SOURCE-01');
  await d
    .getByLabel('Received document text', { exact: true })
    .fill(
      [
        `Patient Name: ${name}`,
        'DOB: 1991-04-03',
        'Document Type: Radiology report',
        '',
        'Synthetic original source result copied into the signed note.',
      ].join('\n'),
    );
  await d
    .getByRole('button', { name: 'Process demo fax', exact: true })
    .click();
  await expect(d).not.toBeVisible();
  const fax = page
    .locator('.finance-card')
    .filter({ hasText: 'ADDENDUM-SOURCE-01' });
  await expect(fax).toContainText('Saved to chart');

  async function openNote(signed = true) {
    await page.getByRole('button', { name: 'Encounters', exact: true }).click();
    await page
      .getByRole('row')
      .filter({ hasText: name })
      .getByRole('button', {
        name: signed ? 'View note' : 'Continue note',
        exact: true,
      })
      .click();
    return page.getByRole('dialog', {
      name: signed ? 'Signed encounter' : 'Document encounter',
      exact: true,
    });
  }
  note = await openNote(false);
  await note
    .getByRole('button', { name: 'Review and include report', exact: true })
    .click();
  await expect(
    note
      .locator('.received-note-results')
      .getByText('Included', { exact: true }),
  ).toBeVisible();
  await note.getByRole('button', { name: 'Sign note', exact: true }).click();
  await note
    .getByRole('button', { name: 'Confirm signature', exact: true })
    .click();
  await expect(note).not.toBeVisible();

  await page.getByRole('button', { name: 'Fax inbox', exact: true }).click();
  await fax
    .getByRole('button', { name: 'Review received fax', exact: true })
    .click();
  d = page.getByRole('dialog', { name: 'Received fax document', exact: true });
  await d
    .getByLabel('Filing / correction reason', { exact: true })
    .fill('Confirmed original document identity and corrected filing context.');
  await d
    .getByLabel('I reviewed the original and verified the patient and claim.', {
      exact: true,
    })
    .check();
  await d
    .getByRole('button', { name: 'Confirm and file document', exact: true })
    .click();
  await expect(d).not.toBeVisible();

  note = await openNote();
  const addenda = note.getByRole('region', {
    name: 'Note addenda and source corrections',
    exact: true,
  });
  await expect(
    addenda.getByText('Signed source needs clinical review', { exact: true }),
  ).toBeVisible();
  await expect(note.locator('.received-note-results')).toContainText(
    'Synthetic original source result copied into the signed note.',
  );
  await addenda
    .getByRole('button', { name: 'Document correction', exact: true })
    .click();
  d = page.getByRole('dialog', { name: 'Add note addendum', exact: true });
  await d
    .getByLabel('Clarification and clinical impact', { exact: true })
    .fill(
      'Reviewed the original source and its filing correction. The original clinical assessment remains independently documented.',
    );
  await d
    .getByRole('button', { name: 'Save draft addendum', exact: true })
    .click();
  await expect(d).not.toBeVisible();
  await expect(
    addenda.getByText('Signed source needs clinical review', { exact: true }),
  ).toBeVisible();
  await addenda
    .getByRole('button', { name: 'Review and sign', exact: true })
    .click();
  d = page.getByRole('dialog', {
    name: 'Review and sign addendum',
    exact: true,
  });
  await d
    .getByLabel(
      'I reviewed this addendum and its referenced sources and attest that the clarification is accurate.',
      { exact: true },
    )
    .check();
  const signature = d.getByRole('textbox');
  const label = await d
    .locator('label')
    .filter({ hasText: 'Type your full account name:' })
    .innerText();
  await signature.fill(
    label.replace('Type your full account name:', '').trim(),
  );
  await d.getByRole('button', { name: 'Sign addendum', exact: true }).click();
  await expect(d).not.toBeVisible();
  await expect(
    addenda.getByText('Signed source needs clinical review', { exact: true }),
  ).toHaveCount(0);
  await expect(addenda.getByText('Signed', { exact: true })).toBeVisible();
  await expect(
    addenda.getByRole('button', { name: 'Edit draft', exact: true }),
  ).toHaveCount(0);
  await expect(
    note
      .locator('.soap-label')
      .filter({ hasText: 'Assessment' })
      .locator('textarea'),
  ).toHaveValue('Original independent assessment.');
  await note.getByRole('button', { name: 'Close dialog', exact: true }).click();
  // The standalone page deliberately resets its in-memory demo on reload.
  // Connected mode also verifies that the persisted snapshot survives a reload.
  if (/^https?:/.test(page.url())) await page.reload();
  note = await openNote();
  await expect(
    note.getByRole('region', {
      name: 'Note addenda and source corrections',
      exact: true,
    }),
  ).toContainText('Reviewed the original source and its filing correction.');
  await expect(note.locator('.received-note-results')).toContainText(
    'Synthetic original source result copied into the signed note.',
  );
}
