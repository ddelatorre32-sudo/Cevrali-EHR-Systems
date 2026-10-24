import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronRight,
  Clock3,
  FileText,
  FlaskConical,
  Heart,
  LockKeyhole,
  Mail,
  MapPin,
  Phone,
  Pill,
  Plus,
  Save,
  ShieldAlert,
  Stethoscope,
  UserRound,
  X,
} from 'lucide-react';
import { api, patch, post } from './api';
import type { Appointment, Encounter, Patient } from './types';
import { NoteTools, useResource } from './workflow-ui';
import { VisitContextPanel } from './order-tools';
import { ActualTreatmentReview } from './treatment-ui';
import { NoteAddenda } from './note-addenda-ui';
import { clinicAge, clinicDate, formatClinicDate } from './clinic-dates';
import { AllergyPicker } from './allergy-picker';
import { US_STATES, formatPatientAddress } from '../server/patient-demographics';
import { PatientDetailsEditor, PatientProfileHistory } from './patient-profile-ui';
import { PatientAllergies } from './patient-allergies-ui';
import { InsurancePage, BillingPage } from './finance-ui';
import { RegistrationInsuranceFields } from './insurance-fields';
import { AuthorizationsPage } from './authorizations-ui';
import {
  ClaimWorkspace,
  PatientDocuments,
  VisitServiceFields,
  readVisitPlanForm,
  ReceivedResultsSection,
} from './operations-ui';
import {
  BillingAccountSelect,
  PatientBillingAccounts,
  RegistrationWorkersComp,
  readWorkersComp,
  WorkersCompNote,
  AppointmentBillingAccount,
} from './patient-accounts-ui';
import {
  defaultPatientAccountId,
  wcDocumentationInput,
  type PatientBillingAccount,
} from '../server/patient-accounts';

export const fullName = (p: { first_name?: string; last_name?: string }) =>
  `${p.first_name || ''} ${p.last_name || ''}`.trim();
export const initials = (p: { first_name?: string; last_name?: string }) =>
  `${p.first_name?.[0] || ''}${p.last_name?.[0] || ''}`;
