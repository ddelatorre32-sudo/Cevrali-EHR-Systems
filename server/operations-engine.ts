import { z } from 'zod';
import type { WorkflowState, WorkflowContext } from './workflow-engine.js';
import {
  ensurePatientAccounts,
  patientAccount,
  readJson,
} from './patient-accounts.js';
import type { PriorAuthorization } from './finance-engine.js';
import {
  treatmentRequest,
  treatmentUsageForPlan,
  type TreatmentReview,
} from './treatment-rules.js';
import {
  syncDocumentResults,
  invalidateDocumentResults,
  noteResultsRequest,
  type NoteResult,
} from './note-results.js';

const fail = (status: number, message: string): never => {
  throw Object.assign(new Error(message), { status });
};
const text = z.string().trim().min(1).max(200);
const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^(\d{5}|[A-Z]\d{4})$/);
export const serviceCategories = [
  'Office visit',
  'Acupuncture',
  'Therapy',
  'Radiology',
  'Other',
] as const;
export type ServiceApproval = {
  id: string;
  authorization_id: string;
  patient_id: string;
  billing_account_id: string;
  policy_id: string;
  policy_revision: number;
  procedure_code: string;
  category: (typeof serviceCategories)[number];
  description: string;
  unit: 'Visits' | 'Units' | 'Studies';
  approved_quantity: number;
  revision: number;
  history: { at: string; actor: string; note: string }[];
};
export const visitPlanInput = z
  .object({
    revision: z.number().int().optional(),
    authorization_required: z.boolean(),
    coverage_mode: z.enum(['Insurance', 'Self-pay']).default('Insurance'),
    services: z
      .array(
        z.object({
          approval_id: z.string().default(''),
          procedure_code: code,
          quantity: z.number().int().min(1).max(1000),
        }),
      )
      .max(20),
  })
  .refine(
    (v) => !v.authorization_required || v.services.length > 0,
    'Enter the services needing authorization',
  );
export type VisitPlan = z.infer<typeof visitPlanInput> & {
  released?: boolean;
  appointment_id: string;
  patient_id: string;
  billing_account_id: string;
  revision: number;
  history: { at: string; actor: string; note: string }[];
};
export type IncomingFax = {
  id: string;
  external_id: string;
  sender: string;
  filename: string;
  format: 'text' | 'pdf';
  original_base64: string;
  extracted_text: string;
  digest: string;
  pages: number;
  extraction_issue: string;
  extraction_method?: 'text' | 'pdf-text' | 'ocr' | 'mixed' | 'unreadable';
  ocr_engine?: string;
  ocr_confidence?: number | null;
  ocr_pages?: number[];
  extraction_reviewed_at?: string | null;
  extraction_reviewed_by?: string;
  extraction_revisions?: {
    revision: number;
    kind: string;
    text: string;
    issue: string;
    at: string;
    actor: string;
    reason: string;
  }[];
  received_at: string;
  revision: number;
  /** Changes only when clinical source text, classification or filing changes. */
  content_revision?: number;
  status: 'Needs review' | 'Filed' | 'Dismissed';
  patient_id: string;
  billing_account_id: string;
  match_reason: string;
  kind: string;
  reviewed_at: string | null;
  reviewed_by: string;
  clinical_task_id: string;
  history: { at: string; actor: string; note: string }[];
};
export type FilingAlert = {
  id: string;
  fax_id: string;
  patient_id: string;
  title: string;
  created_at: string;
  acknowledged_by: string[];
};
export type OperationsState = {
  treatment_reviews: TreatmentReview[];
  note_results: NoteResult[];
  service_approvals: ServiceApproval[];
  visit_plans: VisitPlan[];
  incoming_faxes: IncomingFax[];
  alerts: FilingAlert[];
};
export const emptyOperationsState = (): OperationsState => ({
  treatment_reviews: [],
  note_results: [],
  service_approvals: [],
  visit_plans: [],
  incoming_faxes: [],
  alerts: [],
});
const clinical = (ctx: WorkflowContext) => {
  if (ctx.user.role !== 'clinician') fail(403, 'Clinical access required');
};
const patient = (ctx: WorkflowContext, id: string) =>
  ctx.patients.find((p) => p.id === id) || fail(404, 'Patient not found');
const authorization = (state: WorkflowState, id: string) =>
  state.finance.authorizations.find((a) => a.id === id) ||
  fail(404, 'Authorization not found');
const accountId = (a: Record<string, any>) =>
  a.billing_account_id || `pba-private-${a.patient_id}`;
