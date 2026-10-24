import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  emptyWorkflowState,
  readWorkflowState,
  type WorkflowContext,
} from "../server/workflow-engine.js";
import { operationsRequest } from "../server/operations-engine.js";
import { prepareIncomingDocument } from "../server/incoming-document.js";
import {
  validateNoteResultsForSignature,
  type NoteResult,
} from "../server/note-results.js";
import { createDatabase } from "../server/database.js";
import { createPlatformApp } from "../server/platform.js";
import { loadWorkflow } from "../server/workflows.js";

const rejected = (status: number) => (error: any) => error.status === status;

async function fixture() {
  const state = emptyWorkflowState();
  let serial = 0;
  const note = {
    id: "enc-1",
    patient_id: "pat-1",
    author_id: "doc-1",
    billing_account_id: "pba-private-pat-1",
    status: "Draft",
    created_at: "2026-10-22T16:00:00Z",
    updated_at: "2026-10-22T16:00:00Z",
  };
  const clinician = {
    id: "doc-1",
    name: "Dr. Test",
    role: "clinician",
    email: "test@example.test",
  };
  const ctx: WorkflowContext = {
    user: clinician,
    users: [clinician],
    patients: [
      {
        id: "pat-1",
        first_name: "ResultIntegrity",
        last_name: "Patient",
        dob: "1990-01-01",
      },
      {
        id: "pat-2",
        first_name: "Other",
        last_name: "Patient",
        dob: "1991-01-01",
      },
    ],
    encounters: [note],
    appointments: [],
    tasks: [],
    labs: [],
    now: "2026-10-22T16:00:00Z",
    today: "2026-10-22",
    local_time: "09:00",
    id: (prefix) => `${prefix}-${++serial}`,
    audit() {},
  };
  const call = (path: string, method = "GET", body?: unknown): any =>
    operationsRequest(
      state,
      ctx,
      method,
      new URL(`http://test/operations/${path}`),
      body,
    );
  const report = [
    "Patient Name: ResultIntegrity Patient",
    "DOB: 1990-01-01",
    "Document Type: Lab report",
    "Synthetic potassium: 9.0 mmol/L",
  ].join("\n");
  const received = call(
    "incoming-faxes",
    "POST",
    await prepareIncomingDocument({
      external_id: "integrity-1",
      sender: "Synthetic Lab",
      filename: "report.txt",
      format: "text",
      text: report,
    }),
  );
  const fax = state.operations.incoming_faxes.find(
    (f) => f.id === received.id,
  )!;
  const result = state.operations.note_results[0];
  const section = () => call(`note-results?encounter_id=${note.id}`);
  const review = (decision: "Include" | "Exclude") =>
    call(`note-results/${result.id}/review`, "POST", {
      revision: result.revision,
      decision,
      reason: "Provider reviewed this report for the encounter",
    });
  const sign = () =>
    validateNoteResultsForSignature(
      state,
      ctx,
      note,
      { received_results_version: section().version },
      note.billing_account_id,
    );
  const relink = () =>
    call("note-results", "POST", {
      encounter_id: note.id,
      document_id: fax.id,
    });
  const correct = (text: string) =>
    call(`incoming-faxes/${fax.id}/review-extraction`, "POST", {
      revision: fax.revision,
      reason: "Verified transcription against every original page",
      kind: "Lab report",
      text,
      identity_confirmed: true,
      values_confirmed: true,
    });
  return {
    state,
    ctx,
    note,
    fax,
    result,
    call,
    section,
    review,
    sign,
    relink,
    correct,
    report,
  };
}

test("corrected reports remain invalid after exclusion, relink into the intended draft, and require a fresh review", async () => {
  const f = await fixture();
  f.review("Include");
  f.ctx.encounters.push({ ...f.note, id: "enc-2" });
  f.correct(f.report.replace("9.0", "4.0"));
  assert.equal(f.result.status, "Source changed");
  assert.equal(f.result.source_invalidated, true);
  assert.equal(f.result.text, "");
  assert.deepEqual(
    f.section().candidates.map((c: any) => c.id),
    [f.fax.id],
  );
  f.review("Exclude");
  assert.equal(f.result.source_invalidated, true);
  assert.throws(() => f.review("Include"), rejected(409));
  assert.equal(f.result.status, "Excluded");
  assert.doesNotThrow(f.sign); // Deliberately omitting a changed report remains possible.
  const restored = readWorkflowState(JSON.stringify(f.state));
  assert.equal(restored.operations.note_results[0].source_invalidated, true);
  const oldRevision = f.result.revision;
  f.relink();
  assert.equal(f.result.revision, oldRevision + 1);
  assert.equal(f.result.status, "Pending review");
  assert.equal(f.result.source_invalidated, false);
  assert.equal(f.result.source_revision, f.fax.content_revision);
  assert.match(f.result.text, /4\.0 mmol\/L/);
  assert.equal(f.state.operations.note_results.length, 1);
  assert.equal(f.section().candidates.length, 0);
  assert.throws(f.sign, rejected(409));
  f.review("Include");
  assert.doesNotThrow(f.sign);
});

