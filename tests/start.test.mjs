/**
 * Tests for the container entrypoint (gateway/start.mjs).
 *
 * They cover what can be checked without a browser nor the real runtime: the
 * environment parsing, the argument construction, and the supervision of the
 * child process (signal forwarding, exit code).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { browserServerEntry } from "../gateway/lib/mcp-config.mjs";
import { DEFAULT_SESSION_TTL_MS } from "../gateway/lib/session.mjs";
import {
  DEFAULT_DATA_DIR,
  DEFAULT_SESSION_TTL_HOURS,
  DEFAULT_WORKSPACE,
  HOUR_MS,
  PUBLISHED_HOST,
  PUBLISHED_PORT,
  RUNTIME_ENTRY,
  UPSTREAM_HOST,
  UPSTREAM_PORT,
  exitCodeFor,
  gatewayOptions,
  homeOf,
  parseEnv,
  parseSessionTtlHours,
  parseTrustProxy,
  runtimeArgs,
  start,
} from "../gateway/start.mjs";

/** The argument list the runtime received before the gateway existed, verbatim. */
const DIRECT_ARGS = ["--web", "--host", "0.0.0.0", "--port", "3030", "--workspace", "/workspace", "--no-open", "--no-token"];
/** The loopback form the gateway proxies to when it is in front of the runtime. */
const LOOPBACK_ARGS = ["--web", "--host", "127.0.0.1", "--port", "3131", "--workspace", "/workspace", "--no-open", "--no-token"];

test("the defaults match the image: /workspace, /data, loopback runtime, gateway on", () => {
  assert.deepEqual(parseEnv({}), {
    authEnabled: true,
    browserMcp: true,
    browserPanel: false,
    browserDebugPort: 9222,
    trustProxy: false,
    workspace: DEFAULT_WORKSPACE,
    dataDir: DEFAULT_DATA_DIR,
    sessionTtlHours: DEFAULT_SESSION_TTL_HOURS,
    sessionTtlMs: DEFAULT_SESSION_TTL_MS,
  });
  assert.equal(DEFAULT_WORKSPACE, "/workspace");
  assert.equal(DEFAULT_DATA_DIR, "/data");
  assert.equal(RUNTIME_ENTRY, "/opt/zcodium/bin/zcode.mjs");
  assert.equal(PUBLISHED_HOST, "0.0.0.0");
  assert.equal(PUBLISHED_PORT, 3030);
  assert.equal(UPSTREAM_HOST, "127.0.0.1");
  assert.equal(UPSTREAM_PORT, 3131);
});

/**
 * The documentation states the session lifetime in hours, so the code has to
 * pin the same number: this is the test that stops the two from drifting apart.
 */
test("a session lasts 12 hours by default, and that default is a single number", () => {
  assert.equal(HOUR_MS, 3_600_000);
  assert.equal(DEFAULT_SESSION_TTL_HOURS, 12);
  assert.equal(DEFAULT_SESSION_TTL_MS, 12 * HOUR_MS);
  assert.equal(parseEnv({}).sessionTtlMs, 12 * HOUR_MS);
  assert.equal(parseEnv({}).sessionTtlHours, 12);
});

test("ZCLOUDIUM_SESSION_TTL_HOURS accepts a positive number of hours", () => {
  assert.equal(parseEnv({ ZCLOUDIUM_SESSION_TTL_HOURS: "1" }).sessionTtlMs, 1 * HOUR_MS);
  assert.equal(parseEnv({ ZCLOUDIUM_SESSION_TTL_HOURS: "6" }).sessionTtlHours, 6);
  assert.equal(parseEnv({ ZCLOUDIUM_SESSION_TTL_HOURS: " 24 " }).sessionTtlMs, 24 * HOUR_MS);
  assert.equal(parseEnv({ ZCLOUDIUM_SESSION_TTL_HOURS: "0.5" }).sessionTtlMs, HOUR_MS / 2);
  assert.equal(parseEnv({ ZCLOUDIUM_SESSION_TTL_HOURS: "8760" }).sessionTtlHours, 8760);
});

