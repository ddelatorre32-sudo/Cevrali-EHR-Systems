import { clinicTimestampLabel } from "./clinic-dates";
import { useEffect, useState, type FormEvent } from "react";
import { CreditCard, FileDown, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { api, patch, post } from "./api";
import { Badge, Empty, Modal, fullName, prettyDate } from "./components";
import { useResource } from "./workflow-ui";
import { PolicyFields } from "./insurance-fields";
import { CorrectionTools } from "./corrections-ui";
import { BillingAccountSelect } from "./patient-accounts-ui";
import type { AuthorizationRow } from "./authorizations-ui";
import type { Patient } from "./types";
import type {
  Bill,
  BillView,
  ChargeLine,
  Policy,
  Verification,
} from "../server/finance-engine";

type PolicyRow = Policy & {
  billing_account_name?: string;
  billing_account_kind?: string;
  first_name: string;
  last_name: string;
  verifications: Verification[];
};
type BillVisit = {
  billing_account_id?: string;
  billing_account_name?: string;
  id: string;
  patient_id: string;
  first_name: string;
  last_name: string;
  service_date: string;
  status: string;
  bill_id: string | null;
};
type Summary = {
  charges_cents: number;
  paid_cents: number;
  balance_cents: number;
  patient_balance_cents: number;
  unallocated_cents: number;
  denied_claims: number;
  credit_cents: number;
};
export const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(
    new Date(),
  );
function verificationLabel(policy: PolicyRow) {
  const last = policy.verifications.at(-1);
  if (!last || last.policy_revision !== policy.revision) return "Check needed";
  if (Date.now() - Date.parse(last.checked_at) > 7 * 86400000)
    return "Check expired";
  return `Demo ${last.status}`;
}
function parseMoney(value: FormDataEntryValue | null) {
  const s = String(value || "0").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s))
    throw new Error(
      "Enter a nonnegative dollar amount with up to two decimal places.",
    );
  const [dollars, decimals = ""] = s.split(".");
  const amount = Number(dollars) * 100 + Number(decimals.padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount > 100_000_000)
    throw new Error("Amount exceeds the supported limit.");
  return amount;
}
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function DemoNotice({ billing = false }: { billing?: boolean }) {
  return (
    <div className="finance-notice">
      <ShieldCheck size={20} />
      <div>
        <strong>
          {billing
            ? "Demo billing · clearinghouse disconnected"
            : "Demo eligibility · payer disconnected"}
        </strong>
        <p>
          {billing
            ? "Claims and remittances are simulated. Payments are ledger entries; no money moves."
            : "Choose a payer-response scenario to test the workflow. Sample benefits are estimates, not a guarantee of payment."}
        </p>
      </div>
    </div>
  );
}
function ErrorText({ error }: { error: string }) {
  return error ? (
    <p className="form-error" role="alert">
      {error}
    </p>
  ) : null;
}
function PolicyForm({
  patients,
  patient,
  policy,
  onSaved,
  onClose,
}: {
  patients: Patient[];
  patient?: Patient;
  policy?: Policy;
  onSaved: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedPatient, setSelectedPatient] = useState(
    policy?.patient_id || patient?.id || "",
  );
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const body = {
        ...Object.fromEntries(f),
        revision: policy?.revision,
        ...(policy ? { billing_account_id: policy.billing_account_id } : {}),
      };
      if (policy) await patch(`/workflow/finance/policies/${policy.id}`, body);
      else await post("/workflow/finance/policies", body);
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
      title={policy ? "Edit insurance coverage" : "Add insurance coverage"}
      onClose={onClose}
    >
      <form onSubmit={save}>
        <div className="modal-body">
          <ErrorText error={error} />
          {policy && (
            <p className="finance-help">
              Saving a change requires a new coverage check. Previous
              verification responses remain in history.
            </p>
          )}
          <div className="form-grid">
            <label>
              Patient
              <select
                name="patient_id"
                value={selectedPatient}
                onChange={(e) => setSelectedPatient(e.target.value)}
                required
                disabled={Boolean(policy || patient)}
              >
                <option value="">Select patient</option>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {fullName(p)}
                  </option>
                ))}
              </select>
            </label>
            {(policy || patient) && (
              <input
                type="hidden"
                name="patient_id"
                value={policy?.patient_id || patient!.id}
              />
            )}
            <PolicyFields policy={policy} />
            <div className="span-2">
              <BillingAccountSelect
                patientId={selectedPatient}
                value={policy?.billing_account_id}
                disabled={Boolean(policy)}
                privateOnly
                label="Private insurance billing account"
              />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            Save coverage
          </button>
        </div>
      </form>
    </Modal>
  );
}
function VerifyForm({
  policy,
  onSaved,
  onClose,
}: {
  policy: PolicyRow;
  onSaved: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(event.currentTarget);
    try {
      await post(
        `/workflow/finance/policies/${policy.id}/verify`,
        Object.fromEntries(f),
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
      title="Run demo coverage check"
      subtitle={`${fullName(policy)} · ${policy.payer}`}
      onClose={onClose}
    >
      <form onSubmit={verify}>
        <div className="modal-body">
          <DemoNotice />
          <ErrorText error={error} />
          <div className="form-grid">
            <label>
              Service date
              <input
                type="date"
                name="service_date"
                defaultValue={today()}
                required
              />
            </label>
            <label>
              Demo response
              <select name="scenario">
                <option>Active</option>
                <option>Inactive</option>
                <option>Needs review</option>
              </select>
            </label>
          </div>
          <p className="finance-help">
            {policy.billing_account_kind === "Workers compensation"
              ? "This records a demo claim review, not a live workers compensation coverage decision. Record the accepted claim and accepted body parts in Billing accounts first. No copay, deductible, or coinsurance is applied."
              : "Active sample benefits: $25 copay, $500 deductible remaining, 20% coinsurance. Dates outside the policy period always return inactive."}
            Checks expire for claim preparation after seven days.
          </p>
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            Run demo check
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function InsurancePage({
  patients,
  patient,
}: {
  patients: Patient[];
  patient?: Patient;
}) {
  const scope = patient ? `?patient_id=${encodeURIComponent(patient.id)}` : "";
  const resource = useResource<PolicyRow[]>(
    `/workflow/finance/policies${scope}`,
    [],
  );
  const [patientId, setPatientId] = useState("");
  const [editing, setEditing] = useState<Policy | true | null>(null);
  const [verify, setVerify] = useState<PolicyRow | null>(null);
  const rows = resource.data.filter(
    (p) => !patientId || p.patient_id === patientId,
  );
  return (
    <div className="workflow-stack">
      <DemoNotice />
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Coverage & eligibility</h2>
            <p>Review member information before the visit.</p>
          </div>
          <button className="button primary" onClick={() => setEditing(true)}>
            <Plus size={16} />
            Add coverage
          </button>
        </div>
        {!patient && (
          <div className="finance-toolbar">
            <label>
              Filter by patient
              <select
                value={patientId}
                onChange={(e) => setPatientId(e.target.value)}
              >
                <option value="">All patients</option>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {fullName(p)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <ErrorText error={resource.error} />
        <div className="finance-cards">
          {rows.map((p) => {
            const v = p.verifications.at(-1);
            const current = v && v.policy_revision === p.revision;
            return (
              <article className="finance-card" key={p.id}>
                <div className="finance-card-header">
                  <div>
                    <h3>{fullName(p)}</h3>
                    <p>
                      {p.payer} · {p.plan}
                    </p>
                    <p>{p.billing_account_name}</p>
                  </div>
                  <Badge>{verificationLabel(p)}</Badge>
                </div>
                <dl className="finance-details">
                  <div>
                    <dt>Coverage</dt>
                    <dd>
                      {p.priority} · {p.member_id}
                    </dd>
                  </div>
                  <div>
                    <dt>Subscriber</dt>
                    <dd>
                      {p.subscriber_name} · {p.relationship}
                    </dd>
                  </div>
                  <div>
                    <dt>Policy dates</dt>
                    <dd>
                      {prettyDate(p.effective_date)} –{" "}
                      {p.end_date ? prettyDate(p.end_date) : "Ongoing"}
                    </dd>
                  </div>
                </dl>
                {v && (
                  <div className="finance-benefits">
                    <strong>
                      {current
                        ? "Latest demo check"
                        : "Previous policy version"}
                    </strong>
                    <p>
                      Service date {prettyDate(v.service_date)} · {v.status} ·{" "}
                      {clinicTimestampLabel(v.checked_at)}
                    </p>
                    {v.status === "Active" &&
                      p.billing_account_kind !== "Workers compensation" && (
                        <p>
                          Copay {money(v.copay_cents!)} · Deductible remaining{" "}
                          {money(v.deductible_remaining_cents!)} · Coinsurance{" "}
                          {v.coinsurance_percent}%
                        </p>
                      )}
                  </div>
                )}
                <div className="button-row">
                  <button
                    className="button secondary"
                    onClick={() => setVerify(p)}
                  >
                    Check coverage
                  </button>
                  {p.billing_account_kind !== "Workers compensation" ? (
                    <button
                      className="text-button"
                      onClick={() => setEditing(p)}
                    >
                      Edit coverage
                    </button>
                  ) : (
                    <span className="finance-help">
                      Manage claim details in Billing accounts.
                    </span>
                  )}
                </div>
                {!!p.verifications.length && (
                  <details className="finance-history">
                    <summary>
                      Verification history ({p.verifications.length})
                    </summary>
                    {[...p.verifications].reverse().map((v) => (
                      <div key={v.id}>
                        <strong>Demo {v.status}</strong> ·{" "}
                        {prettyDate(v.service_date)}
                        <p>
                          Policy version {v.policy_revision} · {v.checked_by} ·{" "}
                          {clinicTimestampLabel(v.checked_at)}
                        </p>
                        <small>Reference {v.reference}</small>
                      </div>
                    ))}
                  </details>
                )}
              </article>
            );
          })}
        </div>
        {!resource.loading && !rows.length && (
          <Empty
            icon={ShieldCheck}
            title="No coverage recorded"
            description="Add a policy to check coverage and prepare insured visit billing."
          />
        )}
        <p className="finance-footnote">
          Primary and secondary policies can be recorded. This demo prepares
          primary claims; coordination of benefits and secondary claims require
          a clearinghouse integration.
        </p>
      </section>
      {editing && (
        <PolicyForm
          patients={patients}
          patient={patient}
          policy={editing === true ? undefined : editing}
          onSaved={resource.reload}
          onClose={() => setEditing(null)}
        />
      )}
      {verify && (
        <VerifyForm
          policy={verify}
          onSaved={resource.reload}
          onClose={() => setVerify(null)}
        />
      )}
    </div>
  );
}

function NewBill({
  patient,
  onCreated,
  onClose,
}: {
  patient?: Patient;
  onCreated: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const visits = useResource<BillVisit[]>(
    `/workflow/finance/visits${patient ? `?patient_id=${encodeURIComponent(patient.id)}` : ""}`,
    [],
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const b = await post<Bill>("/workflow/finance/bills", {
        ...Object.fromEntries(f),
        ...(patient ? { patient_id: patient.id } : {}),
      });
      await onCreated(b.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Create visit charge sheet" onClose={onClose}>
      <form onSubmit={create}>
        <div className="modal-body">
          <ErrorText error={error || visits.error} />
          {patient && (
            <p className="finance-help">
              Charge sheet for {fullName(patient)}. Only this patient's
              encounters are listed.
            </p>
          )}
          {!visits.loading &&
            !visits.error &&
            !visits.data.some((v) => !v.bill_id) && (
              <p className="finance-help" role="status">
                No unbilled encounters. Create an encounter for this patient
                before adding visit charges.
              </p>
            )}
          <div className="form-grid">
            <label>
              Encounter
              <select name="encounter_id" required defaultValue="">
                <option value="">Select an unbilled encounter</option>
                {visits.data
                  .filter((v) => !v.bill_id)
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {fullName(v)} · {v.service_date} · {v.status}
                      {v.billing_account_name
                        ? ` · ${v.billing_account_name}`
                        : ""}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Billing type
              <select name="mode">
                <option>Insurance</option>
                <option>Self-pay</option>
              </select>
            </label>
          </div>
          <p className="finance-help">
            Charges can be drafted now. Sign the encounter before preparing a
            claim or finalizing a self-pay balance.
          </p>
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={
              busy || visits.loading || !visits.data.some((v) => !v.bill_id)
            }
          >
            Create charge sheet
          </button>
        </div>
      </form>
    </Modal>
  );
}
const blankLine = () => ({
  code: "",
  description: "",
  diagnosis: "",
  units: 1,
  unit_cents: 0,
});
function BillEditor({
  bill,
  onChanged,
  onClose,
}: {
  bill: BillView;
  onChanged: () => Promise<unknown>;
  onClose: () => void;
}) {
  const policies = useResource<PolicyRow[]>(
    `/workflow/finance/policies?patient_id=${bill.patient_id}&billing_account_id=${bill.billing_account_id || `pba-private-${bill.patient_id}`}`,
    [],
  );
  const [lines, setLines] = useState<ChargeLine[]>(
    bill.lines.length ? bill.lines : [blankLine()],
  );
  const [policyId, setPolicyId] = useState(bill.policy_id);
  const authorizations = useResource<AuthorizationRow[]>(
    `/workflow/finance/authorizations?patient_id=${bill.patient_id}`,
    [],
  );
  const [authorizationRequired, setAuthorizationRequired] = useState(
    Boolean(bill.authorization_required),
  );
  const [authorizationId, setAuthorizationId] = useState(
    bill.authorization_id || "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [action, setAction] = useState<
    "response" | "payment" | "resubmit" | null
  >(null);
  const locked = Boolean(bill.claim || bill.finalized_at);
  const claim = bill.claim;
  const correctionPending = bill.corrections.some((c) =>
    ["Draft", "Demo submitted"].includes(c.status),
  );
  useEffect(() => {
    if (locked) {
      setLines(bill.lines);
      setPolicyId(bill.policy_id);
      setAuthorizationRequired(Boolean(bill.authorization_required));
      setAuthorizationId(bill.authorization_id || "");
    }
  }, [
    locked,
    bill.lines,
    bill.policy_id,
    bill.authorization_required,
    bill.authorization_id,
  ]);
  async function run(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      await onChanged();
      setMessage(success);
      setAction(null);
    } catch (e) {
      setError((e as Error).message);
      try {
        await onChanged();
      } catch {
        /* Keep the original action error visible. */
      }
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    return patch<Bill>(`/workflow/finance/bills/${bill.id}`, {
      revision: bill.revision,
      policy_id: policyId,
      lines,
      authorization_required: authorizationRequired,
      authorization_id: authorizationId,
    });
  }
  const updateLine = (
    index: number,
    field: keyof ChargeLine,
    value: string | number,
  ) =>
    setLines(lines.map((l, i) => (i === index ? { ...l, [field]: value } : l)));
  function payment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    void run(
      async () =>
        post(`/workflow/finance/bills/${bill.id}/payments`, {
          amount_cents: parseMoney(f.get("amount")),
          reference: f.get("reference"),
          note: f.get("note"),
        }),
      "Payment entry recorded. No payment was processed.",
    );
  }
  function response(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    void run(
      async () =>
        post(`/workflow/finance/claims/${claim!.id}/remittance`, {
          reference: f.get("reference"),
          outcome: f.get("outcome"),
          payer_paid_cents: parseMoney(f.get("payer")),
          adjustment_cents: parseMoney(f.get("adjustment")),
          patient_responsibility_cents: parseMoney(f.get("responsibility")),
          denial_reason: f.get("denial_reason"),
        }),
      "Demo response recorded.",
    );
  }
  return (
    <Modal
      title="Visit billing"
      subtitle={`${fullName(bill)} · ${prettyDate(bill.service_date)} · ${bill.mode}`}
      onClose={onClose}
    >
      <div className="modal-body finance-editor">
        <DemoNotice billing />
        <ErrorText error={error || policies.error || authorizations.error} />
        {message && (
          <p className="inline-success" role="status">
            {message}
          </p>
        )}
        <div className="finance-card-header">
          <h3>Charge sheet</h3>
          <Badge>{bill.status}</Badge>
        </div>
        <p className="visit-account-banner">
          <strong>{bill.billing_account.name}</strong> ·{" "}
          {bill.billing_account.kind}
          {bill.billing_account.workers_comp
            ? ` · Claim ${bill.billing_account.workers_comp.claim_number} · ${bill.billing_account.workers_comp.carrier}`
            : ""}
        </p>
        {bill.mode === "Insurance" && (
          <label>
            Insurance policy
            <select
              disabled={locked || busy}
              value={policyId}
              onChange={(e) => setPolicyId(e.target.value)}
            >
              <option value="">Select primary coverage</option>
              {policies.data.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.priority} · {p.payer} · {p.member_id}
                </option>
              ))}
            </select>
          </label>
        )}
        {bill.mode === "Insurance" && (
          <div className="authorization-link">
            <label className="finance-check">
              <input
                type="checkbox"
                checked={authorizationRequired}
                disabled={
                  busy ||
                  correctionPending ||
                  Boolean(
                    locked &&
                    !["Prepared", "Demo denied"].includes(claim?.status || ""),
                  )
                }
                onChange={(e) => setAuthorizationRequired(e.target.checked)}
              />
              Prior authorization required for these services
            </label>
            {authorizationRequired && (
              <label>
                Approved authorization
                <select
                  value={authorizationId}
                  disabled={
                    busy ||
                    correctionPending ||
                    Boolean(
                      locked &&
                      !["Prepared", "Demo denied"].includes(
                        claim?.status || "",
                      ),
                    )
                  }
                  onChange={(e) => setAuthorizationId(e.target.value)}
                >
                  <option value="">Select authorization</option>
                  {authorizations.data
                    .filter((a) => a.policy_id === policyId)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.description} · {a.status} ·{" "}
                        {a.approval_number || "No approval number"} ·{" "}
                        {a.remaining_visits} visits remaining
                      </option>
                    ))}
                </select>
              </label>
            )}
            <p className="finance-help">
              Staff identify requirements. Link an approval covering the service
              date and every listed procedure. Prepared claims reserve one
              approved visit.
            </p>
          </div>
        )}
        <p className="finance-help">
          Enter codes reviewed by staff. No codes or fees are inferred from the
          clinical note. Code format checks do not validate coding accuracy or
          payer rules.
        </p>
        <div className="finance-charge-lines">
          {lines.map((l, i) => (
            <fieldset key={i} disabled={locked || busy}>
              <legend>Charge {i + 1}</legend>
              <div className="form-grid">
                <label>
                  CPT / HCPCS
                  <input
                    aria-label={`Procedure code ${i + 1}`}
                    value={l.code}
                    onChange={(e) =>
                      updateLine(i, "code", e.target.value.toUpperCase())
                    }
                    maxLength={5}
                  />
                </label>
                <label>
                  Diagnosis (ICD-10-CM)
                  <input
                    aria-label={`Diagnosis code ${i + 1}`}
                    value={l.diagnosis}
                    onChange={(e) =>
                      updateLine(i, "diagnosis", e.target.value.toUpperCase())
                    }
                    maxLength={8}
                  />
                </label>
                <label>
                  Description
                  <input
                    aria-label={`Charge description ${i + 1}`}
                    value={l.description}
                    onChange={(e) =>
                      updateLine(i, "description", e.target.value)
                    }
                    maxLength={200}
                  />
                </label>
                <label>
                  Units
                  <input
                    aria-label={`Charge units ${i + 1}`}
                    type="number"
                    min={1}
                    max={100}
                    value={l.units}
                    onChange={(e) =>
                      updateLine(i, "units", Number(e.target.value))
                    }
                  />
                </label>
                <label>
                  Unit fee ($)
                  <input
                    aria-label={`Unit fee ${i + 1}`}
                    key={locked ? l.unit_cents : "editing"}
                    type="number"
                    min="0.01"
                    step="0.01"
                    defaultValue={l.unit_cents ? l.unit_cents / 100 : ""}
                    onChange={(e) => {
                      try {
                        updateLine(i, "unit_cents", parseMoney(e.target.value));
                      } catch {
                        updateLine(i, "unit_cents", -1);
                      }
                    }}
                  />
                </label>
                <div className="finance-line-total">
                  <strong>{money(Math.max(0, l.unit_cents) * l.units)}</strong>
                  {!locked && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Remove charge ${i + 1}`}
                      onClick={() => setLines(lines.filter((_, j) => j !== i))}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </div>
            </fieldset>
          ))}
        </div>
        {!locked && (
          <div className="button-row">
            <button
              className="button secondary"
              disabled={busy || lines.length >= 30}
              onClick={() => setLines([...lines, blankLine()])}
            >
              <Plus size={15} />
              Add charge
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void run(save, "Charges saved.")}
            >
              Save charges
            </button>
          </div>
        )}
        <dl className="finance-totals">
          <div>
            <dt>Saved charges</dt>
            <dd>{money(bill.charges_cents)}</dd>
          </div>
          <div>
            <dt>Recorded payments</dt>
            <dd>{money(bill.paid_cents)}</dd>
          </div>
          <div>
            <dt>Adjustments</dt>
            <dd>{money(bill.adjustment_cents)}</dd>
          </div>
          <div>
            <dt>Outstanding</dt>
            <dd>{money(bill.balance_cents)}</dd>
          </div>
          <div>
            <dt>Patient due</dt>
            <dd>
              {bill.patient_balance_cents === null
                ? "Not assigned"
                : money(bill.patient_balance_cents)}
            </dd>
          </div>
        </dl>
        {Boolean(bill.credit_cents) && (
          <p className="finance-denial">
            Credit balance: {money(bill.credit_cents)}. Review externally; no
            refund has been issued.
          </p>
        )}
        {Boolean(bill.unapplied_patient_cents) && (
          <p className="finance-help">
            Unapplied patient payments: {money(bill.unapplied_patient_cents)}.
            Patient responsibility will be assigned after the replacement claim
            response.
          </p>
        )}
        {correctionPending && (
          <p className="finance-help">
            A correction is being reviewed. Original claim updates and payment
            posting are paused until the correction is resolved.
          </p>
        )}
        <div className="button-row">
          {!locked && bill.mode === "Insurance" && (
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await save();
                  return post("/workflow/finance/claims", { bill_id: bill.id });
                }, "Demo claim prepared. Charges are locked.")
              }
            >
              Prepare demo claim
            </button>
          )}
          {!locked && bill.mode === "Self-pay" && (
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await save();
                  return post(
                    `/workflow/finance/bills/${bill.id}/finalize`,
                    {},
                  );
                }, "Self-pay balance finalized.")
              }
            >
              Finalize self-pay
            </button>
          )}
          {!correctionPending && claim?.status === "Prepared" && (
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void run(
                  () => post(`/workflow/finance/claims/${claim.id}/submit`, {}),
                  "Demo submission recorded. Nothing was transmitted.",
                )
              }
            >
              Simulate submission
            </button>
          )}
          {!correctionPending &&
            claim &&
            ["Prepared", "Demo denied"].includes(claim.status) && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      post(
                        `/workflow/finance/claims/${claim.id}/refresh-coverage`,
                        {
                          authorization_required: authorizationRequired,
                          authorization_id: authorizationId,
                        },
                      ),
                    "Claim coverage refreshed.",
                  )
                }
              >
                Refresh claim coverage
              </button>
            )}
          {!correctionPending && claim?.status === "Demo submitted" && (
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                setAction(action === "response" ? null : "response")
              }
            >
              Record demo payer response
            </button>
          )}
          {!correctionPending && claim?.status === "Demo denied" && (
            <button
              className="button primary"
              disabled={busy}
              onClick={() => setAction("resubmit")}
            >
              Resolve & resubmit demo
            </button>
          )}
          {claim && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void run(
                  async () =>
                    download(
                      await api(`/workflow/finance/claims/${claim.id}/export`),
                      `${claim.id}-draft.json`,
                    ),
                  "Draft exported. No claim was transmitted.",
                )
              }
            >
              <FileDown size={15} />
              Export claim draft
            </button>
          )}
          {!correctionPending &&
            bill.patient_balance_cents !== null &&
            bill.patient_balance_cents > 0 && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  setAction(action === "payment" ? null : "payment")
                }
              >
                Record patient payment
              </button>
            )}
          {bill.patient_balance_cents !== null && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void run(
                  async () =>
                    download(
                      await api(`/workflow/finance/bills/${bill.id}/statement`),
                      `${bill.id}-statement.json`,
                    ),
                  "Demo statement exported. Nothing was sent.",
                )
              }
            >
              <FileDown size={15} />
              Export statement
            </button>
          )}
        </div>
        {claim && (
          <p className="finance-help">
            Claim {claim.id} · {claim.attempts} demo submission(s) · coverage
            version {claim.policy.revision} · {claim.previous_coverage.length}{" "}
            prior coverage snapshot(s)
          </p>
        )}
        {claim?.denial_reason && (
          <p className="finance-denial">
            Denial follow-up: {claim.denial_reason}
          </p>
        )}
        {action === "resubmit" && claim && (
          <form
            className="finance-action-form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void run(
                () =>
                  post(`/workflow/finance/claims/${claim.id}/submit`, {
                    correction_note: f.get("correction_note"),
                  }),
                "Demo claim resubmitted. Nothing was transmitted.",
              );
            }}
          >
            <h3>Document the denial resolution</h3>
            <label>
              Correction / follow-up note
              <textarea
                name="correction_note"
                required
                minLength={5}
                maxLength={500}
              />
            </label>
            <p className="finance-help">
              Record administrative follow-up here. Use Correct claim to revise
              charges or prepare a demo replacement or void with version
              history.
            </p>
            <button className="button primary" disabled={busy}>
              Resubmit demo claim
            </button>
          </form>
        )}
        {action === "response" && (
          <form className="finance-action-form" onSubmit={response}>
            <h3>Simulated remittance</h3>
            <div className="form-grid">
              <label>
                Response reference
                <input name="reference" required maxLength={200} />
              </label>
              <label>
                Outcome
                <select name="outcome">
                  <option>Approved</option>
                  <option>Denied</option>
                </select>
              </label>
              <label>
                Insurer payment ($)
                <input
                  type="number"
                  name="payer"
                  min="0"
                  step="0.01"
                  defaultValue="0"
                  required
                />
              </label>
              <label>
                Contractual adjustment ($)
                <input
                  type="number"
                  name="adjustment"
                  min="0"
                  step="0.01"
                  defaultValue="0"
                  required
                />
              </label>
              <label>
                Patient responsibility ($)
                <input
                  type="number"
                  name="responsibility"
                  readOnly={
                    bill.billing_account.kind === "Workers compensation"
                  }
                  min="0"
                  step="0.01"
                  defaultValue="0"
                  required
                />
              </label>
              <label>
                Denial reason
                <input name="denial_reason" maxLength={500} />
              </label>
            </div>
            <p className="finance-help">
              Approved amounts must equal {money(bill.charges_cents)}. Denials
              require a reason and zero amounts. Eligibility estimates do not
              set patient responsibility.
            </p>
            {bill.billing_account.kind === "Workers compensation" && (
              <p className="finance-help">
                Workers compensation patient responsibility stays zero in this
                demo. Resolve disputed liability outside this workflow; it does
                not transfer to private insurance automatically.
              </p>
            )}
            <button className="button primary" disabled={busy}>
              Post demo response
            </button>
          </form>
        )}
        {action === "payment" && (
          <form className="finance-action-form" onSubmit={payment}>
            <h3>Manual payment entry</h3>
            <div className="form-grid">
              <label>
                Payment amount ($)
                <input
                  type="number"
                  name="amount"
                  min="0.01"
                  max={(bill.patient_balance_cents || 0) / 100}
                  step="0.01"
                  required
                />
              </label>
              <label>
                Payment reference
                <input name="reference" required maxLength={200} />
              </label>
              <label>
                Payment note
                <input
                  name="note"
                  maxLength={500}
                  placeholder="Recordkeeping only; do not enter card details"
                />
              </label>
            </div>
            <p className="finance-help">
              Record a payment already received outside this app. This action
              does not charge a card or transfer funds.
            </p>
            <button className="button primary" disabled={busy}>
              Save payment entry
            </button>
          </form>
        )}
        {!!bill.remittances.length && (
          <details className="finance-history">
            <summary>
              Payer response history ({bill.remittances.length})
            </summary>
            {bill.remittances.map((r) => (
              <div key={r.id}>
                <strong>Demo {r.outcome}</strong> · {r.reference} · attempt{" "}
                {r.attempt}
                <p>
                  {r.denial_reason ||
                    `Insurer ${money(r.payer_paid_cents)} · Adjustment ${money(r.adjustment_cents)} · Patient ${money(r.patient_responsibility_cents)}`}
                </p>
                <small>{clinicTimestampLabel(r.created_at)}</small>
              </div>
            ))}
          </details>
        )}
        {!!bill.ledger.length && (
          <section>
            <h3>Payment & adjustment ledger</h3>
            <div className="finance-ledger">
              {bill.ledger.map((entry) => (
                <div key={entry.id}>
                  <div>
                    <strong>{entry.type}</strong>
                    <p>
                      {entry.reference} · {entry.actor} ·{" "}
                      {clinicTimestampLabel(entry.created_at)}
                    </p>
                    {entry.note && <small>{entry.note}</small>}
                  </div>
                  <strong>
                    {[
                      "Payment reversal",
                      "Insurer payment reversal",
                      "Adjustment reversal",
                    ].includes(entry.type)
                      ? "+"
                      : "−"}
                    {money(entry.amount_cents)}
                  </strong>
                  {!correctionPending &&
                    entry.type === "Patient payment" &&
                    !bill.ledger.some((e) => e.reverses_id === entry.id) && (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => {
                          const reason = window.prompt(
                            "Reason for reversing this ledger entry (no refund will be issued):",
                          );
                          if (reason)
                            void run(
                              () =>
                                post(
                                  `/workflow/finance/payments/${entry.id}/reverse`,
                                  { reason },
                                ),
                              "Payment entry reversed. No refund was issued.",
                            );
                        }}
                      >
                        Reverse entry
                      </button>
                    )}
                </div>
              ))}
            </div>
          </section>
        )}
        {claim && <CorrectionTools bill={bill} onChanged={onChanged} />}
      </div>
      <div className="modal-footer">
        <button className="button secondary" onClick={onClose}>
          Close billing
        </button>
      </div>
    </Modal>
  );
}
export function BillingPage({
  patients,
  patient,
}: {
  patients: Patient[];
  patient?: Patient;
}) {
  const scope = patient ? `?patient_id=${encodeURIComponent(patient.id)}` : "";
  const bills = useResource<BillView[]>(`/workflow/finance/bills${scope}`, []);
  const summary = useResource<Summary | null>(
    `/workflow/finance/summary${scope}`,
    null,
  );
  const [newBill, setNewBill] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("All");
  const [patientId, setPatientId] = useState("");
  const s = summary.data;
  const selectedBill = bills.data.find((b) => b.id === selected);
  const rows = bills.data.filter(
    (b) =>
      (!patientId || b.patient_id === patientId) &&
      (filter === "All" ||
        (filter === "Outstanding" ? b.balance_cents > 0 : b.status === filter)),
  );
  async function refresh() {
    await bills.reload();
    await summary.reload();
  }
  return (
    <div className="workflow-stack">
      <DemoNotice billing />
      <ErrorText error={bills.error || summary.error} />
      <div className="finance-metrics">
        {[
          ["Charges", s?.charges_cents],
          ["Recorded payments", s?.paid_cents],
          ["Outstanding", s?.balance_cents],
          ["Patient due", s?.patient_balance_cents],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <span>{label}</span>
            <strong>
              {value === undefined ? "—" : money(value as number)}
            </strong>
          </div>
        ))}
      </div>
      {Boolean(s?.unallocated_cents) && (
        <p className="finance-help">
          {money(s!.unallocated_cents)} is awaiting payer adjudication or
          self-pay finalization. It has not been assigned to patients.
        </p>
      )}
      {Boolean(s?.credit_cents) && (
        <p className="finance-help">
          Credit balances awaiting review: {money(s!.credit_cents)}. No refunds
          are processed by this demo.
        </p>
      )}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Billing worklist</h2>
            <p>Visit charges, claims, denial follow-up, and balances.</p>
          </div>
          <button className="button primary" onClick={() => setNewBill(true)}>
            <Plus size={16} />
            New charge sheet
          </button>
        </div>
        <div className="finance-toolbar">
          <label>
            Billing status
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              {[
                "All",
                "Draft",
                "Prepared",
                "Demo submitted",
                "Demo denied",
                "Demo adjudicated",
                "Self-pay finalized",
                "Demo voided",
                "Outstanding",
              ].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          {!patient && (
            <label>
              Billing patient
              <select
                value={patientId}
                onChange={(e) => setPatientId(e.target.value)}
              >
                <option value="">All patients</option>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {fullName(p)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {rows.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Patient / service date</th>
                  <th>Status</th>
                  <th>Charges</th>
                  <th>Outstanding</th>
                  <th>Patient due</th>
                  <th>Age</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <strong>{fullName(b)}</strong>
                      <small className="finance-table-sub">
                        {prettyDate(b.service_date)} · {b.mode}
                      </small>
                      <small className="finance-table-sub">
                        {b.billing_account.name}
                        {b.billing_account.workers_comp
                          ? ` · ${b.billing_account.workers_comp.claim_number}`
                          : ""}
                      </small>
                    </td>
                    <td>
                      <Badge>{b.status}</Badge>
                    </td>
                    <td>{money(b.charges_cents)}</td>
                    <td>{money(b.balance_cents)}</td>
                    <td>
                      {b.patient_balance_cents === null
                        ? "Not assigned"
                        : money(b.patient_balance_cents)}
                    </td>
                    <td>{b.age_days}d</td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => setSelected(b.id)}
                      >
                        Manage billing
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !bills.loading && (
            <Empty
              icon={CreditCard}
              title="No charge sheets in this view"
              description="Create a charge sheet from an encounter to begin billing."
            />
          )
        )}
      </section>
      {newBill && (
        <NewBill
          patient={patient}
          onCreated={async (id) => {
            await refresh();
            setSelected(id);
          }}
          onClose={() => setNewBill(false)}
        />
      )}
      {selectedBill && (
        <BillEditor
          key={selectedBill.id}
          bill={selectedBill}
          onChanged={refresh}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

export function VisitFinanceContext({ patientId }: { patientId: string }) {
  const policies = useResource<PolicyRow[]>(
    `/workflow/finance/policies?patient_id=${patientId}`,
    [],
  );
  const bills = useResource<BillView[]>(
    `/workflow/finance/bills?patient_id=${patientId}`,
    [],
  );
  return (
    <div className="visit-summary">
      <ErrorText error={policies.error || bills.error} />
      <section>
        <h4>Insurance on file</h4>
        {policies.data.map((p) => (
          <div key={p.id}>
            <strong>
              {p.priority} · {p.payer}
            </strong>
            <p>
              {p.plan} · member {p.member_id}
            </p>
            <p>
              {p.verifications.at(-1)?.policy_revision === p.revision
                ? `Latest demo check: ${p.verifications.at(-1)!.status} · ${p.verifications.at(-1)!.service_date}`
                : "Coverage check needed"}
            </p>
          </div>
        ))}
        {!policies.loading && !policies.data.length && (
          <p>No insurance recorded.</p>
        )}
      </section>
      <section>
        <h4>Billing summary</h4>
        {bills.data.map((b) => (
          <p key={b.id}>
            {prettyDate(b.service_date)} · {b.status}
            <br />
            Outstanding {money(b.balance_cents)} · Patient{" "}
            {b.patient_balance_cents === null
              ? "not assigned"
              : money(b.patient_balance_cents)}
          </p>
        ))}
        {!bills.loading && !bills.data.length && (
          <p>No visit charges recorded.</p>
        )}
      </section>
      <p>
        Use Insurance and Billing in the main navigation to manage coverage,
        charges, and claims.
      </p>
    </div>
  );
}
