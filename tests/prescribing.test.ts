import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { createDatabase, hashPassword } from "../server/database.js";
import { createApp } from "../server/app.js";
import { createPlatformApp } from "../server/platform.js";
import { loadWorkflow, saveWorkflow } from "../server/workflows.js";
import { emptyWorkflowState, readWorkflowState } from "../server/workflow-engine.js";
import type { PrescriptionFields, PrescriptionView } from "../server/prescribing-model.js";

const basePath = "/workflow/prescribing";
const password = "CevraliDemo2026!";
const syntheticFields: PrescriptionFields = {
  medication_name: "Synthetic example medication", strength: "5 mg", dose: "5 mg",
  route: "Oral", frequency: "Once daily", instructions: "Synthetic workflow fixture; not a clinical instruction.",
  quantity: 30, quantity_unit: "tablets", days_supply: 30, refills: 0,
  pharmacy: { name: "Synthetic Demo Pharmacy", address: "100 Synthetic Street, Boston MA 02108", phone: "555-0109" },
  controlled_schedule: "Non-controlled",
};
const reviewFields = {
  allergies_reviewed: true, medications_reviewed: true, classification_confirmed: true,
  pdmp_reviewed: true, safety_note: "Prescriber manually reviewed this synthetic example; no automated interaction or PDMP service was queried.",
};

async function fixture() {
  const db = createDatabase(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let clinical = "", colleague = "", front = "";
  const call = async (path: string, method = "GET", body?: unknown, cookie = clinical) => {
    const response = await fetch(base + path, {
      method, headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = { text }; }
    return { status: response.status, data, cookie: response.headers.get("set-cookie")?.split(";")[0] || "" };
  };
  const login = async (email: string) => {
    const result = await call("/auth/login", "POST", { email, password }, "");
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.cookie;
  };
  clinical = await login("alex@cevrali.demo");
  colleague = await login("nina@cevrali.demo");
  front = await login("frontdesk@cevrali.demo");
  const create = async (changes: Record<string, unknown> = {}, cookie = clinical) => {
    const result = await call(basePath, "POST", {
      ...syntheticFields, patient_id: "pat-001", encounter_id: null,
      billing_account_id: "pba-private-pat-001", client_id: randomUUID(), ...changes,
    }, cookie);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data as PrescriptionView;
  };
  const reviewContext = async (rx: PrescriptionView, cookie = clinical) => {
    const result = await call(`${basePath}/${rx.id}/review-context`, "GET", undefined, cookie);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.prescription.id, rx.id);
    assert.match(result.data.context_fingerprint, /^[a-f0-9]{64}$/);
    return result.data;
  };
  const review = async (rx: PrescriptionView, changes: Record<string, unknown> = {}, cookie = clinical) => {
    const context = await reviewContext(rx, cookie);
    const result = await call(`${basePath}/${rx.id}/review`, "POST", { revision: rx.revision,
      context_fingerprint: context.context_fingerprint, ...reviewFields, ...changes }, cookie);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data as PrescriptionView;
  };
  const challenge = async (rx: PrescriptionView, cookie = clinical) => {
    const result = await call(`${basePath}/${rx.id}/challenge`, "POST", { revision: rx.revision }, cookie);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  };
  const sign = (rx: PrescriptionView, changes: Record<string, unknown> = {}, cookie = clinical) =>
    call(`${basePath}/${rx.id}/sign`, "POST", { revision: rx.revision, client_id: randomUUID(), ...changes }, cookie);
  const close = async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  };
  return { db, call, login, create, reviewContext, review, challenge, sign, close,
    get clinical() { return clinical; }, get colleague() { return colleague; }, get front() { return front; } };
}

test("prescribing state migrates additively and the workspace reports disconnected safety and pharmacy services", async () => {
  const previous = emptyWorkflowState();
  delete (previous as Partial<typeof previous>).prescribing;
  previous.preferences.existing = { favorites: ["pat-001"], recent: [], filters: [] };
  const restored = readWorkflowState(JSON.stringify(previous));
  assert.deepEqual(restored.prescribing.prescriptions, []);
  assert.deepEqual(restored.preferences, previous.preferences);
  const f = await fixture();
  try {
    assert.equal((await f.call(`${basePath}?patient_id=pat-001`, "GET", undefined, "")).status, 401);
    const workspace = await f.call(`${basePath}?patient_id=pat-001`);
    assert.equal(workspace.status, 200, JSON.stringify(workspace.data));
    assert.equal(workspace.data.patient.id, "pat-001");
    assert.equal(workspace.data.mode, "Demo only");
    assert.equal(workspace.data.pharmacy_connected, false);
    assert.equal(workspace.data.epcs_connected, false);
    assert.equal(workspace.data.interaction_checks_available, false);
    assert.ok(Array.isArray(workspace.data.patient.medications));
    assert.ok(Array.isArray(workspace.data.patient.allergies));
    for (const suffix of ["unknown/extra", "settings/extra", "refills/unknown/extra"])
      assert.equal((await f.call(`${basePath}/${suffix}`)).status, 404);
  } finally { await f.close(); }
});

