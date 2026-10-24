import { clinicTimestampLabel } from "./clinic-dates";
import { useWorkSourceFocus } from "./work-source-focus";
import { useState, type FormEvent } from "react";
import { Plus, ShieldCheck } from "lucide-react";
import { Badge, Empty, Modal, fullName, prettyDate } from "./components";
import { post, patch } from "./api";
import { useResource } from "./workflow-ui";
import { insuranceDate } from "./insurance-fields";
import type { Patient, User } from "./types";
import { RfaTools } from "./rfa-ui";
import { ServiceAllowanceTools } from "./operations-ui";
import type { Policy, PriorAuthorization } from "../server/finance-engine";

export type AuthorizationRow = PriorAuthorization & {
  first_name: string;
  last_name: string;
  payer: string;
  owner_name: string;
  used_visits: number;
  remaining_visits: number;
  expired: boolean;
  expiring: boolean;
  followup_due: boolean;
  policy_changed: boolean;
};
function AuthForm({
  patients,
  patient,
  draft,
  onSaved,
  onClose,
}: {
  patients: Patient[];
  patient?: Patient;
  draft?: AuthorizationRow;
  onSaved: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [patientId, setPatientId] = useState(
    draft?.patient_id || patient?.id || "",
  );
  const [policyId, setPolicyId] = useState(draft?.policy_id || "");
  const [encounterId, setEncounterId] = useState(draft?.encounter_id || "");
  const policies = useResource<(Policy & { billing_account_kind?: string })[]>(
    `/workflow/finance/policies${patientId ? `?patient_id=${encodeURIComponent(patientId)}` : ""}`,
    [],
  );
  const visits = useResource<
    {
      id: string;
      patient_id: string;
      status: string;
      billing_account_id: string;
      billing_account_name: string;
      service_date: string;
    }[]
  >(
    `/workflow/finance/visits${patientId ? `?patient_id=${patientId}` : ""}`,
    [],
  );
  const selectedPolicy = policies.data.find((p) => p.id === policyId);
  const team = useResource<{ id: string; name: string }[]>(
    "/workflow/team",
    [],
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      const body = {
        ...Object.fromEntries(f),
        patient_id: patientId,
        ...(selectedPolicy?.billing_account_kind === "Workers compensation" &&
        encounterId
          ? { encounter_id: encounterId }
          : {}),
        revision: draft?.revision,
        procedure_codes: String(f.get("procedure_codes"))
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        requested_visits: Number(f.get("requested_visits")),
        ...(f.get("owner_id")
          ? { owner_id: f.get("owner_id") }
          : { owner_id: undefined }),
      };
      if (draft)
        await patch(`/workflow/finance/authorizations/${draft.id}`, body);
      else await post("/workflow/finance/authorizations", body);
      await onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={draft ? "Edit authorization draft" : "New prior authorization"}
      onClose={onClose}
    >
      <form onSubmit={save}>
        <div className="modal-body">
          <p className="finance-help">
            Track staff-identified authorization requirements. Demo requests are
            never sent to a payer.
          </p>
          {(error || policies.error || team.error) && (
            <p className="form-error" role="alert">
              {error || policies.error || team.error}
            </p>
          )}
          <div className="form-grid">
            <label>
              Patient
              <select
                value={patientId}
                onChange={(e) => {
                  setPatientId(e.target.value);
                  setPolicyId("");
                  setEncounterId("");
                }}
                required
                disabled={Boolean(patient || draft)}
              >
                <option value="">Select patient</option>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {fullName(p)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Insurance policy
              <select
                name="policy_id"
                value={policyId}
                onChange={(e) => {
                  setPolicyId(e.target.value);
                  setEncounterId("");
                }}
                required
                disabled={!patientId || policies.loading}
              >
                <option value="">Select coverage</option>
                {policies.data
                  .filter((p) => p.patient_id === patientId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.payer} · {p.member_id}
                    </option>
                  ))}
              </select>
            </label>
            <label className="span-2">
              Service description
              <input
                name="description"
                defaultValue={draft?.description}
                required
                maxLength={200}
              />
            </label>
            {selectedPolicy?.billing_account_kind ===
              "Workers compensation" && (
              <label className="span-2">
                Supporting workers’ comp encounter
                <select
                  aria-label="Supporting workers’ comp encounter"
                  value={encounterId}
                  onChange={(e) => setEncounterId(e.target.value)}
                >
                  <option value="">
                    Link an encounter now or edit the draft later
                  </option>
                  {visits.data
                    .filter(
                      (v) =>
                        v.patient_id === patientId &&
                        v.billing_account_id ===
                          selectedPolicy.billing_account_id,
                    )
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.service_date} · {v.status} · {v.billing_account_name}{" "}
                        · {v.id}
                      </option>
                    ))}
                </select>
                <small>
                  A linked draft autofills the DWC RFA when its physician signs
                  the note. A signed encounter creates the RFA draft
                  immediately. No fax is sent automatically.
                </small>
              </label>
            )}
            <label>
              Procedure codes
              <input
                name="procedure_codes"
                defaultValue={draft?.procedure_codes.join(", ")}
                required={
                  !(
                    selectedPolicy?.billing_account_kind ===
                      "Workers compensation" && encounterId
                  )
                }
                placeholder="99213, 93000"
              />
              <small>
                CPT/HCPCS, separated by commas. A linked workers compensation
                RFA may leave unknown codes blank for provider review.
              </small>
            </label>
            <label>
              Requested visits
              <input
                type="number"
                name="requested_visits"
                min="1"
                max="1000"
                defaultValue={draft?.requested_visits || 1}
                required
              />
            </label>
            <label>
              Requested start
              <input
                type="date"
                name="valid_from"
                defaultValue={draft?.valid_from || insuranceDate()}
                required
              />
            </label>
            <label>
              Requested end
              <input
                type="date"
                name="valid_to"
                defaultValue={draft?.valid_to || insuranceDate()}
                required
              />
            </label>
            <label>
              Follow-up due
              <input
                type="date"
                name="due_date"
                defaultValue={draft?.due_date || insuranceDate()}
                required
              />
            </label>
            <label>
              Assigned staff
              <select name="owner_id" defaultValue={draft?.owner_id || ""}>
                <option value="">Assign to me</option>
                {team.data.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy || policies.loading}
          >
            Save authorization draft
          </button>
        </div>
      </form>
    </Modal>
  );
}
function DecisionForm({
  authorization,
  onSaved,
  onClose,
}: {
  authorization: AuthorizationRow;
  onSaved: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [outcome, setOutcome] = useState("Approved");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await post(
        `/workflow/finance/authorizations/${authorization.id}/decision`,
        {
          ...Object.fromEntries(f),
          outcome,
          approved_visits:
            outcome === "Approved" ? Number(f.get("approved_visits")) : 0,
          approval_number:
            outcome === "Approved" ? f.get("approval_number") : "",
          valid_from: f.get("valid_from") || authorization.valid_from,
          valid_to: f.get("valid_to") || authorization.valid_to,
        },
      );
      await onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Record demo authorization decision"
      subtitle={`${fullName(authorization)} · ${authorization.description}`}
      onClose={onClose}
    >
      <form onSubmit={save}>
        <div className="modal-body">
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="form-grid">
            <label>
              Demo outcome
              <select
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
              >
                <option>Approved</option>
                <option>Denied</option>
              </select>
            </label>
            {outcome === "Approved" && (
              <>
                <label>
                  Approval number
                  <input name="approval_number" required maxLength={100} />
                </label>
                <label>
                  Approved visits
                  <input
                    type="number"
                    name="approved_visits"
                    min="1"
                    max={authorization.requested_visits}
                    defaultValue={authorization.requested_visits}
                    required
                  />
                </label>
                <label>
                  Approval start
                  <input
                    type="date"
                    name="valid_from"
                    defaultValue={authorization.valid_from}
                    required
                  />
                </label>
                <label>
                  Approval end
                  <input
                    type="date"
                    name="valid_to"
                    defaultValue={authorization.valid_to}
                    required
                  />
                </label>
              </>
            )}
            <label className="span-2">
              Decision note
              <textarea name="note" required minLength={5} maxLength={1000} />
            </label>
          </div>
          <p className="finance-help">
            Record a simulated payer decision. Approval is counted in visits,
            not individual procedure units, and does not guarantee payment.
          </p>
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            Save demo decision
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function AuthorizationsPage({
  patients,
  patient,
  initialAuthorizationId,
}: {
  patients: Patient[];
  patient?: Patient;
  initialAuthorizationId?: string;
}) {
  const currentUser = useResource<User | null>("/auth/me", null);
  const resource = useResource<AuthorizationRow[]>(
    `/workflow/finance/authorizations${patient ? `?patient_id=${encodeURIComponent(patient.id)}` : ""}`,
    [],
  );
  const [editing, setEditing] = useState<AuthorizationRow | true | null>(null);
  const [decision, setDecision] = useState<AuthorizationRow | null>(null);
  const [filter, setFilter] = useState("All");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useWorkSourceFocus(resource.data.some(authorization => authorization.id === initialAuthorizationId) ? `work-authorization-${initialAuthorizationId}` : undefined);
  async function run(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      await resource.reload();
      setMessage(success);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const rows = resource.data.filter(
    (a) =>
      filter === "All" ||
      (filter === "Expiring"
        ? a.status === "Demo approved" && a.expiring
        : filter === "Expired"
          ? a.status === "Demo approved" && a.expired
          : filter === "Follow-up due"
            ? a.followup_due
            : filter === "Exhausted"
              ? a.status === "Demo approved" && !a.remaining_visits
              : a.status === filter),
  );
  return (
    <div className="workflow-stack">
      <div className="finance-notice">
        <ShieldCheck size={20} />
        <div>
          <strong>Prior authorization · demo payer disconnected</strong>
          <p>
            Track service approvals, approved visits, expiration, and follow-up.
            Staff identify requirements; no requests are transmitted.
          </p>
        </div>
      </div>
      {(error || resource.error) && (
        <p className="form-error" role="alert">
          {error || resource.error}
        </p>
      )}
      {message && (
        <p className="inline-success" role="status">
          {message}
        </p>
      )}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Prior authorizations</h2>
            <p>Keep approvals ready before a claim is prepared.</p>
          </div>
          <button className="button primary" onClick={() => setEditing(true)}>
            <Plus size={16} />
            New authorization
          </button>
        </div>
        <div className="finance-toolbar">
          <label>
            Authorization status
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              {[
                "All",
                "Draft",
                "Demo submitted",
                "Demo approved",
                "Demo denied",
                "Cancelled",
                "Expiring",
                "Expired",
                "Follow-up due",
                "Exhausted",
              ].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="finance-cards">
          {rows.map((a) => (
            <article className={`finance-card ${a.id === initialAuthorizationId ? "work-source-focus" : ""}`} key={a.id} id={`work-authorization-${a.id}`} tabIndex={a.id === initialAuthorizationId ? -1 : undefined}>
              <div className="finance-card-header">
                <div>
                  <h3>{fullName(a)}</h3>
                  <p>
                    {a.description} · {a.payer}
                  </p>
                </div>
                <Badge>{a.status}</Badge>
              </div>
              <dl className="finance-details">
                <div>
                  <dt>Procedures</dt>
                  <dd>
                    {a.procedure_codes.join(", ") ||
                      "Not specified — RFA review required"}
                  </dd>
                </div>
                <div>
                  <dt>Service period</dt>
                  <dd>
                    {prettyDate(a.valid_from)} – {prettyDate(a.valid_to)}
                    {a.status === "Demo approved" &&
                      (a.expired
                        ? " · Expired"
                        : a.expiring
                          ? " · Expires within 14 days"
                          : "")}
                  </dd>
                </div>
                <div>
                  <dt>Owner / follow-up</dt>
                  <dd>
                    {a.owner_name} · {prettyDate(a.due_date)}
                    {a.followup_due ? " · Follow-up due" : ""}
                  </dd>
                </div>
                <div>
                  <dt>Visits</dt>
                  <dd>
                    {a.status === "Demo approved"
                      ? `${a.used_visits} reserved / ${a.approved_visits} approved · ${a.remaining_visits} remaining`
                      : `${a.requested_visits} requested`}
                  </dd>
                </div>
                {a.approval_number && (
                  <div>
                    <dt>Approval number</dt>
                    <dd>{a.approval_number}</dd>
                  </div>
                )}
              </dl>
              {a.encounter_id && (
                <RfaTools
                  authorization={a}
                  clinical={currentUser.data?.role === "clinician"}
                  onChanged={resource.reload}
                />
              )}
              <ServiceAllowanceTools authorization={a} />
              {a.policy_changed && (
                <p className="finance-denial">
                  Policy has changed. New claim submissions require
                  authorization for the current policy version.
                </p>
              )}
              {a.decision_note && (
                <p className="finance-help">{a.decision_note}</p>
              )}
              <div className="button-row">
                {a.status === "Draft" && (
                  <>
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => setEditing(a)}
                    >
                      Edit draft
                    </button>
                    {!a.encounter_id && (
                      <button
                        className="button primary"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () =>
                              post(
                                `/workflow/finance/authorizations/${a.id}/submit`,
                                {},
                              ),
                            "Demo authorization submitted. Nothing was transmitted.",
                          )
                        }
                      >
                        Simulate authorization submission
                      </button>
                    )}
                  </>
                )}
                {a.status === "Demo submitted" && (
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => setDecision(a)}
                  >
                    Record demo decision
                  </button>
                )}
                {!["Cancelled", "Demo denied"].includes(a.status) && (
                  <button
                    className="text-button"
                    disabled={busy || a.used_visits > 0}
                    onClick={() => {
                      const reason = window.prompt(
                        "Reason for cancelling this demo authorization:",
                      );
                      if (reason)
                        void run(
                          () =>
                            post(
                              `/workflow/finance/authorizations/${a.id}/cancel`,
                              { reason },
                            ),
                          "Authorization cancelled.",
                        );
                    }}
                  >
                    Cancel authorization
                  </button>
                )}
              </div>
              <details className="finance-history">
                <summary>Authorization history ({a.history.length})</summary>
                {a.history.map((h, i) => (
                  <div key={i}>
                    <strong>{h.action}</strong>
                    <p>{h.note}</p>
                    <small>
                      {h.actor} · {clinicTimestampLabel(h.at)}
                    </small>
                  </div>
                ))}
              </details>
            </article>
          ))}
        </div>
        {!resource.loading && !rows.length && (
          <Empty
            icon={ShieldCheck}
            title="No authorizations in this view"
            description="Create a request linked to the patient's coverage and planned procedures."
          />
        )}
      </section>
      {editing && (
        <AuthForm
          patients={patients}
          patient={patient}
          draft={editing === true ? undefined : editing}
          onSaved={resource.reload}
          onClose={() => setEditing(null)}
        />
      )}
      {decision && (
        <DecisionForm
          authorization={decision}
          onSaved={resource.reload}
          onClose={() => setDecision(null)}
        />
      )}
    </div>
  );
}
