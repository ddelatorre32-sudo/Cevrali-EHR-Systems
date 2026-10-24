import { useState, type FormEvent } from 'react';
import { Plus, ShieldCheck } from 'lucide-react';
import { patch, post } from './api';
import { Modal, Badge } from './components';
import { useResource } from './workflow-ui';
import {
  defaultPatientAccountId,
  type PatientBillingAccount,
  type WcDocumentation,
} from '../server/patient-accounts';
import type { Appointment } from './types';
import type { Policy } from '../server/finance-engine';

const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(
    new Date(),
  );
export const splitParts = (value: FormDataEntryValue | null) =>
  String(value || '')
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean);
export function workersCompFromForm(f: FormData, prefix = 'wc_') {
  return Object.fromEntries(
    [
      'claim_number',
      'date_of_injury',
      'employer',
      'carrier',
      'jurisdiction',
      'adjuster_name',
      'adjuster_phone',
      'adjuster_email',
      'claim_status',
    ].map((k) => [k, f.get(prefix + k) || '']),
  ) as Record<string, unknown>;
}
export function readWorkersComp(f: FormData, prefix = 'wc_') {
  return {
    ...workersCompFromForm(f, prefix),
    accepted_body_parts: splitParts(f.get(prefix + 'accepted_body_parts')),
  };
}
export function WorkersCompFields({
  account,
  prefix = 'wc_',
}: {
  account?: PatientBillingAccount;
  prefix?: string;
}) {
  const wc = account?.workers_comp;
  return (
    <>
      <div className="form-grid">
        <label>
          Workers comp claim number
          <input
            name={prefix + 'claim_number'}
            defaultValue={wc?.claim_number}
            required
            maxLength={200}
          />
        </label>
        <label>
          Date of injury
          <input
            name={prefix + 'date_of_injury'}
            type="date"
            defaultValue={wc?.date_of_injury}
            required
            max={today()}
          />
        </label>
        <label>
          Employer
          <input
            name={prefix + 'employer'}
            defaultValue={wc?.employer}
            required
            maxLength={200}
          />
        </label>
        <label>
          Workers comp carrier
          <input
            name={prefix + 'carrier'}
            defaultValue={wc?.carrier}
            required
            maxLength={200}
          />
        </label>
        <label>
          Claim jurisdiction
          <input
            name={prefix + 'jurisdiction'}
            defaultValue={wc?.jurisdiction}
            maxLength={100}
            placeholder="State or program"
          />
        </label>
        <label>
          Claim acceptance status
          <select
            name={prefix + 'claim_status'}
            defaultValue={wc?.claim_status || 'Pending'}
          >
            <option>Pending</option>
            <option>Accepted</option>
            <option>Denied</option>
          </select>
        </label>
        <label>
          Adjuster name
          <input
            name={prefix + 'adjuster_name'}
            defaultValue={wc?.adjuster_name}
            maxLength={200}
          />
        </label>
        <label>
          Adjuster phone
          <input
            name={prefix + 'adjuster_phone'}
            defaultValue={wc?.adjuster_phone}
            maxLength={40}
          />
        </label>
        <label>
          Adjuster email
          <input
            name={prefix + 'adjuster_email'}
            type="email"
            defaultValue={wc?.adjuster_email}
            maxLength={254}
          />
        </label>
        <label className="span-2">
          Accepted body parts
          <textarea
            name={prefix + 'accepted_body_parts'}
            defaultValue={wc?.accepted_body_parts.join('\n')}
            maxLength={6000}
            rows={3}
            placeholder="One per line, including side, e.g. Left shoulder"
          />
        </label>
      </div>
      <p className="finance-help">
        Enter acceptance details from the claim determination. This app does not
        determine compensability or infer accepted body parts. Pending and
        denied claims can be saved for follow-up.
      </p>
    </>
  );
}
export function RegistrationWorkersComp() {
  const [enabled, setEnabled] = useState(false);
  return (
    <section className="registration-insurance span-2">
      <h3>Workers compensation account</h3>
      <label className="finance-check">
        <input
          name="add_workers_comp"
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Add workers compensation claim during registration
      </label>
      {enabled && (
        <>
          <label>
            Claim account name
            <input
              name="wc_account_name"
              defaultValue="Workers compensation"
              required
              maxLength={200}
            />
          </label>
          <WorkersCompFields />
          <p className="finance-help">
            A separate private/personal account is kept for unrelated care.
            Select the appropriate account for each visit. No claim is
            transmitted.
          </p>
        </>
      )}
    </section>
  );
}

