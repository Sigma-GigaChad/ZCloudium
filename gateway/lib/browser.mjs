/**
 * The browser panel: Phase 0 of the plan in issue #5.
 *
 * The panel was going to be an application: a live view, a viewport control, an
 * element picker. Before writing it, this module makes the zero-code path
 * testable, because Chromium already serves its own DevTools frontend over HTTP
 * as soon as remote debugging is on:
 *
 *   - launch the container's Chromium headless, on loopback, with a debug port
 *     and a profile on the data volume (this module's launch arguments);
 *   - point the agent's MCP server at that browser instead of letting it launch
 *     its own, with a fallback to today's shape when the port does not answer
 *     (`resolveBrowserMode`, and `browserServerEntry` in mcp-config.mjs);
 *   - proxy the debug port behind the gateway, under `/_browser`, so an
 *     authenticated operator opens the real DevTools frontend against the
 *     agent's page (the route and rewriting helpers here).
 *
 * Nothing in this module knows about the application, and none of it is on
 * unless `ZCLOUDIUM_BROWSER_PANEL` asks for it.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

/** The Chromium installed in the image, the one the MCP server drives today. */
export const BROWSER_EXECUTABLE = "/usr/bin/chromium";

/** The debug endpoint. Loopback only: the gateway is the single way in. */
export const BROWSER_DEBUG_ADDRESS = "127.0.0.1";
export const BROWSER_DEBUG_PORT = 9222;

/** The gateway path the debug port is published under, behind the session. */
export const BROWSER_PREFIX = "/_browser";

/** The profile directory, created under the data volume so it survives a restart. */
export const BROWSER_PROFILE_NAME = "browser-profile";

/** How long Chromium is given to flush its profile before it is killed. */
export const BROWSER_STOP_GRACE_MS = 5_000;

/** How long the entrypoint waits for the debug port before falling back. */
export const BROWSER_PROBE_TIMEOUT_MS = 15_000;
export const BROWSER_PROBE_INTERVAL_MS = 250;

/** Values that turn a switch on. Anything else keeps the safe default. */
export const SWITCH_ON = ["on", "true", "1", "yes"];

export function browserProfileDir(dataDir, name = BROWSER_PROFILE_NAME) {
  return join(dataDir, name);
}

export function browserDebugUrl(port = BROWSER_DEBUG_PORT, host = BROWSER_DEBUG_ADDRESS) {
  return `http://${host}:${port}`;
}

/** The host:port pair Chromium advertises in its discovery documents. */
export function debugAuthority(port = BROWSER_DEBUG_PORT, host = BROWSER_DEBUG_ADDRESS) {
  return `${host}:${port}`;
}

/**
 * The launch arguments.
 *
 * `--headless`: the container has no display, and the operator's viewer is a
 *   browser of their own, not this one.
 * `--no-sandbox`: the profiles drop every capability and set no-new-privileges,
 *   so Chromium cannot use its setuid or namespace sandbox. SECURITY.md states
 *   the consequence.
 * `--disable-dev-shm-usage`: Docker gives /dev/shm 64 MB by default while the
 *   profiles mount a 512 MB tmpfs on /tmp, and a renderer that runs out of shm
 *   dies.
 * `--remote-debugging-address`: loopback. A debug port on 0.0.0.0 would hand the
 *   browser to anyone who can reach the container and bypass the gateway
 *   entirely, which is the one thing this design must not allow.
 * `--user-data-dir`: the profile lives on the data volume, so the agent's logins
 *   and cookies survive a container restart and nothing is written to the
 *   read-only root filesystem.
 */
export function browserArgs({ port = BROWSER_DEBUG_PORT, userDataDir, address = BROWSER_DEBUG_ADDRESS } = {}) {
  if (typeof userDataDir !== "string" || userDataDir.trim() === "") {
    throw new Error("browserArgs requires a userDataDir: without one Chromium writes to a read-only root filesystem");
  }
  return [
    "--headless",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=${address}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ];
}

/** Whether the panel was asked for. Off by default, and off on anything unclear. */
export function parseBrowserPanel(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return false;
  }
  return SWITCH_ON.includes(String(raw).trim().toLowerCase());
}

/** A TCP port, or the default. A typo must not produce a browser nobody can reach. */
export function parseBrowserDebugPort(raw, fallback = BROWSER_DEBUG_PORT) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const value = Number(String(raw).trim());
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : fallback;
}

/**
 * The fallback decision, and the whole point of Phase 0's plumbing: attach to
 * the browser the container launched when it is really there, and launch a
 * private one otherwise. An unreachable debug port must never keep the agent
 * from starting.
 */
