import { expect, test, type Page } from "@playwright/test";

async function openClinicianChart(page: Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open clinician demo", exact: true })
    .click();
  await page.getByRole("button", { name: "Patients", exact: true }).click();
  await page
    .getByRole("row")
    .filter({ hasText: "Olivia Bennett" })
    .getByRole("button", { name: "Open chart", exact: true })
    .click();
  const chart = page.getByRole("dialog", {
    name: "Patient chart",
    exact: true,
  });
  await expect(
    chart.getByRole("heading", { name: "Active conditions", exact: true }),
  ).toBeVisible();
  await expect(
    chart.locator(".condition").filter({ hasText: "Hypertension" }),
  ).toBeVisible();
  return chart;
}

test("switching another tab from clinician to front desk clears the old clinical chart and identity", async ({
  page,
  context,
}) => {
  const chart = await openClinicianChart(page);
  const other = await context.newPage();
  try {
    await other.goto("/");
    await other.getByRole("button", { name: "Sign out", exact: true }).click();
    await other
      .getByRole("button", { name: "Explore the front desk demo", exact: true })
      .click();
    await expect(
      other.getByRole("heading", {
        name: /Good (morning|afternoon|evening), Jamie/,
      }),
    ).toBeVisible();
    await page.bringToFront();
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(chart).toHaveCount(0);
    await expect(
      page.locator(".condition").filter({ hasText: "Hypertension" }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Dr. Alex Morgan", { exact: true }),
    ).toHaveCount(0);
    expect((await context.request.get("/api/patients/pat-001")).status()).toBe(
      403,
    );
  } finally {
    await other.close();
  }
});

test("same-practice clinician replacement clears the old chart even though both accounts have clinical access", async ({
  page,
  context,
}) => {
  const chart = await openClinicianChart(page);
  const other = await context.newPage();
  try {
    await other.goto("/");
    await other.getByRole("button", { name: "Sign out", exact: true }).click();
    await other
      .getByLabel("Email address", { exact: true })
      .fill("nina@cevrali.demo");
    await other
      .getByLabel("Password", { exact: true })
      .fill("CevraliDemo2026!");
    await other.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      other.getByText("Dr. Nina Patel", { exact: true }).first(),
    ).toBeVisible();
    await page.bringToFront();
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(chart).toHaveCount(0);
    await expect(
      page.locator(".condition").filter({ hasText: "Hypertension" }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Dr. Alex Morgan", { exact: true }),
    ).toHaveCount(0);
    const current = await (await context.request.get("/api/auth/me")).json();
    expect(current.name).toBe("Dr. Nina Patel");
  } finally {
    await other.close();
  }
});

test("session revalidation on returning focus preserves an unchanged account’s unsaved SOAP draft", async ({
  page,
  context,
}) => {
  const chart = await openClinicianChart(page);
  await chart
    .getByRole("button", { name: "New encounter", exact: true })
    .click();
  const start = page.getByRole("dialog", {
    name: "Start an encounter",
    exact: true,
  });
  await start
    .getByLabel("Chief complaint", { exact: true })
    .fill("Synthetic session focus review");
  await start
    .getByRole("button", { name: "Create encounter", exact: true })
    .click();
  const note = page.getByRole("dialog", {
    name: "Document encounter",
    exact: true,
  });
  const narrative =
    "Unsaved synthetic history must survive a same-account focus check.";
  const subjective = note
    .locator(".soap-label")
    .filter({ hasText: "Subjective" })
    .locator("textarea");
  await subjective.fill(narrative);
  const chiefComplaint = note.getByLabel("Chief complaint", { exact: true });
  await expect(chiefComplaint).toHaveValue("Synthetic session focus review");
  const other = await context.newPage();
  try {
    await other.goto("/");
    await expect(
      other.getByText("Dr. Alex Morgan", { exact: true }).first(),
    ).toBeVisible();
    const revalidated = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/auth/me") &&
        response.request().method() === "GET",
    );
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const response = await revalidated;
    expect(response.status()).toBe(200);
    await expect(note).toBeVisible();
    await expect(subjective).toHaveValue(narrative);
    await expect(chiefComplaint).toHaveValue("Synthetic session focus review");
    await expect(
      page.getByRole("button", { name: "Sign out", exact: true }),
    ).toBeVisible();
  } finally {
    await other.close();
  }
});