test("anything that is not a positive number falls back to the default", () => {
  for (const value of ["", "   ", "0", "-1", "-0.5", "abc", "12h", "NaN", "Infinity", "1e999"]) {
    const config = parseEnv({ ZCLOUDIUM_SESSION_TTL_HOURS: value });
    assert.equal(config.sessionTtlHours, DEFAULT_SESSION_TTL_HOURS, `"${value}" must fall back`);
    assert.equal(config.sessionTtlMs, DEFAULT_SESSION_TTL_MS, `"${value}" must fall back`);
  }
  assert.equal(parseSessionTtlHours(undefined), DEFAULT_SESSION_TTL_HOURS);
  assert.equal(parseSessionTtlHours(null), DEFAULT_SESSION_TTL_HOURS);
  assert.equal(parseSessionTtlHours("0"), DEFAULT_SESSION_TTL_HOURS);
  assert.equal(parseSessionTtlHours("0.25"), 0.25);
});

test("the workspace and the data directory come from their environment variables", () => {
  const config = parseEnv({
    ZCODE_SERVER_WORKSPACE: "/srv/work",
    ZCODE_DATA_BASE_DIR: "/state",
  });
  assert.equal(config.workspace, "/srv/work");
  assert.equal(config.dataDir, "/state");
});

/**
 * The rate limit key is the connecting socket by default, because a header the
 * client sets is a key the client can change. Trusting the forwarded header is
 * an explicit decision, and the default must stay the safe side.
 */
test("ZCLOUDIUM_TRUST_PROXY defaults to off and is only on when explicitly asked", () => {
  assert.equal(parseEnv({}).trustProxy, false, "the safe default");
  for (const value of ["on", "ON", " on ", "true", "TRUE", "1", "yes"]) {
    assert.equal(parseEnv({ ZCLOUDIUM_TRUST_PROXY: value }).trustProxy, true, `"${value}" must enable it`);
  }
  for (const value of ["off", "false", "0", "no", "", "   ", "onward"]) {
    assert.equal(parseEnv({ ZCLOUDIUM_TRUST_PROXY: value }).trustProxy, false, `"${value}" must keep the default`);
  }
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy(null), false);
});

test("only an explicit ZCLOUDIUM_AUTH=off disables the gateway", () => {
  for (const value of ["off", "OFF", " off "]) {
    assert.equal(parseEnv({ ZCLOUDIUM_AUTH: value }).authEnabled, false, value);
  }
  for (const value of ["on", "ON", "1", "0", "enabled", "disabled", ""]) {
    assert.equal(parseEnv({ ZCLOUDIUM_AUTH: value }).authEnabled, true, `"${value}" must keep the gateway on`);
  }
  assert.equal(parseEnv({}).authEnabled, true);
});

test("ZCLOUDIUM_BROWSER_MCP defaults to on and is only off when explicitly set", () => {
  assert.equal(parseEnv({}).browserMcp, true);
  assert.equal(parseEnv({ ZCLOUDIUM_BROWSER_MCP: "off" }).browserMcp, false);
  for (const value of ["on", "1", "yes", ""]) {
    assert.equal(parseEnv({ ZCLOUDIUM_BROWSER_MCP: value }).browserMcp, true, `"${value}"`);
  }
});

test("ZCLOUDIUM_BROWSER_PANEL is off by default and takes its port from the environment", () => {
  assert.equal(parseEnv({}).browserPanel, false, "the whole Phase 0 path is off unless it is asked for");
  assert.equal(parseEnv({}).browserDebugPort, 9222);
  for (const value of ["on", "true", "1", "yes", " ON "]) {
    assert.equal(parseEnv({ ZCLOUDIUM_BROWSER_PANEL: value }).browserPanel, true, `"${value}"`);
  }
  for (const value of ["off", "0", "no", "", "maybe"]) {
    assert.equal(parseEnv({ ZCLOUDIUM_BROWSER_PANEL: value }).browserPanel, false, `"${value}"`);
  }
  assert.equal(parseEnv({ ZCLOUDIUM_BROWSER_DEBUG_PORT: "9333" }).browserDebugPort, 9333);
  assert.equal(parseEnv({ ZCLOUDIUM_BROWSER_DEBUG_PORT: "not-a-port" }).browserDebugPort, 9222);
});

test("with the gateway on, the runtime is bound to loopback only", () => {
  assert.deepEqual(runtimeArgs({ authEnabled: true, workspace: "/workspace" }), LOOPBACK_ARGS);
  const args = runtimeArgs({ authEnabled: true, workspace: "/srv/work" });
  assert.equal(args.includes(PUBLISHED_HOST), false, "the runtime must never bind the published interface");
  assert.deepEqual(args.slice(0, 7), ["--web", "--host", "127.0.0.1", "--port", "3131", "--workspace", "/srv/work"]);
});

