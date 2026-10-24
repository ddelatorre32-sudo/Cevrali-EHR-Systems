import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { exerciseEfficiency } from "./efficiency-browser.ts";
import { exerciseFinance } from "./finance-browser.ts";
import { exercisePatientFinance } from "./patient-finance-browser.ts";
import { exerciseRevenue, exerciseNewPatient } from "./revenue-browser.ts";
import { exerciseAccounts } from "./accounts-browser.ts";
import { exerciseWorkersComp } from "./workers-comp-browser.ts";
import { exerciseRfa } from "./rfa-browser.ts";
import { exerciseOperations } from "./operations-browser.ts";
import { exerciseFaxOcr } from "./fax-ocr-browser.ts";
import { exerciseTreatment } from "./treatment-browser.ts";
import { exerciseScheduleManagement } from "./schedule-management-browser.ts";
import { exerciseNoteAddenda } from "./note-addenda-browser.ts";
import { exerciseNoteResultIntegrity } from "./note-result-integrity-browser.ts";
import { exerciseInsuranceSwitchGuard } from "./insurance-switch-guard-browser.ts";
import { exerciseBookingConflicts } from "./booking-conflicts-browser.ts";
import { exerciseNoShow } from "./no-show-browser.ts";
import { exerciseCalendar } from "./calendar-browser.ts";
import { exerciseSettings } from "./settings-browser.ts";
import { exerciseRegistrationDetails } from "./registration-details-browser.ts";
import { exercisePatientProfile } from "./patient-profile-browser.ts";
import { exerciseStaffCommunication } from "./staff-communication-browser.ts";
import { exerciseMyWork } from "./my-work-browser.ts";

