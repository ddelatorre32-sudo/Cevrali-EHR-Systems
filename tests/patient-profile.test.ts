import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import {
  emptyWorkflowState,
  workflowRequest,
  type WorkflowContext,
} from "../server/workflow-engine.js";
import { createDatabase } from "../server/database.js";
import { createApp } from "../server/app.js";

const profilePath = "/patient-profiles/pat-001";
const clinician = { id: "doc-one", name: "Provider One", email: "one@example.test", role: "clinician" };
const frontDesk = { id: "front-one", name: "Front Desk One", email: "front@example.test", role: "receptionist", is_admin: true };

function fixture() {
  const state = emptyWorkflowState();
  let serial = 0;
  const audit: [string, string][] = [];
  const ctx: WorkflowContext = {
    user: clinician,
    users: [clinician, frontDesk],
    patients: [
      { id: "pat-001", first_name: "Synthetic", last_name: "First", dob: "1990-01-02", sex: "Unknown", phone: "555-0101", email: "one@example.test", address: "Legacy address text", address_unit: "", city: "", state: "", zip_code: "", allergies: ["Penicillin"], conditions: ["Synthetic condition"], medications: [], created_at: "2026-01-01T10:00:00Z" },
      { id: "pat-002", first_name: "Synthetic", last_name: "Second", dob: "1990-01-02", sex: "Unknown", phone: "555-0102", email: "two@example.test", address: "", allergies: [], conditions: [], medications: [], created_at: "2026-01-02T10:00:00Z" },
    ],
    appointments: [], encounters: [], tasks: [], labs: [],
    now: "2026-10-23T16:00:00Z", today: "2026-10-23", local_time: "09:00",
    id: (prefix) => `${prefix}-${++serial}`,
    audit: (action, resource) => audit.push([action, resource]),
  };
  const request = (method: string, path = profilePath, body?: unknown, user = clinician): any =>
    workflowRequest(state, { ...ctx, user }, method, path, body);
  const view = () => request("GET");
  return { state, ctx, audit, request, view };
}

const status = (code: number) => (error: any) => error.status === code;
const details = {
  type: "Allergy", reaction: "Reported hives", severity: "Moderate",
  source: "Patient reported", onset_date: "2020-03-04", notes: "Reviewed synthetic history", status: "Active",
};

test("legacy allergy names remain unconfirmed and blank charts are not silently marked no-known-allergies", () => {
  const f = fixture();
  const view = f.view();
  assert.equal(view.demographics_revision, 1);
  assert.equal(view.patient.address, "Legacy address text");
  assert.equal(view.allergy.revision, 1);
  assert.equal(view.allergy.status, "Not reviewed");
  assert.equal(view.allergy.reviewed_at, null);
  assert.equal(view.allergy.reviewed_by, null);
  assert.equal(view.allergy.records.length, 1);
  assert.equal(view.allergy.records[0].name, "Penicillin");
  assert.equal(view.allergy.records[0].type, "Unconfirmed");
  assert.equal(view.allergy.records[0].severity, "Unknown");
  assert.equal(view.allergy.records[0].status, "Active");
  assert.equal(f.request("GET", "/patient-profiles/pat-002").allergy.status, "Not reviewed");
  assert.equal(view.patient.conditions, undefined);
  assert.equal(view.patient.allergies, undefined);
});

