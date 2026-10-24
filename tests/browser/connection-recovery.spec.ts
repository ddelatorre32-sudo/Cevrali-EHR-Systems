import { expect, test } from "@playwright/test";

for (const failure of ["gateway", "malformed-success"] as const) {
  test(`startup ${failure} failure is visible and retry restores the existing session`, async ({ page }) => {
    const login = await page.request.post("/api/auth/login", {
      data: { email: "alex@cevrali.demo", password: "CevraliDemo2026!" },
    });
    expect(login.ok()).toBe(true);
    let unavailable = true;
    let browserWrites = 0;
    page.on("request", (request) => {
      if (request.method() !== "GET") browserWrites++;
    });
    await page.route("**/api/auth/me", (route) => unavailable
      ? route.fulfill({
        status: failure === "gateway" ? 503 : 200,
        contentType: "text/html",
        body: "<html><body>Gateway maintenance: private diagnostics</body></html>",
      })
      : route.continue());
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Unable to open Cevrali" })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("Please retry the connection");
    await expect(page.getByRole("button", { name: "Open clinician demo", exact: true })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("private diagnostics");
    unavailable = false;
    await page.getByRole("button", { name: "Retry connection", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening), Dr. Morgan/ })).toBeVisible();
    expect(browserWrites).toBe(0);
  });
}

test("an unresponsive startup check times out and can be retried without reloading", async ({ page }) => {
  await page.clock.install();
  let unresponsive = true;
  await page.route("**/api/auth/me", (route) => {
    if (!unresponsive) return route.continue();
    // Keep the request open to exercise the application's AbortController.
  });
  await page.goto("/");
  await expect(page.getByText("Preparing your workspace…", { exact: true })).toBeVisible();
  await page.clock.fastForward(11000);
  await expect(page.getByRole("heading", { name: "Unable to open Cevrali" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("taking longer than expected");
  unresponsive = false;
  await page.getByRole("button", { name: "Retry connection", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Welcome to Cevrali" })).toBeVisible();
});

test("a gateway error during sign-in shows a useful message without markup or automatic mutation retries", async ({ page }) => {
  await page.goto("/");
  let attempts = 0;
  await page.route("**/api/auth/login", (route) => {
    attempts++;
    return route.fulfill({
      status: 503,
      contentType: "text/html",
      body: "<html><body>Gateway maintenance: private diagnostics</body></html>",
    });
  });
  await page.getByRole("button", { name: "Open clinician demo", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Cevrali is temporarily unavailable. Please try again.");
  await expect(page.locator("body")).not.toContainText("private diagnostics");
  await expect(page.locator("body")).not.toContainText("Unexpected token");
  expect(attempts).toBe(1);
  await page.unroute("**/api/auth/login");
  await page.getByRole("button", { name: "Open clinician demo", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening), Dr. Morgan/ })).toBeVisible();
});