export function BillingAccountSelect({
  patientId,
  value,
  onChange,
  disabled = false,
  name = 'billing_account_id',
  label = 'Account for this visit',
  privateOnly = false,
}: {
  patientId: string;
  value?: string;
  onChange?: (id: string) => void;
  disabled?: boolean;
  name?: string;
  label?: string;
  privateOnly?: boolean;
}) {
  const [internal, setInternal] = useState({ patientId: '', id: '' });
  const resource = useResource<PatientBillingAccount[]>(
    `/workflow/finance/accounts${patientId ? `?patient_id=${encodeURIComponent(patientId)}` : ''}`,
    [],
  );
  const policies = useResource<Policy[]>(
    `/workflow/finance/policies${patientId ? `?patient_id=${encodeURIComponent(patientId)}` : ''}`,
    [],
  );
  const rows = resource.data.filter(
    (a) =>
      a.patient_id === patientId &&
      (!privateOnly || a.kind === 'Private insurance') &&
      (a.status === 'Active' || a.id === value),
  );
  const selected =
    value ||
    (internal.patientId === patientId ? internal.id : '') ||
    rows.find((a) => a.id === defaultPatientAccountId(patientId))?.id ||
    rows[0]?.id ||
    '';
  return (
    <label>
      {label}
      <select
        name={name}
        aria-label={label}
        value={selected}
        onChange={(e) => {
          setInternal({ patientId, id: e.target.value });
          onChange?.(e.target.value);
        }}
        disabled={disabled || !patientId}
        required
      >
        <option value="" disabled>
          {patientId ? 'Select billing account' : 'Choose patient first'}
        </option>
        {rows.map((a) => {
          const carrier = a.workers_comp
            ? `${a.workers_comp.carrier} · Claim ${a.workers_comp.claim_number}`
            : policies.data
                .filter(
                  (p) =>
                    p.billing_account_id === a.id && p.priority === 'Primary',
                )
                .map((p) => p.payer)
                .join(', ');
          return (
            <option value={a.id} key={a.id}>
              {a.name}
              {carrier ? ` · ${carrier}` : ''}
              {a.status === 'Closed' ? ' · Closed' : ''}
            </option>
          );
        })}
      </select>
      {resource.error && <small role="alert">{resource.error}</small>}
      <small>
        Visit account follows the appointment into the note and billing.
      </small>
    </label>
  );
}