function quantities(
  state: WorkflowState,
  ctx: WorkflowContext,
  id: string,
  except = '',
) {
  let reserved = 0,
    completed = 0;
  for (const p of state.operations.visit_plans) {
    if (p.appointment_id === except) continue;
    const q = treatmentUsageForPlan(state, ctx, p, id);
    reserved += q.reserved;
    completed += q.completed;
  }
  return { reserved, completed };
}
function approvalRows(state: WorkflowState, ctx: WorkflowContext, except = '') {
  return state.operations.service_approvals.map((s) => {
    const a = authorization(state, s.authorization_id);
    const policy = state.finance.policies.find((p) => p.id === s.policy_id);
    const q = quantities(state, ctx, s.id, except);
    return {
      ...s,
      ...q,
      remaining: Math.max(0, s.approved_quantity - q.reserved - q.completed),
      approval_number: a.approval_number,
      valid_from: a.valid_from,
      valid_to: a.valid_to,
      status: a.status,
      active:
        a.status === 'Demo approved' &&
        policy?.revision === s.policy_revision &&
        policy.revision === a.policy_revision,
    };
  });
}
export function guardServiceCancellation(
  state: WorkflowState,
  ctx: WorkflowContext,
  id: string,
) {
  for (const s of state.operations.service_approvals.filter(
    (s) => s.authorization_id === id,
  )) {
    const q = quantities(state, ctx, s.id);
    if (q.reserved + q.completed)
      fail(
        409,
        'Authorization has scheduled or completed services. Release scheduled reservations before cancellation; completed services retain their authorization.',
      );
  }
}
function plannedVisitAccountLocked(
  state: WorkflowState,
  ctx: WorkflowContext,
  appointmentId: string,
) {
  const reviewed = (state.operations.treatment_reviews || []).some(
    (r) => r.appointment_id === appointmentId && r.services.length > 0,
  );
  const plan = state.operations.visit_plans.find(
    (p) => p.appointment_id === appointmentId,
  );
  const appointment = ctx.appointments.find((a) => a.id === appointmentId);
  const started =
    (appointment &&
      !['Scheduled', 'Checked in'].includes(appointment.status)) ||
    ctx.encounters.some((e) => e.appointment_id === appointmentId) ||
    Boolean(state.visits[appointmentId]?.started_at);
  return (
    reviewed || Boolean(plan?.services.length && !plan.released && started)
  );
}
const lockedAccountMessage =
  'Insurance cannot change after a planned treatment visit starts or actual treatment is reviewed. Keep this visit’s account and use a separate visit for care under another account.';

