import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createDatabase } from "../server/database.js";
import { createPlatformApp } from "../server/platform.js";

type SessionUser = {
  id: string;
  role: string;
  is_admin: boolean;
  practice: { id: string };
};

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cevrali-session-context-"));
  const db = createDatabase(join(directory, "demo.sqlite"));
  const platform = createPlatformApp(db, join(directory, "accounts"));
  const server = platform.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "",
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
    };
  }
  async function login(email: string) {
    const result = await call("/auth/login", "POST", {
      email,
      password: "CevraliDemo2026!",
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return { user: result.data as SessionUser, cookie: result.cookie };
  }
  const clinician = await login("alex@cevrali.demo");
  const colleague = await login("nina@cevrali.demo");
  const frontDesk = await login("frontdesk@cevrali.demo");
  const snapshot = () => ({
    patients: db.prepare("SELECT * FROM patients ORDER BY id").all(),
    audit: db.prepare("SELECT * FROM audit ORDER BY id").all(),
    sessions: db.prepare("SELECT * FROM sessions ORDER BY token").all(),
  });
  return {
    db,
    call,
    clinician,
    colleague,
    frontDesk,
    snapshot,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      platform.store.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function contextHeaders(user: SessionUser): Record<string, string> {
  return {
    "X-Cevrali-Practice": user.practice.id,
    "X-Cevrali-User": user.id,
    "X-Cevrali-Role": user.role,
    "X-Cevrali-Admin": String(user.is_admin),
  };
}
const registration = {
  first_name: "SessionContext",
  last_name: "SyntheticPatient",
  dob: "1990-05-06",
  phone: "555-0194",
  sex: "Unknown",
};

test("a same-practice clinician change rejects stale reads, registration and sign-out before any side effects", async () => {
  const f = await fixture();
  try {
    assert.equal(f.clinician.user.practice.id, f.colleague.user.practice.id);
    assert.equal(f.clinician.user.role, f.colleague.user.role);
    const before = f.snapshot();
    const stale = contextHeaders(f.clinician.user);
    for (const [path, method, body] of [
      ["/patients/pat-001", "GET", undefined],
      ["/patients", "POST", registration],
      ["/auth/logout", "POST", {}],
    ] as const) {
      const result = await f.call(
        path,
        method,
        body,
        f.colleague.cookie,
        stale,
      );
      assert.equal(
        result.status,
        401,
        `${method} ${path}: ${JSON.stringify(result.data)}`,
      );
    }
    assert.deepEqual(
      f.snapshot(),
      before,
      "stale actions must not create records, audit another user or revoke their session",
    );
    const actual = await f.call(
      "/auth/me",
      "GET",
      undefined,
      f.colleague.cookie,
    );
    assert.equal(actual.status, 200);
    assert.equal(actual.data.id, f.colleague.user.id);
  } finally {
    await f.close();
  }
});

test("role and administrator context mismatches reject stale requests even when the user identity matches", async () => {
  const f = await fixture();
  try {
    const before = f.snapshot();
    const valid = contextHeaders(f.clinician.user);
    for (const mismatch of [
      { "X-Cevrali-Role": "receptionist" },
      { "X-Cevrali-Admin": "false" },
      { "X-Cevrali-User": "" },
    ] as Record<string, string>[]) {
      const result = await f.call(
        "/patients",
        "POST",
        registration,
        f.clinician.cookie,
        { ...valid, ...mismatch },
      );
      assert.equal(result.status, 401, JSON.stringify(result.data));
    }
    assert.deepEqual(f.snapshot(), before);
    const blocked = await f.call(
      "/patients/pat-001",
      "GET",
      undefined,
      f.frontDesk.cookie,
      contextHeaders(f.clinician.user),
    );
    assert.equal(
      blocked.status,
      401,
      "the identity guard must run before the clinical route",
    );
    const authorizedRole = await f.call(
      "/patients/pat-001",
      "GET",
      undefined,
      f.frontDesk.cookie,
      contextHeaders(f.frontDesk.user),
    );
    assert.equal(
      authorizedRole.status,
      403,
      "the normal clinical role restriction remains enforced",
    );
  } finally {
    await f.close();
  }
});

test("correct account context allows normal requests while header-free clients remain compatible and practice isolation stays enforced", async () => {
  const f = await fixture();
  try {
    const headers = contextHeaders(f.clinician.user);
    const me = await f.call(
      "/auth/me",
      "GET",
      undefined,
      f.clinician.cookie,
      headers,
    );
    assert.equal(me.status, 200);
    assert.equal(me.data.id, f.clinician.user.id);
    const created = await f.call(
      "/patients",
      "POST",
      registration,
      f.clinician.cookie,
      headers,
    );
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.ok(
      f.db.prepare("SELECT id FROM patients WHERE id=?").get(created.data.id),
    );
    assert.equal(
      (await f.call("/patients", "GET", undefined, f.clinician.cookie)).status,
      200,
    );
    assert.equal(
      (
        await f.call(
          "/patients",
          "GET",
          undefined,
          f.frontDesk.cookie,
          contextHeaders(f.frontDesk.user),
        )
      ).status,
      200,
    );
    const before = f.snapshot();
    const wrongPractice = await f.call(
      "/patients",
      "POST",
      {
        ...registration,
        last_name: "WrongPractice",
      },
      f.clinician.cookie,
      { ...headers, "X-Cevrali-Practice": "practice-other-workspace" },
    );
    assert.equal(wrongPractice.status, 401);
    assert.deepEqual(f.snapshot(), before);
  } finally {
    await f.close();
  }
});
