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
import { applyBrowserMcp } from "./lib/mcp-config.mjs";
import { createGateway } from "./lib/server.mjs";

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

const OFF = "off";

const isOff = (value) => typeof value === "string" && value.trim().toLowerCase() === OFF;

const envValue = (env, name, fallback) => {
  const raw = env[name];
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : fallback;
};

/** Environment parsing: what the container was asked to do. */
export function parseEnv(env = process.env) {
  return {
    authEnabled: !isOff(env.ZCLOUDIUM_AUTH),
    browserMcp: !isOff(env.ZCLOUDIUM_BROWSER_MCP),
    workspace: envValue(env, "ZCODE_SERVER_WORKSPACE", DEFAULT_WORKSPACE),
    dataDir: envValue(env, "ZCODE_DATA_BASE_DIR", DEFAULT_DATA_DIR),
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

/** Options for createGateway: published address, loopback upstream, data volume. */
export function gatewayOptions({ dataDir = DEFAULT_DATA_DIR } = {}) {
  return {
    host: PUBLISHED_HOST,
    port: PUBLISHED_PORT,
    dataDir,
    upstreamUrl: `http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
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
  logger = (line) => process.stdout.write(`${line}\n`),
  signals = process,
  spawnRuntime = (file, args, options) => spawn(file, args, options),
  createGatewayFn = createGateway,
  applyMcpConfigFn = applyBrowserMcp,
  onExit = (code) => process.exit(code),
} = {}) {
  const config = parseEnv(env);
  const args = runtimeArgs(config);

  // Before the runtime starts, so that it reads a configuration that already
  // contains the browser server instead of writing its own state over it.
  if (config.browserMcp) {
    const home = homeOf(env);
    try {
      const result = await applyMcpConfigFn({ home });
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
    gateway = await createGatewayFn(gatewayOptions(config));
    logger(
      `[start] gateway listening on ${PUBLISHED_HOST}:${gateway.port} (authentication on), ` +
        `runtime confined to ${UPSTREAM_HOST}:${UPSTREAM_PORT} (pid ${child.pid})`,
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
