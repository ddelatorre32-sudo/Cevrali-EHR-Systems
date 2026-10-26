import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Check, ClipboardCheck, KeyRound, LockKeyhole, Pill, Plus, RefreshCw, ShieldCheck, X } from "lucide-react";
import { api, patch, post } from "./api";
import { Badge, Empty, Modal, fullName } from "./components";
import { clinicTimestampLabel, formatClinicDate } from "./clinic-dates";
import type { Patient, User } from "./types";
import type {
  PrescriptionFields, PrescriptionView, PrescribingWorkspace, PrescribingSettingsView,
  RefillRequestView, PrescribingChallengeView, PrescriptionSignResult, ControlledSchedule, PrescribingReviewContext,
} from "../server/prescribing-model";
import "./prescribing.css";

const endpoint = "/workflow/prescribing";
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "This request could not be completed. Try again.";
const clientId = () => typeof crypto.randomUUID === "function" ? crypto.randomUUID() :
  Array.from(crypto.getRandomValues(new Uint8Array(24)), value => value.toString(16).padStart(2, "0")).join("");
const notify = () => window.dispatchEvent(new Event("cevrali:prescribing-updated"));

function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(Boolean(path));
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return null;
    const request = ++sequence.current;
    setLoading(true); setError("");
    try {
      const value = await api<T>(path);
      if (request === sequence.current) setData(value);
      return value;
    } catch (cause) {
      if (request === sequence.current) setError(errorText(cause));
      throw cause;
    } finally { if (request === sequence.current) setLoading(false); }
  }, [path]);
  useEffect(() => { setData(null); void reload().catch(() => {}); return () => { sequence.current++; }; }, [reload]);
  const replace = (value: T) => { sequence.current++; setData(value); setError(""); setLoading(false); };
  return { data, error, loading, reload, replace };
}

function LoadError({ error, onReload }: { error: string; onReload: () => Promise<unknown> }) {
  return error ? <div className="rx-alert" role="alert"><p>{error}</p><button type="button" className="text-button" onClick={() => void onReload().catch(() => {})}>Retry loading</button></div> : null;
}
function DemoBanner() {
  return <div className="rx-demo-banner"><ShieldCheck size={18} /><div><strong>Demo prescribing · Pharmacy disconnected</strong><p>Prescriptions stay in Cevrali. No medication is sent to a pharmacy. Live prescribing and controlled-substance authentication require a connected prescribing/EPCS service.</p></div></div>;
}
function ScheduleBadge({ schedule }: { schedule: ControlledSchedule }) {
  return <span className={`rx-badge ${schedule === "Non-controlled" ? "" : "controlled"}`}>{schedule === "Non-controlled" ? "Non-controlled" : `Schedule ${schedule}`}</span>;
}
function StatusBadge({ prescription }: { prescription: PrescriptionView }) {
  return <span className={`rx-badge ${prescription.status === "Simulated — not sent" ? "simulated" : ""}`}>{prescription.status}</span>;
}

type FormValues = Omit<PrescriptionFields, "quantity" | "days_supply" | "refills"> & { quantity: string; days_supply: string; refills: string };
const blankFields = (): FormValues => ({ medication_name: "", strength: "", dose: "", route: "", frequency: "", instructions: "",
  quantity: "", quantity_unit: "", days_supply: "", refills: "0", pharmacy: { name: "", address: "", phone: "" }, controlled_schedule: "Non-controlled" });
const fieldsOf = (prescription: PrescriptionFields): FormValues => ({
  medication_name: prescription.medication_name, strength: prescription.strength, dose: prescription.dose,
  route: prescription.route, frequency: prescription.frequency, instructions: prescription.instructions,
  quantity: String(prescription.quantity), quantity_unit: prescription.quantity_unit,
  days_supply: String(prescription.days_supply), refills: String(prescription.refills),
  pharmacy: { ...prescription.pharmacy }, controlled_schedule: prescription.controlled_schedule,
});

function PatientContext({ workspace }: { workspace: PrescribingWorkspace }) {
  const patient = workspace.patient;
  return <aside className="rx-context" aria-label="Medication safety context">
    <div className="rx-patient-heading"><Pill size={18} /><div><strong>{fullName(patient)}</strong><p>DOB {formatClinicDate(patient.dob)}</p></div></div>
    <section className="rx-context-section"><h3>Recorded allergies</h3><Badge>{patient.allergy_status}</Badge>
      {patient.allergies.length ? <ul className="rx-context-list">{patient.allergies.map((name, index) => <li key={`${name}-${index}`}>{name}</li>)}</ul>
        : <p>{patient.allergy_status === "No known allergies" ? "No known allergies recorded after review." : "No allergy names recorded. Confirm allergy status before prescribing."}</p>}
      {patient.active_allergy_records.filter(record => record.reaction || record.severity !== "Unknown").map(record => <p className={["Severe", "Life-threatening"].includes(record.severity) ? "rx-allergy-high" : ""} key={record.id}><strong>{record.name}</strong>: {record.type} · {record.severity}{record.reaction ? ` · ${record.reaction}` : ""}</p>)}</section>
    <section className="rx-context-section"><h3>Recorded medications</h3>{patient.medications.length ? <ul className="rx-context-list">{patient.medications.map((medication, index) => <li key={`${medication.name}-${index}`}><strong>{medication.name}</strong><span>{medication.dose} · {medication.frequency}</span></li>)}</ul> : <p>No medications recorded.</p>}</section>
    <p className="rx-hint">Automated drug-interaction, dosing, and PDMP checks are not connected. The prescriber must review the clinical information. Demo prescriptions do not change the recorded medication list or clinical note.</p>
  </aside>;
}

