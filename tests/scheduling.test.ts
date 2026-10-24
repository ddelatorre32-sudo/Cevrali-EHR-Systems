import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createDatabase, clinicDate } from "../server/database.js";
import { createPlatformApp } from "../server/platform.js";
import { loadWorkflow, saveWorkflow } from "../server/workflows.js";
import {
  addCalendarDays,
  calendarRange,
  calendarDates,
  moveCalendarDate,
  readAppointmentRange,
} from "../server/scheduling.js";
import {
  calendarHours,
  filterCalendarAppointments,
  positionCalendarAppointments,
} from "../src/calendar-layout.js";
import type { Appointment } from "../src/types.js";
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cevrali-calendar-")),
    db = createDatabase(join(dir, "demo.sqlite")),
    platform = createPlatformApp(db, join(dir, "accounts")),
    server = platform.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let cookie = "";
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
  return {
    call,
    cleanup: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      platform.store.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("calendar range reads include both boundaries and preserve day queries, sorting and the visit billing account", async () => {
  const f = await fixture();
  try {
    const created = [];
    for (const [date, time] of [
      ["2030-03-13", "10:00"],
      ["2030-03-11", "11:00"],
      ["2030-03-11", "09:00"],
      ["2030-03-14", "09:00"],
    ]) {
      const r = await f.call("/appointments", "POST", {
        patient_id: "pat-001",
        billing_account_id: "pba-private-pat-001",
        date,
        time,
        duration: 30,
        type: "Follow-up",
        reason: "Calendar integration fixture",
      });
      assert.equal(r.status, 201);
      created.push(r.data.id);
    }
    const ranged = await f.call(
      "/appointments?start=2030-03-11&end=2030-03-13",
    );
    assert.equal(ranged.status, 200);
    assert.deepEqual(
      ranged.data.map((a: any) => `${a.date} ${a.time}`),
      ["2030-03-11 09:00", "2030-03-11 11:00", "2030-03-13 10:00"],
    );
    assert.ok(
      ranged.data.every(
        (a: any) =>
          a.billing_account_id === "pba-private-pat-001" &&
          a.provider_id &&
          a.billing_account_name,
      ),
    );
    assert.equal(
      (await f.call("/appointments?date=2030-03-14")).data[0].id,
      created[3],
    );
  } finally {
    await f.cleanup();
  }
});
test("calendar reads reject incomplete, reversed, invalid or excessive ranges rather than loading unbounded records", async () => {
  const f = await fixture();
  try {
    for (const query of [
      "start=2030-03-01",
      "end=2030-03-01",
      "start=2030-03-13&end=2030-03-11",
      "start=2030-02-30&end=2030-03-01",
      "start=2030-01-01&end=2030-02-12",
      "start=2030-03-01&end=2030-03-03&date=2030-03-01",
      "start=2030-03-01&start=2030-03-02&end=2030-03-03",
    ])
      assert.equal((await f.call("/appointments?" + query)).status, 400, query);
    assert.equal(
      (await f.call("/appointments?start=2030-01-01&end=2030-02-11")).status,
      200,
    );
  } finally {
    await f.cleanup();
  }
});
test("calendar ranges retain authentication, front-desk scheduling access and practice isolation", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.call(
          "/appointments?start=2030-03-11&end=2030-03-17",
          "GET",
          undefined,
          "",
        )
      ).status,
      401,
    );
    const r = await f.call("/appointments", "POST", {
      patient_id: "pat-001",
      date: "2030-03-11",
      time: "09:00",
      type: "Follow-up",
      reason: "Calendar tenant isolation",
    });
    assert.equal(r.status, 201);
    const front = (
      await f.call(
        "/auth/login",
        "POST",
        { email: "frontdesk@cevrali.demo", password: "CevraliDemo2026!" },
        "",
      )
    ).cookie;
    assert.equal(
      (
        await f.call(
          "/appointments?start=2030-03-11&end=2030-03-17",
          "GET",
          undefined,
          front,
        )
      ).data[0].id,
      r.data.id,
    );
    const practice = await f.call("/accounts/signup", "POST", {
      owner_name: "Calendar Owner",
      email: "calendar-isolation@example.test",
      password: "SyntheticCalendar2026!",
      clinical_access: true,
      practice: {
        name: "Calendar Practice",
        phone: "555-0100",
        address: "Synthetic location",
      },
    });
    assert.equal(practice.status, 201);
    assert.deepEqual(
      (
        await f.call(
          "/appointments?start=2030-03-11&end=2030-03-17",
          "GET",
          undefined,
          practice.cookie,
        )
      ).data,
      [],
    );
  } finally {
    await f.cleanup();
  }
});