test("demographic edits are revision checked, audited, and visible to front desk without exposing clinical history", () => {
  const f = fixture();
  const initial = f.view();
  const beforeNoop = structuredClone({ state: f.state, patients: f.ctx.patients, audit: f.audit });
  const noop = f.request("PATCH", `${profilePath}/demographics`, {
    revision: 1, reason: "Verified the existing phone number", phone: f.ctx.patients[0].phone,
  }, frontDesk);
  assert.equal(noop.demographics_revision, 1);
  assert.deepEqual({ state: f.state, patients: f.ctx.patients, audit: f.audit }, beforeNoop,
    "saving unchanged details must not generate a misleading change event");
  const updated = f.request("PATCH", `${profilePath}/demographics`, {
    revision: initial.demographics_revision, reason: "Patient provided updated mailing address",
    address: "150 Synthetic Street", address_unit: "4B", city: "Boston", state: "ma", zip_code: "02108-1234", phone: "555-0111",
  }, frontDesk);
  assert.equal(updated.demographics_revision, 2);
  assert.equal(updated.patient.zip_code, "02108-1234");
  assert.equal(updated.patient.state, "MA");
  assert.equal(f.ctx.patients[0].phone, "555-0111");
  assert.equal(updated.history.length, 1);
  assert.equal(updated.history[0].section, "Demographics");
  assert.equal(updated.history[0].actor_id, frontDesk.id);
  assert.equal(updated.history[0].actor_name, frontDesk.name);
  assert.equal(updated.history[0].at, f.ctx.now);
  assert.equal(updated.history[0].before.address, "Legacy address text");
  assert.equal(updated.history[0].after.address_unit, "4B");
  const before = structuredClone({ state: f.state, patients: f.ctx.patients, audit: f.audit });
  assert.throws(() => f.request("PATCH", `${profilePath}/demographics`, {
    revision: 1, reason: "Stale browser", phone: "555-0999",
  }, frontDesk), status(409));
  assert.deepEqual({ state: f.state, patients: f.ctx.patients, audit: f.audit }, before);
  f.request("PATCH", `${profilePath}/allergies`, {
    revision: 1, reason: "Detailed clinical history", status: "Allergies recorded", reviewed: true,
    records: initial.allergy.records.map((record: any) => ({ ...record, ...details })),
  });
  const front = f.request("GET", profilePath, undefined, frontDesk);
  assert.equal(front.allergy, undefined);
  assert.equal(front.patient.allergies, undefined);
  assert.equal(front.patient.conditions, undefined);
  assert.equal(front.patient.medications, undefined);
  assert.equal(front.history.length, 1);
  assert.equal(front.history[0].section, "Demographics");
  assert.equal(JSON.stringify(front).includes("Reported hives"), false);
  assert.equal(updated.history[0].after.address_unit, "4B", "returned history remains a stable snapshot");
});

test("identity edits require duplicate review while a patient's own identity is excluded", () => {
  const f = fixture();
  f.view();
  const before = structuredClone({ state: f.state, patients: f.ctx.patients });
  const input = { revision: 1, reason: "Identity correction after source review", last_name: "Second" };
  assert.throws(() => f.request("PATCH", `${profilePath}/demographics`, input), status(409));
  assert.deepEqual({ state: f.state, patients: f.ctx.patients }, before);
  const saved = f.request("PATCH", `${profilePath}/demographics`, { ...input, duplicate_acknowledged: true });
  assert.equal(saved.patient.last_name, "Second");
  const own = f.request("PATCH", "/patient-profiles/pat-002/demographics", {
    revision: 1, reason: "Unchanged identity with phone correction", phone: "555-0150",
  });
  assert.equal(own.patient.phone, "555-0150");
  assert.equal(f.ctx.patients.length, 2);
});

test("allergy edits preserve reaction, severity and provenance and require a fresh review after changes", () => {
  const f = fixture();
  const original = f.view();
  const saved = f.request("PATCH", `${profilePath}/allergies`, {
    revision: 1, reason: "Provider reviewed patient-reported reaction", status: "Allergies recorded", reviewed: true,
    records: original.allergy.records.map((record: any) => ({ ...record, ...details })),
  });
  assert.equal(saved.allergy.revision, 2);
  assert.equal(saved.allergy.reviewed_at, f.ctx.now);
  assert.equal(saved.allergy.reviewed_by, clinician.id);
  assert.equal(saved.allergy.records[0].reaction, "Reported hives");
  assert.equal(saved.allergy.records[0].onset_date, "2020-03-04");
  assert.deepEqual(f.ctx.patients[0].allergies, ["Penicillin"]);
  const before = structuredClone({ state: f.state, patients: f.ctx.patients, audit: f.audit });
  assert.throws(() => f.request("PATCH", `${profilePath}/allergies`, {
    revision: 1, reason: "Stale allergy entry", status: "Allergies recorded", reviewed: true, records: saved.allergy.records,
  }), status(409));
  assert.deepEqual({ state: f.state, patients: f.ctx.patients, audit: f.audit }, before);
  const changed = f.request("PATCH", `${profilePath}/allergies`, {
    revision: 2, reason: "Updated reaction awaiting fresh review", status: "Allergies recorded", reviewed: false,
    records: saved.allergy.records.map((record: any) => ({ ...record, type: "Intolerance", reaction: "Patient reports rash" })),
  });
  assert.equal(changed.allergy.reviewed_at, null);
  assert.equal(changed.allergy.reviewed_by, null);
  assert.equal(changed.allergy.records[0].type, "Intolerance");
  assert.deepEqual(f.ctx.patients[0].allergies, ["Penicillin"], "active intolerance names remain in legacy safety summaries");
  assert.equal(changed.history.filter((entry: any) => entry.section === "Allergies").length, 2);
  assert.equal(saved.allergy.records[0].reaction, "Reported hives", "prior response snapshots never change");
});

