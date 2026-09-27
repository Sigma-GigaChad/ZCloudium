/**
 * The browser panel, end to end, against a real container.
 *
 * Phase 0's reviewer noted that the suite started no panel container, so the
 * image level wiring of the panel was guarded by a report and nothing else. This
 * spec closes that: it exercises the panel the way the operator does, against the
 * image, and it skips with a reason when the container it was pointed at has the
 * panel off (which is the default, and is what the panel off run of the suite
 * covers: with the switch off nothing observable changes).
 *
 * The three things asserted here are the ones the brief asks for:
 *
 *   1. the panel requires a session, exactly like the rest of the gateway,
 *      including the WebSocket upgrade that carries the control channel;
 *   2. the viewport control changes what the page reports, measured from the
 *      page itself over CDP and not from the panel's own text;
 *   3. detaching and reattaching finds the same state: the point of the whole
 *      feature is acting with the viewer closed, then reopening and seeing the
 *      state intact, which is what the last spec measures (the same document,
 *      the same typed text, the same emulated viewport).
 *
 * The page the panel drives is written into the browser the container launched,
 * through CDP, so the suite never depends on a page the application happens to
 * serve. Nothing here patches the application.
 */

import { test, expect } from "@playwright/test";
import { cdpCall, cdpEvaluate, listPanelTargets } from "../lib/cdp.mjs";
import { STORAGE_STATE } from "../lib/state.mjs";
import { upgradeRequest } from "../lib/websocket.mjs";

