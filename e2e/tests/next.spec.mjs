/**
 * The `next` parameter, in a real browser.
 *
 * tests/gateway.test.mjs pins `safeNext` as a function, which is necessary and
 * not sufficient: what matters is what a browser does with the value, and the
 * browser is the only component whose URL rules count. A backslash is a slash for
 * a special scheme, a tab or a newline is stripped before the URL is parsed, and a
 * path that starts with two slashes is another host. None of that is visible to a
 * test that compares strings, which is why this file resolves the values with the
 * browser's own parser instead.
 *
 * Two layers, and they do not prove the same thing:
 *
 *   1. The value the sign in page hands to the browser always resolves on this
 *      origin. The page render is the only place the sanitiser is applied exactly
 *      once (the verify step applies it to its own previous result), so this is
 *      the layer that pins the sanitiser itself, and it is the one that fails
 *      against a gateway built before the sanitiser fixes. Eight of the nine
 *      values below were rendered verbatim by the gateway this branch replaces.
 *
 *   2. A crafted value submitted from the browser, followed to the end, leaves the
 *      browser on this origin, on the application at "/", and the answer the code
 *      step gave carries a Location that resolves there too. This is the end to end
 *      invariant. It is weaker than it looks on purpose: the code step applies the
 *      sanitiser a second time to its own result, so a sanitiser that returned a
 *      protocol relative path would still be caught by the page render above and
 *      not here. What it does catch is the value that survives both applications
 *      and still changes where the browser lands, which is what the gateway this
 *      branch replaces did.
 *
 * The crafted values, one per class of rewrite the URL specification allows:
 *   //evil.com         the plain protocol relative form, a control: the origin
 *                      test refused it even before the sanitiser was fixed.
 *   /..//evil.com      dot segment normalisation, which the fixed sanitiser
 *                      resolves to //evil.com before handing it over.
 *   /.//evil.com       the same class, one segment shorter.
 *   /%2e%2e//evil.com  the same class, percent encoded.
 *   /\evil.com         a raw backslash: a slash for a special scheme, so a
 *                      browser reads it as another host.
 *   /%5Cevil.com       the percent encoded backslash.
 *   /%2F%2Fevil.com    the percent encoded double slash.
 *   /\t/evil.com       a tab, stripped before the URL is parsed.
 *   /\n/evil.com       a newline, stripped the same way.
 *
 * This spec signs in, so it spends TOTP windows and records each step it used in
 * .auth/account.json. Its file name sorts before session.spec.mjs, and the suite
 * runs a single worker, which is what keeps the two specs from racing for a step.
 */

import { test, expect } from "@playwright/test";
import {
  expectApplication,
  expectVerifyPage,
  submitCode,
  submitCredentials,
} from "../lib/flows.mjs";
import { ACCOUNT, noteUsedStep, readAccount } from "../lib/state.mjs";
import { nextUnusedCode } from "../lib/totp.mjs";

// No cookie: a visitor who has to sign in.
test.use({ storageState: { cookies: [], origins: [] } });

const CRAFTED = [
  "//evil.com",
  "/..//evil.com",
  "/.//evil.com",
  "/%2e%2e//evil.com",
  "/\\evil.com",
  "/%5Cevil.com",
  "/%2F%2Fevil.com",
  "/\t/evil.com",
  "/\n/evil.com",
];

test("the sign in page never hands the browser a next that resolves off this origin", async ({
  page,
}) => {
  await page.goto("/_auth/login");
  const origin = await page.evaluate(() => location.origin);

  for (const value of CRAFTED) {
    await page.goto(`/_auth/login?next=${encodeURIComponent(value)}`);
    const field = page.locator('input[name="next"]');
    const rendered = await field.inputValue();
    // The browser resolves the rendered value with its own parser, against the
    // page it is on. That is the rule this whole family of defects abuses, and it
    // cannot be imitated in Node: a tab is stripped by the parser before anything
    // else happens, and a backslash is a slash for a special scheme.
    const resolved = await field.evaluate((element) => new URL(element.value, location.href).origin);
    expect(
      resolved,
      `next=${JSON.stringify(value)} was rendered as ${JSON.stringify(rendered)}, which this browser resolves to ${resolved}`,
    ).toBe(origin);
  }
});

for (const crafted of ["//evil.com", "/\\evil.com", "/..//evil.com", "/%5Cevil.com"]) {
  test(`signing in with next=${crafted} ends on the application, on this origin`, async ({
    page,
    baseURL,
  }) => {
    const origin = new URL(baseURL).origin;
    const account = await readAccount();

    // The page is asked for the crafted value, then the field is replaced by the
    // raw one: a crafted post does not have to use the value the page put there,
    // so the sanitiser has to hold on the submission and not only on the render.
    await page.goto(`/_auth/login?next=${encodeURIComponent(crafted)}`);
    await page.locator('input[name="next"]').evaluate((element, value) => {
      element.value = value;
    }, crafted);

    await submitCredentials(page, ACCOUNT);
    await expectVerifyPage(page);

    const { code, step } = await nextUnusedCode(account.secret, {
      lastUsedStep: account.lastUsedStep,
    });
    const [answer] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" && response.url().endsWith("/_auth/verify"),
      ),
      submitCode(page, code),
    ]);

    // The code was spent as soon as the gateway accepted it, whatever the browser
    // does next: recording the step here keeps a wrong landing from leaving the
    // account file behind and turning a later sign in into a replay.
    if (answer.status() === 303) {
      await noteUsedStep(step);
    }
    expect(answer.status(), `the code step answered ${answer.status()}`).toBe(303);

    // Where the code step sent the browser, asserted on the header itself so a
    // regression is reported by value and not as a navigation timeout.
    const location = answer.headers()["location"];
    expect(
      new URL(location, origin).origin,
      `the code step carried Location: ${location}`,
    ).toBe(origin);

    // And where the browser actually ended.
    await expectApplication(page);
    expect(new URL(page.url()).origin).toBe(origin);
  });
}