test("bounded calendar reads retain no-shows and a missed appointment does not block a replacement clinician slot", async () => {
  const f = await fixture();
  const date = addCalendarDays(clinicDate(), -1);
  try {
    const missed = await f.call("/appointments", "POST", {
      patient_id: "pat-001",
      billing_account_id: "pba-private-pat-001",
      provider_id: "usr-colleague",
      date,
      time: "09:00",
      duration: 30,
      type: "Follow-up",
      reason: "Calendar no-show history fixture",
    });
    assert.equal(missed.status, 201, JSON.stringify(missed.data));
    const marked = await f.call(`/workflow/visits/${missed.data.id}`, "PATCH", {
      stage: "No-show",
    });
    assert.equal(marked.status, 200, JSON.stringify(marked.data));
    const firstRead = await f.call(`/appointments?start=${date}&end=${date}`);
    assert.equal(firstRead.status, 200);
    assert.equal(
      firstRead.data.find((a: any) => a.id === missed.data.id)?.status,
      "No-show",
    );
    const replacement = await f.call("/appointments", "POST", {
      patient_id: "pat-001",
      billing_account_id: "pba-private-pat-001",
      provider_id: "usr-colleague",
      date,
      time: "09:00",
      duration: 30,
      type: "Follow-up",
      reason: "Replacement visit retains the missed appointment history",
    });
    assert.equal(replacement.status, 201, JSON.stringify(replacement.data));
    const ranged = await f.call(`/appointments?start=${date}&end=${date}`);
    assert.equal(ranged.status, 200);
    assert.deepEqual(ranged.data.map((a: any) => a.status).sort(), [
      "No-show",
      "Scheduled",
    ]);
    assert.equal(
      ranged.data.find((a: any) => a.id === missed.data.id).billing_account_id,
      "pba-private-pat-001",
    );
    const scheduling = await f.call("/workflow/scheduling");
    assert.ok(
      !scheduling.data.slots.some((s: any) => s.id === missed.data.id),
      "A missed appointment is historical and must not become a cancellation offer",
    );
  } finally {
    await f.cleanup();
  }
});

