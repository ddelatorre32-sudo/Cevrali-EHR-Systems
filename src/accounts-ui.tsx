import { formatClinicDate } from "./clinic-dates";
import { useEffect, useState, type FormEvent } from "react";
import { Check, Copy, ShieldCheck, UsersRound } from "lucide-react";
import { api, isStandalonePreview, patch, post } from "./api";
import { Modal } from "./components";
import { useResource } from "./workflow-ui";
import type { User } from "./types";
import { MfaAuthentication, SecurityMfaSettings, type MfaPending } from "./access-security-ui";
import {
  profileComplete,
  type AccountView,
  type AccountMember,
  type Practice,
} from "../server/account-model";

const roleName = (role: string) =>
  role === "clinician" ? "Clinician" : "Front desk";
const formValues = (event: FormEvent<HTMLFormElement>) =>
  Object.fromEntries(new FormData(event.currentTarget));
function PreviewNote() {
  return isStandalonePreview ? (
    <p className="demo-notice">
      Offline preview: accounts and passwords exist only in this page’s memory
      and reset on reload. Use synthetic details and a demo password. Open
      invitation links in this same tab.
    </p>
  ) : null;
}
function PasswordFields() {
  return (
    <>
      <label>
        Password (12 or more characters)
        <input
          name="password"
          type="password"
          minLength={12}
          maxLength={200}
          autoComplete="new-password"
          required
        />
      </label>
      <label>
        Confirm password
        <input
          name="confirm_password"
          type="password"
          minLength={12}
          maxLength={200}
          autoComplete="new-password"
          required
        />
      </label>
    </>
  );
}
function matchingPassword(values: Record<string, FormDataEntryValue>) {
  if (values.password !== values.confirm_password)
    throw new Error("Passwords must match");
}

