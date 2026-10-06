/**
 * Tests for the container entrypoint (gateway/start.mjs).
 *
 * They cover what can be checked without the real runtime: the environment
 * parsing, the argument construction, and the supervision of the child process
 * (signal forwarding, exit code).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
    tls: true,
    tlsHosts: [],
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

test("TLS is on unless it is turned off, and only an explicit value turns it off", () => {
  assert.equal(parseEnv({}).tls, true, "https is the default: nobody should have to ask for an encrypted connection");
  assert.equal(parseEnv({ ZCLOUDIUM_TLS: "maybe" }).tls, true, "a typo must not downgrade the connection");
  assert.deepEqual(parseEnv({ ZCLOUDIUM_TLS_HOSTS: "192.168.51.224, nas.local" }).tlsHosts, ["192.168.51.224", "nas.local"]);
  for (const value of ["off", "OFF", "0", "no", "false", "disabled"]) {
    assert.equal(parseEnv({ ZCLOUDIUM_TLS: value }).tls, false, `"${value}" turns it off, for a proxy in front`);
  }
  for (const value of ["on", "true", "1", "yes", " ON "]) {
    assert.equal(parseEnv({ ZCLOUDIUM_TLS: value }).tls, true, `"${value}"`);
  }
});

test("with TLS on, the certificate is loaded before the gateway and handed to it", async () => {
  const asked = [];
  const { gatewayCalls, logs } = await runStart(
    { HOME: "/data", ZCLOUDIUM_TLS: "on" },
    {
      certificate: async (options) => {
        asked.push(options);
        return { cert: "fake certificate", key: "fake key" };
      },
    },
  );
  assert.equal(asked.length, 1, "the certificate must be loaded exactly once");
  assert.equal(asked[0].dataDir, "/data", "it lives on the data volume, so it survives a restart");
  assert.deepEqual(
    gatewayCalls[0].tls,
    { cert: "fake certificate", key: "fake key" },
    "the gateway must serve the certificate that was loaded",
  );
  assert.equal(
    logs.some((line) => /listening on https:\/\//.test(line)),
    true,
    `the startup line has to say https, got ${JSON.stringify(logs.filter((l) => /listening/.test(l)))}`,
  );
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
    tls: true,
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
 */
async function runStart(
  env,
  {
    gateway = null,
    argv = ["node", "/opt/cloudium/gateway/start.mjs"],
    certificate = async () => ({ cert: "fake certificate", key: "fake key" }),
  } = {},
) {
  const child = fakeChild();
  const spawns = [];
  const signals = fakeProcess();
  const exits = [];
  const gatewayCalls = [];
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
    // The real one would call openssl, which the unit container does not have:
    // what the tests check is the wiring, and a real container run checks the rest.
    loadOrCreateCertificateFn: (options) => certificate(options),
    onExit: (code) => exits.push(code),
  });

  return {
    result,
    child,
    spawns,
    signals,
    exits,
    gatewayCalls,
    logs,
  };
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
        tls: { cert: "fake certificate", key: "fake key" },
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
