#!/usr/bin/env node
/**
 * Container entrypoint.
 *
 * It starts the ZCode runtime on loopback, then puts the authentication gateway
 * on the published port in front of it. The runtime keeps running exactly as it
 * does upstream: nothing here patches or wraps the application, it only decides
 * which address the runtime listens on and what is allowed to reach it.
 *
 * `ZCLOUDIUM_AUTH=off` restores the previous behaviour, where the runtime was
 * published directly and had no authentication, without touching the image.
 */

import { spawn } from "node:child_process";
import { constants, homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BROWSER_PREFIX,
  browserArgs,
  browserDebugUrl,
  browserProfileDir,
  launchBrowser,
  parseBrowserDebugPort,
  parseBrowserPanel,
  prepareBrowserProfile,
  resolveBrowserMode,
  stopBrowser,
  waitForBrowser,
} from "./lib/browser.mjs";
import { applyBrowserMcp, browserServerEntry } from "./lib/mcp-config.mjs";
import { createGateway } from "./lib/server.mjs";
import { DEFAULT_SESSION_TTL_MS } from "./lib/session.mjs";
import { certificateHosts, loadOrCreateCertificate } from "./lib/tls.mjs";

/** Where the runtime tarball is extracted in the image. */
export const RUNTIME_ENTRY = "/opt/zcodium/bin/zcode.mjs";

/** The published address: the only one the image exposes. */
export const PUBLISHED_HOST = "0.0.0.0";
export const PUBLISHED_PORT = 3030;

/** The loopback address the runtime is confined to while the gateway is in front. */
export const UPSTREAM_HOST = "127.0.0.1";
export const UPSTREAM_PORT = 3131;

export const DEFAULT_WORKSPACE = "/workspace";
export const DEFAULT_DATA_DIR = "/data";

export const HOUR_MS = 60 * 60 * 1000;

/**
 * The session lifetime, expressed in hours because that is how the
 * documentation states it. The value itself lives in session.mjs, so the
 * default cannot be described in one place and implemented in another.
 */
export const DEFAULT_SESSION_TTL_HOURS = DEFAULT_SESSION_TTL_MS / HOUR_MS;

const OFF = "off";

const isOff = (value) => typeof value === "string" && value.trim().toLowerCase() === OFF;

/** Values that explicitly ask for a switch to be on, and values that refuse it. */
export const TLS_ON = ["on", "true", "1", "yes"];

const TRUST_PROXY_ON = ["on", "true", "1", "yes"];
export const TRUST_PROXY_OFF = ["off", "false", "0", "no"];

const envValue = (env, name, fallback) => {
  const raw = env[name];
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : fallback;
};

/**
 * Whether the rate limit may be keyed on the x-forwarded-for header.
 *
 * Only an explicit request turns this on. The key decides who gets blocked, so a
 * client able to set that header could otherwise pick a new key for every
 * attempt, which is the same as having no limit at all. It is only correct behind
 * a reverse proxy that overwrites the header with the address it saw.
 */
/**
 * Whether the gateway terminates TLS itself.
 *
 * Off unless it is explicitly asked for, and that direction is deliberate: a
 * deployment that already has a reverse proxy terminating TLS must keep letting
 * that proxy do it, and turning this on there would break it. A value that is not
 * recognised keeps the default.
 */
export function parseTls(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return false;
  }
  return TLS_ON.includes(String(raw).trim().toLowerCase());
}

/**
 * The names the certificate must also carry, when the deployment knows them.
 *
 * A certificate generated inside the container cannot guess the address the
 * operator's browser uses: that address belongs to the host, not to the
 * container. A browser that reaches a name the certificate does not carry refuses
 * the connection even after the warning is accepted, so the one person who knows
 * the name is the operator, and this is where they say it.
 */
export function parseTlsHosts(raw) {
  if (raw === undefined || raw === null) {
    return [];
  }
  return String(raw)
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host !== "");
}

