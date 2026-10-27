import { expect, test } from "@playwright/test";

const pilot = { mode: "pilot", demo_enabled: false, public_signup_enabled: false,
  mfa_required: true, clinical_use_allowed: false };
const pending = (email: string, enrollment = true) => ({ kind: "mfa", email,
  challenge_token: "a".repeat(64), expires_at: new Date(Date.now() + 300_000).toISOString(),
  enrollment_required: enrollment });
const json = (value: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(value) });

test("pilot sign-in waits for authenticator verification and recovery-code acknowledgement", async ({ page }) => {
  // The backend MFA invariants are tested separately. These route fixtures test
  // the browser transitions without enrolling a shared demo user.
  const signedIn = await page.request.post("/api/auth/login", {
    data: { email: "alex@cevrali.demo", password: "CevraliDemo2026!" },
  });
  expect(signedIn.ok()).toBe(true);
  const user = await signedIn.json();
  await page.route("**/api/auth/me", route => route.fulfill({ status: 401,
    contentType: "application/json", body: JSON.stringify({ error: "Please sign in to continue" }) }), { times: 1 });
  await page.route("**/api/runtime", route => route.fulfill(json(pilot)));
  await page.route("**/api/auth/login", route => route.fulfill(json(pending(user.email))));
  await page.route("**/api/auth/mfa/setup", route => route.fulfill(json({
    secret: "JBSWY3DPEHPK3PXP", otpauth_uri: "otpauth://totp/Synthetic?secret=JBSWY3DPEHPK3PXP", expires_at: new Date(Date.now() + 300_000).toISOString(),
  })));
  let verificationAttempts = 0;
  await page.route("**/api/auth/mfa/enroll", route => {
    verificationAttempts++;
    const input = route.request().postDataJSON();
    return route.fulfill(json(input.code === "123456"
      ? { ok: true, user, recovery_codes: ["synthetic-code-one", "synthetic-code-two"] }
      : { ok: false, error: "The verification code is incorrect.", attempts_remaining: 4 }));
  });
  await page.goto("/");
  await expect(page.getByText("Restricted staff pilot.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open clinician demo", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create practice account", exact: true })).toHaveCount(0);
  await page.getByLabel("Email address", { exact: true }).fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill("CevraliDemo2026!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Set up your authenticator", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Patients", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Set up authenticator", exact: true }).click();
  await expect(page.getByLabel("Authenticator setup key", { exact: true })).toHaveText("JBSWY3DPEHPK3PXP");
  await page.getByLabel("Authenticator code", { exact: true }).fill("000000");
  await page.getByRole("button", { name: "Confirm authenticator", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("verification code is incorrect");
  await expect(page.getByRole("status")).toContainText("4 verification attempts remaining");
  await page.getByLabel("Authenticator code", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "Confirm authenticator", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Patients", exact: true })).toHaveCount(0);
  await page.getByLabel("I saved my recovery codes in a private place.", { exact: true }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("button", { name: "Patients", exact: true })).toBeVisible();
  await expect(page.getByRole("note")).toHaveText("Staff pilot — synthetic patient data only. Clinical use is disabled.");
  await expect(page.getByLabel("Authenticator setup key", { exact: true })).toHaveCount(0);
  expect(verificationAttempts).toBe(2);
});

test("missing runtime metadata hides public demo and signup actions while keeping account sign-in", async ({ page }) => {
  await page.route("**/api/runtime", route => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  await page.goto("/");
  await expect(page.getByRole("status")).toContainText("Environment details could not be loaded");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open clinician demo", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create practice account", exact: true })).toHaveCount(0);
});

test("an invitation can require authenticator setup before opening the workspace", async ({ page }) => {
  const token = "b".repeat(64);
  await page.route(`**/api/accounts/invitations/${token}`, route => route.fulfill(json({
    practice_name: "Synthetic Pilot Practice", email: "invite@example.test", role: "clinician", is_admin: false,
  })));
  await page.route(`**/api/accounts/invitations/${token}/accept`, route => route.fulfill(json(pending("invite@example.test"))));
  await page.goto(`/#join/${token}`);
  await page.getByLabel("Your full name", { exact: true }).fill("Synthetic Clinician");
  await page.getByLabel("Password (12 or more characters)", { exact: true }).fill("SyntheticPassword2026!");
  await page.getByLabel("Confirm password", { exact: true }).fill("SyntheticPassword2026!");
  await page.getByRole("button", { name: "Accept invitation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Set up your authenticator", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Patients", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Accept invitation", exact: true })).toHaveCount(0);
});

test("a failed password check in authenticator settings remains a visible failure", async ({ page }) => {
  const login = await page.request.post("/api/auth/login", { data: { email: "alex@cevrali.demo", password: "CevraliDemo2026!" } });
  expect(login.ok()).toBe(true);
  await page.route("**/api/account/mfa", route => route.fulfill(json({ available: true, required: false,
    mfa_enabled: false, recovery_codes_remaining: 0 })));
  await page.route("**/api/account/mfa/setup", route => route.fulfill(json({ ok: false,
    error: "Current password is incorrect.", attempts_remaining: 4 })));
  await page.goto("/#account");
  await page.getByRole("tab", { name: "Security", exact: true }).click();
  const settings = page.getByRole("region", { name: "Authenticator verification", exact: true });
  await settings.getByRole("button", { name: "Set up authenticator", exact: true }).click();
  await settings.getByLabel("Your current password", { exact: true }).fill("wrong-password");
  await settings.getByRole("button", { name: "Continue setup", exact: true }).click();
  await expect(settings.getByRole("alert")).toHaveText("Current password is incorrect.");
  await expect(settings.getByLabel("Authenticator setup key", { exact: true })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Continue setup", exact: true })).toBeVisible();
});
