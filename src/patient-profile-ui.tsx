import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, History, RefreshCw } from 'lucide-react';
import { api, patch } from './api';
import { Modal, fullName, mrn } from './components';
import { clinicDate, clinicTimestampLabel, formatClinicDate } from './clinic-dates';
import { useResource } from './workflow-ui';
import { US_STATES } from '../server/patient-demographics';
import type { PatientProfileView, ProfileChange } from '../server/patient-profile-model';
import type { Patient } from './types';

type DemographicDraft = {
  first_name: string;
  last_name: string;
  dob: string;
  sex: string;
  phone: string;
  email: string;
  address: string;
  address_unit: string;
  city: string;
  state: string;
  zip_code: string;
};
type MatchingPatient = Pick<Patient, 'id' | 'first_name' | 'last_name' | 'dob' | 'phone'>;
function detailsDraft(patient: Partial<Patient>): DemographicDraft {
  return {
    first_name: patient.first_name || '', last_name: patient.last_name || '',
    dob: patient.dob || '', sex: patient.sex || 'Unknown',
    phone: patient.phone || '', email: patient.email || '',
    address: patient.address || '', address_unit: patient.address_unit || '',
    city: patient.city || '', state: patient.state || '', zip_code: patient.zip_code || '',
  };
}
const identityKey = (draft: DemographicDraft) =>
  JSON.stringify([draft.first_name, draft.last_name, draft.dob].map((value) =>
    value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')));

export function PatientDetailsEditor({ patient, onClose, onChanged }: {
  patient: Patient;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const resource = useResource<PatientProfileView | null>(
    `/workflow/patient-profiles/${patient.id}`, null,
  );
  const [draft, setDraft] = useState<DemographicDraft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [reason, setReason] = useState('');
  const [matches, setMatches] = useState<MatchingPatient[]>([]);
  const [matchedIdentity, setMatchedIdentity] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const mutation = useRef(false);
  const dirty = Boolean(draft && JSON.stringify(draft) !== baseline);
  const currentIdentity = draft ? identityKey(draft) : '';
  const currentMatches = currentIdentity === matchedIdentity ? matches : [];

  useEffect(() => {
    if (!resource.data) return;
    const next = detailsDraft(resource.data.patient);
    setDraft(next);
    setBaseline(JSON.stringify(next));
  }, [resource.data]);

  function close() {
    if (busy) return;
    if (committed || !dirty || window.confirm('Discard the unsaved patient details?')) onClose();
  }
  function change(field: keyof DemographicDraft, value: string) {
    if (!draft) return;
    setDraft({ ...draft, [field]: value });
    setError('');
  }
  async function refreshChart() {
    setRefreshError('');
    try {
      await onChanged();
      onClose();
    } catch (cause) {
      setRefreshError((cause as Error).message);
    }
  }
  async function retryRefresh() {
    if (mutation.current) return;
    mutation.current = true; setBusy(true);
    try { await refreshChart(); }
    finally { mutation.current = false; setBusy(false); }
  }
  async function reload() {
    if (busy || committed) return;
    if (dirty && !window.confirm('Discard your draft and load the latest saved patient details?')) return;
    setBusy(true); setError('');
    try {
      await resource.reload();
      setReason(''); setMatches([]); setAcknowledged(false); setMatchedIdentity('');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.current || !draft || !resource.data || committed || !dirty) return;
    mutation.current = true; setBusy(true); setError(''); setRefreshError('');
    try {
      let reviewed = false;
      if (currentIdentity !== identityKey(detailsDraft(resource.data.patient))) {
        const query = new URLSearchParams({
          first_name: draft.first_name, last_name: draft.last_name, dob: draft.dob,
        });
        const existing = (await api<MatchingPatient[]>(`/patients/matches?${query}`))
          .filter((match) => match.id !== patient.id);
        reviewed = acknowledged && matchedIdentity === currentIdentity;
        if (existing.length && !reviewed) {
          setMatches(existing); setMatchedIdentity(currentIdentity); setAcknowledged(false);
          setError('Review the matching patient records before saving these details.');
          return;
        }
      }
      const saved = await patch<PatientProfileView>(
        `/workflow/patient-profiles/${patient.id}/demographics`,
        {
          ...draft, revision: resource.data.demographics_revision,
          reason: reason.trim(), duplicate_acknowledged: reviewed,
        },
      );
      // Store the saved revision before refreshing anything outside this form.
      // A failed chart refresh must never repeat an already committed change.
      resource.setData(saved);
      setCommitted(true);
      await refreshChart();
    } catch (cause) { setError((cause as Error).message); }
    finally { mutation.current = false; setBusy(false); }
  }

  return (
    <Modal title="Edit patient details" subtitle={`${fullName(patient)} · ${mrn(patient.id)}`} onClose={close}>
      <form className="modal-body form-grid patient-profile-editor" onSubmit={save}>
        {resource.loading && <p role="status" className="span-2">Loading current patient details…</p>}
        {(resource.error || error) && <p role="alert" className="form-error span-2">{error || resource.error}</p>}
        {!committed && <div className="span-2 button-row">
          <button type="button" className="text-button" disabled={busy}
            onClick={() => void reload()}><RefreshCw size={14} /> Reload latest patient details</button>
        </div>}
        {committed && <p role="status" className="inline-success span-2"><Check size={16} />Patient details saved.</p>}
        {refreshError && <div className="span-2">
          <p role="alert" className="form-error">Patient details saved. Chart refresh failed: {refreshError}</p>
          <button type="button" className="button primary" disabled={busy}
            onClick={() => void retryRefresh()}>Retry refreshing chart</button>
        </div>}
        {draft && <>
          <fieldset disabled={busy || committed} style={{ display: 'contents' }} aria-label="Editable patient details">
            <label>First name<input name="first_name" autoComplete="given-name" required maxLength={100}
              value={draft.first_name} onChange={(e) => change('first_name', e.target.value)} /></label>
            <label>Last name<input name="last_name" autoComplete="family-name" required maxLength={100}
              value={draft.last_name} onChange={(e) => change('last_name', e.target.value)} /></label>
            <label>Date of birth<input name="dob" type="date" min="1900-01-01" max={clinicDate()} required
              value={draft.dob} onChange={(e) => change('dob', e.target.value)} /></label>
            <label>Sex<select name="sex" value={draft.sex} onChange={(e) => change('sex', e.target.value)}>
              {['Female', 'Male', 'Other', 'Unknown'].map((sex) => <option key={sex}>{sex}</option>)}
            </select></label>
            <label>Phone number<input name="phone" type="tel" autoComplete="tel" required maxLength={40}
              value={draft.phone} onChange={(e) => change('phone', e.target.value)} /></label>
            <label>Email address<input name="email" type="email" autoComplete="email" maxLength={254}
              value={draft.email} onChange={(e) => change('email', e.target.value)} /></label>
            <label className="span-2">Address<input name="address" autoComplete="address-line1" maxLength={500}
              value={draft.address} onChange={(e) => change('address', e.target.value)} /></label>
            <label>Unit / Apt number<input name="address_unit" autoComplete="address-line2" maxLength={100}
              value={draft.address_unit} onChange={(e) => change('address_unit', e.target.value)} /></label>
            <label>City<input name="city" autoComplete="address-level2" maxLength={100}
              value={draft.city} onChange={(e) => change('city', e.target.value)} /></label>
            <label>State<select name="state" autoComplete="address-level1" value={draft.state}
              onChange={(e) => change('state', e.target.value)}>
              <option value="">Select state</option>
              {US_STATES.map(({ code, name }) => <option key={code} value={code}>{name} ({code})</option>)}
            </select></label>
            <label>ZIP code<input name="zip_code" autoComplete="postal-code" inputMode="numeric" maxLength={10}
              pattern="[0-9]{5}(-[0-9]{4})?" title="Enter a five-digit ZIP code or ZIP+4"
              value={draft.zip_code} onChange={(e) => change('zip_code', e.target.value)} /></label>
            <label className="span-2">Change reason<textarea name="reason" required maxLength={500} rows={3}
              value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why are these patient details being updated?" /></label>
            {currentMatches.length > 0 && <section className="span-2 patient-profile-matches" role="region" aria-label="Matching patient records">
              <h3>Review matching patient records</h3>
              <p>The same name and birth date appear on another record. Confirm that this patient remains a separate person.</p>
              <ul>{currentMatches.map((match) => <li key={match.id}>
                <strong>{fullName(match)}</strong> · {formatClinicDate(match.dob)} · {match.phone} · {match.id}
              </li>)}</ul>
              <label className="finance-check"><input type="checkbox" checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)} />I reviewed the matching records and confirm this is a separate patient</label>
            </section>}
          </fieldset>
          <footer className="modal-footer span-2">
            <button type="button" className="button secondary" disabled={busy} onClick={close}>{committed ? 'Close' : 'Cancel'}</button>
            {!committed && <button className="button primary" disabled={busy || !dirty || !reason.trim()}>Save patient details</button>}
          </footer>
        </>}
      </form>
    </Modal>
  );
}

const fieldLabels: Record<string, string> = {
  first_name: 'First name', last_name: 'Last name', dob: 'Date of birth', sex: 'Sex',
  phone: 'Phone number', email: 'Email address', address: 'Address', address_unit: 'Unit / Apt number',
  city: 'City', state: 'State', zip_code: 'ZIP code', status: 'Review status',
  reviewed_at: 'Reviewed at', records: 'Allergy records', reaction: 'Reaction', severity: 'Severity',
  type: 'Record type', source: 'Information source', onset_date: 'Onset date', notes: 'Notes',
};
function scalarLabel(value: unknown, key = ''): string {
  if (value === null || value === undefined || value === '') return 'Not recorded';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') {
    if (key === 'reviewed_at') return clinicTimestampLabel(value);
    if (key === 'dob' || key === 'onset_date') return formatClinicDate(value);
    return value;
  }
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map((part) => scalarLabel(part)).join('; ') || 'Not recorded';
  return 'Updated';
}
function allergyRecordLabel(record: Record<string, unknown> | undefined): string {
  if (!record) return 'Not recorded';
  return ['name', 'type', 'reaction', 'severity', 'source', 'onset_date', 'notes', 'status']
    .filter((field) => record[field] !== undefined && record[field] !== '')
    .map((field) => field === 'name' ? String(record[field])
      : `${field === 'status' ? 'Record status' : fieldLabels[field] || field}: ${scalarLabel(record[field], field)}`).join(' · ');
}
function changesFor(event: ProfileChange) {
  const before = event.before || {};
  const after = event.after || {};
  const changes: { field: string; before: string; after: string }[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (['id', 'revision', 'reviewed_by'].includes(key) || JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    if (key === 'records' && (Array.isArray(before[key]) || Array.isArray(after[key]))) {
      const recordsBefore = (Array.isArray(before[key]) ? before[key] : []) as Record<string, unknown>[];
      const recordsAfter = (Array.isArray(after[key]) ? after[key] : []) as Record<string, unknown>[];
      const previous = new Map(recordsBefore.map((record) => [String(record.id), record]));
      const next = new Map(recordsAfter.map((record) => [String(record.id), record]));
      for (const id of new Set([...previous.keys(), ...next.keys()])) {
        const old = previous.get(id), current = next.get(id);
        if (JSON.stringify(old) === JSON.stringify(current)) continue;
        changes.push({ field: `Record: ${current?.name || old?.name || 'Allergy'}`,
          before: allergyRecordLabel(old), after: allergyRecordLabel(current) });
      }
    } else changes.push({ field: fieldLabels[key] || key.replaceAll('_', ' '),
      before: scalarLabel(before[key], key), after: scalarLabel(after[key], key) });
  }
  return changes;
}

export function PatientProfileHistory({ patientId, clinical }: { patientId: string; clinical: boolean }) {
  const resource = useResource<PatientProfileView | null>(`/workflow/patient-profiles/${patientId}`, null);
  const [reloading, setReloading] = useState(false);
  const history = (resource.data?.history || []).filter((entry) => clinical || entry.section === 'Demographics');
  async function reload() {
    if (reloading) return;
    setReloading(true);
    try { await resource.reload(); } catch { /* The resource renders the failure. */ }
    finally { setReloading(false); }
  }
  return <section className="panel account-panel patient-profile-history">
    <div className="section-heading">
      <h2><History size={18} />Patient profile change history</h2>
      <button className="button secondary small" disabled={resource.loading || reloading}
        onClick={() => void reload()}><RefreshCw size={14} />Refresh change history</button>
    </div>
    <p className="muted">Review saved patient-profile updates, their reasons, and the staff member who made them. Times are shown in Pacific time.</p>
    {resource.loading && <p role="status">Loading change history…</p>}
    {resource.error && <p role="alert" className="form-error">{resource.error}</p>}
    {!resource.loading && !resource.error && !history.length && <p className="muted">No patient profile changes recorded yet.</p>}
    {[...history].reverse().map((event) => <article className="patient-profile-change" key={event.id}>
      <div className="section-heading"><strong>{event.section} updated</strong><time dateTime={event.at}>{clinicTimestampLabel(event.at)}</time></div>
      <p><strong>{event.actor_name}</strong> · {event.reason}</p>
      <details>
        <summary>View changes</summary>
        <div className="patient-profile-diff">{changesFor(event).map((change) => <section key={change.field}>
          <h4>{change.field}</h4><dl><div><dt>Before</dt><dd>{change.before}</dd></div><div><dt>After</dt><dd>{change.after}</dd></div></dl>
        </section>)}</div>
      </details>
    </article>)}
  </section>;
}
