/**
 * Who owns the page the operator watches: its viewport, and its navigation.
 *
 * Chromium 153 and 154 do not answer the viewport question the same way, and that
 * difference is the whole bug: until 153 an override outlived the session that set
 * it, and from 154 it belongs to that session and dies with it. A panel that posed
 * its own override therefore lost the operator's resolution the moment the
 * operator closed the tab, which is exactly the case the pane exists for: acting
 * with the viewer closed, then reopening and finding the state intact.
 *
 * The fix is ownership, not a workaround: the gateway holds one connection to the
 * debug port for its whole life, poses the override on a session it never
 * detaches, and the panel asks it to. Nothing the panel does can clear the
 * viewport afterwards, because the panel no longer has a session of its own.
 *
 * The same hold drives the page: the panel's address bar navigates through here
 * rather than through a channel of its own, so the panel stays a viewer and the
 * gateway stays the only client of that browser besides the agent.
 *
 * What was measured on the pinned browser (Chromium 154.0.8037.57) before this
 * file was written, and what the tests below replay against a fake engine:
 *
 * - an override dies with the session that posed it. A session that only
 *   attaches and detaches leaves another session's override alone;
 * - a session that poses replaces the override for the whole page, whichever
 *   session posed before, and its detach leaves the page at the window size;
 * - Playwright does not re-send an override it already sent, so re-asserting a
 *   size means sending the protocol call again, never calling setViewportSize.
 *
 * The last point is why the viewport calls below go through a CDP session rather
 * than through `page.setViewportSize`: the panel's Apply button has to work the
 * second time the operator presses it with the same numbers.
 */

import { createRequire } from "node:module";
import { clampViewport, deviceMetricsParams } from "./panel.mjs";

/**
 * Where playwright-core is looked for.
 *
 * The image ships the runtime's own copy, and that is deliberate: it is the one
 * version this browser and this runtime are known to work with, it is already
 * pinned by the image's version bump, and it costs nothing to add. The Dockerfile
 * asserts the path exists, so a runtime that moves it fails the build rather than
 * the panel at runtime. The bare name is the fallback for a checkout where
 * playwright-core is installed next to the gateway.
 */
export const PLAYWRIGHT_CANDIDATES = [
  "/opt/zcodium/agent/node_modules/playwright-core",
  "playwright-core",
];

/** How long one protocol call may take before it is treated as a failure. */
export const VIEWPORT_CALL_TIMEOUT_MS = 10_000;

/**
 * The Playwright engine, from the first candidate that loads.
 *
 * It answers the chromium object itself, not the module that carries it, because
 * that is what a caller poses a viewport with: a module would make
 * `connectOverCDP` undefined, which is a failure the end to end suite catches and
 * no unit test of this function alone would.
 *
 * `load` and `candidates` are parameters so the tests can drive this without a
 * browser and without a node_modules tree.
 */
