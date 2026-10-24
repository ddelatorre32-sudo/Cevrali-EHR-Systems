import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDatabase, clinicDate } from "../server/database.js";
import { createApp } from "../server/app.js";
import { loadWorkflow, saveWorkflow } from "../server/workflows.js";
import { addCalendarDays } from "../server/scheduling.js";

const directory = mkdtempSync(join(tmpdir(), "cevrali-workflows-"));
const filename = join(directory, "workflow.sqlite");
let db = createDatabase(filename);
let server: Server;
let base: string;
let cookie = "";
let front = "";
async function listen() {
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}
async function stop() {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
}
async function call(
  path: string,
  method = "GET",
  body?: unknown,
  auth = cookie,
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: auth },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json(), response };
}
before(async () => {
  await listen();
  for (const [email, clinical] of [
    ["alex@cevrali.demo", true],
    ["frontdesk@cevrali.demo", false],
  ] as const) {
    const login = await call(
      "/auth/login",
      "POST",
      { email, password: "CevraliDemo2026!" },
      "",
    );
    const value = login.response.headers.get("set-cookie")!.split(";")[0];
    if (clinical) cookie = value;
    else front = value;
  }
});
after(async () => {
  await stop();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

test("queue stages record real timestamps and reject invalid, unauthorized, and future no-show transitions", async () => {
  const queued = await call("/workflow/queue");
  assert.equal(queued.status, 200);
  assert.equal(
    queued.data.find((a: any) => a.id === "apt-004").wait_minutes,
    null,
  );
  assert.equal(
    (
      await call(
        "/workflow/visits/apt-005",
        "PATCH",
        { stage: "Waiting", room: "Room 2" },
        front,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("/workflow/visits/apt-005", "PATCH", { stage: "Ready" }))
      .status,
    409,
  );
  assert.equal(
    (
      await call(
        "/workflow/visits/apt-005",
        "PATCH",
        { stage: "Roomed", room: "Room 2" },
        front,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("/workflow/visits/apt-005", "PATCH", { stage: "Ready" }, front))
      .status,
    200,
  );
  assert.equal(
    (
      await call(
        "/workflow/visits/apt-005",
        "PATCH",
        { stage: "With clinician" },
        front,
      )
    ).status,
    403,
  );
  const state = loadWorkflow(db);
  state.visits["apt-005"].checked_in_at = new Date(
    Date.now() - 15 * 60000,
  ).toISOString();
  saveWorkflow(db, state);
  assert.equal(
    (
      await call("/workflow/visits/apt-005", "PATCH", {
        stage: "With clinician",
      })
    ).status,
    200,
  );
  const metrics = (await call("/workflow/metrics")).data;
  assert.equal(metrics.measured_visits, 1);
  assert.ok(
    metrics.average_wait_minutes >= 15 && metrics.average_wait_minutes < 16,
  );
  assert.equal(
    (await call("/workflow/visits/apt-005", "PATCH", { stage: "Checkout" }))
      .status,
    200,
  );
  assert.equal(
    (await call("/workflow/visits/apt-005", "PATCH", { stage: "Done" })).status,
    200,
  );
  assert.equal(
    (await call("/appointments")).data.find((a: any) => a.id === "apt-005")
      .status,
    "Completed",
  );
  const future = await call("/appointments", "POST", {
    patient_id: "pat-001",
    date: "2099-01-01",
    time: "15:00",
    duration: 30,
    type: "Consultation",
    reason: "Future no-show test",
  });
  assert.equal(
    (
      await call(`/workflow/visits/${future.data.id}`, "PATCH", {
        stage: "No-show",
      })
    ).status,
    400,
  );
});
test("assigned tasks preserve ownership, due dates, priorities, completion timestamps, and user-specific preferences", async () => {
  const created = await call("/workflow/tasks", "POST", {
    patient_id: "pat-002",
    title: "Review care plan",
    category: "Follow-up",
    priority: "High",
    owner_id: "usr-colleague",
    due_date: "2020-01-01",
  });
  assert.equal(created.status, 200);
  const id = created.data.id;
  const listed = (await call("/tasks")).data.find((t: any) => t.id === id);
  assert.equal(listed.owner_name, "Dr. Nina Patel");
  assert.equal(listed.priority, "High");
  assert.ok((await call("/workflow/metrics")).data.overdue_followups >= 1);
  assert.equal(
    (await call(`/workflow/tasks/${id}`, "PATCH", { owner_id: "not-a-user" }))
      .status,
    400,
  );
  assert.equal(
    (await call(`/tasks/${id}`, "PATCH", { done: true })).status,
    200,
  );
  assert.ok(
    (await call("/tasks")).data.find((t: any) => t.id === id).completed_at,
  );
  assert.equal(
    (await call("/workflow/tasks", "GET", undefined, front)).status,
    403,
  );
  await call("/workflow/preferences", "PATCH", {
    favorites: ["pat-001"],
    recent_patient: "pat-001",
    filters: [{ name: "Olivia", query: "Olivia" }],
  });
  assert.deepEqual((await call("/workflow/preferences")).data.favorites, [
    "pat-001",
  ]);
  assert.deepEqual(
    (await call("/workflow/preferences", "GET", undefined, front)).data
      .favorites,
    [],
  );
});
let intakeId: string;
test("scoped intake works without login, hashes tokens, and keeps patient reports separate until clinician review", async () => {
  const issued = await call(
    "/workflow/intake-links",
    "POST",
    { appointment_id: "apt-006" },
    front,
  );
  assert.equal(issued.status, 200);
  const token = issued.data.token;
  intakeId = issued.data.id;
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(loadWorkflow(db)).includes(token));
  const publicView = await call(`/intake-links/${token}`, "GET", undefined, "");
  assert.equal(publicView.status, 200);
  assert.equal(publicView.data.patient_name, "Noah Davis");
  assert.equal(publicView.data.medications, undefined);
  assert.equal(publicView.data.encounters, undefined);
  assert.equal(
    (
      await call(
        `/intake-links/${token}/appointment`,
        "PATCH",
        { action: "confirm" },
        "",
      )
    ).status,
    200,
  );
  const answers = {
    concern: "Inhaler review",
    symptoms: "Patient-reported update",
    allergies: ["Latex"],
    medications: [
      { name: "Reported medicine", dose: "10 mg", frequency: "Daily" },
    ],
    reminder_consent: true,
    attested: true,
  };
  assert.equal(
    (await call(`/intake-links/${token}`, "POST", answers, "")).status,
    200,
  );
  assert.deepEqual((await call("/patients/pat-006")).data.allergies, []);
  assert.equal(
    (await call(`/intake-links/${token}`, "POST", answers, "")).status,
    409,
  );
  assert.equal(
    (await call("/workflow/intakes", "GET", undefined, front)).status,
    403,
  );
  assert.equal(
    (
      await call(
        `/workflow/intakes/${intakeId}/review`,
        "PATCH",
        { reconcile: true },
        front,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(`/workflow/intakes/${intakeId}/review`, "PATCH", {
        reconcile: true,
      })
    ).status,
    200,
  );
  const chart = (await call("/patients/pat-006")).data;
  assert.deepEqual(chart.allergies, ["Latex"]);
  assert.equal(chart.medications[0].name, "Reported medicine");
  assert.ok(
    (await call("/tasks")).data.find(
      (t: any) => t.source_key === `intake:${intakeId}`,
    ).done,
  );
  assert.equal(
    (await call(`/intake-links/${"a".repeat(64)}`, "GET", undefined, ""))
      .status,
    404,
  );
});
test("regenerating an unsubmitted intake revokes the old token and expiry is enforced", async () => {
  const first = await call("/workflow/intake-links", "POST", {
    appointment_id: "apt-007",
  });
  const second = await call("/workflow/intake-links", "POST", {
    appointment_id: "apt-007",
  });
  assert.equal(
    (await call(`/intake-links/${first.data.token}`, "GET", undefined, ""))
      .status,
    410,
  );
  const state = loadWorkflow(db);
  state.intakes.find((i) => i.id === second.data.id)!.expires_at = new Date(
    Date.now() - 1000,
  ).toISOString();
  saveWorkflow(db, state);
  assert.equal(
    (await call(`/intake-links/${second.data.token}`, "GET", undefined, ""))
      .status,
    410,
  );
});
test("templates and smart phrases are reusable and unresolved prompts cannot be signed", async () => {
  assert.ok((await call("/workflow/templates")).data.length >= 3);
  const template = await call("/workflow/templates", "POST", {
    name: "Team follow-up",
    subjective: "Patient report",
    objective: "",
    assessment: "[[review]]",
    plan: "[[plan]]",
  });
  assert.equal(template.status, 200);
  assert.equal(
    (
      await call("/workflow/phrases", "POST", {
        shortcut: ".followup",
        text: "duplicate",
      })
    ).status,
    409,
  );
  const encounter = (await call("/encounters")).data.find(
    (e: any) => e.id === "enc-002",
  );
  const input = {
    chief_complaint: encounter.chief_complaint,
    subjective: encounter.subjective,
    objective: encounter.objective,
    assessment: "[[review]]",
    plan: "Follow-up plan",
    bp: encounter.bp,
    pulse: encounter.pulse,
    temperature: encounter.temperature,
    updated_at: encounter.updated_at,
    status: "Signed",
  };
  assert.equal((await call("/encounters/enc-002", "PATCH", input)).status, 400);
});
test("orders export draft FHIR, match results to the right patient, create review tasks, and acknowledge results", async () => {
  const order = await call("/workflow/orders", "POST", {
    patient_id: "pat-002",
    encounter_id: "enc-002",
    kind: "Lab",
    name: "HbA1c",
    details: "Demo laboratory order",
  });
  assert.equal(order.status, 200);
  const id = order.data.id;
  const bundle = (await call(`/workflow/orders/${id}/fhir`)).data;
  assert.equal(bundle.resourceType, "Bundle");
  assert.equal(bundle.entry[1].resource.status, "draft");
  assert.equal(bundle.entry[1].resource.subject.reference, "Patient/pat-002");
  await call(`/workflow/orders/${id}`, "PATCH", { status: "Prepared" });
  const result = {
    order_id: id,
    name: "HbA1c",
    value: "7.1",
    unit: "%",
    reference_range: "4.0–5.6",
    flag: "High",
    external_id: "external-workflow-1",
    patient_reference: "Patient/pat-001",
  };
  assert.equal((await call("/workflow/results", "POST", result)).status, 400);
  assert.equal(
    (await call("/workflow/orders")).data.find((o: any) => o.id === id).status,
    "Prepared",
  );
  const imported = await call("/workflow/results", "POST", {
    ...result,
    patient_reference: "Patient/pat-002",
  });
  assert.equal(imported.status, 200);
  const lab = (await call("/labs")).data.find(
    (r: any) => r.id === imported.data.id,
  );
  assert.equal(lab.value, "7.1");
  assert.ok(
    (await call("/patients/pat-002")).data.labs.some(
      (r: any) => r.id === imported.data.id,
    ),
  );
  const task = (await call("/tasks")).data.find(
    (t: any) => t.source_key === `result:${imported.data.id}`,
  );
  assert.equal(task.owner_id, "usr-clinician");
  assert.equal(task.priority, "High");
  assert.equal(
    (
      await call("/workflow/results", "POST", {
        ...result,
        patient_reference: "Patient/pat-002",
      })
    ).status,
    409,
  );
  assert.equal(
    (await call(`/workflow/results/${imported.data.id}/review`, "PATCH", {}))
      .status,
    200,
  );
  assert.equal(
    (await call("/tasks")).data.find((t: any) => t.id === task.id).done,
    1,
  );
  assert.equal(
    (await call("/workflow/orders")).data.find((o: any) => o.id === id).status,
    "Reviewed",
  );
  assert.equal(
    (await call("/workflow/orders", "GET", undefined, front)).status,
    403,
  );
});
test("reminders are idempotent, follow-ups have owners, and demo delivery never reports a message as sent", async () => {
  db.prepare(
    "UPDATE encounters SET created_at=datetime('now','-2 days') WHERE id='enc-002'",
  ).run();
  await call("/workflow/automation", "POST", {});
  const before = (await call("/workflow/reminders")).data.length;
  await call("/workflow/automation", "POST", {});
  assert.equal((await call("/workflow/reminders")).data.length, before);
  assert.ok(
    (await call("/tasks")).data.some(
      (t: any) =>
        t.source_key === "unsigned:enc-002" && t.owner_id === "usr-clinician",
    ),
  );
  const followup = {
    patient_id: "pat-002",
    encounter_id: "enc-002",
    due_date: clinicDate(),
    title: "Check follow-up progress",
  };
  const first = await call("/workflow/followups", "POST", followup);
  const again = await call("/workflow/followups", "POST", followup);
  assert.equal(first.data.id, again.data.id);
  const reminder = (await call("/workflow/reminders")).data.find(
    (r: any) => r.task_id === first.data.id,
  );
  assert.equal(reminder.status, "Ready");
  assert.equal(reminder.delivery, "Manual outreach");
  assert.equal(
    (
      await call(`/workflow/reminders/${reminder.id}`, "PATCH", {
        action: "record-manual",
      })
    ).status,
    200,
  );
  const settings = await call("/workflow/integrations", "PATCH", {
    lab_provider: "Demo lab",
    pharmacy_provider: "Demo pharmacy",
    messaging_provider: "Demo messages",
    reminder_channel: "Email",
  });
  assert.equal(settings.data.messaging_connected, false);
  assert.ok(
    !(await call("/workflow/reminders")).data.some(
      (r: any) => r.status === "Sent",
    ),
  );
});
test("workflow data survives restart without resetting charts or public demo preferences", async () => {
  await stop();
  db.close();
  db = createDatabase(filename);
  await listen();
  assert.equal(
    (await call("/workflow/intakes")).data.find((i: any) => i.id === intakeId)
      .status,
    "Reviewed",
  );
  assert.deepEqual((await call("/patients/pat-006")).data.allergies, ["Latex"]);
  assert.deepEqual((await call("/workflow/preferences")).data.favorites, [
    "pat-001",
  ]);
  assert.equal((await call("/workflow/orders")).data[0].status, "Reviewed");
  assert.equal((await call("/workflow/metrics?from=2026-02-30")).status, 400);
});

test("marking a missed visit persists a terminal no-show, cancels pending outreach and releases its approved treatment units", async () => {
  const serviceDate = addCalendarDays(clinicDate(), -1);
  const policy = await call("/workflow/finance/policies", "POST", {
    patient_id: "pat-008",
    billing_account_id: "pba-private-pat-008",
    payer: "Synthetic no-show coverage",
    plan: "Synthetic treatment reservation test",
    member_id: "NO-SHOW-RESERVATION-001",
    priority: "Primary",
    subscriber_name: "Ava Anderson",
    subscriber_dob: "1980-01-01",
    relationship: "Self",
    effective_date: "2020-01-01",
    end_date: "2099-01-01",
  });
  assert.equal(policy.status, 200, JSON.stringify(policy.data));
  const auth = await call("/workflow/finance/authorizations", "POST", {
    patient_id: "pat-008",
    policy_id: policy.data.id,
    procedure_codes: ["99213"],
    description: "Synthetic missed-visit authorization reservation",
    requested_visits: 1,
    valid_from: serviceDate,
    valid_to: "2099-01-01",
    due_date: clinicDate(),
  });
  assert.equal(auth.status, 200, JSON.stringify(auth.data));
  assert.equal(
    (
      await call(
        `/workflow/finance/authorizations/${auth.data.id}/submit`,
        "POST",
        {},
      )
    ).status,
    200,
  );
  const decision = await call(
    `/workflow/finance/authorizations/${auth.data.id}/decision`,
    "POST",
    {
      outcome: "Approved",
      note: "Synthetic approval for one planned office review",
      approval_number: "DEMO-NO-SHOW-001",
      approved_visits: 1,
      valid_from: serviceDate,
      valid_to: "2099-01-01",
    },
  );
  assert.equal(decision.status, 200, JSON.stringify(decision.data));
  const allowance = await call(
    "/workflow/operations/service-approvals",
    "POST",
    {
      authorization_id: auth.data.id,
      procedure_code: "99213",
      category: "Office visit",
      description: "Synthetic reserved office review",
      unit: "Visits",
      approved_quantity: 1,
      decision_note:
        "One office review available until it is actually performed",
    },
  );
  assert.equal(allowance.status, 200, JSON.stringify(allowance.data));
  const appointment = await call("/appointments", "POST", {
    patient_id: "pat-008",
    billing_account_id: "pba-private-pat-008",
    provider_id: "usr-colleague",
    date: serviceDate,
    time: "09:00",
    duration: 30,
    type: "Follow-up",
    reason: "Synthetic patient missed an authorized review",
    service_plan: {
      authorization_required: true,
      coverage_mode: "Insurance",
      services: [
        {
          approval_id: allowance.data.id,
          procedure_code: "99213",
          quantity: 1,
        },
      ],
    },
  });
  assert.equal(appointment.status, 201, JSON.stringify(appointment.data));
  const id = appointment.data.id;
  const intake = await call("/workflow/intake-links", "POST", {
    appointment_id: id,
  });
  assert.equal(intake.status, 200, JSON.stringify(intake.data));
  const state = loadWorkflow(db);
  for (const [suffix, status] of [
    ["scheduled", "Scheduled"],
    ["ready", "Ready"],
    ["historical", "Manual outreach recorded"],
  ] as const)
    state.reminders.push({
      id: `no-show-reminder-${suffix}`,
      patient_id: "pat-008",
      appointment_id: id,
      kind: "Appointment confirmation",
      channel: "Manual",
      due_date: serviceDate,
      status,
      message: "Synthetic outreach to the missed appointment",
      created_at: new Date().toISOString(),
      source_key: `no-show-test:${id}:${suffix}`,
    });
  saveWorkflow(db, state);
  const reserved = (
    await call("/workflow/operations/service-approvals")
  ).data.find((s: any) => s.id === allowance.data.id);
  assert.equal(reserved.reserved, 1);
  assert.equal(reserved.remaining, 0);

  const marked = await call(
    `/workflow/visits/${id}`,
    "PATCH",
    { stage: "No-show" },
    front,
  );
  assert.equal(marked.status, 200, JSON.stringify(marked.data));
  assert.equal(
    (db.prepare("SELECT status FROM appointments WHERE id=?").get(id) as any)
      .status,
    "No-show",
  );
  const queued = (await call(`/workflow/queue?date=${serviceDate}`)).data.find(
    (a: any) => a.id === id,
  );
  assert.equal(queued.status, "No-show");
  assert.equal(queued.stage, "No-show");
  assert.ok(Number.isFinite(Date.parse(queued.entered_at)));
  assert.equal(queued.wait_minutes, null);
  const reminders = loadWorkflow(db).reminders.filter(
    (r) => r.appointment_id === id,
  );
  assert.equal(
    reminders.find((r) => r.id === "no-show-reminder-scheduled")?.status,
    "Cancelled",
  );
  assert.equal(
    reminders.find((r) => r.id === "no-show-reminder-ready")?.status,
    "Cancelled",
  );
  assert.equal(
    reminders.find((r) => r.id === "no-show-reminder-historical")?.status,
    "Manual outreach recorded",
  );
  for (let attempt = 0; attempt < 2; attempt++)
    assert.equal((await call("/workflow/automation", "POST", {})).status, 200);
  assert.equal(
    loadWorkflow(db).reminders.filter((r) => r.appointment_id === id).length,
    reminders.length,
    "Automation must not recreate outreach for a terminal missed visit",
  );

  for (const status of ["Checked in", "In progress", "Cancelled"]) {
    const rejected = await call(`/appointments/${id}`, "PATCH", { status });
    assert.equal(
      rejected.status,
      409,
      `${status}: ${JSON.stringify(rejected.data)}`,
    );
  }
  for (const stage of ["Waiting", "With clinician"]) {
    const rejected = await call(`/workflow/visits/${id}`, "PATCH", { stage });
    assert.equal(
      rejected.status,
      409,
      `${stage}: ${JSON.stringify(rejected.data)}`,
    );
  }
  assert.equal(
    (await call("/workflow/intake-links", "POST", { appointment_id: id }))
      .status,
    409,
  );
  for (const action of ["confirm", "cancel"]) {
    const rejected = await call(
      `/intake-links/${intake.data.token}/appointment`,
      "PATCH",
      { action },
      "",
    );
    assert.ok(
      [409, 410].includes(rejected.status),
      `${action}: ${JSON.stringify(rejected.data)}`,
    );
  }
  const submitted = await call(
    `/intake-links/${intake.data.token}`,
    "POST",
    {
      concern: "Attempted late intake for a terminal missed visit",
      symptoms: "",
      allergies: [],
      medications: [],
      reminder_consent: false,
      attested: true,
    },
    "",
  );
  assert.ok(
    [409, 410].includes(submitted.status),
    JSON.stringify(submitted.data),
  );
  assert.equal(
    (
      await call("/encounters", "POST", {
        patient_id: "pat-008",
        appointment_id: id,
        chief_complaint: "A missed visit must never create an encounter",
      })
    ).status,
    409,
  );
  assert.equal(
    db.prepare("SELECT id FROM encounters WHERE appointment_id=?").get(id),
    undefined,
  );
  const released = (
    await call("/workflow/operations/service-approvals")
  ).data.find((s: any) => s.id === allowance.data.id);
  assert.equal(released.reserved, 0);
  assert.equal(released.completed, 0);
  assert.equal(released.remaining, 1);
  assert.equal(loadWorkflow(db).visits[id].stage, "No-show");
});
