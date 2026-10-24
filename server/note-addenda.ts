import { z } from 'zod';
import { patientAccount } from './patient-accounts.js';
import type { NoteResult } from './note-results.js';
import type { WorkflowContext, WorkflowState } from './workflow-engine.js';

const fail = (status: number, message: string): never => {
  throw Object.assign(new Error(message), { status });
};
const account = (n: Record<string, any>) =>
  n.billing_account_id || `pba-private-${n.patient_id}`;

export type AddendumSource = {
  note_result_id: string;
  document_id: string;
  source_type: 'Fax' | 'Lab result';
  source_digest: string;
  source_sender: string;
  source_kind: string;
  received_at: string;
  copied_revision: number;
};
export type SignedNoteCorrection = {
  id: string;
  encounter_id: string;
  patient_id: string;
  billing_account_id: string;
  author_id: string;
  source: AddendumSource;
  filing_revision: number;
  change_type: 'Filing' | 'Extracted report text';
  status: 'Needs addendum' | 'Resolved';
  reason: string;
  created_at: string;
  original_signed_at: string;
  resolved_at: string | null;
  resolved_by_addendum_id: string | null;
  task_id: string;
};
export type AddendumContent = {
  reason: string;
  text: string;
  correction_ids: string[];
  affected_result_ids: string[];
};
export type NoteAddendum = AddendumContent & {
  id: string;
  encounter_id: string;
  patient_id: string;
  billing_account_id: string;
  author_id: string;
  author_name: string;
  status: 'Draft' | 'Signed';
  revision: number;
  created_at: string;
  updated_at: string;
  signed_at: string | null;
  signed_name: string;
  signed_snapshot:
    | (AddendumContent & {
        original_signed_at: string;
        sources: AddendumSource[];
      })
    | null;
  history: (AddendumContent & {
    at: string;
    actor_id: string;
    action: 'Created' | 'Edited' | 'Signed';
    revision: number;
  })[];
};
export type NoteCorrectionAlert = {
  id: string;
  correction_id: string;
  encounter_id: string;
  owner_id: string;
  title: string;
  created_at: string;
  resolved_at: string | null;
};
export type NoteAddendaState = {
  addenda: NoteAddendum[];
  corrections: SignedNoteCorrection[];
  alerts: NoteCorrectionAlert[];
};
export const emptyNoteAddendaState = (): NoteAddendaState => ({
  addenda: [],
  corrections: [],
  alerts: [],
});
function data(state: WorkflowState): NoteAddendaState {
  return (state.note_addenda ||= emptyNoteAddendaState());
}
function clinical(ctx: WorkflowContext) {
  if (
    ctx.user.role !== 'clinician' ||
    ctx.user.is_active === 0 ||
    ctx.user.is_active === false
  )
    fail(403, 'Active clinical access required');
}
function encounter(state: WorkflowState, ctx: WorkflowContext, id: string) {
  const n =
    ctx.encounters.find((n) => n.id === id) || fail(404, 'Encounter not found');
  if (!ctx.patients.some((p) => p.id === n.patient_id))
    fail(404, 'Patient not found');
  patientAccount(state.finance, n.patient_id, account(n));
  return n;
}
function signedEncounter(
  state: WorkflowState,
  ctx: WorkflowContext,
  id: string,
) {
  const n = encounter(state, ctx, id);
  if (n.status !== 'Signed' || !n.signed_at)
    fail(409, 'An addendum requires an existing signed note');
  return n;
}
function author(ctx: WorkflowContext, n: Record<string, any>) {
  if (n.author_id !== ctx.user.id)
    fail(403, 'Only the original note author can create or sign its addenda');
}
function source(r: NoteResult): AddendumSource {
  return {
    note_result_id: r.id,
    document_id: r.document_id,
    source_type: r.source_type || 'Fax',
    source_digest: r.source_digest,
    source_sender: r.source_sender,
    source_kind: r.source_kind,
    received_at: r.received_at,
    copied_revision: r.revision,
  };
}
function resultForNote(
  state: WorkflowState,
  n: Record<string, any>,
  id: string,
) {
  const r =
    state.operations.note_results.find((r) => r.id === id) ||
    fail(404, 'Referenced received result not found');
  if (
    r.encounter_id !== n.id ||
    r.patient_id !== n.patient_id ||
    r.billing_account_id !== account(n) ||
    r.status !== 'Included'
  )
    fail(
      400,
      'Referenced result must have been included in this signed note and visit account',
    );
  return r;
}
function correctionForNote(
  state: WorkflowState,
  n: Record<string, any>,
  id: string,
) {
  const c =
    data(state).corrections.find((c) => c.id === id) ||
    fail(404, 'Source correction not found');
  if (
    c.encounter_id !== n.id ||
    c.patient_id !== n.patient_id ||
    c.billing_account_id !== account(n)
  )
    fail(
      400,
      'Source correction must belong to this signed note and visit account',
    );
  const r = resultForNote(state, n, c.source.note_result_id);
  if (
    r.document_id !== c.source.document_id ||
    r.source_digest !== c.source.source_digest ||
    r.revision !== c.source.copied_revision
  )
    fail(
      409,
      'The signed source snapshot no longer matches its correction reference',
    );
  return c;
}

