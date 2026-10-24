import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { createDatabase } from "../server/database.js";
import { createApp } from "../server/app.js";
import { loadWorkflow } from "../server/workflows.js";
import {
  patientAddressFields,
  formatPatientAddress,
  US_STATES,
} from "../server/patient-demographics.js";

async function fixture(filename = ":memory:") {
  const db = createDatabase(filename);
  const server = createApp(db).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let cookie = "";
  const call = async (path: string, method = "GET", body?: unknown, auth = cookie) => {
    const response = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: auth },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json(), response };
  };
  const login = async (email: string) => {
    const result = await call("/auth/login", "POST", {
      email, password: "CevraliDemo2026!",
    }, "");
    assert.equal(result.status, 200);
    return result.response.headers.get("set-cookie")!.split(";")[0];
  };
  cookie = await login("alex@cevrali.demo");
  return {
    db, call, login,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
      db.close();
    },
  };
}

const patient = {
  first_name: "Structured", last_name: "Demographics", dob: "1991-02-03",
  sex: "Unknown", phone: "555-0124",
  address: " 150 Synthetic Street ", address_unit: " Apt 4B ",
  city: " Boston ", state: " ma ", zip_code: " 02108-1234 ",
  allergies: ["Penicillin", "Synthetic custom allergen"],
};
const expected = {
  address: "150 Synthetic Street", address_unit: "Apt 4B", city: "Boston",
  state: "MA", zip_code: "02108-1234",
};

test("patient registration saves each address component and clinical/custom allergies without exposing them in the demographic directory", async () => {
  const f = await fixture();
  try {
    const created = await f.call("/patients", "POST", patient);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const chart = await f.call(`/patients/${created.data.id}`);
    assert.equal(chart.status, 200);
    for (const [key, value] of Object.entries(expected)) assert.equal(chart.data[key], value);
    assert.deepEqual(chart.data.allergies, patient.allergies);
    assert.equal(formatPatientAddress(chart.data),
      "150 Synthetic Street, Apt 4B, Boston, MA 02108-1234");
    const front = await f.login("frontdesk@cevrali.demo");
    const directory = await f.call("/patients?q=Structured", "GET", undefined, front);
    assert.equal(directory.status, 200);
    assert.equal(directory.data.length, 1);
    for (const [key, value] of Object.entries(expected)) assert.equal(directory.data[0][key], value);
    assert.equal(directory.data[0].allergies, undefined);
    assert.equal((await f.call(`/patients/${created.data.id}`, "GET", undefined, front)).status, 403);
  } finally { await f.close(); }
});

test("invalid state, ZIP, and overlong address components fail before patient or insurance writes", async () => {
  const f = await fixture();
  try {
    const beforePatients = f.db.prepare("SELECT * FROM patients ORDER BY id").all();
    const beforeFinance = loadWorkflow(f.db).finance;
    for (const invalid of [
      { state: "California" }, { state: "ZZ" }, { zip_code: "1234" },
      { zip_code: "123456789" }, { zip_code: "AB123" },
      { address_unit: "x".repeat(101) }, { city: "x".repeat(101) },
    ]) {
      const result = await f.call("/patients", "POST", {
        ...patient, ...invalid,
        insurance: { policy: { payer: "This must never be written" } },
      });
      assert.equal(result.status, 400, JSON.stringify(result.data));
      assert.deepEqual(f.db.prepare("SELECT * FROM patients ORDER BY id").all(), beforePatients);
      assert.deepEqual(loadWorkflow(f.db).finance, beforeFinance);
    }
    const front = await f.login("frontdesk@cevrali.demo");
    assert.equal((await f.call("/patients", "POST", patient, front)).status, 403,
      "registration retains clinical allergy permission checks");
    assert.deepEqual(f.db.prepare("SELECT * FROM patients ORDER BY id").all(), beforePatients);
  } finally { await f.close(); }
});

