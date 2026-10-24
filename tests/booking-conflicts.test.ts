import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createDatabase } from "../server/database.js";
import { createPlatformApp } from "../server/platform.js";

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cevrali-booking-conflicts-"));
  const db = createDatabase(join(directory, "demo.sqlite"));
  const platform = createPlatformApp(db, join(directory, "accounts"));
  const server = platform.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let cookie = "";
  async function call(path: string, method = "GET", body?: unknown) {
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
  cookie = (
    await call("/auth/login", "POST", {
      email: "alex@cevrali.demo",
      password: "CevraliDemo2026!",
    })
  ).cookie;
  const book = (overrides: Record<string, unknown> = {}) =>
    call("/appointments", "POST", {
      patient_id: "pat-001",
      billing_account_id: "pba-private-pat-001",
      provider_id: "usr-clinician",
      date: "2034-10-05",
      time: "10:00",
      duration: 30,
      type: "Follow-up",
      reason: "Synthetic booking conflict regression",
      ...overrides,
    });
  const snapshot = () => ({
    appointments: db.prepare("SELECT * FROM appointments ORDER BY id").all(),
    workflow: db
      .prepare("SELECT document FROM workflow_state WHERE id=1")
      .get(),
    audit: db.prepare("SELECT * FROM audit ORDER BY id").all(),
  });
  return {
    book,
    call,
    snapshot,
    rows: () =>
      db
        .prepare(
          "SELECT * FROM appointments WHERE date='2034-10-05' ORDER BY time,id",
        )
        .all(),
    cleanup: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      platform.store.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("ordinary bookings reject patient overlap across providers without changing appointments, plans or audit", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.book()).status, 201);
    const before = f.snapshot();
    const patientConflict = await f.book({
      provider_id: "usr-colleague",
      time: "10:15",
    });
    assert.equal(
      patientConflict.status,
      409,
      JSON.stringify(patientConflict.data),
    );
    assert.match(patientConflict.data.error, /overlaps another appointment/i);
    assert.deepEqual(f.snapshot(), before);

    const independent = await f.book({
      patient_id: "pat-002",
      billing_account_id: "pba-private-pat-002",
      provider_id: "usr-colleague",
      time: "10:15",
    });
    assert.equal(independent.status, 201, JSON.stringify(independent.data));
    const afterIndependent = f.snapshot();
    const providerConflict = await f.book({
      patient_id: "pat-003",
      billing_account_id: "pba-private-pat-003",
      time: "10:15",
    });
    assert.equal(
      providerConflict.status,
      409,
      JSON.stringify(providerConflict.data),
    );
    assert.deepEqual(f.snapshot(), afterIndependent);
    assert.equal(f.rows().length, 2);
  } finally {
    await f.cleanup();
  }
});

test("adjacent visits and exact midnight endings are permitted, overruns fail, and cancelled slots can be reused", async () => {
  const f = await fixture();
  try {
    const original = await f.book();
    assert.equal(original.status, 201);
    assert.equal((await f.book({ time: "10:30" })).status, 201);
    assert.equal((await f.book({ time: "23:45", duration: 15 })).status, 201);
    const beforeOverrun = f.snapshot();
    assert.equal((await f.book({ time: "23:46", duration: 15 })).status, 400);
    assert.deepEqual(f.snapshot(), beforeOverrun);

    assert.equal(
      (
        await f.call("/appointments/" + original.data.id, "PATCH", {
          status: "Cancelled",
        })
      ).status,
      200,
    );
    const replacement = await f.book({ provider_id: "usr-colleague" });
    assert.equal(replacement.status, 201, JSON.stringify(replacement.data));
    assert.equal(f.rows().length, 4);
  } finally {
    await f.cleanup();
  }
});

test("competing ordinary bookings for one patient reserve only one overlapping slot across providers", async () => {
  const f = await fixture();
  try {
    const before = f.snapshot();
    const results = await Promise.all([
      f.book({ provider_id: "usr-clinician" }),
      f.book({ provider_id: "usr-colleague" }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    const rows = f.rows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].patient_id, "pat-001");
    const after = f.snapshot();
    assert.equal(after.appointments.length, before.appointments.length + 1);
    assert.equal(after.audit.length, before.audit.length + 1);
    assert.equal(after.audit.at(-1)?.action, "Scheduled appointment");
  } finally {
    await f.cleanup();
  }
});