/** Called before a fax is refiled. Never changes the signed note or its copied text. */
export function flagSignedSourceCorrection(
  state: WorkflowState,
  ctx: WorkflowContext,
  r: NoteResult,
  changeType: SignedNoteCorrection['change_type'] = 'Filing',
) {
  const n = ctx.encounters.find((n) => n.id === r.encounter_id);
  if (
    !n ||
    n.status !== 'Signed' ||
    !n.signed_at ||
    r.status !== 'Included' ||
    r.source_type === 'Lab result'
  )
    return;
  if (n.patient_id !== r.patient_id || account(n) !== r.billing_account_id)
    return;
  const s = data(state);
  const fax = state.operations.incoming_faxes.find(
    (f) => f.id === r.document_id,
  );
  const filingRevision = (fax?.revision || 0) + 1;
  const existing = s.corrections.find(
    (c) =>
      c.source.note_result_id === r.id && c.filing_revision === filingRevision,
  );
  if (existing) return existing;
  const correction: SignedNoteCorrection = {
    id: ctx.id('note-correction'),
    encounter_id: n.id,
    patient_id: n.patient_id,
    billing_account_id: account(n),
    author_id: n.author_id,
    source: source(r),
    filing_revision: filingRevision,
    change_type: changeType,
    status: 'Needs addendum',
    reason: `${changeType === 'Filing' ? 'The source document patient or claim filing was reviewed or changed' : 'The extracted source report text was corrected'} after this note was signed. Review the copied result and document its clinical relevance or correction in a signed addendum. The original signed note and copied result remain unchanged.`,
    created_at: ctx.now,
    original_signed_at: n.signed_at,
    resolved_at: null,
    resolved_by_addendum_id: null,
    task_id: ctx.id('task'),
  };
  s.corrections.push(correction);
  state.tasks.push({
    id: correction.task_id,
    patient_id: n.patient_id,
    title: 'Review source correction in signed note',
    category: 'Signed note correction',
    priority: 'High',
    done: 0,
    owner_id: n.author_id,
    due_date: ctx.today,
    created_at: ctx.now,
    completed_at: null,
    source_key: `note-correction:${correction.id}`,
  });
  s.alerts.push({
    id: ctx.id('note-alert'),
    correction_id: correction.id,
    encounter_id: n.id,
    owner_id: n.author_id,
    title: 'Signed note source requires an addendum review',
    created_at: ctx.now,
    resolved_at: null,
  });
  ctx.audit(
    'Flagged signed note for source correction; signed content retained',
    n.id,
  );
  return correction;
}
export function pendingSignedSourceCorrections(
  state: WorkflowState,
  encounterId: string,
) {
  return structuredClone(
    data(state).corrections.filter(
      (c) => c.encounter_id === encounterId && c.status === 'Needs addendum',
    ),
  );
}
export function signedAddendaForNote(
  state: WorkflowState,
  encounterId: string,
) {
  return structuredClone(
    data(state).addenda.filter(
      (a) => a.encounter_id === encounterId && a.status === 'Signed',
    ),
  );
}
export function guardCorrectionTaskCompletion(
  state: WorkflowState,
  taskId: string,
  done?: boolean,
) {
  if (
    done &&
    data(state).corrections.some(
      (c) => c.task_id === taskId && c.status === 'Needs addendum',
    )
  )
    fail(409, 'Sign a source correction addendum to complete this task');
}

