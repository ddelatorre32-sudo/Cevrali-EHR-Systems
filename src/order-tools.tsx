import { clinicDate } from "./clinic-dates";
import { useState, type FormEvent } from "react";
import { VisitFinanceContext } from "./finance-ui";
import {
  ArrowDownToLine,
  Check,
  FileDown,
  FlaskConical,
  Plus,
  RefreshCw,
} from "lucide-react";
import { api, patch, post } from "./api";
import { Badge, Empty, Modal, fullName, prettyDate, mrn } from "./components";
import { useResource, IntakePage } from "./workflow-ui";
import type { CareOrder, CareTask } from "../server/workflow-engine";
import type { Encounter, Lab, Patient } from "./types";

type Order = CareOrder & { first_name: string; last_name: string };
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(
    new Date(),
  );
function downloadJson(data: unknown, filename: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], {
      type: "application/fhir+json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function OrderComposer({
  patients,
  patientId,
  encounterId,
  onSaved,
}: {
  patients: Patient[];
  patientId?: string;
  encounterId?: string;
  onSaved: () => Promise<unknown> | void;
}) {
  const [kind, setKind] = useState("Lab");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form).entries());
    setBusy(true);
    setError("");
    try {
      await post("/workflow/orders", {
        ...values,
        patient_id: patientId || values.patient_id,
        encounter_id: encounterId || null,
      });
      setSuccess("Draft order created. It has not been transmitted.");
      form.reset();
      setKind("Lab");
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="order-composer form-stack" onSubmit={submit}>
      {!patientId && (
        <label>
          Patient
          <select name="patient_id" required defaultValue="">
            <option value="" disabled>
              Select a patient
            </option>
            {patients.map((p) => (
              <option value={p.id} key={p.id}>
                {fullName(p)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Order type
        <select
          name="kind"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option>Lab</option>
          <option>Referral</option>
          <option>Medication</option>
        </select>
      </label>
      <label>
        {kind === "Medication"
          ? "Medication name"
          : kind === "Referral"
            ? "Specialty / service"
            : "Test name"}
        <input
          name="name"
          required
          maxLength={200}
          placeholder={
            kind === "Lab"
              ? "e.g. Complete blood count"
              : kind === "Referral"
                ? "e.g. Physical therapy"
                : "Medication to be reviewed"
          }
        />
      </label>
      <label>
        {kind === "Medication"
          ? "Dose, route, frequency, and instructions"
          : "Clinical question and instructions"}
        <textarea name="details" required maxLength={3000} rows={3} />
      </label>
      {kind === "Medication" && (
        <>
          <p className="form-hint">
            This creates a medication order draft. It does not prescribe,
            dispense, or run drug-interaction checks.
          </p>
          <label className="checkbox-label">
            <input type="checkbox" required />I have reviewed the patient’s
            recorded medications and allergies.
          </label>
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="inline-success" role="status">
          {success}
        </p>
      )}
      <button className="button primary small" disabled={busy}>
        <Plus size={14} />
        {busy ? "Creating…" : "Create draft order"}
      </button>
    </form>
  );
}

function ResultForm({
  order,
  onSaved,
}: {
  order: Order;
  onSaved: () => Promise<unknown>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState({
    name: order.name,
    value: "",
    unit: "",
    reference_range: "",
    flag: "",
    external_id: "",
  });
  async function importFile(file?: File) {
    if (!file) return;
    setError("");
    try {
      if (file.size > 1000000)
        throw new Error("Choose a FHIR Observation smaller than 1 MB");
      const observation = JSON.parse(await file.text());
      if (
        observation.resourceType !== "Observation" ||
        !["final", "amended", "corrected"].includes(observation.status)
      )
        throw new Error(
          "Choose a final, amended, or corrected FHIR R4 Observation",
        );
      if (observation.subject?.reference !== `Patient/${order.patient_id}`)
        throw new Error(
          "Observation patient reference does not match this order",
        );
      if (
        observation.basedOn?.length &&
        !observation.basedOn.some(
          (r: { reference?: string }) =>
            r.reference === `ServiceRequest/${order.id}`,
        )
      )
        throw new Error("Observation does not reference this lab order");
      const value = observation.valueQuantity?.value ?? observation.valueString;
      if (value === undefined || !observation.id)
        throw new Error(
          "Observation requires an ID and a quantity or string result",
        );
      const flagCode = observation.interpretation?.[0]?.coding?.[0]?.code;
      const flag =
        (
          {
            H: "High",
            HH: "High",
            L: "Low",
            LL: "Low",
            A: "Abnormal",
            N: "Normal",
          } as Record<string, string>
        )[flagCode] || "";
      setValues({
        name:
          observation.code?.text ||
          observation.code?.coding?.[0]?.display ||
          order.name,
        value: String(value),
        unit: observation.valueQuantity?.unit || "",
        reference_range: observation.referenceRange?.[0]?.text || "",
        flag,
        external_id: String(observation.id),
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post("/workflow/results", {
        ...values,
        order_id: order.id,
        patient_reference: `Patient/${order.patient_id}`,
      });
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form-grid result-form" onSubmit={submit}>
      <p className="form-hint span-2">
        Record a result received outside this demo, or load a FHIR Observation
        file for review. Verify the patient and test before saving.
      </p>
      <label className="span-2">
        Load FHIR Observation
        <input
          type="file"
          accept=".json,application/json,application/fhir+json"
          onChange={(e) => importFile(e.target.files?.[0])}
        />
      </label>
      <label className="span-2">
        Test name
        <input
          value={values.name}
          required
          maxLength={200}
          onChange={(e) => setValues({ ...values, name: e.target.value })}
        />
      </label>
      <label>
        Result
        <input
          value={values.value}
          required
          maxLength={200}
          onChange={(e) => setValues({ ...values, value: e.target.value })}
        />
      </label>
      <label>
        Units
        <input
          value={values.unit}
          maxLength={80}
          onChange={(e) => setValues({ ...values, unit: e.target.value })}
        />
      </label>
      <label>
        Reference range
        <input
          value={values.reference_range}
          maxLength={200}
          onChange={(e) =>
            setValues({ ...values, reference_range: e.target.value })
          }
        />
      </label>
      <label>
        Flag
        <select
          value={values.flag}
          required
          onChange={(e) => setValues({ ...values, flag: e.target.value })}
        >
          <option value="" disabled>
            Select a flag after review
          </option>
          <option>Normal</option>
          <option>High</option>
          <option>Low</option>
          <option>Abnormal</option>
        </select>
      </label>
      <label className="span-2">
        External result ID
        <input
          value={values.external_id}
          required
          maxLength={200}
          onChange={(e) =>
            setValues({ ...values, external_id: e.target.value })
          }
        />
      </label>
      {error && (
        <p className="form-error span-2" role="alert">
          {error}
        </p>
      )}
      <button className="button primary span-2" disabled={busy}>
        Save result & create review task
      </button>
    </form>
  );
}

export function OrderList({
  patientId,
  patients,
  encounterId,
}: {
  patientId?: string;
  patients: Patient[];
  encounterId?: string;
}) {
  const resource = useResource<Order[]>(
    `/workflow/orders${patientId ? `?patient_id=${patientId}` : ""}`,
    [],
  );
  const results = useResource<
    (Lab & { order_id?: string; reviewed_at?: string })[]
  >("/labs", []);
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<Order | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await resource.reload();
      await results.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel orders-panel">
      <div className="panel-heading">
        <div>
          <h2>Orders & connected results</h2>
          <p className="section-caption">
            Demo workflow · Orders and prescriptions are never transmitted
          </p>
        </div>
        <button
          className="button primary small"
          onClick={() => setShowCreate((v) => !v)}
        >
          <Plus size={14} />
          New order
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {resource.error && (
        <p className="form-error" role="alert">
          {resource.error}
        </p>
      )}
      {showCreate && (
        <div className="embedded-composer">
          <OrderComposer
            patients={patients}
            patientId={patientId}
            encounterId={encounterId}
            onSaved={async () => {
              await resource.reload();
              setShowCreate(false);
            }}
          />
        </div>
      )}
      <div className="workflow-list">
        {resource.data.map((order) => (
          <article className="order-card" key={order.id}>
            <div className="section-heading">
              <div>
                <strong>{order.name}</strong>
                <p>
                  {fullName(order)} · {order.kind} ·{" "}
                  {prettyDate(order.created_at)}
                </p>
              </div>
              <Badge>{order.status}</Badge>
            </div>
            <p className="order-detail">{order.details}</p>
            <div className="button-row">
              {order.status === "Draft" && (
                <button
                  className="button secondary small"
                  disabled={busy}
                  onClick={() =>
                    run(() =>
                      patch(`/workflow/orders/${order.id}`, {
                        status: "Prepared",
                      }),
                    )
                  }
                >
                  Mark reviewed & prepared
                </button>
              )}
              {!["Cancelled"].includes(order.status) && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    run(async () =>
                      downloadJson(
                        await api(`/workflow/orders/${order.id}/fhir`),
                        `${order.id}-draft.fhir.json`,
                      ),
                    )
                  }
                >
                  <FileDown size={14} />
                  Export FHIR draft
                </button>
              )}
              {order.kind === "Lab" && order.status === "Prepared" && (
                <button
                  className="button primary small"
                  onClick={() => setSelected(order)}
                >
                  Record received result
                </button>
              )}
              {["Draft", "Prepared"].includes(order.status) && (
                <button
                  className="text-button cancel-link"
                  disabled={busy}
                  onClick={() =>
                    run(() =>
                      patch(`/workflow/orders/${order.id}`, {
                        status: "Cancelled",
                      }),
                    )
                  }
                >
                  Cancel order
                </button>
              )}
            </div>
            {results.data
              .filter((r) => r.order_id === order.id)
              .map((result) => (
                <div className="matched-result" key={result.id}>
                  <strong>
                    {result.name}: {result.value} {result.unit}
                  </strong>
                  <Badge>{result.flag}</Badge>
                  {result.reviewed_at ? (
                    <span className="inline-success">Reviewed</span>
                  ) : (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        run(() =>
                          patch(`/workflow/results/${result.id}/review`, {}),
                        )
                      }
                    >
                      Acknowledge result
                    </button>
                  )}
                </div>
              ))}
          </article>
        ))}
        {!resource.loading && !resource.data.length && (
          <Empty
            icon={FlaskConical}
            title="No orders yet"
            description="Create a lab, referral, or medication draft for a patient."
          />
        )}
      </div>
      {selected && (
        <Modal
          title="Record a received result"
          subtitle={`${fullName(selected)} · ${selected.name}`}
          onClose={() => setSelected(null)}
        >
          <div className="modal-body">
            <ResultForm
              order={selected}
              onSaved={async () => {
                await resource.reload();
                await results.reload();
                setSelected(null);
              }}
            />
          </div>
        </Modal>
      )}
    </section>
  );
}

export function VisitContextPanel({ encounter }: { encounter: Encounter }) {
  const tasks = useResource<CareTask[]>("/workflow/tasks", []);
  const chart = useResource<Patient | null>(
    `/patients/${encounter.patient_id}`,
    null,
  );
  const [tab, setTab] = useState("Summary");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  async function followup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await post("/workflow/followups", {
        patient_id: encounter.patient_id,
        encounter_id: encounter.id,
        due_date: f.get("due_date"),
        title: f.get("title"),
      });
      setSuccess("Follow-up task and reminder created.");
      await tasks.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="visit-context">
      <div className="visit-context-heading">
        <p className="eyebrow">VISIT WORKSPACE</p>
        <h3>{chart.data ? fullName(chart.data) : "Patient context"}</h3>
        <small>{mrn(encounter.patient_id)}</small>
      </div>
      <div className="tabs">
        <button
          className={tab === "Intake" ? "active" : ""}
          onClick={() => setTab("Intake")}
        >
          Intake
        </button>
        <button
          className={tab === "Summary" ? "active" : ""}
          onClick={() => setTab("Summary")}
        >
          Summary
        </button>
        <button
          className={tab === "Orders" ? "active" : ""}
          onClick={() => setTab("Orders")}
        >
          Orders
        </button>
        <button
          className={tab === "Follow-up" ? "active" : ""}
          onClick={() => setTab("Follow-up")}
        >
          Follow-up
        </button>
        <button
          className={tab === "Billing" ? "active" : ""}
          onClick={() => setTab("Billing")}
        >
          Billing
        </button>
      </div>
      {chart.error && (
        <p className="form-error" role="alert">
          {chart.error}
        </p>
      )}
      {tab === "Billing" && (
        <VisitFinanceContext patientId={encounter.patient_id} />
      )}
      {tab === "Summary" && chart.data && (
        <div className="visit-summary">
          <section>
            <h4>Allergies</h4>
            <p className="allergy-summary">
              {chart.data.allergies?.join(", ") || (chart.data.allergy_profile?.status === "No known allergies" ? "No known allergies" : "Allergies not yet reviewed")}
            </p>
            {chart.data.allergy_profile?.records.filter((record) => record.status === "Active" && (record.reaction || record.severity !== "Unknown")).map((record) => <p key={record.id} className={["Severe", "Life-threatening"].includes(record.severity) ? "allergy-severity-high" : "muted"}>{record.name}: {record.type} · {record.severity}{record.reaction ? ` · ${record.reaction}` : ""}</p>)}
          </section>
          <section>
            <h4>Active conditions</h4>
            {chart.data.conditions?.length ? (
              chart.data.conditions.map((c) => <p key={c}>{c}</p>)
            ) : (
              <p>None recorded</p>
            )}
          </section>
          <section>
            <h4>Recorded medications</h4>
            {chart.data.medications?.length ? (
              chart.data.medications.map((m) => (
                <p key={m.name}>
                  <strong>{m.name}</strong>
                  <br />
                  {m.dose} · {m.frequency}
                </p>
              ))
            ) : (
              <p>None recorded</p>
            )}
          </section>
          <section>
            <h4>Recent results</h4>
            {chart.data.labs?.length ? (
              chart.data.labs.slice(0, 3).map((l) => (
                <p key={l.id}>
                  {l.name}:{" "}
                  <strong>
                    {l.value} {l.unit}
                  </strong>{" "}
                  · {l.flag}
                </p>
              ))
            ) : (
              <p>No results recorded</p>
            )}
          </section>
          <p className="section-caption">
            Patient-reported changes are in the Intake tab. Review before
            reconciling the chart.
          </p>
        </div>
      )}
      {tab === "Orders" && (
        <OrderList
          patientId={encounter.patient_id}
          patients={chart.data ? [chart.data] : []}
          encounterId={encounter.id}
        />
      )}
      {tab === "Intake" && (
        <IntakePage
          patientId={encounter.patient_id}
          onChanged={async () => {
            await chart.reload();
            await tasks.reload();
          }}
        />
      )}
      {tab === "Follow-up" && (
        <form className="form-stack visit-followup" onSubmit={followup}>
          <h4>Plan the next step</h4>
          <label>
            Follow-up task
            <input
              name="title"
              required
              maxLength={200}
              placeholder="e.g. Review progress with patient"
            />
          </label>
          <label>
            Due date
            <input
              type="date"
              name="due_date"
              required
              defaultValue={clinicDate(new Date(Date.now() + 7 * 86400000))}
            />
          </label>
          <p className="section-caption">
            Creates an assigned task and a demo reminder; no message is sent.
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {success && (
            <p className="inline-success" role="status">
              {success}
            </p>
          )}
          <button className="button primary small" disabled={busy}>
            Create follow-up
          </button>
          <div className="visit-task-list">
            <h4>Open care tasks</h4>
            {tasks.data
              .filter((t) => t.patient_id === encounter.patient_id && !t.done)
              .map((task) => (
                <div key={task.id}>
                  <strong>{task.title}</strong>
                  <small>
                    Due {task.due_date ? prettyDate(task.due_date) : "not set"}
                  </small>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      patch(`/workflow/tasks/${task.id}`, { done: true })
                        .then(tasks.reload)
                        .catch((e) => setError(e.message))
                    }
                  >
                    Mark complete
                  </button>
                </div>
              ))}
            {tasks.error && (
              <p className="form-error" role="alert">
                {tasks.error}
              </p>
            )}
          </div>
        </form>
      )}
    </aside>
  );
}

export function IntegrationsPage() {
  type Settings = {
    lab_provider: string;
    pharmacy_provider: string;
    messaging_provider: string;
    reminder_channel: string;
    requirement: string;
    can_manage: boolean;
  };
  const resource = useResource<Settings | null>("/workflow/integrations", null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !resource.data?.can_manage) return;
    const values = Object.fromEntries(
      new FormData(event.currentTarget).entries(),
    );
    setError("");
    setSuccess("");
    setSaving(true);
    try {
      await patch("/workflow/integrations", values);
      await resource.reload();
      setSuccess(
        "Demo integration preferences saved. Live delivery remains disconnected.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="workflow-stack">
      <div className="integration-grid">
        {[
          {
            name: "Lab services",
            desc: "Prepare lab orders, export FHIR R4 drafts, and record matched received results with an assigned review task.",
            capability: "FHIR draft export & result review",
          },
          {
            name: "Pharmacy & referrals",
            desc: "Document medication and referral requests for review. Export drafts for a future provider-specific connection.",
            capability: "Drafts only · No e-prescribing",
          },
          {
            name: "Patient reminders",
            desc: "Generate an outbox for confirmations and follow-ups. Track consent and manually completed outreach.",
            capability: "Outbox only · No messages sent",
          },
        ].map((i) => (
          <article className="panel integration-card" key={i.name}>
            <Badge>Demo mode</Badge>
            <h2>{i.name}</h2>
            <p>{i.desc}</p>
            <strong>{i.capability}</strong>
            <span className="section-caption">
              Live connection: not connected
            </span>
          </article>
        ))}
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>Plan your service connections</h2>
        </div>
        {resource.error && (
          <p className="form-error" role="alert">
            {resource.error}
          </p>
        )}
        {resource.data && (
          <form
            className="modal-body form-grid"
            key={JSON.stringify(resource.data)}
            onSubmit={save}
          >
            <fieldset
              className="form-grid span-2"
              disabled={!resource.data.can_manage || saving}
              style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}
            >
            <label>
              Lab provider name
              <input
                name="lab_provider"
                defaultValue={resource.data.lab_provider}
                maxLength={150}
                placeholder="Not selected"
              />
            </label>
            <label>
              Pharmacy / e-prescribing provider
              <input
                name="pharmacy_provider"
                defaultValue={resource.data.pharmacy_provider}
                maxLength={150}
                placeholder="Not selected"
              />
            </label>
            <label>
              Messaging provider name
              <input
                name="messaging_provider"
                defaultValue={resource.data.messaging_provider}
                maxLength={150}
                placeholder="Not selected"
              />
            </label>
            <label>
              Preferred reminder channel
              <select
                name="reminder_channel"
                defaultValue={resource.data.reminder_channel}
              >
                <option>Manual</option>
                <option>Email</option>
                <option>SMS</option>
              </select>
            </label>
            </fieldset>
            <p className="form-hint span-2">
              {resource.data.requirement} Do not enter API keys or credentials
              in these fields.
            </p>
            {error && (
              <p className="form-error span-2" role="alert">
                {error}
              </p>
            )}
            {success && (
              <p className="inline-success span-2" role="status">
                {success}
              </p>
            )}
            {resource.data.can_manage ? (
              <footer className="modal-footer span-2">
                <button className="button primary" disabled={saving}>
                  {saving ? "Saving…" : "Save demo preferences"}
                </button>
              </footer>
            ) : (
              <p className="form-hint span-2">
                Ask your practice administrator to update these connection preferences.
              </p>
            )}
          </form>
        )}
      </section>
    </div>
  );
}

export function MetricsPage() {
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const resource = useResource<any>(
    `/workflow/metrics?from=${from}&to=${to}`,
    null,
  );
  const data = resource.data;
  const cards = data
    ? [
        {
          label: "Completed visits",
          value: `${data.completed} / ${data.appointments}`,
          note: "Non-cancelled appointments in range",
        },
        {
          label: "Average check-in wait",
          value:
            data.average_wait_minutes === null
              ? "—"
              : `${Math.round(data.average_wait_minutes)} min`,
          note: `${data.measured_visits} visits with check-in and care-start timestamps`,
        },
        {
          label: "No-show rate",
          value: data.appointments
            ? `${Math.round((data.no_shows / data.appointments) * 100)}%`
            : "—",
          note: `${data.no_shows} no-shows / ${data.appointments} non-cancelled appointments`,
        },
        {
          label: "Unsigned notes",
          value: data.unsigned_notes,
          note: "Current documentation backlog",
        },
        {
          label: "Overdue follow-ups",
          value: data.overdue_followups,
          note: "Current open follow-ups due before today",
        },
        {
          label: "Task turnaround",
          value:
            data.average_task_hours === null
              ? "—"
              : `${data.average_task_hours.toFixed(1)} h`,
          note: `${data.measured_tasks} completed tasks with creation and completion timestamps`,
        },
      ]
    : [];
  return (
    <div className="workflow-stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Practice operations</h2>
            <p className="section-caption">
              Recorded workflow data · Historical waits without timestamps are
              excluded
            </p>
          </div>
          <div className="metrics-range">
            <label>
              From
              <input
                aria-label="Metrics from"
                type="date"
                value={from}
                onChange={(e) => {
                  if (e.target.value) setFrom(e.target.value);
                }}
              />
            </label>
            <label>
              To
              <input
                aria-label="Metrics to"
                type="date"
                value={to}
                onChange={(e) => {
                  if (e.target.value) setTo(e.target.value);
                }}
              />
            </label>
          </div>
        </div>
        {resource.error && (
          <p className="form-error" role="alert">
            {resource.error}
          </p>
        )}
      </section>
      <div className="metrics-grid">
        {cards.map((c) => (
          <article className="panel metric-card" key={c.label}>
            <p>{c.label}</p>
            <strong>{c.value}</strong>
            <small>{c.note}</small>
          </article>
        ))}
      </div>
      {data && (
        <section className="panel">
          <div className="panel-heading">
            <h2>Visit flow for selected dates</h2>
            <span className="subtle-label">
              {data.cancelled} cancelled · {data.overdue_tasks} currently
              overdue tasks
            </span>
          </div>
          <div className="metrics-flow">
            {data.statuses.map((s: { stage: string; count: number }) => (
              <div key={s.stage}>
                <span>{s.stage}</span>
                <div>
                  <i
                    style={{
                      width: `${data.appointments ? (s.count / data.appointments) * 100 : 0}%`,
                    }}
                  />
                </div>
                <strong>{s.count}</strong>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