test("a reviewed ordinary prescription records a simulation without changing medications or signed clinical notes", async () => {
  const f = await fixture();
  try {
    const originalPatient = (await f.call("/patients/pat-001")).data;
    const originalNotes = f.db.prepare("SELECT * FROM encounters WHERE patient_id=?").all("pat-001");
    const rx = await f.create();
    assert.equal(rx.status, "Draft");
    assert.equal(rx.pharmacy_transmitted, false);
    assert.equal((await f.sign(rx)).status, 409, "drafts require an explicit current safety review");
    const ready = await f.review(rx);
    assert.equal(ready.status, "Ready for demo signing");
    assert.equal(ready.review_current, true);
    const signed = await f.sign(ready);
    assert.equal(signed.status, 200, JSON.stringify(signed.data));
    assert.equal(signed.data.ok, true);
    const saved = signed.data.prescription;
    assert.equal(saved.status, "Simulated — not sent");
    assert.equal(saved.pharmacy_transmitted, false);
    assert.equal(saved.snapshot.pharmacy_transmitted, false);
    assert.equal(saved.snapshot.authentication, "Demo review confirmation");
    assert.equal(saved.snapshot.prescriber.id, "usr-clinician");
    assert.equal(saved.snapshot.patient.id, "pat-001");
    assert.deepEqual(saved.snapshot.fields, syntheticFields);
    assert.deepEqual((await f.call("/patients/pat-001")).data.medications, originalPatient.medications);
    assert.deepEqual(f.db.prepare("SELECT * FROM encounters WHERE patient_id=?").all("pat-001"), originalNotes);
    assert.equal((await f.call(`${basePath}/${rx.id}`, "PATCH", { revision: saved.revision, dose: "10 mg" })).status, 409);
    const list = await f.call(`${basePath}/queue`);
    assert.equal(list.status, 200);
    assert.ok(list.data.some((item: PrescriptionView) => item.id === rx.id && item.pharmacy_transmitted === false));
  } finally { await f.close(); }
});

test("draft creation and successful signing reuse request IDs without duplicate records, history, or signing audit entries", async () => {
  const f = await fixture();
  try {
    const body = { ...syntheticFields, patient_id: "pat-001", encounter_id: null,
      billing_account_id: "pba-private-pat-001", client_id: randomUUID() };
    const first = await f.call(basePath, "POST", body);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const duplicate = await f.call(basePath, "POST", body);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.data.id, first.data.id);
    assert.equal((await f.call(basePath, "POST", { ...body, dose: "changed" })).status, 409);
    const ready = await f.review(first.data);
    const signing = { revision: ready.revision, client_id: randomUUID() };
    const signed = await f.call(`${basePath}/${ready.id}/sign`, "POST", signing);
    assert.equal(signed.status, 200, JSON.stringify(signed.data));
    assert.equal(signed.data.ok, true);
    const before = JSON.stringify(loadWorkflow(f.db).prescribing);
    const audits = Number((f.db.prepare("SELECT count(*) n FROM audit").get() as { n: number }).n);
    const retry = await f.call(`${basePath}/${ready.id}/sign`, "POST", signing);
    assert.equal(retry.status, 200, JSON.stringify(retry.data));
    assert.equal(retry.data.ok, true);
    assert.deepEqual(retry.data.prescription.snapshot, signed.data.prescription.snapshot);
    assert.equal(JSON.stringify(loadWorkflow(f.db).prescribing), before);
    assert.equal(Number((f.db.prepare("SELECT count(*) n FROM audit").get() as { n: number }).n), audits);
    assert.equal(loadWorkflow(f.db).prescribing.prescriptions.length, 1);
  } finally { await f.close(); }
});

test("controlled simulation checks the actual prescriber password and one-use code and never stores those secrets", async () => {
  const f = await fixture();
  try {
    const ready = await f.review(await f.create({ controlled_schedule: "II" }));
    const challenge = await f.challenge(ready);
    assert.match(challenge.demo_code, /^\d{6}$/);
    assert.ok(Date.parse(challenge.expires_at) > Date.now());
    assert.ok(Date.parse(challenge.expires_at) <= Date.now() + 5 * 60_000 + 2000);
    const wrongPassword = await f.sign(ready, { password: "incorrect-password", challenge_id: challenge.challenge_id, code: challenge.demo_code });
    assert.equal(wrongPassword.status, 200, JSON.stringify(wrongPassword.data));
    assert.equal(wrongPassword.data.ok, false);
    assert.equal(wrongPassword.data.attempts_remaining, 4);
    const badCode = challenge.demo_code === "000000" ? "111111" : "000000";
    const wrongCode = await f.sign(ready, { password, challenge_id: challenge.challenge_id, code: badCode });
    assert.equal(wrongCode.status, 200);
    assert.equal(wrongCode.data.ok, false);
    assert.equal(wrongCode.data.attempts_remaining, 3);
    const storedChallenge = loadWorkflow(f.db).prescribing.challenges.find(item => item.id === challenge.challenge_id)!;
    assert.equal(storedChallenge.failed_attempts, 2, "failed authorizations commit even though they do not sign");
    assert.match(storedChallenge.code_hash, /^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(storedChallenge, "demo_code"), false);
    assert.equal(Object.hasOwn(storedChallenge, "password"), false);
    const clientId = randomUUID();
    const body = { password, challenge_id: challenge.challenge_id, code: challenge.demo_code, client_id: clientId };
    const signed = await f.sign(ready, body);
    assert.equal(signed.status, 200, JSON.stringify(signed.data));
    assert.equal(signed.data.ok, true);
    assert.equal(signed.data.prescription.status, "Simulated — not sent");
    assert.equal(signed.data.prescription.snapshot.authentication, "Demo password and displayed code");
    assert.ok(loadWorkflow(f.db).prescribing.challenges.find(item => item.id === challenge.challenge_id)?.consumed_at);
    const replay = await f.sign(ready, body);
    assert.equal(replay.status, 200, JSON.stringify(replay.data));
    assert.equal(replay.data.ok, true, "a lost success response can recover without authorizing another prescription");
    assert.deepEqual(replay.data.prescription.snapshot, signed.data.prescription.snapshot);
    const newOperation = await f.sign(ready, { ...body, client_id: randomUUID() });
    assert.ok(newOperation.status === 409 || (newOperation.status === 200 && newOperation.data.ok === false));
    const stored = JSON.stringify(loadWorkflow(f.db).prescribing);
    assert.equal(stored.includes(password), false);
    assert.equal(JSON.stringify(f.db.prepare("SELECT action,resource FROM audit").all()).includes(password), false);
  } finally { await f.close(); }
});