const contentInput = z.object({
  reason: z.string().trim().min(5).max(1000),
  text: z.string().trim().min(10).max(30000),
  correction_ids: z.array(z.string().min(1)).max(50).default([]),
  affected_result_ids: z.array(z.string().min(1)).max(50).default([]),
});
function validatedContent(
  state: WorkflowState,
  n: Record<string, any>,
  input: AddendumContent,
) {
  const content: AddendumContent = {
    reason: input.reason,
    text: input.text,
    correction_ids: [...input.correction_ids],
    affected_result_ids: [...input.affected_result_ids],
  };
  content.correction_ids = [...new Set(content.correction_ids)];
  const results = new Set(content.affected_result_ids);
  for (const id of content.correction_ids) {
    const c = correctionForNote(state, n, id);
    if (c.status !== 'Needs addendum')
      fail(409, 'This source correction already has a signed addendum');
    results.add(c.source.note_result_id);
  }
  content.affected_result_ids = [...results];
  for (const id of content.affected_result_ids) resultForNote(state, n, id);
  return content;
}
function record(
  a: NoteAddendum,
  ctx: WorkflowContext,
  action: 'Created' | 'Edited' | 'Signed',
) {
  a.history.push({
    at: ctx.now,
    actor_id: ctx.user.id,
    action,
    revision: a.revision,
    reason: a.reason,
    text: a.text,
    correction_ids: [...a.correction_ids],
    affected_result_ids: [...a.affected_result_ids],
  });
}
function editable(state: WorkflowState, ctx: WorkflowContext, id: string) {
  const a =
    data(state).addenda.find((a) => a.id === id) ||
    fail(404, 'Addendum not found');
  const n = signedEncounter(state, ctx, a.encounter_id);
  author(ctx, n);
  if (a.author_id !== ctx.user.id)
    fail(403, 'Only the addendum author can edit or sign it');
  if (a.patient_id !== n.patient_id || a.billing_account_id !== account(n))
    fail(
      409,
      'Addendum patient or visit account no longer matches the signed note',
    );
  if (a.status === 'Signed')
    fail(
      409,
      'Signed addenda are immutable. Create a new addendum for further corrections.',
    );
  return { a, n };
}

