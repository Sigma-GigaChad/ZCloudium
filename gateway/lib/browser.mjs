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
 * Nothing in this module knows about the application. All of it is on by
 * default, and `ZCLOUDIUM_BROWSER_PANEL=off` is what restores the shape the image
 * shipped before this module existed.
 */

import { spawn } from "node:child_process";
import { readlink, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { PANEL_PREFIX } from "./panel.mjs";

/** The Chromium installed in the image, the one the MCP server drives today. */
export const BROWSER_EXECUTABLE = "/usr/bin/chromium";

/** The debug endpoint. Loopback only: the gateway is the single way in. */
export const BROWSER_DEBUG_ADDRESS = "127.0.0.1";
export const BROWSER_DEBUG_PORT = 9222;

/** The gateway path the debug port is published under, behind the session. */
export const BROWSER_PREFIX = "/_browser";

/**
 * Where the panel asks the gateway to pose a viewport (issue #9).
 *
 * It sits under the browser prefix, next to the panel, and it is the gateway's
 * own path rather than the debug port's: the resolution is posed by the gateway's
 * long lived session, which is what makes it survive the panel closing.
 */
export const VIEWPORT_PATH = `${BROWSER_PREFIX}/viewport`;

/** The profile directory, created under the data volume so it survives a restart. */
export const BROWSER_PROFILE_NAME = "browser-profile";

/** How long Chromium is given to flush its profile before it is killed. */
export const BROWSER_STOP_GRACE_MS = 5_000;

/** How long the entrypoint waits for the debug port before falling back. */
export const BROWSER_PROBE_TIMEOUT_MS = 15_000;
export const BROWSER_PROBE_INTERVAL_MS = 250;

/** Values that turn a switch on. Anything else keeps the safe default. */
export const SWITCH_ON = ["on", "true", "1", "yes"];

/** Values that turn off a switch whose default is on. */
export const SWITCH_OFF = ["off", "false", "0", "no", "disabled"];

export function browserProfileDir(dataDir, name = BROWSER_PROFILE_NAME) {
  return join(dataDir, name);
}

export function browserDebugUrl(port = BROWSER_DEBUG_PORT, host = BROWSER_DEBUG_ADDRESS) {
  return `http://${host}:${port}`;
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

/**
 * Whether the browser panel runs.
 *
 * On unless it is explicitly turned off. That is the position the tool was asked
 * for: the browser the agent drives, and the panel that watches it, are the point
 * of the web build rather than an option, and a deployment that wants the
 * previous shape says so with one environment variable. An unclear value keeps the
 * default, the same way the browser MCP switch does, so a typo cannot silently
 * take the feature away.
 */
export function parseBrowserPanel(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return true;
  }
  return !SWITCH_OFF.includes(String(raw).trim().toLowerCase());
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

/**
 * Chromium's profile lock, which is a symlink named `<hostname>-<pid>`, plus the
 * two files it creates next to it.
 */
export const SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

/**
 * Whether a `SingletonLock` was left by another container.
 *
 * Chromium refuses to start when the lock names a machine it is not, because it
 * cannot check whether that process is alive. A container that was killed rather
 * than stopped leaves exactly that in the data volume, and the next start then
 * falls back to the browser the agent launches itself, with the panel silently
 * off. When the lock names this machine, Chromium can check for itself and is
 * left to do it.
 */
export function isStaleSingletonLock(linkTarget, { hostname: current = hostname() } = {}) {
  if (typeof linkTarget !== "string") {
    return false;
  }
  const match = linkTarget.match(/^(.*)-(\d+)$/);
  if (!match) {
    return false;
  }
  return match[1] !== current;
}

/**
 * Releases a stale profile lock before the browser starts.
 *
 * Only the three files Chromium itself names are ever removed, and only when the
 * lock points at another machine. The profile content, which holds the agent's
 * logins, is untouched.
 */
export async function prepareBrowserProfile(
  userDataDir,
  { hostname: current = hostname(), readlinkFn = readlink, removeFn = (path) => rm(path, { force: true }), logger = () => {} } = {},
) {
  let target;
  try {
    target = await readlinkFn(join(userDataDir, "SingletonLock"));
  } catch {
    // Nothing locked, no profile yet, or something that is not a symlink: none of
    // those is ours to clean up.
    return { status: "no-lock" };
  }
  if (!isStaleSingletonLock(target, { hostname: current })) {
    return { status: "kept", target };
  }
  for (const name of SINGLETON_FILES) {
    await removeFn(join(userDataDir, name));
  }
  logger(
    `[start] unlocked the browser profile: ${join(userDataDir, "SingletonLock")} was left by another container (${target})`,
  );
  return { status: "unlocked", target };
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
 *
 * With the panel on, the prefix root is the operator panel, which the gateway
 * serves itself (`panel.mjs`), and everything below it is proxied to the debug
 * port. The panel is a browser route too: it is behind the session, it carries
 * the same Origin rule, and it is the page that then opens the control channel.
 */
export function classifyRoute(pathname, { browserEnabled = false } = {}) {
  if (pathname === "/_auth" || pathname.startsWith("/_auth/")) {
    return "auth";
  }
  if (!browserEnabled) {
    return "app";
  }
  if (pathname === BROWSER_PREFIX || pathname === PANEL_PREFIX) {
    return "panel";
  }
  if (pathname === VIEWPORT_PATH) {
    return "viewport";
  }
  if (pathname.startsWith(`${BROWSER_PREFIX}/`)) {
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

/** The Host header as an authority a URL may be built from, or null. */
export function hostAuthority(host) {
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
  return value;
}

/** The gateway's own host and path, as it appears inside the rewritten documents. */
export function proxyAuthorityFor(host, prefix = BROWSER_PREFIX) {
  const authority = hostAuthority(host);
  return authority === null ? null : `${authority}${prefix}`;
}

/** The port an origin never spells out, per scheme. */
const DEFAULT_PORTS = { "http:": "80", "https:": "443" };

/**
 * One authority as an origin spells it: the host lower cased, and the port
 * dropped when it is the default for the scheme.
 *
 * Two spellings of one authority have to compare equal where origins are
 * compared, because a browser and a reverse proxy disagree about them all the
 * time. A browser lower cases the host in the `Origin` header and never writes a
 * port that is the scheme's default; a reverse proxy writes its `Host` header
 * from its own configuration, and `proxy_set_header Host $host:$server_port` on
 * an https server appends `:443`, which is the default for https and therefore
 * invisible in the origin the browser sends. Without this, the gateway computes
 * its own origin as a different string than its own frontend sends and refuses
 * that frontend with a 403, with the trust flag on or off.
 *
 * Anything that is not an authority (a path, a space, a userinfo section, a
 * newline) is still refused, by the same check as before: the value ends up in a
 * comparison against an origin.
 */
export function normalizeAuthority(authority, scheme = "http:") {
  const value = hostAuthority(authority);
  if (value === null) {
    return null;
  }
  let host = value;
  let port = null;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    host = value.slice(0, end + 1);
    port = value.slice(end + 2) || null;
  } else {
    const separator = value.indexOf(":");
    if (separator >= 0) {
      host = value.slice(0, separator);
      port = value.slice(separator + 1) || null;
    }
  }
  const lower = host.toLowerCase();
  return port === null || port === DEFAULT_PORTS[scheme] ? lower : `${lower}:${port}`;
}

/** A string that is exactly an origin, or null. Anything with a path is not one. */
function strictOrigin(value) {
  try {
    const parsed = new URL(value);
    return parsed.origin === value ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** The shape of an origin: a scheme, an authority, and nothing else but a tail. */
const ORIGIN_SHAPE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]+)([\s\S]*)$/;

/**
 * An origin normalised to the one spelling this comparison uses, or null when the
 * value is not an origin.
 *
 * The shape is checked after the normalisation rather than before it, so
 * `HTTP://Panel.Example:80` and `http://panel.example` are the same origin while a
 * path, a query, a fragment, a userinfo section or the opaque `null` is still
 * refused: what is left of the value after the scheme and the authority has to be
 * empty, and `strictOrigin` is what says so.
 */
function canonicalOrigin(value) {
  const match = ORIGIN_SHAPE.exec(value);
  if (!match) {
    return null;
  }
  const scheme = `${match[1].toLowerCase()}:`;
  if (scheme !== "http:" && scheme !== "https:") {
    return null;
  }
  const authority = normalizeAuthority(match[2], scheme);
  return authority === null ? null : strictOrigin(`${scheme}//${authority}${match[3]}`);
}

/** The gateway's own origin in one scheme, normalised, or null. */
function ownOrigin(scheme, host) {
  const authority = normalizeAuthority(host, `${scheme}:`);
  return authority === null ? null : `${scheme}://${authority}`;
}

/**
 * Whether a request that a browser context made may use the browser route.
 *
 * Why the gateway carries this check, and not Chromium. The debug port is a
 * control channel for a browser that holds the agent's sessions, so "this request
 * has a session cookie" is not enough to open it: every other service on the
 * operator's loopback is same-site, so a page served by one of them arrives with
 * that cookie attached (SameSite=Lax counts loopback to loopback as same-site).
 * If the gateway then passed the request on and deleted the Origin, the browser
 * would have nothing left to refuse it with, and that page would own the agent's
 * browser. So the check lives here, at the authenticated boundary.
 *
 * Upstream, the Origin is still removed, because Chromium refuses any origin it
 * did not generate and the request by then comes from the gateway, not from the
 * page. The alternative, `--remote-allow-origins`, is the wrong layer: it would
 * name trusted origins inside the browser and leave every page of those origins
 * able to reach the debug port, while this check only lets through what arrived
 * at this gateway as its own frontend.
 *
 * A request with no Origin is a client that is not a browser page (the MCP
 * server, curl, the harness), and there is no page context to judge.
 *
 * `trustProxy` covers the deployment README.md recommends: a TLS terminating
 * proxy in front, so the browser sends an `https` Origin while the socket the
 * gateway sees is plain http. The flag already means "a proxy I control is in
 * front", which is exactly the condition under which the https variant of the
 * request's own authority is trustworthy. It adds that one scheme variant of the
 * request's own authority and nothing else, and the authority still has to be the
 * same one after normalisation (`normalizeAuthority`): another name, another port
 * or a different scheme is refused, and with the flag off the behaviour is the one
 * before it existed.
 */
export function isAcceptableOrigin(origin, host, { secure = false, trustProxy = false } = {}) {
  if (origin === undefined || origin === null || String(origin).trim() === "") {
    return true;
  }
  const theirs = canonicalOrigin(String(origin).trim());
  if (theirs === null) {
    // A value that is not an origin cannot be compared, so a request that came
    // from a page is refused rather than waved through.
    return false;
  }
  const own = secure ? "https" : "http";
  if (theirs === ownOrigin(own, host)) {
    return true;
  }
  return trustProxy && theirs === ownOrigin("https", host);
}
