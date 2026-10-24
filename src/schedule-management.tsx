import { useState, type FormEvent } from 'react';
import { CalendarClock, CalendarPlus, RefreshCw, Users } from 'lucide-react';
import { api, patch, post } from './api';
import { Badge, Modal, fullName, prettyDate, timeLabel } from './components';
import { useResource } from './workflow-ui';
import { BillingAccountSelect } from './patient-accounts-ui';
import { VisitServiceFields, readVisitPlanForm } from './operations-ui';
import type { Appointment, Patient } from './types';
import type {
  RecurringSeries,
  ScheduleHistory,
  WaitlistEntry,
  WaitlistOffer,
} from '../server/schedule-workflows';
import type { VisitPlan } from '../server/operations-engine';

const base = '/workflow/scheduling';
type Provider = { id: string; name: string };
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(
    new Date(),
  );
type Candidate = {
  waitlist_id: string;
  revision: number;
  patient_name: string;
  priority: string;
  ready: boolean;
  blockers: string[];
  warnings: string[];
  issues: string[];
};
type Offer = WaitlistOffer & { readiness: Candidate | null };
type Slot = {
  id: string;
  snapshot: string;
  date: string;
  time: string;
  duration: number;
  provider: string;
  provider_id: string;
  candidates: Candidate[];
  offer: WaitlistOffer | null;
};
type SchedulingData = {
  series: RecurringSeries[];
  waitlist: (WaitlistEntry & { patient_name: string; account_name: string })[];
  offers: Offer[];
  slots: Slot[];
  appointments: Appointment[];
};
type Detail = {
  appointment: Appointment;
  snapshot: string;
  revision: number;
  plan: VisitPlan | null;
  history: ScheduleHistory[];
};
const emptyData: SchedulingData = {
  series: [],
  waitlist: [],
  offers: [],
  slots: [],
  appointments: [],
};

