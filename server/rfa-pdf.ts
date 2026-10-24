import { PDFDocument, PDFName, PDFSignature, PDFFont, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { rfaDisplayTime, type RfaPacket } from './rfa-engine.js';

const date = (d: string) =>
  /^\d{4}-\d{2}-\d{2}/.test(d)
    ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`
    : d;
export async function generateRfaPdf(
  packet: RfaPacket,
  template: Uint8Array,
  fontBytes: Uint8Array,
) {
  const pdf = await PDFDocument.load(template);
  pdf.registerFontkit(fontkit);
  pdf.catalog.delete(PDFName.of('OpenAction'));
  pdf.catalog.delete(PDFName.of('Names'));
  pdf.catalog.delete(PDFName.of('StructTreeRoot'));
  pdf.catalog.delete(PDFName.of('MarkInfo'));
  const font = await pdf.embedFont(fontBytes, { subset: true });
  const chars = new Set(font.getCharacterSet());
  const check = (s: string) => {
    for (const c of s)
      if (!['\n', '\r', '\t'].includes(c) && !chars.has(c.codePointAt(0)!))
        throw new Error(
          `The PDF font cannot render character ${c}; review the text before exporting.`,
        );
    return s.replace(/\r\n?/g, '\n').replaceAll('\t', ' ');
  };
  const form = pdf.getForm();
  for (const f of [...form.getFields()])
    if (f instanceof PDFSignature) form.removeField(f);
  const put = (name: string, value: string) => {
    const f = form.getTextField(name);
    f.setText(check(value || ''));
    f.setFontSize(0);
  };
  const claim = packet.account.workers_comp!;
  const physician = packet.physician;
  const recipient = packet.recipient;
  const map: Record<string, string> = {
    'Employee Last Name': packet.patient.last_name,
    'Employee First Name': packet.patient.first_name,
    'Date of Injury (MM/DD/YYYY)': date(claim.date_of_injury),
    'Date of Birth (MM/DD/YYYY)': date(packet.patient.dob),
    'Claim Number': claim.claim_number,
    Employer: claim.employer,
    'Requesting Physician Name': physician.name,
    'Practice Name': physician.practice_name,
    'Contact Name': physician.contact_name,
    'Requesting Physician Address': physician.address,
    'Requesting Physician City': physician.city,
    'Requesting Physician State': physician.state,
    'Requesting Physician Zip Code': physician.zip,
    'Requesting Physician Phone': physician.phone,
    'Requesting Physician Fax Number': physician.fax,
    'Requesting Physician E-mail Address': physician.email,
    Specialty: physician.specialty,
    'NPI Number': physician.npi,
    'Company Name': recipient.name,
    'Contact Name 2': recipient.contact_name,
    'Claims Administrator Address': recipient.address,
    'Claims Administrator City': recipient.city,
    'Claims Administrator State': recipient.state,
    'Claims Administrator Zip Code': recipient.zip,
    'Claims Administrator Phone': recipient.phone,
    'Claims Administrator Fax Number': recipient.fax,
    'Claims Administrator E-mail Address': recipient.email,
    'Date (MM/DD/YYYY)': packet.signed_at ? date(packet.signature_date) : '',
  };
  for (const [k, v] of Object.entries(map)) put(k, v);
  const checkbox = (name: string, yes: boolean) => {
    const f = form.getCheckBox(name);
    if (yes) f.check();
    else f.uncheck();
  };
  checkbox('New Request', packet.request_type === 'New request');
  checkbox(
    'Resubmission – Change in Material Facts',
    packet.request_type === 'Resubmission',
  );
  checkbox(
    'Expedited Review Check box if employee faces an imminent and serious threat to his or her health',
    packet.expedited,
  );
  checkbox(
    'Check box if request is a written confirmation of a prior oral request',
    packet.oral_confirmation,
  );
  // The form has narrow single-line rows. Never truncate long treatment text:
  // refer to the complete continuation sheet instead of shrinking it beyond readability.
  const fit = (field: string, value: string, row: number) => {
    const f = form.getTextField(field);
    const width = f.acroField.getWidgets()[0].getRectangle().width - 5;
    const text = check(value);
    f.setFontSize(8);
    f.setText(
      !text.includes('\n') && font.widthOfTextAtSize(text, 8) <= width
        ? text
        : `See service ${row}, p. 3+`,
    );
  };
  packet.services.slice(0, 5).forEach((s, i) => {
    const n = i + 1;
    fit(`Diagnosis (Required) Row ${n}`, s.diagnosis, n);
    fit(`ICD-Code (Required) Row ${n}`, s.icd_code, n);
    fit(`Service or Good Requested (Required) Row ${n}`, s.service, n);
    fit(`CPT or HCPCS Code (If known) Row ${n}`, s.cpt_code, n);
    fit(
      `Other Information: (Frequency, Duration Quantity, etc.) Row ${n}`,
      `Qty ${s.quantity}; ${s.frequency}; ${s.duration}`,
      n,
    );
  });
  form.updateFieldAppearances(font);
  form.flatten({ updateFieldAppearances: false });
  pdf.catalog.delete(PDFName.of('AcroForm'));
  for (const p of pdf.getPages()) p.node.delete(PDFName.of('Annots'));
  if (packet.signed_at)
    pdf
      .getPages()[0]
      .drawText(
        check(
          font.widthOfTextAtSize(`/s/ ${packet.signed_by}`, 9) <= 231
            ? `/s/ ${packet.signed_by}`
            : '/s/ Provider signature: see attached narrative',
        ),
        {
          x: 184,
          y: 194,
          size: 9,
          font,
          maxWidth: 231,
          color: rgb(0, 0, 0),
        },
      );
  let page = pdf.addPage([612, 792]);
  let y = 734;
  const width = 524;
  function nextPage() {
    page = pdf.addPage([612, 792]);
    y = 734;
  }
  function line(text: string, size = 10, bold = false) {
    if (y < 60) nextPage();
    page.drawText(check(text), {
      x: 44,
      y,
      size,
      font,
      color: bold ? rgb(0.12, 0.28, 0.24) : rgb(0.12, 0.12, 0.12),
    });
    y -= size + 5;
  }
  function paragraph(title: string, value: string) {
    if (y < 105) nextPage();
    line(title, 11, true);
    const clean = check(value || 'Not documented');
    for (const raw of clean.split('\n')) {
      if (!raw) {
        y -= 8;
        continue;
      }
      let out = '';
      for (const word of raw.split(/\s+/)) {
        if (
          font.widthOfTextAtSize([out, word].filter(Boolean).join(' '), 10) <=
          width
        )
          out = [out, word].filter(Boolean).join(' ');
        else {
          if (out) line(out);
          out = '';
          let chunk = '';
          for (const char of word) {
            if (font.widthOfTextAtSize(chunk + char, 10) > width) {
              line(chunk);
              chunk = '';
            }
            chunk += char;
          }
          out = chunk;
        }
      }
      if (out) line(out);
    }
    y -= 9;
  }
  paragraph(
    'Treatment request continuation',
    `Patient: ${packet.patient.last_name}, ${packet.patient.first_name} | Claim: ${claim.claim_number}\nRequested by ${physician.name} | ${packet.request_type}\nAll requested services are reproduced below in full. The first five also appear on form page 1.`,
  );
  packet.services.forEach((s, i) =>
    paragraph(
      `Service ${i + 1}: ${s.category}`,
      `Diagnosis: ${s.diagnosis}\nICD-10-CM: ${s.icd_code || 'Not entered'}\nRequested service: ${s.service}\nCPT/HCPCS: ${s.cpt_code || 'Unknown / not specified'}\nQuantity: ${s.quantity}\nFrequency: ${s.frequency}\nDuration: ${s.duration}`,
    ),
  );
  paragraph(
    'Medical necessity / treatment rationale reviewed by physician',
    packet.clinical_rationale,
  );
  paragraph(
    'Complete requesting physician contact information',
    `${physician.name}\n${physician.practice_name}; ${physician.specialty}; treating physician NPI ${physician.npi}\n${physician.address}\n${physician.city}, ${physician.state} ${physician.zip}\nContact: ${physician.contact_name}; phone ${physician.phone}; fax ${physician.fax}; email ${physician.email}`,
  );
  paragraph(
    'Designated claims administrator recipient',
    `${recipient.name}; contact ${recipient.contact_name}\n${recipient.address}\n${recipient.city}, ${recipient.state} ${recipient.zip}\nPhone ${recipient.phone}; fax ${recipient.fax}; email ${recipient.email}`,
  );
  if (packet.request_type === 'Resubmission')
    paragraph(
      'Change in material facts supporting resubmission',
      packet.material_change,
    );
  if (packet.expedited)
    paragraph('Clinical support for expedited review', packet.expedited_reason);
  if (packet.oral_confirmation)
    paragraph(
      'Confirmation of prior oral request',
      packet.oral_request_details,
    );
  nextPage();
  const note = packet.note;
  const wc = note.wc_documentation;
  paragraph(
    'Supporting signed clinical narrative',
    `Equivalent narrative generated from the signed encounter; this is not a PR-2 or DLSR 5021 form.\nPatient: ${packet.patient.last_name}, ${packet.patient.first_name}; DOB ${date(packet.patient.dob)}\nClaim ${claim.claim_number}; injury ${date(claim.date_of_injury)}; employer ${claim.employer}\nSource encounter ${packet.encounter_id}\nDocumenting physician: ${physician.name}\nSource clinical note signed: ${rfaDisplayTime(note.signed_at)}\nRFA provider attestation: ${packet.signed_at ? `${packet.signed_by} at ${rfaDisplayTime(packet.signed_at)}` : 'Draft — no RFA signature yet'}`,
  );
  for (const [title, value] of [
    ['Chief complaint', note.chief_complaint],
    ['Subjective', note.subjective],
    ['Objective', note.objective],
    ['Assessment', note.assessment],
    ['Plan', note.plan],
  ] as [string, string][])
    paragraph(title, value);
  for (const a of note.signed_addenda || []) {
    const content = a.signed_snapshot ?? a;
    paragraph(
      `Signed addendum — ${a.author_name}`,
      `Signed ${rfaDisplayTime(a.signed_at)}; original note unchanged\nReason: ${content.reason}\n${content.text}`,
    );
  }
  if (wc) {
    for (const r of note.received_results || [])
      paragraph(
        `Received ${r.source_kind} — ${r.source_sender}`,
        `Source ${r.document_id}; received ${rfaDisplayTime(r.received_at)}; reviewed ${rfaDisplayTime(r.reviewed_at)}\n${r.text}`,
      );
    paragraph(
      'Accepted body parts at documentation',
      note.billing_account_snapshot?.workers_comp?.accepted_body_parts?.join(
        '; ',
      ) || claim.accepted_body_parts.join('; '),
    );
    paragraph(
      'Accepted body parts addressed in this visit',
      wc.addressed_body_parts?.join('; '),
    );
    paragraph('Injury history and mechanism', wc.injury_history);
    paragraph('Relationship to work injury', wc.work_related_assessment);
    paragraph(
      'Work status / restrictions',
      `${wc.work_status}\n${wc.restrictions || 'No additional restrictions documented'}\nNext review: ${wc.next_review_date || 'Not specified'}`,
    );
  }
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawText(
      `CEVRALI DEMO - NOT FAXED | ${packet.status === 'Draft' ? 'DRAFT - UNSIGNED RFA' : 'PROVIDER ATTESTED RFA'}`,
      { x: 32, y: 779, size: 8, font, color: rgb(0.55, 0.12, 0.12) },
    );
    p.drawText(
      `Packet ${packet.id} | revision ${packet.revision} | ${i + 1} of ${pages.length}`,
      { x: 32, y: 20, size: 7, font, color: rgb(0.35, 0.35, 0.35) },
    );
  });
  pdf.setTitle('DWC RFA and supporting clinical narrative - demo');
  pdf.setAuthor(physician.name);
  pdf.setSubject('DEMO ONLY - no fax transmitted');
  pdf.setProducer('Cevrali RFA generator');
  return pdf.save({ useObjectStreams: false });
}
