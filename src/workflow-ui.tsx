import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useWorkSourceFocus } from './work-source-focus';
import {
  Activity,
  ArrowRight,
  CalendarDays,
  Check,
  ClipboardList,
  Clock3,
  Copy,
  FileDown,
  Inbox,
  Leaf,
  Link,
  Plus,
  RefreshCw,
  Search,
  Star,
  UserCheck,
} from 'lucide-react';
import { api, patch, post, isStandalonePreview } from './api';
import { PatientRegistration } from './digital-checkin-ui';
import {
  Avatar,
  Badge,
  Empty,
  Modal,
  fullName,
  prettyDate,
  timeLabel,
  mrn,
} from './components';
import type { Appointment, Encounter, Lab, Patient, User } from './types';
import type {
  CareOrder,
  CareTask,
  Intake,
  NoteTemplate,
  VisitStage,
} from '../server/workflow-engine';

type Team = { id: string; name: string; role: string };
type QueueVisit = Appointment & {
  stage: VisitStage;
  room: string;
  wait_minutes: number | null;
  intake_status: string;
  intake_id?: string;
  intake_expired?: boolean;
  registration_status?: string;
  confirmation?: string;
};
type TaskRow = CareTask & {
  first_name: string;
  last_name: string;
  owner_name: string;
};
type IntakeRow = Intake & { first_name: string; last_name: string };
type OrderRow = CareOrder & { first_name: string; last_name: string };
export type Preferences = {
  favorites: string[];
  recent: string[];
  filters: { name: string; query: string }[];
};
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(
    new Date(),
  );
export function useResource<T>(path: string, initial: T) {
  const initialValue = useRef(initial);
  const [data, setData] = useState(initial);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setError('');
    try {
      const value = await api<T>(path);
      setData(value);
      setLoading(false);
      return value;
    } catch (e) {
      setError((e as Error).message);
      setLoading(false);
      throw e;
    }
  }, [path]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setData(initialValue.current);
    api<T>(path)
      .then((value) => {
        if (active) {
          setData(value);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path]);
  return { data, error, loading, reload, setData };
}
function Feedback({ error, loading }: { error?: string; loading?: boolean }) {
  return error ? (
    <p className="form-error" role="alert">
      {error}
    </p>
  ) : loading ? (
    <p className="resource-loading" role="status">
      Loading workspace…
    </p>
  ) : null;
}
function useAction(after?: () => Promise<unknown> | void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  async function run(action: () => Promise<unknown>, success = '') {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      await after?.();
      setMessage(success);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, message, run };
}
function ActionFeedback({ action }: { action: ReturnType<typeof useAction> }) {
  return (
    <>
      {action.error && (
        <p className="form-error" role="alert">
          {action.error}
        </p>
      )}
      {action.message && (
        <p className="inline-success" role="status">
          <Check size={14} />
          {action.message}
        </p>
      )}
    </>
  );
}