test("exhausting authorization attempts persists a lockout that cannot be reset by asking for another code or signing in again", async () => {
  const f = await fixture();
  try {
    const ready = await f.review(await f.create({ controlled_schedule: "III" }));
    const challenge = await f.challenge(ready);
    for (let index = 0; index < 5; index++) {
      const failed = await f.sign(ready, { password: "wrong", challenge_id: challenge.challenge_id, code: challenge.demo_code });
      assert.equal(failed.status, 200, JSON.stringify(failed.data));
      assert.equal(failed.data.ok, false);
      assert.equal(failed.data.attempts_remaining, 4 - index);
    }
    const newCode = await f.call(`${basePath}/${ready.id}/challenge`, "POST", { revision: ready.revision });
    assert.equal(newCode.status, 429, JSON.stringify(newCode.data));
    const sameAccountNewSession = await f.login("alex@cevrali.demo");
    const newSessionCode = await f.call(`${basePath}/${ready.id}/challenge`, "POST", { revision: ready.revision }, sameAccountNewSession);
    assert.equal(newSessionCode.status, 429, "logging in again must not bypass the prescriber's lockout");
    const state = loadWorkflow(f.db).prescribing;
    assert.equal(state.prescriptions.find(item => item.id === ready.id)?.status, "Ready for demo signing");
    assert.equal(state.challenges.find(item => item.id === challenge.challenge_id)?.failed_attempts, 5);
  } finally { await f.close(); }
});

test("controlled codes are bound to one session, prescriber, prescription and current revision", async () => {
  const f = await fixture();
  try {
    const ready = await f.review(await f.create({ controlled_schedule: "IV" }));
    const challenge = await f.challenge(ready);
    const body = { password, challenge_id: challenge.challenge_id, code: challenge.demo_code };
    const anotherSession = await f.login("alex@cevrali.demo");
    const crossSession = await f.sign(ready, body, anotherSession);
    assert.ok(crossSession.status === 403 || crossSession.status === 409 || (crossSession.status === 200 && crossSession.data.ok === false));
    assert.equal((await f.sign(ready, body, f.colleague)).status, 403);
    const another = await f.review(await f.create({ controlled_schedule: "IV", patient_id: "pat-002", billing_account_id: "pba-private-pat-002" }));
    const crossPatient = await f.sign(another, body);
    assert.ok(crossPatient.status === 403 || crossPatient.status === 409 || (crossPatient.status === 200 && crossPatient.data.ok === false));
    assert.equal(loadWorkflow(f.db).prescribing.prescriptions.every(item => !item.snapshot), true);
    const edit = await f.call(`${basePath}/${ready.id}`, "PATCH", { revision: ready.revision, instructions: "Changed synthetic instructions after review" });
    assert.equal(edit.status, 200, JSON.stringify(edit.data));
    assert.equal(edit.data.status, "Draft");
    assert.equal(edit.data.review_current, false);
    assert.equal((await f.sign(edit.data, body)).status, 409);
    assert.equal(loadWorkflow(f.db).prescribing.prescriptions.find(item => item.id === ready.id)?.snapshot, undefined);
  } finally { await f.close(); }
});

test("expired authorization codes cannot sign and issuing a replacement does not revive the old code", async () => {
  const f = await fixture();
  try {
    const ready = await f.review(await f.create({ controlled_schedule: "V" }));
    const challenge = await f.challenge(ready);
    const state = loadWorkflow(f.db);
    state.prescribing.challenges.find(item => item.id === challenge.challenge_id)!.expires_at = new Date(Date.now() - 1000).toISOString();
    saveWorkflow(f.db, state);
    const expired = await f.sign(ready, { password, challenge_id: challenge.challenge_id, code: challenge.demo_code });
    assert.ok(expired.status === 409 || expired.status === 410 || (expired.status === 200 && expired.data.ok === false));
    const replacement = await f.challenge(ready);
    assert.notEqual(replacement.challenge_id, challenge.challenge_id);
    const stale = await f.sign(ready, { password, challenge_id: challenge.challenge_id, code: challenge.demo_code });
    assert.ok(stale.status === 409 || stale.status === 410 || (stale.status === 200 && stale.data.ok === false));
    const valid = await f.sign(ready, { password, challenge_id: replacement.challenge_id, code: replacement.demo_code });
    assert.equal(valid.status, 200, JSON.stringify(valid.data));
    assert.equal(valid.data.ok, true);
  } finally { await f.close(); }
});