test("with ZCLOUDIUM_AUTH=off, the runtime runs exactly as it did before the gateway", () => {
  assert.deepEqual(runtimeArgs({ authEnabled: false, workspace: "/workspace" }), DIRECT_ARGS);
  assert.deepEqual(runtimeArgs({ authEnabled: false, workspace: "/srv/work" }), [
    "--web",
    "--host",
    "0.0.0.0",
    "--port",
    "3030",
    "--workspace",
    "/srv/work",
    "--no-open",
    "--no-token",
  ]);
});

test("the gateway options point at the loopback address the runtime was given", () => {
  const config = parseEnv({ ZCODE_DATA_BASE_DIR: "/state" });
  assert.deepEqual(gatewayOptions(config), {
    host: "0.0.0.0",
    port: 3030,
    dataDir: "/state",
    upstreamUrl: "http://127.0.0.1:3131",
    sessionTtlMs: DEFAULT_SESSION_TTL_MS,
    trustProxy: false,
  });

  const args = runtimeArgs(config);
  const host = args[args.indexOf("--host") + 1];
  const port = args[args.indexOf("--port") + 1];
  assert.equal(gatewayOptions(config).upstreamUrl, `http://${host}:${port}`);

  const shorter = gatewayOptions(parseEnv({ ZCLOUDIUM_SESSION_TTL_HOURS: "3" }));
  assert.equal(shorter.sessionTtlMs, 3 * HOUR_MS, "the configured lifetime must reach the gateway");

  const trusting = gatewayOptions(parseEnv({ ZCLOUDIUM_TRUST_PROXY: "on" }));
  assert.equal(trusting.trustProxy, true, "the configured proxy trust must reach the gateway");
});

test("the home used for the agent configuration is $HOME, then the system home", () => {
  assert.equal(homeOf({ HOME: "/data" }), "/data");
  assert.equal(homeOf({ HOME: "  " }), homedir());
  assert.equal(homeOf({}), homedir());
});

test("exitCodeFor mirrors the child status", () => {
  assert.equal(exitCodeFor(0, null), 0);
  assert.equal(exitCodeFor(7, null), 7);
  assert.equal(exitCodeFor(null, "SIGTERM"), 143);
  assert.equal(exitCodeFor(null, "SIGINT"), 130);
  assert.equal(exitCodeFor(null, "SIGKILL"), 137);
  assert.equal(exitCodeFor(null, null), 1);
  assert.equal(exitCodeFor(null, "SIGWHATEVER"), 1);
});

/** Minimal child process stub: kill() is recorded, exit is emitted by the test. */
function fakeChild() {
  const child = new EventEmitter();
  child.killed = [];
  child.kill = (signal) => {
    child.killed.push(signal);
    return true;
  };
  return child;
}

