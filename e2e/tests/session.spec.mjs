/**
 * Signing out and signing back in: the password, the code, and the two ways of
 * getting either of them wrong.
 *
 * Every test here starts with no cookie at all, which is the situation of
 * someone signing in: the browser session the wizard left behind is exercised in
 * gateway.spec.mjs instead.
 *
 * This is the only spec that spends TOTP windows, and the only one that changes
 * server state: every accepted code advances the account's last accepted step.
 * That is why the suite runs a single worker, and why the codes come from
 * lib/totp.mjs, written from RFC 4226 and RFC 6238 rather than from the
 * gateway's own generator.
 */

import { test, expect } from "@playwright/test";
import {
  expectApplication,
  expectRejected,
  expectSignInRequired,
  expectVerifyPage,
  openSignInPage,
  rejectionMessage,
  signInWithFreshCode,
  signOut,
  submitCode,
  submitCredentials,
  WRONG_CODE_MESSAGE,
  WRONG_PASSWORD_MESSAGE,
} from "../lib/flows.mjs";
import { ACCOUNT, noteUsedStep, readAccount } from "../lib/state.mjs";
import { totpAt } from "../lib/totp.mjs";

test.describe.configure({ mode: "serial", timeout: 120_000 });

// No cookie: the visitor who has to sign in.
test.use({ storageState: { cookies: [], origins: [] } });

/** No session was issued: the application stays out of reach. */
async function expectNoSession(page) {
  const attempt = await page.request.get("/api/server-info", { maxRedirects: 0 });
  expect(attempt.status()).toBe(302);
  expect(attempt.headers()["location"]).toContain("/_auth/login");
}

test("the wrong password is refused", async ({ page }) => {
  await openSignInPage(page);
  await submitCredentials(page, { username: ACCOUNT.username, password: "not-the-password" });

  await expectRejected(page, WRONG_PASSWORD_MESSAGE);
  await expect(page).toHaveURL(/_auth\/login$/);
  // The code step was never reached.
  await expect(page.getByLabel("Verification code")).toHaveCount(0);
  await expectNoSession(page);
});

test("the wrong code is refused, even with the right password", async ({ page }) => {
  await openSignInPage(page);
  await submitCredentials(page, ACCOUNT);
  await expectVerifyPage(page);

  await submitCode(page, "000000");

  await expectRejected(page, WRONG_CODE_MESSAGE);
  await expect(page).toHaveURL(/_auth\/verify$/);
  await expectNoSession(page);
});

test("signing out and signing back in, and the code that cannot be used twice", async ({ page }) => {
  const account = await readAccount();

  // Sign in, from nothing, with the password and a code the server has not seen.
  const first = await signInWithFreshCode(page, {
    username: ACCOUNT.username,
    password: ACCOUNT.password,
    secret: account.secret,
    lastUsedStep: account.lastUsedStep,
  });
  await expectApplication(page);
  await noteUsedStep(first.step);

  // The browser holds the session cookie the gateway issued, and no other.
  const cookies = await page.context().cookies();
  const session = cookies.find((cookie) => cookie.name === "zc_sess");
  expect(session).toBeTruthy();
  expect(session.httpOnly).toBe(true);
  expect(session.sameSite).toBe("Lax");

  // Sign out: the session ends, and the application is out of reach again.
  await signOut(page);
  await page.goto("/");
  await expectSignInRequired(page);
  await expectNoSession(page);

  // Sign back in with a second, fresh code.
  const second = await signInWithFreshCode(page, {
    username: ACCOUNT.username,
    password: ACCOUNT.password,
    secret: account.secret,
    lastUsedStep: first.step,
  });
  expect(second.step).toBeGreaterThan(first.step);
  await expectApplication(page);
  await noteUsedStep(second.step);

  // The same code again, in the same 30 second window: refused. The window has
  // not moved (the helper leaves at least 12 seconds of it), so this is replay
  // protection and not an expired code.
  expect(totpAt(account.secret).step).toBe(second.step);
  await signOut(page);
  await openSignInPage(page);
  await submitCredentials(page, ACCOUNT);
  await expectVerifyPage(page);
  await submitCode(page, second.code);

  await expect(page).toHaveURL(/_auth\/verify$/);
  expect(await rejectionMessage(page)).toBe(WRONG_CODE_MESSAGE);
  await expectNoSession(page);
});
