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
import { readdirSync } from "node:fs";
import { constants } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway } from "./lib/server.mjs";
import { DEFAULT_SESSION_TTL_MS } from "./lib/session.mjs";
import { certificateHosts, loadOrCreateCertificate } from "./lib/tls.mjs";
import { assessVolumes, parseMountInfo, readMountInfo } from "./lib/volumes.mjs";

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
export const TLS_OFF = ["off", "false", "0", "no", "disabled"];

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
 * On unless it is turned off. That is the position asked for, and the argument is
 * simple: a self-signed https is better than plain http, it is what makes the
 * origin a secure context (the clipboard, service workers, the attachment
 * checksum), and nobody should have to think about it to get an encrypted
 * connection.
 *
 * A deployment with a reverse proxy, a WireGuard or a Tailscale tunnel, or a NAS
 * certificate already terminating TLS says `ZCLOUDIUM_TLS=off`, because two layers
 * doing it is one too many. An unrecognised value keeps the default, so a typo
 * cannot silently downgrade the connection.
 */
export function parseTls(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return true;
  }
  return !TLS_OFF.includes(String(raw).trim().toLowerCase());
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
    trustProxy: parseTrustProxy(env.ZCLOUDIUM_TRUST_PROXY),
    tls: parseTls(env.ZCLOUDIUM_TLS),
    tlsHosts: parseTlsHosts(env.ZCLOUDIUM_TLS_HOSTS),
    volumeCheck: !isOff(env.ZCLOUDIUM_VOLUME_CHECK),
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

/** Conventional shell exit code: 128 + the signal number when the child was killed. */
export function exitCodeFor(code, signal) {
  if (typeof code === "number") {
    return code;
  }
  const number = signal ? constants.signals[signal] : undefined;
  return typeof number === "number" ? 128 + number : 1;
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
  loadOrCreateCertificateFn = loadOrCreateCertificate,
  /**
   * The kernel's view of this container's mounts, and a way to ask whether a
   * directory already holds anything. Injectable so the tests can exercise
   * every shape of deployment without mounting anything.
   */
  mountInfoText = readMountInfo(),
  dirState = (dir) => (readdirSync(dir).length > 0 ? "content" : "empty"),
  onExit = (code) => process.exit(code),
} = {}) {
  const config = parseEnv(env);
  const args = runtimeArgs(config);

  // The persistence pre-check runs before anything else, because every other
  // failure mode is recoverable and this one is not: an agent that works for
  // an hour on a throwaway filesystem has done work that no retry brings back.
  // The image declares VOLUME /data, so Docker always mounts something there —
  // the trap this catches is the anonymous volume it silently creates when the
  // operator forgot the -v.
  if (config.volumeCheck) {
    if (mountInfoText === null) {
      logger(
        "[start] the volume check cannot read the mount table (/proc/self/mountinfo): skipping. " +
          "Persistence is not verified for this run.",
      );
    } else {
      const assessment = assessVolumes({
        dataDir: config.dataDir,
        workspace: config.workspace,
        mounts: parseMountInfo(mountInfoText),
        dirState,
      });
      for (const warning of assessment.warnings) {
        logger(`[start] warning: ${warning}`);
      }
      if (!assessment.ok) {
        throw new Error(
          "refusing to start: the directories that hold your work are not persisted.\n" +
            assessment.errors.map((error) => `  - ${error}`).join("\n") +
            "\nMount the volumes (compose.yml does this as shipped), or set ZCLOUDIUM_VOLUME_CHECK=off " +
            "if this container is genuinely throwaway.",
        );
      }
    }
  } else {
    logger(
      "[start] volume check off (ZCLOUDIUM_VOLUME_CHECK=off): nothing verifies that " +
        `${config.dataDir} or ${config.workspace} survive this container`,
    );
  }

  // The addresses and the workspace come from the environment. A leftover
  // command line is appended to this script and does nothing, so say so instead
  // of ignoring it in silence.
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
      : "[start] TLS off (ZCLOUDIUM_TLS=off): the gateway serves plain http. Keep a reverse proxy in front doing " +
          "it, or turn ZCLOUDIUM_TLS back on",
  );
  logger(
    config.trustProxy
      ? "[start] rate limit keyed on the x-forwarded-for header (ZCLOUDIUM_TRUST_PROXY=on): only safe behind a " +
          "proxy that overwrites it, and every client it forwards then shares one key"
      : "[start] rate limit keyed on the connecting socket (default): set ZCLOUDIUM_TRUST_PROXY=on only behind a " +
          "proxy that sets x-forwarded-for itself",
  );

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

  const child = spawnRuntime(process.execPath, [RUNTIME_ENTRY, ...args], {
    stdio: "inherit",
    env,
  });

  const forward = (signal) => {
    logger(`[start] forwarding ${signal} to the runtime (pid ${child.pid})`);
    if (!child.kill(signal)) {
      logger(`[start] the runtime did not accept ${signal}`);
    }
  };
  signals.on("SIGTERM", () => forward("SIGTERM"));
  signals.on("SIGINT", () => forward("SIGINT"));

  let gateway = null;
  let settled = false;

  const stop = async () => {
    const current = gateway;
    gateway = null;
    if (!current) {
      return;
    }
    try {
      await current.close();
    } catch (error) {
      logger(`[start] gateway shutdown failed: ${error.message}`);
    }
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

  if (config.authEnabled) {
    // The logger travels with the options, so the gateway reports its own
    // startup and every authentication event through the same sink as the rest
    // of the startup lines. Without it, a refused password, the reason a code was
    // rejected and the temporary block of an address are written nowhere, which
    // is exactly what an operator needs after a suspicious connection.
    gateway = await createGatewayFn({
      ...gatewayOptions({ ...config, tls }),
      logger,
    });
    logger(
      `[start] gateway listening on ${config.tls ? "https" : "http"}://${PUBLISHED_HOST}:${gateway.port} ` +
        `(authentication on), runtime confined to ${UPSTREAM_HOST}:${UPSTREAM_PORT} (pid ${child.pid})`,
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
