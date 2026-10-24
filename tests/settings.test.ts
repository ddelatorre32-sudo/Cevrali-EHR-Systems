import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDatabase } from "../server/database.js";
import { createPlatformApp } from "../server/platform.js";
import { defaultWorkspaceSettings } from "../server/settings-model.js";
import { emptyWorkflowState, readWorkflowState } from "../server/workflow-engine.js";

const directory = mkdtempSync(join(tmpdir(), "cevrali-settings-"));
const databasePath = join(directory, "demo.sqlite");
const accountsPath = join(directory, "accounts");
const password = "SyntheticSettings2026!";
let db = createDatabase(databasePath);
let platform = createPlatformApp(db, accountsPath);
let server: Server;
let base: string;
let ownerCookie: string;
let staffCookie: string;
let otherCookie: string;
let staffId: string;

async function listen() {
  server = platform.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

async function stop() {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function call(
  path: string,
  method = "GET",
  body?: unknown,
  cookie = ownerCookie,
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie || "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
  };
}

before(async () => {
  await listen();
  const signup = (email: string, name: string) =>
    call("/accounts/signup", "POST", {
      owner_name: "Synthetic Settings Owner",
      email,
      password,
      clinical_access: false,
      practice: { name },
    }, "");
  const owner = await signup("settings-owner@example.test", "Settings Practice");
  assert.equal(owner.status, 201);
  assert.equal(owner.data.role, "receptionist");
  ownerCookie = owner.cookie;
  const other = await signup("other-settings@example.test", "Other Practice");
  assert.equal(other.status, 201);
  otherCookie = other.cookie;
  const invite = await call("/account/invitations", "POST", {
    email: "settings-clinician@example.test",
    role: "clinician",
    is_admin: false,
  });
  assert.equal(invite.status, 200);
  const joined = await call(`/accounts/invitations/${invite.data.token}/accept`, "POST", {
    name: "Synthetic Settings Clinician",
    password,
  }, "");
  assert.equal(joined.status, 201);
  assert.equal(joined.data.is_admin, false);
  staffCookie = joined.cookie;
  staffId = joined.data.id;
});

after(async () => {
  await stop();
  platform.store.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

test("personal settings default safely and remain isolated by staff and practice", async () => {
  const defaults = defaultWorkspaceSettings();
  assert.equal((await call("/workflow/user-settings", "GET", undefined, "")).status, 401);
  for (const cookie of [ownerCookie, staffCookie, otherCookie]) {
    const response = await call("/workflow/user-settings", "GET", undefined, cookie);
    assert.equal(response.status, 200);
    assert.deepEqual(response.data, defaults);
  }
  const saved = await call("/workflow/user-settings", "PATCH", {
    start_page: "schedule",
    calendar_view: "month",
    density: "compact",
    reduced_motion: true,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data, {
    start_page: "schedule",
    calendar_view: "month",
    density: "compact",
    reduced_motion: true,
  });
  for (const cookie of [staffCookie, otherCookie]) {
    assert.deepEqual((await call("/workflow/user-settings", "GET", undefined, cookie)).data, defaults);
  }
  assert.equal((await call("/workflow/user-settings", "PATCH", { calendar_view: "day" }, staffCookie)).status, 200);
  assert.equal((await call("/workflow/user-settings")).data.calendar_view, "month");
  assert.equal((await call("/workflow/user-settings", "GET", undefined, staffCookie)).data.calendar_view, "day");
});

test("settings validation and route guards reject unsupported values and target users without mutation", async () => {
  const before = (await call("/workflow/user-settings")).data;
  for (const invalid of [
    { start_page: "encounters" },
    { calendar_view: "year" },
    { density: "tiny" },
    { reduced_motion: "true" },
    { user_id: staffId, calendar_view: "list" },
    { is_admin: true },
    null,
  ]) {
    assert.equal((await call("/workflow/user-settings", "PATCH", invalid)).status, 400);
    assert.deepEqual((await call("/workflow/user-settings")).data, before);
  }
  assert.equal((await call(`/workflow/user-settings/${staffId}`, "PATCH", { calendar_view: "list" })).status, 404);
  assert.equal((await call("/workflow/user-settings", "POST", {})).status, 405);
  assert.equal((await call("/workflow/user-settings", "DELETE", {})).status, 405);
  assert.deepEqual((await call("/workflow/user-settings")).data, before);
  const partial = await call("/workflow/user-settings", "PATCH", { density: "comfortable" });
  assert.equal(partial.status, 200);
  assert.deepEqual(partial.data, { ...before, density: "comfortable" });
});

test("practice integrations are administrator-managed for every staff role and stay demo-only", async () => {
  const configured = {
    lab_provider: "Synthetic demo lab",
    pharmacy_provider: "Synthetic demo pharmacy",
    messaging_provider: "Synthetic demo reminders",
    reminder_channel: "SMS",
  };
  const ownerRead = await call("/workflow/integrations");
  assert.equal(ownerRead.status, 200);
  assert.equal(ownerRead.data.can_manage, true);
  const staffRead = await call("/workflow/integrations", "GET", undefined, staffCookie);
  assert.equal(staffRead.status, 200);
  assert.equal(staffRead.data.can_manage, false);
  assert.equal((await call("/workflow/integrations", "PATCH", configured, staffCookie)).status, 403);
  assert.deepEqual((await call("/workflow/integrations")).data, ownerRead.data);
  const saved = await call("/workflow/integrations", "PATCH", configured);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.reminder_channel, "SMS");
  for (const field of ["lab_connected", "pharmacy_connected", "messaging_connected"])
    assert.equal(saved.data[field], false);
  assert.equal((await call("/workflow/integrations", "GET", undefined, otherCookie)).data.lab_provider, "");
  assert.equal((await call("/workflow/integrations", "PATCH", { ...configured, lab_connected: true })).status, 400);
  assert.equal((await call("/workflow/integrations", "POST", configured)).status, 405);
  assert.equal((await call("/workflow/integrations", "DELETE", {})).status, 405);
  assert.equal((await call("/workflow/integrations")).data.lab_provider, configured.lab_provider);
});

test("personal and practice settings survive process restart and older saved workflows gain defaults", async () => {
  const expected = (await call("/workflow/user-settings")).data;
  await stop();
  platform.store.close();
  db.close();
  db = createDatabase(databasePath);
  platform = createPlatformApp(db, accountsPath);
  await listen();
  assert.deepEqual((await call("/workflow/user-settings")).data, expected);
  assert.equal((await call("/workflow/user-settings", "GET", undefined, staffCookie)).data.calendar_view, "day");
  assert.deepEqual((await call("/workflow/user-settings", "GET", undefined, otherCookie)).data, defaultWorkspaceSettings());
  assert.equal((await call("/workflow/integrations")).data.lab_provider, "Synthetic demo lab");
  const old = emptyWorkflowState();
  delete (old as Partial<typeof old>).user_settings;
  assert.deepEqual(readWorkflowState(JSON.stringify(old)).user_settings, {});
});