/** Minimal process stub, so the suite never sends a real signal to itself. */
function fakeProcess() {
  const handlers = new Map();
  return {
    on(event, handler) {
      handlers.set(event, handler);
      return this;
    },
    signal(event) {
      const handler = handlers.get(event);
      assert.ok(handler, `${event} must have a handler`);
      handler();
    },
    events: () => [...handlers.keys()],
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Wires start() with stubs and returns everything the assertions need.
 *
 * `browser` is the fake browser process the entrypoint is expected to launch
 * when the panel is on; `probe` answers for the debug port, so the fallback can
 * be exercised without a browser.
 */
async function runStart(
  env,
  {
    gateway = null,
    mcp = async () => ({ status: "unchanged" }),
    argv = ["node", "/opt/cloudium/gateway/start.mjs"],
    browser = null,
    probe = async () => ({ reachable: true, version: { Browser: "Chrome/153.0.8010.52" } }),
    prepare = async () => ({ status: "no-lock" }),
  } = {},
) {
  const child = fakeChild();
  const spawns = [];
  const browserSpawns = [];
  const browserStops = [];
  const profilePreparations = [];
  const probes = [];
  const signals = fakeProcess();
  const exits = [];
  const gatewayCalls = [];
  const mcpCalls = [];
  const logs = [];

  const result = await start({
    env,
    argv,
    logger: (line) => logs.push(line),
    signals,
    spawnRuntime: (file, args, options) => {
      spawns.push({ file, args, options });
      return child;
    },
    createGatewayFn: async (options) => {
      gatewayCalls.push(options);
      // The real module logs through the logger it is given: the first line it
      // emits is its listening line, then one line per authentication event. The
      // stub emits the same shape, so the test can check the wiring rather than
      // the shape of the options object.
      options.logger?.("[auth] gateway listening on 0.0.0.0:3030, proxying to http://127.0.0.1:3131");
      options.logger?.("[auth] failed password attempt from 127.0.0.1");
      return gateway ?? { port: PUBLISHED_PORT, close: async () => {} };
    },
    applyMcpConfigFn: async (options) => {
      mcpCalls.push(options);
      return mcp(options);
    },
    prepareProfileFn: async (dir, options) => {
      profilePreparations.push({ dir, options });
      return prepare(dir, options);
    },
    launchBrowserFn: (options) => {
      browserSpawns.push(options);
      if (!browser) {
        throw new Error("the panel was not expected to launch a browser");
      }
      return browser;
    },
    probeBrowserFn: async (options) => {
      probes.push(options);
      return probe(options);
    },
    stopBrowserFn: async (childArg, options) => {
      browserStops.push({ child: childArg, options });
      return "terminated";
    },
    onExit: (code) => exits.push(code),
  });

  return {
    result,
    child,
    spawns,
    signals,
    exits,
    gatewayCalls,
    mcpCalls,
    logs,
    browserSpawns,
    browserStops,
    profilePreparations,
    probes,
  };
}

/** A fake Chromium process: the entrypoint only kills it and waits for the exit. */
function fakeBrowser() {
  const child = fakeChild();
  child.pid = 4242;
  return child;
}

test("with the gateway on, the runtime is spawned on loopback and the gateway starts in front", async () => {
  const closed = [];
  const { result, child, spawns, signals, exits, gatewayCalls, logs } = await runStart(
    { HOME: "/data" },
    { gateway: { port: PUBLISHED_PORT, close: async () => closed.push(true) } },
  );

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].file, process.execPath);
  assert.deepEqual(spawns[0].args, [RUNTIME_ENTRY, ...LOOPBACK_ARGS]);
  assert.equal(spawns[0].options.stdio, "inherit");
  assert.deepEqual(
    gatewayCalls.map(({ logger, ...options }) => options),
    [
      {
        host: "0.0.0.0",
        port: 3030,
        dataDir: "/data",
        upstreamUrl: "http://127.0.0.1:3131",
        sessionTtlMs: DEFAULT_SESSION_TTL_MS,
        trustProxy: false,
        debugUrl: null,
      },
    ],
  );
  assert.equal(result.child, child);
  assert.equal(result.gateway.port, PUBLISHED_PORT);

  // The gateway must be able to log, and what it logs must reach the entrypoint
  // logger: without this, the failed attempts and the rejected codes of a
  // deployment are invisible in `docker logs`.
  assert.equal(typeof gatewayCalls[0].logger, "function", "the gateway must receive a logger");
  assert.ok(
    logs.includes("[auth] failed password attempt from 127.0.0.1"),
    `the lines the gateway emits must reach the entrypoint logger, got: ${JSON.stringify(logs)}`,
  );
  assert.ok(
    logs.includes("[auth] gateway listening on 0.0.0.0:3030, proxying to http://127.0.0.1:3131"),
    "the gateway listening line must reach the same logger",
  );

  signals.signal("SIGTERM");
  assert.deepEqual(child.killed, ["SIGTERM"]);
  signals.signal("SIGINT");
  assert.deepEqual(child.killed, ["SIGTERM", "SIGINT"]);

  child.emit("exit", 0, null);
  await tick();
  assert.deepEqual(exits, [0], "the process must exit with the child code");
  assert.deepEqual(closed, [true], "the gateway must be closed when the child exits");
});

test("with ZCLOUDIUM_AUTH=off the runtime runs directly and no gateway is started", async () => {
  const { result, child, spawns, signals, exits, gatewayCalls } = await runStart({ ZCLOUDIUM_AUTH: "off" });

  assert.deepEqual(spawns[0].args, [RUNTIME_ENTRY, ...DIRECT_ARGS]);
  assert.equal(gatewayCalls.length, 0, "the gateway must not start when auth is off");
  assert.equal(result.gateway, null);
  assert.deepEqual(signals.events().sort(), ["SIGINT", "SIGTERM"]);

  signals.signal("SIGTERM");
  assert.deepEqual(child.killed, ["SIGTERM"]);

  child.emit("exit", 7, null);
  await tick();
  assert.deepEqual(exits, [7]);
});