export function resolvePlaywright({
  candidates = PLAYWRIGHT_CANDIDATES,
  load = (id) => createRequire(import.meta.url)(id),
} = {}) {
  const failures = [];
  for (const candidate of candidates) {
    try {
      const loaded = load(candidate);
      if (loaded && loaded.chromium) {
        return loaded.chromium;
      }
      failures.push(`${candidate}: no chromium export`);
    } catch (error) {
      failures.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(`playwright-core could not be loaded (${failures.join("; ")})`);
}

/** A promise that rejects instead of hanging when the browser stops answering. */
function withTimeout(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** A host, with an optional port and path: what an address bar is given without a scheme. */
const BARE_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\]|[^\s/?#:]+\.[^\s/?#:]+)(?::\d+)?(?:[/?#].*)?$/;

/**
 * What was typed in the address bar, as an absolute http or https URL, or null.
 *
 * A bare host is what people type in an address bar, so `trip.com` becomes
 * `https://trip.com` and a loopback address becomes `http://`, which is the only
 * scheme that ever serves it. Everything else without a scheme is refused rather
 * than guessed.
 *
 * Only http and https are accepted, where the desktop pane also takes file, data
 * and about. That is deliberate here: a data page or a file from the container,
 * rendered inside the panel, is indistinguishable from a site, and whoever holds
 * a session already reaches both through the agent, where it leaves a trace.
 */
export function absoluteHttpUrl(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim();
  if (value === "") {
    return null;
  }
  let candidate = null;
  if (/^https?:\/\//i.test(value)) {
    candidate = value;
  } else if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) && BARE_HOST.test(value)) {
    candidate = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::|$)/.test(value) ? `http://${value}` : `https://${value}`;
  }
  if (candidate === null) {
    return null;
  }
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    if (url.hostname === "") {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The viewport owner.
 *
 * It connects lazily: a container whose operator never opens the panel never
 * opens a connection at all. One connection, one session per page, and the
 * session that poses an override is kept for the life of the gateway, which is
 * what makes the resolution survive the viewer closing.
 */
export function createPageOwner({
  debugUrl,
  engine = null,
  load = resolvePlaywright,
  logger = () => {},
  timeoutMs = VIEWPORT_CALL_TIMEOUT_MS,
} = {}) {
  if (typeof debugUrl !== "string" || debugUrl.trim() === "") {
    throw new Error("createPageOwner requires a debugUrl");
  }

  let connection = null;
  /** page → { targetId, session }: one session per page, never detached. */
  const entries = new Map();
  /** targetId → { width, height }: what the operator asked this page to be. */
  const desired = new Map();

  async function connect() {
    if (connection) {
      return connection;
    }
    const chromium = engine ?? load({});
    const browser = await withTimeout(chromium.connectOverCDP(debugUrl), timeoutMs, "connectOverCDP");
    const context = browser.contexts()[0] ?? (await withTimeout(browser.newContext(), timeoutMs, "newContext"));
    connection = { browser, context };
    logger(`[viewport] watching the browser on ${debugUrl}`);
    return connection;
  }

  /** Forgets pages that are gone, so a closed tab cannot pin a stale session. */
  function prune() {
    for (const page of [...entries.keys()]) {
      if (page.isClosed()) {
        entries.delete(page);
      }
    }
  }

  /**
   * The page behind a debug target id.
   *
   * The id the panel selects with is Chromium's own, and Playwright does not put
   * it on its Page object, so it is asked to the page itself: Target.getTargetInfo
   * on a session of that page answers it. The session is kept and reused, which is
   * what makes it the owner's session rather than another one that comes and goes.
   */
  async function entryFor(targetId) {
    const { context } = await connect();
    prune();
    for (const page of context.pages()) {
      let entry = entries.get(page);
      if (!entry) {
        const session = await withTimeout(context.newCDPSession(page), timeoutMs, "newCDPSession");
        const info = await withTimeout(session.send("Target.getTargetInfo"), timeoutMs, "Target.getTargetInfo");
        entry = { targetId: info?.targetInfo?.targetId ?? null, session };
        entries.set(page, entry);
      }
      if (entry.targetId === targetId) {
        return { page, ...entry };
      }
    }
    return null;
  }

  /** What the page reports right now, as "WxH". */
  async function reportedOn(page) {
    const size = await withTimeout(page.evaluate(() => `${innerWidth}x${innerHeight}`), timeoutMs, "reading the page size");
    return typeof size === "string" ? size : null;
  }

  async function reportedFor(targetId) {
    const entry = await entryFor(targetId);
    if (!entry) {
      return null;
    }
    return reportedOn(entry.page);
  }

  /**
   * Poses the operator's viewport on a target.
   *
   * The protocol call is sent every time, unchanged numbers included: an override
   * can be replaced or cleared by anything else talking to the same browser, and
   * re-asserting it is the only way back. This is the call that has to survive the
   * panel closing, and it does, because it is sent on this module's session.
   */
  async function apply({ targetId, width, height } = {}) {
    const viewport = clampViewport({ width, height });
    const entry = await entryFor(targetId);
    if (!entry) {
      throw new Error("no page target to pose a viewport on");
    }
    await withTimeout(
      entry.session.send("Emulation.setDeviceMetricsOverride", deviceMetricsParams(viewport)),
      timeoutMs,
      "Emulation.setDeviceMetricsOverride",
    );
    desired.set(targetId, viewport);
    const reported = await reportedOn(entry.page).catch(() => null);
    return { ...viewport, reported };
  }

  /**
   * Called when the panel opens on a target.
   *
   * A page whose resolution the operator already chose is put back to it if it
   * drifted, and left alone otherwise: opening the viewer must not disturb a page
   * nobody has resized, which is what the end to end suite asserts. What can make
   * it drift is another session posing an override of its own and then detaching,
   * the agent's tooling included, and this is the one moment where restoring the
   * operator's choice is what they expect.
   */
  async function attach({ targetId } = {}) {
    const saved = desired.get(targetId);
    const entry = await entryFor(targetId);
    if (!saved || !entry) {
      return { restored: false, targetId: targetId ?? null, reported: entry ? await reportedOn(entry.page).catch(() => null) : null };
    }
    const current = await reportedOn(entry.page).catch(() => null);
    const wanted = `${saved.width}x${saved.height}`;
    if (current === wanted) {
      return { restored: false, ...saved, reported: current };
    }
    await withTimeout(
      entry.session.send("Emulation.setDeviceMetricsOverride", deviceMetricsParams(saved)),
      timeoutMs,
      "Emulation.setDeviceMetricsOverride",
    );
    const reported = await reportedOn(entry.page).catch(() => null);
    logger(`[viewport] restored ${wanted} on a page that had drifted to ${current}`);
    return { restored: true, ...saved, reported };
  }

  /**
   * Stops forcing a size on a target, without touching the page.
   *
   * Used when the panel moves to another target: the page keeps the size it has,
   * the same way a page the operator never resized does, but a later attach will
   * not put the old numbers back on it.
   */
  function release({ targetId } = {}) {
    const had = desired.delete(targetId);
    return { released: had };
  }

  /**
   * Navigates the page, from the panel's address bar.
   *
   * The same session that owns the viewport owns the navigation, for the same
   * reason: the panel has no channel of its own to the browser, so there is one
   * place where "what the page is" is decided, and it is this one.
   */
  async function navigate({ targetId, url } = {}) {
    const wanted = absoluteHttpUrl(url);
    if (wanted === null) {
      throw new Error("only http and https addresses can be opened in the panel");
    }
    const entry = await entryFor(targetId);
    if (!entry) {
      throw new Error("no page target to navigate");
    }
    await withTimeout(entry.page.goto(wanted, { waitUntil: "domcontentloaded" }), timeoutMs, "navigating");
    return { url: wanted, reported: await reportedOn(entry.page).catch(() => null) };
  }

  /**
   * Back, forward and reload.
   *
   * Playwright answers null from goBack and goForward when there is nowhere to go,
   * which is not an error: the panel greys those buttons out from what the page
   * reports, and a race between the two is not worth a failure message.
   */
  async function history({ targetId, direction } = {}) {
    const entry = await entryFor(targetId);
    if (!entry) {
      throw new Error("no page target to move");
    }
    if (direction === "back") {
      await withTimeout(entry.page.goBack({ waitUntil: "domcontentloaded" }), timeoutMs, "going back");
    } else if (direction === "forward") {
      await withTimeout(entry.page.goForward({ waitUntil: "domcontentloaded" }), timeoutMs, "going forward");
    } else if (direction === "reload") {
      await withTimeout(entry.page.reload({ waitUntil: "domcontentloaded" }), timeoutMs, "reloading");
    } else {
      throw new Error(`unknown history direction: ${JSON.stringify(direction)}`);
    }
    return { url: entry.page.url() || null, reported: await reportedOn(entry.page).catch(() => null) };
  }

  function state() {
    return {
      connected: Boolean(connection),
      desired: [...desired.entries()].map(([targetId, viewport]) => ({ targetId, ...viewport })),
    };
  }

  async function close() {
    const open = connection;
    connection = null;
    entries.clear();
    desired.clear();
    if (!open) {
      return;
    }
    // connectOverCDP does not own the browser: closing the connection detaches
    // from it and leaves Chromium running, which is what the runtime needs.
    await open.browser.close().catch((error) => logger(`[viewport] closing the connection failed: ${error.message}`));
  }

  return { apply, attach, release, navigate, history, state, close, connect };
}