function PrescriptionForm({ workspace, prescription, billingAccountId, refillRequestId, onSaved, onCancel, onPreferredSaved }: {
  workspace: PrescribingWorkspace; prescription?: PrescriptionView; billingAccountId?: string; refillRequestId?: string;
  onSaved: (value: PrescriptionView) => void; onCancel: () => void;
  onPreferredSaved: (value: NonNullable<PrescribingWorkspace["preferred_pharmacy"]>) => void;
}) {
  const initial = useRef(prescription ? fieldsOf(prescription) : { ...blankFields(), ...(workspace.preferred_pharmacy ? { pharmacy: { ...workspace.preferred_pharmacy.pharmacy } } : {}) });
  const [fields, setFields] = useState<FormValues>(initial.current);
  const [accountId, setAccountId] = useState(prescription?.billing_account.id || billingAccountId || workspace.selected_billing_account_id);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [preferredRevision, setPreferredRevision] = useState(workspace.preferred_pharmacy?.revision || 0), [pharmacyNotice, setPharmacyNotice] = useState("");
  const active = useRef(true), pending = useRef(false), retry = useRef({ fingerprint: "", id: clientId() });
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const field = (key: keyof FormValues, value: string) => setFields(previous => ({ ...previous, [key]: value }));
  const dirty = JSON.stringify(fields) !== JSON.stringify(initial.current);
  const previousPharmacy = workspace.prescriptions.find(item => item.pharmacy.name)?.pharmacy;
  async function savePreferredPharmacy() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setPharmacyNotice("");
    try {
      const saved = await patch<NonNullable<PrescribingWorkspace["preferred_pharmacy"]>>(`${endpoint}/patients/${workspace.patient.id}/pharmacy`, { revision: preferredRevision, pharmacy: fields.pharmacy });
      if (active.current) { setPreferredRevision(saved.revision); onPreferredSaved(saved); setPharmacyNotice("Preferred pharmacy saved for future drafts. Existing prescriptions are unchanged."); notify(); }
    } catch (cause) { if (active.current) setError(errorText(cause)); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    const input: PrescriptionFields = { ...fields, quantity: Number(fields.quantity), days_supply: Number(fields.days_supply), refills: Number(fields.refills) };
    const fingerprint = JSON.stringify({ ...input, billing_account_id: accountId });
    if (retry.current.fingerprint !== fingerprint) retry.current = { fingerprint, id: clientId() };
    pending.current = true; setBusy(true); setError("");
    try {
      const saved = prescription
        ? await patch<PrescriptionView>(`${endpoint}/${prescription.id}`, { revision: prescription.revision, ...input })
        : await post<PrescriptionView>(endpoint, { ...input, patient_id: workspace.patient.id, encounter_id: workspace.encounter_id,
          billing_account_id: accountId, client_id: retry.current.id, ...(refillRequestId ? { refill_request_id: refillRequestId } : {}) });
      if (active.current) { notify(); onSaved(saved); }
    } catch (cause) { if (active.current) setError(errorText(cause)); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return <form className="rx-card rx-prescription-form" onSubmit={save} aria-label={prescription ? "Edit prescription draft" : "New prescription draft"}>
    <div className="rx-section-heading"><div><h3>{prescription ? "Edit prescription draft" : "New prescription draft"}</h3><p>Enter the prescription exactly as intended. Saving a draft does not authorize or transmit it.</p></div><button type="button" className="icon-button" aria-label="Close prescription form" disabled={busy} onClick={() => { if (!dirty || window.confirm("Discard these unsaved prescription details?")) onCancel(); }}><X size={17} /></button></div>
    <fieldset className="rx-fieldset" disabled={busy}><div className="rx-fields">
      <label className="rx-full">Visit insurance account<select aria-label="Visit insurance account" value={accountId} onChange={event => setAccountId(event.target.value)} disabled={Boolean(prescription || workspace.encounter_id)} required>
        {workspace.billing_accounts.map(account => <option key={account.id} value={account.id}>{account.name}{account.claim_number ? ` · Claim ${account.claim_number}` : ""}</option>)}</select></label>
      <label className="rx-full">Medication name<input value={fields.medication_name} onChange={event => field("medication_name", event.target.value)} required maxLength={200} autoComplete="off" /></label>
      <label>Strength<input value={fields.strength} onChange={event => field("strength", event.target.value)} required maxLength={100} /></label>
      <label>Dose<input value={fields.dose} onChange={event => field("dose", event.target.value)} required maxLength={100} /></label>
      <label>Route<input value={fields.route} onChange={event => field("route", event.target.value)} required maxLength={100} /></label>
      <label>Frequency<input value={fields.frequency} onChange={event => field("frequency", event.target.value)} required maxLength={200} /></label>
      <label className="rx-full">Directions for the patient<textarea value={fields.instructions} onChange={event => field("instructions", event.target.value)} required maxLength={3000} rows={3} /></label>
      <label>Quantity<input type="number" min="0.001" step="0.001" value={fields.quantity} onChange={event => field("quantity", event.target.value)} required /></label>
      <label>Quantity unit<input value={fields.quantity_unit} onChange={event => field("quantity_unit", event.target.value)} required maxLength={80} /></label>
      <label>Days supply<input type="number" min={1} max={365} step={1} value={fields.days_supply} onChange={event => field("days_supply", event.target.value)} required /></label>
      <label>Refills<input type="number" min={0} max={fields.controlled_schedule === "II" ? 0 : ["III", "IV"].includes(fields.controlled_schedule) ? 5 : 12} step={1} value={fields.refills} onChange={event => field("refills", event.target.value)} required /></label>
      <label className="rx-full">Controlled-substance schedule<select aria-label="Controlled-substance schedule" value={fields.controlled_schedule} onChange={event => setFields(previous => ({ ...previous, controlled_schedule: event.target.value as ControlledSchedule, ...(event.target.value === "II" ? { refills: "0" } : {}) }))}>
        <option>Non-controlled</option><option value="II">Schedule II</option><option value="III">Schedule III</option><option value="IV">Schedule IV</option><option value="V">Schedule V</option></select><small>Classification is entered by the prescriber. It is not verified against a drug database.</small></label>
      <div className="rx-full rx-section-heading"><h3>Pharmacy</h3>{previousPharmacy && <button type="button" className="text-button" onClick={() => setFields(previous => ({ ...previous, pharmacy: { ...previousPharmacy } }))}>Use previous pharmacy</button>}</div>
      <label className="rx-full">Pharmacy name<input value={fields.pharmacy.name} onChange={event => setFields(previous => ({ ...previous, pharmacy: { ...previous.pharmacy, name: event.target.value } }))} required maxLength={200} /></label>
      <label className="rx-full">Pharmacy address<input value={fields.pharmacy.address} onChange={event => setFields(previous => ({ ...previous, pharmacy: { ...previous.pharmacy, address: event.target.value } }))} required maxLength={500} /></label>
      <label className="rx-full">Pharmacy phone<input type="tel" value={fields.pharmacy.phone} onChange={event => setFields(previous => ({ ...previous, pharmacy: { ...previous.pharmacy, phone: event.target.value } }))} required maxLength={40} /></label>
      <div className="rx-full"><button className="text-button" type="button" disabled={busy || !fields.pharmacy.name.trim() || !fields.pharmacy.address.trim() || !fields.pharmacy.phone.trim()} onClick={() => void savePreferredPharmacy()}>Save as patient’s preferred pharmacy</button>{pharmacyNotice && <p className="rx-success" role="status">{pharmacyNotice}</p>}</div>
    </div></fieldset>
    {prescription?.review && <p className="rx-hint">Saving changes invalidates the previous review and demo authorization. Review the updated prescription again before signing.</p>}
    {error && <p className="rx-alert" role="alert">{error}</p>}
    <div className="rx-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => { if (!dirty || window.confirm("Discard these unsaved prescription details?")) onCancel(); }}>Cancel</button><button className="button primary" disabled={busy}><Pill size={15} />{busy ? "Saving…" : "Save prescription draft"}</button></div>
  </form>;
}

function PrescriptionSummary({ prescription }: { prescription: PrescriptionView }) {
  const items = [
    ["Medication", `${prescription.medication_name} · ${prescription.strength}`], ["Dose / route", `${prescription.dose} · ${prescription.route}`],
    ["Frequency", prescription.frequency], ["Directions", prescription.instructions],
    ["Quantity", `${prescription.quantity} ${prescription.quantity_unit}`], ["Days supply / refills", `${prescription.days_supply} days · ${prescription.refills} refills`],
    ["Pharmacy", `${prescription.pharmacy.name}\n${prescription.pharmacy.address}\n${prescription.pharmacy.phone}`],
    ["Visit account", `${prescription.billing_account.name}${prescription.billing_account.claim_number ? `\nClaim ${prescription.billing_account.claim_number}` : ""}`],
  ];
  return <dl className="rx-summary">{items.map(([label, value]) => <div className="rx-summary-item" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function PrescriptionDetail({ prescription, user, access, onClose, onSaved, onEdit }: {
  prescription: PrescriptionView; user: User; access?: PrescribingWorkspace["access"];
  onClose: () => void; onSaved: (value: PrescriptionView) => void; onEdit?: (value: PrescriptionView) => void;
}) {
  const [current, setCurrent] = useState(prescription);
  const reviewContext = useLoad<PrescribingReviewContext>(`${endpoint}/${prescription.id}/review-context`);
  const [review, setReview] = useState({ allergies_reviewed: false, medications_reviewed: false, classification_confirmed: false, pdmp_reviewed: false, safety_note: "" });
  const [challenge, setChallenge] = useState<PrescribingChallengeView | null>(null);
  const [password, setPassword] = useState(""), [code, setCode] = useState("");
  const [cancelReason, setCancelReason] = useState(""), [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const active = useRef(true), pending = useRef(false), signRetry = useRef({ fingerprint: "", id: clientId() });
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (reviewContext.data) setCurrent(reviewContext.data.prescription);
  }, [reviewContext.data]);
  const controlled = current.controlled_schedule !== "Non-controlled";
  const remember = (saved: PrescriptionView) => { setCurrent(saved); setChallenge(null); setPassword(""); setCode(""); notify(); onSaved(saved); };
  async function action(operation: () => Promise<PrescriptionView>, success: string) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try { const saved = await operation(); if (active.current) { remember(saved); setNotice(success); } }
    catch (cause) { if (active.current) setError(errorText(cause)); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  async function requestChallenge() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const saved = await post<PrescribingChallengeView>(`${endpoint}/${current.id}/challenge`, { revision: current.revision });
      if (active.current) { setChallenge(saved); setPassword(""); setCode(""); }
    } catch (cause) { if (active.current) setError(errorText(cause)); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  async function sign(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    const fingerprint = JSON.stringify({ id: current.id, revision: current.revision, challenge_id: controlled ? challenge?.challenge_id : "" });
    if (signRetry.current.fingerprint !== fingerprint) signRetry.current = { fingerprint, id: clientId() };
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await post<PrescriptionSignResult>(`${endpoint}/${current.id}/sign`, { revision: current.revision, client_id: signRetry.current.id,
        ...(controlled ? { password, code, challenge_id: challenge?.challenge_id } : {}) });
      if (!active.current) return;
      if (result.ok) { remember(result.prescription); setNotice("Demo authorization recorded. This prescription was not sent to a pharmacy."); }
      else { setError(`${result.error}${result.attempts_remaining > 0 ? ` ${result.attempts_remaining} attempts remaining.` : " Request a new demo authorization after the lockout expires."}`); if (!result.attempts_remaining) setChallenge(null); }
    } catch (cause) { if (active.current) setError(errorText(cause)); }
    finally { pending.current = false; if (active.current) { setBusy(false); setPassword(""); setCode(""); } }
  }
  async function reload() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    setReview({ allergies_reviewed: false, medications_reviewed: false, classification_confirmed: false, pdmp_reviewed: false, safety_note: "" });
    setChallenge(null); setPassword(""); setCode("");
    try {
      const saved = await reviewContext.reload();
      if (saved && active.current) { remember(saved.prescription); setNotice("Prescription reloaded. Review the current patient information before continuing."); }
    } catch (cause) { if (active.current) setError(errorText(cause)); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  const contextReady = Boolean(reviewContext.data && !reviewContext.loading && !reviewContext.error);
  const canAuthorize = contextReady && current.can_sign && (!access || (controlled ? access.can_prescribe_controlled_demo : access.can_prescribe_demo));
  return <Modal title="Prescription review" subtitle={`${current.patient_name} · ${current.author_name}`} wide onClose={() => { if (!pending.current) onClose(); }}>
    <div className="rx-workspace rx-prescription-details"><DemoBanner />
      <div className="rx-section-heading"><div><h3>{current.medication_name}</h3><p>Created {clinicTimestampLabel(current.created_at)}</p></div><div className="rx-badges"><ScheduleBadge schedule={current.controlled_schedule} /><StatusBadge prescription={current} /></div></div>
      <PrescriptionSummary prescription={current} />
      {reviewContext.loading && <p className="rx-hint" role="status">Loading current medications, allergies, and visit context…</p>}
      {reviewContext.error && <div className="rx-alert" role="alert"><p>{reviewContext.error}</p><button type="button" className="text-button" disabled={busy} onClick={() => void reload()}>Reload review context</button></div>}
      {reviewContext.data && <PatientContext workspace={reviewContext.data.workspace} />}
      {current.can_edit && onEdit && <button className="button secondary" type="button" disabled={busy} onClick={() => onEdit(current)}>Edit prescription draft</button>}
      {current.can_review && (!current.review || !current.review_current || current.status === "Draft") && <form className="rx-card rx-review" onSubmit={event => {
        event.preventDefault();
        if (!contextReady || !reviewContext.data?.context_fingerprint) return;
        void action(() => post(`${endpoint}/${current.id}/review`, { revision: current.revision, context_fingerprint: reviewContext.data!.context_fingerprint, ...review }), "Prescription review recorded. Continue to demo signing.");
      }}>
        <h3>Prescriber review</h3><p className="rx-hint">Confirm the patient and exact prescription above. Automated drug-interaction and dose checks are unavailable in this demo.</p>
        <fieldset className="rx-fieldset" disabled={busy || !contextReady || !reviewContext.data?.context_fingerprint}>
          <label className="rx-check"><input type="checkbox" checked={review.allergies_reviewed} onChange={event => setReview(value => ({ ...value, allergies_reviewed: event.target.checked }))} required />I reviewed the patient’s recorded allergies and allergy status.</label>
          <label className="rx-check"><input type="checkbox" checked={review.medications_reviewed} onChange={event => setReview(value => ({ ...value, medications_reviewed: event.target.checked }))} required />I reviewed recorded medications and considered interactions and dosing using appropriate clinical resources.</label>
          <label className="rx-check"><input type="checkbox" checked={review.classification_confirmed} onChange={event => setReview(value => ({ ...value, classification_confirmed: event.target.checked }))} required />I confirmed the medication, directions, pharmacy, quantity, refills, and controlled-substance classification.</label>
          {controlled && <label className="rx-check"><input type="checkbox" checked={review.pdmp_reviewed} onChange={event => setReview(value => ({ ...value, pdmp_reviewed: event.target.checked }))} required />For this demo, I acknowledge that applicable PDMP and controlled-prescribing requirements must be reviewed. No PDMP query is performed.</label>}
          <label>Review notes<textarea value={review.safety_note} onChange={event => setReview(value => ({ ...value, safety_note: event.target.value }))} required maxLength={1000} rows={3} /></label>
          <button className="button primary" disabled={busy || !contextReady || !reviewContext.data?.context_fingerprint}><ClipboardCheck size={15} />{busy ? "Saving…" : "Record prescription review"}</button>
        </fieldset>
      </form>}
      {current.review && <section className="rx-card"><h3>Recorded review</h3><p>{current.review.safety_note}</p><small>{clinicTimestampLabel(current.review.reviewed_at)} · {current.review_current ? "Review matches the current patient and visit context." : "Patient or visit information changed. Reload and review again before signing."}</small></section>}
      {current.status === "Ready for demo signing" && <section className="rx-card rx-auth"><h3>{controlled ? "Controlled medication · Demo authorization" : "Demo signing"}</h3>
        {!canAuthorize && <p className="rx-alert">Your account does not currently have permission to complete this demo prescription. An administrator manages demo prescriber access in Settings.</p>}
        {controlled && canAuthorize && <><p className="rx-hint">This demonstration asks for your Cevrali password and a code displayed here. It is not real two-factor authentication or EPCS enrollment.</p>
          <button className="button secondary" type="button" disabled={busy} onClick={() => void requestChallenge()}><KeyRound size={15} />{challenge ? "Replace demo authorization code" : "Request demo authorization code"}</button>
          {challenge && <div className="rx-demo-code"><strong>Demo code — not real two-factor authentication</strong><output aria-label="Demo authorization code">{challenge.demo_code}</output><span>Expires {clinicTimestampLabel(challenge.expires_at)}. Only usable for this prescription in this signed-in session.</span></div>}
        </>}
        {canAuthorize && (!controlled || challenge) && <form onSubmit={sign}><fieldset className="rx-fieldset" disabled={busy}>
          {controlled && <div className="rx-fields"><label>Your Cevrali password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="off" required maxLength={200} /></label><label>Authorization code<input value={code} onChange={event => setCode(event.target.value)} inputMode="numeric" autoComplete="off" pattern="[0-9]{6}" maxLength={6} required /></label></div>}
          <button className="button primary" disabled={busy || (controlled && (!password || code.length !== 6))}><LockKeyhole size={15} />{busy ? "Authorizing…" : "Authorize demo prescription"}</button>
        </fieldset></form>}
      </section>}
      {current.snapshot && <section className="rx-card rx-success"><Check size={18} /><div><strong>Demo authorization completed · Not sent to pharmacy</strong><p>{current.snapshot.prescriber.name} · {clinicTimestampLabel(current.snapshot.demo_authorized_at)}</p><p>{current.snapshot.authentication}. The authorized prescription snapshot is retained; changes require a new prescription.</p></div></section>}
      {current.cancellation_reason && <p className="rx-hint">Cancelled locally {current.cancelled_at && clinicTimestampLabel(current.cancelled_at)}: {current.cancellation_reason}. No pharmacy cancellation was transmitted.</p>}
      {current.author_id === user.id && current.status !== "Cancelled locally" && !cancelling && <button type="button" className="text-button" disabled={busy} onClick={() => setCancelling(true)}>Cancel this local prescription</button>}
      {cancelling && <form className="rx-card" onSubmit={event => { event.preventDefault(); void action(() => post(`${endpoint}/${current.id}/cancel`, { revision: current.revision, reason: cancelReason }), "Prescription cancelled locally. No pharmacy cancellation was sent."); setCancelling(false); }}>
        <label>Local cancellation reason<textarea value={cancelReason} onChange={event => setCancelReason(event.target.value)} required maxLength={500} rows={2} /></label><div className="rx-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setCancelling(false)}>Keep prescription</button><button className="button secondary" disabled={busy || !cancelReason.trim()}>Confirm local cancellation</button></div></form>}
      <details className="rx-history"><summary>Prescription history ({current.history.length})</summary><ol>{current.history.map(item => <li key={item.id}><strong>{item.action}</strong><span>{item.actor_name} · {clinicTimestampLabel(item.at)}</span><p>{item.detail}</p></li>)}</ol></details>
      {error && <div className="rx-alert" role="alert"><p>{error}</p><button className="text-button" type="button" disabled={busy} onClick={() => void reload()}>Reload prescription</button></div>}
      {notice && <p className="rx-success" role="status">{notice}</p>}
      <div className="rx-actions"><button className="button secondary" type="button" disabled={busy} onClick={onClose}>Close review</button></div>
    </div>
  </Modal>;
}

export function PrescribingPanel({ user, patientId, encounterId, onChanged, initialCompose = false, billingAccountId, initialPrescriptionId, initialEditPrescriptionId, refillRequestId }: {
  user: User; patientId: string; encounterId?: string; onChanged?: () => Promise<void>; initialCompose?: boolean; billingAccountId?: string;
  initialPrescriptionId?: string; initialEditPrescriptionId?: string; refillRequestId?: string;
}) {
  const path = `${endpoint}?patient_id=${encodeURIComponent(patientId)}${encounterId ? `&encounter_id=${encodeURIComponent(encounterId)}` : ""}`;
  const resource = useLoad<PrescribingWorkspace>(user.role === "clinician" ? path : null);
  const [composing, setComposing] = useState(initialCompose), [editing, setEditing] = useState<PrescriptionView | undefined>();
  const [selected, setSelected] = useState<PrescriptionView | null>(null), [notice, setNotice] = useState("");
  const opened = useRef(false);
  useEffect(() => {
    if (!opened.current && (initialPrescriptionId || initialEditPrescriptionId) && resource.data) {
      opened.current = true;
      const target = resource.data.prescriptions.find(item => item.id === (initialEditPrescriptionId || initialPrescriptionId));
      if (initialEditPrescriptionId && target?.can_edit) { setEditing(target); setComposing(true); }
      else setSelected(target || null);
    }
  }, [initialPrescriptionId, initialEditPrescriptionId, resource.data]);
  function remember(saved: PrescriptionView) {
    if (resource.data) resource.replace({ ...resource.data, prescriptions: [saved, ...resource.data.prescriptions.filter(item => item.id !== saved.id)] });
    void onChanged?.().catch(() => setNotice("The prescription was saved. Refresh the surrounding chart if it has not updated."));
  }
  if (user.role !== "clinician") return <p className="rx-hint">Clinical access is required to open patient prescribing. Use the refill-request queue for administrative requests.</p>;
  const workspace = resource.data;
  return <div className="rx-workspace"><div className="rx-section-heading"><div><h2>Medications & prescribing</h2><p>Prepare prescriptions in the patient’s chart, review the details, and record demo authorization.</p></div><button type="button" className="icon-button" aria-label="Refresh prescribing" disabled={resource.loading} onClick={() => void resource.reload().catch(() => {})}><RefreshCw size={17} /></button></div>
    <DemoBanner /><LoadError error={resource.error} onReload={resource.reload} />{resource.loading && !workspace && <p role="status">Loading medication context…</p>}
    {workspace && <div className="rx-layout"><PatientContext workspace={workspace} /><div>
      {!workspace.access.can_prescribe_demo && <p className="rx-hint">You may prepare a draft. Completing demo authorization requires a separate prescriber permission managed by a practice administrator.</p>}
      {!composing && <div className="rx-actions"><button type="button" className="button primary" onClick={() => { setEditing(undefined); setComposing(true); }}><Plus size={15} />New prescription</button></div>}
      {composing && <PrescriptionForm key={editing?.id || "new"} workspace={workspace} prescription={editing} billingAccountId={billingAccountId} refillRequestId={refillRequestId}
        onPreferredSaved={saved => resource.replace({ ...workspace, preferred_pharmacy: saved })}
        onCancel={() => { setComposing(false); setEditing(undefined); }} onSaved={saved => { remember(saved); setComposing(false); setEditing(undefined); setSelected(saved); setNotice("Prescription draft saved. Review it before demo authorization."); }} />}
      <section className="rx-queue" aria-label="Patient prescription history"><div className="rx-section-heading"><h3>Prescription history</h3><span>{workspace.prescriptions.length} recorded</span></div>
        {!workspace.prescriptions.length && <Empty title="No prescriptions recorded" description="Create a draft to review medication details and demonstrate prescribing." />}
        {workspace.prescriptions.map(item => <article key={item.id} className="rx-card" aria-label={`Prescription: ${item.medication_name}`}><div className="rx-section-heading"><div><h3>{item.medication_name} · {item.strength}</h3><p>{item.dose} · {item.route} · {item.frequency}</p></div><StatusBadge prescription={item} /></div><div className="rx-card-meta"><ScheduleBadge schedule={item.controlled_schedule} /><span>{item.pharmacy.name}</span><span>{clinicTimestampLabel(item.created_at)}</span></div><div className="rx-actions"><button type="button" className="button secondary" onClick={() => setSelected(item)}>Review prescription</button></div></article>)}
      </section>{notice && <p className="rx-success" role="status">{notice}</p>}
    </div></div>}
    {selected && <PrescriptionDetail key={selected.id} user={user} prescription={selected} access={workspace?.access} onClose={() => setSelected(null)} onSaved={remember} onEdit={saved => { setSelected(null); setEditing(saved); setComposing(true); }} />}
  </div>;
}

export function PrescriptionLauncher({ user, patientId, encounterId, billingAccountId, disabled = false }: {
  user: User; patientId: string; encounterId?: string; billingAccountId?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (user.role !== "clinician") return null;
  return <><button className="button secondary rx-prescribing-launcher" type="button" disabled={disabled} onClick={() => setOpen(true)}><Pill size={15} />Prescribe medication</button>
    {open && <Modal title="Prescribe medication" subtitle="Patient-scoped prescribing · Demo only" wide onClose={() => setOpen(false)}><div className="rx-prescription-details"><PrescribingPanel user={user} patientId={patientId} encounterId={encounterId} billingAccountId={billingAccountId} initialCompose /></div></Modal>}
  </>;
}

function RefillQueue({ user, patients, patientId, onPrepare }: { user: User; patients: Patient[]; patientId?: string; onPrepare?: (request: RefillRequestView) => void }) {
  const resource = useLoad<RefillRequestView[]>(`${endpoint}/refills`);
  const [composing, setComposing] = useState(false), [selectedPatient, setSelectedPatient] = useState(patientId || "");
  const [name, setName] = useState(""), [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<RefillRequestView | null>(null), [resolution, setResolution] = useState("Reviewed"), [resolutionNote, setResolutionNote] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const pending = useRef(false), active = useRef(true), retry = useRef({ fingerprint: "", id: clientId() });
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const remember = (saved: RefillRequestView) => { resource.replace([saved, ...(resource.data || []).filter(item => item.id !== saved.id)]); notify(); };
  async function create(event: FormEvent) {
    event.preventDefault(); if (pending.current) return;
    const input = { patient_id: patientId || selectedPatient, medication_name: name, notes };
    const fingerprint = JSON.stringify(input);
    if (retry.current.fingerprint !== fingerprint) retry.current = { fingerprint, id: clientId() };
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const saved = await post<RefillRequestView>(`${endpoint}/refills`, { ...input, client_id: retry.current.id });
      if (active.current) { remember(saved); setComposing(false); setName(""); setNotes(""); retry.current = { fingerprint: "", id: clientId() }; setNotice("Refill request recorded for clinician review. No prescription was issued."); }
    } catch (cause) { if (active.current) setError(errorText(cause)); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  async function resolve(event: FormEvent) {
    event.preventDefault(); if (pending.current || !selected) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const saved = await post<RefillRequestView>(`${endpoint}/refills/${selected.id}/resolve`, { revision: selected.revision, resolution, note: resolutionNote });
      if (active.current) { remember(saved); setSelected(null); setResolutionNote(""); setNotice("Refill request review saved. Recording a review does not issue a prescription."); }
    } catch (cause) { if (active.current) setError(errorText(cause)); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  const requests = (resource.data || []).filter(item => !patientId || item.patient_id === patientId);
  return <section className="rx-workspace"><div className="rx-section-heading"><div><h2>Refill requests</h2><p>{user.role === "clinician" ? "Review patient-reported requests. Every prescription requires its own clinical review and authorization." : "Record a patient’s request for clinician review. This view shows only requests you submitted."}</p></div><div className="rx-actions"><button type="button" className="icon-button" aria-label="Refresh refill requests" disabled={resource.loading} onClick={() => void resource.reload().catch(() => {})}><RefreshCw size={16} /></button><button type="button" className="button secondary" onClick={() => setComposing(value => !value)}><Plus size={15} />New refill request</button></div></div>
    <LoadError error={resource.error} onReload={resource.reload} />
    {composing && <form className="rx-card rx-refill-form" onSubmit={create}><fieldset className="rx-fieldset" disabled={busy}><div className="rx-fields">
      {!patientId && <label className="rx-full">Patient<select aria-label="Refill request patient" value={selectedPatient} onChange={event => setSelectedPatient(event.target.value)} required><option value="" disabled>Select a patient</option>{patients.map(patient => <option key={patient.id} value={patient.id}>{fullName(patient)}</option>)}</select></label>}
      <label className="rx-full">Requested medication name<input value={name} onChange={event => setName(event.target.value)} required maxLength={200} /></label><label className="rx-full">Patient request details<textarea value={notes} onChange={event => setNotes(event.target.value)} required maxLength={2000} rows={3} /></label>
    </div><p className="rx-hint">Enter what the patient requested. This does not renew medication or approve a controlled prescription.</p><div className="rx-actions"><button type="button" className="button secondary" onClick={() => setComposing(false)} disabled={busy}>Cancel request entry</button><button className="button primary" disabled={busy}>{busy ? "Saving…" : "Submit refill request"}</button></div></fieldset></form>}
    {resource.loading && !resource.data && <p role="status">Loading refill requests…</p>}
    <div className="rx-queue">{!requests.length && resource.data && <Empty title="No refill requests" description="New patient requests will appear here for review." />}{requests.map(item => <article className="rx-card" key={item.id} aria-label={`Refill request: ${item.medication_name}`}><div className="rx-section-heading"><div><h3>{item.medication_name}</h3><p>{item.patient_name} · Requested by {item.requested_by_name}</p></div><Badge>{item.status}</Badge></div><p>{item.notes}</p><p className="rx-card-meta">{clinicTimestampLabel(item.created_at)}</p>{item.resolution_note && <p className="rx-hint">Review: {item.resolution_note}</p>}
      {user.role === "clinician" && item.status === "Requested" && <div className="rx-actions">{onPrepare && <button type="button" className="button secondary" onClick={() => onPrepare(item)}>Prepare a new prescription</button>}<button type="button" className="button secondary" onClick={() => { setSelected(item); setResolution("Reviewed"); setResolutionNote(""); setError(""); }}>Review refill request</button></div>}</article>)}</div>
    {selected && <form className="rx-card" onSubmit={resolve} aria-label="Refill request review"><h3>Review request: {selected.medication_name}</h3><fieldset className="rx-fieldset" disabled={busy}><label>Request decision<select aria-label="Refill request decision" value={resolution} onChange={event => setResolution(event.target.value)}><option>Reviewed</option><option>Declined</option></select></label><label>Refill review notes<textarea value={resolutionNote} onChange={event => setResolutionNote(event.target.value)} required maxLength={1000} rows={3} /></label><p className="rx-hint">A reviewed request does not authorize a prescription. Use Prepare a new prescription for a separate prescription workflow.</p><div className="rx-actions"><button type="button" className="button secondary" onClick={() => setSelected(null)} disabled={busy}>Cancel review</button><button className="button primary" disabled={busy}>Save refill review</button></div></fieldset></form>}
    {error && <p className="rx-alert" role="alert">{error}</p>}{notice && <p className="rx-success" role="status">{notice}</p>}
  </section>;
}

export function PrescribingPage({ user, patients, onOpenPatient }: { user: User; patients: Patient[]; onOpenPatient?: (id: string) => void }) {
  const clinical = user.role === "clinician";
  const resource = useLoad<PrescriptionView[]>(clinical ? `${endpoint}/queue` : null);
  const [tab, setTab] = useState("prescriptions"), [query, setQuery] = useState("");
  const [patientId, setPatientId] = useState(""), [selected, setSelected] = useState<PrescriptionView | null>(null), [refill, setRefill] = useState<RefillRequestView | null>(null);
  const [editingId, setEditingId] = useState<string | undefined>();
  const needle = query.trim().toLocaleLowerCase();
  const rows = (resource.data || []).filter(item => !needle || `${item.patient_name} ${item.medication_name} ${item.status}`.toLocaleLowerCase().includes(needle));
  const remember = (saved: PrescriptionView) => resource.replace([saved, ...(resource.data || []).filter(item => item.id !== saved.id)]);
  return <section className="panel prescribing-page rx-workspace"><div className="rx-intro"><div><p className="eyebrow">MEDICATIONS, IN CONTEXT</p><h2>{clinical ? "Prescriptions & refills" : "Patient refill requests"}</h2><p>{clinical ? "Prepare and review prescriptions from the patient chart, then track the demo authorization history." : "Send patient-reported refill requests to the clinical team."}</p></div></div><DemoBanner />
    {clinical && <><div className="rx-tabs" role="tablist" aria-label="Prescribing worklists"><button type="button" role="tab" aria-selected={tab === "prescriptions"} onClick={() => setTab("prescriptions")}>Prescription queue</button><button type="button" role="tab" aria-selected={tab === "refills"} onClick={() => setTab("refills")}>Refill requests</button></div>
      {tab === "prescriptions" && <><div className="rx-toolbar"><label className="rx-search">Find prescription<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Patient, medication, or status" /></label><label>Open patient prescribing<select aria-label="Open patient prescribing" value={patientId} onChange={event => setPatientId(event.target.value)}><option value="">Choose a patient</option>{patients.map(patient => <option value={patient.id} key={patient.id}>{fullName(patient)}</option>)}</select></label><button type="button" className="icon-button" aria-label="Refresh prescription queue" onClick={() => void resource.reload().catch(() => {})}><RefreshCw size={16} /></button></div>
        <LoadError error={resource.error} onReload={resource.reload} />{resource.loading && !resource.data && <p role="status">Loading prescription queue…</p>}
        <div className="rx-queue">{resource.data && !rows.length && <Empty title="No matching prescriptions" description="Open a patient above or use Medications & prescribing inside a patient’s chart." />}{rows.map(item => <article key={item.id} className="rx-card" aria-label={`Prescription: ${item.medication_name}`}><div className="rx-section-heading"><div><h3>{item.medication_name} · {item.strength}</h3><p>{item.patient_name} · {item.author_name}</p></div><StatusBadge prescription={item} /></div><div className="rx-card-meta"><ScheduleBadge schedule={item.controlled_schedule} /><span>{item.pharmacy.name}</span><span>{clinicTimestampLabel(item.created_at)}</span></div><div className="rx-actions">{onOpenPatient && <button className="text-button" type="button" onClick={() => onOpenPatient(item.patient_id)}>Open patient chart</button>}<button className="button secondary" type="button" onClick={() => setSelected(item)}>Review prescription</button></div></article>)}</div></>}
    </>}
    {(!clinical || tab === "refills") && <RefillQueue user={user} patients={patients} onPrepare={clinical ? request => { setRefill(request); setPatientId(request.patient_id); } : undefined} />}
    {patientId && <Modal title="Patient prescribing" subtitle={fullName(patients.find(patient => patient.id === patientId) || {})} wide onClose={() => { setPatientId(""); setRefill(null); setEditingId(undefined); }}><div className="rx-prescription-details"><PrescribingPanel key={`${patientId}:${refill?.id || ""}:${editingId || ""}`} user={user} patientId={patientId} initialCompose={Boolean(refill)} initialEditPrescriptionId={editingId} refillRequestId={refill?.id} onChanged={async () => { await resource.reload(); }} /></div></Modal>}
    {selected && <PrescriptionDetail key={selected.id} user={user} prescription={selected} onClose={() => setSelected(null)} onSaved={remember} onEdit={saved => { setSelected(null); setEditingId(saved.id); setPatientId(saved.patient_id); }} />}
  </section>;
}

export function PrescribingSettings({ user }: { user: User }) {
  const resource = useLoad<PrescribingSettingsView>(`${endpoint}/settings`);
  const [draft, setDraft] = useState<PrescribingSettingsView | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const pending = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { if (resource.data) setDraft(resource.data); }, [resource.data]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft || pending.current || !user.is_admin) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const saved = await patch<PrescribingSettingsView>(`${endpoint}/settings`, { revision: draft.revision, prescribers: draft.prescribers.map(({ user_id, can_prescribe_demo, can_prescribe_controlled_demo }) => ({ user_id, can_prescribe_demo, can_prescribe_controlled_demo })) });
      if (active.current) { resource.replace(saved); setDraft(saved); setNotice("Demo prescriber permissions saved. Live pharmacy delivery and EPCS remain disconnected."); notify(); }
    } catch (cause) { if (active.current) setError(errorText(cause)); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return <section className="panel rx-workspace rx-settings"><h2>Prescribing settings</h2><DemoBanner /><p className="rx-hint">These permissions allow clinicians to demonstrate prescription review and authorization. They do not verify a professional license or DEA registration and do not enroll a provider in EPCS. Live activation will require a prescribing service and its provider verification process.</p>
    <LoadError error={resource.error} onReload={resource.reload} />{resource.loading && !draft && <p role="status">Loading prescriber permissions…</p>}
    {draft && <form onSubmit={save}><fieldset className="rx-fieldset" disabled={busy || !user.is_admin}><div className="rx-permissions">{draft.prescribers.map(person => <div key={person.user_id} className="rx-access-row"><div><strong>{person.name}</strong><p>{person.is_active ? "Active clinician" : "Inactive clinician"}</p></div>
      <label className="rx-check"><input type="checkbox" disabled={!person.is_active} checked={person.can_prescribe_demo} onChange={event => setDraft({ ...draft, prescribers: draft.prescribers.map(item => item.user_id === person.user_id ? { ...item, can_prescribe_demo: event.target.checked, can_prescribe_controlled_demo: event.target.checked && item.can_prescribe_controlled_demo } : item) })} />Ordinary prescribing demo</label>
      <label className="rx-check"><input type="checkbox" disabled={!person.is_active || !person.can_prescribe_demo} checked={person.can_prescribe_controlled_demo} onChange={event => setDraft({ ...draft, prescribers: draft.prescribers.map(item => item.user_id === person.user_id ? { ...item, can_prescribe_controlled_demo: event.target.checked } : item) })} />Controlled prescribing demo</label>
    </div>)}</div>{!draft.prescribers.length && <p className="rx-hint">Invite a clinician through Team & access to configure demo prescribing permissions.</p>}{user.is_admin && <button className="button primary" disabled={busy}><ShieldCheck size={15} />{busy ? "Saving…" : "Save demo prescriber permissions"}</button>}</fieldset></form>}
    {!user.is_admin && <p className="rx-hint">A practice administrator manages demo prescriber permissions.</p>}{error && <div className="rx-alert" role="alert"><p>{error}</p><button className="text-button" type="button" onClick={() => void resource.reload().catch(() => {})}>Reload current permissions</button></div>}{notice && <p className="rx-success" role="status">{notice}</p>}
  </section>;
}

export function PrescribingBadge() {
  const resource = useLoad<RefillRequestView[]>(`${endpoint}/refills`);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== "hidden") void resource.reload().catch(() => {}); };
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh); window.addEventListener("cevrali:prescribing-updated", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("cevrali:prescribing-updated", refresh); };
  }, [resource.reload]);
  const count = resource.data?.filter(request => request.status === "Requested").length || 0;
  return count ? <em className="rx-nav-badge" aria-hidden="true">{count > 99 ? "99+" : count}</em> : null;
}