let browser;
const html = readFileSync(resolve("preview/cevrali-preview.html"), "utf8");
before(async () => {
  browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ||
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    args: ["--no-sandbox"],
  });
});
after(async () => {
  await browser?.close();
});
for (const [name, exercise] of [
  ["message assignments and personal My work follow-ups", exerciseMyWork],
  ["staff channels, direct messages, and acknowledged announcements", exerciseStaffCommunication],
  ["patient profile edits and detailed allergy review", exercisePatientProfile],
  ["structured address and searchable patient allergies", exerciseRegistrationDetails],
  ["personal settings and provider template library", exerciseSettings],
  [
    "ordinary bookings prevent overlapping patient visits",
    exerciseBookingConflicts,
  ],
  [
    "corrected-report relinking and source integrity",
    exerciseNoteResultIntegrity,
  ],
  [
    "insurance changes preserve actual treatment accounting",
    exerciseInsuranceSwitchGuard,
  ],
  ["no-show queue and calendar consistency", exerciseNoShow],
  [
    "recurring visits, rescheduling and cancellation waitlist",
    exerciseScheduleManagement,
  ],
  ["actual performed treatment and reconciliation", exerciseTreatment],
  ["scanned-fax identity, classification and value review", exerciseFaxOcr],
  ["signed-note source corrections and addenda", exerciseNoteAddenda],
  ["calendar scheduling and new-patient registration", exerciseCalendar],
  [
    "readiness, claim workspace, incoming fax and note results",
    exerciseOperations,
  ],
  ["RFA autofill, PDF and demo fax", exerciseRfa],
  ["workers compensation and private visit accounts", exerciseWorkersComp],
  ["practice signup, invitation and account isolation", exerciseAccounts],
  ["authorization, replacement and void", exerciseRevenue],
  ["new patient and duplicate review", exerciseNewPatient],
]) {
  test(`${name} operate offline without external delivery`, async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
    });
    const requests = [];
    const errors = [];
    page.on("request", (r) => {
      if (/^https?:/.test(r.url())) requests.push(r.url());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route(/^https?:/, (route) => route.abort());
    try {
      await page.setContent(html);
      await exercise(page);
      assert.deepEqual(requests, []);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}

test("patient registration, chart eligibility and billing run completely offline", async () => {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  const requests = [];
  const errors = [];
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) requests.push(r.url());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/^https?:/, (route) => route.abort());
  try {
    await page.setContent(html);
    await exercisePatientFinance(page);
    assert.deepEqual(requests, []);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("insurance and billing operate offline with no external payer or payment requests", async () => {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  const requests = [];
  const errors = [];
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) requests.push(r.url());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/^https?:/, (route) => route.abort());
  try {
    await page.setContent(html);
    await exerciseFinance(page);
    assert.deepEqual(requests, []);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("all efficiency workflows operate in the standalone preview without network access", async () => {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  const requests = [];
  const errors = [];
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/^https?:/, (route) => route.abort());
  try {
    await page.setContent(html);
    await exerciseEfficiency(page);
    assert.deepEqual(requests, []);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("standalone HTML runs a clinical workflow offline and resets only preview data on reload", async () => {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  const requests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (req) => {
    if (/^https?:/.test(req.url())) requests.push(req.url());
  });
  await page.route(/^https?:/, (route) => route.abort());
  try {
    await page.setContent(html);
    await expect(
      page.getByRole("heading", {
        name: /Good (morning|afternoon|evening), Dr. Morgan/,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Offline preview", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "/tmp/cevrali-offline-preview.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Patients", exact: true }).click();
    await page
      .getByRole("button", { name: "Register patient", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("First name").fill("Preview");
    await dialog.getByLabel("Last name").fill("Example");
    await dialog.getByLabel("Date of birth").fill("1994-05-16");
    await dialog.getByLabel("Phone number").fill("555-0198");
    await dialog.getByRole("combobox", { name: "Known allergies", exact: true }).fill("Penicillin");
    await dialog.getByRole("option", { name: "Penicillin", exact: true }).click();
    await dialog.getByRole("button", { name: "Register patient" }).click();
    await expect(dialog).not.toBeVisible();
    await page
      .getByRole("textbox", { name: "Filter patient directory" })
      .fill("Preview Example");
    await page.getByRole("button", { name: "Open chart" }).click();
    await expect(dialog.getByText("Penicillin", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: "Schedule", exact: true }).click();
    await page.getByRole("button", { name: "New appointment" }).click();
    const patientSelect = dialog.getByRole("combobox", {
      name: "Patient",
      exact: true,
    });
    const option = patientSelect.getByRole("option", {
      name: /Preview Example/,
    });
    await expect(option).toHaveCount(1);
    const patientId = await option.getAttribute("value");
    await patientSelect.selectOption(patientId);
    await dialog.getByLabel("Time", { exact: true }).fill("14:00");
    await dialog.getByLabel("Reason for visit").fill("Offline preview visit");
    await dialog.getByRole("button", { name: "Schedule appointment" }).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole("button", { name: "New appointment" }).click();
    await patientSelect.selectOption(patientId);
    await dialog.getByLabel("Time", { exact: true }).fill("14:15");
    await dialog.getByLabel("Reason for visit").fill("Overlapping appointment");
    await dialog.getByRole("button", { name: "Schedule appointment" }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "overlaps another appointment",
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    const visit = page.getByRole("row").filter({ hasText: "Preview Example" });
    await visit.getByRole("button", { name: "Check in" }).click();
    await visit.getByRole("button", { name: "Start visit" }).click();
    await dialog.getByLabel("Subjective").fill("Synthetic example record.");
    await dialog
      .getByLabel("Assessment", { exact: false })
      .fill("Preventive care review.");
    await dialog
      .getByLabel("Plan", { exact: false })
      .fill("Routine follow-up.");
    await dialog.getByRole("button", { name: "Save draft" }).click();
    await expect(dialog.getByText("All changes saved")).toBeVisible();
    await dialog.getByRole("button", { name: "Sign note" }).click();
    await dialog.getByRole("button", { name: "Confirm signature" }).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole("button", { name: "Encounters", exact: true }).click();
    const row = page.getByRole("row").filter({ hasText: "Preview Example" });
    await row.getByRole("button", { name: "View note" }).click();
    await expect(dialog.getByLabel("Subjective")).toBeDisabled();
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: "Activity log" }).click();
    await expect(
      page.getByRole("cell", { name: "Signed encounter", exact: true }),
    ).toBeVisible();
    await page.reload();
    await page.setContent(html);
    await page.getByRole("button", { name: "Patients", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Filter patient directory" })
      .fill("Preview Example");
    await expect(
      page.getByRole("heading", { name: "No patients found" }),
    ).toBeVisible();
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
  } finally {
    await page.close();
  }
});

test("standalone preview renders on mobile and can switch to the front desk demo", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.setContent(html);
    await expect(
      page.getByRole("heading", {
        name: /Good (morning|afternoon|evening), Dr. Morgan/,
      }),
    ).toBeVisible();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page
      .getByRole("button", { name: "Explore the front desk demo" })
      .click();
    await expect(
      page.getByRole("heading", {
        name: /Good (morning|afternoon|evening), Jamie/,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(
      page.getByRole("button", { name: "Encounters", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Patients", exact: true }).click();
    await expect(
      page
        .getByRole("button", { name: "Insurance & billing", exact: true })
        .first(),
    ).toBeVisible();
  } finally {
    await page.close();
  }
});