export function PatientBillingAccounts({ patientId }: { patientId: string }) {
  const resource = useResource<PatientBillingAccount[]>(
    `/workflow/finance/accounts?patient_id=${patientId}`,
    [],
  );
  const [editing, setEditing] = useState<PatientBillingAccount | true | null>(
    null,
  );
  const [kind, setKind] = useState('Workers compensation');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const f = new FormData(event.currentTarget);
    try {
      const previous = editing === true ? undefined : editing;
      const body = {
        patient_id: patientId,
        name: f.get('account_name'),
        kind,
        status: f.get('account_status'),
        revision: previous?.revision,
        workers_comp:
          kind === 'Workers compensation' ? readWorkersComp(f) : null,
      };
      if (previous)
        await patch(`/workflow/finance/accounts/${previous.id}`, body);
      else await post('/workflow/finance/accounts', body);
      await resource.reload();
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workflow-stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Patient billing accounts</h2>
            <p>
              One patient chart. Separate coverage and claim accounts for each
              visit.
            </p>
          </div>
          <button
            className="button primary"
            onClick={() => {
              setKind('Workers compensation');
              setError('');
              setEditing(true);
            }}
          >
            <Plus size={16} />
            Add billing account
          </button>
        </div>
        <p className="finance-help">
          Use private insurance for personal care or select the specific
          workplace injury claim. Closing an account stops new visit selection
          and retains its history. Signed notes and prepared claims keep their
          original details.
        </p>
        {resource.error && (
          <p className="form-error" role="alert">
            {resource.error}
          </p>
        )}
        <div className="finance-cards">
          {resource.data.map((a) => (
            <article
              className="finance-card patient-billing-account"
              key={a.id}
            >
              <div className="finance-card-header">
                <div>
                  <h3>{a.name}</h3>
                  <p>{a.kind}</p>
                </div>
                <Badge>{a.status}</Badge>
              </div>
              {a.workers_comp ? (
                <dl className="finance-details">
                  <div>
                    <dt>Claim / carrier</dt>
                    <dd>
                      {a.workers_comp.claim_number} · {a.workers_comp.carrier}
                    </dd>
                  </div>
                  <div>
                    <dt>Injury / employer</dt>
                    <dd>
                      {a.workers_comp.date_of_injury} ·{' '}
                      {a.workers_comp.employer}
                    </dd>
                  </div>
                  <div>
                    <dt>Acceptance</dt>
                    <dd>{a.workers_comp.claim_status}</dd>
                  </div>
                  <div>
                    <dt>Accepted body parts</dt>
                    <dd>
                      {a.workers_comp.accepted_body_parts.join(' · ') ||
                        'Not yet recorded'}
                    </dd>
                  </div>
                  <div>
                    <dt>Adjuster</dt>
                    <dd>
                      {[
                        a.workers_comp.adjuster_name,
                        a.workers_comp.adjuster_phone,
                        a.workers_comp.adjuster_email,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'Not recorded'}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="finance-help">
                  Manage private coverage in the Insurance tab. This account can
                  be selected again for any unrelated visit.
                </p>
              )}
              <button
                className="button secondary"
                onClick={() => {
                  setKind(a.kind);
                  setError('');
                  setEditing(a);
                }}
              >
                Edit billing account
              </button>
            </article>
          ))}
        </div>
      </section>
      {editing && (
        <Modal
          title={
            editing === true
              ? 'Add patient billing account'
              : 'Edit patient billing account'
          }
          onClose={() => setEditing(null)}
          wide
        >
          <form onSubmit={save}>
            <div className="modal-body account-form">
              <div className="form-grid">
                <label>
                  Account name
                  <input
                    name="account_name"
                    defaultValue={
                      editing === true ? 'Workers compensation' : editing.name
                    }
                    required
                    maxLength={200}
                  />
                </label>
                <label>
                  Account type
                  <select
                    aria-label="Account type"
                    value={kind}
                    disabled={editing !== true}
                    onChange={(e) => setKind(e.target.value)}
                  >
                    <option>Workers compensation</option>
                    <option>Private insurance</option>
                  </select>
                </label>
                <label>
                  Account status
                  <select
                    name="account_status"
                    defaultValue={editing === true ? 'Active' : editing.status}
                  >
                    <option>Active</option>
                    <option>Closed</option>
                  </select>
                </label>
              </div>
              {kind === 'Workers compensation' && (
                <WorkersCompFields
                  account={editing === true ? undefined : editing}
                />
              )}
              <p className="finance-help">
                A used claim’s number, carrier, injury date, and employer are
                preserved. Add another account for a separate injury or claim.
              </p>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
            </div>
            <footer className="modal-footer">
              <button
                type="button"
                className="button secondary"
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                Save billing account
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}

export function WorkersCompNote({
  account,
  value,
  onChange,
  disabled,
  refresh,
}: {
  account: PatientBillingAccount;
  value: WcDocumentation;
  onChange: (v: WcDocumentation) => void;
  disabled: boolean;
  refresh: () => void;
}) {
  const wc = account.workers_comp!;
  const set = (key: keyof WcDocumentation, v: unknown) =>
    onChange({ ...value, [key]: v });
  return (
    <section className="workers-comp-note">
      <h3>
        <ShieldCheck size={18} />
        Workers compensation documentation
      </h3>
      <p>
        <strong>Claim {wc.claim_number}</strong> · {wc.carrier}
        <br />
        {wc.employer} · Injury {wc.date_of_injury} · {wc.claim_status}
      </p>
      <p className="finance-help">
        Accepted body parts:{' '}
        {wc.accepted_body_parts.join(' · ') || 'Not recorded'}. Select the
        accepted parts addressed in this visit. Document other findings in SOAP
        without treating them as accepted.
      </p>
      {!disabled &&
        value.account_revision !== undefined &&
        value.account_revision !== account.revision && (
          <p className="form-error">
            Claim details changed. Refresh and review them before saving.
          </p>
        )}
      {!disabled&&<button type="button" className="text-button" onClick={refresh}>Refresh claim details</button>}
      <fieldset disabled={disabled}>
        <label className="finance-check">
          <input
            type="checkbox"
            checked={value.claim_reviewed}
            onChange={(e) => set('claim_reviewed', e.target.checked)}
          />
          I reviewed the claim number and accepted body parts for this visit
        </label>
        <div className="wc-parts">
          {wc.accepted_body_parts.map((part) => (
            <label className="finance-check" key={part}>
              <input
                type="checkbox"
                checked={value.addressed_body_parts.includes(part)}
                onChange={(e) =>
                  set(
                    'addressed_body_parts',
                    e.target.checked
                      ? [...value.addressed_body_parts, part]
                      : value.addressed_body_parts.filter((p) => p !== part),
                  )
                }
              />
              {part}
            </label>
          ))}
        </div>
        <label>
          Injury history and mechanism
          <textarea
            value={value.injury_history}
            onChange={(e) => set('injury_history', e.target.value)}
            rows={3}
            maxLength={5000}
          />
        </label>
        <label>
          Assessment of relationship to the work injury
          <textarea
            value={value.work_related_assessment}
            onChange={(e) => set('work_related_assessment', e.target.value)}
            rows={3}
            maxLength={5000}
          />
        </label>
        <div className="form-grid">
          <label>
            Work status
            <select
              aria-label="Work status"
              value={value.work_status}
              onChange={(e) => set('work_status', e.target.value)}
            >
              {['Not assessed', 'Full duty', 'Modified duty', 'Off work'].map(
                (s) => (
                  <option key={s}>{s}</option>
                ),
              )}
            </select>
          </label>
          <label>
            Next work-status review
            <input
              type="date"
              min={today()}
              value={value.next_review_date}
              onChange={(e) => set('next_review_date', e.target.value)}
            />
          </label>
        </div>
        <label>
          Work restrictions and duration
          <textarea
            value={value.restrictions}
            onChange={(e) => set('restrictions', e.target.value)}
            rows={3}
            maxLength={5000}
            placeholder="Specify restrictions and the applicable period when modified duty or off work is selected"
          />
        </label>
      </fieldset>
      <p className="finance-help">
        Complete SOAP assessment and plan as well. Jurisdiction-specific reports
        and external claim submission remain in demo mode.
      </p>
    </section>
  );
}

export function AppointmentBillingAccount({
  appointment,
  onChanged,
}: {
  appointment: Appointment;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(
    appointment.billing_account_id ||
      defaultPatientAccountId(appointment.patient_id),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <>
      <small className="visit-account-label">
        {appointment.billing_account_name ||
          'Private insurance / personal care'}
      </small>
      {['Scheduled', 'Checked in'].includes(appointment.status) && (
        <button
          className="text-button"
          onClick={() => {
            setValue(
              appointment.billing_account_id ||
                defaultPatientAccountId(appointment.patient_id),
            );
            setError('');
            setOpen(true);
          }}
        >
          Visit insurance
        </button>
      )}
      {open && (
        <Modal title="Insurance for this visit" onClose={() => setOpen(false)}>
          <div className="modal-body account-form">
            <p>
              {appointment.first_name} {appointment.last_name} ·{' '}
              {appointment.date} at {appointment.time}
            </p>
            <BillingAccountSelect
              patientId={appointment.patient_id}
              value={value}
              onChange={setValue}
            />
            <p className="finance-help">
              Confirm the account for this date of service. Once an encounter
              starts, its draft must be reviewed before changing the visit
              account.
            </p>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await patch(
                    `/appointments/${appointment.id}/billing-account`,
                    {
                      billing_account_id: value,
                      previous_billing_account_id:
                        appointment.billing_account_id ||
                        defaultPatientAccountId(appointment.patient_id),
                    },
                  );
                  await onChanged();
                  setOpen(false);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save visit insurance
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
