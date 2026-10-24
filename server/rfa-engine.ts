import { z } from 'zod';
import type { FinanceState, PriorAuthorization } from './finance-engine.js';
import type { WorkflowContext } from './workflow-engine.js';
export function rfaDisplayTime(value: string | null | undefined) {
  return value
    ? new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(new Date(value))
    : '';
}
import {
  patientAccount,
  readJson,
  type PatientBillingAccount,
} from './patient-accounts.js';

const text = z.string().trim().max(500);
const contact = z.object({
  name: text.default(''),
  contact_name: text.default(''),
  address: text.default(''),
  city: text.default(''),
  state: text.default(''),
  zip: text.default(''),
  phone: text.default(''),
  fax: text.default(''),
  email: z.union([z.string().trim().email(), z.literal('')]).default(''),
});
export const rfaService = z.object({
  category: z
    .enum(['Office visit', 'Acupuncture', 'Radiology', 'Therapy', 'Other'])
    .default('Other'),
  diagnosis: z.string().trim().max(10000).default(''),
  icd_code: z.string().trim().toUpperCase().max(16).default(''),
  service: z.string().trim().max(2000).default(''),
  cpt_code: z.string().trim().toUpperCase().max(5).default(''),
  quantity: z.number().int().min(1).max(1000).default(1),
  frequency: text.default(''),
  duration: text.default(''),
});
const editable = z.object({
  physician: contact.extend({
    practice_name: text.default(''),
    specialty: text.default(''),
    npi: z.string().trim().max(10).default(''),
  }),
  recipient: contact,
  services: z.array(rfaService).min(1).max(30),
  clinical_rationale: z.string().trim().max(10000),
  request_type: z.enum(['New request', 'Resubmission']),
  material_change: z.string().trim().max(5000).default(''),
  expedited: z.boolean(),
  expedited_reason: z.string().trim().max(5000).default(''),
  oral_confirmation: z.boolean(),
  oral_request_details: z.string().trim().max(5000).default(''),
});
export type RfaPacket = z.infer<typeof editable> & {
  id: string;
  patient_id: string;
  authorization_id: string;
  authorization_revision: number;
  encounter_id: string;
  author_id: string;
  revision: number;
  status: 'Draft' | 'Provider signed';
  created_at: string;
  updated_at: string;
  signed_at: string | null;
  signed_by: string;
  signature_date: string;
  patient: { id: string; first_name: string; last_name: string; dob: string };
  account: PatientBillingAccount;
  note: Record<string, any>;
  history: { action: string; actor: string; at: string }[];
};
export type FaxJob = {
  id: string;
  rfa_id: string;
  packet_revision: number;
  authorization_id: string;
  patient_id: string;
  recipient: string;
  fax: string;
  status:
    | 'Demo queued'
    | 'Demo failed'
    | 'Demo delivery simulated'
    | 'Demo cancelled';
  attempts: number;
  created_at: string;
  updated_at: string;
  history: { status: string; at: string; actor: string; detail: string }[];
};
function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
function clinical(ctx: WorkflowContext) {
  if (ctx.user.role !== 'clinician')
    fail(403, 'Clinical access required for RFA documentation');
}
function auth(state: FinanceState, id: string) {
  return (
    state.authorizations.find((a) => a.id === id) ||
    fail(404, 'Authorization not found')
  );
}
function source(
  state: FinanceState,
  ctx: WorkflowContext,
  a: PriorAuthorization,
) {
  const note =
    ctx.encounters.find((e) => e.id === a.encounter_id) ||
    fail(409, 'Link a supporting encounter to this authorization first');
  if (note.patient_id !== a.patient_id)
    fail(400, 'Supporting encounter belongs to another patient');
  if (note.status !== 'Signed')
    fail(409, 'Sign the supporting encounter before preparing an RFA');
  if (note.source_corrections?.length)
    fail(
      409,
      'Resolve the signed note source correction with a signed addendum before preparing or sending an RFA',
    );
  const policy =
    state.policies.find((p) => p.id === a.policy_id) ||
    fail(404, 'Policy not found');
  const account = patientAccount(
    state,
    a.patient_id,
    policy.billing_account_id,
  );
  if (
    account.kind !== 'Workers compensation' ||
    note.billing_account_id !== account.id
  )
    fail(
      400,
      'RFA documentation and authorization must use the same workers compensation claim',
    );
  const p =
    ctx.patients.find((p) => p.id === a.patient_id) ||
    fail(404, 'Patient not found');
  return {
    account,
    note,
    patient: {
      id: p.id,
      first_name: p.first_name,
      last_name: p.last_name,
      dob: p.dob,
    },
    policy,
  };
}
function noteSnapshot(note: Record<string, any>) {
  return Object.fromEntries(
    [
      'id',
      'patient_id',
      'author_id',
      'billing_account_id',
      'chief_complaint',
      'subjective',
      'objective',
      'assessment',
      'plan',
      'status',
      'signed_at',
      'updated_at',
      'created_at',
      'received_results',
      'signed_addenda',
      'source_corrections',
    ].map((k) => [k, note[k]]),
  ) as Record<string, any>;
}
function snapshot(
  state: FinanceState,
  ctx: WorkflowContext,
  a: PriorAuthorization,
) {
  const s = source(state, ctx, a);
  return {
    patient: structuredClone(s.patient),
    account: structuredClone(s.account),
    note: {
      ...noteSnapshot(s.note),
      wc_documentation: readJson(s.note.wc_documentation, null),
      billing_account_snapshot: readJson(s.note.billing_account_snapshot, null),
    },
  };
}
function history(p: RfaPacket, ctx: WorkflowContext, action: string) {
  p.history.push({ action, actor: ctx.user.name, at: ctx.now });
  p.updated_at = ctx.now;
  p.revision++;
  ctx.audit(action, p.id);
}
export function createRfaDraft(
  state: FinanceState,
  ctx: WorkflowContext,
  a: PriorAuthorization,
) {
  const existing = state.rfa_packets.find(
    (p) => p.authorization_id === a.id && p.status === 'Draft',
  );
  if (existing) return existing;
  if (a.status !== 'Draft')
    fail(409, 'Create an RFA while the authorization is a draft');
  const s = source(state, ctx, a);
  const physician =
    ctx.users.find((u) => u.id === s.note.author_id) ||
    fail(409, 'Supporting physician not found');
  const practice = ctx.practice;
  const p: RfaPacket = {
    ...snapshot(state, ctx, a),
    id: ctx.id('rfa'),
    patient_id: a.patient_id,
    authorization_id: a.id,
    authorization_revision: a.revision,
    encounter_id: s.note.id,
    author_id: physician.id,
    revision: 1,
    status: 'Draft',
    created_at: ctx.now,
    updated_at: ctx.now,
    signed_at: null,
    signed_by: '',
    signature_date: '',
    physician: contact
      .extend({ practice_name: text, specialty: text, npi: text })
      .parse({
        name: physician.name,
        email: physician.email,
        practice_name: practice?.name || '',
        address: practice?.address || '',
        phone: practice?.phone || '',
        fax: practice?.fax_from_number || '',
        specialty: practice?.specialty || '',
        npi: '',
      }),
    recipient: contact.parse({
      name: s.account.workers_comp!.carrier,
      contact_name: s.account.workers_comp!.adjuster_name || '',
      phone: s.account.workers_comp!.adjuster_phone || '',
      email: s.account.workers_comp!.adjuster_email || '',
    }),
    services: (a.procedure_codes.length ? a.procedure_codes : ['']).map((c) =>
      rfaService.parse({
        diagnosis: s.note.assessment,
        service: a.description,
        cpt_code: c,
        quantity: a.requested_visits,
      }),
    ),
    clinical_rationale: s.note.plan || '',
    request_type: 'New request',
    material_change: '',
    expedited: false,
    expedited_reason: '',
    oral_confirmation: false,
    oral_request_details: '',
    history: [
      {
        action: 'Draft autofilled from signed encounter and authorization',
        actor: ctx.user.name,
        at: ctx.now,
      },
    ],
  };
  state.rfa_packets.push(p);
  ctx.audit('Autofilled DWC RFA draft', p.id);
  return p;
}
export function syncRfaDrafts(state: FinanceState, ctx: WorkflowContext) {
  for (const a of state.authorizations) {
    if (
      a.status !== 'Draft' ||
      !a.encounter_id ||
      state.rfa_packets.some((p) => p.authorization_id === a.id)
    )
      continue;
    const e = ctx.encounters.find((e) => e.id === a.encounter_id);
    const policy = state.policies.find((p) => p.id === a.policy_id);
    if (
      e?.status === 'Signed' &&
      !e.source_corrections?.length &&
      policy?.billing_account_id === e.billing_account_id &&
      state.billing_accounts.some(
        (b) =>
          b.id === e.billing_account_id && b.kind === 'Workers compensation',
      )
    )
      createRfaDraft(state, ctx, a);
  }
}
function fresh(state: FinanceState, ctx: WorkflowContext, p: RfaPacket) {
  const a = auth(state, p.authorization_id);
  const s = source(state, ctx, a);
  if (
    a.revision !== p.authorization_revision ||
    s.note.id !== p.encounter_id ||
    s.note.updated_at !== p.note.updated_at ||
    JSON.stringify(s.note.signed_addenda || []) !==
      JSON.stringify(p.note.signed_addenda || []) ||
    JSON.stringify(s.note.source_corrections || []) !==
      JSON.stringify(p.note.source_corrections || []) ||
    s.account.revision !== p.account.revision ||
    JSON.stringify(s.patient) !== JSON.stringify(p.patient) ||
    s.policy.revision !== a.policy_revision
  )
    fail(
      409,
      'Source details changed. Refresh the draft or create a new RFA and review it before fax preparation',
    );
  return a;
}
export function rfaIssues(p: RfaPacket) {
  const missing: string[] = [];
  for (const k of [
    'name',
    'practice_name',
    'contact_name',
    'address',
    'city',
    'state',
    'zip',
    'phone',
    'fax',
    'email',
    'specialty',
  ] as const)
    if (!p.physician[k]) missing.push(`Physician ${k.replaceAll('_', ' ')}`);
  if (!/^\d{10}$/.test(p.physician.npi))
    missing.push('Treating physician 10-digit NPI (not the organization NPI)');
  for (const k of [
    'name',
    'contact_name',
    'address',
    'city',
    'state',
    'zip',
    'phone',
    'email',
  ] as const)
    if (!p.recipient[k])
      missing.push(`Claims administrator ${k.replaceAll('_', ' ')}`);
  if (!/^\+[1-9]\d{7,14}$/.test(p.recipient.fax))
    missing.push(
      'Claims administrator fax with country code, e.g. +14155550123',
    );
  if (!p.clinical_rationale)
    missing.push('Clinical rationale supporting requested treatment');
  p.services.forEach((s, i) => {
    if (!s.diagnosis) missing.push(`Service ${i + 1}: diagnosis`);
    if (!/^[A-Z][0-9][A-Z0-9](\.[A-Z0-9]{1,4})?$/.test(s.icd_code))
      missing.push(`Service ${i + 1}: ICD-10-CM code`);
    if (!s.service)
      missing.push(`Service ${i + 1}: specific requested service`);
    if (s.cpt_code && !/^(\d{5}|[A-Z]\d{4})$/.test(s.cpt_code))
      missing.push(
        `Service ${i + 1}: valid CPT/HCPCS code or blank if unknown`,
      );
    if (!s.frequency || !s.duration)
      missing.push(`Service ${i + 1}: frequency and duration`);
  });
  if (p.request_type === 'Resubmission' && p.material_change.length < 10)
    missing.push('Material-fact change supporting resubmission');
  if (p.expedited && p.expedited_reason.length < 10)
    missing.push('Clinical support for expedited review');
  if (p.oral_confirmation && p.oral_request_details.length < 10)
    missing.push('Prior oral-request details');
  if (
    [
      ...p.services.flatMap((s) => [
        s.diagnosis,
        s.service,
        s.frequency,
        s.duration,
      ]),
      p.clinical_rationale,
      p.material_change,
      p.expedited_reason,
      p.oral_request_details,
    ].some((v) => v.includes('[['))
  )
    missing.push('Resolve template placeholders');
  return missing;
}
function packetSummary(p: RfaPacket) {
  return {
    id: p.id,
    patient_id: p.patient_id,
    authorization_id: p.authorization_id,
    encounter_id: p.encounter_id,
    status: p.status,
    revision: p.revision,
    claim_number: p.account.workers_comp?.claim_number,
    recipient: p.recipient.name,
    fax: p.recipient.fax,
    created_at: p.created_at,
    signed_at: p.signed_at,
  };
}
function packet(state: FinanceState, id: string | undefined) {
  return (
    state.rfa_packets.find((p) => p.id === id) ||
    fail(404, 'RFA packet not found')
  );
}
export function rfaRequest(
  state: FinanceState,
  ctx: WorkflowContext,
  method: string,
  url: URL,
  body: unknown,
  id?: string,
  action?: string,
) {
  const input = body as any;
  if (method === 'GET' && !id)
    return state.rfa_packets
      .filter(
        (p) =>
          !url.searchParams.get('patient_id') ||
          p.patient_id === url.searchParams.get('patient_id'),
      )
      .filter(
        (p) =>
          !url.searchParams.get('authorization_id') ||
          p.authorization_id === url.searchParams.get('authorization_id'),
      )
      .map(packetSummary);
  if (method === 'POST' && !id) {
    clinical(ctx);
    const a = auth(
      state,
      z.object({ authorization_id: z.string() }).parse(body).authorization_id,
    );
    return createRfaDraft(state, ctx, a);
  }
  const p = packet(state, id);
  if (method === 'GET') {
    clinical(ctx);
    return { ...p, missing: rfaIssues(p) };
  }
  if (action === 'queue-fax' && method === 'POST') {
    if (p.status !== 'Provider signed')
      fail(
        409,
        'The requesting physician must review and sign the RFA before fax preparation',
      );
    fresh(state, ctx, p);
    const a = auth(state, p.authorization_id);
    if (a.status !== 'Draft')
      fail(
        409,
        'Authorization has already advanced; use its existing fax history',
      );
    z.object({
      revision: z.literal(p.revision),
      recipient_confirmed: z.literal(true),
    }).parse(body);
    const existing = state.fax_jobs.find(
      (j) => j.rfa_id === p.id && j.packet_revision === p.revision,
    );
    if (existing) {
      if (existing.status === 'Demo cancelled')
        fail(
          409,
          'This fax attempt was cancelled. Create and review a new RFA version before queueing again',
        );
      return existing;
    }
    if (
      state.fax_jobs.some(
        (j) => j.authorization_id === a.id && j.status === 'Demo queued',
      )
    )
      fail(409, 'This authorization already has a queued fax packet');
    const j: FaxJob = {
      id: ctx.id('fax'),
      rfa_id: p.id,
      packet_revision: p.revision,
      authorization_id: a.id,
      patient_id: p.patient_id,
      recipient: p.recipient.name,
      fax: p.recipient.fax,
      status: 'Demo queued',
      attempts: 1,
      created_at: ctx.now,
      updated_at: ctx.now,
      history: [
        {
          status: 'Demo queued',
          at: ctx.now,
          actor: ctx.user.name,
          detail: 'Demo only; no fax was sent.',
        },
      ],
    };
    state.fax_jobs.push(j);
    ctx.audit('Queued demo RFA fax; no transmission', j.id);
    return j;
  }
  clinical(ctx);
  if (ctx.user.id !== p.author_id)
    fail(403, 'Only the supporting note’s physician can edit or sign this RFA');
  if (p.status !== 'Draft')
    fail(
      409,
      'Provider-signed RFA packets are locked; create a new packet for changes',
    );
  if (auth(state, p.authorization_id).status !== 'Draft')
    fail(409, 'Only draft authorizations can update an RFA');
  const revision = z
    .object({ revision: z.number().int() })
    .parse(body).revision;
  if (revision !== p.revision) fail(409, 'RFA changed; reload before saving');
  if (method === 'POST' && action === 'refresh') {
    const a = auth(state, p.authorization_id);
    const s = source(state, ctx, a);
    if (s.note.author_id !== ctx.user.id)
      fail(403, 'The supporting physician changed; create a new packet');
    Object.assign(p, snapshot(state, ctx, a), {
      authorization_revision: a.revision,
      encounter_id: s.note.id,
    });
    history(p, ctx, 'Refreshed RFA source details');
    return p;
  }
  fresh(state, ctx, p);
  if (method === 'PATCH' && !action) {
    const value = editable.parse(body);
    if (value.physician.name !== p.physician.name)
      fail(400, 'Requesting physician must match the signed supporting note');
    Object.assign(p, value);
    history(p, ctx, 'Saved RFA draft');
    return p;
  }
  if (method === 'POST' && action === 'sign') {
    const sign = z
      .object({
        typed_name: z.literal(ctx.user.name),
        attestation: z.literal(true),
      })
      .parse(body);
    const missing = rfaIssues(p);
    if (missing.length) fail(400, `Complete RFA review: ${missing.join('; ')}`);
    const a = auth(state, p.authorization_id);
    const codes = [
      ...new Set(p.services.map((s) => s.cpt_code).filter(Boolean)),
    ].sort();
    if (JSON.stringify(codes) !== JSON.stringify([...a.procedure_codes].sort()))
      fail(
        409,
        'RFA procedure codes differ from the linked authorization. Review the authorization and refresh the draft',
      );
    p.status = 'Provider signed';
    p.signed_at = ctx.now;
    p.signed_by = sign.typed_name;
    p.signature_date = ctx.today;
    history(p, ctx, 'Physician electronically attested and signed RFA');
    return p;
  }
  fail(404, 'RFA action not found');
}
export function faxRequest(
  state: FinanceState,
  ctx: WorkflowContext,
  method: string,
  url: URL,
  body: unknown,
  id?: string,
  action?: string,
) {
  if (method === 'GET')
    return state.fax_jobs.filter(
      (j) =>
        (!url.searchParams.get('patient_id') ||
          j.patient_id === url.searchParams.get('patient_id')) &&
        (!url.searchParams.get('authorization_id') ||
          j.authorization_id === url.searchParams.get('authorization_id')),
    );
  const j =
    state.fax_jobs.find((j) => j.id === id) || fail(404, 'Fax job not found');
  // Cancellation releases a stale queue entry without changing its signed RFA.
  // It must remain available even when source changes make transmission unsafe.
  if (method === 'POST' && action === 'cancel') {
    if (j.status !== 'Demo queued' && j.status !== 'Demo failed')
      fail(409, 'Only queued or failed demo fax attempts can be cancelled');
    const value = z
      .object({
        reason: z.string().trim().min(5).max(1000),
        current_status: z.enum(['Demo queued', 'Demo failed']),
        updated_at: z.string().min(1),
      })
      .parse(body);
    if (value.current_status !== j.status || value.updated_at !== j.updated_at)
      fail(
        409,
        'Fax attempt changed. Reload its current status before cancelling',
      );
    j.status = 'Demo cancelled';
    j.updated_at = ctx.now;
    j.history.push({
      status: j.status,
      at: ctx.now,
      actor: ctx.user.name,
      detail: `Cancelled: ${value.reason}. Demo only; no fax was transmitted.`,
    });
    ctx.audit('Cancelled demo RFA fax; no transmission', j.id);
    return j;
  }
  const p = packet(state, j.rfa_id);
  fresh(state, ctx, p);
  if (method === 'POST' && action === 'retry') {
    if (j.status !== 'Demo failed')
      fail(409, 'Only failed demo faxes can be retried');
    j.status = 'Demo queued';
    j.attempts++;
  } else if (method === 'POST' && action === 'simulate-result') {
    if (j.status !== 'Demo queued')
      fail(409, 'This demo fax attempt has already finished');
    const value = z
      .object({ result: z.enum(['Delivered', 'Failed']) })
      .parse(body);
    j.status =
      value.result === 'Delivered' ? 'Demo delivery simulated' : 'Demo failed';
    if (value.result === 'Delivered') {
      const a = auth(state, j.authorization_id);
      if (a.status !== 'Draft') fail(409, 'Authorization has already advanced');
      a.status = 'Demo submitted';
      a.revision++;
      a.updated_at = ctx.now;
      a.history.push({
        action: 'Demo fax delivery simulated',
        note: 'No fax sent. This is not carrier authorization or approval.',
        actor: ctx.user.name,
        at: ctx.now,
      });
    }
  } else fail(404, 'Fax action not found');
  j.updated_at = ctx.now;
  j.history.push({
    status: j.status,
    at: ctx.now,
    actor: ctx.user.name,
    detail: 'Demo only; no fax was transmitted.',
  });
  ctx.audit(j.status, j.id);
  return j;
}