test("a child killed by a signal yields the conventional exit code", async () => {
  const { child, exits } = await runStart({ ZCLOUDIUM_AUTH: "off" });
  child.emit("exit", null, "SIGTERM");
  await tick();
  assert.deepEqual(exits, [143]);
});

test("the browser MCP configuration is merged into $HOME by default", async () => {
  const { mcpCalls } = await runStart({ HOME: "/data" });
  assert.equal(mcpCalls.length, 1);
  assert.equal(mcpCalls[0].home, "/data");
});

test("ZCLOUDIUM_BROWSER_MCP=off leaves the agent configuration untouched", async () => {
  const { mcpCalls } = await runStart({ HOME: "/data", ZCLOUDIUM_BROWSER_MCP: "off" });
  assert.deepEqual(mcpCalls, []);
});

test("the rate limit key is reported at startup, so the operator knows what it is", async () => {
  const safe = await runStart({ HOME: "/data" });
  assert.equal(
    safe.logs.some((line) => /rate limit keyed on the connecting socket/i.test(line)),
    true,
    `the default must be stated, got ${JSON.stringify(safe.logs)}`,
  );

  const trusting = await runStart({ HOME: "/data", ZCLOUDIUM_TRUST_PROXY: "on" });
  assert.equal(trusting.gatewayCalls[0].trustProxy, true);
  assert.equal(
    trusting.logs.some((line) => /x-forwarded-for/i.test(line)),
    true,
    `trusting a header must be stated, got ${JSON.stringify(trusting.logs)}`,
  );

  const unrecognised = await runStart({ HOME: "/data", ZCLOUDIUM_TRUST_PROXY: "maybe" });
  assert.equal(unrecognised.gatewayCalls[0].trustProxy, false, "an unknown value keeps the safe default");
  assert.equal(
    unrecognised.logs.some((line) => /ZCLOUDIUM_TRUST_PROXY/.test(line) && /maybe/.test(line)),
    true,
    `an unrecognised value must be reported, got ${JSON.stringify(unrecognised.logs)}`,
  );
});

test("the session lifetime from the environment reaches the gateway", async () => {
  const { gatewayCalls } = await runStart({ HOME: "/data", ZCLOUDIUM_SESSION_TTL_HOURS: "2" });
  assert.equal(gatewayCalls.length, 1);
  assert.equal(gatewayCalls[0].sessionTtlMs, 2 * HOUR_MS);

  const reported = await runStart({ HOME: "/data", ZCLOUDIUM_SESSION_TTL_HOURS: "1" });
  assert.equal(
    reported.logs.some((line) => /sessions last 1 hour$/.test(line)),
    true,
    `the reported lifetime must read correctly, got ${JSON.stringify(reported.logs)}`,
  );

  const fallback = await runStart({ HOME: "/data", ZCLOUDIUM_SESSION_TTL_HOURS: "forever" });
  assert.equal(fallback.gatewayCalls[0].sessionTtlMs, DEFAULT_SESSION_TTL_MS, "an unusable value must not weaken the default");
  assert.equal(
    fallback.logs.some((line) => /ZCLOUDIUM_SESSION_TTL_HOURS/.test(line) && /12 hours/.test(line)),
    true,
    `the substitution must be reported, got ${JSON.stringify(fallback.logs)}`,
  );
});

test("extra command line arguments are reported and ignored", async () => {
  const stale = ["node", "/opt/cloudium/gateway/start.mjs", "--web", "--host=0.0.0.0", "--port=3030", "--workspace=/workspace"];
  const { spawns, logs } = await runStart({ HOME: "/data" }, { argv: stale });

  assert.deepEqual(
    spawns[0].args,
    [RUNTIME_ENTRY, ...LOOPBACK_ARGS],
    "the runtime arguments must still come from the environment, not from the command line",
  );
  assert.equal(
    logs.some((line) => /command line/i.test(line)),
    true,
    `the operator must be told, got ${JSON.stringify(logs)}`,
  );

  const quiet = await runStart({ HOME: "/data" });
  assert.equal(quiet.logs.some((line) => /command line/i.test(line)), false, "nothing to report without extra arguments");
});

