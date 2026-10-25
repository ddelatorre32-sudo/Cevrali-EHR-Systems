import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { createDatabase } from "../server/database.js";
import { createApp } from "../server/app.js";
import { createPlatformApp } from "../server/platform.js";
import { loadWorkflow, saveWorkflow } from "../server/workflows.js";
import type { CheckInPacketView } from "../server/digital-checkin-model.js";

// A real, tiny PNG with independently generated chunk checksums, rather than a
// filename/MIME-only fixture that could conceal broken upload validation.
function png() {
  const chunk = (type: string, data: Buffer) => {
    const content = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, content, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 24, 92, 83, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const image = png();
const proposedContact = {
  phone: "555-0199", email: "updated@example.test", address: "123 Synthetic Avenue",
  address_unit: "4B", city: "Boston", state: "MA", zip_code: "02108-1234",
};
const clinicalAnswers = {
  concern: "PRIVATE CLINICAL CONCERN", symptoms: "PRIVATE CLINICAL SYMPTOMS",
  allergies: ["PRIVATE CLINICAL ALLERGY"], medications: [], reminder_consent: false, attested: true,
};

async function fixture() {
  const db = createDatabase(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let clinical = "", front = "", serial = 0;
  const call = async (path: string, method = "GET", body?: unknown, auth = clinical) => {
    const response = await fetch(base + path, {
      method, headers: { "Content-Type": "application/json", Cookie: auth },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = { text }; }
    return { status: response.status, data, response };
  };
  for (const email of ["alex@cevrali.demo", "frontdesk@cevrali.demo"]) {
    const login = await call("/auth/login", "POST", { email, password: "CevraliDemo2026!" }, "");
    assert.equal(login.status, 200);
    const cookie = login.response.headers.get("set-cookie")!.split(";")[0];
    if (email.startsWith("alex")) clinical = cookie; else front = cookie;
  }
  const issue = async (patientId = "pat-001") => {
    const appointment = await call("/appointments", "POST", {
      patient_id: patientId, date: `2099-01-${String(++serial).padStart(2, "0")}`,
      time: "10:00", duration: 30, type: "Consultation", reason: "Synthetic digital check-in test",
    }, front);
    assert.equal(appointment.status, 201, JSON.stringify(appointment.data));
    const issued = await call("/workflow/intake-links", "POST", { appointment_id: appointment.data.id }, front);
    assert.equal(issued.status, 200, JSON.stringify(issued.data));
    const path = `/intake-links/${issued.data.token}/registration`;
    const initial = await call(path, "GET", undefined, "");
    assert.equal(initial.status, 200, JSON.stringify(initial.data));
    let current = initial.data as CheckInPacketView;
    return {
      id: issued.data.id as string, token: issued.data.token as string,
      appointmentId: appointment.data.id as string, path,
      get packet() { return current; },
      async mutate(suffix: string, body: Record<string, unknown>) {
        const result = await call(path + suffix, "POST", { revision: current.revision, ...body }, "");
        assert.equal(result.status, 200, JSON.stringify(result.data));
        current = result.data;
        return current;
      },
      async signAll() {
        for (const consent of current.consents)
          if (!consent.signature) await this.mutate(`/consents/${consent.id}`, {
            client_id: randomUUID(), signer_name: "Synthetic Patient", signer_role: "Patient", relationship: "", agree: true,
          });
      },
      async complete() {
        await this.mutate("", { contact: proposedContact });
        await this.signAll();
        await this.mutate("/submit", { client_id: randomUUID(), no_card_reason: "Will bring the card to the appointment" });
      },
    };
  };
  return {
    db, call, issue, get front() { return front; },
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      db.close();
    },
  };
}

test("patient registration remains a proposal until front-desk review and remote completion does not check the patient in", async () => {
  const f = await fixture();
  try {
    const intake = await f.issue();
    const before = (await f.call("/workflow/patient-profiles/pat-001", "GET", undefined, f.front)).data;
    assert.equal(intake.packet.contact, null, "public links do not prefill private contact details");
    await intake.complete();
    assert.equal(intake.packet.status, "Submitted");
    assert.equal((await f.call("/workflow/patient-profiles/pat-001", "GET", undefined, f.front)).data.patient.phone, before.patient.phone);
    assert.equal((await f.call("/appointments?start=2099-01-01&end=2099-01-31")).data.find((row: any) => row.id === intake.appointmentId).status, "Scheduled");
    const detail = (await f.call(`/workflow/digital-checkin/${intake.id}`, "GET", undefined, f.front)).data;
    const review = await f.call(`/workflow/digital-checkin/${intake.id}/review`, "POST", {
      revision: detail.revision, demographics_revision: detail.demographics_revision,
      apply_demographics: true, reason: "Front desk verified patient-submitted contact information",
    }, f.front);
    assert.equal(review.status, 200, JSON.stringify(review.data));
    assert.equal(review.data.status, "Reviewed");
    assert.equal(review.data.demographics_applied, true);
    const profile = (await f.call("/workflow/patient-profiles/pat-001", "GET", undefined, f.front)).data;
    for (const [key, value] of Object.entries(proposedContact)) assert.equal(profile.patient[key], value);
    assert.equal(profile.patient.first_name, before.patient.first_name);
    assert.equal(profile.patient.dob, before.patient.dob);
    assert.ok(profile.history.some((change: any) => change.section === "Demographics" && change.actor_id === "usr-reception"));
    assert.equal(loadWorkflow(f.db).intakes.find((row) => row.id === intake.id)?.status, "Requested", "clinical review is a separate workflow");
  } finally { await f.close(); }
});

test("a retried contact save with a stable request ID changes the revision and audit exactly once", async () => {
  const f = await fixture();
  try {
    const intake = await f.issue();
    const payload = { revision: intake.packet.revision, client_id: randomUUID(), contact: proposedContact };
    const countContactAudits = () => Number((f.db.prepare(
      "SELECT count(*) AS total FROM audit WHERE resource=? AND action=?",
    ).get(intake.id, "Patient self-service: saved registration contact details") as { total: number }).total);
    const initialAudits = countContactAudits();
    const first = await f.call(intake.path, "POST", payload, "");
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.revision, payload.revision + 1);
    assert.equal(countContactAudits(), initialAudits + 1);
    // Reuse the original stale revision to model losing the success response.
    const retry = await f.call(intake.path, "POST", payload, "");
    assert.equal(retry.status, 200, JSON.stringify(retry.data));
    assert.equal(retry.data.revision, first.data.revision);
    assert.deepEqual(retry.data.contact, proposedContact);
    assert.equal(countContactAudits(), initialAudits + 1);
    const conflicting = await f.call(intake.path, "POST", {
      ...payload, revision: first.data.revision, contact: { ...proposedContact, phone: "555-0188" },
    }, "");
    assert.equal(conflicting.status, 409);
    const fresh = await f.call(intake.path, "GET", undefined, "");
    assert.equal(fresh.data.revision, first.data.revision);
    assert.deepEqual(fresh.data.contact, proposedContact);
    assert.equal(countContactAudits(), initialAudits + 1);
  } finally { await f.close(); }
});

test("insurance-card uploads preserve exact bytes and hashes, scope downloads to the intake, and retry without duplicates", async () => {
  const f = await fixture();
  try {
    const intake = await f.issue(), other = await f.issue("pat-002");
    const payload = {
      revision: intake.packet.revision, side: "Front", name: "insurance-front.png", mime_type: "image/png",
      data_base64: image.toString("base64"), client_id: randomUUID(),
    };
    await intake.mutate("/files", payload);
    const file = intake.packet.files.find((row) => !row.superseded_at)!;
    assert.equal(file.size, image.length);
    assert.equal(file.sha256, createHash("sha256").update(image).digest("hex"));
    const retry = await f.call(intake.path + "/files", "POST", payload, "");
    assert.equal(retry.status, 200, JSON.stringify(retry.data));
    assert.equal(retry.data.files.length, 1);
    assert.equal(retry.data.files[0].id, file.id);
    const reusedRequest = await f.call(intake.path + "/files", "POST", { ...payload, side: "Back" }, "");
    assert.equal(reusedRequest.status, 409, "a retry key cannot authorize a different upload");
    const retrieved = await f.call(`${intake.path}/files/${file.id}`, "GET", undefined, "");
    assert.equal(retrieved.status, 200, JSON.stringify(retrieved.data));
    assert.deepEqual(Buffer.from(retrieved.data.data_base64, "base64"), image);
    assert.equal((await f.call(`${other.path}/files/${file.id}`, "GET", undefined, "")).status, 404);
    assert.equal((await f.call(`/workflow/digital-checkin/${other.id}/files/${file.id}`, "GET", undefined, f.front)).status, 404);
    assert.equal((await f.call(`${intake.path}/files/${file.id}`, "GET", undefined, "")).data.mime_type, "image/png");
    await intake.mutate("", { contact: proposedContact });
    await intake.signAll();
    await intake.mutate("/submit", { client_id: randomUUID(), no_card_reason: "" });
    assert.equal(intake.packet.status, "Submitted");
  } finally { await f.close(); }
});

test("uploaded images with an HTML filename receive an image extension in public and staff downloads", async () => {
  const f = await fixture();
  try {
    const intake = await f.issue();
    await intake.mutate("/files", {
      side: "Front", name: "insurance.html", mime_type: "image/png",
      data_base64: image.toString("base64"), client_id: randomUUID(),
    });
    const file = intake.packet.files[0];
    assert.equal(file.name, "insurance.png");
    assert.equal(file.mime_type, "image/png");
    for (const path of [
      `${intake.path}/files/${file.id}`,
      `/workflow/digital-checkin/${intake.id}/files/${file.id}`,
    ]) {
      const downloaded = await f.call(path, "GET", undefined, path.startsWith("/workflow") ? f.front : "");
      assert.equal(downloaded.status, 200, JSON.stringify(downloaded.data));
      assert.equal(downloaded.data.name, "insurance.png");
      assert.equal(downloaded.data.mime_type, "image/png");
      assert.deepEqual(Buffer.from(downloaded.data.data_base64, "base64"), image);
      assert.equal(downloaded.data.sha256, createHash("sha256").update(image).digest("hex"));
    }
  } finally { await f.close(); }
});

test("uploads reject disguised, damaged, oversized and cross-type files without changing the packet", async () => {
  const f = await fixture();
  try {
    const intake = await f.issue();
    const damaged = Buffer.from(image); damaged[damaged.length - 1] ^= 1;
    const before = JSON.stringify(loadWorkflow(f.db).digital_checkin);
    const invalid = [
      { mime_type: "image/png", data_base64: Buffer.from("<svg onload='alert(1)'></svg>").toString("base64") },
      { mime_type: "image/jpeg", data_base64: image.toString("base64") },
      { mime_type: "image/png", data_base64: damaged.toString("base64") },
      { mime_type: "image/png", data_base64: image.subarray(0, 35).toString("base64") },
      { mime_type: "image/svg+xml", data_base64: image.toString("base64") },
      { mime_type: "image/png", data_base64: "not valid base64!" },
      { mime_type: "image/png", data_base64: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64") },
    ];
    for (const candidate of invalid) {
      const result = await f.call(intake.path + "/files", "POST", {
        revision: intake.packet.revision, side: "Front", name: "insurance.png", client_id: randomUUID(), ...candidate,
      }, "");
      assert.equal(result.status, 400, JSON.stringify(result.data));
      assert.equal(JSON.stringify(loadWorkflow(f.db).digital_checkin), before);
    }
  } finally { await f.close(); }
});

test("signed consent keeps its issued text and version after template edits, with idempotent signatures and submission", async () => {
  const f = await fixture();
  try {
    const intake = await f.issue();
    const consent = structuredClone(intake.packet.consents[0]);
    assert.ok(consent.text && consent.title && consent.sha256);
    const forms = (await f.call("/workflow/digital-checkin/forms")).data;
    const form = forms.find((row: any) => row.id === consent.form_id);
    const edited = await f.call(`/workflow/digital-checkin/forms/${form.id}`, "PATCH", {
      revision: form.revision, text: "A revised consent applies only to newly issued registration packets.",
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    const signature = {
      revision: intake.packet.revision, client_id: randomUUID(), signer_name: "Synthetic Guardian",
      signer_role: "Representative", relationship: "Parent", agree: true,
    };
    const signed = await intake.mutate(`/consents/${consent.id}`, signature);
    const signatureAt = signed.consents[0].signature!.signed_at;
    const repeated = await f.call(`${intake.path}/consents/${consent.id}`, "POST", signature, "");
    assert.equal(repeated.status, 200, JSON.stringify(repeated.data));
    assert.equal(repeated.data.consents[0].signature.signed_at, signatureAt);
    assert.equal(repeated.data.consents[0].signature.relationship, "Parent");
    for (const key of ["text", "title", "version", "sha256"] as const)
      assert.equal(repeated.data.consents[0][key], consent[key]);
    const replacement = await f.call(`${intake.path}/consents/${consent.id}`, "POST", {
      ...signature, revision: signed.revision, client_id: randomUUID(), signer_name: "Someone else",
    }, "");
    assert.equal(replacement.status, 409);
    await intake.mutate("", { contact: proposedContact });
    await intake.signAll();
    const submit = { revision: intake.packet.revision, client_id: randomUUID(), no_card_reason: "Card unavailable today" };
    const completed = await intake.mutate("/submit", submit);
    const repeatedSubmit = await f.call(intake.path + "/submit", "POST", submit, "");
    assert.equal(repeatedSubmit.status, 200, JSON.stringify(repeatedSubmit.data));
    assert.equal(repeatedSubmit.data.submitted_at, completed.submitted_at);
    assert.equal((await f.call(intake.path, "POST", { revision: completed.revision, contact: proposedContact }, "")).status, 409);
    const later = await f.issue("pat-002");
    const laterConsent = later.packet.consents.find((row) => row.form_id === form.id)!;
    assert.equal(laterConsent.version, consent.version + 1);
    assert.notEqual(laterConsent.text, consent.text);
  } finally { await f.close(); }
});

test("submission requires saved contacts, signed consents and an insurance-card or explicit unavailable reason", async () => {
  const f = await fixture();
  try {
    const intake = await f.issue();
    const submit = () => f.call(intake.path + "/submit", "POST", {
      revision: intake.packet.revision, client_id: randomUUID(), no_card_reason: "",
    }, "");
    assert.equal((await submit()).status, 400);
    const invalidContact = await f.call(intake.path, "POST", {
      revision: intake.packet.revision, contact: { ...proposedContact, zip_code: "1234", patient_id: "pat-002" },
    }, "");
    assert.equal(invalidContact.status, 400);
    await intake.mutate("", { contact: proposedContact });
    assert.equal((await submit()).status, 400);
    const consent = intake.packet.consents[0];
    assert.equal((await f.call(`${intake.path}/consents/${consent.id}`, "POST", {
      revision: intake.packet.revision, client_id: randomUUID(), signer_name: "Synthetic Representative",
      signer_role: "Representative", relationship: "", agree: true,
    }, "")).status, 400);
    await intake.signAll();
    assert.equal((await submit()).status, 400);
    assert.equal(intake.packet.status, "Requested");
    await intake.mutate("/submit", { client_id: randomUUID(), no_card_reason: "Patient will bring the card" });
    assert.equal(intake.packet.status, "Submitted");
  } finally { await f.close(); }
});

test("front desk reviews administrative registration without seeing clinical intake answers and can retain current demographics", async () => {
  const f = await fixture();
  try {
    const intake = await f.issue();
    await intake.complete();
    assert.equal((await f.call(`/intake-links/${intake.token}`, "POST", clinicalAnswers, "")).status, 200);
    for (const path of ["/workflow/digital-checkin", `/workflow/digital-checkin/${intake.id}`]) {
      const result = await f.call(path, "GET", undefined, f.front);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      const serialized = JSON.stringify(result.data);
      assert.equal(serialized.includes("PRIVATE CLINICAL"), false);
      assert.equal(serialized.includes("data_base64"), false);
      assert.equal(serialized.includes("token_hash"), false);
    }
    assert.equal((await f.call("/workflow/intakes", "GET", undefined, f.front)).status, 403);
    const detail = (await f.call(`/workflow/digital-checkin/${intake.id}`, "GET", undefined, f.front)).data;
    const before = (await f.call("/workflow/patient-profiles/pat-001", "GET", undefined, f.front)).data;
    const reviewed = await f.call(`/workflow/digital-checkin/${intake.id}/review`, "POST", {
      revision: detail.revision, demographics_revision: detail.demographics_revision,
      apply_demographics: false, reason: "Verified that the chart address should be retained",
    }, f.front);
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
    assert.equal(reviewed.data.status, "Reviewed");
    const after = (await f.call("/workflow/patient-profiles/pat-001", "GET", undefined, f.front)).data;
    assert.deepEqual(after.patient, before.patient);
    assert.equal(after.demographics_revision, before.demographics_revision);
  } finally { await f.close(); }
});

test("a patient sees registration completion without internal staff review notes or current chart demographics", async () => {
  const f = await fixture();
  try {
    const intake = await f.issue(); await intake.complete();
    const detail = (await f.call(`/workflow/digital-checkin/${intake.id}`, "GET", undefined, f.front)).data;
    const internalReason = "INTERNAL STAFF REVIEW: chart address verified by telephone";
    const reviewed = await f.call(`/workflow/digital-checkin/${intake.id}/review`, "POST", {
      revision: detail.revision, demographics_revision: detail.demographics_revision,
      apply_demographics: false, reason: internalReason,
    }, f.front);
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
    assert.equal(reviewed.data.review_reason, internalReason);
    assert.ok(reviewed.data.reviewed_by_name);
    assert.ok(reviewed.data.current_contact);
    const publicView = await f.call(intake.path, "GET", undefined, "");
    assert.equal(publicView.status, 200, JSON.stringify(publicView.data));
    assert.equal(publicView.data.status, "Reviewed");
    assert.deepEqual(publicView.data.contact, proposedContact, "patients can still see their own submitted contact proposal");
    for (const key of ["review_reason", "reviewed_by_name", "current_contact", "demographics_revision", "current_billing_account", "demographics_applied"])
      assert.equal(Object.hasOwn(publicView.data, key), false, `${key} is staff-only`);
    assert.equal(JSON.stringify(publicView.data).includes(internalReason), false);
  } finally { await f.close(); }
});

test("stale demographic review cannot overwrite a concurrent staff update or mark the packet reviewed", async () => {
  const f = await fixture();
  try {
    const intake = await f.issue(); await intake.complete();
    const detail = (await f.call(`/workflow/digital-checkin/${intake.id}`, "GET", undefined, f.front)).data;
    const changed = await f.call("/workflow/patient-profiles/pat-001/demographics", "PATCH", {
      revision: detail.demographics_revision, reason: "Telephone update while registration was under review", phone: "555-0110",
    }, f.front);
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    const review = await f.call(`/workflow/digital-checkin/${intake.id}/review`, "POST", {
      revision: detail.revision, demographics_revision: detail.demographics_revision,
      apply_demographics: true, reason: "Stale browser should not overwrite verified details",
    }, f.front);
    assert.equal(review.status, 409);
    const fresh = (await f.call(`/workflow/digital-checkin/${intake.id}`, "GET", undefined, f.front)).data;
    assert.equal(fresh.status, "Submitted");
    assert.equal(fresh.current_contact.phone, "555-0110");
    assert.equal(fresh.revision, detail.revision);
  } finally { await f.close(); }
});

test("expired, revoked and unknown tokens cannot read or mutate registration, and unknown suffixes cannot trigger appointment actions", async () => {
  const f = await fixture();
  try {
    const intake = await f.issue();
    await intake.mutate("/files", {
      side: "Front", name: "front.png", mime_type: "image/png", data_base64: image.toString("base64"), client_id: randomUUID(),
    });
    const file = intake.packet.files[0];
    const unknown = "a".repeat(64);
    assert.equal((await f.call(`/intake-links/${unknown}/registration`, "GET", undefined, "")).status, 404);
    for (const suffix of ["unknown", "registration/unknown", "appointment/extra", "registration/files/extra/extra"]) {
      const result = await f.call(`/intake-links/${intake.token}/${suffix}`, "PATCH", { action: "cancel" }, "");
      assert.equal(result.status, 404, `${suffix}: ${JSON.stringify(result.data)}`);
    }
    assert.equal((await f.call("/appointments?start=2099-01-01&end=2099-01-31")).data.find((row: any) => row.id === intake.appointmentId).status, "Scheduled");
    const replacement = await f.call("/workflow/intake-links", "POST", { appointment_id: intake.appointmentId }, f.front);
    assert.equal(replacement.status, 200);
    for (const suffix of ["", `/files/${file.id}`])
      assert.equal((await f.call(intake.path + suffix, "GET", undefined, "")).status, 410);
    assert.equal((await f.call(intake.path, "POST", { revision: intake.packet.revision, contact: proposedContact }, "")).status, 410);
    const state = loadWorkflow(f.db);
    const current = state.intakes.find((row) => row.id === replacement.data.id)!;
    current.expires_at = new Date(Date.now() - 1000).toISOString();
    saveWorkflow(f.db, state);
    assert.equal((await f.call(`/intake-links/${replacement.data.token}/registration`, "GET", undefined, "")).status, 410);
    assert.equal((await f.call(`/intake-links/${replacement.data.token}/registration/submit`, "POST", {
      revision: 1, client_id: randomUUID(), no_card_reason: "Not available",
    }, "")).status, 410);
  } finally { await f.close(); }
});

test("staff can renew an expired link after clinical intake submission without losing pending registration or signed documents", async () => {
  const f = await fixture();
  try {
    const intake = await f.issue();
    await intake.mutate("", { contact: proposedContact });
    await intake.mutate("/files", {
      side: "Front", name: "preserved-front.png", mime_type: "image/png",
      data_base64: image.toString("base64"), client_id: randomUUID(),
    });
    await intake.signAll();
    assert.equal((await f.call(`/intake-links/${intake.token}`, "POST", clinicalAnswers, "")).status, 200);
    const before = structuredClone(intake.packet);
    const state = loadWorkflow(f.db);
    state.intakes.find((row) => row.id === intake.id)!.expires_at = new Date(Date.now() - 1000).toISOString();
    saveWorkflow(f.db, state);
    const renewed = await f.call(`/workflow/intake-links/${intake.id}/renew`, "POST", {}, f.front);
    assert.equal(renewed.status, 200, JSON.stringify(renewed.data));
    assert.notEqual(renewed.data.token, intake.token);
    assert.equal(renewed.data.id, intake.id);
    assert.equal((await f.call(intake.path, "GET", undefined, "")).status, 404);
    const path = `/intake-links/${renewed.data.token}/registration`;
    const fresh = await f.call(path, "GET", undefined, "");
    assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
    assert.equal(fresh.data.status, "Requested");
    assert.equal(fresh.data.intake_status, "Submitted");
    assert.deepEqual(fresh.data.contact, before.contact);
    assert.deepEqual(fresh.data.consents, before.consents);
    assert.deepEqual(fresh.data.files, before.files);
    assert.equal(fresh.data.revision, before.revision);
    const original = await f.call(`${path}/files/${before.files[0].id}`, "GET", undefined, "");
    assert.equal(original.status, 200);
    assert.deepEqual(Buffer.from(original.data.data_base64, "base64"), image);
    const completed = await f.call(path + "/submit", "POST", {
      revision: fresh.data.revision, client_id: randomUUID(), no_card_reason: "",
    }, "");
    assert.equal(completed.status, 200, JSON.stringify(completed.data));
    assert.equal(completed.data.status, "Submitted");
    assert.equal(loadWorkflow(f.db).intakes.find((row) => row.id === intake.id)!.answers?.concern, clinicalAnswers.concern);
  } finally { await f.close(); }
});

test("closed appointments reject new registration writes and link renewals", async () => {
  const f = await fixture();
  try {
    const intake = await f.issue();
    const cancelled = await f.call(`/appointments/${intake.appointmentId}`, "PATCH", { status: "Cancelled" }, f.front);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
    const before = JSON.stringify(loadWorkflow(f.db).digital_checkin);
    const attempts: [string, Record<string, unknown>][] = [
      ["", { contact: proposedContact }],
      ["/files", { side: "Front", name: "front.png", mime_type: "image/png", data_base64: image.toString("base64"), client_id: randomUUID() }],
      [`/consents/${intake.packet.consents[0].id}`, { client_id: randomUUID(), signer_name: "Synthetic Patient", signer_role: "Patient", relationship: "", agree: true }],
      ["/submit", { client_id: randomUUID(), no_card_reason: "Not available" }],
    ];
    for (const [suffix, body] of attempts) {
      const result = await f.call(intake.path + suffix, "POST", { revision: intake.packet.revision, ...body }, "");
      assert.equal(result.status, 409, JSON.stringify(result.data));
      assert.equal(JSON.stringify(loadWorkflow(f.db).digital_checkin), before);
    }
    assert.equal((await f.call(`/workflow/intake-links/${intake.id}/renew`, "POST", {}, f.front)).status, 409);
  } finally { await f.close(); }
});

test("administrators version consent forms while non-admin staff can only read them", async () => {
  const f = await fixture();
  try {
    const body = { client_id: randomUUID(), title: "Synthetic practice consent", text: "Please read this exact synthetic practice consent before signing." };
    assert.equal((await f.call("/workflow/digital-checkin/forms", "POST", body, f.front)).status, 403);
    const created = await f.call("/workflow/digital-checkin/forms", "POST", body);
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const form = created.data;
    assert.equal((await f.call(`/workflow/digital-checkin/forms/${form.id}`, "PATCH", { revision: form.revision, archived: true }, f.front)).status, 403);
    const repeated = await f.call("/workflow/digital-checkin/forms", "POST", body);
    assert.equal(repeated.status, 200, JSON.stringify(repeated.data));
    assert.equal(repeated.data.id, form.id);
    const first = await f.issue();
    assert.ok(first.packet.consents.some((row) => row.form_id === form.id));
    const archived = await f.call(`/workflow/digital-checkin/forms/${form.id}`, "PATCH", { revision: form.revision, archived: true });
    assert.equal(archived.status, 200, JSON.stringify(archived.data));
    const later = await f.issue("pat-002");
    assert.equal(later.packet.consents.some((row) => row.form_id === form.id), false);
    const original = (await f.call(first.path, "GET", undefined, "")).data;
    assert.ok(original.consents.some((row: any) => row.form_id === form.id), "archiving a template never erases issued consent records");
  } finally { await f.close(); }
});

test("a changed visit insurance account requires staff acknowledgement and preserves the original card association", async () => {
  const f = await fixture();
  try {
    const intake = await f.issue();
    const originalAccount = structuredClone(intake.packet.billing_account);
    await intake.complete();
    const account = await f.call("/workflow/finance/accounts", "POST", {
      patient_id: "pat-001", name: "Synthetic work injury claim", kind: "Workers compensation",
      workers_comp: {
        claim_number: "SYNTHETIC-CHECKIN-WC", carrier: "Synthetic Workers Carrier", date_of_injury: "2020-01-02",
        employer: "Synthetic Employer", claim_status: "Accepted", accepted_body_parts: ["Left shoulder"],
      },
    });
    assert.equal(account.status, 200, JSON.stringify(account.data));
    const changed = await f.call(`/appointments/${intake.appointmentId}/billing-account`, "PATCH", {
      previous_billing_account_id: originalAccount.id, billing_account_id: account.data.id,
    }, f.front);
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    const detail = (await f.call(`/workflow/digital-checkin/${intake.id}`, "GET", undefined, f.front)).data;
    assert.equal(detail.account_mismatch, true);
    assert.equal(detail.billing_account.id, originalAccount.id);
    assert.equal(detail.current_billing_account.id, account.data.id);
    const body = {
      revision: detail.revision, demographics_revision: detail.demographics_revision,
      apply_demographics: false, reason: "Reviewed registration for changed visit payer",
    };
    assert.equal((await f.call(`/workflow/digital-checkin/${intake.id}/review`, "POST", body, f.front)).status, 409);
    const accepted = await f.call(`/workflow/digital-checkin/${intake.id}/review`, "POST", {
      ...body, account_mismatch_acknowledged: true,
    }, f.front);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    assert.equal(accepted.data.status, "Reviewed");
    assert.equal(accepted.data.billing_account.id, originalAccount.id);
    const stored = loadWorkflow(f.db).digital_checkin.packets.find((row) => row.id === intake.id)!;
    assert.equal(stored.account_mismatch_acknowledged, true);
    assert.equal(stored.reviewed_billing_account?.id, account.data.id);
  } finally { await f.close(); }
});

test("registration links route to their own practice, isolate staff files, and retain signed originals across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cevrali-checkin-isolation-"));
  let db = createDatabase(join(directory, "demo.sqlite"));
  let platform = createPlatformApp(db, join(directory, "accounts"));
  let server = platform.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  let base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (path: string, method = "GET", body?: unknown, cookie = "") => {
    const response = await fetch(base + path, {
      method, headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] || "" };
  };
  const stop = async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    platform.store.close(); db.close();
  };
  try {
    const workspaces: { cookie: string; token: string; intakeId: string; packet: CheckInPacketView }[] = [];
    for (const label of ["Alpha", "Beta"]) {
      const signup = await call("/accounts/signup", "POST", {
        owner_name: `Synthetic ${label} Owner`, email: `${label.toLowerCase()}@example.test`, password: "SyntheticCheckIn2026!",
        clinical_access: true, practice: { name: `${label} Synthetic Practice`, phone: "555-0100", address: "100 Synthetic Street" },
      });
      assert.equal(signup.status, 201, JSON.stringify(signup.data));
      const patient = await call("/patients", "POST", {
        first_name: "Synthetic", last_name: label, dob: "1990-01-01", sex: "Unknown", phone: "555-0102",
      }, signup.cookie);
      assert.equal(patient.status, 201, JSON.stringify(patient.data));
      const appointment = await call("/appointments", "POST", {
        patient_id: patient.data.id, date: "2099-02-01", time: "09:00", type: "Consultation", reason: "Practice isolation test",
      }, signup.cookie);
      assert.equal(appointment.status, 201, JSON.stringify(appointment.data));
      const issued = await call("/workflow/intake-links", "POST", { appointment_id: appointment.data.id }, signup.cookie);
      assert.equal(issued.status, 200, JSON.stringify(issued.data));
      const packet = await call(`/intake-links/${issued.data.token}/registration`);
      assert.equal(packet.status, 200, JSON.stringify(packet.data));
      assert.equal(packet.data.practice_name, `${label} Synthetic Practice`);
      workspaces.push({ cookie: signup.cookie, token: issued.data.token, intakeId: issued.data.id, packet: packet.data });
    }
    const [alpha, beta] = workspaces;
    const path = `/intake-links/${alpha.token}/registration`;
    const uploaded = await call(path + "/files", "POST", {
      revision: alpha.packet.revision, side: "Front", name: "alpha-card.png", mime_type: "image/png",
      data_base64: image.toString("base64"), client_id: randomUUID(),
    });
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
    const consent = uploaded.data.consents[0];
    const signed = await call(`${path}/consents/${consent.id}`, "POST", {
      revision: uploaded.data.revision, client_id: randomUUID(), signer_name: "Synthetic Alpha",
      signer_role: "Patient", relationship: "", agree: true,
    });
    assert.equal(signed.status, 200, JSON.stringify(signed.data));
    const file = signed.data.files[0];
    assert.equal((await call(`/workflow/digital-checkin/${alpha.intakeId}`, "GET", undefined, beta.cookie)).status, 404);
    assert.equal((await call(`/workflow/digital-checkin/${alpha.intakeId}/files/${file.id}`, "GET", undefined, beta.cookie)).status, 404);
    assert.equal((await call(`/intake-links/${beta.token}/registration/files/${file.id}`)).status, 404);
    const withOtherSession = await call(path, "GET", undefined, beta.cookie);
    assert.equal(withOtherSession.status, 200);
    assert.equal(withOtherSession.data.practice_name, "Alpha Synthetic Practice", "the patient token selects its practice even if another staff session exists");
    assert.equal((await call("/workflow/digital-checkin", "GET", undefined, beta.cookie)).data.every((row: any) => row.id !== alpha.intakeId), true);
    const savedSignature = structuredClone(signed.data.consents[0]);
    await stop();
    db = createDatabase(join(directory, "demo.sqlite"));
    platform = createPlatformApp(db, join(directory, "accounts"));
    server = platform.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const restored = await call(path);
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.deepEqual(restored.data.consents[0], savedSignature);
    const original = await call(`${path}/files/${file.id}`);
    assert.equal(original.status, 200);
    assert.deepEqual(Buffer.from(original.data.data_base64, "base64"), image);
    assert.equal((await call(`/workflow/digital-checkin/${alpha.intakeId}`, "GET", undefined, beta.cookie)).status, 404);
  } finally {
    await stop(); rmSync(directory, { recursive: true, force: true });
  }
});
