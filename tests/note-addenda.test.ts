import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyWorkflowState,
  readWorkflowState,
  type WorkflowContext,
} from '../server/workflow-engine.js';
import { ensurePatientAccounts } from '../server/patient-accounts.js';
import {
  invalidateDocumentResults,
  type NoteResult,
} from '../server/note-results.js';
import {
  guardCorrectionTaskCompletion,
  noteAddendaRequest,
  pendingSignedSourceCorrections,
  signedAddendaForNote,
  type NoteAddendum,
} from '../server/note-addenda.js';

function fixture() {
  const state = emptyWorkflowState();
  let serial = 0;
  const original = {
    id: 'enc-1',
    patient_id: 'pat-1',
    author_id: 'doc-1',
    billing_account_id: 'pba-private-pat-1',
    status: 'Signed',
    signed_at: '2026-10-20T16:00:00Z',
    updated_at: '2026-10-20T16:00:00Z',
    chief_complaint: 'Synthetic evaluation',
    subjective: 'Original narrative',
    objective: 'Original examination',
    assessment: 'Original assessment',
    plan: 'Original plan',
  };
  const ctx: WorkflowContext = {
    user: {
      id: 'doc-1',
      name: 'Dr. Original Author',
      email: 'one@example.test',
      role: 'clinician',
    },
    users: [
      {
        id: 'doc-1',
        name: 'Dr. Original Author',
        email: 'one@example.test',
        role: 'clinician',
      },
      {
        id: 'doc-2',
        name: 'Dr. Other Author',
        email: 'two@example.test',
        role: 'clinician',
      },
    ],
    patients: [{ id: 'pat-1' }, { id: 'pat-2' }],
    encounters: [original],
    appointments: [],
    tasks: [],
    labs: [],
    now: '2026-10-21T16:00:00Z',
    today: '2026-10-21',
    local_time: '09:00',
    id: (prefix) => `${prefix}-${++serial}`,
    audit() {},
  };
  ensurePatientAccounts(state.finance, ctx);
  const result: NoteResult = {
    id: 'result-1',
    source_type: 'Fax',
    encounter_id: original.id,
    patient_id: original.patient_id,
    billing_account_id: original.billing_account_id,
    document_id: 'fax-1',
    source_digest: 'original-byte-digest',
    source_sender: 'Synthetic Imaging',
    source_kind: 'Radiology report',
    received_at: '2026-10-20T15:00:00Z',
    text: 'Exact report copied before signature.',
    status: 'Included',
    revision: 2,
    reviewed_by: ctx.user.id,
    reviewed_at: '2026-10-20T15:30:00Z',
    review_note: 'Original source reviewed',
  };
  state.operations.note_results.push(result);
  state.operations.incoming_faxes.push({
    id: 'fax-1',
    external_id: 'FAX-1',
    sender: 'Synthetic Imaging',
    filename: 'report.txt',
    format: 'text',
    original_base64: '',
    extracted_text: result.text,
    digest: result.source_digest,
    pages: 1,
    extraction_issue: '',
    received_at: result.received_at,
    revision: 3,
    status: 'Filed',
    patient_id: 'pat-1',
    billing_account_id: original.billing_account_id,
    match_reason: 'Verified identity',
    kind: 'Radiology report',
    reviewed_at: result.reviewed_at,
    reviewed_by: ctx.user.id,
    clinical_task_id: '',
    history: [],
  });
  const request = (
    method: string,
    body?: unknown,
    id?: string,
    action?: string,
    encounterId = original.id,
  ) =>
    noteAddendaRequest(
      state,
      ctx,
      method,
      new URL(`http://test/note-addenda?encounter_id=${encounterId}`),
      body,
      id,
      action,
    );
  const content = {
    encounter_id: original.id,
    reason: 'Clarify clinical interpretation',
    text: 'Clarified interpretation and clinical follow-up plan.',
    affected_result_ids: [result.id],
    correction_ids: [] as string[],
  };
  const create = (change: Record<string, unknown> = {}) =>
    request('POST', { ...content, ...change }) as NoteAddendum;
  const sign = (a: NoteAddendum, change: Record<string, unknown> = {}) =>
    request(
      'POST',
      {
        revision: a.revision,
        attested: true,
        signed_name: ctx.user.name,
        ...change,
      },
      a.id,
      'sign',
    ) as NoteAddendum;
  return { state, ctx, original, result, request, content, create, sign };
}
const status = (expected: number) => (e: any) => e.status === expected;