test("legacy appointment CHECK migration preserves linked charts, extra columns, indexes, account data and audit while normalizing stored no-shows", () => {
  const directory = mkdtempSync(join(tmpdir(), "cevrali-legacy-no-show-"));
  const filename = join(directory, "legacy.sqlite");
  let db = createDatabase(filename);
  let open = true;
  try {
    db.exec(
      "ALTER TABLE appointments ADD COLUMN external_ref TEXT NOT NULL DEFAULT ''",
    );
    db.exec(
      "CREATE INDEX legacy_appointment_provider_date ON appointments(provider_id,date)",
    );
    db.prepare(
      "UPDATE appointments SET billing_account_id=?, external_ref=? WHERE id=?",
    ).run("legacy-private-account", "LEGACY-EXTERNAL-REFERENCE", "apt-001");
    const snapshot = JSON.stringify({
      id: "legacy-private-account",
      name: "Legacy private insurance",
    });
    const documentation = JSON.stringify({
      injury_history: "Legacy narrative preserved verbatim",
    });
    db.prepare(
      "UPDATE encounters SET billing_account_id=?,billing_account_snapshot=?,wc_documentation=? WHERE id=?",
    ).run("legacy-private-account", snapshot, documentation, "enc-001");
    const sentinelAudit = db
      .prepare("INSERT INTO audit(user_id,action,resource) VALUES(?,?,?)")
      .run(
        "usr-clinician",
        "Legacy migration preservation sentinel",
        "apt-001",
      ).lastInsertRowid;
    const state = loadWorkflow(db);
    state.preferences["usr-colleague"] = {
      favorites: ["pat-003"],
      recent: ["pat-001"],
      filters: [{ name: "Legacy patients", query: "Synthetic legacy query" }],
    };
    state.finance.billing_accounts.push({
      id: "legacy-private-account",
      patient_id: "pat-001",
      name: "Legacy private insurance",
      kind: "Private insurance",
      status: "Active",
      workers_comp: null,
      revision: 4,
      created_at: "2020-01-01T00:00:00.000Z",
      updated_at: "2021-01-01T00:00:00.000Z",
    });
    state.visits["apt-007"] = {
      stage: "No-show",
      room: "",
      entered_at: "2026-01-01T12:34:56.000Z",
    };
    saveWorkflow(db, state);

    const patients = db.prepare("SELECT * FROM patients ORDER BY id").all();
    const encounters = db.prepare("SELECT * FROM encounters ORDER BY id").all();
    const appointments = db
      .prepare("SELECT * FROM appointments ORDER BY id")
      .all() as Record<string, unknown>[];
    const originalAudit = db
      .prepare("SELECT * FROM audit WHERE id=?")
      .get(sentinelAudit);
    const indexes = db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='appointments' AND sql IS NOT NULL ORDER BY name",
      )
      .all() as { name: string; sql: string }[];
    const columns = (
      db.prepare("PRAGMA table_info(appointments)").all() as { name: string }[]
    )
      .map((c) => `"${c.name.replaceAll('"', '""')}"`)
      .join(",");
    const table = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='appointments'",
      )
      .get() as { sql: string };
    const legacySql = table.sql
      .replace(/,\s*'No-show'/g, "")
      .replace(/'No-show'\s*,/g, "")
      .replace(
        /^CREATE TABLE\s+(?:"appointments"|appointments)/i,
        "CREATE TABLE appointments_legacy",
      );
    assert.doesNotMatch(legacySql, /'No-show'/);
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(legacySql);
      db.exec(
        `INSERT INTO appointments_legacy(${columns}) SELECT ${columns} FROM appointments`,
      );
      db.exec("DROP TABLE appointments");
      db.exec("ALTER TABLE appointments_legacy RENAME TO appointments");
      for (const index of indexes) db.exec(index.sql);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    db.exec("PRAGMA foreign_keys=ON");
    // Existing integrations may own appointment triggers or reference this table
    // from other tables and views. The rebuild must preserve all of them.
    db.exec(`
      CREATE TABLE legacy_migration_probe(kind TEXT,appointment_id TEXT,status TEXT);
      CREATE TABLE legacy_migration_sender(id TEXT);
      CREATE TRIGGER legacy_appointment_status_history AFTER UPDATE OF status ON appointments
        BEGIN
          INSERT INTO legacy_migration_probe VALUES ('appointment',NEW.id,NEW.status);
        END;
      CREATE VIEW legacy_appointment_view AS SELECT id,status,external_ref FROM appointments;
      CREATE TRIGGER legacy_sender_appointment_lookup AFTER INSERT ON legacy_migration_sender
        BEGIN
          INSERT INTO legacy_migration_probe
            SELECT 'dependent',NEW.id,CAST(COUNT(*) AS TEXT) FROM appointments;
        END;
    `);
    const dependentSchema = db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN ('legacy_appointment_status_history','legacy_appointment_view','legacy_sender_appointment_lookup') ORDER BY name",
      )
      .all();
    assert.equal(
      (
        db
          .prepare("SELECT status FROM appointments WHERE id=?")
          .get("apt-007") as any
      ).status,
      "Scheduled",
    );
    db.close();
    open = false;

    db = createDatabase(filename);
    open = true;
    const expectedAppointments = appointments.map((a) =>
      a.id === "apt-007"
        ? Object.assign(Object.create(Object.getPrototypeOf(a)), a, {
            status: "No-show",
          })
        : a,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM patients ORDER BY id").all(),
      patients,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM encounters ORDER BY id").all(),
      encounters,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM appointments ORDER BY id").all(),
      expectedAppointments,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM audit WHERE id=?").get(sentinelAudit),
      originalAudit,
    );
    assert.equal(
      (db.prepare("PRAGMA foreign_keys").get() as any).foreign_keys,
      1,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(
      (db.prepare("PRAGMA legacy_alter_table").get() as any).legacy_alter_table,
      0,
      "The migration must restore normal SQLite schema validation",
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN ('legacy_appointment_status_history','legacy_appointment_view','legacy_sender_appointment_lookup') ORDER BY name",
        )
        .all(),
      dependentSchema,
    );
    assert.deepEqual(
      db
        .prepare("SELECT * FROM legacy_appointment_view ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      expectedAppointments.map((a) => ({
        id: a.id,
        status: a.status,
        external_ref: a.external_ref,
      })),
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT appointment_id,status FROM legacy_migration_probe WHERE kind='appointment'",
        )
        .all()
        .map((row) => ({ ...row })),
      [{ appointment_id: "apt-007", status: "No-show" }],
      "The retained appointment trigger must run when legacy status is normalized",
    );
    db.prepare("INSERT INTO legacy_migration_sender VALUES (?)").run(
      "preserved-integration",
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT appointment_id,status FROM legacy_migration_probe WHERE kind='dependent'",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          appointment_id: "preserved-integration",
          status: String(appointments.length),
        },
      ],
      "Triggers on other tables must still be able to query appointments",
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='appointments' AND sql IS NOT NULL ORDER BY name",
        )
        .all(),
      indexes,
    );
    const reloaded = loadWorkflow(db);
    assert.deepEqual(
      reloaded.preferences["usr-colleague"],
      state.preferences["usr-colleague"],
    );
    assert.deepEqual(
      reloaded.finance.billing_accounts,
      state.finance.billing_accounts,
    );
    assert.equal(reloaded.visits["apt-007"].stage, "No-show");
    assert.equal(
      reloaded.visits["apt-007"].entered_at,
      "2026-01-01T12:34:56.000Z",
    );
    assert.throws(
      () => db.prepare("DELETE FROM patients WHERE id=?").run("pat-001"),
      /FOREIGN KEY/,
    );
    db.prepare("UPDATE appointments SET status=? WHERE id=?").run(
      "No-show",
      "apt-008",
    );
    db.close();
    open = false;
    db = createDatabase(filename);
    open = true;
    assert.equal(
      (
        db
          .prepare("SELECT status FROM appointments WHERE id=?")
          .get("apt-007") as any
      ).status,
      "No-show",
    );
    assert.equal(
      (
        db
          .prepare("SELECT status FROM appointments WHERE id=?")
          .get("apt-008") as any
      ).status,
      "No-show",
    );
    assert.equal(
      (
        db
          .prepare("SELECT external_ref FROM appointments WHERE id=?")
          .get("apt-001") as any
      ).external_ref,
      "LEGACY-EXTERNAL-REFERENCE",
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    if (open) db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("calendar navigation keeps clinic date keys across daylight-saving, year changes and short months", () => {
  assert.equal(addCalendarDays("2026-03-07", 2), "2026-03-09");
  assert.equal(addCalendarDays("2026-10-31", 2), "2026-11-02");
  assert.deepEqual(calendarRange("week", "2027-01-01"), {
    start: "2026-12-28",
    end: "2027-01-03",
  });
  assert.equal(moveCalendarDate("month", "2028-01-31", 1), "2028-02-29");
  assert.equal(moveCalendarDate("month", "2026-03-31", -1), "2026-02-28");
  const grid = calendarRange("month", "2026-11-01");
  assert.equal(grid.start, "2026-10-26");
  assert.equal(calendarDates(grid.start, 42).at(-1), grid.end);
  assert.deepEqual(readAppointmentRange({ date: "2026-11-01" }, "2026-10-20"), {
    start: "2026-11-01",
    end: "2026-11-01",
  });
});
const visit = (id: string, time: string, duration: number) =>
  ({ id, time, duration }) as Appointment;
test("overlapping provider visits receive separate lanes while adjacent independent visits keep their full width", () => {
  const positioned = positionCalendarAppointments([
    visit("a", "09:00", 60),
    visit("b", "09:15", 30),
    visit("c", "09:45", 30),
    visit("d", "10:15", 15),
  ]);
  assert.equal(positioned.length, 4);
  assert.deepEqual(
    positioned.map((x) => [x.appointment.id, x.lane, x.lanes]),
    [
      ["a", 0, 2],
      ["b", 1, 2],
      ["c", 1, 2],
      ["d", 0, 1],
    ],
  );
  const same = positionCalendarAppointments([
    visit("a", "09:00", 30),
    visit("b", "09:00", 30),
    visit("c", "09:00", 15),
  ]);
  assert.equal(new Set(same.map((x) => x.lane)).size, 3);
  assert.ok(same.every((x) => x.lanes === 3));
});
test("calendar hours expand to retain early and late appointments including midnight end times", () => {
  assert.deepEqual(calendarHours([]), { start: 7, end: 19 });
  assert.deepEqual(
    calendarHours([visit("early", "02:15", 30), visit("late", "23:30", 30)]),
    { start: 2, end: 24 },
  );
});

test("calendar status filters preserve no-show history while excluding it from upcoming work and honoring the selected clinician", () => {
  const rows = [
    { id: "scheduled", status: "Scheduled", provider_id: "usr-clinician" },
    { id: "checked-in", status: "Checked in", provider_id: "usr-clinician" },
    { id: "started", status: "In progress", provider_id: "usr-clinician" },
    { id: "completed", status: "Completed", provider_id: "usr-clinician" },
    { id: "cancelled", status: "Cancelled", provider_id: "usr-clinician" },
    { id: "missed", status: "No-show", provider_id: "usr-clinician" },
    { id: "colleague-missed", status: "No-show", provider_id: "usr-colleague" },
    {
      id: "colleague-scheduled",
      status: "Scheduled",
      provider_id: "usr-colleague",
    },
  ] as Appointment[];
  const original = structuredClone(rows);
  const ids = (
    provider: string,
    filter: "All appointments" | "Upcoming" | "Completed" | "No-shows",
  ) => filterCalendarAppointments(rows, provider, filter).map((a) => a.id);
  assert.deepEqual(
    ids("all", "All appointments"),
    rows.map((a) => a.id),
  );
  assert.deepEqual(ids("usr-clinician", "Upcoming"), [
    "scheduled",
    "checked-in",
    "started",
  ]);
  assert.deepEqual(ids("usr-clinician", "Completed"), ["completed"]);
  assert.deepEqual(ids("usr-clinician", "No-shows"), ["missed"]);
  assert.deepEqual(ids("usr-colleague", "No-shows"), ["colleague-missed"]);
  assert.deepEqual(ids("all", "No-shows"), ["missed", "colleague-missed"]);
  assert.deepEqual(rows, original);
});