test("unchanged text after reviewed refiling still requires relinking; harmless clinical acknowledgments do not invalidate copies", async () => {
  const f = await fixture();
  f.review("Include");
  const before = f.result.source_revision;
  f.call(`incoming-faxes/${f.fax.id}/review`, "POST", {
    revision: f.fax.revision,
    reason: "Clinical follow-up and report reviewed",
  });
  assert.equal(f.fax.content_revision, before);
  assert.doesNotThrow(f.sign);
  f.call(`incoming-faxes/${f.fax.id}/file`, "POST", {
    revision: f.fax.revision,
    patient_id: f.note.patient_id,
    billing_account_id: f.note.billing_account_id,
    identity_confirmed: true,
    reason: "Reconfirmed patient and account against original identifiers",
  });
  assert.equal(f.result.source_invalidated, true);
  assert.notEqual(f.fax.content_revision, before);
  f.review("Exclude");
  assert.throws(() => f.review("Include"), rejected(409));
  f.relink();
  f.review("Include");
  assert.doesNotThrow(f.sign);
});

test("inclusion and signature independently reject stale text, digest, source revision, filing, account and unreadable sources", async () => {
  const changes = [
    {
      name: "text",
      mutate: (f: Awaited<ReturnType<typeof fixture>>) => {
        f.fax.extracted_text += "\nCorrected result";
      },
    },
    {
      name: "digest",
      mutate: (f: Awaited<ReturnType<typeof fixture>>) => {
        f.fax.digest = "other-original";
      },
    },
    {
      name: "revision",
      mutate: (f: Awaited<ReturnType<typeof fixture>>) => {
        f.fax.content_revision!++;
      },
    },
    {
      name: "patient",
      mutate: (f: Awaited<ReturnType<typeof fixture>>) => {
        f.fax.patient_id = "pat-2";
      },
    },
    {
      name: "account",
      mutate: (f: Awaited<ReturnType<typeof fixture>>) => {
        f.fax.billing_account_id = "another-claim";
      },
    },
    {
      name: "classification",
      mutate: (f: Awaited<ReturnType<typeof fixture>>) => {
        f.fax.kind = "Other";
      },
    },
    {
      name: "empty copy",
      mutate: (f: Awaited<ReturnType<typeof fixture>>) => {
        f.result.text = "";
      },
    },
    {
      name: "unreadable",
      mutate: (f: Awaited<ReturnType<typeof fixture>>) => {
        f.fax.extraction_issue = "Original must be reviewed";
      },
    },
  ];
  for (const change of changes) {
    const f = await fixture();
    f.review("Include");
    change.mutate(f);
    assert.throws(f.sign, rejected(409), `${change.name}: signature`);
    f.review("Exclude");
    assert.throws(
      () => f.review("Include"),
      rejected(409),
      `${change.name}: include`,
    );
  }
});

test("valid legacy copies remain usable while signed copies stay immutable when their source changes", async () => {
  const f = await fixture();
  delete f.result.source_revision;
  delete f.result.source_invalidated;
  delete f.fax.content_revision;
  f.review("Include");
  assert.doesNotThrow(f.sign);
  const legacy = structuredClone(f.result);
  f.note.status = "Signed";
  Object.assign(f.note, { signed_at: f.ctx.now });
  f.correct(f.report.replace("9.0", "4.0"));
  assert.deepEqual(f.result, legacy);
  assert.equal(f.state.note_addenda.corrections.length, 1);
});