test("no-known-allergy attestations require no active records and retained inactive history", () => {
  const f = fixture();
  const original = f.view();
  const before = structuredClone({ state: f.state, patients: f.ctx.patients });
  for (const body of [
    { revision: 1, reason: "Contradictory status", status: "No known allergies", reviewed: true, records: original.allergy.records },
    { revision: 1, reason: "Unreviewed attestation", status: "Not reviewed", reviewed: true, records: original.allergy.records },
    { revision: 1, reason: "NKA requires explicit clinician review", status: "No known allergies", reviewed: false, records: original.allergy.records.map((record: any) => ({ ...record, status: "Inactive" })) },
    { revision: 1, reason: "Must retain old records", status: "No known allergies", reviewed: true, records: [] },
  ]) {
    assert.throws(() => f.request("PATCH", `${profilePath}/allergies`, body));
    assert.deepEqual({ state: f.state, patients: f.ctx.patients }, before);
  }
  const saved = f.request("PATCH", `${profilePath}/allergies`, {
    revision: 1, reason: "Provider determined prior record entered in error", status: "No known allergies", reviewed: true,
    records: original.allergy.records.map((record: any) => ({ ...record, status: "Entered in error" })),
  });
  assert.equal(saved.allergy.status, "No known allergies");
  assert.equal(saved.allergy.records[0].status, "Entered in error");
  assert.equal(saved.allergy.reviewed_by, clinician.id);
  assert.deepEqual(f.ctx.patients[0].allergies, []);
});

test("invalid or unauthorized profile changes leave patient data, profile history and audits untouched", () => {
  const f = fixture();
  const original = f.view();
  const valid = { revision: 1, reason: "Review", status: "Allergies recorded", reviewed: false, records: original.allergy.records };
  const duplicate = { ...original.allergy.records[0], id: "different-id", name: "  pENICILLIN  " };
  const invalid: [string, unknown, any?][] = [
    [`${profilePath}/demographics`, { revision: 1, reason: "", phone: "555-0112" }],
    [`${profilePath}/demographics`, { revision: 1, reason: "Inject clinical data", allergies: [] }],
    [`${profilePath}/demographics`, { revision: 1, reason: "Invalid ZIP", zip_code: "1234" }],
    [`${profilePath}/demographics`, { revision: 1, reason: "Invalid future birth date", dob: "2099-01-01" }],
    [`${profilePath}/allergies`, valid, frontDesk],
    [`${profilePath}/allergies`, { ...valid, records: [...valid.records, duplicate] }],
    [`${profilePath}/allergies`, { ...valid, records: valid.records.map((record: any) => ({ ...record, onset_date: "2099-01-01" })) }],
    [`${profilePath}/allergies`, { ...valid, records: valid.records.map((record: any) => ({ ...record, onset_date: "2026-02-30" })) }],
    [`${profilePath}/allergies`, { ...valid, records: valid.records.map((record: any) => ({ ...record, severity: "Definitely safe" })) }],
  ];
  for (const [path, body, user] of invalid) {
    const before = structuredClone({ state: f.state, patients: f.ctx.patients, audit: f.audit });
    assert.throws(() => f.request("PATCH", path, body, user));
    assert.deepEqual({ state: f.state, patients: f.ctx.patients, audit: f.audit }, before);
  }
});