export function PracticeSignup({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (user: User) => void;
}) {
  const [step, setStep] = useState(1);
  const [owner, setOwner] = useState<Record<string, FormDataEntryValue>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const values = formValues(event);
    try {
      if (step === 1) {
        matchingPassword(values);
        setOwner(values);
        setStep(2);
        return;
      }
      setBusy(true);
      const user = await post<User>("/accounts/signup", {
        owner_name: owner.owner_name,
        email: owner.email,
        password: owner.password,
        clinical_access: owner.clinical_access === "on",
        practice: values,
      });
      onCreated(user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Create practice account" onClose={onClose} wide>
      <div className="modal-body">
        <div className="account-intro">
          <ShieldCheck size={22} />
          <div>
            <strong>Your practice, your workspace</strong>
            <p>
              Start with an empty patient directory. Add your practice details,
              then invite your team.
            </p>
          </div>
        </div>
        <PreviewNote />
        <p className="eyebrow">
          STEP {step} OF 2 · {step === 1 ? "ACCOUNT OWNER" : "PRACTICE DETAILS"}
        </p>
        <form key={step} onSubmit={submit} className="account-form">
          {step === 1 ? (
            <>
              <label>
                Your full name
                <input
                  name="owner_name"
                  defaultValue={String(owner.owner_name || "")}
                  autoComplete="name"
                  maxLength={160}
                  required
                />
              </label>
              <label>
                Your work email
                <input
                  name="email"
                  defaultValue={String(owner.email || "")}
                  type="email"
                  autoComplete="username"
                  maxLength={254}
                  required
                />
              </label>
              <PasswordFields />
              <label className="account-check">
                <input
                  name="clinical_access"
                  type="checkbox"
                  defaultChecked={owner.clinical_access === "on"}
                />
                I also need clinician access
              </label>
              <p className="muted">
                You will be the practice administrator. Clinician access also
                permits clinical notes, orders, and lab review.
              </p>
            </>
          ) : (
            <>
              <label>
                Practice name
                <input
                  name="name"
                  maxLength={160}
                  autoComplete="organization"
                  required
                />
              </label>
              <label>
                Specialty
                <input
                  name="specialty"
                  defaultValue="Primary care"
                  maxLength={100}
                  required
                />
              </label>
              <label>
                Practice contact email
                <input
                  name="email"
                  type="email"
                  defaultValue={String(owner.email)}
                  maxLength={254}
                  required
                />
              </label>
              <label>
                Practice phone
                <input name="phone" type="tel" maxLength={40} required />
              </label>
              <label>
                Practice address
                <textarea name="address" maxLength={500} required />
              </label>
              <p className="muted">
                Appointments use Pacific time. Insurance, billing, and external
                connections remain in demo mode.
              </p>
              <h3>Electronic fax setup</h3>
              <label>
                Preferred fax provider
                <input
                  name="fax_provider_name"
                  defaultValue="Demo fax"
                  maxLength={100}
                />
              </label>
              <label>
                Practice fax sender number
                <input
                  name="fax_from_number"
                  type="tel"
                  placeholder="+14155550123"
                  pattern="\+[1-9][0-9]{7,14}"
                />
              </label>
              <p className="muted">
                Demo fax is available immediately. Save a provider preference
                and sender number now; delivery remains simulated until a live
                integration is configured. No credentials are collected here.
              </p>
            </>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            {step === 2 && (
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setStep(1)}
              >
                Back
              </button>
            )}
            <button className="button primary" disabled={busy}>
              {busy
                ? "Creating…"
                : step === 1
                  ? "Continue to practice details"
                  : "Create practice workspace"}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

export function StaffJoin({
  token,
  onJoined,
}: {
  token: string;
  onJoined: (user: User) => void;
}) {
  const resource = useResource<{
    practice_name: string;
    email: string;
    role: string;
    is_admin: boolean;
  } | null>(`/accounts/invitations/${token}`, null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<MfaPending | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const values = formValues(event);
    try {
      matchingPassword(values);
      setBusy(true);
      const result = await post<User | MfaPending>(`/accounts/invitations/${token}/accept`, {
          name: values.name,
          password: values.password,
        });
      if ("kind" in result && result.kind === "mfa") setChallenge(result);
      else onJoined(result as User);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="join-layout">
      <section className="panel join-card">
        {challenge ? <MfaAuthentication key={challenge.challenge_token} challenge={challenge}
          onAuthenticated={onJoined} onCancel={() => { location.hash = "overview"; }} /> : <>
        <p className="eyebrow">CEVRALI · TEAM INVITATION</p>
        <h1>Join your practice</h1>
        <PreviewNote />
        {resource.loading && <p role="status">Checking invitation…</p>}
        {(resource.error || error) && (
          <p className="form-error" role="alert">
            {resource.error || error}
          </p>
        )}
        {resource.data && (
          <>
            <h2>{resource.data.practice_name}</h2>
            <p>
              {resource.data.email} · {roleName(resource.data.role)}
              {resource.data.is_admin ? " · Practice administrator" : ""}
            </p>
            <form onSubmit={submit} className="account-form">
              <label>
                Your full name
                <input
                  name="name"
                  maxLength={160}
                  autoComplete="name"
                  required
                />
              </label>
              <PasswordFields />
              <button className="button primary" disabled={busy}>
                {busy ? "Joining…" : "Accept invitation"}
              </button>
            </form>
          </>
        )}
        <a className="text-button" href="#overview">
          Return to sign in
        </a>
        </>}
      </section>
    </main>
  );
}

function MemberEditor({
  member,
  ownerId,
  currentId,
  busy,
  onSave,
}: {
  member: AccountMember;
  ownerId: string;
  currentId: string;
  busy: boolean;
  onSave: (value: AccountMember) => void;
}) {
  const [draft, setDraft] = useState(member);
  useEffect(() => setDraft(member), [member]);
  const self = member.id === currentId;
  const owner = member.id === ownerId;
  return (
    <div className="account-member">
      <div>
        <strong>
          {member.name}
          {owner ? " · Owner" : ""}
          {self ? " · You" : ""}
        </strong>
        <small>{member.email}</small>
      </div>
      <label>
        Access role
        <select
          aria-label={`Role for ${member.name}`}
          value={draft.role}
          disabled={busy || self}
          onChange={(e) =>
            setDraft({
              ...draft,
              role: e.target.value as AccountMember["role"],
            })
          }
        >
          <option value="clinician">Clinician</option>
          <option value="receptionist">Front desk</option>
        </select>
      </label>
      <label className="account-check">
        <input
          type="checkbox"
          checked={draft.is_admin}
          disabled={busy || self || owner}
          onChange={(e) => setDraft({ ...draft, is_admin: e.target.checked })}
        />
        Administrator
      </label>
      <label className="account-check">
        <input
          type="checkbox"
          checked={draft.is_active}
          disabled={busy || self || owner}
          onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })}
        />
        Active
      </label>
      <button
        className="button secondary"
        disabled={
          busy || self || JSON.stringify(draft) === JSON.stringify(member)
        }
        onClick={() => onSave(draft)}
      >
        Save access
      </button>
    </div>
  );
}

export function AccountPage({
  user,
  onUserChanged,
  section,
}: {
  user: User;
  onUserChanged: (user: User) => void;
  section?: "Practice" | "Team" | "Security";
}) {
  const resource = useResource<AccountView | null>("/account", null);
  const [tab, setTab] = useState("Practice");
  const [draft, setDraft] = useState<Practice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [link, setLink] = useState("");
  useEffect(() => {
    if (resource.data) setDraft(resource.data.practice);
  }, [resource.data]);
  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      await resource.reload();
      onUserChanged(await api<User>("/auth/me"));
      setMessage(success);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const complete =
      (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") ===
      "complete";
    void run(
      () => patch("/account/practice", { ...draft, complete_setup: complete }),
      complete ? "Practice setup complete" : "Practice details saved",
    );
  }
  function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = formValues(event);
    setLink("");
    void run(async () => {
      const result = await post<{ token: string }>("/account/invitations", {
        email: values.email,
        role: values.role,
        is_admin: values.is_admin === "on",
      });
      setLink(`${location.href.split("#")[0]}#join/${result.token}`);
      form.reset();
    }, "Invitation created. Share the link directly; no email was sent.");
  }
  function password(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = formValues(event);
    void run(async () => {
      matchingPassword(values);
      onUserChanged(
        await post<User>("/account/password", {
          current_password: values.current_password,
          password: values.password,
        }),
      );
      form.reset();
    }, "Password changed. Other sessions have been signed out.");
  }
  const data = resource.data;
  const activeTab = section || tab;
  return (
    <div className="account-page">
      {!section && <PreviewNote />}
      {resource.loading && <p role="status">Loading account…</p>}
      {(resource.error || error) && (
        <p className="form-error" role="alert">
          {error || resource.error}{" "}
          <button
            className="text-button"
            onClick={() => void resource.reload().catch(() => {})}
          >
            Reload settings
          </button>
        </p>
      )}
      {message && (
        <p className="inline-success" role="status">
          <Check size={16} />
          {message}
        </p>
      )}
      {data && draft && (
        <>
          {!section && <div className="account-summary">
            <div>
              <span className="eyebrow">
                {data.practice.setup_completed_at
                  ? "PRACTICE READY"
                  : "LET’S GET YOUR PRACTICE READY"}
              </span>
              <h2>{data.practice.name}</h2>
              <p>
                {data.patient_count} registered patient
                {data.patient_count === 1 ? "" : "s"} ·{" "}
                {data.practice.is_demo
                  ? "Synthetic demo practice"
                  : "Private practice workspace"}{" "}
                · Pacific time
              </p>
            </div>
            <ShieldCheck size={36} />
          </div>}
          {!section && data.is_admin && (
            <div className="account-checklist">
              <span>
                {profileComplete(data.practice) ? "✓" : "1"} Practice contact
                details
              </span>
              <span>✓ Owner account</span>
              <span>
                {data.members.filter((m) => m.is_active).length > 1 ? "✓" : "3"}{" "}
                Invite your team (optional)
              </span>
            </div>
          )}
          {!section && <div className="tab-bar" role="tablist" aria-label="Account settings">
            {["Practice", ...(data.is_admin ? ["Team"] : []), "Security"].map(
              (t) => (
                <button
                  role="tab"
                  aria-selected={tab === t}
                  className={tab === t ? "active" : ""}
                  key={t}
                  onClick={() => {
                    setTab(t);
                    setError("");
                    setMessage("");
                  }}
                >
                  {t}
                </button>
              ),
            )}
          </div>}
          {activeTab === "Practice" && (
            <section className="panel account-panel">
              <h2>Practice details</h2>
              <p className="muted">
                Contact details for your organization. Billing and verification
                use demo connections.
              </p>
              <form className="account-form" onSubmit={save}>
                <fieldset disabled={!data.is_admin || busy}>
                  <div className="account-field-grid">
                    {(
                      [
                        ["name", "Practice name"],
                        ["legal_name", "Legal business name"],
                        ["specialty", "Specialty"],
                        ["email", "Practice contact email"],
                        ["phone", "Practice phone"],
                        ["fax_provider_name", "Preferred fax provider"],
                        ["fax_from_number", "Practice fax sender number"],
                        ["npi", "Organization NPI (optional)"],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key}>
                        {label}
                        <input
                          name={key}
                          value={draft[key] || ""}
                          type={
                            key === "email"
                              ? "email"
                              : key === "phone"
                                ? "tel"
                                : "text"
                          }
                          maxLength={key === "npi" ? 10 : 200}
                          pattern={key === "npi" ? "[0-9]{10}" : undefined}
                          required={["name", "email", "phone"].includes(key)}
                          onChange={(e) =>
                            setDraft({ ...draft, [key]: e.target.value })
                          }
                        />
                      </label>
                    ))}
                    <label className="account-address">
                      Practice address
                      <textarea
                        name="address"
                        maxLength={500}
                        value={draft.address}
                        required
                        onChange={(e) =>
                          setDraft({ ...draft, address: e.target.value })
                        }
                      />
                    </label>
                    <p className="account-address finance-help">
                      Electronic fax connection: demo only. Provider preference
                      and sender number are saved for onboarding; no fax service
                      is connected and no transmissions occur.
                    </p>
                  </div>
                </fieldset>
                {data.is_admin ? (
                  <div className="form-actions">
                    <button className="button secondary" disabled={busy}>
                      Save practice details
                    </button>
                    {!draft.setup_completed_at && (
                      <button
                        className="button primary"
                        value="complete"
                        disabled={busy}
                      >
                        Finish practice setup
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="muted">
                    Ask your practice administrator to update these details.
                  </p>
                )}
              </form>
            </section>
          )}
          {activeTab === "Team" && data.is_admin && (
            <>
              <section className="panel account-panel">
                <h2>
                  <UsersRound size={20} /> Staff access
                </h2>
                <p className="muted">
                  Clinicians can access clinical records. Front desk staff
                  manage registration, scheduling, and revenue workflows.
                  Administrators also manage practice settings and staff. Saving
                  an access change signs that staff member out.
                </p>
                <div>
                  {data.members.map((member) => (
                    <MemberEditor
                      key={member.id}
                      member={member}
                      ownerId={draft.owner_id}
                      currentId={user.id}
                      busy={busy}
                      onSave={(value) =>
                        void run(
                          () => patch(`/account/members/${value.id}`, value),
                          "Staff access updated",
                        )
                      }
                    />
                  ))}
                </div>
                <p className="muted">
                  Your own access must be changed by another administrator. The
                  owner always retains administrator access.
                </p>
              </section>
              <section className="panel account-panel">
                <h2>Invite a team member</h2>
                <p className="muted">
                  Each email belongs to one practice. Invitation links expire
                  after 72 hours and can be used once. Share the generated link
                  directly; email delivery is in demo mode.
                </p>
                <form className="account-form" onSubmit={invite}>
                  <div className="account-field-grid">
                    <label>
                      Staff email
                      <input
                        name="email"
                        type="email"
                        maxLength={254}
                        required
                      />
                    </label>
                    <label>
                      Staff role
                      <select name="role" defaultValue="receptionist">
                        <option value="receptionist">Front desk</option>
                        <option value="clinician">Clinician</option>
                      </select>
                    </label>
                  </div>
                  <label className="account-check">
                    <input type="checkbox" name="is_admin" />
                    Also grant practice administrator access
                  </label>
                  <button className="button primary" disabled={busy}>
                    Create invitation link
                  </button>
                </form>
                {link && (
                  <div className="account-invite-link">
                    <label>
                      Invitation link
                      <input
                        aria-label="Invitation link"
                        readOnly
                        value={link}
                        onFocus={(e) => e.target.select()}
                      />
                    </label>
                    <button
                      className="button secondary"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(link);
                          setMessage("Invitation link copied");
                        } catch {
                          setMessage(
                            "Select and copy the invitation link above",
                          );
                        }
                      }}
                    >
                      <Copy size={15} />
                      Copy link
                    </button>
                    <a className="text-button" href={link}>
                      Open invitation
                    </a>
                  </div>
                )}
                {data.invitations.length > 0 && (
                  <div className="account-invitations">
                    {data.invitations.map((i) => (
                      <div className="account-invitation" key={i.id}>
                        <div>
                          <strong>{i.email}</strong>
                          <small>
                            {roleName(i.role)}
                            {i.is_admin ? " · Administrator" : ""} · {i.status}{" "}
                            · Expires {formatClinicDate(i.expires_at)}
                          </small>
                        </div>
                        {i.status === "Pending" && (
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () =>
                                  post(
                                    `/account/invitations/${i.id}/revoke`,
                                    {},
                                  ),
                                "Invitation revoked",
                              )
                            }
                          >
                            Revoke invitation
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
          {activeTab === "Team" && !data.is_admin && (
            <p className="muted">Ask your practice administrator to manage staff access.</p>
          )}
          {activeTab === "Security" && (
            <><section className="panel account-panel">
              <h2>Change your password</h2>
              <p className="muted">
                Signed in as {user.email}. Changing your password signs out your
                other sessions.
              </p>
              <form className="account-form" onSubmit={password}>
                <label>
                  Current password
                  <input
                    name="current_password"
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={200}
                  />
                </label>
                <PasswordFields />
                <button className="button primary" disabled={busy}>
                  Change password
                </button>
              </form>
            </section>
            <SecurityMfaSettings user={user} onUserChanged={onUserChanged} /></>
          )}
        </>
      )}
    </div>
  );
}
