import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, RefreshCw, ShieldCheck } from 'lucide-react';
import { patch } from './api';
import { AllergyPicker } from './allergy-picker';
import { Badge } from './components';
import { clinicDate, clinicTimestampLabel } from './clinic-dates';
import { useResource } from './workflow-ui';
import type {
  AllergyProfile,
  AllergyRecord,
  PatientProfileView,
} from '../server/patient-profile-model';

const normalize = (value: string) => value.normalize('NFKC').trim()
  .replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
const signature = (profile: AllergyProfile) => JSON.stringify({
  status: profile.status,
  records: profile.records,
});
const entryTypes: AllergyRecord['type'][] = ['Allergy', 'Intolerance', 'Unconfirmed'];
const severities: AllergyRecord['severity'][] = ['Unknown', 'Mild', 'Moderate', 'Severe', 'Life-threatening'];
const sources: AllergyRecord['source'][] = [
  'Patient reported', 'Caregiver reported', 'Outside record',
  'Clinician documented', 'Unknown',
];
const entryStatuses: AllergyRecord['status'][] = ['Active', 'Inactive', 'Entered in error'];

function newRecord(name: string): AllergyRecord {
  const random = Array.from(crypto.getRandomValues(new Uint32Array(2)),
    (part) => part.toString(36)).join('-');
  return {
    id: `allergy-${random}`,
    name,
    type: 'Unconfirmed',
    reaction: '',
    severity: 'Unknown',
    source: 'Unknown',
    onset_date: '',
    notes: '',
    status: 'Active',
  };
}