/** A saved change remains saved when a subsequent calendar refresh fails. */
function useSchedulingAction(refresh: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [refreshError, setRefreshError] = useState('');
  async function reload() {
    setRefreshError('');
    try {
      await refresh();
    } catch (e) {
      setRefreshError(
        `Saved changes are safe. Refresh the schedule: ${(e as Error).message}`,
      );
    }
  }
  return {
    busy,
    error,
    message,
    refreshError,
    reload,
    run: async (fn: () => Promise<unknown>, success: string) => {
      setBusy(true);
      setError('');
      setMessage('');
      setRefreshError('');
      try {
        await fn();
        setMessage(success);
        await reload();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
  };
}
function Feedback({
  action,
}: {
  action: ReturnType<typeof useSchedulingAction>;
}) {
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
      {action.refreshError && (
        <p className="form-error" role="alert">
          {action.refreshError}{' '}
          <button
            className="text-button"
            type="button"
            onClick={() => void action.reload()}
            disabled={action.busy}
          >
            Retry refresh
          </button>
        </p>
      )}
    </>
  );
}

export function AppointmentRescheduleButton({
  appointment,
  providers,
  onChange,
}: {
  appointment: Appointment;
  providers: Provider[];
  onChange: () => Promise<unknown> | void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null),
    [opening, setOpening] = useState(false),
    [loadError, setLoadError] = useState('');
  const action = useSchedulingAction(async () => onChange());
  if (appointment.status !== 'Scheduled') return null;
  async function open() {
    setOpening(true);
    setLoadError('');
    try {
      setDetail(await api<Detail>(`${base}/appointments/${appointment.id}`));
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setOpening(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!detail) return;
    const f = new FormData(e.currentTarget);
    await action.run(async () => {
      await post(`${base}/appointments/${appointment.id}/reschedule`, {
        date: f.get('date'),
        time: f.get('time'),
        provider_id: f.get('provider_id'),
        reason: f.get('reason'),
        snapshot: detail.snapshot,
        revision: detail.revision,
      });
      setDetail(null);
    }, 'Appointment rescheduled. Its visit account and treatment plan were rechecked.');
  }
  return (
    <section className="ops-subsection">
      <button
        className="button secondary small"
        type="button"
        onClick={() => void open()}
        disabled={opening || action.busy}
      >
        <CalendarClock size={15} />
        {opening ? 'Loading visit…' : 'Reschedule visit'}
      </button>
      {loadError && (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      )}
      {!detail && <Feedback action={action} />}
      {detail && (
        <Modal
          title="Reschedule visit"
          subtitle={`${fullName(appointment)} · ${appointment.billing_account_name || 'Selected visit account'}`}
          onClose={() => !action.busy && setDetail(null)}
        >
          <form onSubmit={submit}>
            <div className="modal-body">
              <p className="muted">
                Keep the same patient, visit account and duration. Coverage
                dates, clinician availability and approved treatment units are
                checked before saving.
              </p>
              <div className="form-grid">
                <label>
                  New visit date
                  <input
                    type="date"
                    name="date"
                    min={today()}
                    defaultValue={detail.appointment.date}
                    required
                  />
                </label>
                <label>
                  New visit time
                  <input
                    type="time"
                    name="time"
                    defaultValue={detail.appointment.time}
                    required
                  />
                </label>
                <label className="span-2">
                  Clinician
                  <select
                    name="provider_id"
                    defaultValue={detail.appointment.provider_id}
                    required
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="span-2">
                  Reason for rescheduling
                  <textarea
                    name="reason"
                    required
                    minLength={5}
                    maxLength={1000}
                    placeholder="Record the patient request or scheduling reason"
                  />
                </label>
              </div>
              <Feedback action={action} />
              {detail.history.length > 0 && (
                <details className="ops-subsection">
                  <summary>
                    Scheduling history ({detail.history.length})
                  </summary>
                  {detail.history.map((h) => (
                    <p key={h.id}>
                      <strong>{h.action}</strong> · {h.actor}
                      <br />
                      {h.reason}
                    </p>
                  ))}
                </details>
              )}
            </div>
            <div className="modal-footer">
              <button
                className="button secondary"
                type="button"
                disabled={action.busy}
                onClick={() => void open()}
              >
                Reload latest visit
              </button>
              <button className="button primary" disabled={action.busy}>
                {action.busy ? 'Saving…' : 'Save rescheduled visit'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

export function ScheduleManagement({
  patients,
  providers,
  onChange,
}: {
  patients: Patient[];
  providers: Provider[];
  onChange: () => Promise<unknown> | void;
}) {
  const resource = useResource<SchedulingData>(base, emptyData);
  const [modal, setModal] = useState<'series' | 'waitlist' | null>(null),
    [editing, setEditing] = useState<WaitlistEntry | null>(null),
    [confirming, setConfirming] = useState<Offer | null>(null),
    [patientId, setPatientId] = useState(''),
    [billingId, setBillingId] = useState(''),
    [sourceId, setSourceId] = useState(''),
    [providerId, setProviderId] = useState(''),
    [date, setDate] = useState(today),
    [visitTime, setVisitTime] = useState('09:00'),
    [duration, setDuration] = useState(30),
    [type, setType] = useState('Follow-up'),
    [reason, setReason] = useState('');
  const action = useSchedulingAction(async () => {
    // Both refreshes are independent; attempting each lets either view recover.
    const results = await Promise.allSettled([
      resource.reload(),
      Promise.resolve().then(onChange),
    ]);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  });
  const waiting = resource.data.waitlist.filter((e) =>
    ['Waiting', 'Offered'].includes(e.status),
  );
  const source = resource.data.appointments.find((a) => a.id === sourceId);
  const confirmingSlot =
    confirming && resource.data.slots.find((s) => s.id === confirming.slot_id);
  const confirmingEntry =
    confirming &&
    resource.data.waitlist.find((e) => e.id === confirming.waitlist_id);
  function open(kind: 'series' | 'waitlist') {
    setEditing(null);
    setPatientId('');
    setBillingId('');
    setSourceId('');
    setProviderId(kind === 'series' ? providers[0]?.id || '' : '');
    setDate(today());
    setVisitTime('09:00');
    setDuration(30);
    setType('Follow-up');
    setReason('');
    setModal(kind);
  }
  function edit(entry: WaitlistEntry) {
    setEditing(entry);
    setPatientId(entry.patient_id);
    setBillingId(entry.billing_account_id);
    setSourceId(entry.appointment_id);
    setProviderId(entry.provider_id);
    setDate(entry.earliest_date);
    setVisitTime(entry.earliest_time);
    setDuration(entry.duration);
    setType(entry.type);
    setReason(entry.reason);
    setModal('waitlist');
  }
  function choosePatient(id: string) {
    setPatientId(id);
    setBillingId(id ? `pba-private-${id}` : '');
    setSourceId('');
  }
  function chooseSource(id: string) {
    setSourceId(id);
    const a = resource.data.appointments.find((a) => a.id === id);
    if (a) {
      setBillingId(a.billing_account_id || `pba-private-${a.patient_id}`);
      setProviderId(a.provider_id || '');
      setDuration(a.duration);
      setType(a.type);
      setReason(a.reason);
    }
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget),
      kind = modal;
    await action.run(
      async () => {
        const visitPlan = readVisitPlanForm(f);
        if (kind === 'series') {
          if (!visitPlan)
            throw Error(
              'Review the authorization requirement for the recurring visits',
            );
          await post(`${base}/series`, {
            patient_id: patientId,
            billing_account_id: f.get('billing_account_id'),
            provider_id: providerId,
            date,
            time: visitTime,
            duration,
            type,
            reason,
            count: Number(f.get('count')),
            interval: f.get('interval'),
            visit_plan: visitPlan,
          });
        } else {
          const body = {
            patient_id: patientId,
            billing_account_id: f.get('billing_account_id'),
            provider_id: providerId,
            appointment_id: sourceId,
            earliest_date: date,
            latest_date: f.get('latest_date'),
            earliest_time: visitTime,
            latest_time: f.get('latest_time'),
            duration,
            type,
            reason,
            priority: f.get('priority'),
            visit_plan: visitPlan,
          };
          if (editing)
            await patch(`${base}/waitlist/${editing.id}`, {
              ...body,
              revision: editing.revision,
            });
          else await post(`${base}/waitlist`, body);
        }
        setModal(null);
      },
      kind === 'series'
        ? 'Recurring visits saved with separate treatment reservations for every date.'
        : editing
          ? 'Waitlist preferences and treatment review updated.'
          : 'Patient added to the manual cancellation waitlist.',
    );
  }
  async function offer(slot: Slot, candidate: Candidate) {
    await action.run(async () => {
      await post(`${base}/waitlist/${candidate.waitlist_id}/offer`, {
        revision: candidate.revision,
        slot_id: slot.id,
        slot_snapshot: slot.snapshot,
      });
    }, 'Manual offer recorded. Contact the patient using your usual process, then confirm acceptance here. No message was sent.');
  }
  async function book(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!confirming) return;
    const f = new FormData(e.currentTarget),
      offer = confirming,
      entry = resource.data.waitlist.find((e) => e.id === offer.waitlist_id);
    if (!entry) return;
    await action.run(async () => {
      await post(`${base}/waitlist/${entry.id}/book`, {
        revision: entry.revision,
        offer_id: offer.id,
        readiness_acknowledged: f.get('readiness_acknowledged') === 'on',
      });
      setConfirming(null);
    }, 'Cancellation slot booked after staff confirmed patient acceptance.');
  }
  return (
    <section
      className="ops-subsection"
      aria-label="Recurring visits and cancellation waitlist"
    >
      <div className="section-heading">
        <div>
          <h3>Recurring visits &amp; cancellation waitlist</h3>
          <p className="muted">
            Reserve each approved treatment separately and fill cancellations
            with reviewed patient preferences.
          </p>
        </div>
        <div className="button-row">
          <button
            className="button secondary small"
            type="button"
            onClick={() => open('series')}
            disabled={action.busy}
          >
            <CalendarPlus size={15} />
            Recurring visits
          </button>
          <button
            className="button secondary small"
            type="button"
            onClick={() => open('waitlist')}
            disabled={action.busy}
          >
            <Users size={15} />
            Add to waitlist
          </button>
          <button
            className="button secondary small"
            type="button"
            onClick={() => void action.reload()}
            disabled={action.busy || resource.loading}
          >
            <RefreshCw size={15} />
            Refresh waitlist
          </button>
        </div>
      </div>
      {!modal && !confirming && <Feedback action={action} />}
      {resource.error && (
        <p className="form-error" role="alert">
          {resource.error}
        </p>
      )}
      <details>
        <summary>
          {waiting.length} active waitlist request
          {waiting.length === 1 ? '' : 's'} · {resource.data.slots.length}{' '}
          cancellation slot{resource.data.slots.length === 1 ? '' : 's'} ·{' '}
          {resource.data.series.length} recurring series
        </summary>
        <p className="muted">
          Offers are manual and expire after 48 hours or when the slot changes.
          No SMS, email or other delivery occurs in demo mode.
        </p>
        <div className="finance-cards">
          {waiting.map((e) => {
            const activeOffer = resource.data.offers.find(
              (o) => o.waitlist_id === e.id && o.status === 'Active',
            );
            const slot =
              activeOffer &&
              resource.data.slots.find((s) => s.id === activeOffer.slot_id);
            return (
              <article className="finance-card" key={e.id}>
                <div className="finance-card-header">
                  <div>
                    <h4>{e.patient_name}</h4>
                    <p>
                      {e.account_name} · {e.priority} priority
                    </p>
                  </div>
                  <Badge>{e.status}</Badge>
                </div>
                <p>
                  {prettyDate(e.earliest_date)} – {prettyDate(e.latest_date)} ·{' '}
                  {timeLabel(e.earliest_time)} – {timeLabel(e.latest_time)} ·{' '}
                  {e.duration} minutes
                </p>
                <p className="muted">
                  {e.provider_id
                    ? providers.find((p) => p.id === e.provider_id)?.name ||
                      'Selected clinician'
                    : 'Any clinician'}{' '}
                  · {e.appointment_id ? 'Move an existing visit' : 'New visit'}
                </p>
                {slot && (
                  <p>
                    Offered: {prettyDate(slot.date)} at {timeLabel(slot.time)}{' '}
                    with {slot.provider}
                  </p>
                )}
                {activeOffer?.readiness?.issues.length ? (
                  <ul className="ops-checklist">
                    {activeOffer.readiness.issues.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                ) : null}
                <div className="button-row">
                  {e.status === 'Waiting' && (
                    <button
                      className="button secondary small"
                      type="button"
                      disabled={action.busy}
                      onClick={() => edit(e)}
                    >
                      Review / update request
                    </button>
                  )}
                  {activeOffer && (
                    <button
                      className="button primary small"
                      type="button"
                      disabled={
                        action.busy || !!activeOffer.readiness?.blockers.length
                      }
                      onClick={() => setConfirming(activeOffer)}
                    >
                      Confirm patient accepted
                    </button>
                  )}
                  <button
                    className="button secondary small"
                    type="button"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        await patch(`${base}/waitlist/${e.id}`, {
                          revision: e.revision,
                          status: 'Cancelled',
                        });
                      }, 'Waitlist request cancelled and any held offer released.')
                    }
                  >
                    Cancel request
                  </button>
                </div>
              </article>
            );
          })}
        </div>
        {!waiting.length && (
          <p className="muted">
            Add a patient and their visit account to match future cancellation
            slots.
          </p>
        )}
        {resource.data.slots.map((slot) => (
          <article className="finance-card" key={slot.id}>
            <div className="finance-card-header">
              <div>
                <h4>
                  {prettyDate(slot.date)} · {timeLabel(slot.time)}
                </h4>
                <p>
                  {slot.provider} · {slot.duration} minutes available
                </p>
              </div>
              <Badge>{slot.offer ? 'Offer held' : 'Available'}</Badge>
            </div>
            {!slot.offer &&
              slot.candidates.map((candidate) => (
                <div className="ops-subsection" key={candidate.waitlist_id}>
                  <div className="section-heading">
                    <strong>
                      {candidate.patient_name} · {candidate.priority}
                    </strong>
                    <Badge>
                      {candidate.ready
                        ? 'Ready'
                        : candidate.blockers.length
                          ? 'Needs review'
                          : 'Follow-up needed'}
                    </Badge>
                  </div>
                  {candidate.issues.length > 0 && (
                    <ul className="ops-checklist">
                      {candidate.issues.map((x) => (
                        <li key={x}>{x}</li>
                      ))}
                    </ul>
                  )}
                  <button
                    className="button secondary small"
                    type="button"
                    disabled={action.busy || !!candidate.blockers.length}
                    onClick={() => void offer(slot, candidate)}
                  >
                    Record manual offer
                  </button>
                </div>
              ))}
            {!slot.offer && !slot.candidates.length && (
              <p className="muted">
                No waitlist requests match this clinician, date and time window.
              </p>
            )}
          </article>
        ))}
      </details>
      {modal && (
        <Modal
          title={
            modal === 'series'
              ? 'Create recurring visits'
              : editing
                ? 'Update cancellation waitlist request'
                : 'Add patient to cancellation waitlist'
          }
          subtitle={
            modal === 'series'
              ? 'Every occurrence is checked before the complete series is saved.'
              : 'Choose the patient, visit account and preferred appointment window.'
          }
          onClose={() => !action.busy && setModal(null)}
          wide
        >
          <form onSubmit={save}>
            <div className="modal-body">
              <div className="form-grid">
                <label>
                  Patient
                  <select
                    value={patientId}
                    onChange={(e) => choosePatient(e.target.value)}
                    required
                  >
                    <option value="" disabled>
                      Select a patient
                    </option>
                    {patients.map((p) => (
                      <option value={p.id} key={p.id}>
                        {fullName(p)}
                      </option>
                    ))}
                  </select>
                </label>
                <BillingAccountSelect
                  patientId={patientId}
                  value={billingId}
                  onChange={(id) => {
                    setBillingId(id);
                    setSourceId('');
                  }}
                />
                {modal === 'waitlist' && (
                  <label className="span-2">
                    Visit to move (optional)
                    <select
                      value={sourceId}
                      onChange={(e) => chooseSource(e.target.value)}
                      disabled={!patientId}
                    >
                      <option value="">
                        Create a new visit when a slot is accepted
                      </option>
                      {resource.data.appointments
                        .filter((a) => a.patient_id === patientId)
                        .map((a) => (
                          <option value={a.id} key={a.id}>
                            {prettyDate(a.date)} · {timeLabel(a.time)} ·{' '}
                            {a.type}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                <label>
                  {modal === 'series'
                    ? 'Series start date'
                    : 'Waitlist earliest date'}
                  <input
                    type="date"
                    min={today()}
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    required
                  />
                </label>
                {modal === 'waitlist' && (
                  <label>
                    Waitlist latest date
                    <input
                      name="latest_date"
                      type="date"
                      min={date}
                      defaultValue={editing?.latest_date || date}
                      required
                    />
                  </label>
                )}
                <label>
                  {modal === 'series' ? 'Visit time' : 'Earliest start time'}
                  <input
                    type="time"
                    value={visitTime}
                    onChange={(e) => setVisitTime(e.target.value)}
                    required
                  />
                </label>
                {modal === 'waitlist' && (
                  <label>
                    Latest finish time
                    <input
                      name="latest_time"
                      type="time"
                      defaultValue={editing?.latest_time || '17:00'}
                      required
                    />
                  </label>
                )}
                <label>
                  Clinician preference
                  <select
                    value={providerId}
                    onChange={(e) => setProviderId(e.target.value)}
                    required={modal === 'series'}
                  >
                    <option value="">
                      {modal === 'series'
                        ? 'Select a clinician'
                        : 'Any clinician'}
                    </option>
                    {providers.map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Duration (minutes)
                  <input
                    type="number"
                    min="15"
                    max="120"
                    step="5"
                    value={duration}
                    onChange={(e) => setDuration(Number(e.target.value))}
                    disabled={!!source}
                    required
                  />
                </label>
                <label>
                  Visit type
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    disabled={!!source}
                    required
                  >
                    {[
                      'Consultation',
                      'Follow-up',
                      'Annual physical',
                      'Procedure',
                    ].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
                {modal === 'series' ? (
                  <>
                    <label>
                      Repeat interval
                      <select name="interval">
                        <option>Weekly</option>
                        <option>Biweekly</option>
                      </select>
                    </label>
                    <label>
                      Number of visits
                      <input
                        name="count"
                        type="number"
                        min="2"
                        max="24"
                        defaultValue="6"
                        required
                      />
                    </label>
                  </>
                ) : (
                  <label>
                    Waitlist priority
                    <select
                      name="priority"
                      defaultValue={editing?.priority || 'Routine'}
                    >
                      <option>Routine</option>
                      <option>High</option>
                    </select>
                  </label>
                )}
                <label className="span-2">
                  Visit reason
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    disabled={!!source}
                    required
                    maxLength={1000}
                  />
                </label>
                {source ? (
                  <p className="muted span-2">
                    The original appointment keeps its visit account, completed
                    intake and reviewed treatment plan. Reservations and
                    coverage are checked again for the accepted date.
                  </p>
                ) : (
                  patientId && (
                    <>
                      <VisitServiceFields
                        key={`${patientId}-${billingId}-${modal}-${editing?.id || 'new'}`}
                        patientId={patientId}
                        billingId={billingId}
                        date={date}
                        existing={
                          editing?.visit_plan
                            ? {
                                ...editing.visit_plan,
                                appointment_id: editing.appointment_id,
                                patient_id: editing.patient_id,
                                billing_account_id: editing.billing_account_id,
                                revision: 0,
                                history: [],
                              }
                            : null
                        }
                      />
                      <p className="muted span-2">
                        Recurring visits and cancellation offers require
                        available approvals for every service marked as
                        requiring authorization. A waitlist request can remain
                        pending until its review is complete.
                      </p>
                    </>
                  )
                )}
              </div>
              <Feedback action={action} />
            </div>
            <div className="modal-footer">
              <button
                className="button secondary"
                type="button"
                disabled={action.busy}
                onClick={() => setModal(null)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                disabled={action.busy || !patientId}
              >
                {action.busy
                  ? 'Saving…'
                  : modal === 'series'
                    ? 'Create recurring visits'
                    : editing
                      ? 'Save waitlist review'
                      : 'Add waitlist request'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {confirming && (
        <Modal
          title="Confirm cancellation booking"
          subtitle="Record this only after the patient has accepted the manual offer."
          onClose={() => !action.busy && setConfirming(null)}
        >
          <form onSubmit={book}>
            <div className="modal-body">
              <p>
                <strong>
                  {confirmingEntry?.patient_name ||
                    confirming.readiness?.patient_name}
                </strong>{' '}
                · {confirmingEntry?.account_name}
              </p>
              {confirmingSlot && (
                <p>
                  {prettyDate(confirmingSlot.date)} at{' '}
                  {timeLabel(confirmingSlot.time)} · {confirmingSlot.provider}
                </p>
              )}
              <p>
                The slot, visit account and remaining treatment authorizations
                will be checked again before booking.
              </p>
              {confirming.readiness?.issues.length ? (
                <>
                  <ul className="ops-checklist">
                    {confirming.readiness.issues.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                  <label className="checkbox-label">
                    <input
                      name="readiness_acknowledged"
                      type="checkbox"
                      required
                    />
                    I reviewed these outstanding readiness items and will
                    complete the follow-up before the visit.
                  </label>
                </>
              ) : (
                <p className="inline-success">Readiness checks are complete.</p>
              )}
              <label className="checkbox-label">
                <input type="checkbox" required />
                Patient acceptance has been confirmed by staff.
              </label>
              <Feedback action={action} />
            </div>
            <div className="modal-footer">
              <button
                className="button secondary"
                type="button"
                onClick={() => setConfirming(null)}
                disabled={action.busy}
              >
                Keep offer pending
              </button>
              <button className="button primary" disabled={action.busy}>
                {action.busy ? 'Booking…' : 'Book accepted slot'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
