import { useState, type FormEvent } from "react";
import { FileDown, Plus, Trash2 } from "lucide-react";
import { api, patch, post, sessionContextVersion } from "./api";
import { Modal, Badge } from "./components";
import { useResource } from "./workflow-ui";
import {
  rfaDisplayTime,
  rfaService,
  type RfaPacket,
  type FaxJob,
} from "../server/rfa-engine";
import type { PriorAuthorization } from "../server/finance-engine";
type Packet = RfaPacket & { missing?: string[] };
type Summary = {
  id: string;
  authorization_id: string;
  status: string;
  revision: number;
  recipient: string;
  fax: string;
  claim_number: string;
  signed_at: string | null;
};
const base = "/workflow/finance";
const contactLabels = [
  ["name", "Name / company"],
  ["contact_name", "Contact name"],
  ["address", "Street address"],
  ["city", "City"],
  ["state", "State"],
  ["zip", "ZIP code"],
  ["phone", "Phone"],
  ["fax", "Fax number"],
  ["email", "Email"],
] as const;
function RfaEditor({
  initial,
  onClose,
  onChanged,
}: {
  initial: Packet;
  onClose: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const [p, setP] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [typedName, setTypedName] = useState("");
  const [attest, setAttest] = useState(false);
  const locked = p.status === "Provider signed";
  async function load() {
    const value = await api<Packet>(`${base}/rfa/${p.id}`);
    setP(value);
    return value;
  }
  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      await onChanged();
      setMessage(success);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    await patch(`${base}/rfa/${p.id}`, p);
    return load();
  }
  function change(key: keyof RfaPacket, value: unknown) {
    setP({ ...p, [key]: value });
    setAttest(false);
    setMessage("");
  }
  return (
    <Modal
      title="California DWC request for authorization"
      subtitle={`Claim ${p.account.workers_comp?.claim_number} · ${p.patient.last_name}, ${p.patient.first_name}`}
      onClose={onClose}
      wide
    >
      <div className="modal-body rfa-editor">
        <div className="finance-notice">
          <div>
            <strong>Exact uploaded DWC Form RFA · 01/2014</strong>
            <p>
              Patient, claim and signed-note details are prefilled. Review each
              requested service, diagnosis, code, quantity and recipient. The
              PDF includes continuation pages and the supporting signed
              narrative. Fax delivery remains a demo.
            </p>
          </div>
        </div>
        <div className="rfa-source">
          <Badge>{p.status}</Badge>
          <span>
            Supporting note signed {rfaDisplayTime(p.note.signed_at)} ·{" "}
            {p.physician.name}
          </span>
          <p>
            Claim: {p.account.workers_comp?.claim_number} · Injury{" "}
            {p.account.workers_comp?.date_of_injury} · Employer{" "}
            {p.account.workers_comp?.employer}
          </p>
          <p>
            Accepted parts:{" "}
            {p.account.workers_comp?.accepted_body_parts.join(" · ")}
          </p>
        </div>
        {(error || message) && (
          <p
            className={error ? "form-error" : "inline-success"}
            role={error ? "alert" : "status"}
          >
            {error || message}
          </p>
        )}
        {!!p.missing?.length && !locked && (
          <details className="rfa-missing">
            <summary>
              {p.missing.length} fields need review before signing
            </summary>
            <ul>
              {p.missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </details>
        )}
        <fieldset disabled={locked || busy}>
          <legend>Requesting physician</legend>
          <div className="form-grid">
            {contactLabels.map(([key, label]) => (
              <label key={key}>
                {`Physician ${label}`}
                <input
                  aria-label={`Physician ${label}`}
                  value={p.physician[key]}
                  readOnly={key === "name"}
                  type={key === "email" ? "email" : "text"}
                  maxLength={500}
                  onChange={(e) =>
                    change("physician", {
                      ...p.physician,
                      [key]: e.target.value,
                    })
                  }
                />
              </label>
            ))}
            {(
              [
                ["practice_name", "Practice name"],
                ["specialty", "Specialty"],
                ["npi", "Treating physician NPI"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  value={p.physician[key]}
                  maxLength={key === "npi" ? 10 : 500}
                  aria-label={label}
                  onChange={(e) =>
                    change("physician", {
                      ...p.physician,
                      [key]: e.target.value,
                    })
                  }
                />
                {key === "npi" && (
                  <small>
                    Enter the treating physician’s NPI. The organization NPI is
                    not copied here.
                  </small>
                )}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset disabled={locked || busy}>
          <legend>Claims administrator recipient</legend>
          <p className="finance-help">
            Verify the designated utilization-review recipient and fax number
            for this claim. Use a country code, for example +14155550123.
          </p>
          <div className="form-grid">
            {contactLabels.map(([key, label]) => (
              <label key={key}>
                {`Administrator ${label}`}
                <input
                  aria-label={`Administrator ${label}`}
                  value={p.recipient[key]}
                  type={key === "email" ? "email" : "text"}
                  maxLength={500}
                  onChange={(e) =>
                    change("recipient", {
                      ...p.recipient,
                      [key]: e.target.value,
                    })
                  }
                />
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset disabled={locked || busy}>
          <legend>Requested treatments</legend>
          <p className="finance-help">
            Office visits, acupuncture, radiology, and other services can be
            requested. Codes and clinical necessity are reviewed by the
            provider; they are not inferred from free text. More than five rows
            and long descriptions continue on extra pages.
          </p>
          {p.services.map((s, i) => (
            <div className="rfa-service" key={i}>
              <h4>Requested service {i + 1}</h4>
              <div className="form-grid">
                <label>
                  Service category
                  <select
                    aria-label={`Service category ${i + 1}`}
                    value={s.category}
                    onChange={(e) =>
                      change(
                        "services",
                        p.services.map((v, n) =>
                          n === i ? { ...v, category: e.target.value } : v,
                        ),
                      )
                    }
                  >
                    {[
                      "Office visit",
                      "Acupuncture",
                      "Radiology",
                      "Therapy",
                      "Other",
                    ].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                {(
                  [
                    ["diagnosis", "Diagnosis"],
                    ["icd_code", "ICD-10-CM code"],
                    ["service", "Specific service requested"],
                    ["cpt_code", "CPT / HCPCS code (if known)"],
                    ["frequency", "Frequency"],
                    ["duration", "Duration"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <textarea
                      rows={key === "service" || key === "diagnosis" ? 2 : 1}
                      aria-label={`${label} ${i + 1}`}
                      value={s[key]}
                      maxLength={
                        key === "diagnosis"
                          ? 5000
                          : key === "service"
                            ? 2000
                            : key === "cpt_code"
                              ? 5
                              : key === "icd_code"
                                ? 16
                                : 500
                      }
                      onChange={(e) =>
                        change(
                          "services",
                          p.services.map((v, n) =>
                            n === i ? { ...v, [key]: e.target.value } : v,
                          ),
                        )
                      }
                    />
                  </label>
                ))}
                <label>
                  Quantity
                  <input
                    type="number"
                    aria-label={`Quantity ${i + 1}`}
                    min={1}
                    max={1000}
                    value={s.quantity}
                    onChange={(e) =>
                      change(
                        "services",
                        p.services.map((v, n) =>
                          n === i
                            ? { ...v, quantity: Number(e.target.value) }
                            : v,
                        ),
                      )
                    }
                  />
                </label>
              </div>
              {!locked && p.services.length > 1 && (
                <button
                  className="text-button"
                  onClick={() =>
                    change(
                      "services",
                      p.services.filter((_, n) => n !== i),
                    )
                  }
                >
                  <Trash2 size={14} />
                  Remove requested service {i + 1}
                </button>
              )}
            </div>
          ))}
          {!locked && (
            <button
              className="button secondary"
              disabled={p.services.length >= 30}
              onClick={() =>
                change("services", [...p.services, rfaService.parse({})])
              }
            >
              <Plus size={15} />
              Add requested treatment
            </button>
          )}
        </fieldset>
        <fieldset disabled={locked || busy}>
          <legend>Supporting clinical rationale and request type</legend>
          <label>
            Medical necessity / clinical rationale
            <textarea
              value={p.clinical_rationale}
              maxLength={10000}
              rows={4}
              onChange={(e) => change("clinical_rationale", e.target.value)}
            />
          </label>
          <label>
            RFA request type
            <select
              value={p.request_type}
              onChange={(e) => change("request_type", e.target.value)}
            >
              <option>New request</option>
              <option>Resubmission</option>
            </select>
          </label>
          {p.request_type === "Resubmission" && (
            <label>
              Change in material facts
              <textarea
                value={p.material_change}
                rows={3}
                maxLength={5000}
                onChange={(e) => change("material_change", e.target.value)}
              />
            </label>
          )}
          <label className="finance-check">
            <input
              type="checkbox"
              checked={p.expedited}
              onChange={(e) => change("expedited", e.target.checked)}
            />
            Request expedited review for imminent serious threat to health
          </label>
          {p.expedited && (
            <label>
              Clinical support for expedited review
              <textarea
                value={p.expedited_reason}
                maxLength={5000}
                rows={3}
                onChange={(e) => change("expedited_reason", e.target.value)}
              />
            </label>
          )}
          <label className="finance-check">
            <input
              type="checkbox"
              checked={p.oral_confirmation}
              onChange={(e) => change("oral_confirmation", e.target.checked)}
            />
            Written confirmation of a prior oral request
          </label>
          {p.oral_confirmation && (
            <label>
              Prior oral-request details
              <textarea
                value={p.oral_request_details}
                maxLength={5000}
                rows={3}
                onChange={(e) => change("oral_request_details", e.target.value)}
              />
            </label>
          )}
        </fieldset>
        <details>
          <summary>Supporting signed clinical narrative</summary>
          {(["subjective", "objective", "assessment", "plan"] as const).map(
            (k) => (
              <div key={k}>
                <h4>{k[0].toUpperCase() + k.slice(1)}</h4>
                <p className="rfa-narrative">{p.note[k] || "Not documented"}</p>
              </div>
            ),
          )}
        </details>
        {!locked ? (
          <div className="rfa-attestation">
            <label>
              Physician signature name
              <input
                aria-label="Physician signature name"
                value={typedName}
                placeholder={p.physician.name}
                onChange={(e) => setTypedName(e.target.value)}
              />
            </label>
            <label className="finance-check">
              <input
                type="checkbox"
                checked={attest}
                onChange={(e) => setAttest(e.target.checked)}
              />
              I reviewed the treatment request, supporting documentation and
              designated claims administrator recipient, and I electronically
              sign this RFA.
            </label>
            <p className="finance-help">
              This records a typed electronic attestation for this RFA. Signing
              the clinical note alone does not sign the RFA. No
              certificate-based digital signature is applied.
            </p>
          </div>
        ) : (
          <p className="inline-success">
            RFA electronically attested by {p.signed_by} at{" "}
            {rfaDisplayTime(p.signed_at)}. The reviewed packet is locked.
          </p>
        )}
        <div className="button-row">
          {!locked && (
            <>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void run(save, "RFA draft saved")}
              >
                Save RFA draft
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await post(`${base}/rfa/${p.id}/refresh`, {
                      revision: p.revision,
                    });
                    await load();
                    setAttest(false);
                  }, "Source details refreshed; review before signing")
                }
              >
                Refresh source details
              </button>
              <button
                className="button primary"
                disabled={busy || !attest || !typedName}
                onClick={() =>
                  void run(async () => {
                    const saved = await save();
                    await post(`${base}/rfa/${p.id}/sign`, {
                      revision: saved.revision,
                      typed_name: typedName,
                      attestation: attest,
                    });
                    await load();
                  }, "Provider signed RFA. It has not been faxed.")
                }
              >
                Review and sign RFA
              </button>
            </>
          )}
          <button
            className="button secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const version = sessionContextVersion();
                const doc = locked ? p : await save();
                const { downloadRfa } = await import("./rfa-download");
                await downloadRfa(doc, version);
              }, "RFA PDF and supporting narrative downloaded. Nothing was faxed.")
            }
          >
            <FileDown size={15} />
            {locked ? "Download reviewed RFA PDF" : "Download draft RFA PDF"}
          </button>
          <button className="button secondary" onClick={onClose}>
            Close RFA
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function RfaTools({
  authorization,
  clinical,
  onChanged,
}: {
  authorization: PriorAuthorization;
  clinical: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const packets = useResource<Summary[]>(
    `${base}/rfa?patient_id=${authorization.patient_id}&authorization_id=${authorization.id}`,
    [],
  );
  const faxes = useResource<FaxJob[]>(
    `${base}/faxes?authorization_id=${authorization.id}`,
    [],
  );
  const [editing, setEditing] = useState<Packet | null>(null);
  const [cancelling, setCancelling] = useState<FaxJob | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const p = packets.data
    .filter((p) => p.authorization_id === authorization.id)
    .at(-1);
  const job = faxes.data.filter((j) => j.rfa_id === p?.id).at(-1);
  async function refresh() {
    await packets.reload();
    await faxes.reload();
    await onChanged();
  }
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function cancel(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!cancelling) return;
    const reason = new FormData(e.currentTarget).get("reason");
    void run(async () => {
      await post(`${base}/faxes/${cancelling.id}/cancel`, {
        reason,
        current_status: cancelling.status,
        updated_at: cancelling.updated_at,
      });
      setCancelling(null);
    });
  }
  return (
    <section className="rfa-tools">
      <h4>DWC RFA & electronic fax</h4>
      <p className="finance-help">
        {p
          ? `Claim ${p.claim_number} · ${p.status}`
          : "A linked supporting note must be signed before the form autofills."}{" "}
        · Demo fax only; no transmission.
      </p>
      {(error || packets.error || faxes.error) && (
        <p className="form-error" role="alert">
          {error || packets.error || faxes.error}
        </p>
      )}
      {clinical && (
        <div className="button-row">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const draft = p
                  ? { id: p.id }
                  : await post<Packet>(`${base}/rfa`, {
                      authorization_id: authorization.id,
                    });
                setEditing(await api<Packet>(`${base}/rfa/${draft.id}`));
              })
            }
          >
            {p ? "Review RFA packet" : "Prepare RFA from signed note"}
          </button>
          {p?.status === "Provider signed" &&
            authorization.status === "Draft" && (
              <button
                className="text-button"
                onClick={() =>
                  void run(async () => {
                    const draft = await post<Packet>(`${base}/rfa`, {
                      authorization_id: authorization.id,
                    });
                    setEditing(await api<Packet>(`${base}/rfa/${draft.id}`));
                  })
                }
              >
                Create new RFA version
              </button>
            )}
        </div>
      )}
      {p?.status === "Provider signed" && (
        <>
          <p className="finance-help">
            Reviewed recipient: {p.recipient} · {p.fax}
          </p>
          {!job && authorization.status === "Draft" && (
            <>
              <label className="finance-check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                I verified this claims administrator and fax number for the
                claim
              </label>
              <button
                className="button primary"
                disabled={busy || !confirmed}
                onClick={() =>
                  void run(() =>
                    post(`${base}/rfa/${p.id}/queue-fax`, {
                      revision: p.revision,
                      recipient_confirmed: confirmed,
                    }),
                  )
                }
              >
                Queue demo fax
              </button>
            </>
          )}
        </>
      )}
      {faxes.data.map((job) => (
        <div className="rfa-fax-job" key={job.id}>
          <strong>{job.status}</strong>
          {job.rfa_id !== p?.id && (
            <p className="finance-help">Earlier RFA version</p>
          )}
          <p>
            To {job.recipient} · {job.fax} · Attempt {job.attempts}
          </p>
          <p className="finance-help">
            A simulated delivery is not an actual fax or an authorization
            approval.
          </p>
          <div className="button-row">
            {job.status === "Demo queued" && (
              <>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      post(`${base}/faxes/${job.id}/simulate-result`, {
                        result: "Delivered",
                      }),
                    )
                  }
                >
                  Simulate fax delivery
                </button>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      post(`${base}/faxes/${job.id}/simulate-result`, {
                        result: "Failed",
                      }),
                    )
                  }
                >
                  Simulate fax failure
                </button>
              </>
            )}
            {job.status === "Demo failed" && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void run(() => post(`${base}/faxes/${job.id}/retry`, {}))
                }
              >
                Retry demo fax
              </button>
            )}
            {(job.status === "Demo queued" || job.status === "Demo failed") && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setError("");
                  setCancelling(job);
                }}
              >
                Cancel demo fax attempt
              </button>
            )}
          </div>
          {job.status === "Demo cancelled" && (
            <p className="finance-help">
              This attempt is closed. A physician can prepare and sign a new RFA
              version before a new fax is queued.
            </p>
          )}
          <details>
            <summary>Fax attempt history</summary>
            {job.history.map((h, i) => (
              <p key={i}>
                {h.status} · {rfaDisplayTime(h.at)} · {h.actor} · {h.detail}
              </p>
            ))}
          </details>
        </div>
      ))}
      {cancelling && (
        <Modal
          title="Cancel demo fax attempt"
          onClose={() => !busy && setCancelling(null)}
        >
          <form onSubmit={cancel}>
            <div className="modal-body form-stack">
              <p>
                Cancel this {cancelling.status.toLowerCase()} attempt to release
                its queue position. The original RFA and fax history remain
                available. If source details changed, prepare and review a new
                RFA version before queueing it.
              </p>
              <p>
                To {cancelling.recipient} · {cancelling.fax}
              </p>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <label>
                Cancellation reason
                <textarea
                  name="reason"
                  required
                  minLength={5}
                  maxLength={1000}
                  rows={3}
                />
              </label>
            </div>
            <div className="modal-footer">
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => setCancelling(null)}
              >
                Keep attempt
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? "Cancelling…" : "Confirm cancellation"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {editing && (
        <RfaEditor
          initial={editing}
          onClose={() => setEditing(null)}
          onChanged={refresh}
        />
      )}
    </section>
  );
}