test("HTTP correction/exclusion cannot bypass review; relinking and signing persist the verified corrected report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cevrali-result-integrity-"));
  const db = createDatabase(join(directory, "demo.sqlite"));
  const platform = createPlatformApp(db, join(directory, "accounts"));
  const server = platform.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let clinician = "";
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    cookie = clinician,
  ) {
    const response = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
    };
  }
  const op = "/workflow/operations";
  try {
    clinician = (
      await call("/auth/login", "POST", {
        email: "alex@cevrali.demo",
        password: "CevraliDemo2026!",
      })
    ).cookie;
    const front = (
      await call(
        "/auth/login",
        "POST",
        {
          email: "frontdesk@cevrali.demo",
          password: "CevraliDemo2026!",
        },
        "",
      )
    ).cookie;
    const other = (
      await call(
        "/auth/login",
        "POST",
        {
          email: "nina@cevrali.demo",
          password: "CevraliDemo2026!",
        },
        "",
      )
    ).cookie;
    const patient = await call("/patients", "POST", {
      first_name: "HttpIntegrity",
      last_name: "Patient",
      dob: "1991-05-06",
      sex: "Unknown",
      phone: "555-0123",
    });
    assert.equal(patient.status, 201);
    const created = await call("/encounters", "POST", {
      patient_id: patient.data.id,
      chief_complaint: "Synthetic corrected report review",
    });
    assert.equal(created.status, 201);
    const encounterId = created.data.id;
    const original = `Patient Name: HttpIntegrity Patient\nDOB: 1991-05-06\nDocument Type: Lab report\nSynthetic potassium: 9.0 mmol/L`;
    const corrected = original.replace("9.0", "4.0");
    const receipt = await call(
      `${op}/incoming-faxes`,
      "POST",
      {
        external_id: "HTTP-INTEGRITY",
        sender: "Synthetic Lab",
        filename: "result.txt",
        format: "text",
        text: original,
      },
      front,
    );
    assert.equal(receipt.status, 200);
    assert.equal(receipt.data.status, "Filed");
    const section = async () =>
      (await call(`${op}/note-results?encounter_id=${encounterId}`)).data;
    let current = await section();
    const rowId = current.results[0].id;
    const review = (decision: "Include" | "Exclude", row: NoteResult) =>
      call(`${op}/note-results/${rowId}/review`, "POST", {
        revision: row.revision,
        decision,
        reason: "Provider compared report with original",
      });
    assert.equal((await review("Include", current.results[0])).status, 200);
    assert.equal(
      (
        await call("/encounters", "POST", {
          patient_id: patient.data.id,
          chief_complaint: "Second open draft",
        })
      ).status,
      201,
    );
    const extraction = await call(
      `${op}/incoming-faxes/${receipt.data.id}/review-extraction`,
      "POST",
      {
        revision: receipt.data.revision,
        kind: "Lab report",
        text: corrected,
        identity_confirmed: true,
        values_confirmed: true,
        reason: "Compared original decimal value, units, and patient identity",
      },
    );
    assert.equal(extraction.status, 200, JSON.stringify(extraction.data));
    current = await section();
    assert.equal(current.results[0].source_invalidated, true);
    assert.equal(current.candidates[0].id, receipt.data.id);
    assert.equal((await review("Exclude", current.results[0])).status, 200);
    current = await section();
    assert.equal((await review("Include", current.results[0])).status, 409);
    assert.equal(
      loadWorkflow(db).operations.note_results.find((r) => r.id === rowId)
        ?.source_invalidated,
      true,
    );
    const link = { encounter_id: encounterId, document_id: receipt.data.id };
    assert.equal(
      (await call(`${op}/note-results`, "POST", link, front)).status,
      403,
    );
    assert.equal(
      (await call(`${op}/note-results`, "POST", link, other)).status,
      403,
    );
    const relinked = await call(`${op}/note-results`, "POST", link);
    assert.equal(relinked.status, 200);
    assert.equal(relinked.data.id, rowId);
    assert.equal(relinked.data.text, corrected);
    assert.equal(relinked.data.status, "Pending review");
    const note = (await call("/encounters")).data.find(
      (n: any) => n.id === encounterId,
    );
    const signing = async () =>
      call(`/encounters/${encounterId}`, "PATCH", {
        ...note,
        assessment: "Independent clinician assessment",
        plan: "Independent follow-up plan",
        status: "Signed",
        received_results_version: (await section()).version,
      });
    assert.equal((await signing()).status, 409);
    assert.equal((await review("Include", relinked.data)).status, 200);
    assert.equal((await signing()).status, 200);
    const signed = (await call("/encounters")).data.find(
      (n: any) => n.id === encounterId,
    );
    assert.equal(signed.received_results[0].text, corrected);
    assert.equal(signed.received_results[0].source_invalidated, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    platform.store.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