test("a merge failure is reported but does not prevent the startup", async () => {
  const { logs, spawns } = await runStart(
    { HOME: "/data" },
    { mcp: async () => ({ status: "malformed", configPath: "/data/.zcode/cli/config.json", message: "invalid JSON" }) },
  );
  assert.equal(spawns.length, 1, "the runtime must start anyway");
  assert.equal(logs.some((line) => /malformed|invalid JSON/i.test(line)), true, `expected a warning, got ${JSON.stringify(logs)}`);
});

test("a thrown error while merging is caught and does not prevent the startup", async () => {
  const { logs, spawns } = await runStart(
    { HOME: "/data" },
    {
      mcp: async () => {
        throw new Error("disk on fire");
      },
    },
  );
  assert.equal(spawns.length, 1);
  assert.equal(logs.some((line) => /disk on fire/.test(line)), true, `expected the message in the logs, got ${JSON.stringify(logs)}`);
});

/**
 * Phase 0 of issue #5: the browser panel switch, in the entrypoint.
 *
 * With the switch off nothing at all may change. With it on, the entrypoint
 * launches one Chromium on a debug port, points the agent's MCP server at it, and
 * stops it with the rest of the container. If the debug port never answers, the
 * agent must fall back to launching its own browser rather than refuse to start.
 */

test("with the panel off, no browser is launched and the gateway knows nothing about one", async () => {
  const { browserSpawns, browserStops, probes, gatewayCalls, mcpCalls, logs } = await runStart({ HOME: "/data" });
  assert.deepEqual(browserSpawns, [], "no browser may be started");
  assert.deepEqual(browserStops, []);
  assert.deepEqual(probes, [], "no port may be probed");
  assert.equal(gatewayCalls[0].debugUrl, null);
  assert.deepEqual(
    mcpCalls[0].entry,
    browserServerEntry(),
    "with the panel off the entry is exactly the one the image shipped before, launch arguments and all",
  );
  assert.equal(
    logs.some((line) => /browser panel/i.test(line)),
    true,
    `the off state has to be stated, got ${JSON.stringify(logs)}`,
  );
});

test("with the panel on, one browser is launched on the data volume and the agent attaches to it", async () => {
  const browser = fakeBrowser();
  const { browserSpawns, probes, gatewayCalls, mcpCalls, logs } = await runStart(
    { HOME: "/data", ZCLOUDIUM_BROWSER_PANEL: "on" },
    { browser },
  );

  assert.equal(browserSpawns.length, 1);
  assert.equal(browserSpawns[0].args.includes("--remote-debugging-port=9222"), true);
  assert.equal(browserSpawns[0].args.includes("--user-data-dir=/data/browser-profile"), true, "the profile belongs on the volume");
  assert.deepEqual(probes.map((probe) => probe.debugUrl), ["http://127.0.0.1:9222"]);

  assert.equal(mcpCalls.length, 1);
  assert.equal(mcpCalls[0].entry.args.includes("--browserUrl"), true, "the agent must attach instead of launching its own browser");
  assert.equal(mcpCalls[0].entry.args[mcpCalls[0].entry.args.indexOf("--browserUrl") + 1], "http://127.0.0.1:9222");
  assert.equal(gatewayCalls[0].debugUrl, "http://127.0.0.1:9222", "the gateway needs the port to proxy it");
  assert.equal(
    logs.some((line) => /attaches to http:\/\/127\.0\.0\.1:9222/.test(line)),
    true,
    `the attach must be stated, got ${JSON.stringify(logs)}`,
  );
});

test("the debug port is configurable from the environment, and the profile follows the data directory", async () => {
  const browser = fakeBrowser();
  const { browserSpawns, probes, gatewayCalls, mcpCalls } = await runStart(
    {
      HOME: "/data",
      ZCLOUDIUM_BROWSER_PANEL: "1",
      ZCLOUDIUM_BROWSER_DEBUG_PORT: "9333",
      ZCODE_DATA_BASE_DIR: "/state",
    },
    { browser },
  );
  assert.equal(browserSpawns[0].args.includes("--remote-debugging-port=9333"), true);
  assert.equal(browserSpawns[0].args.includes("--user-data-dir=/state/browser-profile"), true);
  assert.deepEqual(probes.map((probe) => probe.debugUrl), ["http://127.0.0.1:9333"]);
  assert.equal(gatewayCalls[0].debugUrl, "http://127.0.0.1:9333");
  assert.equal(mcpCalls[0].entry.args[mcpCalls[0].entry.args.indexOf("--browserUrl") + 1], "http://127.0.0.1:9333");
});