test("structured prescriptions reject invalid schedules, quantities, extra identity fields and unsafe refill combinations", async () => {
  const f = await fixture();
  try {
    const body = { ...syntheticFields, patient_id: "pat-001", encounter_id: null,
      billing_account_id: "pba-private-pat-001", client_id: randomUUID() };
    for (const change of [
      { quantity: 0 }, { days_supply: 0 }, { refills: -1 }, { controlled_schedule: "I" },
      { controlled_schedule: "II", refills: 1 }, { controlled_schedule: "III", refills: 6 },
      { controlled_schedule: "IV", days_supply: 181 }, { pharmacy: { name: "", address: "", phone: "" } },
      { author_id: "usr-colleague" }, { status: "Simulated — not sent" }, { patient_id: "does-not-exist" },
    ]) {
      const result = await f.call(basePath, "POST", { ...body, client_id: randomUUID(), ...change });
      assert.ok([400, 404].includes(result.status), `${JSON.stringify(change)}: ${JSON.stringify(result.data)}`);
    }
    assert.equal(loadWorkflow(f.db).prescribing.prescriptions.length, 0, "invalid writes leave no partial prescription");
    const rx = await f.create({ controlled_schedule: "II" });
    const context = await f.reviewContext(rx);
    const unreviewedPdmp = await f.call(`${basePath}/${rx.id}/review`, "POST", {
      revision: rx.revision, context_fingerprint: context.context_fingerprint, ...reviewFields, pdmp_reviewed: false,
    });
    assert.equal(unreviewedPdmp.status, 400, JSON.stringify(unreviewedPdmp.data));
    for (const flag of ["allergies_reviewed", "medications_reviewed", "classification_confirmed"]) {
      const rejected = await f.call(`${basePath}/${rx.id}/review`, "POST", { revision: rx.revision,
        context_fingerprint: context.context_fingerprint, ...reviewFields, [flag]: false });
      assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
    }
  } finally { await f.close(); }
});

test("a prescribing review requires the exact medication and detailed allergy context that the prescriber loaded", async () => {
  const f = await fixture();
  try {
    const profile = await f.call("/workflow/patient-profiles/pat-001");
    assert.equal(profile.status, 200);
    const rx = await f.create();
    const missingContext = await f.call(`${basePath}/${rx.id}/review`, "POST", {
      revision: rx.revision, ...reviewFields,
    });
    assert.equal(missingContext.status, 400, JSON.stringify(missingContext.data));
    for (const change of [
      () => f.db.prepare("UPDATE patients SET medications=? WHERE id=?").run(
        JSON.stringify([{ name: "A medication reported after the review screen opened", dose: "Unknown", frequency: "Unknown" }]), "pat-001"),
      () => {
        const state = loadWorkflow(f.db);
        const allergy = state.patient_profiles["pat-001"].allergy;
        assert.ok(allergy.records.length, "the seeded patient has a detailed allergy record");
        allergy.records[0].reaction = "Newly reported synthetic reaction";
        allergy.records[0].severity = "Severe";
        allergy.revision++;
        saveWorkflow(f.db, state);
      },
    ]) {
      const loaded = await f.reviewContext(rx);
      await change();
      const before = structuredClone(loadWorkflow(f.db).prescribing.prescriptions.find(item => item.id === rx.id));
      const stale = await f.call(`${basePath}/${rx.id}/review`, "POST", {
        revision: rx.revision, context_fingerprint: loaded.context_fingerprint, ...reviewFields,
      });
      assert.equal(stale.status, 409, JSON.stringify(stale.data));
      assert.deepEqual(loadWorkflow(f.db).prescribing.prescriptions.find(item => item.id === rx.id), before,
        "a stale context acknowledgement cannot create a review or alter the draft");
    }
    const fresh = await f.reviewContext(rx);
    assert.ok(fresh.workspace.patient.active_allergy_records.some((item: any) =>
      item.severity === "Severe" && item.reaction === "Newly reported synthetic reaction"));
    const reviewed = await f.review(rx);
    assert.equal(reviewed.status, "Ready for demo signing");
    assert.equal(reviewed.review_current, true);
  } finally { await f.close(); }
});

test("prescription review context is patient scoped and displays the actual non-default insurance account", async () => {
  const f = await fixture();
  try {
    const ordinary = await f.create();
    const otherPatient = await f.create({ patient_id: "pat-002", billing_account_id: "pba-private-pat-002" });
    const otherContext = await f.reviewContext(otherPatient);
    assert.equal(otherContext.workspace.patient.id, "pat-002");
    const wrongPatientContext = await f.call(`${basePath}/${ordinary.id}/review`, "POST", {
      revision: ordinary.revision, context_fingerprint: otherContext.context_fingerprint, ...reviewFields,
    });
    assert.equal(wrongPatientContext.status, 409, JSON.stringify(wrongPatientContext.data));
    assert.equal((await f.call(`${basePath}/${ordinary.id}/review-context`, "GET", undefined, f.front)).status, 403);
    const createdAccount = await f.call("/workflow/finance/accounts", "POST", {
      patient_id: "pat-001", name: "Synthetic review-context injury claim", kind: "Workers compensation",
      workers_comp: { claim_number: "SYNTHETIC-CONTEXT-CLAIM", carrier: "Synthetic Context Carrier",
        date_of_injury: "2020-01-02", employer: "Synthetic Employer", claim_status: "Accepted",
        accepted_body_parts: ["Left shoulder"] },
    });
    assert.equal(createdAccount.status, 200, JSON.stringify(createdAccount.data));
    const wc = await f.create({ billing_account_id: createdAccount.data.id });
    const wcContext = await f.reviewContext(wc);
    assert.equal(wcContext.workspace.selected_billing_account_id, createdAccount.data.id);
    assert.equal(wcContext.prescription.billing_account.claim_number, "SYNTHETIC-CONTEXT-CLAIM");
    const privateContext = await f.reviewContext(ordinary);
    assert.notEqual(wcContext.context_fingerprint, privateContext.context_fingerprint);
    const wrongAccountContext = await f.call(`${basePath}/${wc.id}/review`, "POST", {
      revision: wc.revision, context_fingerprint: privateContext.context_fingerprint, ...reviewFields,
    });
    assert.equal(wrongAccountContext.status, 409, JSON.stringify(wrongAccountContext.data));
    const reviewed = await f.review(wc);
    assert.equal(reviewed.billing_account.id, createdAccount.data.id);
  } finally { await f.close(); }
});

