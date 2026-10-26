import { useEffect, useState, type FormEvent } from "react";
import { Building2, Check, ClipboardList, Link2, ShieldCheck, SlidersHorizontal, UsersRound } from "lucide-react";
import { patch, isStandalonePreview } from "./api";
import { AccountPage } from "./accounts-ui";
import { IntegrationsPage } from "./order-tools";
import { TemplateSettings } from "./template-settings";
import { PrescribingSettings } from "./prescribing-ui";
import { useResource } from "./workflow-ui";
import type { WorkspaceSettings } from "../server/settings-model";
import type { User } from "./types";

function PersonalSettings({ user, onSaved }: { user: User; onSaved: (settings: WorkspaceSettings) => void }) {
  const resource = useResource<WorkspaceSettings | null>("/workflow/user-settings", null);
  const [draft, setDraft] = useState<WorkspaceSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => { if (resource.data) setDraft(resource.data); }, [resource.data]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const saved = await patch<WorkspaceSettings>("/workflow/user-settings", draft);
      setDraft(saved);
      onSaved(saved);
      setMessage("Personal preferences saved");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="panel account-panel">
    <h2>Your workspace</h2>
    <p className="muted">Preferences for {user.name} in this practice. Each staff account has its own settings.</p>
    {resource.loading && <p role="status">Loading personal preferences…</p>}
    {resource.error && <p className="form-error" role="alert">{resource.error} <button className="text-button" onClick={() => void resource.reload().catch(() => {})}>Retry loading preferences</button></p>}
    {draft && <form className="account-form" onSubmit={save}>
      <fieldset disabled={busy}>
        <div className="account-field-grid">
          <label>Start page
            <select value={draft.start_page} onChange={e => { setDraft({ ...draft, start_page: e.target.value as WorkspaceSettings["start_page"] }); setMessage(""); }}>
              <option value="overview">Overview</option><option value="patients">Patients</option><option value="schedule">Schedule</option><option value="queue">Patient queue</option><option value="staff">Staff communication</option><option value="my-work">My work</option>
            </select>
          </label>
          <label>Default calendar view
            <select value={draft.calendar_view} onChange={e => { setDraft({ ...draft, calendar_view: e.target.value as WorkspaceSettings["calendar_view"] }); setMessage(""); }}>
              <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option><option value="list">List</option>
            </select>
          </label>
          <label>Display density
            <select value={draft.density} onChange={e => { setDraft({ ...draft, density: e.target.value as WorkspaceSettings["density"] }); setMessage(""); }}>
              <option value="comfortable">Comfortable</option><option value="compact">Compact tables</option>
            </select>
          </label>
          <label className="settings-checkbox"><input type="checkbox" checked={draft.reduced_motion} onChange={e => { setDraft({ ...draft, reduced_motion: e.target.checked }); setMessage(""); }} />Reduce interface motion</label>
        </div>
      </fieldset>
      <p className="form-hint">Your start page opens when signing in without a specific page link. Calendar preferences apply when opening Schedule. All scheduling uses Pacific time.</p>
      {error && <p role="alert" className="form-error">{error}</p>}
      {message && <p role="status" className="inline-success"><Check size={16} />{message}</p>}
      <div className="form-actions"><button className="button primary" disabled={busy}>Save personal preferences</button></div>
    </form>}
  </section>;
}

type Section = "personal" | "Practice" | "Team" | "Security" | "connections" | "templates" | "prescribing";
export function SettingsPage({ user, onUserChanged, onSettingsChanged }: {
  user: User;
  onUserChanged: (user: User) => void;
  onSettingsChanged: (settings: WorkspaceSettings) => void;
}) {
  const [section, setSection] = useState<Section>("personal");
  const categories: { id: Section; label: string; detail: string; icon: typeof SlidersHorizontal }[] = [
    { id: "personal", label: "Personal preferences", detail: "Your daily workspace", icon: SlidersHorizontal },
    { id: "Practice", label: "Practice details", detail: "Organization & fax preferences", icon: Building2 },
    ...(user.is_admin ? [{ id: "Team" as const, label: "Team & access", detail: "Staff roles & invitations", icon: UsersRound }] : []),
    { id: "Security", label: "Security", detail: "Your password & access", icon: ShieldCheck },
    { id: "connections", label: "Connections", detail: "Lab, pharmacy & reminders", icon: Link2 },
    ...((user.is_admin || user.role === "clinician") ? [{ id: "prescribing" as const, label: "Prescribing", detail: "Demo prescriber permissions", icon: ShieldCheck }] : []),
    ...(user.role === "clinician" ? [{ id: "templates" as const, label: "Templates & phrases", detail: "Reusable clinical documentation", icon: ClipboardList }] : []),
  ];
  const selected = categories.find(c => c.id === section) || categories[0];
  return <div className="settings-page">
    <div className="settings-intro"><div><span className="eyebrow">MAKE CEVRALI WORK FOR YOU</span><h2>One place for your practice and your preferences.</h2><p>Manage your workspace, team, and documentation tools.</p></div><span className="settings-scope">{user.is_admin ? "Practice administrator" : "Staff account"}</span></div>
    {isStandalonePreview && <p className="form-hint">Offline demo: changes last until this preview is reloaded. External services remain in demo mode.</p>}
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings categories">{categories.map(c => <button key={c.id} aria-label={c.label} className={selected.id === c.id ? "active" : ""} aria-pressed={selected.id === c.id} aria-controls="settings-content" onClick={() => setSection(c.id)}><c.icon size={19} /><span><strong>{c.label}</strong><small>{c.detail}</small></span></button>)}</nav>
      <div className="settings-content" id="settings-content" key={selected.id}>
        {selected.id === "personal" && <PersonalSettings user={user} onSaved={onSettingsChanged} />}
        {(["Practice", "Team", "Security"] as Section[]).includes(selected.id) && <AccountPage section={selected.id as "Practice" | "Team" | "Security"} user={user} onUserChanged={onUserChanged} />}
        {selected.id === "connections" && <IntegrationsPage />}
        {selected.id === "prescribing" && <PrescribingSettings user={user} />}
        {selected.id === "templates" && user.role === "clinician" && <TemplateSettings user={user} />}
      </div>
    </div>
  </div>;
}