export function parseTrustProxy(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return false;
  }
  return TRUST_PROXY_ON.includes(String(raw).trim().toLowerCase());
}

/**
 * Reads a number of hours. Anything that is not a positive number is refused
 * and replaced by the default: a typo must not silently produce a session that
 * outlives the documentation.
 */
export function parseSessionTtlHours(raw, fallback = DEFAULT_SESSION_TTL_HOURS) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const hours = Number(String(raw).trim());
  return Number.isFinite(hours) && hours > 0 ? hours : fallback;
}

/** Environment parsing: what the container was asked to do. */
export function parseEnv(env = process.env) {
  const sessionTtlHours = parseSessionTtlHours(env.ZCLOUDIUM_SESSION_TTL_HOURS);
  return {
    authEnabled: !isOff(env.ZCLOUDIUM_AUTH),
    browserMcp: !isOff(env.ZCLOUDIUM_BROWSER_MCP),
    browserPanel: parseBrowserPanel(env.ZCLOUDIUM_BROWSER_PANEL),
    browserDebugPort: parseBrowserDebugPort(env.ZCLOUDIUM_BROWSER_DEBUG_PORT),
    trustProxy: parseTrustProxy(env.ZCLOUDIUM_TRUST_PROXY),
    tls: parseTls(env.ZCLOUDIUM_TLS),
    tlsHosts: parseTlsHosts(env.ZCLOUDIUM_TLS_HOSTS),
    workspace: envValue(env, "ZCODE_SERVER_WORKSPACE", DEFAULT_WORKSPACE),
    dataDir: envValue(env, "ZCODE_DATA_BASE_DIR", DEFAULT_DATA_DIR),
    sessionTtlHours,
    sessionTtlMs: sessionTtlHours * HOUR_MS,
  };
}

/**
 * Argument construction for the runtime.
 *
 * With the gateway on, the runtime is bound to loopback: it is then reachable
 * only through the gateway, which is the whole point of the exercise. With the
 * gateway off, these are exactly the arguments the image used before, so the
 * fallback is a known quantity.
 */
export function runtimeArgs({ authEnabled = true, workspace = DEFAULT_WORKSPACE } = {}) {
  return [
    "--web",
    "--host",
    authEnabled ? UPSTREAM_HOST : PUBLISHED_HOST,
    "--port",
    String(authEnabled ? UPSTREAM_PORT : PUBLISHED_PORT),
    "--workspace",
    workspace,
    "--no-open",
    "--no-token",
  ];
}