test("changes to patient identity, medications and allergy review invalidate an existing prescribing review", async () => {
  const f = await fixture();
  try {
    for (const change of [
      () => f.db.prepare("UPDATE patients SET last_name=? WHERE id=?").run("Changed identity", "pat-001"),
      () => f.db.prepare("UPDATE patients SET medications=? WHERE id=?").run(JSON.stringify([{ name: "A newly reported medication", dose: "Unknown", frequency: "Unknown" }]), "pat-001"),
      () => f.db.prepare("UPDATE patients SET allergies=? WHERE id=?").run(JSON.stringify(["Newly reported synthetic allergy"]), "pat-001"),
      async () => {
        const initialized = await f.call("/workflow/patient-profiles/pat-001");
        assert.equal(initialized.status, 200);
        const state = loadWorkflow(f.db);
        const profile = state.patient_profiles["pat-001"];
        assert.ok(profile);
        profile.allergy.revision++;
        profile.allergy.reviewed_at = null;
        saveWorkflow(f.db, state);
      },
    ]) {
      const ready = await f.review(await f.create());
      await change();
      const rejected = await f.sign(ready);
      assert.equal(rejected.status, 409, JSON.stringify(rejected.data));
      const fresh = await f.call(`${basePath}/${ready.id}`);
      assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
      assert.equal(fresh.data.review_current, false);
      assert.equal(fresh.data.snapshot, undefined);
    }
  } finally { await f.close(); }
});

test("billing accounts are patient scoped and changes to the reviewed visit or account require a new draft", async () => {
  const f = await fixture();
  try {
    const crossPatient = await f.call(basePath, "POST", { ...syntheticFields, patient_id: "pat-001", encounter_id: null,
      billing_account_id: "pba-private-pat-002", client_id: randomUUID() });
    assert.ok([400, 404].includes(crossPatient.status), JSON.stringify(crossPatient.data));
    const createdEncounter = await f.call("/encounters", "POST", { patient_id: "pat-001", chief_complaint: "Synthetic prescribing account review" });
    assert.equal(createdEncounter.status, 201, JSON.stringify(createdEncounter.data));
    const encounterId = createdEncounter.data.id;
    const ready = await f.review(await f.create({ encounter_id: encounterId }));
    const originalAccount = structuredClone(ready.billing_account);
    const account = await f.call("/workflow/finance/accounts", "POST", {
      patient_id: "pat-001", name: "Synthetic medication work injury claim", kind: "Workers compensation",
      workers_comp: { claim_number: "SYNTHETIC-RX-CLAIM", carrier: "Synthetic Carrier", date_of_injury: "2020-01-02",
        employer: "Synthetic Employer", claim_status: "Accepted", accepted_body_parts: ["Left shoulder"] },
    });
    assert.equal(account.status, 200, JSON.stringify(account.data));
    const mismatchedEncounter = await f.call(basePath, "POST", { ...syntheticFields, patient_id: "pat-001",
      encounter_id: encounterId, billing_account_id: account.data.id, client_id: randomUUID() });
    assert.equal(mismatchedEncounter.status, 409, JSON.stringify(mismatchedEncounter.data));
    f.db.prepare("UPDATE encounters SET billing_account_id=? WHERE id=?").run(account.data.id, encounterId);
    assert.equal((await f.sign(ready)).status, 409);
    assert.deepEqual(loadWorkflow(f.db).prescribing.prescriptions.find(item => item.id === ready.id)?.billing_account, originalAccount);
    const accountRx = await f.review(await f.create({ billing_account_id: account.data.id }));
    assert.equal(accountRx.billing_account.claim_number, "SYNTHETIC-RX-CLAIM");
    const state = loadWorkflow(f.db);
    state.finance.billing_accounts.find(item => item.id === account.data.id)!.revision++;
    saveWorkflow(f.db, state);
    assert.equal((await f.sign(accountRx)).status, 409);
  } finally { await f.close(); }
});