test('addenda require a signed note, clinical access, and its original author', () => {
  const f = fixture();
  f.original.status = 'Draft';
  assert.throws(() => f.create(), status(409));
  f.original.status = 'Signed';
  f.ctx.user = { ...f.ctx.users[1] };
  assert.throws(() => f.create(), status(403));
  f.ctx.user = { ...f.ctx.users[0], role: 'frontdesk' };
  assert.throws(() => f.request('GET'), status(403));
  assert.throws(() => f.request('GET', undefined, 'corrections'), status(403));
  f.ctx.user = { ...f.ctx.users[0], is_active: false };
  assert.throws(() => f.create(), status(403));
  assert.equal(f.state.note_addenda.addenda.length, 0);
});

test('draft revisions, explicit attestation and typed name preserve signed originals and freeze addenda', () => {
  const f = fixture();
  const before = structuredClone({ note: f.original, result: f.result });
  const a = f.create();
  const updated = f.request(
    'PATCH',
    {
      ...f.content,
      revision: a.revision,
      text: 'Updated clarification with independently documented follow-up.',
    },
    a.id,
  ) as NoteAddendum;
  assert.equal(updated.revision, 2);
  assert.equal(updated.history.length, 2);
  assert.equal(updated.history[0].text, f.content.text);
  assert.throws(
    () => f.request('PATCH', { ...f.content, revision: 1 }, a.id),
    status(409),
  );
  assert.throws(() => f.sign(updated, { revision: 1 }), status(409));
  assert.throws(() => f.sign(updated, { attested: false }));
  assert.throws(
    () => f.sign(updated, { signed_name: 'Someone Else' }),
    status(400),
  );
  f.ctx.user = { ...f.ctx.users[1] };
  assert.throws(() => f.sign(updated), status(403));
  f.ctx.user = { ...f.ctx.users[0] };
  const signed = f.sign(updated);
  assert.equal(signed.status, 'Signed');
  assert.equal(signed.history.at(-1)?.action, 'Signed');
  assert.equal(signed.signed_snapshot?.text, updated.text);
  assert.equal(
    signed.signed_snapshot?.original_signed_at,
    f.original.signed_at,
  );
  assert.equal(
    signed.signed_snapshot?.sources[0].source_digest,
    f.result.source_digest,
  );
  assert.deepEqual({ note: f.original, result: f.result }, before);
  assert.throws(
    () => f.request('PATCH', { ...f.content, revision: signed.revision }, a.id),
    status(409),
  );
  assert.throws(() => f.sign(signed), status(409));
  signed.signed_snapshot!.text = 'Changed returned copy';
  assert.equal(
    signedAddendaForNote(f.state, f.original.id)[0].signed_snapshot?.text,
    updated.text,
  );
});

test('fax refiling preserves signed copied results and creates a deduplicated author correction task and alert', () => {
  const f = fixture();
  const before = structuredClone({ note: f.original, result: f.result });
  invalidateDocumentResults(f.state, f.ctx, 'fax-1');
  invalidateDocumentResults(f.state, f.ctx, 'fax-1');
  assert.deepEqual({ note: f.original, result: f.result }, before);
  assert.equal(f.state.note_addenda.corrections.length, 1);
  const correction = f.state.note_addenda.corrections[0];
  assert.equal(correction.author_id, f.original.author_id);
  assert.equal(correction.source.note_result_id, f.result.id);
  assert.equal(correction.filing_revision, 4);
  assert.equal(f.state.tasks.length, 1);
  assert.equal(f.state.tasks[0].owner_id, f.original.author_id);
  assert.equal(f.state.tasks[0].priority, 'High');
  assert.equal(f.state.note_addenda.alerts[0].owner_id, f.original.author_id);
  assert.throws(
    () => guardCorrectionTaskCompletion(f.state, correction.task_id, true),
    status(409),
  );
  assert.equal(
    f.state.operations.alerts.length,
    0,
    'clinical correction details never enter front desk filing alerts',
  );
  f.ctx.user = { ...f.ctx.users[1] };
  assert.deepEqual(f.request('GET', undefined, 'corrections'), {
    corrections: [],
    alerts: [],
  });
  f.ctx.user = { ...f.ctx.users[0] };
  assert.equal(
    (f.request('GET', undefined, 'corrections') as any).alerts.length,
    1,
  );
  const fax = f.state.operations.incoming_faxes[0];
  fax.revision++;
  fax.patient_id = 'pat-2';
  fax.billing_account_id = 'pba-private-pat-2';
  invalidateDocumentResults(f.state, f.ctx, fax.id);
  assert.equal(f.state.note_addenda.corrections.length, 2);
  assert.deepEqual({ note: f.original, result: f.result }, before);
  assert.ok(
    !JSON.stringify(correction).includes('pat-2'),
    'original chart correction excludes the newly filed patient',
  );
});