export function PatientAllergies({ patientId, onChanged, onDirtyChange }: {
  patientId: string;
  onChanged: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const resource = useResource<PatientProfileView | null>(
    `/workflow/patient-profiles/${encodeURIComponent(patientId)}`, null,
  );
  const [storedDraft, setDraft] = useState<AllergyProfile | null>(null);
  const [loadedPatientId, setLoadedPatientId] = useState('');
  const draft = loadedPatientId === patientId ? storedDraft : null;
  const [savedSignature, setSavedSignature] = useState('');
  const [reason, setReason] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [refreshPending, setRefreshPending] = useState(false);
  const [pendingOther, setPendingOther] = useState(false);
  const saving = useRef(false);

  function adopt(profile: AllergyProfile) {
    setLoadedPatientId(patientId);
    setDraft(structuredClone(profile));
    setSavedSignature(signature(profile));
    setReason('');
    setReviewed(false);
  }
  useEffect(() => {
    if (resource.data?.patient.id === patientId && resource.data.allergy)
      adopt(resource.data.allergy);
  }, [resource.data, patientId]);

  const dirty = Boolean(draft && signature(draft) !== savedSignature) ||
    Boolean(reason.trim()) || reviewed || pendingOther;
  useEffect(() => {
    onDirtyChange?.(dirty && !refreshPending);
    return () => onDirtyChange?.(false);
  }, [dirty, refreshPending, onDirtyChange]);
  useEffect(() => {
    if (!dirty || refreshPending) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, refreshPending]);

  function editProfile(next: AllergyProfile) {
    setDraft(next);
    setReviewed(false);
    setMessage('');
    setError('');
  }
  function changeActiveNames(names: string[]) {
    if (!draft) return;
    const requested = new Set(names.map(normalize));
    const records = draft.records.map((record) => ({
      ...record,
      status: record.status === 'Active' && !requested.has(normalize(record.name))
        ? 'Inactive' as const : record.status,
    }));
    for (const name of names) {
      const sameName = (record: AllergyRecord) => normalize(record.name) === normalize(name);
      // Intake may retain an older inactive entry beside a fresh active report.
      // Keep that current active entry rather than reactivating its predecessor.
      const prior = records.find((record) => record.status === 'Active' && sameName(record)) ||
        records.find((record) => record.status === 'Inactive' && sameName(record));
      if (prior) prior.status = 'Active';
      else records.push(newRecord(name));
    }
    editProfile({
      ...draft,
      records,
      status: names.length ? 'Allergies recorded'
        : draft.status === 'No known allergies' ? 'No known allergies' : 'Not reviewed',
    });
  }
  function changeRecord(id: string, change: Partial<AllergyRecord>) {
    if (!draft) return;
    const records = draft.records.map((record) =>
      record.id === id ? { ...record, ...change } : record);
    const active = records.filter((record) => record.status === 'Active');
    if (new Set(active.map((record) => normalize(record.name))).size !== active.length) {
      setError('An active entry for this allergen already exists. Update that entry instead.');
      return;
    }
    editProfile({
      ...draft,
      records,
      status: active.length ? 'Allergies recorded'
        : draft.status === 'No known allergies' ? 'No known allergies' : 'Not reviewed',
    });
  }
  async function reload() {
    if (saving.current || refreshPending) return;
    if (dirty && !window.confirm('Discard unsaved allergy changes and load the latest saved information?')) return;
    saving.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try { await resource.reload(); }
    catch (cause) { setError((cause as Error).message); }
    finally { saving.current = false; setBusy(false); }
  }
  async function refreshChart() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      await onChanged();
      setRefreshPending(false);
      setMessage('Allergy record saved');
    } catch (cause) {
      setError(`Allergy record saved. Chart refresh failed: ${(cause as Error).message}`);
    } finally { saving.current = false; setBusy(false); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || saving.current || refreshPending) return;
    if (!reason.trim()) { setError('Enter the reason for this allergy change.'); return; }
    if (draft.status === 'No known allergies' && !reviewed) {
      setError('Confirm that you reviewed the information before recording no known allergies.');
      return;
    }
    saving.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    let committed = false;
    try {
      const saved = await patch<PatientProfileView>(
        `/workflow/patient-profiles/${encodeURIComponent(patientId)}/allergies`,
        {
          revision: draft.revision,
          reason: reason.trim(),
          status: draft.status,
          records: draft.records,
          reviewed,
        },
      );
      // Retain the new revision before a separately fallible chart refresh.
      // Retrying the refresh must never repeat a committed clinical update.
      committed = true;
      resource.setData(saved);
      if (saved.allergy) adopt(saved.allergy);
      setMessage('Allergy record saved');
      setRefreshPending(true);
      await onChanged();
      setRefreshPending(false);
    } catch (cause) {
      setError(committed
        ? `Allergy record saved. Chart refresh failed: ${(cause as Error).message}`
        : (cause as Error).message);
    } finally { saving.current = false; setBusy(false); }
  }

  const locked = busy || refreshPending;
  const activeRecords = draft?.records.filter((record) => record.status === 'Active') || [];
  const inactiveCount = (draft?.records.length || 0) - activeRecords.length;
  const visibleRecords = draft?.records.filter((record) => showInactive || record.status === 'Active') || [];
  const reviewer = (draft as (AllergyProfile & { reviewed_by_name?: string | null }) | null)
    ?.reviewed_by_name || draft?.reviewed_by;

  return (
    <section className="patient-allergies workflow-stack">
      <div className="section-heading">
        <div>
          <h3><ShieldCheck size={18} /> Allergy and intolerance record</h3>
          <p className="muted">Record what is known, preserve prior entries, and document your review.</p>
        </div>
        <button type="button" className="button secondary small" disabled={locked}
          onClick={() => void reload()}><RefreshCw size={14} /> Reload allergy information</button>
      </div>
      {resource.loading && <p role="status">Loading allergy information…</p>}
      {(resource.error || error) && <p className="form-error" role="alert">{error || resource.error}</p>}
      {message && <p className="inline-success" role="status"><Check size={16} />{message}</p>}
      {refreshPending && <div className="allergy-refresh-pending">
        <p>The update is saved. Refresh the chart before making another change.</p>
        <button type="button" className="button secondary" disabled={busy}
          onClick={() => void refreshChart()}>Retry refreshing chart</button>
      </div>}
      {!resource.loading && resource.data && !resource.data.allergy &&
        <p className="muted">Clinical access is required to view allergy details.</p>}
      {draft && <>
        <div className="allergy-profile-summary">
          <Badge>{draft.status}</Badge>
          <p>{draft.reviewed_at
            ? `Last saved review: ${clinicTimestampLabel(draft.reviewed_at)}${reviewer ? ` · ${reviewer}` : ''}`
            : 'No clinician review recorded for this information.'}</p>
          <p className="muted">A blank list is not a confirmation of no known allergies. Select that status explicitly after review.</p>
        </div>
        <form aria-label="Detailed allergy record" className="workflow-stack" onSubmit={save}>
          <fieldset disabled={locked} className="allergy-review-controls">
            <label>Allergy review status
              <select value={draft.status}
                onChange={(event) => editProfile({ ...draft, status: event.target.value as AllergyProfile['status'] })}>
                <option>Not reviewed</option>
                <option disabled={activeRecords.length > 0}>No known allergies</option>
                <option disabled={!activeRecords.length}>Allergies recorded</option>
              </select>
            </label>
            <AllergyPicker value={activeRecords.map((record) => record.name)}
              onChange={changeActiveNames} disabled={locked} onPendingChange={setPendingOther} />
            {inactiveCount > 0 && <label className="finance-check">
              <input type="checkbox" checked={showInactive}
                onChange={(event) => setShowInactive(event.target.checked)} />
              Show inactive allergy entries
            </label>}
            <div className="allergy-record-list">
              {visibleRecords.map((record) => <fieldset key={record.id}
                aria-label={record.name} className="allergy-record-card">
                <legend>{record.name}</legend>
                <div className="button-row"><Badge>{record.status}</Badge><Badge>{record.type}</Badge></div>
                <div className="form-grid allergy-record-grid">
                  <label>Allergy type
                    <select value={record.type} onChange={(event) => changeRecord(record.id, { type: event.target.value as AllergyRecord['type'] })}>
                      {entryTypes.map((type) => <option key={type}>{type}</option>)}
                    </select>
                  </label>
                  <label>Severity
                    <select value={record.severity} onChange={(event) => changeRecord(record.id, { severity: event.target.value as AllergyRecord['severity'] })}>
                      {severities.map((severity) => <option key={severity}>{severity}</option>)}
                    </select>
                  </label>
                  <label className="span-2">Reaction
                    <textarea rows={2} maxLength={500} value={record.reaction}
                      placeholder="Document the reported or observed reaction"
                      onChange={(event) => changeRecord(record.id, { reaction: event.target.value })} />
                  </label>
                  <label>Information source
                    <select value={record.source} onChange={(event) => changeRecord(record.id, { source: event.target.value as AllergyRecord['source'] })}>
                      {sources.map((source) => <option key={source}>{source}</option>)}
                    </select>
                  </label>
                  <label>Onset date
                    <input type="date" min="1900-01-01" max={clinicDate()} value={record.onset_date}
                      onChange={(event) => changeRecord(record.id, { onset_date: event.target.value })} />
                  </label>
                  <label>Entry status
                    <select value={record.status} onChange={(event) => changeRecord(record.id, { status: event.target.value as AllergyRecord['status'] })}>
                      {entryStatuses.map((status) => <option key={status}>{status}</option>)}
                    </select>
                  </label>
                  <label className="span-2">Notes
                    <textarea rows={2} maxLength={1000} value={record.notes}
                      onChange={(event) => changeRecord(record.id, { notes: event.target.value })} />
                  </label>
                </div>
              </fieldset>)}
            </div>
            {!activeRecords.length && <p className="muted">No active allergy or intolerance entries.</p>}
            <label>Allergy change reason
              <textarea rows={2} required maxLength={500} value={reason}
                onChange={(event) => { setReason(event.target.value); setMessage(''); }}
                placeholder="Explain the correction, source update, or review" />
            </label>
            <label className="finance-check">
              <input type="checkbox" checked={reviewed} required={draft.status === 'No known allergies'} disabled={draft.status === 'Not reviewed'}
                onChange={(event) => { setReviewed(event.target.checked); setMessage(''); }} />
              I reviewed this allergy information
            </label>
            <p className="form-hint">Choose No known allergies only when explicitly confirmed. Editing entries requires a fresh review to retain a reviewed status. Earlier values remain in change history.</p>
            {!refreshPending && <div className="button-row">
              <button className="button primary" disabled={busy}>Save allergy record</button>
            </div>}
          </fieldset>
        </form>
      </>}
    </section>
  );
}