test("clinical access and administrator status do not substitute for a prescriber's own current permissions", async () => {
  const f = await fixture();
  try {
    const rx = await f.create();
    for (const path of [`${basePath}?patient_id=pat-001`, `${basePath}/queue`, `${basePath}/${rx.id}`])
      assert.equal((await f.call(path, "GET", undefined, f.front)).status, 403);
    assert.equal((await f.call(basePath, "POST", { ...syntheticFields, patient_id: "pat-001", encounter_id: null,
      billing_account_id: "pba-private-pat-001", client_id: randomUUID() }, f.front)).status, 403);
    f.db.prepare("UPDATE users SET is_admin=1 WHERE id=?").run("usr-reception");
    assert.equal((await f.call(`${basePath}/queue`, "GET", undefined, f.front)).status, 403, "front-desk administrators still cannot read clinical prescriptions");
    assert.equal((await f.call(`${basePath}/${rx.id}`, "PATCH", { revision: rx.revision, instructions: "Another clinician's edit" }, f.colleague)).status, 403);
    const ready = await f.review(rx);
    const settings = (await f.call(`${basePath}/settings`)).data;
    const revoked = await f.call(`${basePath}/settings`, "PATCH", {
      revision: settings.revision,
      prescribers: settings.prescribers.map((item: any) => ({ user_id: item.user_id,
        can_prescribe_demo: item.user_id !== "usr-clinician" && item.can_prescribe_demo,
        can_prescribe_controlled_demo: item.user_id !== "usr-clinician" && item.can_prescribe_controlled_demo })),
    });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
    assert.equal((await f.sign(ready)).status, 403);
    assert.equal(loadWorkflow(f.db).prescribing.prescriptions.find(item => item.id === rx.id)?.snapshot, undefined);
  } finally { await f.close(); }
});

test("controlled prescribing permission can be revoked after a valid challenge without revoking ordinary demo access", async () => {
  const f = await fixture();
  try {
    const ready = await f.review(await f.create({ controlled_schedule: "II" }));
    const challenge = await f.challenge(ready);
    const settings = (await f.call(`${basePath}/settings`)).data;
    const changed = await f.call(`${basePath}/settings`, "PATCH", {
      revision: settings.revision, prescribers: settings.prescribers.map((item: any) => ({ user_id: item.user_id,
        can_prescribe_demo: item.can_prescribe_demo,
        can_prescribe_controlled_demo: item.user_id !== "usr-clinician" && item.can_prescribe_controlled_demo })),
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    assert.equal((await f.sign(ready, { password, challenge_id: challenge.challenge_id, code: challenge.demo_code })).status, 403);
    const ordinary = await f.review(await f.create());
    const signed = await f.sign(ordinary);
    assert.equal(signed.status, 200, JSON.stringify(signed.data));
    assert.equal(signed.data.ok, true);
  } finally { await f.close(); }
});

test("front-desk refill requests expose only the submitter's administrative requests and require explicit clinical resolution", async () => {
  const f = await fixture();
  try {
    f.db.prepare("INSERT INTO users(id,name,email,password,role) VALUES(?,?,?,?,?)").run(
      "rx-front-two", "Synthetic Second Front Desk", "rx-second-front@example.test", hashPassword(password), "receptionist",
    );
    const second = await f.login("rx-second-front@example.test");
    const body = { patient_id: "pat-001", medication_name: "Patient-reported synthetic refill", notes: "Patient called to request review.", client_id: randomUUID() };
    const request = await f.call(`${basePath}/refills`, "POST", body, f.front);
    assert.equal(request.status, 200, JSON.stringify(request.data));
    assert.equal(request.data.status, "Requested");
    const repeat = await f.call(`${basePath}/refills`, "POST", body, f.front);
    assert.equal(repeat.status, 200);
    assert.equal(repeat.data.id, request.data.id);
    const other = await f.call(`${basePath}/refills`, "POST", { ...body, medication_name: "Another staff request", client_id: randomUUID() }, second);
    assert.equal(other.status, 200);
    const ownList = await f.call(`${basePath}/refills`, "GET", undefined, f.front);
    assert.equal(ownList.status, 200);
    assert.ok(ownList.data.some((item: any) => item.id === request.data.id));
    assert.equal(ownList.data.some((item: any) => item.id === other.data.id), false);
    assert.equal((await f.call(`${basePath}/refills/${request.data.id}/resolve`, "POST", { revision: 1,
      resolution: "Reviewed", note: "Front desk cannot approve this request" }, f.front)).status, 403);
    const rx = await f.create({ refill_request_id: request.data.id });
    assert.equal(rx.status, "Draft", "a refill request never automatically signs a new prescription");
    const wrongPatient = await f.call(`${basePath}/refills/${request.data.id}/resolve`, "POST", { revision: request.data.revision,
      resolution: "Reviewed", note: "Wrong-patient linkage rejected", prescription_id: (await f.create({ patient_id: "pat-002", billing_account_id: "pba-private-pat-002" })).id });
    assert.ok([400, 409].includes(wrongPatient.status), JSON.stringify(wrongPatient.data));
    const draftResolution = await f.call(`${basePath}/refills/${request.data.id}/resolve`, "POST", {
      revision: request.data.revision, resolution: "Reviewed", note: "A draft alone cannot stand in for final prescriber review.", prescription_id: rx.id,
    });
    assert.equal(draftResolution.status, 400, JSON.stringify(draftResolution.data));
    const signed = await f.sign(await f.review(rx));
    assert.equal(signed.status, 200, JSON.stringify(signed.data));
    assert.equal(signed.data.ok, true);
    const resolved = await f.call(`${basePath}/refills/${request.data.id}/resolve`, "POST", {
      revision: request.data.revision, resolution: "Reviewed", note: "PRIVATE clinical decision: review completed; draft prepared only.", prescription_id: rx.id,
    });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.data));
    assert.equal(resolved.data.status, "Reviewed");
    assert.equal(resolved.data.prescription_id, rx.id);
    const frontList = (await f.call(`${basePath}/refills`, "GET", undefined, f.front)).data;
    const safe = frontList.find((item: any) => item.id === request.data.id);
    assert.equal(safe.status, "Reviewed");
    assert.equal(safe.resolution_note, undefined);
    assert.equal(safe.prescription_id, undefined);
    assert.equal(JSON.stringify(frontList).includes("PRIVATE clinical decision"), false);
    assert.equal(loadWorkflow(f.db).prescribing.prescriptions.find(item => item.id === rx.id)?.snapshot?.pharmacy_transmitted, false);
  } finally { await f.close(); }
});

