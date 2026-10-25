import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Check, CheckCircle2, ClipboardCheck, Download, FileCheck2, ImagePlus, RefreshCw, ShieldCheck } from "lucide-react";
import { api, patch, post } from "./api";
import { Badge, Empty, Modal } from "./components";
import { clinicTimestampLabel, formatClinicDate } from "./clinic-dates";
import { US_STATES } from "../server/patient-demographics";
import type { CheckInPacketView, CheckInListItem, ConsentForm } from "../server/digital-checkin-model";
import type { User } from "./types";
import "./digital-checkin.css";

const endpoint = "/workflow/digital-checkin";
const checkInUpdatedEvent = "cevrali:checkin-updated";
const notifyCheckInUpdated = () => window.dispatchEvent(new Event(checkInUpdatedEvent));
const newClientId = () => typeof crypto.randomUUID === "function" ? crypto.randomUUID() :
  Array.from(crypto.getRandomValues(new Uint8Array(24)), value => value.toString(16).padStart(2, "0")).join("");
const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : "This request could not be completed. Please try again.";
const contactKeys = ["phone", "email", "address", "address_unit", "city", "state", "zip_code"] as const;
type Contact = Record<typeof contactKeys[number], string>;
const blankContact = (): Contact => ({ phone: "", email: "", address: "", address_unit: "", city: "", state: "", zip_code: "" });
const contactLabels: Record<keyof Contact, string> = {
  phone: "Phone number", email: "Email address", address: "Street address", address_unit: "Unit / APT number", city: "City", state: "State", zip_code: "ZIP code",
};

function useLoad<T>(path: string, poll = false) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const reload = useCallback(async (quiet = false) => {
    const request = ++sequence.current;
    if (!quiet) { setLoading(true); setError(""); }
    try {
      const value = await api<T>(path);
      if (request === sequence.current) { setData(value); setError(""); }
      return value;
    } catch (cause) {
      if (request === sequence.current) setError(messageOf(cause));
      throw cause;
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setData(null);
    void reload().catch(() => {});
    return () => { sequence.current++; };
  }, [reload]);
  useEffect(() => {
    if (!poll) return;
    const refresh = () => { if (document.visibilityState !== "hidden") void reload(true).catch(() => {}); };
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    window.addEventListener(checkInUpdatedEvent, refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener(checkInUpdatedEvent, refresh); };
  }, [poll, reload]);
  const replace = (value: T) => { sequence.current++; setData(value); setLoading(false); setError(""); };
  return { data, loading, error, reload, replace };
}

function LoadError({ error, reload }: { error: string; reload: () => Promise<unknown> }) {
  return error ? <div className="checkin-error" role="alert"><p>{error}</p>
    <button type="button" className="button secondary" onClick={() => void reload().catch(() => {})}><RefreshCw size={14} />Try again</button>
  </div> : null;
}

function ContactFields({ value, onChange, disabled }: { value: Contact; onChange: (value: Contact) => void; disabled?: boolean }) {
  return <fieldset className="checkin-contact-grid" disabled={disabled}>
    {contactKeys.map(key => <label key={key} className={key === "address" ? "checkin-span" : ""}>
      {contactLabels[key]}
      {key === "state" ? <select value={value[key]} onChange={event => onChange({ ...value, [key]: event.target.value })} autoComplete="address-level1">
        <option value="">Select state</option>{US_STATES.map(state => <option key={state.code} value={state.code}>{state.name}</option>)}
      </select> : <input value={value[key]} onChange={event => onChange({ ...value, [key]: event.target.value })}
        type={key === "email" ? "email" : key === "phone" ? "tel" : "text"}
        autoComplete={({ phone: "tel", email: "email", address: "address-line1", address_unit: "address-line2", city: "address-level2", zip_code: "postal-code" } as Record<string, string>)[key]}
        required={key === "phone"}
        maxLength={key === "address" ? 500 : key === "email" ? 254 : key === "phone" ? 40 : key === "zip_code" ? 10 : 100}
        pattern={key === "zip_code" ? "[0-9]{5}(-[0-9]{4})?" : undefined}
        title={key === "zip_code" ? "Five-digit ZIP code or ZIP+4" : undefined} />}
    </label>)}
  </fieldset>;
}