/** Run before mutating an appointment, encounter, or preview object. */
export function guardVisitAccountChange(
  state: WorkflowState,
  ctx: WorkflowContext,
  appointmentId: string,
  newAccountId: string,
) {
  const appointment = ctx.appointments.find((a) => a.id === appointmentId);
  if (!appointment) fail(404, 'Appointment not found');
  if (accountId(appointment!) === newAccountId) return;
  if (plannedVisitAccountLocked(state, ctx, appointmentId))
    fail(409, lockedAccountMessage);
}
export function releaseVisitPlanForAccountChange(
  state: WorkflowState,
  ctx: WorkflowContext,
  appointmentId: string,
  newAccountId: string,
) {
  guardVisitAccountChange(state, ctx, appointmentId, newAccountId);
  const p = state.operations.visit_plans.find(
    (p) => p.appointment_id === appointmentId,
  );
  if (p && p.billing_account_id !== newAccountId && !p.released) {
    // Also protect callers whose mutable preview context already contains the
    // new account. A late release must never erase reviewed performed usage.
    if (plannedVisitAccountLocked(state, ctx, appointmentId))
      fail(409, lockedAccountMessage);
    p.released = true;
    p.revision++;
    p.history.push({
      at: ctx.now,
      actor: ctx.user.name,
      note: 'Released treatment reservations after visit insurance changed; review required',
    });
    ctx.audit(
      'Released visit treatment reservations after insurance change',
      appointmentId,
    );
  }
}
export function saveVisitPlan(
  state: WorkflowState,
  ctx: WorkflowContext,
  appointment: Record<string, any>,
  body: unknown,
) {
  const input = visitPlanInput.parse(body);
  const old = state.operations.visit_plans.find(
    (p) => p.appointment_id === appointment.id,
  );
  if (old && input.revision !== old.revision)
    fail(409, 'Treatment plan changed; reload before saving');
  if (!['Scheduled', 'Checked in'].includes(appointment.status))
    fail(409, 'Treatment plans can only change before the visit starts');
  const billing = patientAccount(
    state.finance,
    appointment.patient_id,
    accountId(appointment),
    true,
  );
  if (
    input.coverage_mode === 'Self-pay' &&
    billing.kind === 'Workers compensation'
  )
    fail(
      400,
      'Workers compensation visits cannot be shifted to patient self-pay. Review the claim account.',
    );
  const seen = new Set<string>();
  for (const item of input.services) {
    if (seen.has(item.procedure_code))
      fail(400, 'Enter each procedure only once');
    seen.add(item.procedure_code);
    if (!input.authorization_required && item.approval_id)
      fail(400, 'Select authorization required to reserve approved treatment');
    if (!item.approval_id) continue;
    const s =
      approvalRows(state, ctx, appointment.id).find(
        (s) => s.id === item.approval_id,
      ) || fail(404, 'Service approval not found');
    if (
      s.patient_id !== appointment.patient_id ||
      s.billing_account_id !== billing.id ||
      s.procedure_code !== item.procedure_code
    )
      fail(
        400,
        'Service approval must match the patient, visit account and procedure',
      );
    if (
      !s.active ||
      appointment.date < s.valid_from ||
      appointment.date > s.valid_to
    )
      fail(409, 'Approval is inactive, changed or outside this visit date');
    if (item.quantity > s.remaining)
      fail(409, 'Not enough approved treatments remain for this visit');
  }
  const p: VisitPlan = {
    ...input,
    appointment_id: appointment.id,
    patient_id: appointment.patient_id,
    billing_account_id: billing.id,
    released: false,
    revision: (old?.revision || 0) + 1,
    history: [
      ...(old?.history || []),
      {
        at: ctx.now,
        actor: ctx.user.name,
        note: 'Reviewed visit services and authorization reservations',
      },
    ],
  };
  if (old) Object.assign(old, p);
  else state.operations.visit_plans.push(p);
  ctx.audit('Saved visit treatment authorization plan', appointment.id);
  return p;
}
function planIssues(
  state: WorkflowState,
  ctx: WorkflowContext,
  a: Record<string, any>,
) {
  const p = state.operations.visit_plans.find((p) => p.appointment_id === a.id);
  if (!p)
    return ['Treatment / authorization requirement has not been reviewed'];
  if (p.released || p.billing_account_id !== accountId(a))
    return ['Visit insurance changed; review treatment authorization again'];
  const issues: string[] = [];
  if (
    p.services.length &&
    ['In progress', 'Completed'].includes(a.status) &&
    !(state.operations.treatment_reviews || []).some(
      (r) =>
        r.appointment_id === a.id &&
        r.plan_revision === p.revision &&
        r.billing_account_id === p.billing_account_id,
    )
  )
    issues.push(
      'Actual treatment review required; planned quantities remain reserved',
    );
  if (!p.authorization_required) return issues;
  for (const item of p.services) {
    if (!item.approval_id) {
      issues.push(`${item.procedure_code}: approval needed`);
      continue;
    }
    const s = approvalRows(state, ctx).find((s) => s.id === item.approval_id);
    if (!s || !s.active || a.date < s.valid_from || a.date > s.valid_to)
      issues.push(
        `${item.procedure_code}: approval inactive, expired or changed`,
      );
  }
  return issues;
}
export function readinessRows(
  state: WorkflowState,
  ctx: WorkflowContext,
  date: string,
) {
  return ctx.appointments
    .filter((a) => a.date === date && a.status !== 'Cancelled')
    .map((a) => {
      const p = patient(ctx, a.patient_id);
      const account = patientAccount(state.finance, a.patient_id, accountId(a));
      const issues = planIssues(state, ctx, a);
      if (!p.phone || !p.address)
        issues.push('Patient contact details incomplete');
      if (account.status !== 'Active')
        issues.push('Visit billing account is closed');
      if (account.workers_comp) {
        if (account.workers_comp.claim_status !== 'Accepted')
          issues.push('Workers compensation claim acceptance needs review');
        if (!account.workers_comp.accepted_body_parts.length)
          issues.push('Accepted body parts missing');
      }
      const policies = state.finance.policies.filter(
        (p) =>
          p.patient_id === a.patient_id &&
          p.billing_account_id === account.id &&
          p.effective_date <= a.date &&
          (!p.end_date || p.end_date >= a.date),
      );
      const selfPay =
        account.kind === 'Private insurance' &&
        state.operations.visit_plans.some(
          (p) =>
            p.appointment_id === a.id &&
            p.billing_account_id === account.id &&
            !p.released &&
            p.coverage_mode === 'Self-pay',
        );
      if (!selfPay && !policies.length)
        issues.push(
          'No coverage for visit date; confirm self-pay or add insurance',
        );
      else if (
        !selfPay &&
        !policies.some((p) => {
          const v = [...state.finance.verifications]
            .reverse()
            .find(
              (v) =>
                v.policy_id === p.id &&
                v.policy_revision === p.revision &&
                v.service_date === a.date,
            );
          return (
            v?.status === 'Active' &&
            Date.parse(ctx.now) - Date.parse(v.checked_at) <= 7 * 86400000
          );
        })
      )
        issues.push('Current service-date coverage check needed');
      const intake = [...state.intakes]
        .reverse()
        .find((i) => i.appointment_id === a.id && i.status !== 'Revoked');
      if (!intake || !['Submitted', 'Reviewed'].includes(intake.status))
        issues.push('Pre-visit intake not submitted');
      const unresolved = state.operations.incoming_faxes.filter(
        (f) =>
          f.status === 'Filed' &&
          f.patient_id === a.patient_id &&
          (!f.billing_account_id || f.billing_account_id === account.id) &&
          !f.reviewed_at,
      ).length;
      if (unresolved)
        issues.push(`${unresolved} outside document(s) await clinician review`);
      return {
        id: a.id,
        patient_id: a.patient_id,
        first_name: p.first_name,
        last_name: p.last_name,
        date: a.date,
        time: a.time,
        status: a.status,
        billing_account_id: account.id,
        account_name: account.name,
        claim_number: account.workers_comp?.claim_number || '',
        issues,
        ready: issues.length === 0,
        plan:
          state.operations.visit_plans.find((p) => p.appointment_id === a.id) ||
          null,
      };
    });
}
const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const mrn = (id: string) =>
  `CV-${id.replace('pat-', '').toUpperCase().padStart(5, '0')}`;