test("local cancellation keeps the simulated signing snapshot and makes no claim that a pharmacy cancelled anything", async () => {
  const f = await fixture();
  try {
    const signed = await f.sign(await f.review(await f.create()));
    assert.equal(signed.data.ok, true);
    const rx = signed.data.prescription;
    const cancelled = await f.call(`${basePath}/${rx.id}/cancel`, "POST", { revision: rx.revision, reason: "Synthetic local correction; no pharmacy transmission occurred." });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
    assert.equal(cancelled.data.status, "Cancelled locally");
    assert.equal(cancelled.data.pharmacy_transmitted, false);
    assert.deepEqual(cancelled.data.snapshot, rx.snapshot);
    assert.ok(cancelled.data.history.length > rx.history.length);
    assert.equal(cancelled.data.cancellation_reason, "Synthetic local correction; no pharmacy transmission occurred.");
  } finally { await f.close(); }
});

test("preferred pharmacies use patient-specific revisions and never rewrite an existing prescription's pharmacy", async () => {
  const f = await fixture();
  try {
    const initial = (await f.call(`${basePath}?patient_id=pat-001`)).data;
    assert.equal(initial.preferred_pharmacy, null);
    const path = `${basePath}/patients/pat-001/pharmacy`;
    assert.equal((await f.call(path, "PATCH", { revision: 0, pharmacy: syntheticFields.pharmacy }, f.front)).status, 403);
    const saved = await f.call(path, "PATCH", { revision: 0, pharmacy: syntheticFields.pharmacy });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.revision, 1);
    assert.deepEqual(saved.data.pharmacy, syntheticFields.pharmacy);
    assert.equal((await f.call(`${basePath}?patient_id=pat-002`)).data.preferred_pharmacy, null);
    const ready = await f.review(await f.create());
    const updatedPharmacy = { name: "Another Synthetic Pharmacy", address: "200 Other Synthetic Street", phone: "555-0123" };
    const updated = await f.call(path, "PATCH", { revision: saved.data.revision, pharmacy: updatedPharmacy });
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
    assert.equal((await f.call(path, "PATCH", { revision: 1, pharmacy: syntheticFields.pharmacy })).status, 409);
    const signed = await f.sign(ready);
    assert.equal(signed.status, 200, JSON.stringify(signed.data));
    assert.equal(signed.data.ok, true, "changing a future preference does not change the pharmacy explicitly reviewed on a draft");
    assert.deepEqual(signed.data.prescription.snapshot.fields.pharmacy, syntheticFields.pharmacy);
    const fresh = await f.call(`${basePath}?patient_id=pat-001`);
    assert.deepEqual(fresh.data.preferred_pharmacy.pharmacy, updatedPharmacy);
    assert.equal((await f.call(`${basePath}/patients/not-a-patient/pharmacy`, "PATCH", { revision: 0, pharmacy: updatedPharmacy })).status, 404);
  } finally { await f.close(); }
});

test("only administrators can grant demo permissions, and stale or invalid access changes leave the existing grants intact", async () => {
  const f = await fixture();
  try {
    const original = await f.call(`${basePath}/settings`);
    assert.equal(original.status, 200, JSON.stringify(original.data));
    const grants = original.data.prescribers.map((item: any) => ({ user_id: item.user_id,
      can_prescribe_demo: item.can_prescribe_demo, can_prescribe_controlled_demo: item.can_prescribe_controlled_demo }));
    assert.equal((await f.call(`${basePath}/settings`, "PATCH", { revision: original.data.revision, prescribers: grants }, f.colleague)).status, 403);
    assert.equal((await f.call(`${basePath}/settings`, "PATCH", { revision: original.data.revision, prescribers: grants }, f.front)).status, 403);
    const before = JSON.stringify(loadWorkflow(f.db).prescribing.settings);
    for (const invalid of [
      [{ user_id: "usr-reception", can_prescribe_demo: true, can_prescribe_controlled_demo: false }],
      [{ user_id: "usr-clinician", can_prescribe_demo: false, can_prescribe_controlled_demo: true }],
      [grants[0], grants[0]],
    ]) {
      const result = await f.call(`${basePath}/settings`, "PATCH", { revision: original.data.revision, prescribers: invalid });
      assert.equal(result.status, 400, JSON.stringify(result.data));
      assert.equal(JSON.stringify(loadWorkflow(f.db).prescribing.settings), before);
    }
    f.db.prepare("UPDATE users SET is_active=0 WHERE id=?").run("usr-colleague");
    const inactive = await f.call(`${basePath}/settings`, "PATCH", { revision: original.data.revision, prescribers: grants });
    assert.equal(inactive.status, 400, JSON.stringify(inactive.data));
    assert.equal(JSON.stringify(loadWorkflow(f.db).prescribing.settings), before);
    const enabled = await f.call(`${basePath}/settings`, "PATCH", { revision: original.data.revision,
      prescribers: grants.map((grant: any) => grant.user_id === "usr-colleague"
        ? { ...grant, can_prescribe_demo: false, can_prescribe_controlled_demo: false } : grant) });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
    const after = JSON.stringify(loadWorkflow(f.db).prescribing.settings);
    const stale = await f.call(`${basePath}/settings`, "PATCH", { revision: original.data.revision, prescribers: [] });
    assert.equal(stale.status, 409, JSON.stringify(stale.data));
    assert.equal(JSON.stringify(loadWorkflow(f.db).prescribing.settings), after);
    assert.equal(enabled.data.pharmacy_connected, false);
    assert.equal(enabled.data.epcs_connected, false);
  } finally { await f.close(); }
});