test("a browser that never answers its debug port falls back to the launch shape and does not block the start", async () => {
  const browser = fakeBrowser();
  const { browserStops, gatewayCalls, mcpCalls, logs, spawns, child, exits } = await runStart(
    { HOME: "/data", ZCLOUDIUM_BROWSER_PANEL: "on" },
    { browser, probe: async () => ({ reachable: false }) },
  );

  assert.equal(spawns.length, 1, "the runtime must start whatever the browser does");
  assert.equal(mcpCalls[0].entry.args.includes("--browserUrl"), false);
  assert.deepEqual(mcpCalls[0].entry, browserServerEntry(), "the fallback is exactly the shape the image shipped before");
  assert.equal(gatewayCalls[0].debugUrl, null, "an unreachable port must not be proxied");
  assert.equal(browserStops.length, 1, "a browser nobody can attach to must not be left running");
  assert.equal(
    logs.some((line) => /did not answer|not reachable|falls back/i.test(line)),
    true,
    `the fallback must be stated, got ${JSON.stringify(logs)}`,
  );

  child.emit("exit", 0, null);
  await tick();
  assert.deepEqual(exits, [0], "the runtime still exits normally after the fallback");
});

test("the browser is stopped cleanly when the runtime exits", async () => {
  const browser = fakeBrowser();
  const { child, browserStops, exits, logs } = await runStart(
    { HOME: "/data", ZCLOUDIUM_BROWSER_PANEL: "on" },
    { browser },
  );

  child.emit("exit", 0, null);
  await tick();
  assert.deepEqual(exits, [0]);
  assert.equal(browserStops.length, 1, "the browser must not outlive the container");
  assert.equal(browserStops[0].child, browser);
  assert.equal(
    logs.some((line) => /browser stopped/i.test(line)),
    true,
    `the stop must be reported, got ${JSON.stringify(logs)}`,
  );
});

test("a shutdown signal stops the browser as well as the runtime", async () => {
  const browser = fakeBrowser();
  const { child, signals, browserStops } = await runStart(
    { HOME: "/data", ZCLOUDIUM_BROWSER_PANEL: "on" },
    { browser },
  );

  signals.signal("SIGTERM");
  await tick();
  assert.deepEqual(child.killed, ["SIGTERM"], "the runtime is forwarded the signal as before");
  assert.equal(browserStops.length, 1, "the browser is asked to stop on the same signal");
});

test("the browser profile is unlocked before the browser is launched", async () => {
  const browser = fakeBrowser();
  const { profilePreparations, browserSpawns } = await runStart(
    { HOME: "/data", ZCLOUDIUM_BROWSER_PANEL: "on" },
    { browser, prepare: async () => ({ status: "unlocked", target: "other-container-14" }) },
  );
  assert.deepEqual(profilePreparations.map((entry) => entry.dir), ["/data/browser-profile"]);
  assert.equal(browserSpawns.length, 1, "the browser is launched after the profile is prepared");
});

test("a profile that cannot be unlocked is reported and does not stop the panel", async () => {
  const browser = fakeBrowser();
  const { browserSpawns, probes, logs } = await runStart(
    { HOME: "/data", ZCLOUDIUM_BROWSER_PANEL: "on" },
    {
      browser,
      prepare: async () => {
        throw new Error("read-only profile");
      },
    },
  );
  assert.equal(browserSpawns.length, 1, "the browser is still launched, and Chromium decides");
  assert.equal(probes.length, 1);
  assert.equal(
    logs.some((line) => /read-only profile/.test(line)),
    true,
    `the failure must be reported, got ${JSON.stringify(logs)}`,
  );
});

test("with the browser MCP off there is nothing for the panel to attach to, so no browser starts", async () => {
  const { browserSpawns, probes, mcpCalls, gatewayCalls, logs } = await runStart({
    HOME: "/data",
    ZCLOUDIUM_BROWSER_PANEL: "on",
    ZCLOUDIUM_BROWSER_MCP: "off",
  });
  assert.deepEqual(browserSpawns, [], "no agent browser means no browser to launch");
  assert.deepEqual(probes, []);
  assert.deepEqual(mcpCalls, []);
  assert.equal(gatewayCalls[0].debugUrl, null);
  assert.equal(
    logs.some((line) => /panel.*browser MCP|browser MCP.*off/i.test(line)),
    true,
    `the interaction must be stated rather than silent, got ${JSON.stringify(logs)}`,
  );
});