function labelled(text: string, labels: string) {
  const values: string[] = [];
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:${labels})\\s*[:#]\\s*([^\\n]+)`,
    'gi',
  );
  for (const m of text.matchAll(re)) values.push(m[1].trim());
  return [...new Set(values)];
}
function birthDate(s: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
}
export function matchIncomingPatient(ctx: WorkflowContext, body: string) {
  const names = labelled(body, 'Patient(?: Name)?|Name').map((v) =>
    v.includes(',') ? v.split(',').reverse().join(' ') : v,
  );
  const dates = labelled(body, 'DOB|Date of Birth').map(birthDate);
  const ids = labelled(body, 'MRN|Medical Record Number|Patient ID');
  if (
    names.length > 1 ||
    dates.length !== 1 ||
    ids.length > 1 ||
    (!names.length && !ids.length) ||
    !dates[0]
  )
    return {
      patient_id: '',
      reason: 'Needs one patient identity and an unambiguous date of birth',
    };
  const matches = ctx.patients.filter(
    (p) =>
      p.dob === dates[0] &&
      (!names.length ||
        normalize(names[0]) === normalize(`${p.first_name} ${p.last_name}`)) &&
      (!ids.length ||
        normalize(ids[0]) === normalize(mrn(p.id)) ||
        ids[0] === p.id),
  );
  if (matches.length !== 1)
    return {
      patient_id: '',
      reason:
        matches.length > 1
          ? 'Multiple patients match; review required'
          : 'Patient identifiers do not identify one matching chart',
    };
  return {
    patient_id: matches[0].id as string,
    reason: ids.length
      ? 'Exact MRN and birth date; supplied name also checked'
      : 'Exact full name and birth date; one matching chart',
  };
}
function metadata(f: IncomingFax, ctx: WorkflowContext) {
  const p = ctx.patients.find((p) => p.id === f.patient_id);
  return {
    id: f.id,
    external_id: f.external_id,
    sender: f.sender,
    filename: f.filename,
    format: f.format,
    received_at: f.received_at,
    revision: f.revision,
    status: f.status,
    patient_id: f.patient_id,
    patient_name: p ? `${p.first_name} ${p.last_name}` : '',
    billing_account_id: f.billing_account_id,
    match_reason: f.match_reason,
    kind: f.kind,
    reviewed_at: f.reviewed_at,
    reviewed_by: f.reviewed_by,
    pages: f.pages,
    extraction_method:
      f.extraction_method || (f.format === 'text' ? 'text' : 'pdf-text'),
    extraction_issue: f.extraction_issue,
    ocr_engine: f.ocr_engine || '',
    ocr_confidence: f.ocr_confidence ?? null,
    ocr_pages: f.ocr_pages || [],
    extraction_reviewed_at: f.extraction_reviewed_at || null,
    extraction_reviewed_by: f.extraction_reviewed_by || '',
    history:
      ctx.user.role === 'clinician'
        ? f.history
        : f.history.map((h) => ({
            ...h,
            note: h.note.startsWith('Clinical review:')
              ? 'Clinical review recorded'
              : h.note.startsWith('Clinician filed / corrected')
                ? 'Patient / claim filing reviewed by clinician'
                : h.note.startsWith('Extraction review:')
                  ? 'Document classification and extraction reviewed by clinician'
                  : h.note,
          })),
  };
}
function notify(
  state: WorkflowState,
  ctx: WorkflowContext,
  f: IncomingFax,
  title: string,
) {
  state.operations.alerts.push({
    id: ctx.id('notice'),
    fax_id: f.id,
    patient_id: f.patient_id,
    title,
    created_at: ctx.now,
    acknowledged_by: [],
  });
}
function fileFax(
  state: WorkflowState,
  ctx: WorkflowContext,
  f: IncomingFax,
  patientId: string,
  billingId: string,
  note: string,
) {
  invalidateDocumentResults(state, ctx, f.id);
  patient(ctx, patientId);
  if (billingId) patientAccount(state.finance, patientId, billingId);
  if (f.clinical_task_id) {
    const old = state.tasks.find((t) => t.id === f.clinical_task_id);
    if (old) {
      old.done = 1;
      old.completed_at = ctx.now;
    }
  }
  f.patient_id = patientId;
  if (note.startsWith('Clinician filed'))
    f.match_reason = 'Patient and claim filing verified by clinician';
  f.billing_account_id = billingId;
  f.status = 'Filed';
  f.reviewed_at = null;
  f.reviewed_by = '';
  f.revision++;
  f.content_revision = f.revision;
  f.history.push({ at: ctx.now, actor: ctx.user.name, note });
  const owner = ctx.users.find(
    (u) => u.role === 'clinician' && u.is_active !== 0 && u.is_active !== false,
  );
  const task = {
    id: ctx.id('task'),
    patient_id: patientId,
    title: 'Review received outside document',
    category: 'Outside document',
    priority: 'Normal' as const,
    done: 0,
    owner_id: owner?.id || '',
    due_date: ctx.today,
    created_at: ctx.now,
    completed_at: null,
    source_key: `incoming-fax:${f.id}:${f.revision}`,
  };
  state.tasks.push(task);
  f.clinical_task_id = task.id;
  notify(state, ctx, f, 'Incoming fax saved to patient chart');
  ctx.audit(note, f.id);
  syncDocumentResults(state, ctx);
}
export function operationsRequest(
  state: WorkflowState,
  ctx: WorkflowContext,
  method: string,
  url: URL,
  body: unknown,
) {
  ensurePatientAccounts(state.finance, ctx);
  const [, resource, id, action] = url.pathname.split('/').filter(Boolean);
  const input = body as any;
  const op = state.operations;
  if (resource === 'treatments' || resource === 'treatment-reconciliation')
    return treatmentRequest(state, ctx, method, url, body);
  if (resource === 'note-results')
    return noteResultsRequest(state, ctx, method, url, body, id, action);
  if (resource === 'readiness' && method === 'GET')
    return readinessRows(state, ctx, url.searchParams.get('date') || ctx.today);
  if (resource === 'service-approvals') {
    if (method === 'GET')
      return approvalRows(
        state,
        ctx,
        url.searchParams.get('except_appointment') || '',
      ).filter(
        (s) =>
          (!url.searchParams.get('patient_id') ||
            s.patient_id === url.searchParams.get('patient_id')) &&
          (!url.searchParams.get('authorization_id') ||
            s.authorization_id === url.searchParams.get('authorization_id')),
      );
    if (method === 'POST' || method === 'PATCH') {
      const v = z
        .object({
          authorization_id: text,
          procedure_code: code,
          category: z.enum(serviceCategories),
          description: text,
          unit: z.enum(['Visits', 'Units', 'Studies']),
          approved_quantity: z.number().int().min(1).max(1000),
          revision: z.number().int().optional(),
          decision_note: z.string().trim().min(5).max(1000),
        })
        .parse(body);
      const a = authorization(state, v.authorization_id);
      const policy =
        state.finance.policies.find((p) => p.id === a.policy_id) ||
        fail(404, 'Policy not found');
      if (a.status !== 'Demo approved' || a.policy_revision !== policy.revision)
        fail(409, 'Record a current demo authorization approval first');
      if (!a.procedure_codes.includes(v.procedure_code))
        fail(
          400,
          'Service code must be included in the approved authorization',
        );
      const old = id
        ? op.service_approvals.find((s) => s.id === id) ||
          fail(404, 'Service approval not found')
        : undefined;
      if (
        old &&
        (v.revision !== old.revision ||
          v.authorization_id !== old.authorization_id ||
          v.procedure_code !== old.procedure_code ||
          v.unit !== old.unit)
      )
        fail(
          409,
          'Service approval changed or its identity/units do not match; reload before saving',
        );
      if (
        !old &&
        op.service_approvals.some(
          (s) =>
            s.authorization_id === a.id &&
            s.procedure_code === v.procedure_code,
        )
      )
        fail(
          409,
          'This authorization already has an allowance for that procedure',
        );
      const q = old
        ? quantities(state, ctx, old.id)
        : { reserved: 0, completed: 0 };
      if (v.approved_quantity < q.reserved + q.completed)
        fail(
          409,
          'Allowance cannot be lower than scheduled and completed treatments',
        );
      const s: ServiceApproval = {
        ...v,
        id: old?.id || ctx.id('svc'),
        patient_id: a.patient_id,
        policy_id: policy.id,
        policy_revision: policy.revision,
        billing_account_id: accountId(policy),
        revision: (old?.revision || 0) + 1,
        history: [
          ...(old?.history || []),
          { at: ctx.now, actor: ctx.user.name, note: v.decision_note },
        ],
      };
      if (old) Object.assign(old, s);
      else op.service_approvals.push(s);
      ctx.audit('Recorded demo service-specific treatment allowance', s.id);
      return s;
    }
  }
  if (resource === 'visit-plans') {
    const a =
      ctx.appointments.find((a) => a.id === id) ||
      fail(404, 'Appointment not found');
    if (method === 'GET')
      return op.visit_plans.find((p) => p.appointment_id === id) || null;
    if (method === 'POST') return saveVisitPlan(state, ctx, a, body);
  }
  if (resource === 'claims' && method === 'GET') {
    const p = patient(ctx, url.searchParams.get('patient_id') || '');
    ctx.audit('Viewed workers compensation claim workspace', p.id);
    return state.finance.billing_accounts
      .filter((a) => a.patient_id === p.id && a.kind === 'Workers compensation')
      .map((a) => {
        const policies = state.finance.policies.filter(
          (p) => p.billing_account_id === a.id,
        );
        const auths = state.finance.authorizations.filter((x) =>
          policies.some((p) => p.id === x.policy_id),
        );
        const notes = ctx.encounters
          .filter(
            (e) =>
              e.patient_id === p.id &&
              accountId(e) === a.id &&
              e.status === 'Signed',
          )
          .sort((a, b) =>
            String(b.signed_at).localeCompare(String(a.signed_at)),
          );
        const latest = notes[0];
        const doc = latest ? readJson(latest.wc_documentation, null) : null;
        return {
          account: a,
          authorizations: auths,
          services: approvalRows(state, ctx).filter(
            (s) => s.billing_account_id === a.id,
          ),
          appointments: ctx.appointments
            .filter((x) => x.patient_id === p.id && accountId(x) === a.id)
            .map((x) => ({
              id: x.id,
              date: x.date,
              time: x.time,
              status: x.status,
            })),
          bills: state.finance.bills
            .filter(
              (b) => b.patient_id === p.id && b.billing_account_id === a.id,
            )
            .map((b) => ({
              id: b.id,
              service_date: b.service_date,
              claim_status:
                state.finance.claims.filter((c) => c.bill_id === b.id).at(-1)
                  ?.status || 'Draft',
            })),
          outgoing_faxes: state.finance.fax_jobs.filter((f) =>
            auths.some((a) => a.id === f.authorization_id),
          ),
          documents: op.incoming_faxes
            .filter(
              (f) =>
                f.status === 'Filed' &&
                f.patient_id === p.id &&
                f.billing_account_id === a.id,
            )
            .map((f) => metadata(f, ctx)),
          work_status:
            ctx.user.role === 'clinician' && latest
              ? { signed_at: latest.signed_at, documentation: doc }
              : null,
        };
      });
  }
  if (resource === 'alerts') {
    if (method === 'GET')
      return op.alerts.map((a) => ({
        ...a,
        acknowledged: a.acknowledged_by.includes(ctx.user.id),
        patient_name: a.patient_id
          ? `${patient(ctx, a.patient_id).first_name} ${patient(ctx, a.patient_id).last_name}`
          : '',
      }));
    if (method === 'POST' && action === 'acknowledge') {
      const a =
        op.alerts.find((a) => a.id === id) || fail(404, 'Alert not found');
      if (!a.acknowledged_by.includes(ctx.user.id))
        a.acknowledged_by.push(ctx.user.id);
      ctx.audit('Acknowledged incoming fax filing alert', a.id);
      return { ok: true };
    }
  }
  if (resource === 'documents' && method === 'GET') {
    if (id) {
      clinical(ctx);
      const f =
        op.incoming_faxes.find((f) => f.id === id && f.status === 'Filed') ||
        fail(404, 'Document not found');
      ctx.audit('Viewed received clinical document', id);
      return {
        ...metadata(f, ctx),
        original_base64: f.original_base64,
        extracted_text: f.extracted_text,
        extraction_revisions: f.extraction_revisions || [],
      };
    }
    return op.incoming_faxes
      .filter(
        (f) =>
          f.status === 'Filed' &&
          f.patient_id === url.searchParams.get('patient_id'),
      )
      .map((f) => metadata(f, ctx));
  }
  if (resource === 'incoming-faxes') {
    if (method === 'GET') {
      if (!id) return op.incoming_faxes.map((f) => metadata(f, ctx));
      clinical(ctx);
      const f =
        op.incoming_faxes.find((f) => f.id === id) ||
        fail(404, 'Fax not found');
      ctx.audit('Viewed incoming fax document', id);
      return {
        ...metadata(f, ctx),
        extracted_text: f.extracted_text,
        extraction_revisions: f.extraction_revisions || [],
        original_base64: f.original_base64,
      };
    }
    if (method === 'POST' && !id) {
      // Bytes and extraction are prepared by the transport adapter, never accepted from client match suggestions.
      const v = input as IncomingFax;
      if (
        !v.digest ||
        typeof v.extracted_text !== 'string' ||
        !v.original_base64
      )
        fail(400, 'Fax transport must process the original document first');
      const repeat = op.incoming_faxes.find(
        (f) => f.external_id === v.external_id,
      );
      if (repeat) {
        if (repeat.digest !== v.digest)
          fail(409, 'Fax reference already used for a different document');
        return metadata(repeat, ctx);
      }
      const duplicate = op.incoming_faxes.find((f) => f.digest === v.digest);
      if (duplicate) return metadata(duplicate, ctx);
      const f: IncomingFax = {
        ...v,
        id: ctx.id('inbound'),
        received_at: ctx.now,
        revision: 1,
        content_revision: 1,
        status: 'Needs review',
        patient_id: '',
        billing_account_id: '',
        match_reason: '',
        kind: 'Outside document',
        reviewed_at: null,
        reviewed_by: '',
        clinical_task_id: '',
        extraction_reviewed_at: null,
        extraction_reviewed_by: '',
        extraction_revisions: [],
        history: [
          {
            at: ctx.now,
            actor: ctx.user.name,
            note: 'Received through demo fax connection; no external fax service connected',
          },
        ],
      };
      const kind = labelled(f.extracted_text, 'Document Type')[0];
      if (
        [
          'Radiology report',
          'Specialist note',
          'Lab report',
          'Authorization letter',
          'Referral',
          'Other',
        ].includes(kind)
      )
        f.kind = kind;
      else if (
        /^\s*(?:radiology|imaging|MRI|CT) report\b/im.test(
          f.extracted_text.slice(0, 1500),
        )
      )
        f.kind = 'Radiology report';
      else if (
        /^\s*(?:laboratory (?:results|report)|lab (?:results|report))\b/im.test(
          f.extracted_text.slice(0, 1500),
        )
      )
        f.kind = 'Lab report';
      const match = matchIncomingPatient(ctx, f.extracted_text);
      f.match_reason = f.extraction_issue || match.reason;
      op.incoming_faxes.push(f);
      if (!f.extraction_issue && match.patient_id) {
        const claims = labelled(f.extracted_text, 'Claim(?: Number)?');
        const accounts = state.finance.billing_accounts.filter(
          (a) =>
            a.patient_id === match.patient_id &&
            a.workers_comp &&
            normalize(a.workers_comp.claim_number) ===
              normalize(claims[0] || ''),
        );
        if (claims.length > 1 || (claims.length && accounts.length !== 1))
          f.match_reason =
            'Claim number does not identify one account for the matched patient';
        else
          fileFax(
            state,
            ctx,
            f,
            match.patient_id,
            accounts[0]?.id || '',
            'Automatically filed received fax after exact identifier checks',
          );
      }
      if (f.status === 'Needs review')
        notify(state, ctx, f, 'Incoming fax needs matching review');
      ctx.audit('Received demo incoming fax', f.id);
      return metadata(f, ctx);
    }
    const f =
      op.incoming_faxes.find((f) => f.id === id) || fail(404, 'Fax not found');
    clinical(ctx);
    const v = z
      .object({
        revision: z.literal(f.revision),
        reason: z.string().trim().min(5).max(1000),
      })
      .parse(body);
    if (action === 'review-extraction' && method === 'POST') {
      const correction = z
        .object({
          kind: z.enum([
            'Outside document',
            'Radiology report',
            'Specialist note',
            'Lab report',
            'Authorization letter',
            'Referral',
            'Other',
          ]),
          text: z.string().trim().min(1).max(100000),
          identity_confirmed: z.literal(true),
          values_confirmed: z.literal(true),
        })
        .parse(body);
      const changed =
        f.kind !== correction.kind || f.extracted_text !== correction.text;
      if (changed)
        invalidateDocumentResults(state, ctx, f.id, 'Extracted report text');
      (f.extraction_revisions ||= []).push({
        revision: f.revision,
        kind: f.kind,
        text: f.extracted_text,
        issue: f.extraction_issue,
        at: ctx.now,
        actor: ctx.user.name,
        reason: v.reason,
      });
      f.kind = correction.kind;
      f.extracted_text = correction.text;
      f.extraction_issue = '';
      f.extraction_reviewed_at = ctx.now;
      f.extraction_reviewed_by = ctx.user.name;
      if (f.status === 'Needs review')
        f.match_reason =
          'Extraction verified by clinician; confirm patient and claim before chart filing';
      f.reviewed_at = null;
      f.reviewed_by = '';
      f.revision++;
      if (changed) f.content_revision = f.revision;
      f.history.push({
        at: ctx.now,
        actor: ctx.user.name,
        note: `Extraction review: ${v.reason}`,
      });
      if (f.status === 'Filed') {
        const task = state.tasks.find((t) => t.id === f.clinical_task_id);
        if (task) {
          task.done = 0;
          task.completed_at = null;
        }
        notify(
          state,
          ctx,
          f,
          'Incoming fax classification or transcription reviewed',
        );
        syncDocumentResults(state, ctx);
      }
      ctx.audit(
        'Reviewed incoming fax classification and extracted text against original',
        f.id,
      );
      return {
        ...metadata(f, ctx),
        extracted_text: f.extracted_text,
        original_base64: f.original_base64,
        extraction_revisions: f.extraction_revisions,
      };
    }
    if (action === 'file' && method === 'POST') {
      if (f.extraction_issue)
        fail(
          409,
          'Review every original page and confirm extracted text, identity and values before filing',
        );
      const target = z
        .object({
          patient_id: text,
          billing_account_id: z.string().default(''),
          identity_confirmed: z.literal(true),
        })
        .parse(body);
      fileFax(
        state,
        ctx,
        f,
        target.patient_id,
        target.billing_account_id,
        `Clinician filed / corrected document: ${v.reason}`,
      );
      return metadata(f, ctx);
    }
    if (action === 'review' && method === 'POST') {
      if (f.status !== 'Filed')
        fail(409, 'File the document to a patient before clinical review');
      if (f.extraction_issue)
        fail(409, 'Complete original-document extraction review first');
      f.reviewed_at = ctx.now;
      f.reviewed_by = ctx.user.name;
      f.revision++;
      f.history.push({
        at: ctx.now,
        actor: ctx.user.name,
        note: `Clinical review: ${v.reason}`,
      });
      const task = state.tasks.find((t) => t.id === f.clinical_task_id);
      if (task) {
        task.done = 1;
        task.completed_at = ctx.now;
      }
      ctx.audit('Clinically reviewed outside document', f.id);
      return metadata(f, ctx);
    }
    if (action === 'dismiss' && method === 'POST') {
      if (f.status === 'Filed')
        fail(
          409,
          'Filed documents must be corrected through reviewed reassignment',
        );
      f.status = 'Dismissed';
      f.revision++;
      f.history.push({
        at: ctx.now,
        actor: ctx.user.name,
        note: `Dismissed: ${v.reason}`,
      });
      ctx.audit('Dismissed unmatched incoming fax', f.id);
      return metadata(f, ctx);
    }
  }
  fail(404, 'Operations workflow not found');
}
