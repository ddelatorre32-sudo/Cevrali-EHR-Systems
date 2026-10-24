import { useEffect, useState, type FormEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import { post } from './api';
import { Badge, Empty, Modal, prettyDate, timeLabel } from './components';
import { useResource } from './workflow-ui';
import { rfaDisplayTime } from '../server/rfa-engine';
import type { TreatmentReview } from '../server/treatment-rules';
import type { VisitPlan } from '../server/operations-engine';

const base = '/workflow/operations';
type ServiceRow = {
  procedure_code: string;
  planned: number;
  performed: number | null;
  deferred: number | null;
  cancelled: number | null;
  billed: number;
};
type ReviewView = {
  appointment_id: string;
  encounter_id: string;
  patient_id: string;
  status: string;
  plan: VisitPlan | null;
  review: TreatmentReview | null;
  can_review: boolean;
  services: ServiceRow[];
};
type ReconciliationRow = ReviewView & {
  first_name: string;
  last_name: string;
  date: string;
  time: string;
  issues: string[];
  ready: boolean;
};

export function ActualTreatmentReview({
  appointmentId,
  encounterId,
  onChanged,
}: {
  appointmentId?: string;
  encounterId?: string;
  onChanged?: () => void | Promise<unknown>;
}) {
  const query = appointmentId
    ? `appointment_id=${encodeURIComponent(appointmentId)}`
    : `encounter_id=${encodeURIComponent(encounterId || '')}`;
  const resource = useResource<ReviewView | null>(
    `${base}/treatments?${query}`,
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    setMessage('');
    setError('');
  }, [query]);
  const view = resource.data;
  if (resource.loading)
    return <p className="muted">Loading actual treatment…</p>;
  if (resource.error)
    return (
      <p className="form-error" role="alert">
        {resource.error}
      </p>
    );
  if (!view?.plan?.services.length) return null;
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!view?.plan) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await post(`${base}/treatments?${query}`, {
        revision: view.review?.revision || 0,
        plan_revision: view.plan.revision,
        reason: f.get('reason'),
        services: view.services.map((s, i) => ({
          procedure_code: s.procedure_code,
          performed: Number(f.get(`performed-${i}`)),
          deferred: Number(f.get(`deferred-${i}`)),
          cancelled: Number(f.get(`cancelled-${i}`)),
        })),
      });
      await resource.reload();
      await onChanged?.();
      setMessage(
        'Actual treatment reviewed. Service allowances and billing checks updated.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ops-subsection">
      <div className="section-heading">
        <div>
          <h4>Actual treatment and billing</h4>
          <p className="muted">
            Confirm each service performed, deferred or cancelled. The three
            quantities must total the planned units.
          </p>
        </div>
        <Badge>
          {view.review
            ? `Reviewed · revision ${view.review.revision}`
            : 'Clinician review required'}
        </Badge>
      </div>
      {!view.review && (
        <p className="finance-help">
          Completing an appointment keeps planned units reserved until the
          clinician records actual treatment.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="inline-success" role="status">
          {message}
        </p>
      )}
      <form
        key={`${view.appointment_id}:${view.review?.revision || 0}:${view.plan.revision}`}
        onSubmit={save}
      >
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Procedure</th>
                <th>Planned</th>
                <th>Performed</th>
                <th>Deferred</th>
                <th>Cancelled</th>
                <th>Charged</th>
              </tr>
            </thead>
            <tbody>
              {view.services.map((s, i) => (
                <tr key={s.procedure_code}>
                  <td>
                    <strong>{s.procedure_code}</strong>
                  </td>
                  <td>{s.planned}</td>
                  {(['performed', 'deferred', 'cancelled'] as const).map(
                    (kind) => (
                      <td key={kind}>
                        {view.can_review ? (
                          <input
                            aria-label={`${s.procedure_code} ${kind} units`}
                            name={`${kind}-${i}`}
                            type="number"
                            min={0}
                            max={s.planned}
                            step={1}
                            required
                            defaultValue={s[kind] ?? ''}
                            style={{ width: '5.5rem' }}
                          />
                        ) : (
                          (s[kind] ?? 'Pending')
                        )}
                      </td>
                    ),
                  )}
                  <td>{s.billed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {view.can_review ? (
          <>
            <label>
              Review or correction reason
              <textarea
                name="reason"
                minLength={3}
                maxLength={1000}
                required
                placeholder="Confirm services delivered and explain deferred, cancelled or corrected treatment."
              />
            </label>
            <p className="muted">
              Prior reviews remain in history. Correct or void charge sheets
              before reducing performed units below charged units.
            </p>
            <button className="button secondary small" disabled={busy}>
              {busy
                ? 'Saving…'
                : view.review
                  ? 'Save treatment correction'
                  : 'Confirm actual treatment'}
            </button>
          </>
        ) : (
          <p className="muted">
            The encounter author or assigned visit clinician can review actuals
            after the visit starts.
          </p>
        )}
      </form>
      {view.review && (
        <details className="ops-subsection">
          <summary>
            Treatment review history ({view.review.history.length})
          </summary>
          {view.review.history
            .slice()
            .reverse()
            .map((h) => (
              <div className="ops-allowance" key={h.revision}>
                <div>
                  <strong>
                    Revision {h.revision} · {h.actor}
                  </strong>
                  <p>{rfaDisplayTime(h.at)}</p>
                  {h.reason && <p>{h.reason}</p>}
                  <small>
                    {h.services
                      .map(
                        (s) =>
                          `${s.procedure_code}: ${s.performed} performed, ${s.deferred} deferred, ${s.cancelled} cancelled`,
                      )
                      .join(' · ')}
                  </small>
                </div>
              </div>
            ))}
        </details>
      )}
    </section>
  );
}

export function TreatmentReconciliationPage() {
  const resource = useResource<ReconciliationRow[]>(
    `${base}/treatment-reconciliation`,
    [],
  );
  const [selected, setSelected] = useState('');
  const [search, setSearch] = useState('');
  const [onlyIssues, setOnlyIssues] = useState(true);
  const rows = resource.data
    .filter(
      (r) =>
        (!onlyIssues || r.issues.length > 0) &&
        `${r.first_name} ${r.last_name} ${r.date} ${r.services.map((s) => s.procedure_code).join(' ')}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort(
      (a, b) => b.date.localeCompare(a.date) || a.time.localeCompare(b.time),
    );
  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <h1>Treatment reconciliation</h1>
          <p>
            Review actual services, authorization usage and charge quantities
            together.
          </p>
        </div>
        <button
          className="button secondary"
          onClick={() => void resource.reload().catch(() => {})}
        >
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>
      {resource.error && (
        <p className="form-error" role="alert">
          {resource.error}
        </p>
      )}
      <div className="section-heading">
        <input
          aria-label="Search treatment reconciliation"
          placeholder="Search patient, date or procedure"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={onlyIssues}
            onChange={(e) => setOnlyIssues(e.target.checked)}
          />
          Needs attention only
        </label>
      </div>
      <div className="card">
        {!rows.length ? (
          <Empty
            title={
              resource.loading
                ? 'Loading treatment reviews…'
                : 'No treatment discrepancies'
            }
            description="Actual treatment reviews and charge differences appear here."
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Patient / visit</th>
                  <th>Services</th>
                  <th>Review</th>
                  <th>Needs attention</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.appointment_id}>
                    <td>
                      <strong>
                        {r.first_name} {r.last_name}
                      </strong>
                      <div className="muted">
                        {prettyDate(r.date)} · {timeLabel(r.time)} · {r.status}
                      </div>
                    </td>
                    <td>
                      {r.services.map((s) => (
                        <div key={s.procedure_code}>
                          {s.procedure_code}: {s.planned} planned ·{' '}
                          {s.performed ?? 'pending'} performed · {s.billed}{' '}
                          charged
                        </div>
                      ))}
                    </td>
                    <td>
                      <Badge>{r.review ? 'Reviewed' : 'Pending'}</Badge>
                    </td>
                    <td>
                      {r.issues.length
                        ? r.issues.map((v) => <div key={v}>{v}</div>)
                        : 'Reconciled'}
                    </td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => setSelected(r.appointment_id)}
                      >
                        Review treatment
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {selected && (
        <Modal title="Actual treatment review" onClose={() => setSelected('')}>
          <div className="modal-body">
            <ActualTreatmentReview
              appointmentId={selected}
              onChanged={resource.reload}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}
