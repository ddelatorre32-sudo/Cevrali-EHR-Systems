import assert from "node:assert/strict";

const base = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3000";
let health;
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    health = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (health.ok) break;
  } catch {
    /* The dev processes can still be starting. */
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
assert.ok(health, "Server did not respond to a health check");
assert.equal(health.status, 200);
assert.equal((await health.json()).status, "ok");
const login = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: new URL(base).origin },
  body: JSON.stringify({
    email: "alex@cevrali.demo",
    password: "CevraliDemo2026!",
  }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie);
try {
  for (const [path, validate] of [
    [
      "/account",
      (data) =>
        data.practice?.is_demo === true &&
        data.is_admin === true &&
        Array.isArray(data.members),
    ],
    ["/patients", (data) => Array.isArray(data) && data.length >= 8],
    [
      "/overview",
      (data) =>
        typeof data.appointments === "number" &&
        /^\d{4}-\d{2}-\d{2}$/.test(data.today),
    ],
    ["/appointments", (data) => Array.isArray(data)],
    ["/encounters", (data) => Array.isArray(data) && data.length >= 3],
    ["/workflow/queue", (data) => Array.isArray(data)],
    ["/workflow/tasks", (data) => Array.isArray(data)],
    ["/workflow/templates", (data) => Array.isArray(data) && data.length >= 3],
    [
      "/workflow/staff",
      (data) => Array.isArray(data.directory) &&
        data.conversations.some((conversation) => conversation.id === "staff-general") &&
        typeof data.unread_messages === "number",
    ],
    ["/workflow/metrics", (data) => typeof data.measured_visits === "number"],
    ["/workflow/finance/policies", (data) => Array.isArray(data)],
    [
      "/workflow/finance/accounts",
      (data) =>
        Array.isArray(data) &&
        data.every(
          (a) =>
            a.kind === "Private insurance" || a.kind === "Workers compensation",
        ),
    ],
    ["/workflow/finance/bills", (data) => Array.isArray(data)],
    ["/workflow/finance/authorizations", (data) => Array.isArray(data)],
    ["/workflow/finance/rfa", (data) => Array.isArray(data)],
    ["/workflow/finance/faxes", (data) => Array.isArray(data)],
    ["/workflow/finance/corrections", (data) => Array.isArray(data)],
    ["/workflow/operations/readiness", (data) => Array.isArray(data)],
    ["/workflow/operations/service-approvals", (data) => Array.isArray(data)],
    ["/workflow/operations/incoming-faxes", (data) => Array.isArray(data)],
    ["/workflow/operations/alerts", (data) => Array.isArray(data)],
    [
      "/workflow/scheduling",
      (data) => Array.isArray(data.waitlist) && Array.isArray(data.series),
    ],
    [
      "/workflow/operations/treatment-reconciliation",
      (data) => Array.isArray(data),
    ],
    [
      "/workflow/note-addenda/corrections",
      (data) => Array.isArray(data.corrections),
    ],
    [
      "/workflow/finance/summary",
      (data) =>
        data.payer_connected === false &&
        data.clearinghouse_connected === false,
    ],
    [
      "/workflow/integrations",
      (data) =>
        data.messaging_connected === false &&
        data.pharmacy_connected === false &&
        data.lab_connected === false,
    ],
  ]) {
    const response = await fetch(`${base}/api${path}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 200, path);
    assert.ok(validate(await response.json()), `Invalid response: ${path}`);
  }
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Cevrali/);
  console.log(
    "Smoke passed: web page, SQLite health, sign-in, charts, schedule, encounters, queue, tasks, templates, metrics, insurance, billing, RFA packets, demo fax outbox, and disconnected demo integrations.",
  );
} finally {
  const logout = await fetch(`${base}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(logout.status, 200);
}
