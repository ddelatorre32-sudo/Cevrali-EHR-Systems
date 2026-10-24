import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createDatabase, clinicDate } from "../server/database.js";
import { createPlatformApp } from "../server/platform.js";
import { loadWorkflow } from "../server/workflows.js";
import { readWorkflowState } from "../server/workflow-engine.js";
const basePath = "/workflow/operations";
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cevrali-operations-"));
  let db = createDatabase(join(dir, "demo.sqlite"));
  let platform = createPlatformApp(db, join(dir, "accounts"));
  let server = platform.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  let base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let cookie = "",
    front = "";
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    auth = cookie,
  ) {
    const r = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: auth },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: r.status,
      data: await r.json(),
      cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
    };
  }
  cookie = (
    await call(
      "/auth/login",
      "POST",
      { email: "alex@cevrali.demo", password: "CevraliDemo2026!" },
      "",
    )
  ).cookie;
  front = (
    await call(
      "/auth/login",
      "POST",
      { email: "frontdesk@cevrali.demo", password: "CevraliDemo2026!" },
      "",
    )
  ).cookie;
  const p = (await call("/patients")).data.find((p: any) => p.id === "pat-001");
  const text = `Patient Name: ${p.first_name} ${p.last_name}\nDOB: ${p.dob}\nMRN: CV-00001\nDocument Type: Radiology report\n\nSynthetic private clinical report content.`;
  async function receive(extra: Record<string, unknown> = {}, auth = front) {
    return call(
      `${basePath}/incoming-faxes`,
      "POST",
      {
        external_id: "FAX-01",
        sender: "Synthetic Facility",
        filename: "received.txt",
        format: "text",
        text,
        ...extra,
      },
      auth,
    );
  }
  async function wc() {
    const r = await call("/workflow/finance/accounts", "POST", {
      patient_id: p.id,
      name: "Operations work injury",
      kind: "Workers compensation",
      workers_comp: {
        claim_number: "OPS-WC-01",
        carrier: "Synthetic Carrier",
        date_of_injury: "2020-01-01",
        employer: "Synthetic Employer",
        claim_status: "Accepted",
        accepted_body_parts: ["Left shoulder"],
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  }
  async function approved(account: any) {
    const policy = (
      await call("/workflow/finance/policies?billing_account_id=" + account.id)
    ).data[0];
    const r = await call("/workflow/finance/authorizations", "POST", {
      patient_id: p.id,
      policy_id: policy.id,
      procedure_codes: ["99213", "97810", "73221"],
      description: "Office review, acupuncture and imaging",
      requested_visits: 10,
      valid_from: clinicDate(),
      valid_to: "2099-01-01",
      due_date: clinicDate(),
    });
    assert.equal(r.status, 200);
    await call(
      "/workflow/finance/authorizations/" + r.data.id + "/submit",
      "POST",
      {},
    );
    const a = await call(
      "/workflow/finance/authorizations/" + r.data.id + "/decision",
      "POST",
      {
        outcome: "Approved",
        note: "Synthetic demo approval reviewed",
        approval_number: "OPS-DEMO-APPROVAL",
        approved_visits: 10,
        valid_from: clinicDate(),
        valid_to: "2099-01-01",
      },
    );
    assert.equal(a.status, 200);
    return { auth: a.data, policy };
  }
  async function allowance(a: any, extra: Record<string, unknown> = {}) {
    return call(`${basePath}/service-approvals`, "POST", {
      authorization_id: a.id,
      procedure_code: "97810",
      category: "Acupuncture",
      description: "Acupuncture treatment",
      unit: "Visits",
      approved_quantity: 6,
      decision_note: "Synthetic service decision recorded",
      ...extra,
    });
  }
  const plan = (s: any, n = 1) => ({
    authorization_required: true,
    services: [
      { approval_id: s.id, procedure_code: s.procedure_code, quantity: n },
    ],
  });
  async function schedule(
    account: any,
    service_plan?: unknown,
    time = "01:00",
    patientId = p.id,
  ) {
    return call("/appointments", "POST", {
      patient_id: patientId,
      billing_account_id: account.id,
      date: clinicDate(),
      time,
      duration: 30,
      type: "Follow-up",
      reason: "Synthetic scheduled care",
      service_plan,
    });
  }
  async function close() {
    await new Promise<void>((r) => server.close(() => r()));
    platform.store.close();
    db.close();
  }
  return {
    call,
    receive,
    wc,
    approved,
    allowance,
    plan,
    schedule,
    p,
    text,
    cookie,
    front,
    db: () => db,
    state: () => loadWorkflow(db),
    cleanup: async () => {
      await close();
      rmSync(dir, { recursive: true, force: true });
    },
    reopen: async () => {
      await close();
      db = createDatabase(join(dir, "demo.sqlite"));
      platform = createPlatformApp(db, join(dir, "accounts"));
      server = platform.app.listen(0, "127.0.0.1");
      await new Promise<void>((r) => server.once("listening", r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    },
  };
}
async function pdf(lines: string[]) {
  const doc = await PDFDocument.create();
  const p = doc.addPage();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  lines.forEach((line, i) =>
    p.drawText(line, { x: 30, y: 760 - i * 20, size: 11, font }),
  );
  return Buffer.from(await doc.save()).toString("base64");
}

test("additive operations migration preserves existing records without replacing workflow state", () => {
  const saved = {
    version: 1,
    finance: { bills: [{ id: "existing" }] },
    visits: { existing: { stage: "Waiting" } },
  };
  const s = readWorkflowState(JSON.stringify(saved));
  assert.equal(s.finance.bills[0].id, "existing");
  assert.equal(s.visits.existing.stage, "Waiting");
  assert.deepEqual(s.operations.incoming_faxes, []);
});

test("exact incoming fax matching autosaves original to chart, creates a clinical task and safe per-user front-desk alerts", async () => {
  const f = await fixture();
  try {
    const r = await f.receive();
    assert.equal(r.status, 200);
    assert.equal(r.data.status, "Filed");
    assert.equal(r.data.patient_id, f.p.id);
    assert.equal(r.data.extracted_text, undefined);
    const docs = await f.call(
      `${basePath}/documents?patient_id=${f.p.id}`,
      "GET",
      undefined,
      f.front,
    );
    assert.equal(docs.data.length, 1);
    assert.ok(!JSON.stringify(docs.data).includes("private clinical"));
    const original = await f.call(`${basePath}/documents/${r.data.id}`);
    assert.equal(
      Buffer.from(original.data.original_base64, "base64").toString(),
      f.text,
    );
    assert.equal(
      (
        await f.call(
          `${basePath}/documents/${r.data.id}`,
          "GET",
          undefined,
          f.front,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call(
          `${basePath}/incoming-faxes/${r.data.id}`,
          "GET",
          undefined,
          f.front,
        )
      ).status,
      403,
    );
    assert.equal(
      f.state().tasks.filter((t) => t.source_key?.startsWith("incoming-fax:"))
        .length,
      1,
    );
    const alerts = (
      await f.call(`${basePath}/alerts`, "GET", undefined, f.front)
    ).data;
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].acknowledged, false);
    await f.call(
      `${basePath}/alerts/${alerts[0].id}/acknowledge`,
      "POST",
      {},
      f.front,
    );
    assert.equal(
      (await f.call(`${basePath}/alerts`, "GET", undefined, f.front)).data[0]
        .acknowledged,
      true,
    );
    assert.equal(
      (await f.call(`${basePath}/alerts`)).data[0].acknowledged,
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("fax reference and original-byte deduplication prevent duplicate documents, alerts and review tasks", async () => {
  const f = await fixture();
  try {
    const a = await f.receive(),
      b = await f.receive(),
      c = await f.receive({ external_id: "REDELIVERY" });
    assert.equal(a.data.id, b.data.id);
    assert.equal(a.data.id, c.data.id);
    assert.equal(
      (await f.receive({ text: f.text + " Changed body" })).status,
      409,
    );
    assert.equal(f.state().operations.incoming_faxes.length, 1);
    assert.equal(f.state().operations.alerts.length, 1);
    assert.equal(
      f.state().tasks.filter((t) => t.source_key?.startsWith("incoming-fax:"))
        .length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test("conflicting identifiers, ambiguous patients and unmatched claim numbers remain in review without any chart attachment", async () => {
  const f = await fixture();
  try {
    for (const [i, text] of [
      f.text.replace("CV-00001", "CV-00002"),
      f.text + "\nPatient Name: Another Person",
      f.text.replace(f.p.dob, "1901-01-01"),
      f.text + "\nClaim Number: UNKNOWN",
    ].entries()) {
      const r = await f.receive({ external_id: "CONFLICT-" + i, text });
      assert.equal(r.data.status, "Needs review");
      assert.equal(r.data.patient_id, "");
    }
    const duplicate = await f.call("/patients", "POST", {
      first_name: f.p.first_name,
      last_name: f.p.last_name,
      dob: f.p.dob,
      sex: f.p.sex,
      phone: "555-0199",
      duplicate_acknowledged: true,
    });
    assert.equal(duplicate.status, 201);
    const r = await f.receive({
      external_id: "AMBIGUOUS",
      text: f.text.replace("MRN: CV-00001\n", ""),
    });
    assert.equal(r.data.status, "Needs review");
    assert.equal(
      (await f.call(`${basePath}/documents?patient_id=${f.p.id}`)).data.length,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test("PDF text is extracted from original bytes and image-only or partially unreadable PDFs never trust client-provided extracted text", async () => {
  const f = await fixture();
  try {
    const original = await pdf(f.text.split("\n"));
    const r = await f.receive({
      format: "pdf",
      filename: "report.pdf",
      original_base64: original,
      text: "Patient Name: Forged",
      extracted_text: "forged",
      digest: "forged",
    });
    assert.equal(r.data.status, "Filed", JSON.stringify(r.data));
    const d = (await f.call(`${basePath}/documents/${r.data.id}`)).data;
    assert.equal(d.original_base64, original);
    assert.match(d.extracted_text, /Synthetic private clinical/);
    const blank = await PDFDocument.create();
    blank.addPage();
    const b = await f.receive({
      external_id: "SCAN",
      format: "pdf",
      original_base64: Buffer.from(await blank.save()).toString("base64"),
      extracted_text: f.text,
    });
    assert.equal(b.data.status, "Needs review");
    assert.match(b.data.match_reason, /readable|OCR/);
    const mixed = await PDFDocument.load(Buffer.from(original, "base64"));
    mixed.addPage();
    const c = await f.receive({
      external_id: "MIXED",
      format: "pdf",
      original_base64: Buffer.from(await mixed.save()).toString("base64"),
    });
    assert.equal(c.data.status, "Needs review");
    assert.equal(
      (
        await f.receive({
          external_id: "BAD",
          format: "pdf",
          original_base64: btoa("not pdf"),
        })
      ).status,
      400,
    );
  } finally {
    await f.cleanup();
  }
});

test("claim numbers file documents only to the matching patient claim and never grant authorization or modify signed clinical records", async () => {
  const f = await fixture();
  try {
    const account = await f.wc();
    const before = f.state().finance.authorizations.length;
    const r = await f.receive({
      text:
        f.text +
        "\nClaim Number: OPS-WC-01\nAuthorization approved for all treatment",
    });
    assert.equal(r.data.status, "Filed");
    assert.equal(r.data.billing_account_id, account.id);
    const rows = (
      await f.call(
        `${basePath}/claims?patient_id=${f.p.id}`,
        "GET",
        undefined,
        f.front,
      )
    ).data;
    assert.equal(rows[0].documents.length, 1);
    assert.equal(rows[0].work_status, null);
    assert.equal(f.state().finance.authorizations.length, before);
  } finally {
    await f.cleanup();
  }
});

test("clinical review and audited reassignment preserve original bytes, require confirmation and reject stale or cross-patient account selections", async () => {
  const f = await fixture();
  try {
    const received = (await f.receive()).data;
    const account = await f.wc();
    const data = {
      revision: received.revision,
      patient_id: "pat-002",
      billing_account_id: account.id,
      identity_confirmed: true,
      reason: "Identity manually reviewed",
    };
    assert.equal(
      (
        await f.call(
          `${basePath}/incoming-faxes/${received.id}/file`,
          "POST",
          data,
          f.front,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call(
          `${basePath}/incoming-faxes/${received.id}/file`,
          "POST",
          data,
        )
      ).status,
      400,
    );
    const r = await f.call(
      `${basePath}/incoming-faxes/${received.id}/file`,
      "POST",
      { ...data, billing_account_id: "" },
    );
    assert.equal(r.status, 200);
    assert.equal(
      (await f.call(`${basePath}/documents?patient_id=pat-001`)).data.length,
      0,
    );
    assert.equal(
      (await f.call(`${basePath}/documents?patient_id=pat-002`)).data.length,
      1,
    );
    assert.equal(
      (
        await f.call(`${basePath}/incoming-faxes/${received.id}/file`, "POST", {
          ...data,
          billing_account_id: "",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.call(
          `${basePath}/incoming-faxes/${received.id}/review`,
          "POST",
          {
            revision: r.data.revision,
            reason: "Reviewed clinical outside report",
          },
        )
      ).status,
      200,
    );
    assert.ok(
      f
        .state()
        .tasks.filter((t) => t.source_key?.startsWith("incoming-fax:"))
        .every((t) => t.done === 1),
    );
    assert.equal(
      Buffer.from(
        (await f.call(`${basePath}/documents/${received.id}`)).data
          .original_base64,
        "base64",
      ).toString(),
      f.text,
    );
    const safe = (
      await f.call(
        `${basePath}/documents?patient_id=pat-002`,
        "GET",
        undefined,
        f.front,
      )
    ).data;
    assert.ok(
      !JSON.stringify(safe).includes("Reviewed clinical outside report"),
    );
  } finally {
    await f.cleanup();
  }
});

test("service allowances require a current approved authorization and preserve procedure identity and counting units", async () => {
  const f = await fixture();
  try {
    const account = await f.wc();
    const { auth } = await f.approved(account);
    assert.equal(
      (await f.allowance(auth, { procedure_code: "93000" })).status,
      400,
    );
    const s = await f.allowance(auth);
    assert.equal(s.status, 200);
    assert.equal((await f.allowance(auth)).status, 409);
    const updated = await f.call(
      `${basePath}/service-approvals/${s.data.id}`,
      "PATCH",
      {
        ...s.data,
        unit: "Units",
        decision_note: "Changing unit is not allowed",
      },
    );
    assert.equal(updated.status, 409);
    const rows = (
      await f.call(`${basePath}/service-approvals?patient_id=${f.p.id}`)
    ).data;
    assert.equal(rows[0].remaining, 6);
  } finally {
    await f.cleanup();
  }
});

test("scheduling atomically reserves service-specific quantities and rejects overbooking or mismatched patients without partial appointments", async () => {
  const f = await fixture();
  try {
    const account = await f.wc(),
      { auth } = await f.approved(account);
    const acu = (await f.allowance(auth)).data,
      mri = (
        await f.allowance(auth, {
          procedure_code: "73221",
          category: "Radiology",
          unit: "Studies",
          approved_quantity: 1,
        })
      ).data;
    const a = await f.schedule(account, {
      authorization_required: true,
      services: [...f.plan(acu, 2).services, ...f.plan(mri).services],
    });
    assert.equal(a.status, 201);
    let rows = (await f.call(`${basePath}/service-approvals`)).data;
    assert.equal(rows.find((s: any) => s.id === acu.id).remaining, 4);
    assert.equal(rows.find((s: any) => s.id === mri.id).remaining, 0);
    const before = (await f.call("/appointments")).data.length;
    assert.equal((await f.schedule(account, f.plan(mri), "02:00")).status, 409);
    assert.equal(
      (
        await f.schedule(
          { id: "pba-private-pat-002" },
          f.plan(acu),
          "02:00",
          "pat-002",
        )
      ).status,
      400,
    );
    assert.equal((await f.call("/appointments")).data.length, before);
    assert.equal(
      (
        await f.call(
          "/workflow/finance/authorizations/" + auth.id + "/cancel",
          "POST",
          { reason: "Cannot cancel reserved treatment" },
        )
      ).status,
      409,
    );
    await f.call("/appointments/" + a.data.id, "PATCH", {
      status: "Cancelled",
    });
    rows = (await f.call(`${basePath}/service-approvals`)).data;
    assert.equal(rows.find((s: any) => s.id === acu.id).remaining, 6);
    assert.equal(rows.find((s: any) => s.id === mri.id).remaining, 1);
  } finally {
    await f.cleanup();
  }
});

test("visit plan revisions replace reservations and insurance changes permanently release old holds until reviewed again", async () => {
  const f = await fixture();
  try {
    const account = await f.wc(),
      { auth } = await f.approved(account),
      s = (await f.allowance(auth)).data;
    const a = (await f.schedule(account, f.plan(s, 2))).data;
    let plan = (await f.call(`${basePath}/visit-plans/${a.id}`)).data;
    assert.equal(
      (
        await f.call(`${basePath}/visit-plans/${a.id}`, "POST", {
          ...f.plan(s, 3),
          revision: plan.revision,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.call(`${basePath}/visit-plans/${a.id}`, "POST", {
          ...f.plan(s),
          revision: plan.revision,
        })
      ).status,
      409,
    );
    assert.equal(
      (await f.call(`${basePath}/service-approvals`)).data[0].remaining,
      3,
    );
    assert.equal(
      (
        await f.call("/appointments/" + a.id + "/billing-account", "PATCH", {
          billing_account_id: "pba-private-pat-001",
          previous_billing_account_id: account.id,
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.call(`${basePath}/service-approvals`)).data[0].remaining,
      6,
    );
    await f.call("/appointments/" + a.id + "/billing-account", "PATCH", {
      billing_account_id: account.id,
      previous_billing_account_id: "pba-private-pat-001",
    });
    assert.equal(
      (await f.call(`${basePath}/service-approvals`)).data[0].remaining,
      6,
    );
    const ready = (await f.call(`${basePath}/readiness`)).data.find(
      (r: any) => r.id === a.id,
    );
    assert.ok(
      ready.issues.some((s: string) => s.includes("insurance changed")),
    );
  } finally {
    await f.cleanup();
  }
});

test("completed treatments retain reservations until actual review then consume their own allowance without silent edits", async () => {
  const f = await fixture();
  try {
    const account = await f.wc(),
      { auth } = await f.approved(account),
      s = (await f.allowance(auth)).data;
    const a = (await f.schedule(account, f.plan(s, 2))).data;
    for (const status of ["Checked in", "In progress", "Completed"])
      assert.equal(
        (await f.call("/appointments/" + a.id, "PATCH", { status })).status,
        200,
      );
    let row = (await f.call(`${basePath}/service-approvals`)).data[0];
    assert.equal(row.reserved, 2);
    assert.equal(row.completed, 0);
    assert.equal(row.remaining, 4);
    const plan = (await f.call(`${basePath}/visit-plans/${a.id}`)).data;
    const reviewed = await f.call(
      `${basePath}/treatments?appointment_id=${a.id}`,
      "POST",
      {
        revision: 0,
        plan_revision: plan.revision,
        reason:
          "Clinician confirmed both planned treatment units were performed",
        services: [
          {
            procedure_code: s.procedure_code,
            performed: 2,
            deferred: 0,
            cancelled: 0,
          },
        ],
      },
    );
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
    row = (await f.call(`${basePath}/service-approvals`)).data[0];
    assert.equal(row.reserved, 0);
    assert.equal(row.completed, 2);
    assert.equal(row.remaining, 4);
    assert.equal(
      (
        await f.call(`${basePath}/visit-plans/${a.id}`, "POST", {
          authorization_required: false,
          services: [],
          revision: plan.revision,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call(`${basePath}/service-approvals/${s.id}`, "PATCH", {
          ...s,
          approved_quantity: 1,
          decision_note: "Cannot shrink below used count",
        })
      ).status,
      409,
    );
  } finally {
    await f.cleanup();
  }
});

test("readiness uses selected visit insurance, current coverage, intake and outside clinical review without exposing note content", async () => {
  const f = await fixture();
  try {
    const account = await f.wc(),
      { auth, policy } = await f.approved(account),
      s = (await f.allowance(auth)).data;
    const a = (await f.schedule(account, f.plan(s))).data;
    const verify = await f.call(
      "/workflow/finance/policies/" + policy.id + "/verify",
      "POST",
      { service_date: clinicDate(), scenario: "Active" },
    );
    assert.equal(verify.status, 200);
    const link = await f.call("/workflow/intake-links", "POST", {
      appointment_id: a.id,
    });
    assert.equal(link.status, 200);
    assert.equal(
      (
        await f.call(
          "/intake-links/" + link.data.token,
          "POST",
          {
            concern: "Synthetic visit concern",
            symptoms: "Synthetic symptoms",
            allergies: [],
            medications: [],
            reminder_consent: false,
            attested: true,
          },
          "",
        )
      ).status,
      200,
    );
    let r = (
      await f.call(`${basePath}/readiness`, "GET", undefined, f.front)
    ).data.find((r: any) => r.id === a.id);
    assert.deepEqual(r.issues, []);
    await f.receive({ text: f.text + "\nClaim Number: OPS-WC-01" });
    r = (
      await f.call(`${basePath}/readiness`, "GET", undefined, f.front)
    ).data.find((r: any) => r.id === a.id);
    assert.ok(r.issues.some((v: string) => v.includes("clinician review")));
    assert.ok(!JSON.stringify(r).includes("private clinical"));
  } finally {
    await f.cleanup();
  }
});

test("incoming originals, alerts and treatment reservations persist across restart and remain isolated from a new practice", async () => {
  const f = await fixture();
  try {
    const r = await f.receive(),
      account = await f.wc(),
      { auth } = await f.approved(account),
      s = (await f.allowance(auth)).data;
    await f.schedule(account, f.plan(s));
    await f.reopen();
    assert.equal(
      (await f.call(`${basePath}/documents/${r.data.id}`)).status,
      200,
    );
    assert.equal(
      (await f.call(`${basePath}/service-approvals`)).data[0].reserved,
      1,
    );
    const created = await f.call("/accounts/signup", "POST", {
      owner_name: "Isolated Owner",
      email: "isolated-ops@example.test",
      password: "SyntheticPassword2026!",
      clinical_access: true,
      practice: {
        name: "Isolated Practice",
        phone: "555-0199",
        address: "Synthetic address",
      },
    });
    assert.equal(created.status, 201);
    for (const path of ["incoming-faxes", "alerts", "service-approvals"])
      assert.deepEqual(
        (await f.call(`${basePath}/${path}`, "GET", undefined, created.cookie))
          .data,
        [],
      );
    assert.equal(
      (
        await f.call(
          `${basePath}/documents/${r.data.id}`,
          "GET",
          undefined,
          created.cookie,
        )
      ).status,
      404,
    );
  } finally {
    await f.cleanup();
  }
});

async function resultPatient(f: Awaited<ReturnType<typeof fixture>>) {
  const created = await f.call("/patients", "POST", {
    first_name: "ResultExample",
    last_name: "Patient",
    dob: "1990-05-06",
    sex: "Unknown",
    phone: "555-0188",
    address: "Synthetic address",
  });
  assert.equal(created.status, 201);
  const id = created.data.id;
  const report = `Patient Name: ResultExample Patient\nDOB: 1990-05-06\nMRN: CV-${id.replace("pat-", "").toUpperCase().padStart(5, "0")}\nDocument Type: Lab report\n\nSynthetic hemoglobin: 13.2 g/dL. Reference interval: 12.0-16.0 g/dL.\nOriginal report text; no interpretation generated.`;
  const createNote = async (extra: Record<string, unknown> = {}) => {
    const n = await f.call("/encounters", "POST", {
      patient_id: id,
      chief_complaint: "Synthetic results review",
      ...extra,
    });
    assert.equal(n.status, 201);
    return (await f.call("/encounters")).data.find(
      (e: any) => e.id === n.data.id,
    );
  };
  return { id, report, createNote };
}
test("a clearly matched report populates the only current draft verbatim and requires author review plus current result version before signature", async () => {
  const f = await fixture();
  try {
    const p = await resultPatient(f),
      n = await p.createNote();
    const received = await f.receive({ text: p.report });
    assert.equal(received.data.status, "Filed");
    let section = (
      await f.call(`${basePath}/note-results?encounter_id=${n.id}`)
    ).data;
    assert.equal(section.results.length, 1);
    assert.equal(section.results[0].text, p.report);
    assert.equal(section.results[0].status, "Pending review");
    assert.equal(
      (
        await f.call(
          `${basePath}/note-results?encounter_id=${n.id}`,
          "GET",
          undefined,
          f.front,
        )
      ).status,
      403,
    );
    const fields = {
      ...n,
      assessment: "Provider assessment recorded",
      plan: "Provider plan recorded",
      status: "Signed",
      received_results_version: section.version,
    };
    assert.equal(
      (await f.call("/encounters/" + n.id, "PATCH", fields)).status,
      409,
    );
    const other = (
      await f.call(
        "/auth/login",
        "POST",
        { email: "nina@cevrali.demo", password: "CevraliDemo2026!" },
        "",
      )
    ).cookie;
    assert.equal(
      (
        await f.call(
          `${basePath}/note-results/${section.results[0].id}/review`,
          "POST",
          {
            revision: section.results[0].revision,
            decision: "Include",
            reason: "Source reviewed for this visit",
          },
          other,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call(
          `${basePath}/note-results/${section.results[0].id}/review`,
          "POST",
          {
            revision: section.results[0].revision,
            decision: "Include",
            reason: "Source reviewed for this visit",
          },
        )
      ).status,
      200,
    );
    assert.equal(
      (await f.call("/encounters/" + n.id, "PATCH", fields)).status,
      409,
    );
    section = (await f.call(`${basePath}/note-results?encounter_id=${n.id}`))
      .data;
    assert.equal(
      (
        await f.call("/encounters/" + n.id, "PATCH", {
          ...fields,
          received_results_version: section.version,
        })
      ).status,
      200,
    );
    const signed = (await f.call("/encounters")).data.find(
      (e: any) => e.id === n.id,
    );
    assert.equal(signed.received_results[0].text, p.report);
    assert.equal(signed.objective, n.objective);
    assert.equal(signed.assessment, fields.assessment);
    const saved = JSON.stringify(signed.received_results);
    await f.receive({
      external_id: "LATE",
      text: p.report + "\nAdditional synthetic result.",
    });
    assert.equal(
      JSON.stringify(
        (await f.call("/encounters")).data.find((e: any) => e.id === n.id)
          .received_results,
      ),
      saved,
    );
    assert.equal(
      (
        await f.call(
          `${basePath}/note-results/${section.results[0].id}/review`,
          "POST",
          {
            revision: section.results[0].revision,
            decision: "Exclude",
            reason: "Cannot rewrite signed result",
          },
        )
      ).status,
      409,
    );
  } finally {
    await f.cleanup();
  }
});

test("multiple draft visits need a provider-selected report link and reports cannot cross patient or private/work-comp accounts", async () => {
  const f = await fixture();
  try {
    const p = await resultPatient(f),
      first = await p.createNote(),
      second = await p.createNote();
    const received = await f.receive({ text: p.report });
    let s = (await f.call(`${basePath}/note-results?encounter_id=${first.id}`))
      .data;
    assert.equal(s.results.length, 0);
    assert.equal(s.candidates.length, 1);
    assert.equal(
      (
        await f.call(`${basePath}/note-results`, "POST", {
          document_id: received.data.id,
          encounter_id: first.id,
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.call(`${basePath}/note-results?encounter_id=${second.id}`)).data
        .results.length,
      0,
    );
    const wrong = (await f.call("/encounters")).data.find(
      (e: any) => e.patient_id !== p.id && e.status === "Draft",
    );
    assert.equal(
      (
        await f.call(`${basePath}/note-results`, "POST", {
          document_id: received.data.id,
          encounter_id: wrong.id,
        })
      ).status,
      400,
    );
    const wc = await f.wc();
    const compNote = (
      await f.call("/encounters", "POST", {
        patient_id: f.p.id,
        billing_account_id: wc.id,
        chief_complaint: "Synthetic claim care",
      })
    ).data;
    const general = await f.receive({ external_id: "GENERAL", text: f.text });
    assert.equal(
      (
        await f.call(`${basePath}/note-results`, "POST", {
          document_id: general.data.id,
          encounter_id: compNote.id,
        })
      ).status,
      400,
    );
  } finally {
    await f.cleanup();
  }
});

test("corrected fax filing clears transcribed text from an unsigned note and requires exclusion or relinking before signature", async () => {
  const f = await fixture();
  try {
    const p = await resultPatient(f),
      n = await p.createNote(),
      r = (await f.receive({ text: p.report })).data;
    const moved = await f.call(
      `${basePath}/incoming-faxes/${r.id}/file`,
      "POST",
      {
        revision: r.revision,
        patient_id: "pat-002",
        billing_account_id: "",
        identity_confirmed: true,
        reason: "Corrected patient after original document review",
      },
    );
    assert.equal(moved.status, 200);
    let s = (await f.call(`${basePath}/note-results?encounter_id=${n.id}`))
      .data;
    assert.equal(s.results[0].status, "Source changed");
    assert.equal(s.results[0].text, "");
    const fields = {
      ...n,
      status: "Signed",
      assessment: "Provider assessment",
      plan: "Provider follow-up",
      received_results_version: s.version,
    };
    assert.equal(
      (await f.call("/encounters/" + n.id, "PATCH", fields)).status,
      409,
    );
    await f.call(`${basePath}/note-results/${s.results[0].id}/review`, "POST", {
      revision: s.results[0].revision,
      decision: "Exclude",
      reason: "Source belongs to another patient",
    });
    s = (await f.call(`${basePath}/note-results?encounter_id=${n.id}`)).data;
    assert.equal(
      (
        await f.call("/encounters/" + n.id, "PATCH", {
          ...fields,
          received_results_version: s.version,
        })
      ).status,
      200,
    );
    assert.deepEqual(
      (await f.call("/encounters")).data.find((e: any) => e.id === n.id)
        .received_results,
      [],
    );
  } finally {
    await f.cleanup();
  }
});

test("pre-visit review can confirm private self-pay without assigning workers compensation liability to the patient", async () => {
  const f = await fixture();
  try {
    const p = await resultPatient(f);
    const a = await f.schedule(
      { id: `pba-private-${p.id}` },
      undefined,
      "02:00",
      p.id,
    );
    assert.equal(a.status, 201);
    assert.equal(
      (
        await f.call(`${basePath}/visit-plans/${a.data.id}`, "POST", {
          authorization_required: false,
          services: [],
          coverage_mode: "Self-pay",
        })
      ).status,
      200,
    );
    const r = (await f.call(`${basePath}/readiness`)).data.find(
      (r: any) => r.id === a.data.id,
    );
    assert.deepEqual(r.issues, ["Pre-visit intake not submitted"]);
    const wc = await f.wc();
    const b = await f.schedule(wc, undefined, "03:00");
    assert.equal(b.status, 201);
    assert.equal(
      (
        await f.call(`${basePath}/visit-plans/${b.data.id}`, "POST", {
          authorization_required: false,
          services: [],
          coverage_mode: "Self-pay",
        })
      ).status,
      400,
    );
  } finally {
    await f.cleanup();
  }
});

test("pending authorization services stay flagged and closed approvals cannot gain new service allowances", async () => {
  const f = await fixture();
  try {
    const account = await f.wc(),
      { auth } = await f.approved(account);
    const pending = await f.schedule(account, {
      authorization_required: true,
      services: [{ approval_id: "", procedure_code: "73221", quantity: 1 }],
    });
    assert.equal(pending.status, 201);
    const r = (await f.call(`${basePath}/readiness`)).data.find(
      (r: any) => r.id === pending.data.id,
    );
    assert.ok(r.issues.includes("73221: approval needed"));
    assert.equal(
      (
        await f.call(
          "/workflow/finance/authorizations/" + auth.id + "/cancel",
          "POST",
          { reason: "Synthetic approval withdrawn with no reservations" },
        )
      ).status,
      200,
    );
    assert.equal((await f.allowance(auth)).status, 409);
  } finally {
    await f.cleanup();
  }
});

test("recorded lab results populate their ordering encounter with exact values, units and ranges without overwriting provider assessment", async () => {
  const f = await fixture();
  try {
    const p = await resultPatient(f),
      n = await p.createNote();
    const order = await f.call("/workflow/orders", "POST", {
      patient_id: p.id,
      encounter_id: n.id,
      kind: "Lab",
      name: "Hemoglobin",
      details: "Synthetic ordered test",
    });
    assert.equal(order.status, 200);
    await f.call("/workflow/orders/" + order.data.id, "PATCH", {
      status: "Prepared",
    });
    const result = await f.call("/workflow/results", "POST", {
      order_id: order.data.id,
      name: "Hemoglobin",
      value: "13.2",
      unit: "g/dL",
      reference_range: "12.0-16.0",
      flag: "Normal",
      external_id: "SYNTHETIC-LAB-OPS-01",
      patient_reference: `Patient/${p.id}`,
    });
    assert.equal(result.status, 200);
    let s = (await f.call(`${basePath}/note-results?encounter_id=${n.id}`))
      .data;
    assert.equal(s.results.length, 1);
    assert.equal(s.results[0].source_type, "Lab result");
    assert.match(s.results[0].text, /Hemoglobin: 13.2 g\/dL/);
    assert.match(s.results[0].text, /Reference range: 12.0-16.0/);
    assert.equal(
      (
        await f.call(
          `${basePath}/note-results/${s.results[0].id}/review`,
          "POST",
          {
            revision: s.results[0].revision,
            decision: "Include",
            reason: "Provider reviewed ordered laboratory result",
          },
        )
      ).status,
      200,
    );
    s = (await f.call(`${basePath}/note-results?encounter_id=${n.id}`)).data;
    assert.equal(
      (
        await f.call("/encounters/" + n.id, "PATCH", {
          ...n,
          status: "Signed",
          assessment: "Provider assessment documented independently",
          plan: "Follow-up plan documented independently",
          received_results_version: s.version,
        })
      ).status,
      200,
    );
    const saved = (await f.call("/encounters")).data.find(
      (e: any) => e.id === n.id,
    );
    assert.equal(
      saved.received_results[0].source_digest,
      "SYNTHETIC-LAB-OPS-01",
    );
    assert.equal(
      f.state().orders.find((o) => o.id === order.data.id)?.status,
      "Reviewed",
    );
    assert.ok(
      f.state().tasks.find((t) => t.source_key === `result:${result.data.id}`)
        ?.done,
    );
  } finally {
    await f.cleanup();
  }
});
