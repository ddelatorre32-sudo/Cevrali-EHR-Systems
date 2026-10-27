import { expect, test, type BrowserContext } from "@playwright/test";
import express from "express";
import { createHmac, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { AccountStore } from "../../server/accounts";

// Independent RFC 6238 code generation for the real server enrollment flow.
function authenticatorCode(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = Array.from(secret.toUpperCase().replace(/=+$/, ""), character => {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("Authenticator setup returned invalid Base32");
    return index.toString(2).padStart(5, "0");
  }).join("");
  const key = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, index) =>
    Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

test("real HTTPS pilot requires authenticator enrollment, protects chart access, and accepts a single-use recovery sign-in", async ({ browser }) => {
  test.setTimeout(90_000);
  const directory = mkdtempSync(join(tmpdir(), "cevrali-pilot-browser-"));
  const tlsKey = join(directory, "tls.key");
  const tlsCertificate = join(directory, "tls.crt");
  let context: BrowserContext | undefined;
  let mainDb: DatabaseSync | undefined;
  let store: AccountStore | undefined;
  let httpsServer: ReturnType<typeof createServer> | undefined;
  try {
    // These short-lived keys and this certificate belong only to the isolated
    // local test. No production files, external services, or browser mocks are used.
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", tlsKey, "-out", tlsCertificate, "-days", "1", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "pipe", timeout: 10_000 });
    const authKey = join(directory, "authentication.key");
    const backupKey = join(directory, "backup.key");
    writeFileSync(authKey, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
    writeFileSync(backupKey, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
    httpsServer = createServer({ key: readFileSync(tlsKey), cert: readFileSync(tlsCertificate) });
    await new Promise<void>((accept, reject) => {
      httpsServer!.once("error", reject);
      httpsServer!.listen(0, "127.0.0.1", () => { httpsServer!.off("error", reject); accept(); });
    });
    const address = httpsServer.address();
    if (!address || typeof address === "string") throw new Error("Pilot HTTPS test did not acquire a local port");
    const baseUrl = `https://127.0.0.1:${address.port}`;
    // Import the exact built server that the ordinary browser suite exercises.
    const { createDatabase } = await import(pathToFileURL(resolve("dist-server/database.js")).href) as typeof import("../../server/database");
    const { loadRuntimeConfig } = await import(pathToFileURL(resolve("dist-server/runtime-config.js")).href) as typeof import("../../server/runtime-config");
    const { createPlatformApp } = await import(pathToFileURL(resolve("dist-server/platform.js")).href) as typeof import("../../server/platform");
    const runtime = loadRuntimeConfig({ CEVRALI_MODE: "pilot", COOKIE_SECURE: "true",
      PUBLIC_BASE_URL: baseUrl, DATABASE_PATH: join(directory, "cevrali.sqlite"),
      ACCOUNTS_PATH: join(directory, "accounts"), CEVRALI_AUTH_ENCRYPTION_KEY_FILE: authKey,
      CEVRALI_BACKUP_KEY_FILE: backupKey });
    mainDb = createDatabase(runtime.databasePath, { seedDemo: false });
    const platform = createPlatformApp(mainDb, runtime.accountsPath, { runtime });
    store = platform.store;
    const email = "synthetic-pilot-owner@example.test";
    const password = "SyntheticPilotBrowser2026!";
    // This represents operator provisioning, not the disabled public signup route.
    const created = store.signup({ owner_name: "Synthetic Pilot Owner", email, password,
      clinical_access: true, practice: { name: "Synthetic Pilot Browser Practice" } });
    const tenantDb = store.db(created.practice.id);
    platform.app.use(express.static(resolve("dist")));
    platform.app.get("/{*path}", (_request, response) => response.sendFile(resolve("dist/index.html")));
    httpsServer.on("request", platform.app);
    context = await browser.newContext({ ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    const sessionCookies = async () => (await context!.cookies(baseUrl)).filter(cookie => cookie.name === "cevrali_session");
    const signIn = async () => {
      await page.getByLabel("Email address", { exact: true }).fill(email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      const pending = page.waitForResponse(response => response.url() === `${baseUrl}/api/auth/login` && response.request().method() === "POST");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      const response = await pending;
      expect(response.status()).toBe(200);
      expect((await response.allHeaders())["set-cookie"]).toBeUndefined();
      const challenge = await response.json();
      expect(challenge.kind).toBe("mfa");
      expect(challenge.user).toBeUndefined();
      expect(await sessionCookies()).toHaveLength(0);
      expect((await context!.request.get(`${baseUrl}/api/patients`)).status()).toBe(401);
      return challenge;
    };

    await page.goto(baseUrl);
    await expect(page.getByText("Restricted staff pilot.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open clinician demo", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create practice account", exact: true })).toHaveCount(0);
    expect((await context.request.post(`${baseUrl}/api/accounts/signup`, { data: {} })).status()).toBe(403);
    expect((await signIn()).enrollment_required).toBe(true);
    expect(tenantDb.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count).toBe(0);
    expect(store.registry.prepare("SELECT COUNT(*) AS count FROM session_index").get()?.count).toBe(0);
    await expect(page.getByRole("heading", { name: "Set up your authenticator", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Set up authenticator", exact: true }).click();
    const secret = await page.getByLabel("Authenticator setup key", { exact: true }).textContent();
    if (!secret) throw new Error("Authenticator setup did not display its enrollment key");
    await page.getByLabel("Authenticator code", { exact: true }).fill(authenticatorCode(secret));
    const enrollment = page.waitForResponse(response => response.url() === `${baseUrl}/api/auth/mfa/enroll`);
    await page.getByRole("button", { name: "Confirm authenticator", exact: true }).click();
    const enrollmentResponse = await enrollment;
    expect(enrollmentResponse.status()).toBe(200);
    expect((await enrollmentResponse.json()).ok).toBe(true);
    const setCookie = (await enrollmentResponse.allHeaders())["set-cookie"] || "";
    expect(setCookie).toMatch(/;\s*Secure(?:;|$)/i);
    expect(setCookie).toMatch(/;\s*HttpOnly(?:;|$)/i);
    expect(setCookie).toMatch(/;\s*SameSite=Strict(?:;|$)/i);
    await expect(page.getByRole("heading", { name: "Save your recovery codes", exact: true })).toBeVisible();
    const recoveryCodes = await page.getByRole("list", { name: "Recovery codes", exact: true }).locator("code").allTextContents();
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Patients", exact: true })).toHaveCount(0);
    await page.getByLabel("I saved my recovery codes in a private place.", { exact: true }).check();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("note")).toHaveText("Staff pilot — synthetic patient data only. Clinical use is disabled.");
    const [firstCookie] = await sessionCookies();
    expect(firstCookie).toMatchObject({ secure: true, httpOnly: true, sameSite: "Strict" });
    const patientResponse = await context.request.post(`${baseUrl}/api/patients`, { data: {
      first_name: "Synthetic", last_name: "PilotChart", dob: "1990-01-01", sex: "Unknown", phone: "555-0100",
    } });
    expect(patientResponse.status()).toBe(201);
    // The setup API write happens outside the application's mutation handlers;
    // reload the directory so this browser reads the newly created record.
    await page.goto(`${baseUrl}/#patients`);
    await page.reload();
    await page.getByRole("row").filter({ hasText: "PilotChart" }).getByRole("button", { name: "Open chart", exact: true }).click();
    const chart = page.getByRole("dialog", { name: "Patient chart", exact: true });
    await expect(chart).toBeVisible();
    await expect(chart).toContainText("Synthetic PilotChart");
    await chart.getByRole("button", { name: "Close dialog", exact: true }).click();
    const signedOut = page.waitForResponse(response => response.url() === `${baseUrl}/api/auth/logout`);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    expect((await signedOut).status()).toBe(200);
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    expect(await sessionCookies()).toHaveLength(0);

    expect((await signIn()).enrollment_required).toBe(false);
    await expect(page.getByRole("heading", { name: "Verify your sign-in", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Use a recovery code", exact: true }).click();
    await page.getByLabel("Recovery code", { exact: true }).fill(recoveryCodes[0]);
    const recovery = page.waitForResponse(response => response.url() === `${baseUrl}/api/auth/mfa/complete`);
    await page.getByRole("button", { name: "Verify and sign in", exact: true }).click();
    expect((await recovery).status()).toBe(200);
    await expect(page.getByRole("button", { name: "Patients", exact: true })).toBeVisible();
    await expect(page.getByRole("note")).toHaveText("Staff pilot — synthetic patient data only. Clinical use is disabled.");
    const [recoveredCookie] = await sessionCookies();
    expect(recoveredCookie).toMatchObject({ secure: true, httpOnly: true, sameSite: "Strict" });
    expect(recoveredCookie.value === firstCookie.value).toBe(false);
    const status = await context.request.get(`${baseUrl}/api/account/mfa`);
    expect(status.status()).toBe(200);
    expect(await status.json()).toMatchObject({ required: true, mfa_enabled: true, recovery_codes_remaining: 9 });
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await signIn();
    await page.getByRole("button", { name: "Use a recovery code", exact: true }).click();
    await page.getByLabel("Recovery code", { exact: true }).fill(recoveryCodes[0]);
    const reused = page.waitForResponse(response => response.url() === `${baseUrl}/api/auth/mfa/complete`);
    await page.getByRole("button", { name: "Verify and sign in", exact: true }).click();
    const reusedResponse = await reused;
    expect(reusedResponse.status()).toBe(200);
    expect((await reusedResponse.json()).ok).toBe(false);
    await expect(page.getByRole("alert")).toContainText("already been used");
    expect(await sessionCookies()).toHaveLength(0);
    expect((await context.request.get(`${baseUrl}/api/patients`)).status()).toBe(401);
    expect(pageErrors).toEqual([]);
  } finally {
    await context?.close();
    if (httpsServer) {
      httpsServer.closeAllConnections();
      await new Promise<void>(accept => httpsServer!.close(() => accept()));
    }
    store?.close();
    mainDb?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
