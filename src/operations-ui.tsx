import { useEffect, useState, type FormEvent } from 'react';
import {
  Bell,
  FileDown,
  FileText,
  Plus,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { api, patch, post } from './api';
import {
  Badge,
  Empty,
  Modal,
  fullName,
  mrn,
  prettyDate,
  timeLabel,
} from './components';
import { useResource } from './workflow-ui';
import { rfaDisplayTime } from '../server/rfa-engine';
import {
  serviceCategories,
  type ServiceApproval,
  type VisitPlan,
} from '../server/operations-engine';
import type { Patient, User } from './types';
import type { PriorAuthorization } from '../server/finance-engine';
import type { PatientBillingAccount } from '../server/patient-accounts';
import { scannedFaxExample } from './ocr-demo';
const base = '/workflow/operations';
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(
    new Date(),
  );
type ApprovalRow = ServiceApproval & {
  reserved: number;
  completed: number;
  remaining: number;
  valid_from: string;
  valid_to: string;
  active: boolean;
  approval_number: string;
};
function useAction(after?: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  return {
    busy,
    error,
    message,
    run: async (fn: () => Promise<unknown>, success = 'Saved') => {
      setBusy(true);
      setError('');
      setMessage('');
      try {
        await fn();
        await after?.();
        setMessage(success);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
  };
}
function Feedback({ action }: { action: ReturnType<typeof useAction> }) {
  return (
    <>
      {action.error && (
        <p className="form-error" role="alert">
          {action.error}
        </p>
      )}
      {action.message && (
        <p className="inline-success" role="status">
          {action.message}
        </p>
      )}
    </>
  );
}

export function ServiceAllowanceTools({
  authorization,
}: {
  authorization: PriorAuthorization;
}) {
  const resource = useResource<ApprovalRow[]>(
    `${base}/service-approvals?authorization_id=${authorization.id}`,
    [],
  );
  const [editing, setEditing] = useState<ApprovalRow | true | null>(null);
  const action = useAction(resource.reload);
  if (authorization.status !== 'Demo approved' && !resource.data.length)
    return null;
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget),
      old = editing === true ? undefined : editing;
    await action.run(async () => {
      const body = {
        ...Object.fromEntries(f),
        authorization_id: authorization.id,
        approved_quantity: Number(f.get('approved_quantity')),
        revision: old?.revision,
      };
      if (old) await patch(`${base}/service-approvals/${old.id}`, body);
      else await post(`${base}/service-approvals`, body);
      setEditing(null);
    }, 'Service allowance saved');
  }
  return (
    <section className="ops-subsection">
      <div className="section-heading">
        <div>
          <h4>Service-specific allowances</h4>
          <p className="muted">
            Scheduled and completed treatments, counted separately for each
            procedure.
          </p>
        </div>
        {authorization.status === 'Demo approved' && (
          <button
            className="button secondary small"
            onClick={() => setEditing(true)}
          >
            <Plus size={14} />
            Record service allowance
          </button>
        )}
      </div>
      {resource.error && (
        <p role="alert" className="form-error">
          {resource.error}
        </p>
      )}
      <Feedback action={action} />
      {resource.data.map((s) => (
        <div className="ops-allowance" key={s.id}>
          <div>
            <strong>
              {s.category} · {s.procedure_code}
            </strong>
            <p>{s.description}</p>
            <small>
              {s.reserved} scheduled · {s.completed} completed ·{' '}
              {s.approved_quantity} approved {s.unit.toLowerCase()}
            </small>
          </div>
          <Badge>
            {s.active ? `${s.remaining} remaining` : 'Approval needs review'}
          </Badge>
          <button className="text-button" onClick={() => setEditing(s)}>
            Edit allowance
          </button>
        </div>
      ))}
      {!resource.data.length && (
        <p className="muted">
          Record the service quantities from the demo approval before reserving
          treatments in Schedule.
        </p>
      )}
      {editing && (
        <Modal
          title="Record demo service allowance"
          onClose={() => setEditing(null)}
        >
          <form onSubmit={save}>
            <div className="modal-body form-grid">
              <p className="finance-help span-2">
                Enter the approved quantity for this service. This is a demo
                decision record. Claim preparation also checks the
                authorization’s overall visit limit.
              </p>
              <label>
                Procedure code
                <select
                  name="procedure_code"
                  defaultValue={
                    editing === true
                      ? authorization.procedure_codes[0]
                      : editing.procedure_code
                  }
                >
                  {(editing === true
                    ? authorization.procedure_codes
                    : [editing.procedure_code]
                  ).map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label>
                Service category
                <select
                  name="category"
                  defaultValue={
                    editing === true ? 'Office visit' : editing.category
                  }
                >
                  {serviceCategories.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="span-2">
                Treatment description
                <input
                  name="description"
                  required
                  maxLength={200}
                  defaultValue={editing === true ? '' : editing.description}
                />
              </label>
              <label>
                Approved quantity
                <input
                  name="approved_quantity"
                  type="number"
                  min="1"
                  max="1000"
                  required
                  defaultValue={
                    editing === true ? 1 : editing.approved_quantity
                  }
                />
              </label>
              <label>
                Counting unit
                <select
                  name="unit"
                  defaultValue={editing === true ? 'Visits' : editing.unit}
                >
                  {(editing === true
                    ? ['Visits', 'Units', 'Studies']
                    : [editing.unit]
                  ).map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="span-2">
                Approval / change note
                <textarea
                  name="decision_note"
                  minLength={5}
                  maxLength={1000}
                  required
                />
              </label>
              <div className="span-2">
                <Feedback action={action} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="button primary" disabled={action.busy}>
                Save service allowance
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
export function readVisitPlanForm(f: FormData) {
  const requirement = String(
    f.get('authorization_requirement') || 'unreviewed',
  );
  if (requirement === 'unreviewed') return undefined;
  const count = Number(f.get('service_count') || 0);
  return {
    authorization_required: requirement === 'required',
    coverage_mode: String(f.get('visit_coverage_mode') || 'Insurance'),
    services:
      requirement === 'required'
        ? Array.from({ length: count }, (_, i) => ({
            approval_id: String(f.get(`service_approval_${i}`) || ''),
            procedure_code: String(f.get(`service_code_${i}`) || ''),
            quantity: Number(f.get(`service_quantity_${i}`) || 1),
          }))
        : [],
  };
}
export function VisitServiceFields({
  patientId,
  billingId,
  date,
  existing,
  appointmentId,
}: {
  patientId: string;
  billingId: string;
  date: string;
  existing?: VisitPlan | null;
  appointmentId?: string;
}) {
  const resource = useResource<ApprovalRow[]>(
    `${base}/service-approvals?patient_id=${patientId}${appointmentId ? `&except_appointment=${appointmentId}` : ''}`,
    [],
  );
  const [requirement, setRequirement] = useState(
    existing
      ? existing.authorization_required
        ? 'required'
        : 'not-required'
      : 'unreviewed',
  );
  const [services, setServices] = useState(
    existing?.services.length
      ? existing.services
      : [{ approval_id: '', procedure_code: '', quantity: 1 }],
  );
  const rows = resource.data.filter(
    (s) =>
      s.patient_id === patientId &&
      s.billing_account_id === billingId &&
      s.active &&
      s.valid_from <= date &&
      s.valid_to >= date,
  );
  return (
    <fieldset className="ops-fieldset span-2">
      <legend>Treatment authorization for this visit</legend>
      <label>
        Coverage for this visit
        <select
          name="visit_coverage_mode"
          defaultValue={existing?.coverage_mode || 'Insurance'}
        >
          <option>Insurance</option>
          <option>Self-pay</option>
        </select>
      </label>
      <label>
        Authorization review
        <select
          name="authorization_requirement"
          value={requirement}
          onChange={(e) => setRequirement(e.target.value)}
        >
          <option value="unreviewed">
            Not reviewed yet — flag before visit
          </option>
          <option value="not-required">
            Reviewed — authorization not required
          </option>
          <option value="required">Authorization required</option>
        </select>
      </label>
      <p className="muted">
        {rows.length
          ? `${rows.length} service allowance(s) available for the selected account and date.`
          : 'No active service allowances for the selected account and date.'}{' '}
        Unapproved services can be scheduled and remain flagged for follow-up.
      </p>
      <input type="hidden" name="service_count" value={services.length} />
      {requirement === 'required' &&
        services.map((s, i) => (
          <div className="ops-service-input" key={i}>
            <label>
              Service approval {i + 1}
              <select
                name={`service_approval_${i}`}
                value={s.approval_id}
                onChange={(e) => {
                  const chosen = rows.find((r) => r.id === e.target.value);
                  setServices(
                    services.map((x, j) =>
                      j === i
                        ? {
                            ...x,
                            approval_id: e.target.value,
                            procedure_code:
                              chosen?.procedure_code || x.procedure_code,
                          }
                        : x,
                    ),
                  );
                }}
              >
                <option value="">Pending / no approval — flag visit</option>
                {rows.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.category} · {r.procedure_code} · {r.remaining}{' '}
                    {r.unit.toLowerCase()} remaining · {r.approval_number}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-grid">
              <label>
                Procedure code {i + 1}
                <input
                  name={`service_code_${i}`}
                  value={s.procedure_code}
                  required
                  maxLength={5}
                  onChange={(e) =>
                    setServices(
                      services.map((x, j) =>
                        j === i ? { ...x, procedure_code: e.target.value } : x,
                      ),
                    )
                  }
                />
              </label>
              <label>
                Quantity for visit {i + 1}
                <input
                  name={`service_quantity_${i}`}
                  type="number"
                  min="1"
                  max="1000"
                  required
                  value={s.quantity}
                  onChange={(e) =>
                    setServices(
                      services.map((x, j) =>
                        j === i
                          ? { ...x, quantity: Number(e.target.value) }
                          : x,
                      ),
                    )
                  }
                />
              </label>
            </div>
            {services.length > 1 && (
              <button
                className="text-button"
                type="button"
                onClick={() => setServices(services.filter((_, j) => j !== i))}
              >
                Remove service {i + 1}
              </button>
            )}
          </div>
        ))}
      {requirement === 'required' && services.length < 20 && (
        <button
          type="button"
          className="text-button"
          onClick={() =>
            setServices([
              ...services,
              { approval_id: '', procedure_code: '', quantity: 1 },
            ])
          }
        >
          Add another service
        </button>
      )}
      {resource.error && (
        <p className="form-error" role="alert">
          {resource.error}
        </p>
      )}
    </fieldset>
  );
}
type ReadinessRow = {
  id: string;
  patient_id: string;
  first_name: string;
  last_name: string;
  date: string;
  time: string;
  status: string;
  billing_account_id: string;
  account_name: string;
  claim_number: string;
  issues: string[];
  ready: boolean;
  plan: VisitPlan | null;
};
export function ReadinessPage({ onChart }: { onChart: (id: string) => void }) {
  const [date, setDate] = useState(today),
    [onlyIssues, setOnlyIssues] = useState(false),
    [editing, setEditing] = useState<ReadinessRow | null>(null);
  const resource = useResource<ReadinessRow[]>(
    `${base}/readiness?date=${date}`,
    [],
  );
  const action = useAction(resource.reload);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const plan = readVisitPlanForm(new FormData(e.currentTarget));
    await action.run(async () => {
      if (!plan) throw Error('Choose whether authorization is required');
      await post(`${base}/visit-plans/${editing!.id}`, {
        ...plan,
        revision: editing!.plan?.revision,
      });
      setEditing(null);
    }, 'Visit authorization review saved');
  }
  return (
    <div className="workflow-stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Pre-visit readiness</h2>
            <p>
              Check the insurance selected for each visit, intake, documents and
              treatment approvals.
            </p>
          </div>
          <button
            className="button secondary"
            onClick={() =>
              void action.run(resource.reload, 'Readiness refreshed')
            }
            disabled={action.busy}
          >
            <RefreshCw size={15} />
            Refresh readiness
          </button>
        </div>
        <div className="finance-toolbar">
          <label>
            Readiness date
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={onlyIssues}
              onChange={(e) => setOnlyIssues(e.target.checked)}
            />
            Only visits needing attention
          </label>
          <strong>
            {resource.data.filter((r) => r.ready).length} ready ·{' '}
            {resource.data.filter((r) => !r.ready).length} need attention
          </strong>
        </div>
        <Feedback action={action} />
        {resource.error && (
          <p className="form-error" role="alert">
            {resource.error}
          </p>
        )}
        <div className="finance-cards">
          {resource.data
            .filter((r) => !onlyIssues || !r.ready)
            .map((r) => (
              <article className="finance-card" key={r.id}>
                <div className="finance-card-header">
                  <div>
                    <h3>{fullName(r)}</h3>
                    <p>
                      {timeLabel(r.time)} · {r.status} · {r.account_name}
                      {r.claim_number ? ` · Claim ${r.claim_number}` : ''}
                    </p>
                  </div>
                  <Badge>{r.ready ? 'Ready' : 'Needs attention'}</Badge>
                </div>
                {r.issues.length ? (
                  <ul className="ops-checklist">
                    {r.issues.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="inline-success">Readiness checks complete.</p>
                )}
                <div className="button-row">
                  <button
                    className="button secondary small"
                    onClick={() => onChart(r.patient_id)}
                  >
                    Open patient record
                  </button>
                  {['Scheduled', 'Checked in'].includes(r.status) && (
                    <button
                      className="button secondary small"
                      onClick={() => setEditing(r)}
                    >
                      Review visit services
                    </button>
                  )}
                </div>
              </article>
            ))}
        </div>
        {!resource.loading && !resource.data.length && (
          <Empty
            icon={ShieldCheck}
            title="No visits on this date"
            description="Schedule a visit to review its readiness."
          />
        )}
      </section>
      {editing && (
        <Modal
          title="Review visit services"
          subtitle={`${fullName(editing)} · ${prettyDate(editing.date)} · ${editing.account_name}`}
          onClose={() => setEditing(null)}
        >
          <form onSubmit={save}>
            <div className="modal-body">
              <VisitServiceFields
                key={editing.id}
                patientId={editing.patient_id}
                billingId={editing.billing_account_id}
                date={editing.date}
                existing={editing.plan}
                appointmentId={editing.id}
              />
              <Feedback action={action} />
            </div>
            <div className="modal-footer">
              <button className="button primary" disabled={action.busy}>
                Save visit services
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

type FaxRow = {
  id: string;
  external_id: string;
  sender: string;
  filename: string;
  format: 'text' | 'pdf';
  received_at: string;
  revision: number;
  status: string;
  patient_id: string;
  patient_name: string;
  billing_account_id: string;
  match_reason: string;
  kind: string;
  reviewed_at: string | null;
  reviewed_by: string;
  pages: number;
  history: { at: string; actor: string; note: string }[];
  original_base64?: string;
  extracted_text?: string;
  extraction_method?: 'text' | 'pdf-text' | 'ocr' | 'mixed' | 'unreadable';
  extraction_issue?: string;
  ocr_engine?: string;
  ocr_confidence?: number | null;
  ocr_pages?: number[];
  extraction_reviewed_at?: string | null;
  extraction_reviewed_by?: string;
};
type Notice = {
  id: string;
  fax_id: string;
  patient_id: string;
  patient_name: string;
  title: string;
  created_at: string;
  acknowledged: boolean;
};
export function FaxAlertButton({ onOpen }: { onOpen: () => void }) {
  const resource = useResource<Notice[]>(`${base}/alerts`, []);
  useEffect(() => {
    const reload = () => void resource.reload().catch(() => {});
    const timer = setInterval(reload, 15000);
    window.addEventListener('cevrali-fax-updated', reload);
    window.addEventListener('focus', reload);
    return () => {
      clearInterval(timer);
      window.removeEventListener('cevrali-fax-updated', reload);
      window.removeEventListener('focus', reload);
    };
  }, [resource.reload]);
  const unread = resource.data.filter((n) => !n.acknowledged).length;
  return (
    <button
      className="notification-button icon-button"
      aria-label={`Fax alerts, ${unread} unread`}
      title="Incoming fax alerts"
      onClick={onOpen}
    >
      <Bell size={19} />
      {unread > 0 && <span className="ops-alert-count">{unread}</span>}
    </button>
  );
}
function refreshAlerts() {
  window.dispatchEvent(new Event('cevrali-fax-updated'));
}
function downloadDocument(f: FaxRow) {
  const bytes = Uint8Array.from(atob(f.original_base64!), (c) =>
    c.charCodeAt(0),
  );
  const url = URL.createObjectURL(
    new Blob([bytes], {
      type: f.format === 'pdf' ? 'application/pdf' : 'text/plain;charset=utf-8',
    }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `received-${f.id}.${f.format === 'pdf' ? 'pdf' : 'txt'}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function FaxDocument({
  fax,
  clinical,
  patients,
  onChanged,
  onClose,
}: {
  fax: FaxRow;
  clinical: boolean;
  patients: Patient[];
  onChanged: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState(fax),
    [target, setTarget] = useState(fax.patient_id),
    [billing, setBilling] = useState(fax.billing_account_id || ''),
    [correctedKind, setCorrectedKind] = useState(fax.kind),
    [correctedText, setCorrectedText] = useState(fax.extracted_text || ''),
    [loadError, setLoadError] = useState('');
  const accounts = useResource<PatientBillingAccount[]>(
    `/workflow/finance/accounts?patient_id=${target}`,
    [],
  );
  const patientDirectory = useResource<Patient[]>('/patients', []);
  const action = useAction(onChanged);
  useEffect(() => {
    if (clinical)
      void api<FaxRow>(`${base}/incoming-faxes/${fax.id}`)
        .then((received) => {
          setDetail(received);
          setCorrectedKind(received.kind);
          setCorrectedText(received.extracted_text || '');
        })
        .catch((error: Error) => setLoadError(error.message));
  }, [clinical, fax.id]);
  async function reviewExtraction(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await action.run(async () => {
      const received = await post<FaxRow>(`${base}/incoming-faxes/${detail.id}/review-extraction`, {
        revision: detail.revision,
        kind: correctedKind,
        text: correctedText,
        identity_confirmed: form.get('identity_confirmed') === 'on',
        values_confirmed: form.get('values_confirmed') === 'on',
        reason: form.get('reason'),
      });
      setDetail(received);
      setCorrectedKind(received.kind);
      setCorrectedText(received.extracted_text || '');
      refreshAlerts();
    }, 'Classification and text verified. Confirm the patient and claim to file an unmatched document.');
  }
  async function file(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await action.run(async () => {
      await post(`${base}/incoming-faxes/${fax.id}/file`, {
        revision: detail.revision,
        patient_id: target,
        billing_account_id: billing,
        identity_confirmed: f.get('identity_confirmed') === 'on',
        reason: f.get('reason'),
      });
      refreshAlerts();
      onClose();
    }, 'Document filed');
  }
  return (
    <Modal
      title="Received fax document"
      subtitle={`${fax.sender} · ${rfaDisplayTime(fax.received_at)}`}
      onClose={onClose}
      wide
    >
      <div className="modal-body workflow-stack">
        <div className="finance-notice">
          <FileText size={20} />
          <div>
            <strong>
              {detail.kind} · {detail.status}
            </strong>
            <p>
              {detail.match_reason}. Clinical content remains unreviewed until a
              clinician acknowledges it.
            </p>
          </div>
        </div>
        {clinical ? (
          <>
            <div className="button-row">
              <button
                className="button secondary"
                disabled={!detail.original_base64}
                onClick={() => downloadDocument(detail)}
              >
                <FileDown size={15} />
                Download original document
              </button>
              {detail.status === 'Filed' && !detail.reviewed_at && !detail.extraction_issue && (
                <button
                  className="button primary"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await post(`${base}/incoming-faxes/${detail.id}/review`, {
                        revision: detail.revision,
                        reason:
                          'Clinician reviewed the original outside document',
                      });
                      onClose();
                    }, 'Clinical review recorded')
                  }
                >
                  Mark document clinically reviewed
                </button>
              )}
            </div>
            {loadError && <p className="form-error" role="alert">{loadError}</p>}
            <p className="finance-help">
              Extraction: {detail.ocr_engine || (detail.format === 'pdf' ? 'PDF text layer' : 'Received text')}
              {detail.ocr_pages?.length ? ` · OCR pages ${detail.ocr_pages.join(', ')}` : ''}
              {detail.ocr_confidence != null ? ` · OCR confidence ${detail.ocr_confidence}%` : ''}.
              {detail.ocr_pages?.length ? ' OCR confidence measures text recognition quality; verify every clinical value against the original.' : ''}
            </p>
            {detail.extraction_issue && (
              <p className="form-error" role="alert">{detail.extraction_issue}</p>
            )}
            <details open>
              <summary>Extracted document text</summary>
              <pre className="ops-document-text">
                {detail.extracted_text ||
                  'No readable text. Review the original and enter a verified transcription below.'}
              </pre>
            </details>
            <details open={Boolean(detail.extraction_issue)}>
              <summary>Correct document type / verify extracted text</summary>
              <form onSubmit={reviewExtraction} className="workflow-stack">
                <p className="finance-help">
                  Compare every original page before saving. A correction retains the original file,
                  reopens draft-result review and flags any affected signed note for an addendum.
                </p>
                <label>
                  Document type
                  <select value={correctedKind} onChange={(e) => setCorrectedKind(e.target.value)} required>
                    {['Outside document', 'Radiology report', 'Specialist note', 'Lab report',
                      'Authorization letter', 'Referral', 'Other'].map((kind) => <option key={kind}>{kind}</option>)}
                  </select>
                </label>
                <label>
                  Verified extracted text / manual transcription
                  <textarea rows={12} value={correctedText} onChange={(e) => setCorrectedText(e.target.value)}
                    required maxLength={100000} />
                </label>
                <label>
                  Review / correction reason
                  <textarea name="reason" required minLength={5} maxLength={1000} />
                </label>
                <label className="checkbox-label">
                  <input name="identity_confirmed" type="checkbox" required />
                  I reviewed the original and verified patient identifiers.
                </label>
                <label className="checkbox-label">
                  <input name="values_confirmed" type="checkbox" required />
                  I compared every original page and verified all text, values, units and document type.
                </label>
                <button className="button secondary" disabled={action.busy || !detail.original_base64}>
                  Save verified classification and text
                </button>
              </form>
            </details>
            {detail.extraction_reviewed_at && <p className="inline-success">
              Extraction verified by {detail.extraction_reviewed_by} · {rfaDisplayTime(detail.extraction_reviewed_at)}
            </p>}
            <form onSubmit={file}>
              <fieldset className="ops-fieldset">
                <legend>
                  {fax.status === 'Filed'
                    ? 'Correct patient / claim filing'
                    : 'Review identity and file to chart'}
                </legend>
                <div className="form-grid">
                  <label>
                    File to patient
                    <select
                      value={target}
                      onChange={(e) => {
                        setTarget(e.target.value);
                        setBilling('');
                      }}
                      required
                    >
                      <option value="">Choose the verified patient</option>
                      {(patients.length ? patients : patientDirectory.data).map(
                        (p) => (
                          <option key={p.id} value={p.id}>
                            {fullName(p)} · {p.dob} · {mrn(p.id)}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label>
                    Claim / account for document
                    <select
                      value={billing}
                      onChange={(e) => setBilling(e.target.value)}
                    >
                      <option value="">
                        General patient document — no claim assigned
                      </option>
                      {accounts.data
                        .filter((a) => a.patient_id === target)
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                            {a.workers_comp
                              ? ` · ${a.workers_comp.claim_number}`
                              : ''}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="span-2">
                    Filing / correction reason
                    <textarea
                      name="reason"
                      required
                      minLength={5}
                      maxLength={1000}
                    />
                  </label>
                  <label className="checkbox-label span-2">
                    <input name="identity_confirmed" type="checkbox" required />
                    I reviewed the original and verified the patient and claim.
                  </label>
                </div>
                {detail.extraction_issue && <p className="finance-help">Complete original-document text review above before filing.</p>}
                <button className="button primary" disabled={action.busy || Boolean(detail.extraction_issue)}>
                  Confirm and file document
                </button>
              </fieldset>
            </form>
            {fax.status === 'Needs review' && (
              <button
                className="text-button"
                disabled={action.busy}
                onClick={() => {
                  const reason = window.prompt(
                    'Reason to dismiss this unmatched fax:',
                  );
                  if (reason)
                    void action.run(async () => {
                      await post(
                        `${base}/incoming-faxes/${detail.id}/dismiss`,
                        { revision: detail.revision, reason },
                      );
                      onClose();
                    });
                }}
              >
                Dismiss unrelated fax with reason
              </button>
            )}
          </>
        ) : (
          <p className="finance-help">
            Front desk can track receipt and filing status. A clinician reviews
            document contents and resolves uncertain matches.
          </p>
        )}
        {detail.reviewed_at && (
          <p className="inline-success">
            Clinically reviewed by {detail.reviewed_by} ·{' '}
            {rfaDisplayTime(detail.reviewed_at)}
          </p>
        )}
        <Feedback action={action} />
        <details>
          <summary>Receipt and filing history</summary>
          {detail.history.map((h, i) => (
            <p className="muted" key={i}>
              {rfaDisplayTime(h.at)} · {h.actor} · {h.note}
            </p>
          ))}
        </details>
      </div>
    </Modal>
  );
}
export function PatientDocuments({
  patientId,
  clinical,
}: {
  patientId: string;
  clinical: boolean;
}) {
  const resource = useResource<FaxRow[]>(
    `${base}/documents?patient_id=${patientId}`,
    [],
  );
  const [selected, setSelected] = useState<FaxRow | null>(null);
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Received documents</h2>
          <p>
            Original outside records saved from incoming faxes. Filing does not
            update diagnoses, medications or authorization decisions.
          </p>
        </div>
      </div>
      {resource.error && (
        <p role="alert" className="form-error">
          {resource.error}
        </p>
      )}
      <div className="finance-cards">
        {resource.data.map((f) => (
          <article className="finance-card" key={f.id}>
            <div className="finance-card-header">
              <div>
                <h3>{f.kind}</h3>
                <p>
                  {f.sender} · {rfaDisplayTime(f.received_at)}
                </p>
              </div>
              <Badge>
                {f.reviewed_at
                  ? 'Clinically reviewed'
                  : 'Awaiting clinical review'}
              </Badge>
            </div>
            {clinical && (
              <button
                className="button secondary small"
                onClick={() => setSelected(f)}
              >
                Open received document
              </button>
            )}
            {!clinical && (
              <p className="muted">
                Saved to chart · clinical content restricted
              </p>
            )}
          </article>
        ))}
      </div>
      {!resource.loading && !resource.data.length && (
        <Empty
          icon={FileText}
          title="No received documents"
          description="Matched incoming faxes will appear here automatically."
        />
      )}
      {selected && (
        <FaxDocument
          fax={selected}
          clinical={clinical}
          patients={[]}
          onChanged={resource.reload}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}
export function FaxInboxPage({
  patients,
  clinical,
  onChart,
}: {
  patients: Patient[];
  clinical: boolean;
  onChart: (id: string) => void;
}) {
  const resource = useResource<FaxRow[]>(`${base}/incoming-faxes`, []),
    alerts = useResource<Notice[]>(`${base}/alerts`, []);
  const [receiving, setReceiving] = useState(false),
    [selected, setSelected] = useState<FaxRow | null>(null),
    [filter, setFilter] = useState('All'),
    [samplePatient, setSamplePatient] = useState(''),
    [documentText, setDocumentText] = useState('');
  const reload = async () => {
    await Promise.all([resource.reload(), alerts.reload()]);
    refreshAlerts();
  };
  const action = useAction(reload);
  useEffect(() => {
    const timer = setInterval(() => void reload().catch(() => {}), 15000);
    return () => clearInterval(timer);
  }, [resource.reload, alerts.reload]);
  async function receive(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await action.run(async () => {
      const file = f.get('pdf') as File;
      let format = 'text',
        original_base64: string | undefined;
      if (file?.size) {
        if (file.size > 2000000) throw Error('PDF must be no larger than 2 MB');
        format = 'pdf';
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (const b of bytes) binary += String.fromCharCode(b);
        original_base64 = btoa(binary);
      }
      await post(`${base}/incoming-faxes`, {
        external_id: f.get('external_id'),
        sender: f.get('sender'),
        filename: file?.size ? file.name : 'demo-received-document.txt',
        format,
        text: documentText,
        original_base64,
      });
      setReceiving(false);
    }, 'Demo fax processed. Check filing status and front-desk alerts.');
  }
  function loadSample() {
    const p = patients.find((p) => p.id === samplePatient) || patients[0];
    if (p) {
      setSamplePatient(p.id);
      setDocumentText(
        `Patient Name: ${fullName(p)}\nDOB: ${p.dob}\nMRN: ${mrn(p.id)}\nDocument Type: Radiology report\n\nSynthetic outside report for demonstration. Provider review is required.\nNo clinical findings or treatment decisions are inferred by filing this document.`,
      );
    }
  }
  return (
    <div className="workflow-stack">
      <div className="finance-notice">
        <ShieldCheck size={20} />
        <div>
          <strong>Electronic fax · demo connection</strong>
          <p>
            Simulate a facility’s incoming fax with text or a PDF. Exact
            identifiers can file it automatically; uncertain matches stay in
            review. The connected server reads scanned PDFs with local OCR and
            holds them for clinician identity and value review. Standalone preview
            supports manual transcription. Live fax delivery uses the demo connection.
          </p>
        </div>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Front-desk fax alerts</h2>
            <p>
              Each staff member acknowledges their own alerts. New receipts
              appear within 15 seconds.
            </p>
          </div>
        </div>
        <div className="finance-cards">
          {alerts.data
            .filter((n) => !n.acknowledged)
            .map((n) => (
              <article className="ops-notice" key={n.id}>
                <div>
                  <strong>{n.title}</strong>
                  <p>
                    {n.patient_name || 'Unmatched document'} ·{' '}
                    {rfaDisplayTime(n.created_at)}
                  </p>
                </div>
                <div className="button-row">
                  {n.patient_id && (
                    <button
                      className="text-button"
                      onClick={() => onChart(n.patient_id)}
                    >
                      Open patient record
                    </button>
                  )}
                  <button
                    className="button secondary small"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(
                        () => post(`${base}/alerts/${n.id}/acknowledge`, {}),
                        'Alert acknowledged',
                      )
                    }
                  >
                    Acknowledge alert
                  </button>
                </div>
              </article>
            ))}
          {!alerts.data.some((n) => !n.acknowledged) && (
            <p className="finance-help">No unread fax alerts.</p>
          )}
        </div>
        {alerts.error && (
          <p className="form-error" role="alert">
            {alerts.error}
          </p>
        )}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Incoming fax inbox</h2>
            <p>Originals, patient matching, chart filing and review history.</p>
          </div>
          <div className="button-row">
            <button
              className="button secondary"
              onClick={() => void action.run(reload, 'Inbox refreshed')}
            >
              Refresh inbox
            </button>
            <button
              className="button primary"
              onClick={() => setReceiving(true)}
            >
              <Plus size={15} />
              Receive demo fax
            </button>
          </div>
        </div>
        <Feedback action={action} />
        {resource.error && (
          <p role="alert" className="form-error">
            {resource.error}
          </p>
        )}
        <div className="finance-toolbar">
          <label>
            Fax filing status
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              {['All', 'Needs review', 'Filed', 'Dismissed'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="finance-cards">
          {resource.data
            .filter((f) => filter === 'All' || f.status === filter)
            .slice()
            .reverse()
            .map((f) => (
              <article className="finance-card" key={f.id}>
                <div className="finance-card-header">
                  <div>
                    <h3>
                      {f.kind} · {f.sender}
                    </h3>
                    <p>
                      {f.patient_name || 'Patient not matched'} ·{' '}
                      {rfaDisplayTime(f.received_at)} · {f.external_id}
                    </p>
                  </div>
                  <Badge>
                    {f.status === 'Filed' ? 'Saved to chart' : f.status}
                  </Badge>
                </div>
                <p className="finance-help">{f.match_reason}</p>
                <div className="button-row">
                  <button
                    className="button secondary small"
                    onClick={() => setSelected(f)}
                  >
                    {clinical ? 'Review received fax' : 'View receipt details'}
                  </button>
                  {f.patient_id && (
                    <button
                      className="text-button"
                      onClick={() => onChart(f.patient_id)}
                    >
                      Open patient record
                    </button>
                  )}
                  {f.status === 'Filed' && (
                    <Badge>
                      {f.reviewed_at
                        ? 'Clinically reviewed'
                        : 'Clinical review pending'}
                    </Badge>
                  )}
                </div>
              </article>
            ))}
        </div>
        {!resource.loading && !resource.data.length && (
          <Empty
            icon={FileText}
            title="No incoming faxes yet"
            description="Receive a demo fax to see automatic filing and front-desk alerts."
          />
        )}
      </section>
      {selected && (
        <FaxDocument
          fax={selected}
          clinical={clinical}
          patients={patients}
          onChanged={reload}
          onClose={() => setSelected(null)}
        />
      )}
      {receiving && (
        <Modal title="Receive a demo fax" onClose={() => setReceiving(false)}>
          <form onSubmit={receive}>
            <div className="modal-body workflow-stack">
              <p className="finance-help">
                This simulates the incoming connection from another facility.
                PDF text is extracted from the original file. Scanned pages use
                local OCR on the connected server and remain held for clinician
                review. Standalone preview requires manual transcription of scans.
              </p>
              <div className="form-grid">
                <label>
                  Sending facility
                  <input
                    name="sender"
                    required
                    maxLength={200}
                    defaultValue="Synthetic Imaging Center"
                  />
                </label>
                <label>
                  Facility fax reference
                  <input
                    name="external_id"
                    required
                    maxLength={150}
                    defaultValue={`DEMO-${Date.now()}`}
                  />
                </label>
                <label className="span-2">
                  Attach received PDF (optional, up to 2 MB)
                  <input name="pdf" type="file" accept="application/pdf,.pdf" />
                </label>
                <label className="span-2">
                  Received document text
                  <textarea
                    name="document_text"
                    rows={10}
                    value={documentText}
                    onChange={(e) => setDocumentText(e.target.value)}
                    maxLength={100000}
                  />
                </label>
                <label>
                  Example patient
                  <select
                    value={samplePatient}
                    onChange={(e) => setSamplePatient(e.target.value)}
                  >
                    <option value="">Choose a synthetic patient</option>
                    {patients.map((p) => (
                      <option key={p.id} value={p.id}>
                        {fullName(p)}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="button secondary"
                  onClick={loadSample}
                >
                  Load synthetic fax example
                </button>
                <button type="button" className="button secondary span-2" disabled={action.busy || !patients.length}
                  onClick={() => void action.run(async () => {
                    const patient = patients.find((p) => p.id === samplePatient) || patients[0];
                    if (!patient) throw Error('Choose a synthetic patient first');
                    await post(`${base}/incoming-faxes`, {
                      external_id: `OCR-DEMO-${Date.now()}`,
                      sender: 'Synthetic OCR Demonstration Facility',
                      filename: 'synthetic-scanned-report.pdf',
                      format: 'pdf',
                      original_base64: await scannedFaxExample(patient),
                    });
                    setReceiving(false);
                  }, 'Image-only PDF received. Open the held document to review OCR or enter a verified manual transcription.')}>
                  Receive scanned PDF example
                </button>
              </div>
              <p className="muted">
                For matching, include labelled lines for Patient Name, DOB
                and/or MRN. Include Claim Number to file under a particular
                workers’ comp account. Documents with conflicting identifiers
                are held for review.
              </p>
              <Feedback action={action} />
            </div>
            <div className="modal-footer">
              <button className="button primary" disabled={action.busy}>
                {action.busy ? 'Processing document…' : 'Process demo fax'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

type ClaimRow = {
  account: PatientBillingAccount;
  authorizations: PriorAuthorization[];
  services: ApprovalRow[];
  appointments: { id: string; date: string; time: string; status: string }[];
  bills: { id: string; service_date: string; claim_status: string }[];
  outgoing_faxes: { id: string; status: string; updated_at: string }[];
  documents: FaxRow[];
  work_status: {
    signed_at: string;
    documentation: {
      work_status: string;
      restrictions: string;
      next_review_date: string;
    };
  } | null;
};
export function ClaimWorkspace({
  patientId,
  clinical,
}: {
  patientId: string;
  clinical: boolean;
}) {
  const resource = useResource<ClaimRow[]>(
    `${base}/claims?patient_id=${patientId}`,
    [],
  );
  const [selected, setSelected] = useState('');
  const row =
    resource.data.find((r) => r.account.id === selected) || resource.data[0];
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Workers’ comp claim workspace</h2>
          <p>
            Keep each injury claim’s approvals, visits, documents and billing
            together.
          </p>
        </div>
      </div>
      {resource.error && (
        <p className="form-error" role="alert">
          {resource.error}
        </p>
      )}
      {row ? (
        <div className="modal-body workflow-stack">
          <label>
            Claim workspace account
            <select
              value={row.account.id}
              onChange={(e) => setSelected(e.target.value)}
            >
              {resource.data.map((r) => (
                <option key={r.account.id} value={r.account.id}>
                  {r.account.name} · {r.account.workers_comp?.claim_number}
                </option>
              ))}
            </select>
          </label>
          <div className="finance-card">
            <div className="finance-card-header">
              <div>
                <h3>Claim {row.account.workers_comp?.claim_number}</h3>
                <p>
                  {row.account.workers_comp?.carrier} · Injury{' '}
                  {prettyDate(row.account.workers_comp?.date_of_injury || '')}
                </p>
              </div>
              <Badge>
                {row.account.workers_comp?.claim_status || 'Pending'}
              </Badge>
            </div>
            <dl className="finance-details">
              <div>
                <dt>Employer</dt>
                <dd>{row.account.workers_comp?.employer}</dd>
              </div>
              <div>
                <dt>Accepted body parts</dt>
                <dd>
                  {row.account.workers_comp?.accepted_body_parts.join(', ') ||
                    'Not recorded'}
                </dd>
              </div>
              <div>
                <dt>Adjuster</dt>
                <dd>
                  {row.account.workers_comp?.adjuster_name || 'Not recorded'} ·{' '}
                  {row.account.workers_comp?.adjuster_phone || ''}
                </dd>
              </div>
            </dl>
          </div>
          {clinical && (
            <section className="ops-subsection">
              <h3>Latest signed work status</h3>
              {row.work_status?.documentation ? (
                <>
                  <p>
                    {row.work_status.documentation.work_status} ·{' '}
                    {rfaDisplayTime(row.work_status.signed_at)}
                  </p>
                  <p className="ops-preserve-text">
                    {row.work_status.documentation.restrictions ||
                      'No restrictions recorded'}
                  </p>
                  <p>
                    Next review:{' '}
                    {row.work_status.documentation.next_review_date ||
                      'Not recorded'}
                  </p>
                </>
              ) : (
                <p className="muted">
                  No signed workers’ compensation documentation yet.
                </p>
              )}
            </section>
          )}
          <section className="ops-subsection">
            <h3>Treatment authorizations</h3>
            {row.authorizations.map((a) => (
              <div className="ops-allowance" key={a.id}>
                <div>
                  <strong>{a.description}</strong>
                  <p>
                    {a.procedure_codes.join(', ')} · {prettyDate(a.valid_from)}{' '}
                    – {prettyDate(a.valid_to)}
                  </p>
                </div>
                <Badge>{a.status}</Badge>
              </div>
            ))}
            {!row.authorizations.length && (
              <p className="muted">No authorization requests for this claim.</p>
            )}
            {row.services.map((s) => (
              <p key={s.id}>
                {s.category} · {s.procedure_code}:{' '}
                <strong>
                  {s.remaining} {s.unit.toLowerCase()} remaining
                </strong>{' '}
                · {s.reserved} scheduled · {s.completed} completed
              </p>
            ))}
          </section>
          <div className="ops-workspace-grid">
            <section className="ops-subsection">
              <h3>Claim visits</h3>
              {row.appointments.map((a) => (
                <p key={a.id}>
                  {prettyDate(a.date)} · {timeLabel(a.time)} · {a.status}
                </p>
              ))}
              {!row.appointments.length && (
                <p className="muted">No scheduled visits.</p>
              )}
            </section>
            <section className="ops-subsection">
              <h3>Billing</h3>
              {row.bills.map((b) => (
                <p key={b.id}>
                  {prettyDate(b.service_date)} · {b.claim_status}
                </p>
              ))}
              {!row.bills.length && (
                <p className="muted">No bills for this claim.</p>
              )}
            </section>
            <section className="ops-subsection">
              <h3>Outgoing RFA faxes</h3>
              {row.outgoing_faxes.map((f) => (
                <p key={f.id}>
                  {f.status} · {rfaDisplayTime(f.updated_at)}
                </p>
              ))}
              {!row.outgoing_faxes.length && (
                <p className="muted">No outgoing RFA faxes.</p>
              )}
            </section>
            <section className="ops-subsection">
              <h3>Received claim documents</h3>
              {row.documents.map((f) => (
                <p key={f.id}>
                  {f.kind} · {f.sender} ·{' '}
                  {f.reviewed_at ? 'Reviewed' : 'Awaiting clinical review'}
                </p>
              ))}
              {!row.documents.length && (
                <p className="muted">
                  No incoming documents assigned to this claim.
                </p>
              )}
            </section>
          </div>
        </div>
      ) : (
        !resource.loading && (
          <Empty
            icon={ShieldCheck}
            title="No workers’ comp claims"
            description="Add a workers’ compensation billing account to use this workspace."
          />
        )
      )}
    </section>
  );
}

export function ReceivedResultsSection({
  encounterId,
  locked,
  onVersion,
}: {
  encounterId: string;
  locked: boolean;
  onVersion: (version: number) => void;
}) {
  const resource = useResource<{
    results: import('../server/note-results').NoteResult[];
    version: number;
    candidates: {
      id: string;
      sender: string;
      kind: string;
      received_at: string;
    }[];
  }>(`${base}/note-results?encounter_id=${encounterId}`, {
    results: [],
    version: 0,
    candidates: [],
  });
  const action = useAction(resource.reload);
  const [source, setSource] = useState('');
  const needsRelink = (r: import('../server/note-results').NoteResult) =>
    r.source_invalidated ||
    r.status === 'Source changed' ||
    !r.text.trim() ||
    resource.data.candidates.some((f) => f.id === r.document_id);
  useEffect(() => {
    onVersion(resource.data.version);
  }, [resource.data.version, onVersion]);
  useEffect(() => {
    if (locked) return;
    const timer = setInterval(
      () => void resource.reload().catch(() => {}),
      15000,
    );
    return () => clearInterval(timer);
  }, [locked, resource.reload]);
  return (
    <section className="ops-subsection received-note-results">
      <div className="section-heading">
        <div>
          <h3>Received lab & radiology results</h3>
          <p className="muted">
            Original report text with source attribution. Review each report
            before signing; your assessment and plan remain separate.
          </p>
        </div>
        {!locked && (
          <button
            className="text-button"
            onClick={() =>
              void action.run(resource.reload, 'Received results refreshed')
            }
          >
            Refresh received results
          </button>
        )}
      </div>
      {resource.error && (
        <p className="form-error" role="alert">
          {resource.error}
        </p>
      )}
      <Feedback action={action} />
      {resource.data.results
        .filter((r) => !locked || r.status === 'Included')
        .map((r) => (
          <article className="finance-card" key={r.id}>
            <div className="finance-card-header">
              <div>
                <h4>
                  {r.source_kind} · {r.source_sender}
                </h4>
                <p>
                  Received {rfaDisplayTime(r.received_at)} · Source{' '}
                  {r.document_id}
                </p>
              </div>
              <Badge>{r.status}</Badge>
            </div>
            <details
              open={r.status === 'Pending review' || r.status === 'Included'}
            >
              <summary>Report text copied from original</summary>
              <pre className="ops-document-text">
                {r.text ||
                  'Source filing changed; this report is no longer part of this draft. Exclude it or relink the verified document.'}
              </pre>
            </details>
            {!locked && (
              <div className="button-row">
                <button
                  className="button secondary small"
                  disabled={action.busy || needsRelink(r)}
                  onClick={() =>
                    void action.run(
                      () =>
                        post(`${base}/note-results/${r.id}/review`, {
                          revision: r.revision,
                          decision: 'Include',
                          reason:
                            'Provider reviewed the source report and confirmed relevance to this visit',
                        }),
                      'Reviewed result included in note',
                    )
                  }
                >
                  Review and include report
                </button>
                {resource.data.candidates.some((f) => f.id === r.document_id) && (
                  <button
                    className="button secondary small"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(
                        () =>
                          post(`${base}/note-results`, {
                            document_id: r.document_id,
                            encounter_id: encounterId,
                          }),
                        'Current report copied. Review it before including it in this note.',
                      )
                    }
                  >
                    Relink verified report
                  </button>
                )}
                <button
                  className="text-button"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(
                      () =>
                        post(`${base}/note-results/${r.id}/review`, {
                          revision: r.revision,
                          decision: 'Exclude',
                          reason:
                            'Provider excluded this report from the current visit documentation',
                        }),
                      'Report excluded from note',
                    )
                  }
                >
                  Exclude from this note
                </button>
              </div>
            )}
          </article>
        ))}
      {!resource.data.results.length && (
        <p className="muted">
          A clearly matched lab or radiology fax will populate here when this is
          the only open draft for that patient and account. Other received
          reports can be linked below.
        </p>
      )}
      {!locked && resource.data.candidates.length > 0 && (
        <div className="ops-link-result">
          <label>
            Received report for this visit
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Choose a report to populate</option>
              {resource.data.candidates.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.kind} · {f.sender} · {rfaDisplayTime(f.received_at)}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button secondary small"
            disabled={!source || action.busy}
            onClick={() =>
              void action.run(
                () =>
                  post(`${base}/note-results`, {
                    document_id: source,
                    encounter_id: encounterId,
                  }),
                'Report text populated in draft note',
              )
            }
          >
            Populate report in this draft
          </button>
        </div>
      )}
    </section>
  );
}
