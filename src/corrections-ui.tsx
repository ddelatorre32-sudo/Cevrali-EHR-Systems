import { clinicTimestampLabel } from "./clinic-dates";
import { useState, type FormEvent } from "react";
import { Badge } from "./components";
import { post } from "./api";
import { useResource } from "./workflow-ui";
import type { BillView, ChargeLine, Policy } from "../server/finance-engine";
import type { AuthorizationRow } from "./authorizations-ui";

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
function dollars(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return -1;
  const [d, c = ""] = value.split(".");
  return Number(d) * 100 + Number(c.padEnd(2, "0"));
}
export function CorrectionTools({
  bill,
  onChanged,
}: {
  bill: BillView;
  onChanged: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState(
    bill.claim?.status === "Prepared" ? "Draft revision" : "Replacement",
  );
  const [lines, setLines] = useState<ChargeLine[]>(
    bill.lines.map((l) => ({ ...l })),
  );
  const [policyId, setPolicyId] = useState(bill.policy_id);
  const [requiresAuth, setRequiresAuth] = useState(
    Boolean(bill.authorization_required),
  );
  const [authId, setAuthId] = useState(bill.authorization_id || "");
  const policies = useResource<Policy[]>(
    `/workflow/finance/policies?patient_id=${bill.patient_id}&billing_account_id=${bill.billing_account_id || `pba-private-${bill.patient_id}`}`,
    [],
  );
  const authorizations = useResource<AuthorizationRow[]>(
    `/workflow/finance/authorizations?patient_id=${bill.patient_id}`,
    [],
  );
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [responding, setResponding] = useState<string | null>(null);
  const pending = bill.corrections.find((c) =>
    ["Draft", "Demo submitted"].includes(c.status),
  );
  async function run(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      await onChanged();
      setMessage(success);
      setOpen(false);
      setResponding(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function prepare(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void run(
      () =>
        post("/workflow/finance/corrections", {
          bill_id: bill.id,
          revision: bill.revision,
          kind,
          reason: f.get("reason"),
          lines: kind === "Void" ? [] : lines,
          policy_id: policyId,
          authorization_required: requiresAuth,
          authorization_id: authId,
        }),
      "Correction draft prepared. Original billing is unchanged.",
    );
  }
  return (
    <section className="correction-tools">
      <div className="section-heading">
        <div>
          <h3>Claim corrections & history</h3>
          <p className="finance-help">
            Changes preserve original claims and postings. Patient receipts
            remain as unapplied payments or credits; no refund is issued.
          </p>
        </div>
        {!pending && !bill.voided_at && bill.claim && (
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => {
              setKind(
                bill.claim!.status === "Prepared"
                  ? "Draft revision"
                  : "Replacement",
              );
              setLines(bill.lines.map((l) => ({ ...l })));
              setOpen(!open);
            }}
          >
            Correct claim
          </button>
        )}
      </div>
      {(error || policies.error || authorizations.error) && (
        <p className="form-error" role="alert">
          {error || policies.error || authorizations.error}
        </p>
      )}
      {message && (
        <p className="inline-success" role="status">
          {message}
        </p>
      )}
      {open && (
        <form className="finance-action-form" onSubmit={prepare}>
          <h3>Prepare an audited correction</h3>
          <div className="form-grid">
            <label>
              Correction type
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {bill.claim?.status === "Prepared" ? (
                  <option>Draft revision</option>
                ) : (
                  <>
                    <option>Replacement</option>
                    <option>Void</option>
                  </>
                )}
              </select>
            </label>
            <label>
              Correction policy
              <select
                value={policyId}
                onChange={(e) => setPolicyId(e.target.value)}
                disabled={kind === "Void"}
              >
                {policies.data.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.priority} · {p.payer} · {p.member_id}
                  </option>
                ))}
              </select>
            </label>
            <label className="span-2">
              Reason for correction
              <textarea name="reason" required minLength={5} maxLength={1000} />
            </label>
          </div>
          {kind !== "Void" && (
            <>
              <div className="finance-charge-lines">
                {lines.map((l, i) => (
                  <fieldset key={i}>
                    <legend>Corrected charge {i + 1}</legend>
                    <div className="form-grid">
                      <label>
                        Procedure code
                        <input
                          aria-label={`Corrected procedure ${i + 1}`}
                          value={l.code}
                          onChange={(e) =>
                            setLines(
                              lines.map((a, j) =>
                                i === j
                                  ? { ...a, code: e.target.value.toUpperCase() }
                                  : a,
                              ),
                            )
                          }
                          required
                          maxLength={5}
                        />
                      </label>
                      <label>
                        Diagnosis code
                        <input
                          aria-label={`Corrected diagnosis ${i + 1}`}
                          value={l.diagnosis}
                          onChange={(e) =>
                            setLines(
                              lines.map((a, j) =>
                                i === j
                                  ? {
                                      ...a,
                                      diagnosis: e.target.value.toUpperCase(),
                                    }
                                  : a,
                              ),
                            )
                          }
                          required
                          maxLength={8}
                        />
                      </label>
                      <label>
                        Description
                        <input
                          aria-label={`Corrected description ${i + 1}`}
                          value={l.description}
                          onChange={(e) =>
                            setLines(
                              lines.map((a, j) =>
                                i === j
                                  ? { ...a, description: e.target.value }
                                  : a,
                              ),
                            )
                          }
                          required
                          maxLength={200}
                        />
                      </label>
                      <label>
                        Units
                        <input
                          aria-label={`Corrected units ${i + 1}`}
                          type="number"
                          min="1"
                          max="100"
                          value={l.units}
                          onChange={(e) =>
                            setLines(
                              lines.map((a, j) =>
                                i === j
                                  ? { ...a, units: Number(e.target.value) }
                                  : a,
                              ),
                            )
                          }
                          required
                        />
                      </label>
                      <label>
                        Unit fee ($)
                        <input
                          aria-label={`Corrected fee ${i + 1}`}
                          type="number"
                          step="0.01"
                          min="0.01"
                          defaultValue={l.unit_cents / 100}
                          onChange={(e) =>
                            setLines(
                              lines.map((a, j) =>
                                i === j
                                  ? {
                                      ...a,
                                      unit_cents: dollars(e.target.value),
                                    }
                                  : a,
                              ),
                            )
                          }
                          required
                        />
                      </label>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() =>
                          setLines(lines.filter((_, j) => i !== j))
                        }
                      >
                        Remove corrected charge {i + 1}
                      </button>
                    </div>
                  </fieldset>
                ))}
              </div>
              <button
                type="button"
                className="button secondary"
                disabled={lines.length >= 30}
                onClick={() =>
                  setLines([
                    ...lines,
                    {
                      code: "",
                      description: "",
                      diagnosis: "",
                      units: 1,
                      unit_cents: 0,
                    },
                  ])
                }
              >
                Add corrected charge
              </button>
              <label className="finance-check">
                <input
                  type="checkbox"
                  checked={requiresAuth}
                  onChange={(e) => setRequiresAuth(e.target.checked)}
                />
                Corrected services require prior authorization
              </label>
              {requiresAuth && (
                <label>
                  Correction authorization
                  <select
                    value={authId}
                    onChange={(e) => setAuthId(e.target.value)}
                    required
                  >
                    <option value="">Select authorization</option>
                    {authorizations.data
                      .filter((a) => a.policy_id === policyId)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.description} · {a.status} ·{" "}
                          {a.approval_number || "No approval number"}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </>
          )}
          <p className="finance-help">
            {kind === "Draft revision"
              ? "Apply a reviewed draft revision locally before its first submission."
              : "Original amounts and balances remain in place until you record an accepted demo correction response."}
          </p>
          <div className="button-row">
            <button className="button primary" disabled={busy}>
              Prepare correction
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => setOpen(false)}
            >
              Discard form
            </button>
          </div>
        </form>
      )}
      {pending && (
        <div className="finance-action-form">
          <div className="finance-card-header">
            <h3>{pending.kind} correction</h3>
            <Badge>{pending.status}</Badge>
          </div>
          <p>{pending.reason}</p>
          <p className="finance-help">
            Corrected charges:{" "}
            {pending.kind === "Void"
              ? "Voided"
              : money(
                  pending.lines.reduce((n, l) => n + l.units * l.unit_cents, 0),
                )}
            . Payments and original claim changes pause while this correction is
            open.
          </p>
          <div className="button-row">
            {pending.status === "Draft" && (
              <>
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        post(
                          `/workflow/finance/corrections/${pending.id}/${pending.kind === "Draft revision" ? "apply" : "submit"}`,
                          {},
                        ),
                      pending.kind === "Draft revision"
                        ? "Draft revision applied. Original claim remains in history."
                        : "Demo correction submitted. Nothing was transmitted.",
                    )
                  }
                >
                  {pending.kind === "Draft revision"
                    ? "Apply draft revision"
                    : "Simulate correction submission"}
                </button>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        post(
                          `/workflow/finance/corrections/${pending.id}/cancel`,
                          {},
                        ),
                      "Correction cancelled. Original billing is unchanged.",
                    )
                  }
                >
                  Cancel correction
                </button>
              </>
            )}
            {pending.status === "Demo submitted" && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => setResponding(responding ? null : pending.id)}
              >
                Record correction response
              </button>
            )}
          </div>
          {responding === pending.id && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void run(
                  () =>
                    post(
                      `/workflow/finance/corrections/${pending.id}/decision`,
                      Object.fromEntries(f),
                    ),
                  "Demo correction response recorded. Review the updated balances and claim history.",
                );
              }}
            >
              <div className="form-grid">
                <label>
                  Correction outcome
                  <select name="outcome">
                    <option>Accepted</option>
                    <option>Rejected</option>
                  </select>
                </label>
                <label>
                  Correction response reference
                  <input name="reference" required maxLength={200} />
                </label>
                <label className="span-2">
                  Correction response note
                  <textarea
                    name="note"
                    required
                    minLength={5}
                    maxLength={1000}
                  />
                </label>
              </div>
              <button className="button primary" disabled={busy}>
                Save correction response
              </button>
            </form>
          )}
        </div>
      )}
      {!!bill.corrections.length && (
        <details className="finance-history">
          <summary>Correction history ({bill.corrections.length})</summary>
          {bill.corrections.map((c) => (
            <div key={c.id}>
              <strong>
                {c.kind} · {c.status}
              </strong>
              <p>{c.reason}</p>
              <p>
                Original claim {c.claim_id} · original charges{" "}
                {money(c.original_claim.total_cents)}
              </p>
              {c.response_reference && (
                <p>
                  {c.response_reference} · {c.response_note}
                </p>
              )}
              {c.history.map((h, i) => (
                <p key={i}>
                  {h.action} · {h.actor} · {clinicTimestampLabel(h.at)}
                </p>
              ))}
            </div>
          ))}
        </details>
      )}
      {bill.claim_history.length > 1 && (
        <details className="finance-history">
          <summary>Claim versions ({bill.claim_history.length})</summary>
          {bill.claim_history.map((c) => (
            <div key={c.id}>
              <strong>
                {c.kind || "Original"} · {c.status}
              </strong>
              <p>
                {c.id} · {money(c.total_cents)}
              </p>
              {c.replaces_claim_id && <p>Replaces {c.replaces_claim_id}</p>}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
