/**
 * The flows the suite drives, one function per step a human would take.
 *
 * Every locator in this file was read from a page rendered by a real container,
 * never guessed: the headings are the rendered text, the fields are reached
 * through their labels, and the secret is read from the element that displays
 * it. Where a step navigates, the click and the navigation wait are paired, so
 * a spec that follows reads the page that actually loaded.
 */

import { expect } from "@playwright/test";
import { nextUnusedCode } from "./totp.mjs";

export const SETUP_HEADINGS = {
  step1: "Create the account",
  step2: "Enrol the authenticator",
  signIn: "Sign in",
  verify: "Two-factor code",
};

/** The message the gateway renders when a password does not match. */
export const WRONG_PASSWORD_MESSAGE = "Incorrect username or password.";
/** The message the gateway renders when a code is wrong, malformed or replayed. */
export const WRONG_CODE_MESSAGE = "That code is not valid.";

/**
 * A clean browser lands on the wizard, not on the interface, as long as no
 * account exists. The redirect is what makes the first run usable.
 */
export async function expectFirstRunWizard(page) {
  await page.goto("/");
  await expect(page).toHaveURL(/_auth\/setup$/);
  await expect(page.getByRole("heading", { name: SETUP_HEADINGS.step1 })).toBeVisible();
  await expect(page.getByText("Step 1 of 2")).toBeVisible();
}

/**
 * Step 1 posts the username, the password and the confirmation. On success the
 * gateway answers 303 to the TOTP step.
 */
export async function completeStep1(page, { username, password }) {
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await Promise.all([
    page.waitForURL(/_auth\/setup\/totp$/),
    page.getByRole("button", { name: "Continue" }).click(),
  ]);
}

export async function expectStep2(page) {
  await expect(page.getByRole("heading", { name: SETUP_HEADINGS.step2 })).toBeVisible();
  await expect(page.getByText("Step 2 of 2")).toBeVisible();
}

/**
 * The secret as the wizard displays it, and as an authenticator app would
 * receive it: the text is grouped in blocks of four, and the "Copy key" button
 * carries the ungrouped value it puts on the clipboard. Both are read, so the
 * spec can check the grouping against the value the clipboard would receive.
 */
export async function readDisplayedSecret(page) {
  const element = page.locator("#otp-secret");
  await expect(element).toBeVisible();
  const displayed = (await element.textContent())?.trim() ?? "";
  const clipboardValue =
    (await page.locator("#copy-secret").getAttribute("data-secret"))?.trim() ?? "";
  return {
    displayed,
    clipboardValue,
    ungrouped: displayed.replace(/\s/g, ""),
    groups: displayed.length === 0 ? [] : displayed.split(/\s+/),
  };
}

/** Step 2 posts the code. A wrong code is re-rendered on the same page with the secret still shown. */
export async function completeStep2(page, code) {
  await page.getByLabel("Code from the app").fill(code);
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/"),
    page.getByRole("button", { name: "Finish setup" }).click(),
  ]);
}

/**
 * What "reached the ZCode interface" means, without touching the application:
 * the root document of the app is served at /, its title is the product name,
 * and its root element has rendered something.
 */
export async function expectApplication(page) {
  await expect(page).toHaveURL((url) => url.pathname === "/");
  await expect(page).toHaveTitle(/ZCodium/);
  // The interface is a single page application: the shell is served at / and the
  // client renders into it. Both are awaited, so a blank document is a failure.
  const root = page.locator("#root");
  await expect(root).toBeVisible();
  await expect(root).not.toBeEmpty();
}

/** The sign in page, once an account exists. */
export async function openSignInPage(page) {
  await page.goto("/_auth/login");
  await expect(page.getByRole("heading", { name: SETUP_HEADINGS.signIn })).toBeVisible();
}

/**
 * The password step. A correct password redirects to /_auth/verify, a wrong one
 * re-renders the page with an alert.
 */
export async function submitCredentials(page, { username, password }) {
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
}

export async function expectVerifyPage(page) {
  await expect(page).toHaveURL(/_auth\/verify$/);
  await expect(page.getByRole("heading", { name: SETUP_HEADINGS.verify })).toBeVisible();
}

/** The code step. Signing in lands back on the next path, "/" by default. */
export async function submitCode(page, code) {
  await page.getByLabel("Verification code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
}

export async function expectRejected(page, message) {
  await expect(page.getByRole("alert")).toHaveText(message);
}

/** The alert is inside the gateway page: reading it first is what proves the rejection. */
export async function rejectionMessage(page) {
  return page.getByRole("alert").textContent();
}

/**
 * A full sign in with a code the server has not accepted yet. The wait for the
 * next 30 second step happens here and nowhere else, so no spec has to know
 * about TOTP windows.
 */
export async function signInWithFreshCode(page, { username, password, secret, lastUsedStep }) {
  await openSignInPage(page);
  await submitCredentials(page, { username, password });
  await expectVerifyPage(page);
  const { code, step } = await nextUnusedCode(secret, { lastUsedStep });
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/"),
    submitCode(page, code),
  ]);
  return { code, step };
}

/**
 * Leaving the session. The gateway owns POST /_auth/logout, and the interface
 * behind it knows nothing about authentication, so there is no sign out button
 * to click: the request goes through the browser context, with the cookies the
 * browser holds, and then the browser is asked to load / again.
 */
export async function signOut(page) {
  const response = await page.request.post("/_auth/logout", { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  expect(response.headers()["location"]).toBe("/_auth/login");
}

export async function expectSignInRequired(page) {
  await expect(page).toHaveURL(/_auth\/login/);
  await expect(page.getByRole("heading", { name: SETUP_HEADINGS.signIn })).toBeVisible();
}

/** The session cookie the browser holds, as a Cookie header for a raw request. */
export async function sessionCookieHeader(context) {
  const cookies = await context.cookies();
  const session = cookies.find((cookie) => cookie.name === "zc_sess");
  expect(session, "the browser should hold the gateway session cookie").toBeTruthy();
  return `${session.name}=${session.value}`;
}

/**
 * The background of an input at rest.
 *
 * A field that carries autofocus is measured while focused otherwise, and the
 * focused rule swaps the surface token for the hover one, through a 120ms
 * transition: the reading would then be an interpolated value near either end.
 * Blurring first and letting the transition settle gives the resting token.
 */
export async function restingInputBackground(page, selector) {
  await page.locator(selector).blur();
  await page.waitForTimeout(250);
  return page.locator(selector).evaluate((element) => getComputedStyle(element).backgroundColor);
}