test("new practices need explicit demo prescribing access and prescription snapshots remain isolated across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cevrali-prescribing-isolation-"));
  const filename = join(directory, "demo.sqlite"), accounts = join(directory, "accounts");
  let db = createDatabase(filename), platform = createPlatformApp(db, accounts);
  let server = platform.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  let base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (path: string, method = "GET", body?: unknown, cookie = "") => {
    const response = await fetch(base + path, { method,
      headers: { "Content-Type": "application/json", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] || "" };
  };
  const stop = async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    platform.store.close(); db.close();
  };
  try {
    const practices: { cookie: string; userId: string; patientId: string; prescription?: PrescriptionView }[] = [];
    for (const label of ["Alpha", "Beta"]) {
      const signup = await call("/accounts/signup", "POST", { owner_name: `Synthetic ${label} Prescriber`,
        email: `rx-${label.toLowerCase()}@example.test`, password: "SyntheticPrescribing2026!", clinical_access: true,
        practice: { name: `${label} Synthetic Prescribing Practice` } });
      assert.equal(signup.status, 201, JSON.stringify(signup.data));
      const patient = await call("/patients", "POST", { first_name: "Synthetic", last_name: label,
        dob: "1990-01-01", sex: "Unknown", phone: "555-0100" }, signup.cookie);
      assert.equal(patient.status, 201);
      const settings = await call(`${basePath}/settings`, "GET", undefined, signup.cookie);
      assert.equal(settings.status, 200, JSON.stringify(settings.data));
      assert.equal(settings.data.prescribers.find((item: any) => item.user_id === signup.data.id).can_prescribe_demo, false);
      const input = { ...syntheticFields, patient_id: patient.data.id, encounter_id: null,
        billing_account_id: `pba-private-${patient.data.id}`, client_id: randomUUID() };
      const draft = await call(basePath, "POST", input, signup.cookie);
      assert.equal(draft.status, 200, JSON.stringify(draft.data));
      const context = await call(`${basePath}/${draft.data.id}/review-context`, "GET", undefined, signup.cookie);
      assert.equal(context.status, 200, JSON.stringify(context.data));
      const disallowedReview = await call(`${basePath}/${draft.data.id}/review`, "POST", { revision: draft.data.revision,
        context_fingerprint: context.data.context_fingerprint, ...reviewFields }, signup.cookie);
      assert.equal(disallowedReview.status, 403, JSON.stringify(disallowedReview.data));
      const disallowed = await call(`${basePath}/${draft.data.id}/sign`, "POST", { revision: draft.data.revision, client_id: randomUUID() }, signup.cookie);
      assert.equal(disallowed.status, 403);
      const enabled = await call(`${basePath}/settings`, "PATCH", { revision: settings.data.revision,
        prescribers: [{ user_id: signup.data.id, can_prescribe_demo: true, can_prescribe_controlled_demo: true }] }, signup.cookie);
      assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
      const ready = await call(`${basePath}/${draft.data.id}/review`, "POST", { revision: draft.data.revision,
        context_fingerprint: context.data.context_fingerprint, ...reviewFields }, signup.cookie);
      assert.equal(ready.status, 200, JSON.stringify(ready.data));
      const signed = await call(`${basePath}/${draft.data.id}/sign`, "POST", { revision: ready.data.revision, client_id: randomUUID() }, signup.cookie);
      assert.equal(signed.status, 200, JSON.stringify(signed.data));
      assert.equal(signed.data.ok, true);
      practices.push({ cookie: signup.cookie, userId: signup.data.id, patientId: patient.data.id, prescription: signed.data.prescription });
    }
    const [alpha, beta] = practices;
    assert.equal((await call(`${basePath}/${alpha.prescription!.id}`, "GET", undefined, beta.cookie)).status, 404);
    assert.equal((await call(`${basePath}?patient_id=${alpha.patientId}`, "GET", undefined, beta.cookie)).status, 404);
    assert.equal((await call(`${basePath}/queue`, "GET", undefined, beta.cookie)).data.some((item: PrescriptionView) => item.id === alpha.prescription!.id), false);
    const snapshot = structuredClone(alpha.prescription!.snapshot);
    await stop();
    db = createDatabase(filename); platform = createPlatformApp(db, accounts);
    server = platform.app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const restored = await call(`${basePath}/${alpha.prescription!.id}`, "GET", undefined, alpha.cookie);
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.deepEqual(restored.data.snapshot, snapshot);
    assert.equal(restored.data.pharmacy_transmitted, false);
    assert.equal((await call(`${basePath}/${alpha.prescription!.id}`, "GET", undefined, beta.cookie)).status, 404);
    const settings = await call(`${basePath}/settings`, "GET", undefined, alpha.cookie);
    assert.equal(settings.data.prescribers.find((item: any) => item.user_id === alpha.userId).can_prescribe_demo, true);
  } finally { await stop(); rmSync(directory, { recursive: true, force: true }); }
});