export function QueuePage({
  clinical,
  onVisit,
  onChanged,
}: {
  clinical: boolean;
  onVisit: (a: Appointment) => void;
  onChanged: () => Promise<void>;
}) {
  const [date, setDate] = useState(today);
  const [roomDrafts, setRoomDrafts] = useState<Record<string, string>>({});
  const resource = useResource<QueueVisit[]>(
    `/workflow/queue?date=${date}`,
    [],
  );
  const [link, setLink] = useState<{
    token: string;
    expires_at: string;
  } | null>(null);
  const action = useAction(async () => {
    await resource.reload();
    await onChanged();
  });
  useEffect(() => {
    const timer = setInterval(() => resource.reload().catch(() => {}), 15000);
    return () => clearInterval(timer);
  }, [resource.reload]);
  const next: Partial<Record<VisitStage, VisitStage>> = {
    Scheduled: 'Waiting',
    Waiting: 'Roomed',
    Roomed: 'Ready',
    Ready: 'With clinician',
    'With clinician': 'Checkout',
    Checkout: 'Done',
  };
  const labels: Record<string, string> = {
    Waiting: 'Check in',
    Roomed: 'Room patient',
    Ready: 'Ready for clinician',
    'With clinician': 'Begin care',
    Checkout: 'Ready for checkout',
    Done: 'Complete visit',
  };
  async function move(a: QueueVisit, stage: VisitStage) {
    await action.run(
      () =>
        patch(`/workflow/visits/${a.id}`, {
          stage,
          room: roomDrafts[a.id] ?? a.room,
        }),
      `Moved to ${stage.toLowerCase()}`,
    );
  }
  const linkUrl = link
    ? `${location.href.split('#')[0]}#intake/${link.token}`
    : '';
  return (
    <div className="workflow-stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Live patient queue</h2>
            <p className="section-caption">
              Updates every 15 seconds · Pacific time · elapsed time starts at
              recorded check-in
            </p>
          </div>
          <div className="button-row">
            <input
              aria-label="Queue date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value || today())}
            />
            <button
              className="icon-button"
              aria-label="Refresh patient queue"
              onClick={() => action.run(resource.reload)}
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </div>
        <Feedback {...resource} />
        <ActionFeedback action={action} />
        <div className="queue-columns">
          {(
            [
              'Scheduled',
              'Waiting',
              'Roomed',
              'Ready',
              'With clinician',
              'Checkout',
              'Done',
              'No-show',
            ] as VisitStage[]
          ).map((stage) => (
            <section className="queue-column" key={stage}>
              <div className="queue-stage">
                <span
                  className={`queue-dot stage-${stage.toLowerCase().replaceAll(' ', '-')}`}
                />
                <h3>{stage}</h3>
                <span className="count-chip">
                  {resource.data.filter((a) => a.stage === stage).length}
                </span>
              </div>
              {resource.data
                .filter((a) => a.stage === stage)
                .map((a) => (
                  <article className="queue-card" key={a.id}>
                    <div className="person-cell">
                      <Avatar person={a} />
                      <div>
                        <strong>{fullName(a)}</strong>
                        <small>
                          {timeLabel(a.time)} · {a.type}
                        </small>
                      </div>
                    </div>
                    <p>{a.reason}</p>
                    <div className="queue-meta">
                      <span>
                        <Clock3 size={12} />
                        {a.wait_minutes === null
                          ? 'Wait not measured'
                          : `${a.wait_minutes} min waiting`}
                      </span>
                      <span>Intake: {a.intake_status}</span>
                      <span>Registration: {a.registration_status || 'Not requested'}</span>
                      {a.confirmation && <span>Appointment confirmed</span>}
                    </div>
                    {!['Scheduled', 'Done', 'No-show', 'Cancelled'].includes(
                      stage,
                    ) && (
                      <label className="room-field">
                        Room
                        <input
                          aria-label={`Room for ${fullName(a)}`}
                          placeholder="e.g. Room 2"
                          value={roomDrafts[a.id] ?? a.room}
                          maxLength={30}
                          onChange={(e) =>
                            setRoomDrafts((drafts) => ({
                              ...drafts,
                              [a.id]: e.target.value,
                            }))
                          }
                        />
                        <button
                          className="text-button"
                          disabled={
                            action.busy || roomDrafts[a.id] === undefined
                          }
                          type="button"
                          onClick={() =>
                            action.run(() =>
                              patch(`/workflow/visits/${a.id}`, {
                                stage: a.stage,
                                room: roomDrafts[a.id] ?? a.room,
                              }),
                            )
                          }
                        >
                          Save
                        </button>
                      </label>
                    )}
                    <div className="queue-actions">
                      {next[stage] &&
                        (clinical ||
                          !['With clinician', 'Checkout', 'Done'].includes(
                            next[stage]!,
                          )) && (
                          <button
                            className="button primary small"
                            disabled={action.busy}
                            onClick={() => move(a, next[stage]!)}
                          >
                            {labels[next[stage]!]}
                          </button>
                        )}
                      {clinical &&
                        [
                          'Waiting',
                          'Roomed',
                          'Ready',
                          'With clinician',
                          'Checkout',
                        ].includes(stage) && (
                          <button
                            className="button secondary small"
                            disabled={action.busy}
                            onClick={() => onVisit(a)}
                          >
                            Open visit
                          </button>
                        )}
                      {stage === 'Scheduled' && (
                        <button
                          className="text-button"
                          disabled={action.busy}
                          onClick={() =>
                            action.run(() =>
                              patch(`/workflow/visits/${a.id}`, {
                                stage: 'No-show',
                              }),
                            )
                          }
                        >
                          Mark no-show
                        </button>
                      )}
                      {!['Done', 'No-show', 'Cancelled'].includes(stage) &&
                        a.intake_id && a.intake_expired && (
                          <button className="text-button" disabled={action.busy} onClick={() => action.run(async () => setLink(await post(`/workflow/intake-links/${a.intake_id}/renew`, {})))}>
                            Renew intake link
                          </button>
                        )}
                      {!['Done', 'No-show', 'Cancelled'].includes(stage) &&
                        a.intake_status === 'Not requested' && (
                          <button
                            className="text-button"
                            disabled={action.busy}
                            onClick={() =>
                              action.run(async () =>
                                setLink(
                                  await post('/workflow/intake-links', {
                                    appointment_id: a.id,
                                  }),
                                ),
                              )
                            }
                          >
                            Create intake link
                          </button>
                        )}
                    </div>
                  </article>
                ))}
              {!resource.data.some((a) => a.stage === stage) && (
                <p className="queue-empty">No patients here</p>
              )}
            </section>
          ))}
        </div>
      </section>
      {link && (
        <Modal
          title="Patient intake link"
          subtitle="A scoped link for this appointment, valid for 72 hours."
          onClose={() => setLink(null)}
        >
          <div className="modal-body form-stack">
            <p className="muted">
              The patient can complete registration, upload insurance cards,
              sign forms, submit clinical intake, and confirm or cancel this
              appointment. Staff review contact changes, and a clinician reviews
              clinical information before it changes the chart.
            </p>
            <label>
              Intake URL
              <input
                readOnly
                value={linkUrl}
                onFocus={(e) => e.target.select()}
              />
            </label>
            <p className="section-caption">
              Expires{' '}
              {new Date(link.expires_at).toLocaleString('en-US', {
                timeZone: 'America/Los_Angeles',
              })}{' '}
              Pacific time.
              {isStandalonePreview &&
                ' In the offline preview, use the patient-view button in this tab; links reset on reload.'}
            </p>
            <div className="button-row">
              <button
                className="button secondary"
                onClick={() =>
                  action.run(
                    () => navigator.clipboard.writeText(linkUrl),
                    'Link copied',
                  )
                }
              >
                <Copy size={15} />
                Copy link
              </button>
              <button
                className="button primary"
                onClick={() => {
                  location.hash = `intake/${link.token}`;
                }}
              >
                Open patient view
                <ArrowRight size={15} />
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function PatientIntakePortal({ token }: { token: string }) {
  type Details = {
    practice_name: string;
    patient_name: string;
    appointment: {
      date: string;
      time: string;
      status: string;
      confirmed: boolean;
    };
    status: string;
  };
  const resource = useResource<Details | null>(`/intake-links/${token}`, null);
  const action = useAction(resource.reload);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const medications = String(form.get('medications') || '')
      .split('\n')
      .filter((v) => v.trim())
      .map((line) => {
        const [name, dose = '', frequency = ''] = line
          .split('|')
          .map((v) => v.trim());
        return { name, dose, frequency };
      });
    await action.run(
      () =>
        post(`/intake-links/${token}`, {
          concern: form.get('concern'),
          symptoms: form.get('symptoms'),
          allergies: String(form.get('allergies') || '')
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean),
          medications,
          reminder_consent: form.get('consent') === 'on',
          attested: form.get('attested') === 'on',
        }),
      'Your intake was submitted to the care team.',
    );
  }
  return (
    <main className="patient-portal">
      <div className="portal-brand">
        <Leaf size={25} />
        <strong>cevrali.</strong>
        <span>Patient intake</span>
      </div>
      <section className="panel portal-card">
        <Feedback {...resource} />
        <ActionFeedback action={action} />
        {resource.data && (
          <>
            <div className="portal-heading">
              <p className="eyebrow">{resource.data.practice_name} · SYNTHETIC DATA DEMO</p>
              <h1>Hello, {resource.data.patient_name.split(' ')[0]}.</h1>
              <p>
                Your appointment is {prettyDate(resource.data.appointment.date)}{' '}
                at {timeLabel(resource.data.appointment.time)} Pacific time.
              </p>
              <p className="muted">
                Do not use this form for urgent concerns or emergencies.
              </p>
            </div>
            <div className="portal-appointment">
              <Badge>{resource.data.appointment.status}</Badge>
              {resource.data.appointment.confirmed && (
                <span className="inline-success">Appointment confirmed</span>
              )}
              {resource.data.appointment.status === 'Scheduled' && (
                <div className="button-row">
                  <button
                    className="button primary small"
                    disabled={
                      action.busy || resource.data.appointment.confirmed
                    }
                    onClick={() =>
                      action.run(
                        () =>
                          patch(`/intake-links/${token}/appointment`, {
                            action: 'confirm',
                          }),
                        'Appointment confirmed',
                      )
                    }
                  >
                    Confirm appointment
                  </button>
                  <button
                    className="button secondary small"
                    disabled={action.busy}
                    onClick={() => {
                      if (window.confirm('Cancel this appointment?'))
                        void action.run(
                          () =>
                            patch(`/intake-links/${token}/appointment`, {
                              action: 'cancel',
                            }),
                          'Appointment cancelled',
                        );
                    }}
                  >
                    Cancel appointment
                  </button>
                </div>
              )}
            </div>
            {!['Cancelled', 'Completed', 'No-show'].includes(resource.data.appointment.status) && <PatientRegistration token={token} />}
            {resource.data.appointment.status === 'Cancelled' ? (
              <p className="form-hint">
                This appointment is cancelled. Please contact the practice to
                reschedule.
              </p>
            ) : resource.data.status !== 'Requested' ? (
              <div className="empty-state">
                <UserCheck size={38} />
                <h2>Thank you. Your form is with the care team.</h2>
                <p>
                  Patient-reported medications and allergies will be reviewed
                  before changes are made to the chart.
                </p>
              </div>
            ) : (
              <form className="form-stack" onSubmit={submit}>
                <label>
                  Main concern
                  <input
                    name="concern"
                    required
                    maxLength={200}
                    placeholder="What would you like to discuss?"
                  />
                </label>
                <label>
                  Symptoms or updates
                  <textarea name="symptoms" rows={4} maxLength={4000} />
                </label>
                <label>
                  Allergies you want the team to review
                  <small>
                    Separate with commas; leave blank if none reported
                  </small>
                  <input
                    name="allergies"
                    placeholder="e.g. Penicillin, Latex"
                  />
                </label>
                <label>
                  Medications you are taking
                  <small>One per line: medication | dose | how often</small>
                  <textarea
                    name="medications"
                    rows={4}
                    placeholder="Example medicine | 10 mg | once daily"
                  />
                </label>
                <label className="checkbox-label">
                  <input name="consent" type="checkbox" />I agree to appointment
                  and follow-up reminders. Delivery remains in demo mode.
                </label>
                <label className="checkbox-label">
                  <input name="attested" required type="checkbox" />I have
                  reviewed this information and want to submit it to my care
                  team.
                </label>
                <button className="button primary" disabled={action.busy}>
                  {action.busy ? 'Submitting…' : 'Submit intake'}
                </button>
              </form>
            )}
          </>
        )}
        {isStandalonePreview && (
          <button
            className="text-button portal-return"
            onClick={() => {
              location.hash = 'overview';
            }}
          >
            Return to clinical preview
            <ArrowRight size={15} />
          </button>
        )}
      </section>
    </main>
  );
}

export function IntakePage({
  patientId,
  onChanged,
}: {
  patientId?: string;
  onChanged?: () => Promise<void>;
}) {
  const resource = useResource<IntakeRow[]>('/workflow/intakes', []);
  const action = useAction(async () => {
    await resource.reload();
    await onChanged?.();
  });
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Pre-visit intake review</h2>
          <p className="section-caption">
            Patient reports stay separate until a clinician reviews them. Create
            links from the patient queue.
          </p>
        </div>
        <button
          className="icon-button"
          aria-label="Refresh intake"
          onClick={() => action.run(resource.reload)}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      <Feedback {...resource} />
      <ActionFeedback action={action} />
      <div className="workflow-list">
        {resource.data
          .filter((i) => !patientId || i.patient_id === patientId)
          .map((i) => (
            <article className="intake-card" key={i.id}>
              <div className="section-heading">
                <div>
                  <strong>{fullName(i)}</strong>
                  <p>Requested {prettyDate(i.created_at)}</p>
                </div>
                <Badge>{i.status}</Badge>
              </div>
              {i.answers && (
                <>
                  <div className="intake-answers">
                    <div>
                      <small>Patient concern</small>
                      <p>{i.answers.concern}</p>
                    </div>
                    <div>
                      <small>Symptoms / updates</small>
                      <p>{i.answers.symptoms || 'None supplied'}</p>
                    </div>
                    <div>
                      <small>Reported allergies</small>
                      <p>{i.answers.allergies.join(', ') || 'None reported'}</p>
                    </div>
                    <div>
                      <small>Reported medications</small>
                      {i.answers.medications.length ? (
                        i.answers.medications.map((m, index) => (
                          <p key={index}>
                            {m.name} · {m.dose} · {m.frequency}
                          </p>
                        ))
                      ) : (
                        <p>None reported</p>
                      )}
                    </div>
                  </div>
                  {i.status === 'Submitted' && (
                    <div className="button-row">
                      <button
                        className="button primary small"
                        disabled={action.busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              'Replace the recorded allergies and medications with these patient-reported lists after your review?',
                            )
                          )
                            void action.run(
                              () =>
                                patch(`/workflow/intakes/${i.id}/review`, {
                                  reconcile: true,
                                }),
                              'Intake reviewed and chart reconciled',
                            );
                        }}
                      >
                        Review & reconcile chart
                      </button>
                      <button
                        className="button secondary small"
                        disabled={action.busy}
                        onClick={() =>
                          action.run(
                            () =>
                              patch(`/workflow/intakes/${i.id}/review`, {
                                reconcile: false,
                              }),
                            'Reviewed; chart lists unchanged',
                          )
                        }
                      >
                        Reviewed — retain chart lists
                      </button>
                    </div>
                  )}
                </>
              )}
            </article>
          ))}
        {!resource.loading &&
          !resource.data.some(
            (i) => !patientId || i.patient_id === patientId,
          ) && (
            <Empty
              icon={ClipboardList}
              title="No intake forms yet"
              description="Create an intake link for an appointment from the patient queue."
            />
          )}
      </div>
    </section>
  );
}