export function resolveBrowserMode({ panelEnabled = false, debugUrl = null, reachable = false } = {}) {
  if (!panelEnabled || typeof debugUrl !== "string" || debugUrl === "" || !reachable) {
    return "launch";
  }
  return "attach";
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls the debug endpoint until it answers `/json/version`, or the deadline
 * passes. Chromium needs seconds to come up, and the entrypoint must not give up
 * before that, nor wait forever for a browser that will not start.
 */
export async function waitForBrowser({
  debugUrl,
  fetchImpl = fetch,
  timeoutMs = BROWSER_PROBE_TIMEOUT_MS,
  intervalMs = BROWSER_PROBE_INTERVAL_MS,
  sleep = defaultSleep,
} = {}) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${debugUrl}/json/version`);
      if (response?.ok) {
        const version = await response.json();
        return { reachable: true, version, attempts: attempt };
      }
    } catch {
      // Not up yet, or not there at all: the caller decides what that means.
    }
    if (attempt < attempts) {
      await sleep(intervalMs);
    }
  }
  return { reachable: false, attempts };
}

/** Spawns Chromium and reports its exit, so the entrypoint can say so in the logs. */
export function launchBrowser({
  args,
  env = process.env,
  executable = BROWSER_EXECUTABLE,
  spawnBrowser = (file, spawnArgs, options) => spawn(file, spawnArgs, options),
  logger = () => {},
  onExit = () => {},
} = {}) {
  logger(`[start] starting the browser: ${executable} ${args.join(" ")}`);
  const child = spawnBrowser(executable, args, { stdio: "inherit", env });
  child.on?.("exit", (code, signal) => onExit(code, signal));
  child.on?.("error", (error) => onExit(null, null, error));
  return child;
}

/**
 * Stops the browser cleanly: SIGTERM, and SIGKILL only if it is still there
 * after the grace period. The profile lives on the data volume and Chromium
 * flushes it on the way out, so the order matters.
 */
export function stopBrowser(child, { graceMs = BROWSER_STOP_GRACE_MS, logger = () => {}, timers = { setTimeout, clearTimeout } } = {}) {
  if (!child) {
    return Promise.resolve("no-browser");
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) {
        return;
      }
      settled = true;
      timers.clearTimeout(timer);
      resolve(outcome);
    };
    const timer = timers.setTimeout(() => {
      logger(`[start] the browser is still running after ${graceMs} ms, killing it`);
      try {
        child.kill("SIGKILL");
      } catch {
        // It went away between the deadline and the kill: nothing to report.
      }
      finish("killed");
    }, graceMs);
    child.once?.("exit", () => finish("terminated"));
    try {
      if (!child.kill("SIGTERM")) {
        finish("already-exited");
      }
    } catch {
      finish("already-exited");
    }
  });
}

/**
 * Route classification for the gateway.
 *
 * With the panel off there is no browser route at all: `/_browser/...` is
 * ordinary application traffic, which is what makes the off switch total.
 */
export function classifyRoute(pathname, { browserEnabled = false } = {}) {
  if (pathname === "/_auth" || pathname.startsWith("/_auth/")) {
    return "auth";
  }
  if (!browserEnabled) {
    return "app";
  }
  if (pathname === BROWSER_PREFIX || pathname.startsWith(`${BROWSER_PREFIX}/`)) {
    return "browser";
  }
  return "app";
}

/**
 * The path and query the debug endpoint is asked for: the proxy prefix is the
 * only part that is removed, everything else reaches Chromium as it was.
 *
 * The DevTools frontend is served from `/devtools/...` by Chromium itself, and
 * its own assets and imports are relative, so a stripped prefix is all the
 * rewriting it needs.
 */
export function debugPathFor(pathname, search = "") {
  const rest = pathname === BROWSER_PREFIX ? "" : pathname.slice(BROWSER_PREFIX.length);
  return rest === "" || rest === "/" ? `/${search}` : `${rest}${search}`;
}

/** The documents that carry URLs the frontend would otherwise resolve to loopback. */
export function isDiscoveryPath(pathname) {
  return pathname === "/json" || pathname === "/json/" || pathname === "/json/list" || pathname === "/json/version";
}

/**
 * Rewrites the discovery documents so the frontend connects back through the
 * gateway instead of trying 127.0.0.1:9222, which only works on the machine the
 * container runs on.
 *
 * A plain substitution, because that is the actual difference: the debug
 * authority appears in the JSON as `ws://127.0.0.1:9222/path` for
 * `webSocketDebuggerUrl` and as `ws=127.0.0.1:9222/path` inside the frontend
 * URLs. Both become `<proxy host>/_browser/path`, which is the same origin the
 * frontend was served from, and therefore allowed by the frontend's own
 * `connect-src 'self'`.
 */
export function rewriteDiscovery(body, { authority, proxyAuthority } = {}) {
  if (typeof body !== "string" || typeof authority !== "string" || authority === "" || typeof proxyAuthority !== "string") {
    return body;
  }
  return body.split(authority).join(proxyAuthority);
}

/** The Host header, as an authority a URL may be built from, or null. */
export function proxyAuthorityFor(host, prefix = BROWSER_PREFIX) {
  if (typeof host !== "string") {
    return null;
  }
  const value = host.trim();
  // Hostnames, IPv4, ports, and the bracketed IPv6 form. Anything else (a slash,
  // whitespace, a userinfo section) could not only produce a broken URL but also
  // inject into the document the frontend reads, so it is refused.
  if (!/^[A-Za-z0-9._-]+(:\d+)?$/.test(value) && !/^\[[0-9A-Fa-f:]+\](:\d+)?$/.test(value)) {
    return null;
  }
  return `${value}${prefix}`;
}