test("intake reconciliation retains detailed matched allergies, archives removed entries and clears outdated review", () => {
  const f = fixture();
  const original = f.view();
  const saved = f.request("PATCH", `${profilePath}/allergies`, {
    revision: 1, reason: "Clinical review", status: "Allergies recorded", reviewed: true,
    records: [...original.allergy.records.map((record: any) => ({ ...record, ...details })), {
      id: "latex-record", name: "Latex", type: "Allergy", reaction: "Contact rash", severity: "Mild", source: "Outside record", onset_date: "", notes: "Original source retained", status: "Active",
    }],
  });
  f.state.intakes.push({
    id: "intake-profile", patient_id: "pat-001", appointment_id: "not-needed-for-review", status: "Submitted", token_hash: "synthetic", expires_at: "2026-11-01T00:00:00Z", created_at: f.ctx.now, issuer_id: clinician.id,
    answers: { concern: "Synthetic review", symptoms: "", allergies: ["Penicillin", "New patient-reported allergen"], medications: [], reminder_consent: false },
  });
  f.request("PATCH", "/intakes/intake-profile/review", { reconcile: true });
  const after = f.view();
  assert.equal(after.allergy.revision, saved.allergy.revision + 1);
  assert.equal(after.allergy.reviewed_at, null);
  assert.equal(after.allergy.reviewed_by, null);
  const penicillin = after.allergy.records.find((record: any) => record.name === "Penicillin");
  assert.equal(penicillin.reaction, "Reported hives");
  assert.equal(penicillin.severity, "Moderate");
  assert.equal(penicillin.onset_date, "2020-03-04");
  assert.equal(after.allergy.records.find((record: any) => record.name === "Latex").status, "Inactive");
  const added = after.allergy.records.find((record: any) => record.name === "New patient-reported allergen");
  assert.equal(added.type, "Unconfirmed");
  assert.equal(added.source, "Patient reported");
  assert.deepEqual(f.ctx.patients[0].allergies, ["Penicillin", "New patient-reported allergen"]);
});

test("patient profile documents stay isolated between practice workflow states", () => {
  const first = fixture();
  const second = fixture();
  first.view(); second.view();
  first.request("PATCH", `${profilePath}/demographics`, { revision: 1, reason: "Practice-local edit", phone: "555-0199" });
  assert.equal(second.view().demographics_revision, 1);
  assert.equal(second.view().patient.phone, "555-0101");
  assert.equal(second.view().history.length, 0);
});

test("native profile changes persist with revisions/history after restart and leave signed notes unchanged", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cevrali-profile-"));
  const filename = join(directory, "practice.sqlite");
  let db = createDatabase(filename);
  let server = createApp(db).listen(0, "127.0.0.1");
  const listen = async () => {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  };
  let base = await listen();
  let cookie = "";
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), response };
  };
  const login = async () => {
    const response = await call("/auth/login", "POST", { email: "alex@cevrali.demo", password: "CevraliDemo2026!" });
    assert.equal(response.status, 200);
    cookie = response.response.headers.get("set-cookie")!.split(";")[0];
  };
  const stop = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  try {
    await login();
    const signedBefore = db.prepare("SELECT * FROM encounters WHERE status='Signed' ORDER BY id").all();
    const initial = await call(`/workflow${profilePath}`);
    assert.equal(initial.status, 200, JSON.stringify(initial.data));
    const demographics = await call(`/workflow${profilePath}/demographics`, "PATCH", { revision: 1, reason: "Updated patient contact", phone: "555-0189", city: "Boston", state: "MA", zip_code: "02108" });
    assert.equal(demographics.status, 200, JSON.stringify(demographics.data));
    const allergies = await call(`/workflow${profilePath}/allergies`, "PATCH", { revision: 1, reason: "Provider reviewed allergy history", status: "Allergies recorded", reviewed: true, records: initial.data.allergy.records.map((record: any) => ({ ...record, ...details })) });
    assert.equal(allergies.status, 200, JSON.stringify(allergies.data));
    const row = db.prepare("SELECT phone,city,state,zip_code,allergies FROM patients WHERE id='pat-001'").get() as Record<string, any>;
    assert.deepEqual({ ...row }, { phone: "555-0189", city: "Boston", state: "MA", zip_code: "02108", allergies: '["Penicillin"]' });
    assert.deepEqual(db.prepare("SELECT * FROM encounters WHERE status='Signed' ORDER BY id").all(), signedBefore);
    await stop(); db.close();
    db = createDatabase(filename);
    server = createApp(db).listen(0, "127.0.0.1");
    base = await listen(); cookie = "";
    await login();
    const reopened = await call(`/workflow${profilePath}`);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.data.demographics_revision, 2);
    assert.equal(reopened.data.allergy.revision, 2);
    assert.equal(reopened.data.allergy.records[0].reaction, "Reported hives");
    assert.equal(reopened.data.history.length, 2);
    assert.deepEqual(db.prepare("SELECT * FROM encounters WHERE status='Signed' ORDER BY id").all(), signedBefore);
  } finally {
    await stop(); db.close(); rmSync(directory, { recursive: true, force: true });
  }
});