export function noteAddendaRequest(
  state: WorkflowState,
  ctx: WorkflowContext,
  method: string,
  url: URL,
  body: unknown,
  id?: string,
  action?: string,
) {
  clinical(ctx);
  const s = data(state);
  if (method === 'GET' && id === 'corrections') {
    const encounterId = url.searchParams.get('encounter_id');
    if (encounterId) encounter(state, ctx, encounterId);
    return {
      corrections: structuredClone(
        s.corrections.filter(
          (c) =>
            c.author_id === ctx.user.id &&
            c.status === 'Needs addendum' &&
            (!encounterId || c.encounter_id === encounterId),
        ),
      ),
      alerts: structuredClone(
        s.alerts.filter(
          (a) =>
            a.owner_id === ctx.user.id &&
            !a.resolved_at &&
            (!encounterId || a.encounter_id === encounterId),
        ),
      ),
    };
  }
  if (method === 'GET' && !id) {
    const n = encounter(state, ctx, url.searchParams.get('encounter_id') || '');
    return {
      encounter_id: n.id,
      note_status: n.status,
      original_signed_at: n.signed_at || null,
      author_name:
        ctx.users.find((u) => u.id === n.author_id)?.name || 'Original author',
      can_edit: n.status === 'Signed' && n.author_id === ctx.user.id,
      addenda: structuredClone(
        s.addenda.filter((a) => a.encounter_id === n.id),
      ),
      corrections: structuredClone(
        s.corrections.filter((c) => c.encounter_id === n.id),
      ),
      sources: state.operations.note_results
        .filter(
          (r) =>
            r.encounter_id === n.id &&
            r.status === 'Included' &&
            r.patient_id === n.patient_id &&
            r.billing_account_id === account(n),
        )
        .map(source),
    };
  }
  if (method === 'POST' && !id) {
    const v = contentInput
      .extend({ encounter_id: z.string().min(1) })
      .parse(body);
    const n = signedEncounter(state, ctx, v.encounter_id);
    author(ctx, n);
    const content = validatedContent(state, n, v);
    const a: NoteAddendum = {
      ...content,
      id: ctx.id('note-addendum'),
      encounter_id: n.id,
      patient_id: n.patient_id,
      billing_account_id: account(n),
      author_id: ctx.user.id,
      author_name: ctx.user.name,
      status: 'Draft',
      revision: 1,
      created_at: ctx.now,
      updated_at: ctx.now,
      signed_at: null,
      signed_name: '',
      signed_snapshot: null,
      history: [],
    };
    record(a, ctx, 'Created');
    s.addenda.push(a);
    ctx.audit('Created draft addendum to signed note', n.id);
    return structuredClone(a);
  }
  if (method === 'PATCH' && id && !action) {
    const { a, n } = editable(state, ctx, id);
    const v = contentInput
      .extend({ revision: z.number().int().positive() })
      .parse(body);
    if (v.revision !== a.revision)
      fail(409, 'Addendum changed. Reload before editing.');
    const content = validatedContent(state, n, v);
    Object.assign(a, content, {
      revision: a.revision + 1,
      updated_at: ctx.now,
    });
    record(a, ctx, 'Edited');
    ctx.audit('Updated draft addendum', n.id);
    return structuredClone(a);
  }
  if (method === 'POST' && id && action === 'sign') {
    const { a, n } = editable(state, ctx, id);
    const v = z
      .object({
        revision: z.number().int().positive(),
        attested: z.literal(true),
        signed_name: z.string().trim().min(1).max(200),
      })
      .parse(body);
    if (v.revision !== a.revision)
      fail(409, 'Addendum changed. Reload and review before signing.');
    if (
      v.signed_name.replace(/\s+/g, ' ').toLocaleLowerCase() !==
      ctx.user.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
    )
      fail(400, 'Type your full account name to sign this addendum');
    const content = validatedContent(state, n, a);
    const sources = content.affected_result_ids.map((id) =>
      source(resultForNote(state, n, id)),
    );
    a.signed_snapshot = structuredClone({
      ...content,
      original_signed_at: n.signed_at,
      sources,
    });
    a.status = 'Signed';
    a.signed_at = ctx.now;
    a.signed_name = ctx.user.name;
    a.updated_at = ctx.now;
    a.revision++;
    record(a, ctx, 'Signed');
    for (const id of content.correction_ids) {
      const c = correctionForNote(state, n, id);
      c.status = 'Resolved';
      c.resolved_at = ctx.now;
      c.resolved_by_addendum_id = a.id;
      const task = state.tasks.find((t) => t.id === c.task_id);
      if (task) {
        task.done = 1;
        task.completed_at = ctx.now;
      }
      for (const alert of s.alerts.filter(
        (alert) => alert.correction_id === c.id,
      ))
        alert.resolved_at = ctx.now;
    }
    ctx.audit('Signed note addendum; original signed note retained', n.id);
    return structuredClone(a);
  }
  fail(404, 'Note addendum workflow not found');
}