/** Options for createGateway: published address, loopback upstream, data volume, session lifetime, rate limit key. */
export function gatewayOptions({
  dataDir = DEFAULT_DATA_DIR,
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  trustProxy = false,
  tls = null,
} = {}) {
  return {
    host: PUBLISHED_HOST,
    port: PUBLISHED_PORT,
    dataDir,
    upstreamUrl: `http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
    sessionTtlMs,
    trustProxy,
    tls,
  };
}

/** The agent configuration lives under $HOME, which both compose profiles set. */
export function homeOf(env = process.env) {
  return envValue(env, "HOME", homedir());
}

/** Conventional shell exit code: 128 + the signal number when the child was killed. */
export function exitCodeFor(code, signal) {
  if (typeof code === "number") {
    return code;
  }
  const number = signal ? constants.signals[signal] : undefined;
  return typeof number === "number" ? 128 + number : 1;
}

function describeMerge(result) {
  switch (result?.status) {
    case "created":
      return `wrote ${result.configPath}`;
    case "updated":
      return `added to ${result.configPath} (previous file kept in ${result.backupPath})`;
    case "unchanged":
      return `already configured in ${result.configPath}`;
    default:
      return `left the configuration untouched: ${result?.message ?? "unknown result"}`;
  }
}

/**
 * Starts the runtime, and the gateway in front of it unless authentication is
 * off. Returns once both are up; the process keeps running until the runtime
 * exits. Every dependency is injectable, which is what the tests use.
 */
export async function start({
  env = process.env,
  argv = process.argv,
  logger = (line) => process.stdout.write(`${line}\n`),
  signals = process,
  spawnRuntime = (file, args, options) => spawn(file, args, options),
  createGatewayFn = createGateway,
  applyMcpConfigFn = applyBrowserMcp,
  launchBrowserFn = launchBrowser,
  probeBrowserFn = waitForBrowser,
  stopBrowserFn = stopBrowser,
  prepareProfileFn = prepareBrowserProfile,
  loadOrCreateCertificateFn = loadOrCreateCertificate,
  onExit = (code) => process.exit(code),
} = {}) {
  const config = parseEnv(env);
  const args = runtimeArgs(config);

  // The addresses, the workspace and the data directory come from the
  // environment. A leftover command line is appended to this script and does
  // nothing, so say so instead of ignoring it in silence.
  const extra = argv.slice(2);
  if (extra.length > 0) {
    logger(
      `[start] ignoring the extra command line arguments (${extra.join(" ")}): the workspace, the addresses and ` +
        "the data directory come from the environment. Remove the command block from your compose file, and set " +
        "ZCODE_SERVER_WORKSPACE and ZCODE_DATA_BASE_DIR instead.",
    );
  }

  // The lifetime is reported because it is the window during which a stolen
  // cookie stays usable.
  const requestedTtl = envValue(env, "ZCLOUDIUM_SESSION_TTL_HOURS", null);
  const lifetime = `${config.sessionTtlHours} ${config.sessionTtlHours === 1 ? "hour" : "hours"}`;
  if (requestedTtl !== null && Number(requestedTtl) !== config.sessionTtlHours) {
    logger(
      `[start] ZCLOUDIUM_SESSION_TTL_HOURS="${requestedTtl}" is not a positive number of hours, ` +
        `falling back to ${lifetime}`,
    );
  }
  logger(`[start] sessions last ${lifetime}`);

  // Which key the failure block uses decides who gets blocked, so it is stated,
  // not left implicit.
  const requestedProxy = envValue(env, "ZCLOUDIUM_TRUST_PROXY", null);
  if (
    requestedProxy !== null &&
    !TRUST_PROXY_ON.includes(requestedProxy.toLowerCase()) &&
    !TRUST_PROXY_OFF.includes(requestedProxy.toLowerCase())
  ) {
    logger(
      `[start] ZCLOUDIUM_TRUST_PROXY="${requestedProxy}" is not a recognised value, keeping the default: ` +
        "the rate limit ignores forwarded addresses",
    );
  }
  logger(
    config.tls
      ? "[start] TLS on (ZCLOUDIUM_TLS=on): the gateway serves https with its own certificate. A browser will warn " +
          "once, because a self-signed certificate is not signed by an authority it knows"
      : "[start] TLS off (default): the gateway serves plain http. Turn ZCLOUDIUM_TLS=on for https from the gateway, " +
          "or keep a reverse proxy in front doing it",
  );
  logger(
    config.trustProxy
      ? "[start] rate limit keyed on the x-forwarded-for header (ZCLOUDIUM_TRUST_PROXY=on): only safe behind a " +
          "proxy that overwrites it, and every client it forwards then shares one key"
      : "[start] rate limit keyed on the connecting socket (default): set ZCLOUDIUM_TRUST_PROXY=on only behind a " +
          "proxy that sets x-forwarded-for itself",
  );

  // Before the runtime starts, so that it reads a configuration that already
  // contains the browser server instead of writing its own state over it.
  //
  // Phase 0 of issue #5: the container launches one Chromium with a debug port on
  // loopback first, and the agent's MCP server attaches to it instead of launching
  // its own browser. On by default, because that browser and the panel that
  // watches it are the point of the tool: ZCLOUDIUM_BROWSER_PANEL=off restores the
  // shape the image shipped before, with nothing here running and no debug port
  // announced to the gateway.
  const debugUrl = browserDebugUrl(config.browserDebugPort);
  let browser = null;
  let browserStop = null;

  /** Asks the browser to stop once, whatever asked for it. */
  const stopBrowserOnce = (reason) => {
    if (!browser) {
      return Promise.resolve("no-browser");
    }
    if (!browserStop) {
      logger(`[start] stopping the browser (${reason})`);
      browserStop = Promise.resolve(stopBrowserFn(browser, { logger })).then((outcome) => {
        logger(`[start] browser stopped: ${outcome}`);
        return outcome;
      });
    }
    return browserStop;
  };

  if (config.browserPanel && !config.browserMcp) {
    // The panel is the agent's browser made visible. With no browser MCP server
    // there is no agent browser, so a browser here would be a stray process.
    logger(
      "[start] the browser panel is on but the browser MCP server is off (ZCLOUDIUM_BROWSER_MCP=off): no browser is " +
        "started, because nothing would drive it",
    );
  } else if (config.browserPanel) {
    const profile = browserProfileDir(config.dataDir);
    // Before the browser starts: a container that was killed rather than stopped
    // leaves a lock naming another machine, and Chromium refuses to start on it.
    // Failing to unlock is reported and the browser is still launched, so the
    // fallback covers it.
    try {
      const prepared = await prepareProfileFn(profile, { logger });
      if (prepared.status === "unlocked") {
        logger(`[start] browser profile prepared: released a lock from ${prepared.target}`);
      }
    } catch (error) {
      logger(`[start] the browser profile could not be prepared: ${error.message}`);
    }
    browser = launchBrowserFn({
      args: browserArgs({ port: config.browserDebugPort, userDataDir: profile }),
      env,
      logger,
      onExit: (code, signal, error) =>
        logger(
          `[start] the browser exited (code ${code}, signal ${signal ?? "none"}${error ? `, ${error}` : ""})`,
        ),
    });

    const probe = await probeBrowserFn({ debugUrl });
    if (resolveBrowserMode({ panelEnabled: true, debugUrl, reachable: probe.reachable }) === "attach") {
      // Where the panel can be reached depends on the gateway existing: with
      // ZCLOUDIUM_AUTH=off the runtime is published directly and nothing serves
      // the browser prefix, so saying the panel is on /_browser/ there would be a
      // promise the deployment cannot keep.
      const where = config.authEnabled
        ? `The panel is on ${BROWSER_PREFIX}/ behind the session, and Chromium's own DevTools frontend on ` +
          `${BROWSER_PREFIX}/devtools/inspector.html.`
        : `With ZCLOUDIUM_AUTH=off no gateway serves ${BROWSER_PREFIX}/, so the panel is not reachable: the browser ` +
          "runs for the agent only.";
      logger(
        `[start] browser panel: the agent attaches to ${debugUrl} (pid ${browser.pid}), profile ${profile}. ${where}`,
      );
    } else {
      // A browser that never opened its debug port is no use to anyone: the
      // agent falls back to launching its own, and this one is stopped rather
      // than left running and invisible.
      logger(
        `[start] browser panel: ${debugUrl} did not answer its discovery endpoint, so the agent falls back to the ` +
          "browser it launches itself",
      );
      await stopBrowserOnce("the debug port did not answer");
      browser = null;
    }
  } else {
    logger(
      "[start] the browser panel is off (ZCLOUDIUM_BROWSER_PANEL=off): the agent launches its own headless browser",
    );
  }

  const attached = browser !== null;

  if (config.browserMcp) {
    const home = homeOf(env);
    try {
      const result = await applyMcpConfigFn({
        home,
        entry: browserServerEntry({ browserUrl: attached ? debugUrl : null }),
      });
      logger(`[start] browser MCP ${describeMerge(result)}`);
    } catch (error) {
      // A configuration problem must not keep the interface from starting.
      logger(`[start] browser MCP configuration left untouched: ${error.message}`);
    }
  } else {
    logger("[start] browser MCP disabled (ZCLOUDIUM_BROWSER_MCP=off)");
  }

  const child = spawnRuntime(process.execPath, [RUNTIME_ENTRY, ...args], {
    stdio: "inherit",
    env,
  });

  const forward = (signal) => {
    logger(`[start] forwarding ${signal} to the runtime (pid ${child.pid})`);
    if (!child.kill(signal)) {
      logger(`[start] the runtime did not accept ${signal}`);
    }
    // The browser is stopped on the same signal. Chromium flushes its profile on
    // the way out, and that profile holds the agent's sessions, so it must not be
    // left to a kill from the runtime's own shutdown.
    void stopBrowserOnce(signal);
  };
  signals.on("SIGTERM", () => forward("SIGTERM"));
  signals.on("SIGINT", () => forward("SIGINT"));

  let gateway = null;
  let settled = false;

  const stop = async () => {
    const current = gateway;
    gateway = null;
    if (!current) {
      await stopBrowserOnce("the runtime exited");
      return;
    }
    try {
      await current.close();
    } catch (error) {
      logger(`[start] gateway shutdown failed: ${error.message}`);
    }
    await stopBrowserOnce("the runtime exited");
  };

  child.on("exit", (code, signal) => {
    const exitCode = exitCodeFor(code, signal);
    logger(`[start] the runtime exited (code ${code}, signal ${signal ?? "none"})`);
    if (settled) {
      return;
    }
    settled = true;
    void stop().finally(() => onExit(exitCode));
  });

  child.on("error", (error) => {
    logger(`[start] the runtime could not be started: ${error.message}`);
    if (settled) {
      return;
    }
    settled = true;
    void stop().finally(() => onExit(1));
  });

  /**
   * The certificate, when TLS is asked for.
   *
   * It is loaded before the gateway starts, and a failure here is fatal on
   * purpose: an operator who asked for TLS must not end up with an unencrypted
   * listener because a file could not be read. The module says which file and why.
   */
  let tls = null;
  if (config.authEnabled && config.tls) {
    // What the machine answers to, plus what the operator declared: the two
    // together are what the certificate has to name.
    tls = await loadOrCreateCertificateFn({
      dataDir: config.dataDir,
      logger,
      hosts: [...new Set([...certificateHosts(), ...config.tlsHosts])].sort(),
    });
  }

  if (config.authEnabled) {
    // The logger travels with the options, so the gateway reports its own
    // startup and every authentication event through the same sink as the rest
    // of the startup lines. Without it, a refused password, the reason a code was
    // rejected and the temporary block of an address are written nowhere, which
    // is exactly what an operator needs after a suspicious connection.
    gateway = await createGatewayFn({
      ...gatewayOptions({ ...config, tls }),
      debugUrl: attached ? debugUrl : null,
      logger,
    });
    logger(
      `[start] gateway listening on ${config.tls ? "https" : "http"}://${PUBLISHED_HOST}:${gateway.port} (authentication on), ` +
        `runtime confined to ${UPSTREAM_HOST}:${UPSTREAM_PORT} (pid ${child.pid})` +
        (attached ? `, browser panel proxied on ${BROWSER_PREFIX}/` : ""),
    );
  } else {
    logger(
      `[start] authentication disabled (ZCLOUDIUM_AUTH=off): the runtime listens on ` +
        `${PUBLISHED_HOST}:${PUBLISHED_PORT} with no authentication`,
    );
  }

  return { child, gateway, config, args };
}

async function main() {
  try {
    await start();
  } catch (error) {
    // If the gateway cannot bind, the container has nothing to serve: let it
    // fail loudly rather than expose the runtime.
    process.stderr.write(`[start] fatal: ${error.stack ?? error.message}\n`);
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  void main();
}