/** The page the panel shows: it reports what only the page can report. */
const FIXTURE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Panel fixture</title></head>
<body style="font-family: system-ui, sans-serif; margin: 16px">
<h1 id="heading">Panel fixture</h1>
<p>viewport: <b id="size">?</b></p>
<p>typed: <b id="typedmirror">(nothing)</b></p>
<p>clicks: <b id="clicks">0</b></p>
<input id="typed" placeholder="type here">
<button id="target" type="button">Pick me</button>
<div id="tall" style="height: 2400px; background: repeating-linear-gradient(#f4f4f4, #f4f4f4 40px, #dcdcdc 40px, #dcdcdc 80px)">tall block</div>
<script>
function report() {
  document.getElementById("size").textContent = innerWidth + "x" + innerHeight + " dpr=" + devicePixelRatio;
}
report();
addEventListener("resize", report);
document.getElementById("typed").addEventListener("input", (event) => {
  document.getElementById("typedmirror").textContent = event.target.value || "(nothing)";
  document.title = "typed: " + event.target.value;
});
document.getElementById("target").addEventListener("click", () => {
  const clicks = Number(document.getElementById("clicks").textContent) + 1;
  document.getElementById("clicks").textContent = String(clicks);
});
</script>
</body>
</html>`;

/**
 * Whether this container was started with the panel on. The check is the panel's
 * own discovery route: with the switch off, `/_browser/...` is ordinary
 * application traffic, and the application cannot answer with Chromium's target
 * list.
 */
async function panelTargetAvailable(page) {
  const response = await page.request.get("/_browser/json/list");
  if (response.status() !== 200) {
    return false;
  }
  try {
    return Array.isArray(await response.json());
  } catch {
    return false;
  }
}

/** Writes the fixture into the page target of the container's browser. */
async function installFixture(page) {
  // The CDP helpers run inside the browser, so the page driving them has to be
  // on the gateway's own origin first.
  await page.goto("/_auth/health");
  const targets = await listPanelTargets(page.request);
  expect(targets.length, "the container browser should have a page target").toBeGreaterThan(0);
  const target = targets[0];
  const frameTree = await cdpCall(page, { targetId: target.id, method: "Page.getFrameTree" });
  await cdpCall(page, {
    targetId: target.id,
    method: "Page.setDocumentContent",
    params: { frameId: frameTree.frameTree.frame.id, html: FIXTURE },
  });
  return target;
}

/** Waits until the panel has painted a frame, and returns what it says about it. */
async function waitForFrames(panel, minimum = 1, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = (await panel.locator("#picture").textContent()) ?? "";
    const frames = Number((text.match(/frames (\d+)/) ?? [])[1] ?? 0);
    const bitmap = await panel.locator("#screen").evaluate((canvas) => `${canvas.width}x${canvas.height}`);
    if (frames >= minimum && bitmap !== "0x0") {
      return { frames, bitmap, text };
    }
    await panel.waitForTimeout(150);
  }
  throw new Error(`the panel painted no frame within ${timeoutMs} ms`);
}

/** Applies a viewport from the panel's fields, the way the operator does. */
async function applyViewport(panel, width, height) {
  await panel.locator("#width").fill(String(width));
  await panel.locator("#height").fill(String(height));
  await panel.locator("#apply").click();
  await expect(panel.locator("#reported")).toContainText(`page reports ${width}x${height}`);
}

/**
 * The container's own gateway, as the container's browser sees it.
 *
 * The published port varies (the suite is pointed at it through E2E_BASE_URL), but
 * inside the container the gateway is always on 3030: the image exposes it, the
 * healthcheck probes it, and both compose files publish it. These two pages are
 * used as navigation targets because they are served by the gateway itself, so the
 * navigation test depends on no outside network at all.
 */
const CONTAINER_GATEWAY = "https://127.0.0.1:3030";
const HEALTH_PAGE = `${CONTAINER_GATEWAY}/_auth/health`;
const LOGIN_PAGE = `${CONTAINER_GATEWAY}/_auth/login`;

test.describe("the browser panel", () => {
  test.describe("without a session", () => {
    test("every panel path is refused, including the WebSocket the panel needs", async ({ browser, baseURL }) => {
      // A context of its own, with no cookies at all: a visitor who never signed in.
      const anonymous = await browser.newContext({ baseURL });
      const page = await anonymous.newPage();
      try {
        for (const path of ["/_browser/", "/_browser", "/_browser/json/list", "/_browser/devtools/inspector.html"]) {
          const response = await page.request.get(path, { maxRedirects: 0 });
          expect(response.status(), path).toBe(302);
          expect(response.headers()["location"], path).toBe(`/_auth/login?next=${encodeURIComponent(path)}`);
          const body = await response.text();
          expect(body, `${path} must leak nothing before authentication`).not.toMatch(/Page\.startScreencast|webSocketDebuggerUrl/);
        }
        // The control channel is a WebSocket, and it is refused before any upgrade.
        const refused = await upgradeRequest(baseURL, { path: "/_browser/devtools/page/0000000000000000000000000000" });
        expect(refused.upgraded).toBe(false);
        expect(refused.status).toBe(401);
      } finally {
        await anonymous.close();
      }
    });
  });

  test.describe("with a session", () => {
    test.use({ storageState: STORAGE_STATE });

    test("the panel is served, behind the session, and is not the application", async ({ page }) => {
      test.skip(!(await panelTargetAvailable(page)), "this container runs without the browser panel (start it with E2E_PANEL=on)");

      const response = await page.request.get("/_browser/");
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toMatch(/text\/html/);
      const body = await response.text();
      expect(body).toMatch(/Page\.startScreencast/);
      expect(body).toMatch(/Shared with the agent/);

      await page.goto("/_browser/");
      await expect(page.getByText("Shared with the agent")).toBeVisible();
      await expect(page.locator("#screen")).toBeVisible();
      await expect(page.locator("#status")).toHaveText("connected", { timeout: 20_000 });
    });

    test("the viewport control changes what the page reports, and the picture follows", async ({ page }) => {
      test.skip(!(await panelTargetAvailable(page)), "this container runs without the browser panel (start it with E2E_PANEL=on)");

      const target = await installFixture(page);
      const before = await cdpEvaluate(page, { targetId: target.id, expression: "innerWidth + 'x' + innerHeight" });

      const panel = await page.context().newPage();
      await panel.goto("/_browser/");
      await expect(panel.locator("#status")).toHaveText("connected", { timeout: 20_000 });
      const firstFrames = await waitForFrames(panel, 1);
      // The panel adopts the size the page is already at: opening it disturbs nothing.
      expect(await panel.locator("#width").inputValue()).toBe(before.split("x")[0]);
      expect(await cdpEvaluate(page, { targetId: target.id, expression: "innerWidth + 'x' + innerHeight" })).toBe(before);

      await applyViewport(panel, 640, 480);
      // What the page reports, read from the page, not from the panel.
      expect(await cdpEvaluate(page, { targetId: target.id, expression: "innerWidth + 'x' + innerHeight" })).toBe("640x480");
      expect(await cdpEvaluate(page, { targetId: target.id, expression: "document.getElementById('size').textContent" })).toBe("640x480 dpr=1");
      expect(await cdpEvaluate(page, { targetId: target.id, expression: "String(matchMedia('(max-width: 700px)').matches)" })).toBe("true");
      // And the picture is of that page: the frame is the emulated size, and the
      // stream produced another frame for the layout change.
      const afterResize = await waitForFrames(panel, firstFrames.frames + 1);
      expect(afterResize.bitmap).toBe("640x480");
      await expect(panel.locator("#picture")).toContainText("640x480");
      await panel.close();
    });

    test("acting with the viewer closed, then reopening, finds the state intact", async ({ page }) => {
      test.skip(!(await panelTargetAvailable(page)), "this container runs without the browser panel (start it with E2E_PANEL=on)");

      const target = await installFixture(page);
      const panel = await page.context().newPage();
      await panel.goto("/_browser/");
      await expect(panel.locator("#status")).toHaveText("connected", { timeout: 20_000 });
      await waitForFrames(panel, 1);
      await applyViewport(panel, 800, 600);
      // An operator looks at the picture before clicking it: the frame at the new
      // size is what the click is aimed with.
      await expect(panel.locator("#picture")).toContainText("800x600", { timeout: 15_000 });

      // The operator types into the page, through the panel, and the page sees it.
      const point = JSON.parse(
        await cdpEvaluate(page, {
          targetId: target.id,
          expression: "JSON.stringify((() => { const r = document.querySelector('#typed').getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })())",
        }),
      );
      const box = await panel.locator("#screen").boundingBox();
      await panel.mouse.click(box.x + (point.x / 800) * box.width, box.y + (point.y / 600) * box.height);
      await panel.keyboard.type("kept");
      await expect
        .poll(() => cdpEvaluate(page, { targetId: target.id, expression: "document.getElementById('typed').value" }), { timeout: 15_000 })
        .toBe("kept");

      const beforeClose = JSON.parse(
        await cdpEvaluate(page, {
          targetId: target.id,
          expression: "JSON.stringify({timeOrigin: performance.timeOrigin, size: innerWidth + 'x' + innerHeight, typed: document.getElementById('typed').value})",
        }),
      );
      const pictureBefore = await panel.locator("#screen").screenshot();
      await panel.close();

      // With the viewer closed: a real key press and a real change, through CDP.
      await cdpCall(page, { targetId: target.id, method: "Runtime.evaluate", params: { expression: "document.getElementById('typed').focus(); 'ok'" } });
      for (const command of [
        { type: "rawKeyDown", key: "K", code: "KeyK", windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75, modifiers: 8 },
        { type: "char", text: "K", key: "K", modifiers: 8 },
        { type: "keyUp", key: "K", code: "KeyK", windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75, modifiers: 8 },
      ]) {
        await cdpCall(page, { targetId: target.id, method: "Input.dispatchKeyEvent", params: command });
      }
      await cdpCall(page, {
        targetId: target.id,
        method: "Runtime.evaluate",
        params: { expression: "document.getElementById('heading').textContent = 'changed while the panel was closed'; 'ok'" },
      });
      const withPanelClosed = JSON.parse(
        await cdpEvaluate(page, {
          targetId: target.id,
          expression: "JSON.stringify({timeOrigin: performance.timeOrigin, size: innerWidth + 'x' + innerHeight, typed: document.getElementById('typed').value, heading: document.getElementById('heading').textContent})",
        }),
      );
      // Nothing reloaded while nobody was watching.
      expect(withPanelClosed.timeOrigin).toBe(beforeClose.timeOrigin);
      expect(withPanelClosed.typed).toBe("keptK");

      const reopened = await page.context().newPage();
      await reopened.goto("/_browser/");
      await expect(reopened.locator("#status")).toHaveText("connected", { timeout: 20_000 });
      const frames = await waitForFrames(reopened, 1);

      // The same document, the same typed text, the same emulated viewport, and
      // a picture that shows the change made while the panel was closed.
      const afterReopen = JSON.parse(
        await cdpEvaluate(page, {
          targetId: target.id,
          expression: "JSON.stringify({timeOrigin: performance.timeOrigin, size: innerWidth + 'x' + innerHeight, typed: document.getElementById('typed').value, heading: document.getElementById('heading').textContent})",
        }),
      );
      expect(afterReopen).toEqual(withPanelClosed);
      expect(afterReopen.size).toBe("800x600");
      expect(afterReopen.heading).toBe("changed while the panel was closed");
      expect(frames.bitmap).toBe("800x600");
      expect(await reopened.locator("#width").inputValue()).toBe("800");
      expect(await reopened.locator("#height").inputValue()).toBe("600");
      // The picture is not the one that was on screen before the detach.
      const pictureAfter = await reopened.locator("#screen").screenshot();
      expect(Buffer.compare(pictureBefore, pictureAfter)).not.toBe(0);
      await reopened.close();
    });

    test("the address bar navigates the page, and the history buttons move it", async ({ page }) => {
      test.skip(!(await panelTargetAvailable(page)), "this container runs without the browser panel (start it with E2E_PANEL=on)");

      const target = await installFixture(page);
      const panel = await page.context().newPage();
      await panel.goto("/_browser/");
      await expect(panel.locator("#status")).toHaveText("connected", { timeout: 20_000 });
      await waitForFrames(panel, 1);

      // The address bar is the only way in: type, Enter, and the page the panel
      // shows is that page. Measured from the page itself, over CDP.
      await panel.locator("#address").fill(HEALTH_PAGE);
      await panel.locator("#address").press("Enter");
      await expect
        .poll(() => cdpEvaluate(page, { targetId: target.id, expression: "location.href" }), { timeout: 15_000 })
        .toBe(HEALTH_PAGE);
      // The body is not read back on purpose: the gateway serves https with a
      // certificate it generated itself, and the container's Chromium shows its
      // warning page instead of the body. The address is what the navigation
      // proves, and the history assertions below use it the same way.
      await expect(panel.locator("#address")).toHaveValue(HEALTH_PAGE);

      // A second page, so there is somewhere to go back to and forward from.
      await panel.locator("#address").fill(LOGIN_PAGE);
      await panel.locator("#address").press("Enter");
      await expect
        .poll(() => cdpEvaluate(page, { targetId: target.id, expression: "location.href" }), { timeout: 15_000 })
        .toBe(LOGIN_PAGE);

      await panel.locator("#back").click();
      await expect
        .poll(() => cdpEvaluate(page, { targetId: target.id, expression: "location.href" }), { timeout: 15_000 })
        .toBe(HEALTH_PAGE);
      await panel.locator("#forward").click();
      await expect
        .poll(() => cdpEvaluate(page, { targetId: target.id, expression: "location.href" }), { timeout: 15_000 })
        .toBe(LOGIN_PAGE);

      // Reload is a real reload: the same address, a new document.
      const before = await cdpEvaluate(page, { targetId: target.id, expression: "String(performance.timeOrigin)" });
      await panel.locator("#reload").click();
      await expect
        .poll(() => cdpEvaluate(page, { targetId: target.id, expression: "String(performance.timeOrigin)" }), { timeout: 15_000 })
        .not.toBe(before);
      expect(await cdpEvaluate(page, { targetId: target.id, expression: "location.href" })).toBe(LOGIN_PAGE);
      await panel.close();
    });

    test("the DevTools button opens the proxied frontend on this target", async ({ page }) => {
      test.skip(!(await panelTargetAvailable(page)), "this container runs without the browser panel (start it with E2E_PANEL=on)");

      const target = await installFixture(page);
      const panel = await page.context().newPage();
      await panel.goto("/_browser/");
      await expect(panel.locator("#status")).toHaveText("connected", { timeout: 20_000 });
      const href = await panel.locator("#devtools").getAttribute("href");
      expect(href).toContain("/_browser/devtools/inspector.html?ws=");
      expect(href).toContain(`/_browser/devtools/page/${target.id}`);
      expect(href, "the frontend must be reached through this gateway").not.toContain("appspot.com");

      const devtools = await page.context().newPage();
      await devtools.goto(href);
      // The Elements panel renders the fixture's own markup. DevTools builds its
      // UI inside shadow roots and separates tokens with zero width spaces, so a
      // document level query sees nothing and a substring of the markup does not
      // match: the check is the fixture's visible text, through a locator that
      // pierces shadow DOM.
      await expect(devtools.getByText("Panel fixture", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
      await devtools.close();
      await panel.close();
    });
  });
});