export function TaskBoard({
  patients,
  user,
  onChanged,
  initialTaskId,
}: {
  patients: Patient[];
  user: User;
  onChanged: () => Promise<void>;
  initialTaskId?: string;
}) {
  const resource = useResource<TaskRow[]>('/workflow/tasks', []);
  const team = useResource<Team[]>('/workflow/team', []);
  useWorkSourceFocus(resource.data.some(task => task.id === initialTaskId) ? `work-care-${initialTaskId}` : undefined);
  const [filter, setFilter] = useState('Open');
  const [showForm, setShowForm] = useState(false);
  const action = useAction(async () => {
    await resource.reload();
    await onChanged();
  });
  const rows = resource.data
    .filter(
      (t) =>
        filter === 'All' ||
        (filter === 'Completed'
          ? t.done
          : filter === 'Mine'
            ? !t.done && t.owner_id === user.id
            : filter === 'Overdue'
              ? !t.done && t.due_date && t.due_date < today()
              : !t.done),
    )
    .sort(
      (a, b) =>
        Number(a.done) - Number(b.done) ||
        Number(b.priority === 'High') - Number(a.priority === 'High') ||
        (a.due_date || '9999').localeCompare(b.due_date || '9999'),
    );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(
      new FormData(event.currentTarget).entries(),
    );
    await action.run(async () => {
      await post('/workflow/tasks', {
        ...values,
        patient_id: values.patient_id || null,
      });
      setShowForm(false);
    }, 'Care task created');
  }
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Assigned care inbox</h2>
          <p className="section-caption">
            Every follow-up has an owner and a next step.
          </p>
        </div>
        <button
          className="button primary small"
          onClick={() => setShowForm(true)}
        >
          <Plus size={15} />
          New task
        </button>
      </div>
      <Feedback
        error={resource.error || team.error}
        loading={resource.loading}
      />
      <ActionFeedback action={action} />
      <div className="panel-toolbar">
        <div className="tabs">
          {['Open', 'Mine', 'Overdue', 'Completed', 'All'].map((f) => (
            <button
              className={filter === f ? 'active' : ''}
              key={f}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      <div className="workflow-list">
        {rows.map((t) => (
          <article
            className={`assigned-task ${t.done ? 'task-done' : ''} ${t.id === initialTaskId ? 'work-source-focus' : ''}`}
            key={t.id}
            id={`work-care-${t.id}`}
            tabIndex={t.id === initialTaskId ? -1 : undefined}
          >
            <button
              className="task-check"
              aria-label={`${t.done ? 'Reopen' : 'Complete'} ${t.title}`}
              disabled={action.busy}
              onClick={() =>
                action.run(() =>
                  patch(`/workflow/tasks/${t.id}`, { done: !t.done }),
                )
              }
            >
              {t.done ? <Check size={13} /> : null}
            </button>
            <div className="assigned-task-main">
              <strong>{t.title}</strong>
              <p>
                {fullName(t) || 'Practice task'} · {t.category}
              </p>
              <div className="task-assignment">
                <label>
                  Owner
                  <select
                    aria-label={`Owner for ${t.title}`}
                    disabled={action.busy}
                    value={t.owner_id}
                    onChange={(e) =>
                      action.run(() =>
                        patch(`/workflow/tasks/${t.id}`, {
                          owner_id: e.target.value,
                        }),
                      )
                    }
                  >
                    {team.data
                      .filter((u) => u.role === 'clinician')
                      .map((u) => (
                        <option value={u.id} key={u.id}>
                          {u.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Due date
                  <input
                    aria-label={`Due date for ${t.title}`}
                    disabled={action.busy}
                    type="date"
                    value={t.due_date}
                    onChange={(e) => {
                      if (e.target.value)
                        void action.run(() =>
                          patch(`/workflow/tasks/${t.id}`, {
                            due_date: e.target.value,
                          }),
                        );
                    }}
                  />
                </label>
                <label>
                  Priority
                  <select
                    aria-label={`Priority for ${t.title}`}
                    value={t.priority}
                    disabled={action.busy}
                    onChange={(e) =>
                      action.run(() =>
                        patch(`/workflow/tasks/${t.id}`, {
                          priority: e.target.value,
                        }),
                      )
                    }
                  >
                    <option>Normal</option>
                    <option>High</option>
                  </select>
                </label>
              </div>
            </div>
            <div className="task-status">
              <Badge>
                {t.done
                  ? 'Completed'
                  : t.due_date && t.due_date < today()
                    ? 'Overdue'
                    : t.priority === 'High'
                      ? 'High'
                      : 'Open'}
              </Badge>
            </div>
          </article>
        ))}
        {!resource.loading && !rows.length && (
          <Empty
            icon={Inbox}
            title="All clear in this view"
            description="Choose another filter or create a care task."
          />
        )}
      </div>
      {showForm && (
        <Modal title="Create a care task" onClose={() => setShowForm(false)}>
          <form className="modal-body form-grid" onSubmit={submit}>
            <label className="span-2">
              Task title
              <input name="title" required maxLength={200} />
            </label>
            <label className="span-2">
              Patient
              <select name="patient_id">
                <option value="">Practice task</option>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {fullName(p)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Owner
              <select name="owner_id" defaultValue={user.id}>
                {team.data
                  .filter((u) => u.role === 'clinician')
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Due date
              <input
                name="due_date"
                type="date"
                required
                defaultValue={today()}
              />
            </label>
            <label>
              Category
              <select name="category">
                {[
                  'Follow-up',
                  'Lab review',
                  'Documentation',
                  'Intake review',
                  'Referral',
                  'Refill',
                  'Other',
                ].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              Priority
              <select name="priority">
                <option>Normal</option>
                <option>High</option>
              </select>
            </label>
            <ActionFeedback action={action} />
            <footer className="modal-footer span-2">
              <button
                className="button secondary"
                type="button"
                onClick={() => setShowForm(false)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={action.busy}>
                Create task
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </section>
  );
}

type ReminderRow = {
  id: string;
  first_name: string;
  last_name: string;
  message: string;
  kind: string;
  channel: string;
  due_date: string;
  status: string;
  delivery: string;
  consent: boolean;
};
export function RemindersPage({ clinical }: { clinical: boolean }) {
  const resource = useResource<ReminderRow[]>('/workflow/reminders', []);
  const action = useAction(resource.reload);
  const [view, setView] = useState('Active');
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Reminder outbox</h2>
          <p className="section-caption">
            Demo delivery · Messages are never sent automatically. Recording
            manual outreach requires you to contact the patient first.
          </p>
        </div>
        {clinical && (
          <button
            className="button secondary small"
            disabled={action.busy}
            onClick={() =>
              action.run(
                () => post('/workflow/automation', {}),
                'Due reminders refreshed',
              )
            }
          >
            <RefreshCw size={15} />
            Process due reminders
          </button>
        )}
      </div>
      <Feedback {...resource} />
      <ActionFeedback action={action} />
      <div className="panel-toolbar">
        <div className="tabs">
          {['Active', 'Handled', 'All'].map((v) => (
            <button
              className={view === v ? 'active' : ''}
              key={v}
              onClick={() => setView(v)}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      <div className="workflow-list">
        {resource.data
          .filter(
            (r) =>
              view === 'All' ||
              (view === 'Active'
                ? ['Ready', 'Scheduled'].includes(r.status)
                : !['Ready', 'Scheduled'].includes(r.status)),
          )
          .map((r) => (
            <article className="reminder-card" key={r.id}>
              <div className="section-heading">
                <div>
                  <strong>{fullName(r)}</strong>
                  <p>
                    {r.kind} · Due {prettyDate(r.due_date)}
                  </p>
                </div>
                <Badge>{r.status}</Badge>
              </div>
              <p className="reminder-message">{r.message}</p>
              <div className="reminder-detail">
                <span>
                  {r.channel} · {r.delivery}
                </span>
                <span>Consent: {r.consent ? 'Recorded' : 'Not recorded'}</span>
              </div>
              {['Ready', 'Scheduled'].includes(r.status) && (
                <div className="button-row">
                  <button
                    className="button secondary small"
                    disabled={action.busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          'Confirm you have already contacted the patient manually. This button does not send a message.',
                        )
                      )
                        void action.run(
                          () =>
                            patch(`/workflow/reminders/${r.id}`, {
                              action: 'record-manual',
                            }),
                          'Manual outreach recorded',
                        );
                    }}
                  >
                    Record completed manual outreach
                  </button>
                  <button
                    className="text-button"
                    disabled={action.busy}
                    onClick={() =>
                      action.run(() =>
                        patch(`/workflow/reminders/${r.id}`, {
                          action: 'cancel',
                        }),
                      )
                    }
                  >
                    Cancel reminder
                  </button>
                </div>
              )}
            </article>
          ))}
        {!resource.loading && !resource.data.length && (
          <Empty
            title="No reminders yet"
            description="Active appointments and documented follow-up plans create reminders automatically."
          />
        )}
      </div>
    </section>
  );
}

export function NoteTools({
  fields,
  onApply,
  onPhrase,
  disabled,
}: {
  fields: {
    subjective: string;
    objective: string;
    assessment: string;
    plan: string;
  };
  onApply: (t: NoteTemplate) => void;
  onPhrase: (field: keyof typeof fields, text: string) => void;
  disabled: boolean;
}) {
  const templates = useResource<NoteTemplate[]>('/workflow/templates', []);
  const phrases = useResource<{ id: string; shortcut: string; text: string }[]>(
    '/workflow/phrases',
    [],
  );
  const [selected, setSelected] = useState('');
  const [target, setTarget] = useState<keyof typeof fields>('plan');
  const [phrase, setPhrase] = useState('');
  const [name, setName] = useState('');
  const [showSave, setShowSave] = useState(false);
  const [showPhrase, setShowPhrase] = useState(false);
  const [newShortcut, setNewShortcut] = useState('');
  const [newPhrase, setNewPhrase] = useState('');
  const action = useAction(templates.reload);
  return (
    <section className="note-tools">
      <div className="tool-heading">
        <ClipboardList size={16} />
        <strong>Templates & smart phrases</strong>
        <small>Review every inserted prompt before signing</small>
      </div>
      <Feedback error={templates.error || phrases.error} />
      <div className="note-tool-row">
        <select
          aria-label="Visit template"
          value={selected}
          disabled={disabled}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">Choose a visit template</option>
          {templates.data.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button
          className="button secondary small"
          disabled={!selected || disabled}
          onClick={() => {
            const template = templates.data.find((t) => t.id === selected);
            if (
              template &&
              (!Object.values(fields).some(Boolean) ||
                window.confirm(
                  'Replace the SOAP text with this template? Your recorded vitals and chief complaint are retained.',
                ))
            )
              onApply(template);
          }}
        >
          Apply template
        </button>
        <button
          className="text-button"
          disabled={disabled}
          onClick={() => setShowSave((v) => !v)}
        >
          Save as template
        </button>
      </div>
      <div className="note-tool-row">
        <select
          aria-label="Smart phrase"
          value={phrase}
          disabled={disabled}
          onChange={(e) => setPhrase(e.target.value)}
        >
          <option value="">Choose a smart phrase</option>
          {phrases.data.map((p) => (
            <option value={p.id} key={p.id}>
              {p.shortcut}
            </option>
          ))}
        </select>
        <select
          aria-label="Smart phrase section"
          value={target}
          disabled={disabled}
          onChange={(e) => setTarget(e.target.value as keyof typeof fields)}
        >
          {['subjective', 'objective', 'assessment', 'plan'].map((s) => (
            <option key={s} value={s}>
              {s[0].toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
        <button
          className="button secondary small"
          disabled={!phrase || disabled}
          onClick={() => {
            const chosen = phrases.data.find((p) => p.id === phrase);
            if (chosen) onPhrase(target, chosen.text);
          }}
        >
          Insert phrase
        </button>
        <button
          className="text-button"
          disabled={disabled}
          onClick={() => setShowPhrase((v) => !v)}
        >
          Create smart phrase
        </button>
      </div>
      {showPhrase && (
        <div className="phrase-composer">
          <label>
            Phrase shortcut
            <input
              value={newShortcut}
              maxLength={32}
              placeholder=".example"
              onChange={(e) => setNewShortcut(e.target.value)}
            />
          </label>
          <label>
            Phrase text
            <textarea
              value={newPhrase}
              rows={3}
              maxLength={3000}
              onChange={(e) => setNewPhrase(e.target.value)}
              placeholder="Reusable text; use [[prompts]] for details that require review."
            />
          </label>
          <button
            className="button secondary small"
            disabled={
              disabled ||
              !newShortcut.trim() ||
              !newPhrase.trim() ||
              action.busy
            }
            onClick={() =>
              action.run(async () => {
                await post('/workflow/phrases', {
                  shortcut: newShortcut,
                  text: newPhrase,
                });
                await phrases.reload();
                setShowPhrase(false);
                setNewShortcut('');
                setNewPhrase('');
              }, 'Smart phrase saved')
            }
          >
            Save smart phrase
          </button>
        </div>
      )}
      {showSave && (
        <div className="note-tool-row">
          <input
            aria-label="New template name"
            placeholder="Name this reusable template"
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            className="button primary small"
            disabled={disabled || !name.trim() || action.busy}
            onClick={() =>
              action.run(async () => {
                await post('/workflow/templates', { name, ...fields });
                setShowSave(false);
                setName('');
              }, 'Template saved')
            }
          >
            Save template
          </button>
        </div>
      )}
      <ActionFeedback action={action} />
    </section>
  );
}

export function PatientQuickTools({
  patients,
  query,
  onQuery,
  onChart,
}: {
  patients: Patient[];
  query: string;
  onQuery: (q: string) => void;
  onChart: (id: string) => void;
}) {
  const pref = useResource<Preferences>('/workflow/preferences', {
    favorites: [],
    recent: [],
    filters: [],
  });
  const [name, setName] = useState('');
  const action = useAction(pref.reload);
  return (
    <div className="patient-quick-tools">
      <div className="quick-filter-row">
        <span className="subtle-label">Saved views</span>
        {pref.data.filters.map((f) => (
          <button
            className={`filter-chip ${f.query === query ? 'selected' : ''}`}
            key={f.name}
            onClick={() => onQuery(f.query)}
          >
            {f.name}
            <span
              className="remove-filter"
              role="button"
              tabIndex={0}
              aria-label={`Remove ${f.name} view`}
              onClick={(e) => {
                e.stopPropagation();
                void action.run(() =>
                  patch('/workflow/preferences', {
                    filters: pref.data.filters.filter((v) => v.name !== f.name),
                  }),
                );
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.stopPropagation();
                  void action.run(() =>
                    patch('/workflow/preferences', {
                      filters: pref.data.filters.filter(
                        (v) => v.name !== f.name,
                      ),
                    }),
                  );
                }
              }}
            >
              ×
            </span>
          </button>
        ))}
        <input
          aria-label="Saved view name"
          placeholder="Name this search"
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          className="text-button"
          disabled={!name.trim() || action.busy}
          onClick={() =>
            action.run(async () => {
              await patch('/workflow/preferences', {
                filters: [
                  ...pref.data.filters.filter((f) => f.name !== name.trim()),
                  { name: name.trim(), query },
                ],
              });
              setName('');
            }, 'Search view saved')
          }
        >
          Save current view
        </button>
      </div>
      <div className="recent-patients">
        <span className="subtle-label">Recent & starred</span>
        {[...new Set([...pref.data.favorites, ...pref.data.recent])]
          .slice(0, 8)
          .map((id) => {
            const p = patients.find((p) => p.id === id);
            return p ? (
              <span className="recent-patient" key={id}>
                <button className="text-button" onClick={() => onChart(id)}>
                  {fullName(p)}
                </button>
                <button
                  className={`star-button ${pref.data.favorites.includes(id) ? 'starred' : ''}`}
                  aria-label={`${pref.data.favorites.includes(id) ? 'Unstar' : 'Star'} ${fullName(p)}`}
                  onClick={() =>
                    action.run(() =>
                      patch('/workflow/preferences', {
                        favorites: pref.data.favorites.includes(id)
                          ? pref.data.favorites.filter((v) => v !== id)
                          : [...pref.data.favorites, id],
                      }),
                    )
                  }
                >
                  <Star size={12} />
                </button>
              </span>
            ) : null;
          })}
        {!pref.data.recent.length && (
          <span className="section-caption">
            Open a chart to build your recent list.
          </span>
        )}
      </div>
      <ActionFeedback action={action} />
    </div>
  );
}

export function CommandPalette({
  patients,
  encounters,
  onChart,
  onNote,
  onNavigate,
  onClose,
}: {
  patients: Patient[];
  encounters: Encounter[];
  onChart: (id: string) => void;
  onNote: (e: Encounter) => void;
  onNavigate: (page: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const prefs = useResource<Preferences>('/workflow/preferences', {
    favorites: [],
    recent: [],
    filters: [],
  });
  const [favoriteError, setFavoriteError] = useState('');
  const matching = patients
    .filter((p) =>
      `${fullName(p)} ${mrn(p.id)} ${p.phone}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(prefs.data.favorites.includes(b.id)) -
        Number(prefs.data.favorites.includes(a.id)),
    )
    .slice(0, 8);
  return (
    <Modal
      title="Find your next step"
      subtitle="Search patients and notes · Alt+P register patient · Alt+N new note · Alt+S schedule"
      onClose={onClose}
    >
      <div className="modal-body command-palette">
        <Feedback error={favoriteError || prefs.error} />
        <label className="command-search">
          <Search size={18} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Patient, chart ID, phone, or encounter…"
            aria-label="Command search"
          />
        </label>
        <div className="command-nav">
          {[
            'overview',
            'patients',
            'queue',
            'schedule',
            'inbox',
            'orders',
            'reminders',
            'metrics',
          ]
            .filter((page) => page.includes(query.toLowerCase()))
            .map((page) => (
              <button
                key={page}
                onClick={() => {
                  onClose();
                  onNavigate(page);
                }}
              >
                {page[0].toUpperCase() + page.slice(1)}
                <ArrowRight size={13} />
              </button>
            ))}
        </div>
        <p className="eyebrow">PATIENTS</p>
        {matching.map((p) => (
          <div className="command-patient" key={p.id}>
            <button
              className="person-cell"
              onClick={() => {
                onClose();
                onChart(p.id);
              }}
            >
              <Avatar person={p} />
              <span>
                <strong>{fullName(p)}</strong>
                <small>{mrn(p.id)}</small>
              </span>
            </button>
            <button
              className={`star-button ${prefs.data.favorites.includes(p.id) ? 'starred' : ''}`}
              aria-label={`${prefs.data.favorites.includes(p.id) ? 'Unstar' : 'Star'} ${fullName(p)}`}
              onClick={() =>
                patch('/workflow/preferences', {
                  favorites: prefs.data.favorites.includes(p.id)
                    ? prefs.data.favorites.filter((id) => id !== p.id)
                    : [...prefs.data.favorites, p.id],
                })
                  .then(prefs.reload)
                  .catch(error => setFavoriteError(error.message))
              }
            >
              <Star size={15} />
            </button>
          </div>
        ))}
        {query && (
          <>
            <p className="eyebrow">ENCOUNTERS</p>
            {encounters
              .filter((e) =>
                `${fullName(e)} ${e.chief_complaint}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .slice(0, 5)
              .map((e) => (
                <button
                  className="command-note"
                  key={e.id}
                  onClick={() => {
                    onClose();
                    onNote(e);
                  }}
                >
                  <span>
                    {fullName(e)} · {e.chief_complaint}
                  </span>
                  <Badge>{e.status}</Badge>
                </button>
              ))}
          </>
        )}
      </div>
    </Modal>
  );
}