test("separate patient address fields and recorded allergies survive a database restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cevrali-patient-address-"));
  const filename = join(directory, "practice.sqlite");
  let first: Awaited<ReturnType<typeof fixture>> | undefined;
  let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    first = await fixture(filename);
    const created = await first.call("/patients", "POST", patient);
    assert.equal(created.status, 201);
    await first.close(); first = undefined;
    reopened = await fixture(filename);
    const chart = await reopened.call(`/patients/${created.data.id}`);
    assert.equal(chart.status, 200);
    for (const [key, value] of Object.entries(expected)) assert.equal(chart.data[key], value);
    assert.deepEqual(chart.data.allergies, patient.allergies);
  } finally {
    await first?.close(); await reopened?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("additive address migration preserves legacy free-form addresses, allergies, indexes, triggers, and views", () => {
  const directory = mkdtempSync(join(tmpdir(), "cevrali-legacy-address-"));
  const filename = join(directory, "legacy.sqlite");
  let db = new DatabaseSync(filename);
  try {
    db.exec(`
      CREATE TABLE patients (
        id TEXT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
        dob TEXT NOT NULL, sex TEXT NOT NULL, phone TEXT NOT NULL,
        email TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
        allergies TEXT NOT NULL DEFAULT '[]', conditions TEXT NOT NULL DEFAULT '[]',
        medications TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX legacy_patient_name ON patients(last_name);
      CREATE VIEW legacy_addresses AS SELECT id,address FROM patients;
      CREATE TABLE legacy_updates(patient_id TEXT);
      CREATE TRIGGER legacy_patient_update AFTER UPDATE ON patients BEGIN
        INSERT INTO legacy_updates(patient_id) VALUES (NEW.id);
      END;
      INSERT INTO patients(id,first_name,last_name,dob,sex,phone,address,allergies)
        VALUES ('legacy-patient','Legacy','Patient','1990-01-01','Unknown','555-0100',
          '24 Legacy Lane, Unit 8, Austin TX 78701','["Latex"]');
    `);
    const legacy = db.prepare("SELECT * FROM patients").get();
    db.close();
    db = createDatabase(filename, { seedDemo: false });
    const migrated = db.prepare("SELECT * FROM patients").get()!;
    for (const [key, value] of Object.entries(legacy!)) assert.equal(migrated[key], value);
    for (const key of ["address_unit", "city", "state", "zip_code"]) assert.equal(migrated[key], "");
    assert.equal(formatPatientAddress(migrated), legacy!.address);
    assert.equal(db.prepare("SELECT address FROM legacy_addresses").get()!.address, legacy!.address);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM legacy_updates").get()!.count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE name IN ('legacy_patient_name','legacy_patient_update','legacy_addresses')").get()!.count, 3);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.close();
    db = createDatabase(filename, { seedDemo: false });
    assert.equal(db.prepare("PRAGMA table_info(patients)").all()
      .filter((column) => column.name === "city").length, 1);
    assert.equal(db.prepare("SELECT address FROM patients").get()!.address, legacy!.address);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("shared native/preview address validation keeps optional legacy addresses and leading-zero ZIPs", () => {
  assert.deepEqual(patientAddressFields.parse({}), {
    address: "", address_unit: "", city: "", state: "", zip_code: "",
  });
  assert.equal(patientAddressFields.parse({ zip_code: "02108" }).zip_code, "02108");
  assert.equal(patientAddressFields.parse({ state: "ap" }).state, "AP");
  assert.equal(patientAddressFields.parse({ state: "pr" }).state, "PR");
  assert.equal(US_STATES.find((state) => state.code === "CA")!.name, "California");
  assert.equal(formatPatientAddress({ address: "San Francisco, CA" }), "San Francisco, CA");
  assert.equal(formatPatientAddress({ city: "Boston", state: "MA", zip_code: "02108" }), "Boston, MA 02108");
  assert.equal(formatPatientAddress({}), "");
});