test('only a scoped signed addendum resolves corrections, alerts and clinical tasks, including after refiling to another patient', () => {
  const f = fixture();
  invalidateDocumentResults(f.state, f.ctx, 'fax-1');
  const c = f.state.note_addenda.corrections[0];
  f.state.operations.incoming_faxes[0].patient_id = 'pat-2';
  f.state.operations.incoming_faxes[0].billing_account_id = 'pba-private-pat-2';
  const unrelated = f.create();
  f.sign(unrelated);
  assert.equal(
    pendingSignedSourceCorrections(f.state, f.original.id).length,
    1,
  );
  const a = f.create({ correction_ids: [c.id], affected_result_ids: [] });
  assert.deepEqual(a.affected_result_ids, [f.result.id]);
  assert.equal(c.status, 'Needs addendum');
  assert.equal(f.state.tasks[0].done, 0);
  const signed = f.sign(a);
  assert.equal(c.status, 'Resolved');
  assert.equal(c.resolved_by_addendum_id, signed.id);
  assert.equal(f.state.tasks[0].done, 1);
  assert.equal(f.state.tasks[0].completed_at, f.ctx.now);
  assert.equal(f.state.note_addenda.alerts[0].resolved_at, f.ctx.now);
  assert.equal(
    pendingSignedSourceCorrections(f.state, f.original.id).length,
    0,
  );
  assert.doesNotThrow(() =>
    guardCorrectionTaskCompletion(f.state, c.task_id, true),
  );
  assert.throws(() => f.create({ correction_ids: [c.id] }), status(409));
  assert.equal(f.result.text, 'Exact report copied before signature.');
  const restored = readWorkflowState(JSON.stringify(f.state));
  assert.deepEqual(restored.note_addenda, f.state.note_addenda);
});

test('correction and affected-result references cannot cross notes, patients or visit accounts', () => {
  const f = fixture();
  invalidateDocumentResults(f.state, f.ctx, 'fax-1');
  const c = f.state.note_addenda.corrections[0];
  f.ctx.encounters.push({
    ...f.original,
    id: 'enc-other',
    patient_id: 'pat-2',
    billing_account_id: 'pba-private-pat-2',
  });
  assert.throws(
    () => f.create({ encounter_id: 'enc-other', correction_ids: [c.id] }),
    status(400),
  );
  assert.throws(() => f.create({ encounter_id: 'enc-other' }), status(400));
  f.result.billing_account_id = 'another-claim';
  assert.throws(() => f.create({ correction_ids: [c.id] }), status(400));
  f.result.billing_account_id = f.original.billing_account_id;
  f.original.billing_account_id = 'pba-private-pat-2';
  assert.throws(() => f.create(), status(400));
  assert.equal(f.state.note_addenda.addenda.length, 0);
});

test('draft result corrections still invalidate editable text; signed extraction corrections retain it with accurate provenance', () => {
  const f = fixture();
  invalidateDocumentResults(f.state, f.ctx, 'fax-1', 'Extracted report text');
  assert.equal(
    f.state.note_addenda.corrections[0].change_type,
    'Extracted report text',
  );
  assert.match(
    f.state.note_addenda.corrections[0].reason,
    /extracted source report text was corrected/,
  );
  assert.equal(f.result.status, 'Included');
  assert.equal(f.result.text, 'Exact report copied before signature.');
  const draft = fixture();
  draft.original.status = 'Draft';
  invalidateDocumentResults(
    draft.state,
    draft.ctx,
    'fax-1',
    'Extracted report text',
  );
  assert.equal(draft.result.status, 'Source changed');
  assert.equal(draft.result.text, '');
  assert.equal(draft.result.reviewed_by, '');
  assert.equal(draft.state.note_addenda.corrections.length, 0);
});