type FileMeta = { id: string; side: string; name: string; mime_type: string; size: number; sha256: string; uploaded_at: string };
type DownloadFile = FileMeta & { data_base64: string };
function fileBlob(file: DownloadFile): Blob {
  if (!["image/jpeg", "image/png"].includes(file.mime_type)) throw new Error("Unsupported insurance-card file type.");
  const raw = atob(file.data_base64);
  const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
  return new Blob([bytes], { type: file.mime_type });
}
function FileDownload({ file, path }: { file: FileMeta; path: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [preview, setPreview] = useState("");
  const mounted = useRef(true), previewUrl = useRef("");
  const closePreview = () => { if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = ""; setPreview(""); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); }; }, []);
  return <div className="checkin-file">
    <div><strong>{file.side} of card</strong><span>{file.name} · {Math.ceil(file.size / 1024)} KB</span>
      <small>Received {clinicTimestampLabel(file.uploaded_at)}</small></div>
    <div className="checkin-file-actions"><button type="button" className="button secondary" disabled={busy} aria-label={`View ${file.side.toLowerCase()} insurance card`} onClick={async () => {
      if (busy) return;
      setBusy(true); setError("");
      try {
        const saved = await api<DownloadFile>(path);
        if (!mounted.current) return;
        const url = URL.createObjectURL(fileBlob(saved));
        if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
        previewUrl.current = url; setPreview(url);
      } catch (cause) { if (mounted.current) setError(messageOf(cause)); }
      finally { if (mounted.current) setBusy(false); }
    }}><ShieldCheck size={14} />View</button>
    <button type="button" className="button secondary" disabled={busy} aria-label={`Download ${file.side.toLowerCase()} insurance card`} onClick={async () => {
      if (busy) return;
      setBusy(true); setError("");
      try {
        const saved = await api<DownloadFile>(path);
        if (!mounted.current) return;
        const url = URL.createObjectURL(fileBlob(saved));
        const link = document.createElement("a"); link.href = url;
        link.download = `${saved.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_. -]/g, "_") || "insurance-card"}.${saved.mime_type === "image/png" ? "png" : "jpg"}`;
        link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
      } catch (cause) { if (mounted.current) setError(messageOf(cause)); }
      finally { if (mounted.current) setBusy(false); }
    }}><Download size={14} />{busy ? "Preparing…" : "Download"}</button></div>
    {preview && <Modal title={`${file.side} insurance card`} subtitle={file.name} onClose={closePreview}>
      <div className="checkin-card-preview"><img src={preview} alt={`${file.side} of insurance card`} /><button type="button" className="button secondary" onClick={closePreview}>Close card preview</button></div>
    </Modal>}
    {error && <p className="checkin-error" role="alert">{error}</p>}
  </div>;
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The file could not be read. Please choose it again."));
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.readAsDataURL(file);
  });
}

function ConsentDisplay({ consent }: { consent: CheckInPacketView["consents"][number] }) {
  return <div className="checkin-consent-text"><h4>{consent.title}</h4><small>Version {consent.version}</small><p>{consent.text}</p></div>;
}