export const age = clinicAge;
export const prettyDate = formatClinicDate;
export function timeLabel(time: string) {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
export const mrn = (id: string) =>
  `CV-${id.replace('pat-', '').toUpperCase().padStart(5, '0')}`;

export function Avatar({
  person,
  large = false,
}: {
  person: { first_name?: string; last_name?: string };
  large?: boolean;
}) {
  const color = (person.first_name?.charCodeAt(0) || 0) % 5;
  return (
    <span className={`avatar color-${color} ${large ? 'avatar-large' : ''}`}>
      {initials(person)}
    </span>
  );
}
export function Badge({ children }: { children: string }) {
  return (
    <span
      className={`badge badge-${children.toLowerCase().replaceAll(' ', '-')}`}
    >
      <span />
      {children}
    </span>
  );
}
export function Empty({
  icon: Icon = FileText,
  title,
  description,
  action,
}: {
  icon?: typeof FileText;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon size={25} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
const modalStack: string[] = [];
let pageOverflow = '';
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    if (!modalStack.length) pageOverflow = document.body.style.overflow;
    modalStack.push(headingId);
    document.body.style.overflow = 'hidden';
    const focusable = () =>
      Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ) || [],
      );
    focusable()[0]?.focus();
    const handler = (event: KeyboardEvent) => {
      if (modalStack.at(-1) !== headingId) return;
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const elements = focusable();
        const first = elements[0];
        const last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      const index = modalStack.lastIndexOf(headingId);
      if (index >= 0) modalStack.splice(index, 1);
      if (!modalStack.length) document.body.style.overflow = pageOverflow;
      document.removeEventListener('keydown', handler);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className={`modal ${wide ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <header className="modal-header">
          <div>
            <h2 id={headingId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function PatientForm({
  onClose,
  onSaved,
  clinical,
  openOnCreate = false,
  scheduling = false,
}: {
  onClose: () => void;
  onSaved: (
    id: string,
    openRecord: boolean,
    initialTab?: string,
    existing?: boolean,
  ) => Promise<void>;
  clinical: boolean;
  openOnCreate?: boolean;
  scheduling?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [registeredPatient, setRegisteredPatient] = useState<{
    id: string;
    openRecord: boolean;
    initialTab: string;
  } | null>(null);
  const registered = useRef<typeof registeredPatient>(null);
  const submitting = useRef(false);
  const [openRecord, setOpenRecord] = useState(openOnCreate);
  const [hasInsurance, setHasInsurance] = useState(false);
  const [allergies, setAllergies] = useState<string[]>([]);
  const [duplicates, setDuplicates] = useState<
    {
      id: string;
      first_name: string;
      last_name: string;
      dob: string;
      phone: string;
    }[]
  >([]);
  const [duplicateIdentity, setDuplicateIdentity] = useState('');
  const [duplicateAcknowledged, setDuplicateAcknowledged] = useState(false);
  const duplicateBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (duplicates.length)
      duplicateBox.current?.scrollIntoView({ block: 'nearest' });
  }, [duplicates]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      if (!registered.current) {
        const f = new FormData(event.currentTarget);
        const values = Object.fromEntries(f.entries());
        const insurance = values.add_insurance
          ? {
              policy: Object.fromEntries(
                [
                  'payer',
                  'plan',
                  'member_id',
                  'group_number',
                  'priority',
                  'subscriber_name',
                  'subscriber_dob',
                  'relationship',
                  'effective_date',
                  'end_date',
                ].map((key) => [key, f.get(`insurance_${key}`) ?? '']),
              ),
              ...(values.verify_insurance
                ? {
                    verification: {
                      service_date: values.insurance_service_date,
                      scenario: values.insurance_scenario,
                    },
                  }
                : {}),
            }
          : undefined;
        if (insurance && values.patient_is_subscriber) {
          insurance.policy.subscriber_name =
            `${values.first_name} ${values.last_name}`.trim();
          insurance.policy.subscriber_dob = values.dob;
          insurance.policy.relationship = 'Self';
        }
        const identity = JSON.stringify([
          values.first_name,
          values.last_name,
          values.dob,
        ]);
        const acknowledged =
          duplicateAcknowledged && duplicateIdentity === identity;
        const matches = await api<typeof duplicates>(
          `/patients/matches?${new URLSearchParams({ first_name: String(values.first_name), last_name: String(values.last_name), dob: String(values.dob) })}`,
        );
        if (matches.length && !acknowledged) {
          setDuplicates(matches);
          setDuplicateIdentity(identity);
          setDuplicateAcknowledged(false);
          return;
        }
        const result = await post<{ id: string }>('/patients', {
          ...values,
          allergies: clinical ? allergies : [],
          conditions: String(values.conditions || '')
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean),
          ...(insurance ? { insurance } : {}),
          ...(values.add_workers_comp
            ? {
                workers_comp: {
                  name: values.wc_account_name,
                  workers_comp: readWorkersComp(f),
                },
              }
            : {}),
          duplicate_acknowledged: acknowledged,
        });
        registered.current = {
          id: result.id,
          openRecord:
            Boolean(insurance) ||
            Boolean(values.add_workers_comp) ||
            openRecord,
          initialTab: values.add_workers_comp
            ? 'Billing accounts'
            : insurance
              ? 'Insurance'
              : clinical
                ? 'Summary'
                : 'Insurance',
        };
        setRegisteredPatient(registered.current);
      }
      await onSaved(
        registered.current.id,
        registered.current.openRecord,
        registered.current.initialTab,
      );
      onClose();
    } catch (e) {
      setError(
        registered.current
          ? `Patient saved. Please retry ${scheduling ? 'continuing scheduling' : 'opening the record'}: ${(e as Error).message}`
          : (e as Error).message,
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Register a patient"
      subtitle={
        scheduling
          ? 'Register the patient, then return to the selected appointment time.'
          : 'Create a patient record in your practice.'
      }
      onClose={onClose}
    >
      <form onSubmit={submit} className="modal-body form-grid">
        <fieldset
          disabled={busy || Boolean(registeredPatient)}
          aria-label="Patient registration details"
          style={{ display: 'contents' }}
        >
          <label>
            First name
            <input
              autoComplete="given-name"
              name="first_name"
              required
              maxLength={100}
            />
          </label>
          <label>
            Last name
            <input
              autoComplete="family-name"
              name="last_name"
              required
              maxLength={100}
            />
          </label>
          <label>
            Date of birth
            <input
              name="dob"
              type="date"
              min="1900-01-01"
              max={clinicDate()}
              required
            />
          </label>
          <label>
            Sex
            <select name="sex" defaultValue="Unknown">
              <option>Female</option>
              <option>Male</option>
              <option>Other</option>
              <option>Unknown</option>
            </select>
          </label>
          <label>
            Phone number
            <input
              name="phone"
              type="tel"
              autoComplete="tel"
              required
              maxLength={40}
            />
          </label>
          <label>
            Email address
            <input
              name="email"
              type="email"
              autoComplete="email"
              maxLength={254}
            />
          </label>
          <label className="span-2">
            Address
            <input name="address" autoComplete="address-line1" maxLength={500} placeholder="Street address" />
          </label>
          <label>
            Unit / Apt number
            <input name="address_unit" autoComplete="address-line2" maxLength={100} />
          </label>
          <label>
            City
            <input name="city" autoComplete="address-level2" maxLength={100} />
          </label>
          <label>
            State
            <select name="state" autoComplete="address-level1" defaultValue="">
              <option value="">Select state</option>
              {US_STATES.map(({ code, name }) => <option value={code} key={code}>{name} ({code})</option>)}
            </select>
          </label>
          <label>
            ZIP code
            <input name="zip_code" autoComplete="postal-code" inputMode="numeric" maxLength={10} pattern="[0-9]{5}(-[0-9]{4})?" title="Enter a 5-digit ZIP code or ZIP+4, such as 01234 or 01234-5678" />
          </label>
          {clinical && (
            <>
              <div className="span-2"><AllergyPicker value={allergies} onChange={setAllergies} disabled={busy || Boolean(registeredPatient)} /></div>
              <label className="span-2">
                Active conditions <small>Separate with commas</small>
                <input
                  name="conditions"
                  placeholder="e.g. Hypertension"
                  maxLength={2000}
                />
              </label>
            </>
          )}
          <RegistrationInsuranceFields onEnabledChange={setHasInsurance} />
          <RegistrationWorkersComp />
          {!scheduling && (
            <label className="finance-check span-2">
              <input
                type="checkbox"
                checked={openRecord || hasInsurance}
                disabled={hasInsurance}
                onChange={(e) => setOpenRecord(e.target.checked)}
              />
              Open patient record after registration
            </label>
          )}
          {duplicates.length > 0 && !registeredPatient && (
            <div
              ref={duplicateBox}
              className="duplicate-review span-2"
              role="region"
              aria-label="Possible duplicate patients"
            >
              <h3>Review existing patient records</h3>
              <p>
                A patient with the same name and birth date is already registered.
              </p>
              {duplicates.map((p) => (
                <div key={p.id}>
                  <div>
                    <strong>{fullName(p)}</strong>
                    <p>
                      {prettyDate(p.dob)} · {mrn(p.id)} · {p.phone}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      setError('');
                      try {
                        await onSaved(
                          p.id,
                          true,
                          clinical ? 'Summary' : 'Insurance',
                          true,
                        );
                        onClose();
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {scheduling
                      ? 'Use existing patient for appointment'
                      : 'Open existing patient'}
                  </button>
                </div>
              ))}
              <label className="finance-check">
                <input
                  type="checkbox"
                  checked={duplicateAcknowledged}
                  onChange={(e) => setDuplicateAcknowledged(e.target.checked)}
                />
                I reviewed the matches and need a separate patient record
              </label>
            </div>
          )}
        </fieldset>
        {registeredPatient && (
          <p className="inline-success span-2" role="status">
            {busy
              ? `Patient saved. ${scheduling ? 'Continuing scheduling…' : 'Opening the patient record…'}`
              : `Patient saved. Registration details are locked. ${scheduling ? 'Continue scheduling with this saved patient.' : 'Retry opening this saved patient record.'}`}
          </p>
        )}
        {error && (
          <p className="form-error span-2" role="alert">
            {error}
          </p>
        )}
        <footer className="modal-footer span-2">
          <button type="button" className="button secondary" onClick={onClose}>
            {registeredPatient ? 'Close' : 'Cancel'}
          </button>
          <button className="button primary" disabled={busy}>
            <Plus size={16} />
            {busy
              ? registeredPatient
                ? scheduling
                  ? 'Continuing…'
                  : 'Opening…'
                : 'Registering…'
              : registeredPatient
                ? scheduling
                  ? 'Continue scheduling saved patient'
                  : 'Retry opening patient record'
                : scheduling
                  ? 'Register and continue scheduling'
                  : 'Register patient'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function AppointmentForm({
  patients,
  today,
  onClose,
  onSaved,
  initialTime = '14:00',
  initialProvider = '',
  clinical = true,
  onPatientsChanged,
  registerNewPatient = false,
}: {
  patients: Patient[];
  today: string;
  onClose: () => void;
  onSaved: (date: string) => Promise<void>;
  initialTime?: string;
  initialProvider?: string;
  clinical?: boolean;
  onPatientsChanged?: () => Promise<void>;
  registerNewPatient?: boolean;
}) {
  const team = useResource<{ id: string; name: string; role: string }[]>(
    '/workflow/team',
    [],
  );
  const providers = team.data.filter((u) => u.role === 'clinician');
  const [providerId, setProviderId] = useState(initialProvider);
  const [registering, setRegistering] = useState(registerNewPatient);
  const [extraPatients, setExtraPatients] = useState<Patient[]>([]);
  const [patientMessage, setPatientMessage] = useState('');
  const patientOptions = [
    ...new Map([...patients, ...extraPatients].map((p) => [p.id, p])).values(),
  ];
  const [selectedPatient, setSelectedPatient] = useState('');
  const [selectedBilling, setSelectedBilling] = useState('');
  const [selectedDate, setSelectedDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedAppointment, setSavedAppointment] = useState<{
    id: string;
    date: string;
  } | null>(null);
  const savedAppointmentRef = useRef<typeof savedAppointment>(null);
  const submittingRef = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError('');
    try {
      let saved = savedAppointmentRef.current;
      if (!saved) {
        const formData = new FormData(event.currentTarget);
        const values = Object.fromEntries(formData.entries());
        if (!values.billing_account_id)
          throw new Error('Choose the account for this visit before scheduling');
        const appointment = await post<{ id: string }>('/appointments', {
          ...values,
          duration: Number(values.duration),
          service_plan: readVisitPlanForm(formData),
        });
        saved = { id: appointment.id, date: String(values.date) };
        savedAppointmentRef.current = saved;
        setSavedAppointment(saved);
      }
      await onSaved(saved.date);
      onClose();
    } catch (e) {
      const message = (e as Error).message;
      setError(
        savedAppointmentRef.current
          ? `The appointment is saved, but the schedule could not refresh. ${message}`
          : message,
      );
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <div
        inert={registering || undefined}
        aria-hidden={registering || undefined}
      >
        <Modal
          title="Schedule an appointment"
          subtitle="Make room for a little more care."
          onClose={onClose}
        >
          <form onSubmit={submit} className="modal-body form-grid">
            <fieldset
              disabled={busy || Boolean(savedAppointment)}
              aria-label="Appointment details"
              style={{ display: 'contents' }}
            >
              <label className="span-2">
                Patient
                <select
                  name="patient_id"
                  required
                  value={selectedPatient}
                  onChange={(e) => {
                    setSelectedPatient(e.target.value);
                    setSelectedBilling(`pba-private-${e.target.value}`);
                  }}
                >
                  <option disabled value="">
                    Select a patient
                  </option>
                  {patientOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {fullName(p)} · {mrn(p.id)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="calendar-register-patient span-2">
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => setRegistering(true)}
                >
                  <Plus size={15} />
                  Register new patient
                </button>
                <p>
                  {patientMessage ||
                    'Create a patient record and continue booking this appointment.'}
                </p>
              </div>
              <label>
                Date
                <input
                  type="date"
                  name="date"
                  required
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                />
              </label>
              <div className="span-2">
                <BillingAccountSelect
                  patientId={selectedPatient}
                  value={selectedBilling}
                  onChange={setSelectedBilling}
                />
              </div>
              {selectedPatient && (
                <VisitServiceFields
                  key={`${selectedPatient}:${selectedBilling}:${selectedDate}`}
                  patientId={selectedPatient}
                  billingId={selectedBilling}
                  date={selectedDate}
                />
              )}
              <label>
                Time
                <input
                  type="time"
                  name="time"
                  required
                  defaultValue={initialTime}
                />
              </label>
              <label>
                Visit type
                <select name="type">
                  <option>Consultation</option>
                  <option>Follow-up</option>
                  <option>Annual physical</option>
                  <option>Procedure</option>
                </select>
              </label>
              <label>
                Duration
                <select name="duration" defaultValue="30">
                  <option value="15">15 minutes</option>
                  <option value="30">30 minutes</option>
                  <option value="45">45 minutes</option>
                  <option value="60">60 minutes</option>
                </select>
              </label>
              <label className="span-2">
                Reason for visit
                <textarea
                  name="reason"
                  rows={3}
                  required
                  maxLength={500}
                  placeholder="What brings the patient in?"
                />
              </label>
              <label className="span-2">
                Provider
                <select
                  name="provider_id"
                  value={providerId || providers[0]?.id || ''}
                  onChange={(e) => setProviderId(e.target.value)}
                  required
                >
                  {providers.length ? (
                    providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))
                  ) : (
                    <option value="">Add clinical staff in Account setup</option>
                  )}
                </select>
                <small>Pacific time · active clinicians in this practice</small>
              </label>
            </fieldset>
            {savedAppointment && (
              <p className="inline-success span-2" role="status">
                {busy
                  ? 'Appointment saved. Refreshing the schedule…'
                  : 'Appointment saved. Retry the schedule refresh to finish. The booking details are locked.'}
              </p>
            )}
            {team.error && (
              <p className="form-error span-2" role="alert">
                {team.error}
              </p>
            )}
            {error && (
              <p className="form-error span-2" role="alert">
                {error}
              </p>
            )}
            <footer className="modal-footer span-2">
              <button
                type="button"
                className="button secondary"
                onClick={onClose}
              >
                {savedAppointment ? 'Close' : 'Cancel'}
              </button>
              <button
                className="button primary"
                disabled={busy || (!savedAppointment && (team.loading || !providers.length))}
              >
                <CalendarDays size={16} />
                {savedAppointment
                  ? busy
                    ? 'Refreshing…'
                    : 'Retry schedule refresh'
                  : busy
                    ? 'Scheduling…'
                    : 'Schedule appointment'}
              </button>
            </footer>
          </form>
        </Modal>
      </div>
      {registering && (
        <PatientForm
          clinical={clinical}
          scheduling
          onClose={() => setRegistering(false)}
          onSaved={async (id, _open, initialTab, _existing) => {
            const directory = await api<Patient[]>('/patients');
            const person = directory.find((p) => p.id === id);
            if (!person)
              throw new Error(
                'Patient was saved but could not be loaded. Retry to continue scheduling.',
              );
            const accounts = await api<PatientBillingAccount[]>(
              `/workflow/finance/accounts?patient_id=${id}`,
            );
            setExtraPatients((p) => [...p.filter((p) => p.id !== id), person]);
            setSelectedPatient(id);
            setSelectedBilling(
              (initialTab === 'Billing accounts' && !_existing
                ? accounts.find(
                    (a) =>
                      a.kind === 'Workers compensation' &&
                      a.status === 'Active',
                  )?.id
                : undefined) ||
                accounts.find(
                  (a) =>
                    a.kind === 'Private insurance' && a.status === 'Active',
                )?.id ||
                accounts.find((a) => a.status === 'Active')?.id ||
                '',
            );
            await onPatientsChanged?.();
            setPatientMessage(
              `${fullName(person)} selected. Confirm the visit account and finish scheduling below.`,
            );
            setRegistering(false);
          }}
        />
      )}
    </>
  );
}

export function PatientChart({
  patient,
  onClose,
  onEncounter,
  clinical = true,
  initialTab = 'Summary',
  onChanged,
}: {
  patient: Patient;
  onClose: () => void;
  onEncounter: (patient: Patient) => void;
  clinical?: boolean;
  initialTab?: string;
  onChanged: () => Promise<void>;
}) {
  const [tab, setTab] = useState(initialTab);
  const [editingDetails, setEditingDetails] = useState(false);
  const [profileVersion, setProfileVersion] = useState(0);
  const [allergyDirty, setAllergyDirty] = useState(false);
  function confirmLeavingAllergies() {
    return !allergyDirty || window.confirm('Discard the unsaved allergy changes?');
  }
  function changeChartTab(next: string) {
    if (next !== tab && !confirmLeavingAllergies()) return;
    setTab(next);
  }
  async function profileChanged() {
    await onChanged();
    setProfileVersion((value) => value + 1);
  }
  return (
    <>
    <Modal
      title={clinical ? 'Patient chart' : 'Patient record'}
      subtitle={`${mrn(patient.id)} · ${clinical ? 'Longitudinal care record' : 'Demographics, insurance & billing'}`}
      onClose={() => { if (confirmLeavingAllergies()) onClose(); }}
      wide
    >
      <div className="chart-identity">
        <Avatar person={patient} large />
        <div>
          <h2>{fullName(patient)}</h2>
          <p>
            {age(patient.dob)} years · {patient.sex} · DOB{' '}
            {prettyDate(patient.dob)}
          </p>
        </div>
        <div className="button-row patient-chart-actions">
          <button className="button secondary" onClick={() => setEditingDetails(true)}>Edit patient details</button>
        {clinical && (
          <button
            className="button primary"
            onClick={() => { if (confirmLeavingAllergies()) onEncounter(patient); }}
          >
            <Plus size={16} />
            New encounter
          </button>
        )}
        </div>
      </div>
      {clinical && (
        <div className="allergy-strip">
          <ShieldAlert size={17} />
          <strong>Allergies</strong>
          <div className="patient-allergy-summary">
          <span>
            {patient.allergies?.length
              ? patient.allergies.join(' · ')
              : patient.allergy_profile?.status === 'No known allergies'
                ? 'No known allergies'
                : 'Allergies not yet reviewed'}
          </span>
          {patient.allergy_profile?.records.filter((entry) => entry.status === 'Active' && (entry.reaction || entry.severity !== 'Unknown' || entry.type === 'Intolerance')).map((entry) => <small key={entry.id} className={['Severe', 'Life-threatening'].includes(entry.severity) ? 'allergy-severity-high' : ''}>{entry.name}: {entry.type} · {entry.severity}{entry.reaction ? ` · ${entry.reaction}` : ''}</small>)}
          </div>
          <Badge>{patient.allergy_profile?.reviewed_at ? 'Reviewed' : 'Not reviewed'}</Badge>
          <button className="text-button" onClick={() => changeChartTab('Allergies')}>Review allergies</button>
        </div>
      )}
      <div className="tabs chart-tabs">
        {(clinical
          ? [
              'Summary',
              'Allergies',
              'Encounters',
              'Lab results',
              'Insurance',
              'Billing accounts',
              'Billing',
              'Authorizations',
              'Claim workspace',
              'Documents',
              'Change history',
            ]
          : [
              'Summary',
              'Insurance',
              'Billing accounts',
              'Billing',
              'Authorizations',
              'Claim workspace',
              'Documents',
              'Change history',
            ]
        ).map((t) => (
          <button
            className={t === tab ? 'active' : ''}
            onClick={() => changeChartTab(t)}
            key={t}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="chart-content">
        {tab === 'Allergies' && clinical && <PatientAllergies patientId={patient.id} onChanged={profileChanged} onDirtyChange={setAllergyDirty} />}
        {tab === 'Change history' && <PatientProfileHistory key={profileVersion} patientId={patient.id} clinical={clinical} />}
        {tab === 'Summary' && (
          <div className="chart-grid">
            <section className="mini-card">
              <h3>
                <UserRound size={17} />
                Patient details
              </h3>
              <p>
                <Phone size={15} />
                {patient.phone}
              </p>
              <p>
                <Mail size={15} />
                {patient.email || 'No email recorded'}
              </p>
              <p>
                <MapPin size={15} />
                <span style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>{formatPatientAddress(patient) || 'No address recorded'}</span>
              </p>
            </section>
            {clinical && (
              <>
                <section className="mini-card">
                  <h3>
                    <Activity size={17} />
                    Active conditions
                  </h3>
                  {patient.conditions?.length ? (
                    patient.conditions.map((c) => (
                      <div className="condition" key={c}>
                        <span className="condition-dot" />
                        {c}
                        <span className="tiny-label">Active</span>
                      </div>
                    ))
                  ) : (
                    <p className="muted">No active conditions recorded.</p>
                  )}
                </section>
                <section className="mini-card span-2">
                  <h3>
                    <Pill size={17} />
                    Medication history{' '}
                    <span className="tiny-label">Recorded medications</span>
                  </h3>
                  {patient.medications?.length ? (
                    patient.medications.map((m) => (
                      <div className="medication" key={m.name}>
                        <span className="pill-icon">
                          <Pill size={18} />
                        </span>
                        <div>
                          <strong>{m.name}</strong>
                          <p>
                            {m.dose} · {m.frequency}
                          </p>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="muted">No medications recorded.</p>
                  )}
                </section>
                <section className="mini-card span-2">
                  <h3>
                    <Heart size={17} />
                    Latest recorded vitals
                  </h3>
                  {patient.encounters?.[0] ? (
                    <div className="vitals">
                      <div>
                        <small>Blood pressure</small>
                        <strong>
                          {patient.encounters[0].bp || '—'} <em>mmHg</em>
                        </strong>
                      </div>
                      <div>
                        <small>Heart rate</small>
                        <strong>
                          {patient.encounters[0].pulse || '—'} <em>bpm</em>
                        </strong>
                      </div>
                      <div>
                        <small>Temperature</small>
                        <strong>
                          {patient.encounters[0].temperature || '—'} <em>°C</em>
                        </strong>
                      </div>
                    </div>
                  ) : (
                    <p className="muted">
                      Vitals will appear after the first encounter.
                    </p>
                  )}
                </section>
              </>
            )}
          </div>
        )}
        {tab === 'Insurance' && (
          <InsurancePage patients={[patient]} patient={patient} />
        )}
        {tab === 'Claim workspace' && (
          <ClaimWorkspace patientId={patient.id} clinical={clinical} />
        )}
        {tab === 'Documents' && (
          <PatientDocuments patientId={patient.id} clinical={clinical} />
        )}
        {tab === 'Billing accounts' && (
          <PatientBillingAccounts patientId={patient.id} />
        )}
        {tab === 'Authorizations' && (
          <AuthorizationsPage patients={[patient]} patient={patient} />
        )}
        {tab === 'Billing' && (
          <BillingPage patients={[patient]} patient={patient} />
        )}
        {clinical &&
          tab === 'Encounters' &&
          (patient.encounters?.length ? (
            patient.encounters.map((e) => (
              <article className="chart-note" key={e.id}>
                <div className="section-heading">
                  <div>
                    <strong>{e.chief_complaint}</strong>
                    <p>
                      {prettyDate(e.created_at)} · {e.author}
                    </p>
                  </div>
                  <Badge>{e.status}</Badge>
                </div>
                {e.billing_account_snapshot?.kind === 'Workers compensation' &&
                  e.wc_documentation && (
                    <WorkersCompNote
                      account={e.billing_account_snapshot}
                      value={e.wc_documentation}
                      disabled
                      onChange={() => {}}
                      refresh={() => {}}
                    />
                  )}
                {[
                  ['Subjective', e.subjective],
                  ['Objective', e.objective],
                  ['Assessment', e.assessment],
                  ['Plan', e.plan],
                ].map(([label, content]) => (
                  <div className="note-section" key={label}>
                    <h4>{label}</h4>
                    <p>{content || 'Not yet documented'}</p>
                  </div>
                ))}
                {e.appointment_id && (
                  <ActualTreatmentReview encounterId={e.id} />
                )}
                {e.received_results?.length ? (
                  <section className="note-section">
                    <h4>Received lab & radiology results</h4>
                    {e.received_results.map((r) => (
                      <div key={r.id}>
                        <strong>
                          {r.source_kind} · {r.source_sender}
                        </strong>
                        <p className="ops-preserve-text">{r.text}</p>
                      </div>
                    ))}
                  </section>
                ) : null}
                {e.status === 'Signed' && <NoteAddenda encounterId={e.id} />}
              </article>
            ))
          ) : (
            <Empty
              title="A fresh care journey"
              description="Start an encounter to document this patient's visit."
            />
          ))}
        {clinical &&
          tab === 'Lab results' &&
          (patient.labs?.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Test</th>
                    <th>Result</th>
                    <th>Reference</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {patient.labs.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <strong>{l.name}</strong>
                      </td>
                      <td>
                        <span className={l.flag === 'High' ? 'abnormal' : ''}>
                          {l.value} {l.unit}
                        </span>{' '}
                        <Badge>{l.flag}</Badge>
                      </td>
                      <td>{l.reference_range}</td>
                      <td>{prettyDate(l.date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              icon={FlaskConical}
              title="No results recorded"
              description="There are no laboratory results in this patient's chart."
            />
          ))}
      </div>
    </Modal>
    {editingDetails && <PatientDetailsEditor patient={patient} onClose={() => setEditingDetails(false)} onChanged={profileChanged} />}
    </>
  );
}

export function EncounterEditor({
  encounter,
  patientName,
  onClose,
  onSaved,
}: {
  encounter: Encounter;
  patientName: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [fields, setFields] = useState({
    chief_complaint: encounter.chief_complaint,
    subjective: encounter.subjective,
    objective: encounter.objective,
    assessment: encounter.assessment,
    plan: encounter.plan,
    bp: encounter.bp,
    pulse: encounter.pulse,
    temperature: encounter.temperature,
  });
  const [updatedAt, setUpdatedAt] = useState(encounter.updated_at);
  const [receivedResultsVersion, setReceivedResultsVersion] = useState(0);
  const accounts = useResource<PatientBillingAccount[]>(
    `/workflow/finance/accounts?patient_id=${encounter.patient_id}`,
    [],
  );
  const [billingId, setBillingId] = useState(
    encounter.billing_account_id ||
      defaultPatientAccountId(encounter.patient_id),
  );
  const [wc, setWc] = useState(
    wcDocumentationInput.parse(encounter.wc_documentation || {}),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [confirmSign, setConfirmSign] = useState(false);
  const [dirty, setDirty] = useState(false);
  const locked = encounter.status === 'Signed';
  const selectedAccount =
    locked && encounter.billing_account_snapshot
      ? encounter.billing_account_snapshot
      : accounts.data.find((a) => a.id === billingId);
  const close = () => {
    if (!dirty || window.confirm('Discard unsaved changes to this note?'))
      onClose();
  };
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  function change(name: keyof typeof fields, value: string) {
    setFields((f) => ({ ...f, [name]: value }));
    setSaved(false);
    setDirty(true);
  }
  async function save(status: 'Draft' | 'Signed') {
    setBusy(true);
    setError('');
    try {
      const r = await patch<{ updated_at: string }>(
        `/encounters/${encounter.id}`,
        {
          ...fields,
          updated_at: updatedAt,
          status,
          received_results_version: receivedResultsVersion,
          billing_account_id: billingId,
          wc_documentation:
            selectedAccount?.kind === 'Workers compensation' ? wc : null,
        },
      );
      setUpdatedAt(r.updated_at);
      setSaved(true);
      setDirty(false);
      await onSaved();
      if (status === 'Signed') onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setConfirmSign(false);
    }
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!locked && !busy && !confirmSign) void save('Draft');
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [fields, updatedAt, busy, locked, confirmSign, billingId, wc]);
  return (
    <Modal
      title={locked ? 'Signed encounter' : 'Document encounter'}
      subtitle={`${patientName} · ${prettyDate(encounter.created_at)} · ${encounter.author}`}
      onClose={close}
      wide
    >
      <div className="visit-workspace">
        <VisitContextPanel encounter={encounter} />
        <div className="modal-body encounter-form">
          <div className="encounter-top">
            <Badge>{encounter.status}</Badge>
            <span className="muted">
              {locked
                ? 'Signed notes are locked'
                : saved
                  ? 'All changes saved'
                  : 'Save your progress as a draft'}
            </span>
          </div>
          {locked && (
            <div className="form-hint">
              <LockKeyhole size={16} />
              Signed{' '}
              {encounter.signed_at ? prettyDate(encounter.signed_at) : ''}. This
              note is read-only.
            </div>
          )}
          <BillingAccountSelect
            patientId={encounter.patient_id}
            value={billingId}
            disabled={locked || busy}
            onChange={(id) => {
              setBillingId(id);
              setWc(
                wcDocumentationInput.parse({
                  account_revision: accounts.data.find((a) => a.id === id)
                    ?.revision,
                }),
              );
              setDirty(true);
              setSaved(false);
            }}
          />
          {selectedAccount?.kind === 'Workers compensation' && (
            <WorkersCompNote
              account={selectedAccount}
              value={wc}
              disabled={locked || busy}
              onChange={(v) => {
                setWc(v);
                setDirty(true);
                setSaved(false);
              }}
              refresh={() =>
                void accounts
                  .reload()
                  .then((rows) => {
                    const a = rows.find((a) => a.id === billingId);
                    if (a)
                      setWc({
                        ...wc,
                        account_revision: a.revision,
                        claim_reviewed: false,
                        addressed_body_parts: wc.addressed_body_parts.filter(
                          (p) =>
                            a.workers_comp?.accepted_body_parts.includes(p),
                        ),
                      });
                    setDirty(true);
                  })
                  .catch((e) => setError(e.message))
              }
            />
          )}
          <NoteTools
            fields={{
              subjective: fields.subjective,
              objective: fields.objective,
              assessment: fields.assessment,
              plan: fields.plan,
            }}
            disabled={locked || busy}
            onApply={(template) => {
              setFields((f) => ({
                ...f,
                subjective: template.subjective,
                objective: template.objective,
                assessment: template.assessment,
                plan: template.plan,
              }));
              setDirty(true);
              setSaved(false);
            }}
            onPhrase={(key, text) =>
              change(key, [fields[key], text].filter(Boolean).join('\n'))
            }
          />
          <label>
            Chief complaint
            <input
              disabled={locked || busy}
              value={fields.chief_complaint}
              onChange={(e) => change('chief_complaint', e.target.value)}
              maxLength={500}
            />
          </label>
          <div className="vital-inputs">
            <label>
              Blood pressure <small>mmHg</small>
              <input
                placeholder="120/80"
                disabled={locked || busy}
                value={fields.bp}
                onChange={(e) => change('bp', e.target.value)}
              />
            </label>
            <label>
              Heart rate <small>bpm</small>
              <input
                placeholder="72"
                disabled={locked || busy}
                value={fields.pulse}
                onChange={(e) => change('pulse', e.target.value)}
              />
            </label>
            <label>
              Temperature <small>°C</small>
              <input
                placeholder="36.7"
                disabled={locked || busy}
                value={fields.temperature}
                onChange={(e) => change('temperature', e.target.value)}
              />
            </label>
          </div>
          {(['subjective', 'objective', 'assessment', 'plan'] as const).map(
            (key, i) => (
              <label className="soap-label" key={key}>
                <span>
                  <b>{['S', 'O', 'A', 'P'][i]}</b>
                  {key[0].toUpperCase() + key.slice(1)}
                  {['assessment', 'plan'].includes(key) && (
                    <small>Required to sign</small>
                  )}
                </span>
                <textarea
                  rows={3}
                  disabled={locked || busy}
                  value={fields[key]}
                  onChange={(e) => change(key, e.target.value)}
                  maxLength={10000}
                  placeholder={
                    {
                      subjective:
                        'History, symptoms, and patient-reported concerns…',
                      objective: 'Examination findings and observations…',
                      assessment: 'Clinical assessment and diagnoses…',
                      plan: 'Treatment plan and follow-up…',
                    }[key]
                  }
                />
              </label>
            ),
          )}
          <ReceivedResultsSection
            encounterId={encounter.id}
            locked={locked}
            onVersion={setReceivedResultsVersion}
          />
          {encounter.appointment_id && (
            <ActualTreatmentReview encounterId={encounter.id} />
          )}
          {locked && <NoteAddenda encounterId={encounter.id} />}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {confirmSign && (
            <div className="confirm-box">
              <LockKeyhole size={20} />
              <div>
                <strong>Sign and lock this note?</strong>
                <p>
                  Confirm the documentation is complete. Signed notes cannot be
                  edited in this starter.
                </p>
                <div className="button-row">
                  <button
                    className="button secondary"
                    onClick={() => setConfirmSign(false)}
                  >
                    Keep editing
                  </button>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => save('Signed')}
                  >
                    {busy ? 'Signing…' : 'Confirm signature'}
                  </button>
                </div>
              </div>
            </div>
          )}
          <footer className="modal-footer">
            <button className="button secondary" onClick={close}>
              {locked ? 'Close' : 'Cancel'}
            </button>
            {!locked && (
              <>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => save('Draft')}
                >
                  <Save size={16} />
                  {saved ? 'Saved' : 'Save draft'}
                </button>
                <button
                  className="button primary"
                  disabled={busy || confirmSign}
                  onClick={() => setConfirmSign(true)}
                >
                  <Check size={16} />
                  Sign note
                </button>
              </>
            )}
          </footer>
        </div>
      </div>
    </Modal>
  );
}

export function AppointmentTable({
  appointments,
  onChart,
  onStatus,
  onStart,
  clinical,
  limit,
  onBillingChanged,
}: {
  appointments: Appointment[];
  onChart: (id: string) => void;
  onStatus: (a: Appointment, status: string) => void;
  onStart: (a: Appointment) => void;
  clinical: boolean;
  limit?: number;
  onBillingChanged?: () => Promise<void>;
}) {
  if (!appointments.length)
    return (
      <Empty
        icon={CalendarDays}
        title="A little breathing room"
        description="No appointments for this day. Schedule a visit to get started."
      />
    );
  return (
    <div className="table-scroll">
      <table className="appointment-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Patient</th>
            <th>Visit type</th>
            <th>Status</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {appointments.slice(0, limit).map((a) => (
            <tr key={a.id}>
              <td className="time-cell">
                <strong>{timeLabel(a.time)}</strong>
                <small>{a.duration} min</small>
              </td>
              <td>
                <button
                  className="person-cell"
                  disabled={!clinical}
                  onClick={() => onChart(a.patient_id)}
                >
                  <Avatar person={a} />
                  <span>
                    <strong>{fullName(a)}</strong>
                    <small>
                      {age(a.dob)} yrs · {a.sex}
                    </small>
                  </span>
                </button>
              </td>
              <td>
                <span
                  className={`visit-icon ${a.type === 'Annual physical' ? 'blue' : ''}`}
                >
                  {a.type === 'Annual physical' ? (
                    <Heart size={13} />
                  ) : (
                    <Stethoscope size={13} />
                  )}
                </span>
                {a.type}
                <AppointmentBillingAccount
                  appointment={a}
                  onChanged={onBillingChanged || (() => Promise.resolve())}
                />
              </td>
              <td>
                <Badge>{a.status}</Badge>
              </td>
              <td className="row-action">
                {a.status === 'Scheduled' ? (
                  <button
                    className="text-button"
                    onClick={() => onStatus(a, 'Checked in')}
                  >
                    Check in <ArrowUpRight size={14} />
                  </button>
                ) : a.status === 'Checked in' && clinical ? (
                  <button className="text-button" onClick={() => onStart(a)}>
                    Start visit <ArrowUpRight size={14} />
                  </button>
                ) : a.status === 'In progress' && clinical ? (
                  <button className="text-button" onClick={() => onStart(a)}>
                    Continue <ChevronRight size={15} />
                  </button>
                ) : clinical ? (
                  <button
                    className="icon-button"
                    aria-label={`Open ${fullName(a)} chart`}
                    onClick={() => onChart(a.patient_id)}
                  >
                    <ChevronRight size={17} />
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
