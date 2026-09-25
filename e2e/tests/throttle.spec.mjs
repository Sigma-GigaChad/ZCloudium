/**
 * The failure limiter on the second factor, driven over HTTP.
 *
 * The unit test in tests/gateway.test.mjs proves the same property against a
 * gateway the suite starts itself. What this adds is the real container: the
 * limiter's key is the connecting socket address, and behind the Docker port
 * mapping that address is the bridge, so this is also the test that pins the
 * documented consequence (every client shares one budget, the block is global,
 * and the block is bounded).
 *
 * A request context, not the interface: eight wrong codes and their refusal take
 * a second here, where crossing the same threshold in the browser would spend
 * five minutes waiting for the block to end before the suite could go on.
 *
 * Ordering matters, and it is the reason this file is named so it sorts after the
 * others. A block is keyed on the address the container sees, and every client of
 * a published port shares that address, so this spec leaves the whole gateway
 * blocked for the rest of the five minutes. Anything that needs to sign in after
 * it would be refused, which is the documented behaviour and not a bug. The suite
 * that runs after this one has to start a fresh container, which is what both
 * run-e2e.sh and CI do.
 */

import { test, expect, request as playwrightRequest } from "@playwright/test";
import { ACCOUNT, noteUsedStep, readAccount } from "../lib/state.mjs";
import { nextUnusedCode, totpAt } from "../lib/totp.mjs";

/**
 * The budget the documentation advertises: eight failed attempts block the key.
 *
 * Spelled out rather than imported from the gateway: this suite drives the image
 * as a black box, and the number is part of what the image promises (README.md,
 * SECURITY.md). A gateway that stops blocking after eight failures, or blocks
 * earlier, fails here.
 */
const MAX_FAILURES = 8;

/** The alert the gateway renders when it refuses a throttled attempt. */
const REFUSED_STATUS = 429;

/** The password step, as a raw request. The pending cookie stays in the context. */
function submitPassword(api, password) {
  return api.post("/_auth/login", {
    form: { username: ACCOUNT.username, password },
    maxRedirects: 0,
  });
}

/**
 * The code step, as a raw request. The cookie the password step issued travels
 * through the context's own cookie jar, so the request is the one a real client
 * sends and nothing is copied by hand.
 */
function submitCode(api, code) {
  return api.post("/_auth/verify", { form: { code }, maxRedirects: 0 });
}

test.describe.configure({ mode: "serial" });

test("repeated failures at the second factor are refused, and the refusal covers a valid code", async ({
  baseURL,
}) => {
  test.setTimeout(120_000);
  const api = await playwrightRequest.newContext({ baseURL });
  try {
    const account = await readAccount();

    // A code from this helper is genuinely accepted, before anything is blocked.
    // That is what makes the refusal of the same kind of code below a refusal
    // rather than an expired or replayed step.
    const pending = await submitPassword(api, ACCOUNT.password);
    expect(pending.status()).toBe(303);
    const first = await nextUnusedCode(account.secret, { lastUsedStep: account.lastUsedStep });
    const accepted = await submitCode(api, first.code);
    expect(accepted.status(), "the helper's code must be accepted while nothing is blocked").toBe(303);
    await noteUsedStep(first.step);

    // The advertised budget of wrong codes: every one of them is still answered
    // as a rejected code.
    const rejected = [];
    await submitPassword(api, ACCOUNT.password);
    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      const response = await submitCode(api, "000000");
      rejected.push(response.status());
    }
    expect(rejected, `wrong code ${MAX_FAILURES} must still be answered as a rejection`).toEqual(
      Array(MAX_FAILURES).fill(401),
    );

    // The threshold is crossed: the next attempt is refused, not verified.
    const blocked = await submitCode(api, "000000");
    expect(blocked.status(), "the ninth attempt must be refused").toBe(REFUSED_STATUS);

    // And the refusal covers a code that would otherwise be accepted. The step is
    // one the server has not accepted yet, and the code is the one for the window
    // in progress, so nothing about it is stale: only the block refuses it.
    const current = await readAccount();
    const valid = await nextUnusedCode(account.secret, { lastUsedStep: current.lastUsedStep });
    expect(totpAt(account.secret).step).toBe(valid.step);
    const refused = await submitCode(api, valid.code);
    expect(refused.status(), "a valid code must be refused while the block holds").toBe(REFUSED_STATUS);

    // No session was issued by the refused attempt.
    const issued = refused
      .headersArray()
      .filter((header) => header.name.toLowerCase() === "set-cookie")
      .map((header) => header.value);
    expect(
      issued.some((value) => value.startsWith("zc_sess=")),
      `the refusal must not issue a session, it sent: ${issued.join(" | ") || "no cookie"}`,
    ).toBe(false);
  } finally {
    await api.dispose();
  }
});
