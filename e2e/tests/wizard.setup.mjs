/**
 * First run: the wizard, in a browser, against the container.
 *
 * This is the only spec that can create the account (setup runs once per data
 * volume), so it also writes what the rest of the suite needs: the browser
 * session (Playwright storage state) and the base32 secret with the step that
 * enrolment spent.
 *
 * Serial on purpose: a failure here means there is nothing for the rest of the
 * suite to test, so the remaining tests are skipped rather than run against a
 * container that never got an account.
 */

import { test, expect } from "@playwright/test";
import {
  completeStep1,
  completeStep2,
  expectApplication,
  expectFirstRunWizard,
  expectStep2,
  readDisplayedSecret,
} from "../lib/flows.mjs";
import { ACCOUNT, STORAGE_STATE, writeAccount } from "../lib/state.mjs";
import { base32Decode, hotp, totpAt } from "../lib/totp.mjs";

test.describe.configure({ mode: "serial" });

/** The tokens the gateway copies from the ZCode stylesheet, as the browser computes them. */
const THEME = {
  background: "rgb(22, 22, 22)",
  panel: "rgb(32, 32, 32)",
  foreground: "rgb(229, 229, 229)",
  surface: "rgba(255, 255, 255, 0.05)",
};

/**
 * The computed styles of a gateway page. The password field is the one the page
 * does not focus: focusing swaps the surface token for the hover one, and the
 * resting state is what this reads.
 */
function pageTheme(page) {
  return page.evaluate(() => {
    const read = (element) => {
      if (!element) {
        return null;
      }
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, color: style.color };
    };
    return {
      body: read(document.body),
      panel: read(document.querySelector("main")),
      restingInput: read(document.querySelector('input[type="password"]')),
    };
  });
}

test("a clean volume sends the first visitor to the setup wizard", async ({ page }) => {
  await expectFirstRunWizard(page);
  await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
});

test("the wizard wears the ZCode theme on both steps", async ({ page }) => {
  await expectFirstRunWizard(page);
  const step1 = await pageTheme(page);
  expect(step1.body.background).toBe(THEME.background);
  expect(step1.body.color).toBe(THEME.foreground);
  expect(step1.panel.background).toBe(THEME.panel);
  expect(step1.restingInput.background).toBe(THEME.surface);
  expect(step1.restingInput.color).toBe(THEME.foreground);

  await completeStep1(page, ACCOUNT);
  await expectStep2(page);
  const step2 = await pageTheme(page);
  expect(step2.body.background).toBe(THEME.background);
  expect(step2.panel.background).toBe(THEME.panel);
  expect(step2.restingInput).toBeNull();
});

test("a password shorter than 12 characters is refused, and nothing is created", async ({ page }) => {
  await expectFirstRunWizard(page);
  await page.getByLabel("Username").fill(ACCOUNT.username);
  await page.getByLabel("Password", { exact: true }).fill("too-short");
  await page.getByLabel("Confirm password").fill("too-short");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("alert")).toHaveText("Password must be at least 12 characters.");
  await expect(page).toHaveURL(/_auth\/setup$/);

  // The rejected attempt created nothing: the wizard is still the first page.
  await page.goto("/");
  await expect(page).toHaveURL(/_auth\/setup$/);
});

test("the displayed secret is a base32 key grouped in blocks of four", async ({ page }) => {
  await expectFirstRunWizard(page);
  await completeStep1(page, ACCOUNT);
  await expectStep2(page);

  const { clipboardValue, ungrouped, groups } = await readDisplayedSecret(page);
  expect(groups.length).toBeGreaterThan(0);
  for (const group of groups) {
    expect(group).toHaveLength(4);
    expect(group).toMatch(/^[A-Z2-7]+$/);
  }
  // A SHA-1 TOTP secret is 20 bytes, so 32 base32 characters.
  expect(ungrouped).toHaveLength(32);
  expect(groups.join("")).toBe(ungrouped);
  // The key the "Copy key" button puts on the clipboard is the same, unspaced.
  expect(clipboardValue).toBe(ungrouped);
  expect(base32Decode(ungrouped)).toHaveLength(20);
});

test("the code from the displayed secret finishes setup and opens the interface", async ({ page }) => {
  await expectFirstRunWizard(page);
  await completeStep1(page, ACCOUNT);
  await expectStep2(page);

  const { ungrouped: secret } = await readDisplayedSecret(page);
  const { code, step } = totpAt(secret);
  expect(code).toMatch(/^\d{6}$/);
  // The helper is checked against itself: the same counter recomputed gives the
  // same code, which is what an authenticator app does at every window.
  expect(hotp(secret, step)).toBe(code);

  await completeStep2(page, code);
  await expectApplication(page);

  await page.context().storageState({ path: STORAGE_STATE });
  await writeAccount({
    ...ACCOUNT,
    secret,
    setupStep: step,
    // The code just spent is the last one the server has accepted.
    lastUsedStep: step,
    createdAt: new Date().toISOString(),
  });
});

test("setup is closed and every path now asks to sign in", async ({ page }) => {
  await page.goto("/_auth/setup");
  await expect(page).toHaveURL(/_auth\/login$/);

  await page.goto("/");
  await expect(page).toHaveURL(/_auth\/login\?next=%2F/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});
