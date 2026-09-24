/**
 * The gateway itself: what it protects, what it lets through, and how it looks.
 *
 * These are the checks a plain HTTP probe cannot see. The existing smoke job
 * proves that /_auth/health answers; none of the following would be caught by it:
 * an application path served without a session, a session cookie that does not
 * authorise anything, or a WebSocket proxy that lets an anonymous client in.
 *
 * The session comes from the wizard spec (storage state), so nothing here signs
 * in: signing in is the job of session.spec.mjs, and it is the only spec that
 * spends TOTP windows.
 */

import { test, expect } from "@playwright/test";
import {
  expectApplication,
  expectSignInRequired,
  openSignInPage,
  restingInputBackground,
  sessionCookieHeader,
  submitCredentials,
} from "../lib/flows.mjs";
import { ACCOUNT, STORAGE_STATE } from "../lib/state.mjs";
import { EXPECTED_ACCEPT, WEBSOCKET_PATH, upgradeRequest } from "../lib/websocket.mjs";

const THEME = {
  background: "rgb(22, 22, 22)",
  panel: "rgb(32, 32, 32)",
  foreground: "rgb(229, 229, 229)",
  surface: "rgba(255, 255, 255, 0.05)",
};

/** A browser with no cookie at all: a visitor who has never signed in. */
test.describe("without a session", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("an application path is redirected to the sign in page", async ({ page, request }) => {
    // The redirect, as the server answers it, with the path the visitor wanted.
    const api = await request.get("/api/server-info", { maxRedirects: 0 });
    expect(api.status()).toBe(302);
    expect(api.headers()["location"]).toBe("/_auth/login?next=%2Fapi%2Fserver-info");

    const root = await request.get("/", { maxRedirects: 0 });
    expect(root.status()).toBe(302);
    expect(root.headers()["location"]).toBe("/_auth/login?next=%2F");

    // And in a browser, where the visitor ends up on the rendered page.
    await page.goto("/api/server-info");
    await expectSignInRequired(page);
  });

  test("the sign in and code pages wear the ZCode theme", async ({ page }) => {
    await openSignInPage(page);
    const login = await page.evaluate(() => {
      const read = (element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, color: style.color };
      };
      return {
        body: read(document.body),
        panel: read(document.querySelector("main")),
      };
    });
    expect(login.body.background).toBe(THEME.background);
    expect(login.body.color).toBe(THEME.foreground);
    expect(login.panel.background).toBe(THEME.panel);
    // The password field is the one the page does not focus on load.
    expect(await restingInputBackground(page, "#password")).toBe(THEME.surface);

    // The code page shares the same stylesheet, and is reached with the password
    // alone: no code is spent here, so the TOTP windows stay untouched.
    await submitCredentials(page, ACCOUNT);
    await expect(page).toHaveURL(/_auth\/verify$/);
    expect(await restingInputBackground(page, "#code")).toBe(THEME.surface);
    const codeColor = await page
      .locator("#code")
      .evaluate((element) => getComputedStyle(element).color);
    expect(codeColor).toBe(THEME.foreground);
  });

  test("a websocket upgrade is refused", async ({ page, baseURL }) => {
    // The HTTP answer, exactly: 401 before any upgrade, which is what the proxy
    // does and what no HTML check can observe.
    const refused = await upgradeRequest(baseURL, { path: WEBSOCKET_PATH });
    expect(refused.upgraded).toBe(false);
    expect(refused.status).toBe(401);

    // The same thing from the browser, where the interface would notice: the
    // connection never opens.
    const outcome = await page.evaluate((path) => {
      return new Promise((resolve) => {
        const socket = new WebSocket(`ws://${location.host}${path}`);
        socket.onopen = () => resolve("open");
        socket.onerror = () => resolve("error");
        socket.onclose = () => resolve("closed");
        setTimeout(() => resolve("timeout"), 10_000);
      });
    }, WEBSOCKET_PATH);
    expect(outcome).not.toBe("open");
  });
});

test.describe("with a session", () => {
  test.use({ storageState: STORAGE_STATE });

  test("an application path reaches the application", async ({ page, request }) => {
    const api = await request.get("/api/server-info");
    expect(api.status()).toBe(200);
    const info = await api.json();
    expect(typeof info.version).toBe("string");
    expect(info.workspaces[0].path).toBe("/workspace");

    await page.goto("/");
    await expectApplication(page);
  });

  test("a websocket upgrade is proxied through to the runtime", async ({ page, baseURL }) => {
    const cookie = await sessionCookieHeader(page.context());
    const accepted = await upgradeRequest(baseURL, { cookie, path: WEBSOCKET_PATH });
    expect(accepted.status).toBe(101);
    expect(accepted.upgraded).toBe(true);
    expect(accepted.headers["sec-websocket-accept"]).toBe(EXPECTED_ACCEPT);
  });
});