export function PatientRegistration({ token }: { token: string }) {
  const path = `/intake-links/${token}/registration`;
  const resource = useLoad<CheckInPacketView>(path);
  const [contact, setContact] = useState<Contact>(blankContact);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [noCardReason, setNoCardReason] = useState("");
  const pending = useRef(false), active = useRef(true), initialized = useRef<string | null>(null);
  const retry = useRef<Record<string, { fingerprint: string; id: string }>>({});
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (resource.data && initialized.current !== resource.data.id) {
      initialized.current = resource.data.id;
      setContact({ ...blankContact(), ...resource.data.contact });
      setNoCardReason(resource.data.no_card_reason || "");
    }
  }, [resource.data]);
  function clientId(key: string, value: unknown) {
    const fingerprint = JSON.stringify(value);
    if (retry.current[key]?.fingerprint !== fingerprint) retry.current[key] = { fingerprint, id: newClientId() };
    return retry.current[key].id;
  }
  async function mutate(suffix: string, body: Record<string, unknown>, success: string, key?: string) {
    if (pending.current || !resource.data) return false;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const input = { revision: resource.data.revision, ...body, ...(key ? { client_id: clientId(key, body) } : {}) };
      const saved = await post<CheckInPacketView>(`${path}${suffix}`, input);
      if (active.current) {
        resource.replace(saved);
        if (!suffix && saved.contact) setContact({ ...blankContact(), ...saved.contact });
        setNotice(success);
      }
      notifyCheckInUpdated();
      return true;
    } catch (cause) { if (active.current) setError(messageOf(cause)); return false; }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  const packet = resource.data;
  const locked = !packet || packet.status !== "Requested" || ["Cancelled", "Completed", "No-show"].includes(packet.appointment.status);
  const contactDirty = packet && JSON.stringify(contactKeys.map(key => contact[key])) !== JSON.stringify(contactKeys.map(key => packet.contact?.[key] || ""));
  return <section className="digital-checkin patient-registration" aria-labelledby="patient-registration-heading">
    <div className="checkin-section-heading"><div><p className="checkin-eyebrow"><ClipboardCheck size={15} />Before your visit</p>
      <h2 id="patient-registration-heading">Digital check-in</h2><p>Review your contact information, add your insurance card, and sign your registration forms.</p></div>
      {packet && <Badge>{packet.status}</Badge>}</div>
    <LoadError error={resource.error} reload={resource.reload} />
    {resource.loading && !packet && <p className="checkin-muted" role="status">Loading registration…</p>}
    {packet && <>
      <div className="checkin-progress" aria-label="Registration progress">
        <span className={packet.contact ? "done" : ""}><CheckCircle2 size={15} />Contact details</span>
        <span className={packet.files.some(file => file.side === "Front" && !file.superseded_at) || packet.no_card_reason ? "done" : ""}><ShieldCheck size={15} />Insurance card</span>
        <span className={packet.consents.every(consent => Boolean(consent.signature)) ? "done" : ""}><FileCheck2 size={15} />Consent forms</span>
      </div>
      <p className="checkin-hint">Completing these forms prepares your visit. Please check in with the front desk when you arrive.</p>
      {packet.status !== "Requested" && <p className="checkin-success" role="status"><Check size={16} />{packet.status === "Reviewed" ? "The front desk has reviewed your registration." : "Your registration has been submitted for front-desk review."}</p>}
      <form className="checkin-block" onSubmit={event => { event.preventDefault(); void mutate("", { contact }, "Contact details saved.", "contact"); }}>
        <h3>1. Contact information</h3><p className="checkin-hint">Enter your current details. The front desk will review updates before changing your chart.</p>
        <ContactFields value={contact} onChange={setContact} disabled={busy || locked} />
        {!locked && <button className="button secondary" disabled={busy || (!contactDirty && Boolean(packet.contact))}><Check size={14} />Save contact details</button>}
      </form>
      <section className="checkin-block"><h3>2. Insurance card</h3>
        <p className="checkin-hint">For this visit: <strong>{packet.billing_account?.name || "No billing account selected"}</strong>. Card uploads do not verify coverage or change the visit’s billing account.</p>
        {packet.files.map(file => <FileDownload key={file.id} file={file} path={`${path}/files/${file.id}`} />)}
        {!locked && <div className="checkin-upload-grid">{(["Front", "Back"] as const).map(side => <label className="checkin-upload" key={side}>
          <ImagePlus size={19} /><strong>{packet.files.some(file => file.side === side) ? `Replace ${side.toLowerCase()}` : `Upload ${side.toLowerCase()}`} of card</strong>
          <span>JPG or PNG · up to 2 MB</span>
          <input type="file" accept="image/jpeg,image/png" aria-label={`${side} of insurance card`} disabled={busy} onChange={async event => {
            const file = event.target.files?.[0]; event.target.value = "";
            if (!file || pending.current) return;
            if (!["image/jpeg", "image/png"].includes(file.type) || file.size > 2 * 1024 * 1024 || !file.size) {
              setError("Choose a JPG or PNG insurance-card image up to 2 MB."); return;
            }
            // Reading is part of the same single-flight action; another save cannot race it.
            pending.current = true; setBusy(true); setError("");
            try {
              const data_base64 = await readFile(file);
              pending.current = false;
              if (active.current) await mutate("/files", { side, name: file.name, mime_type: file.type, data_base64 }, `${side} of insurance card uploaded.`, `file-${side}`);
            } catch (cause) { pending.current = false; if (active.current) { setError(messageOf(cause)); setBusy(false); } }
          }} />
        </label>)}</div>}
        {!packet.files.some(file => file.side === "Front") && <label className="checkin-label">If you do not have a card, tell the front desk why
          <input value={noCardReason} onChange={event => setNoCardReason(event.target.value)} disabled={busy || locked} maxLength={500} placeholder="For example, I will bring my card to the visit" />
        </label>}
        {locked && packet.no_card_reason && <p className="checkin-hint">Card not supplied: {packet.no_card_reason}</p>}
      </section>
      <section className="checkin-block"><h3>3. Consent forms</h3>
        {packet.consents.map(consent => <ConsentSignature key={consent.id} consent={consent} disabled={busy || locked}
          onSign={body => mutate(`/consents/${consent.id}`, body, "Electronic signature saved.", `consent-${consent.id}`)} />)}
        {!packet.consents.length && <p className="checkin-hint">No electronic consent forms are required for this registration.</p>}
      </section>
      {!locked && <form className="checkin-submit" onSubmit={event => {
        event.preventDefault();
        if (contactDirty) { setError("Save your contact details before submitting registration."); return; }
        void mutate("/submit", { no_card_reason: noCardReason }, "Registration submitted. The front desk will review it.", "submit");
      }}><p className="checkin-hint">Your care team will review medical history separately in the intake form below.</p>
        <button className="button primary" disabled={busy || !packet.contact || packet.consents.some(consent => !consent.signature) || (!packet.files.some(file => file.side === "Front") && !noCardReason.trim())}>
          <ClipboardCheck size={16} />{busy ? "Saving…" : "Submit registration"}</button>
      </form>}
      {error && <div className="checkin-error" role="alert"><p>{error}</p><button type="button" className="text-button" disabled={busy} onClick={() => {
        void resource.reload().then(value => { setContact({ ...blankContact(), ...value.contact }); setError(""); }).catch(() => {});
      }}>Reload saved registration</button></div>}
      {notice && <p className="checkin-success" role="status"><Check size={15} />{notice}</p>}
    </>}
  </section>;
}

function ConsentSignature({ consent, disabled, onSign }: {
  consent: CheckInPacketView["consents"][number]; disabled: boolean;
  onSign: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [name, setName] = useState(""), [role, setRole] = useState("Patient"), [relationship, setRelationship] = useState("");
  const [agreed, setAgreed] = useState(false);
  return <article className="checkin-consent"><ConsentDisplay consent={consent} />
    {consent.signature ? <div className="checkin-signed"><CheckCircle2 size={16} /><div><strong>Signed by {consent.signature.signer_name}</strong>
      <span>{consent.signature.signer_role}{consent.signature.relationship ? ` · ${consent.signature.relationship}` : ""} · {clinicTimestampLabel(consent.signature.signed_at)}</span></div></div>
      : <form className="checkin-signature-form" onSubmit={event => {
        event.preventDefault(); void onSign({ signer_name: name, signer_role: role, relationship: role === "Representative" ? relationship : "", agree: true });
      }}><fieldset disabled={disabled}>
        <label>Full name for electronic signature<input value={name} onChange={event => setName(event.target.value)} required maxLength={200} autoComplete="name" /></label>
        <label>Signing as<select value={role} onChange={event => setRole(event.target.value)}><option>Patient</option><option>Representative</option></select></label>
        {role === "Representative" && <label>Relationship to patient<input value={relationship} onChange={event => setRelationship(event.target.value)} required maxLength={200} /></label>}
        <label className="checkin-checkbox"><input type="checkbox" required checked={agreed} onChange={event => setAgreed(event.target.checked)} />I have read this form and agree to sign it electronically using the name entered above.</label>
        <button className="button secondary" disabled={disabled || !agreed || !name.trim() || (role === "Representative" && !relationship.trim())}><FileCheck2 size={14} />Sign this form</button>
      </fieldset></form>}
  </article>;
}

export function DigitalCheckInBadge() {
  const resource = useLoad<CheckInListItem[]>(endpoint, true);
  const count = resource.data?.filter(item => item.status === "Submitted").length || 0;
  return count ? <em className="checkin-nav-badge" aria-hidden="true">{count > 99 ? "99+" : count}</em> : null;
}

export function DigitalCheckInPage({ user, patientId, onOpenPatient, onChanged }: {
  user: User; patientId?: string; onOpenPatient?: (id: string) => void; onChanged?: () => Promise<void>;
}) {
  const resource = useLoad<CheckInListItem[]>(endpoint, true);
  const [selected, setSelected] = useState<string | null>(null), [filter, setFilter] = useState("All"), [search, setSearch] = useState("");
  const rows = (resource.data || []).filter(item => !patientId || item.patient_id === patientId);
  const visible = rows.filter(item => (filter === "All" || item.status === filter) && item.patient_name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  async function changed() {
    await resource.reload();
    await onChanged?.();
  }
  return <section className="panel digital-checkin staff-checkin">
    <div className="panel-heading"><div><h2>Digital check-in</h2><p className="section-caption">Review patient contact updates, insurance cards, and signed registration forms. Create patient links from the patient queue.</p></div>
      <button className="icon-button" type="button" aria-label="Refresh digital check-in" disabled={resource.loading} onClick={() => void resource.reload().catch(() => {})}><RefreshCw size={16} /></button></div>
    <div className="checkin-stats">{(["Requested", "Submitted", "Reviewed"] as const).map(status => <button type="button" key={status} className={filter === status ? "selected" : ""} onClick={() => setFilter(filter === status ? "All" : status)}>
      <span>{status === "Requested" ? "Awaiting patient" : status === "Submitted" ? "Needs staff review" : "Reviewed"}</span><strong>{rows.filter(row => row.status === status).length}</strong>
    </button>)}</div>
    <div className="checkin-filters"><label>Registration status<select value={filter} onChange={event => setFilter(event.target.value)}><option>All</option><option>Requested</option><option>Submitted</option><option>Reviewed</option></select></label>
      <label>Find patient<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search by patient name" /></label></div>
    <LoadError error={resource.error} reload={resource.reload} />
    {resource.loading && !resource.data && <p className="checkin-muted" role="status">Loading registrations…</p>}
    {resource.data && !visible.length && <Empty title="No matching registrations" description="Use Create intake link in the patient queue to invite a patient to complete registration." />}
    <div className="checkin-queue">{visible.map(item => <article className="checkin-queue-item" key={item.id}>
      <div className="checkin-queue-person"><strong>{item.patient_name}</strong><span>{formatClinicDate(item.appointment.date)} · {item.appointment.time} Pacific</span>
        <small>{item.billing_account.name}{item.account_mismatch ? " · Visit billing account changed" : ""}</small></div>
      <div className="checkin-queue-progress"><span>{item.card_count} card image{item.card_count === 1 ? "" : "s"}</span><span>{item.signed_consent_count}/{item.consent_count} forms signed</span>
        {item.link_expired && item.status === "Requested" && <small>Patient link expired</small>}</div>
      <div className="checkin-queue-actions"><Badge>{item.status}</Badge><button type="button" className="button secondary" onClick={() => setSelected(item.id)}>{item.status === "Submitted" ? "Review registration" : "View registration"}</button></div>
    </article>)}</div>
    {!patientId && <details className="checkin-form-settings"><summary><FileCheck2 size={16} />Practice consent forms</summary>
      <ConsentForms user={user} /></details>}
    {selected && <RegistrationReview key={selected} id={selected} onClose={() => setSelected(null)} onChanged={changed}
      onOpenPatient={onOpenPatient ? id => { setSelected(null); onOpenPatient(id); } : undefined} />}
  </section>;
}

function ContactComparison({ current, proposed }: { current: Contact; proposed: Contact | null }) {
  return <div className="checkin-comparison" role="table" aria-label="Contact information comparison">
    <div className="checkin-comparison-row heading" role="row"><span role="columnheader">Contact field</span><span role="columnheader">Current chart</span><span role="columnheader">Patient submitted</span></div>
    {contactKeys.map(key => <div key={key} role="row" className={`checkin-comparison-row ${proposed && proposed[key] !== current[key] ? "changed" : ""}`}>
      <strong role="cell">{contactLabels[key]}</strong><span role="cell">{current[key] || "—"}</span><span role="cell">{proposed?.[key] || "—"}</span>
    </div>)}
  </div>;
}

function RegistrationReview({ id, onClose, onChanged, onOpenPatient }: {
  id: string; onClose: () => void; onChanged: () => Promise<void>; onOpenPatient?: (id: string) => void;
}) {
  const path = `${endpoint}/${id}`;
  const resource = useLoad<CheckInPacketView>(path);
  const [apply, setApply] = useState(false), [reason, setReason] = useState(""), [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const active = useRef(true), pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const packet = resource.data;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!packet || pending.current || packet.status !== "Submitted") return;
    pending.current = true; setBusy(true); setError("");
    let committed = false;
    try {
      const saved = await post<CheckInPacketView>(`${path}/review`, {
        revision: packet.revision, demographics_revision: packet.demographics_revision,
        apply_demographics: apply, reason, account_mismatch_acknowledged: ack,
      });
      committed = true;
      notifyCheckInUpdated();
      if (!active.current) return;
      resource.replace(saved); setNotice("Registration reviewed and saved.");
      try { await onChanged(); }
      catch { if (active.current) setError("The review was saved, but the work list could not refresh. Close this review and refresh the list."); }
    } catch (cause) { if (active.current) setError(messageOf(cause)); }
    finally { pending.current = false; if (active.current) { setBusy(false); if (committed) setApply(false); } }
  }
  return <Modal title="Registration review" subtitle={packet?.patient_name || "Patient registration"} wide onClose={() => { if (!pending.current) onClose(); }}>
    <div className="digital-checkin checkin-review-dialog"><LoadError error={resource.error} reload={resource.reload} />
      {resource.loading && !packet && <p className="checkin-muted" role="status">Loading registration…</p>}
      {packet && <>
        <div className="checkin-section-heading"><div><h3>{packet.patient_name}</h3><p>{formatClinicDate(packet.appointment.date)} at {packet.appointment.time} Pacific · {packet.appointment.status}</p></div><Badge>{packet.status}</Badge></div>
        {onOpenPatient && <button type="button" className="text-button" onClick={() => onOpenPatient(packet.patient_id)}>Open patient chart</button>}
        <section className="checkin-block"><h3>Contact updates</h3><p className="checkin-hint">Highlighted rows differ from the current chart. Blank patient fields will clear those fields if you apply all submitted details.</p>
          <ContactComparison current={{ ...blankContact(), ...packet.current_contact }} proposed={packet.contact} />
        </section>
        <section className="checkin-block"><h3>Insurance card documents</h3><p className="checkin-hint">Submitted for: <strong>{packet.billing_account.name}</strong> ({packet.billing_account.kind}). These images do not verify eligibility.</p>
          {packet.account_mismatch && <p className="checkin-warning">The visit now uses <strong>{packet.current_billing_account?.name || "a different billing account"}</strong>. The submitted card retains its original billing-account association.</p>}
          {packet.files.length ? packet.files.map(file => <div key={file.id}>{file.superseded_at && <small className="checkin-muted">Previous upload · replaced {clinicTimestampLabel(file.superseded_at)}</small>}
            <FileDownload file={file} path={`${path}/files/${file.id}`} /></div>) : <p className="checkin-hint">No insurance card supplied{packet.no_card_reason ? `: ${packet.no_card_reason}` : "."}</p>}
        </section>
        <section className="checkin-block"><h3>Consent records</h3>{packet.consents.map(consent => <details className="checkin-consent-record" key={consent.id}><summary><FileCheck2 size={15} /><span>{consent.title} · v{consent.version}</span><Badge>{consent.signature ? "Signed" : "Awaiting signature"}</Badge></summary>
          <ConsentDisplay consent={consent} />{consent.signature && <p className="checkin-hint">Signed by <strong>{consent.signature.signer_name}</strong> ({consent.signature.signer_role}{consent.signature.relationship ? `, ${consent.signature.relationship}` : ""}) on {clinicTimestampLabel(consent.signature.signed_at)}.</p>}
          <p className="checkin-digest">Document SHA-256: {consent.sha256}</p></details>)}</section>
        {packet.status === "Submitted" && <form className="checkin-block checkin-review-form" onSubmit={submit}>
          <h3>Complete front-desk review</h3><fieldset disabled={busy}>
            <label className="checkin-label">Contact update decision<select value={apply ? "apply" : "keep"} onChange={event => setApply(event.target.value === "apply")}>
              <option value="keep">Keep the current chart contact details</option><option value="apply" disabled={!packet.contact}>Apply all patient-submitted contact details</option></select></label>
            {packet.account_mismatch && <label className="checkin-checkbox"><input type="checkbox" required checked={ack} onChange={event => setAck(event.target.checked)} />I reviewed the changed visit billing account. The card remains associated with the original account shown above.</label>}
            <label className="checkin-label">Review notes<textarea value={reason} onChange={event => setReason(event.target.value)} required maxLength={500} rows={3} placeholder="Record what you reviewed and any follow-up needed" /></label>
            <p className="checkin-hint">Clinical intake, medical history, and arrival check-in are reviewed separately.</p>
            <button className="button primary" disabled={busy || !reason.trim() || (packet.account_mismatch && !ack)}><ClipboardCheck size={15} />{busy ? "Saving review…" : "Complete registration review"}</button>
          </fieldset></form>}
        {packet.status === "Reviewed" && <div className="checkin-success"><CheckCircle2 size={16} /><div><strong>Reviewed by {packet.reviewed_by_name || "practice staff"}</strong>
          <p>{packet.reviewed_at && clinicTimestampLabel(packet.reviewed_at)} · Contact updates {packet.demographics_applied ? "applied" : "kept for reference"}.</p><p>{packet.review_reason}</p></div></div>}
        {error && <div className="checkin-error" role="alert"><p>{error}</p>{packet.status !== "Reviewed" && <button type="button" className="text-button" disabled={busy} onClick={() => void resource.reload().then(() => { setError(""); setApply(false); setAck(false); }).catch(() => {})}>Reload current details</button>}</div>}
        {notice && <p className="checkin-success" role="status">{notice}</p>}
      </>}
      <div className="checkin-actions"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>Close</button></div>
    </div>
  </Modal>;
}

function ConsentForms({ user }: { user: User }) {
  const resource = useLoad<ConsentForm[]>(`${endpoint}/forms`);
  const [selectedId, setSelectedId] = useState<string | null>(null), [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(""), [text, setText] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const active = useRef(true), pending = useRef(false), retry = useRef({ fingerprint: "", id: newClientId() });
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const selected = resource.data?.find(form => form.id === selectedId);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !user.is_admin || (selectedId && !selected)) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    const input = { title, text };
    const fingerprint = JSON.stringify(input);
    if (retry.current.fingerprint !== fingerprint) retry.current = { fingerprint, id: newClientId() };
    try {
      const saved = selected
        ? await patch<ConsentForm>(`${endpoint}/forms/${selected.id}`, { revision: selected.revision, ...input })
        : await post<ConsentForm>(`${endpoint}/forms`, { ...input, client_id: retry.current.id });
      if (!active.current) return;
      resource.replace([saved, ...(resource.data || []).filter(form => form.id !== saved.id)]);
      setEditing(false); setSelectedId(null); setTitle(""); setText("");
      setNotice("Consent form saved. New patient links will use this version. Existing registration packets retain their original forms.");
    } catch (cause) { if (active.current) setError(messageOf(cause)); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  async function archive(form: ConsentForm) {
    if (pending.current || !user.is_admin) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const saved = await patch<ConsentForm>(`${endpoint}/forms/${form.id}`, { revision: form.revision, archived: !form.archived });
      if (!active.current) return;
      resource.replace((resource.data || []).map(item => item.id === saved.id ? saved : item));
      setNotice(saved.archived ? "Consent form archived for new registration links." : "Consent form restored for new registration links.");
    } catch (cause) { if (active.current) setError(messageOf(cause)); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return <div className="checkin-forms-manager"><p className="checkin-hint">Every patient link keeps a snapshot of the forms in effect when it is created. Editing a form creates a new version for future links. The included sample form should be reviewed by your practice before use.</p>
    <LoadError error={resource.error} reload={resource.reload} />
    {resource.loading && !resource.data && <p className="checkin-muted">Loading consent forms…</p>}
    <div className="checkin-form-library">{resource.data?.map(form => <article key={form.id}><div className="checkin-section-heading"><div><strong>{form.title}</strong><p>Version {form.version} · {form.archived ? "Archived" : "Included in new links"}</p></div>
      {user.is_admin && <div className="checkin-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => { setSelectedId(form.id); setTitle(form.title); setText(form.text); setEditing(true); setError(""); }}>Edit form</button>
        <button type="button" className="text-button" disabled={busy} onClick={() => void archive(form)}>{form.archived ? "Restore" : "Archive"}</button></div>}</div><details><summary>Read form text</summary><p className="checkin-form-preview">{form.text}</p></details></article>)}</div>
    {user.is_admin && !editing && <button type="button" className="button secondary" onClick={() => { setSelectedId(null); setTitle(""); setText(""); setEditing(true); setError(""); }}><FileCheck2 size={15} />Add consent form</button>}
    {editing && <form className="checkin-block checkin-consent-editor" onSubmit={save}><h3>{selectedId ? "Edit consent form" : "New consent form"}</h3><fieldset disabled={busy}>
      <label className="checkin-label">Form title<input value={title} onChange={event => setTitle(event.target.value)} required maxLength={200} /></label>
      <label className="checkin-label">Consent form text<textarea value={text} onChange={event => setText(event.target.value)} required rows={9} maxLength={20000} /></label>
      <p className="checkin-hint">Patients see the full text and explicitly sign the saved version. Include a paper alternative and the practice contact when appropriate.</p>
      <div className="checkin-actions"><button type="button" className="button secondary" onClick={() => setEditing(false)} disabled={busy}>Cancel edit</button><button className="button primary" disabled={busy || !title.trim() || !text.trim()}>{busy ? "Saving…" : "Save consent form"}</button></div>
    </fieldset></form>}
    {!user.is_admin && <p className="checkin-hint">Practice administrators can add, edit, and archive consent forms.</p>}
    {error && <div className="checkin-error" role="alert"><p>{error}</p><button type="button" className="text-button" disabled={busy} onClick={() => void resource.reload().then(() => { setEditing(false); setSelectedId(null); setError(""); }).catch(() => {})}>Reload consent forms</button></div>}{notice && <p className="checkin-success" role="status">{notice}</p>}
  </div>;
}
