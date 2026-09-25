/**
 * Tests for the browser panel plumbing (gateway/lib/browser.mjs).
 *
 * Phase 0 answers one question: does the zero-code path already deliver the live
 * view, the viewport control, the picking and the DevTools? The module under
 * test is what the container needs to ask it: the Chromium launch arguments, the
 * decision between attaching to that browser and launching a private one, the
 * route classification behind the gateway, and the rewriting of the DevTools
 * discovery JSON.
 *
 * Everything here is a pure function or a function with its effects injected:
 * the browser itself is observed in a real container, not here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  BROWSER_DEBUG_ADDRESS,
  BROWSER_DEBUG_PORT,
  BROWSER_PREFIX,
  BROWSER_PROFILE_NAME,
  BROWSER_STOP_GRACE_MS,
  browserArgs,
  browserDebugUrl,
  browserProfileDir,
  classifyRoute,
  debugAuthority,
  debugPathFor,
  isDiscoveryPath,
  launchBrowser,
  parseBrowserDebugPort,
  parseBrowserPanel,
  proxyAuthorityFor,
  resolveBrowserMode,
  rewriteDiscovery,
  stopBrowser,
  waitForBrowser,
} from "../gateway/lib/browser.mjs";

test("the debug port is on loopback, on the pinned default", () => {
  assert.equal(BROWSER_DEBUG_PORT, 9222);
  assert.equal(BROWSER_DEBUG_ADDRESS, "127.0.0.1");
  assert.equal(browserDebugUrl(), "http://127.0.0.1:9222");
  assert.equal(browserDebugUrl(9333), "http://127.0.0.1:9333");
  assert.equal(BROWSER_PREFIX, "/_browser");
  assert.equal(BROWSER_PROFILE_NAME, "browser-profile");
});

test("the browser profile lives on the data volume, never in the image", () => {
  assert.equal(browserProfileDir("/data"), "/data/browser-profile");
  assert.equal(browserProfileDir("/srv/state"), "/srv/state/browser-profile");
  assert.equal(browserProfileDir("/data", "custom"), "/data/custom");
});

test("the launch arguments put the debug port on loopback and the profile on a volume", () => {
  const args = browserArgs({ userDataDir: "/data/browser-profile" });
  assert.deepEqual(args, [
    "--headless",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=9222",
    "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=/data/browser-profile",
    "about:blank",
  ]);
});

test("the debug port is configurable, and the address never leaves loopback", () => {
  const args = browserArgs({ userDataDir: "/data/p", port: 9333 });
  assert.equal(args.includes("--remote-debugging-port=9333"), true);
  assert.equal(args.includes("--remote-debugging-address=127.0.0.1"), true);
  // A published debug port would hand the browser to anyone who can reach the
  // host, and bypass the gateway: this test is the one that stops that.
  assert.equal(args.some((arg) => arg === "--remote-debugging-address=0.0.0.0"), false);
  assert.equal(BROWSER_DEBUG_ADDRESS, "127.0.0.1");
});

test("the launch arguments refuse to run without a profile directory", () => {
  // Without --user-data-dir Chromium writes to $HOME/.config, which is on the
  // read-only root filesystem: the browser would fail, or worse, half start.
  for (const broken of [undefined, null, "", "   "]) {
    assert.throws(() => browserArgs({ userDataDir: broken }), (error) => error instanceof Error, `userDataDir=${JSON.stringify(broken)}`);
  }
});

test("ZCLOUDIUM_BROWSER_PANEL is off unless it is explicitly asked for", () => {
  assert.equal(parseBrowserPanel(undefined), false, "the default is off: with the switch off nothing must change");
  assert.equal(parseBrowserPanel(null), false);
  assert.equal(parseBrowserPanel(""), false);
  assert.equal(parseBrowserPanel("   "), false);
  for (const value of ["off", "OFF", "0", "false", "no", "disabled", "onward"]) {
    assert.equal(parseBrowserPanel(value), false, `"${value}" must keep the panel off`);
  }
  for (const value of ["on", "ON", " on ", "true", "TRUE", "1", "yes"]) {
    assert.equal(parseBrowserPanel(value), true, `"${value}" must turn the panel on`);
  }
});

test("the debug port comes from the environment, and a typo keeps the default", () => {
  assert.equal(parseBrowserDebugPort(undefined), BROWSER_DEBUG_PORT);
  assert.equal(parseBrowserDebugPort(""), BROWSER_DEBUG_PORT);
  assert.equal(parseBrowserDebugPort("9333"), 9333);
  assert.equal(parseBrowserDebugPort(" 9333 "), 9333);
  for (const value of ["0", "-1", "65536", "abc", "9222.5", "1e999", "NaN", "9222h"]) {
    assert.equal(parseBrowserDebugPort(value), BROWSER_DEBUG_PORT, `"${value}" must fall back`);
  }
});

test("the fallback decision: attach only when the panel is on and the browser answers", () => {
  const url = "http://127.0.0.1:9222";
  assert.equal(resolveBrowserMode({ panelEnabled: true, debugUrl: url, reachable: true }), "attach");
  assert.equal(
    resolveBrowserMode({ panelEnabled: true, debugUrl: url, reachable: false }),
    "launch",
    "an unreachable debug port must fall back to the browser the MCP launches itself",
  );
  assert.equal(resolveBrowserMode({ panelEnabled: false, debugUrl: url, reachable: true }), "launch");
  assert.equal(resolveBrowserMode({ panelEnabled: false }), "launch");
  assert.equal(resolveBrowserMode({}), "launch");
  assert.equal(resolveBrowserMode({ panelEnabled: true, debugUrl: null, reachable: true }), "launch");
  assert.equal(resolveBrowserMode({ panelEnabled: true, debugUrl: "", reachable: true }), "launch");
});

test("waitForBrowser gives up after the deadline and reports the version it found", async () => {
  const asked = [];
  const answering = async (url) => {
    asked.push(url);
    return { ok: true, json: async () => ({ Browser: "Chrome/153.0.8010.52" }) };
  };
  const found = await waitForBrowser({ debugUrl: "http://127.0.0.1:9222", fetchImpl: answering });
  assert.equal(found.reachable, true);
  assert.equal(found.version.Browser, "Chrome/153.0.8010.52");
  assert.deepEqual(asked, ["http://127.0.0.1:9222/json/version"]);

  let attempts = 0;
  const slow = async () => {
    attempts += 1;
    throw new Error("ECONNREFUSED");
  };
  const started = Date.now();
  const missing = await waitForBrowser({ debugUrl: "http://127.0.0.1:9222", fetchImpl: slow, timeoutMs: 60, intervalMs: 20 });
  assert.equal(missing.reachable, false);
  assert.ok(attempts >= 2, `expected several attempts, got ${attempts}`);
  assert.ok(Date.now() - started >= 40, "the deadline must actually be waited out");

  // A port that answers but with an error status is not a usable debug port.
  const refusing = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal((await waitForBrowser({ debugUrl: "http://127.0.0.1:9222", fetchImpl: refusing, timeoutMs: 40, intervalMs: 20 })).reachable, false);
});

test("the browser is asked to stop, then killed, and the profile is written before that", async () => {
  assert.equal(BROWSER_STOP_GRACE_MS, 5_000);

  const polite = new EventEmitter();
  polite.killed = [];
  polite.kill = (signal) => {
    polite.killed.push(signal);
    if (signal === "SIGTERM") {
      setImmediate(() => polite.emit("exit", null, "SIGTERM"));
    }
    return true;
  };
  assert.equal(await stopBrowser(polite, { graceMs: 1000 }), "terminated");
  assert.deepEqual(polite.killed, ["SIGTERM"], "a browser that stops on SIGTERM must not be killed");

  const stubborn = new EventEmitter();
  stubborn.killed = [];
  stubborn.kill = (signal) => {
    stubborn.killed.push(signal);
    return true;
  };
  const logs = [];
  const outcome = await stopBrowser(stubborn, { graceMs: 20, logger: (line) => logs.push(line) });
  assert.equal(outcome, "killed");
  assert.deepEqual(stubborn.killed, ["SIGTERM", "SIGKILL"]);
  assert.equal(logs.some((line) => /SIGKILL|kill/i.test(line)), true, `the escalation must be reported, got ${JSON.stringify(logs)}`);

  const gone = new EventEmitter();
  gone.kill = () => {
    throw new Error("ESRCH");
  };
  assert.equal(await stopBrowser(gone, { graceMs: 10 }), "already-exited");
});

test("the browser is spawned on the image's Chromium, and its exit is reported", () => {
  const calls = [];
  const exits = [];
  const fake = new EventEmitter();
  const child = launchBrowser({
    args: ["--headless", "about:blank"],
    env: { HOME: "/data" },
    logger: () => {},
    spawnBrowser: (file, spawnArgs, options) => {
      calls.push({ file, spawnArgs, options });
      return fake;
    },
    onExit: (code, signal) => exits.push({ code, signal }),
  });
  assert.equal(child, fake);
  assert.equal(calls[0].file, "/usr/bin/chromium");
  assert.deepEqual(calls[0].spawnArgs, ["--headless", "about:blank"]);
  assert.equal(calls[0].options.stdio, "inherit", "the browser logs must reach the container logs");
  assert.deepEqual(calls[0].options.env, { HOME: "/data" });

  fake.emit("exit", null, "SIGKILL");
  assert.deepEqual(exits, [{ code: null, signal: "SIGKILL" }], "an unexpected browser exit must be reported");
});

test("the proxied authority comes from the Host header, and nothing else", () => {
  assert.equal(debugAuthority(), "127.0.0.1:9222");
  assert.equal(debugAuthority(9333), "127.0.0.1:9333");
  assert.equal(proxyAuthorityFor("panel.example:3030"), "panel.example:3030/_browser");
  assert.equal(proxyAuthorityFor("127.0.0.1:3030"), "127.0.0.1:3030/_browser");
  assert.equal(proxyAuthorityFor("[::1]:3030"), "[::1]:3030/_browser");
  assert.equal(proxyAuthorityFor(" panel.example:3030 "), "panel.example:3030/_browser");

  // A Host header is attacker controlled. It must not be able to add a path, a
  // newline, a userinfo section or a scheme to the document the frontend reads.
  for (const hostile of [undefined, null, "", "   ", "evil.example/../x", "evil.example x", "user:pass@host", "host\nSet-Cookie: x", "host/", "http://host"]) {
    assert.equal(proxyAuthorityFor(hostile), null, JSON.stringify(hostile));
  }
});

test("the route classification keeps the three prefixes apart", () => {
  assert.equal(classifyRoute("/_auth/login"), "auth");
  assert.equal(classifyRoute("/_auth"), "auth");
  assert.equal(classifyRoute("/_auth/health"), "auth");
  assert.equal(classifyRoute("/api/server-info"), "app");
  assert.equal(classifyRoute("/"), "app");
  assert.equal(classifyRoute("/ws"), "app");

  // With the panel off the gateway knows nothing about the browser, so the
  // prefix is ordinary application traffic: the off switch is total.
  assert.equal(classifyRoute("/_browser/json/version"), "app");
  assert.equal(classifyRoute("/_browser", { browserEnabled: false }), "app");

  assert.equal(classifyRoute("/_browser", { browserEnabled: true }), "browser");
  assert.equal(classifyRoute("/_browser/", { browserEnabled: true }), "browser");
  assert.equal(classifyRoute("/_browser/json/version", { browserEnabled: true }), "browser");
  assert.equal(classifyRoute("/_browser/devtools/inspector.html", { browserEnabled: true }), "browser");
  // A path that merely starts with the same letters is not the prefix.
  assert.equal(classifyRoute("/_browsers", { browserEnabled: true }), "app");
  assert.equal(classifyRoute("/_browserish/x", { browserEnabled: true }), "app");
});

test("the proxied path maps onto the debug endpoint, query string preserved", () => {
  assert.equal(debugPathFor("/_browser"), "/");
  assert.equal(debugPathFor("/_browser/"), "/");
  assert.equal(debugPathFor("/_browser/json/list"), "/json/list");
  assert.equal(debugPathFor("/_browser/json/version"), "/json/version");
  assert.equal(
    debugPathFor("/_browser/devtools/inspector.html", "?ws=panel.example:3030/_browser/devtools/page/ABC"),
    "/devtools/inspector.html?ws=panel.example:3030/_browser/devtools/page/ABC",
  );
  assert.equal(debugPathFor("/_browser/"), "/");
});

test("only the discovery documents are rewritten", () => {
  for (const path of ["/json", "/json/", "/json/list", "/json/version"]) {
    assert.equal(isDiscoveryPath(path), true, path);
  }
  for (const path of ["/", "/devtools/inspector.html", "/json/protocol", "/json/new", "/jsonish"]) {
    assert.equal(isDiscoveryPath(path), false, path);
  }
});

test("the discovery JSON points the frontend at the proxied path, not at loopback", () => {
  const body = JSON.stringify({
    webSocketDebuggerUrl: `ws://${BROWSER_DEBUG_ADDRESS}:${BROWSER_DEBUG_PORT}/devtools/browser/abc`,
    devtoolsFrontendUrl: `/devtools/inspector.html?ws=${BROWSER_DEBUG_ADDRESS}:${BROWSER_DEBUG_PORT}/devtools/browser/abc`,
    devtoolsFrontendUrlCompat: `../devtools/inspector.html?ws=${BROWSER_DEBUG_ADDRESS}:${BROWSER_DEBUG_PORT}/devtools/browser/abc`,
  });
  const rewritten = rewriteDiscovery(body, {
    authority: "127.0.0.1:9222",
    proxyAuthority: "panel.example:3030/_browser",
  });
  const parsed = JSON.parse(rewritten);
  assert.equal(parsed.webSocketDebuggerUrl, "ws://panel.example:3030/_browser/devtools/browser/abc");
  assert.equal(parsed.devtoolsFrontendUrl, "/devtools/inspector.html?ws=panel.example:3030/_browser/devtools/browser/abc");
  assert.equal(parsed.devtoolsFrontendUrlCompat, "../devtools/inspector.html?ws=panel.example:3030/_browser/devtools/browser/abc");
  assert.equal(rewritten.includes("127.0.0.1:9222"), false, "the frontend must not be told to reach loopback");
});

test("the target list keeps its shape while every target is re-pointed", () => {
  const list = JSON.stringify([
    { id: "8B04", type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/8B04" },
    { id: "1376", type: "iframe", url: "about:blank", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1376" },
  ]);
  const parsed = JSON.parse(rewriteDiscovery(list, { authority: "127.0.0.1:9222", proxyAuthority: "panel.example:3030/_browser" }));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, "8B04");
  assert.equal(parsed[0].url, "about:blank");
  assert.equal(parsed[0].webSocketDebuggerUrl, "ws://panel.example:3030/_browser/devtools/page/8B04");
  assert.equal(parsed[1].webSocketDebuggerUrl, "ws://panel.example:3030/_browser/devtools/page/1376");
});

test("a body that does not mention the debug endpoint is returned untouched", () => {
  for (const body of ['{"ok":true}', "", "not json at all", '{"protocol":{"domains":[]}}']) {
    assert.equal(
      rewriteDiscovery(body, { authority: "127.0.0.1:9222", proxyAuthority: "panel.example:3030/_browser" }),
      body,
      "the rewriting must be a no-op when there is nothing to rewrite",
    );
  }
  // And an unrelated mention of another host must survive as is.
  const other = '{"webSocketDebuggerUrl":"ws://127.0.0.1:9229/devtools/browser/x"}';
  assert.equal(rewriteDiscovery(other, { authority: "127.0.0.1:9222", proxyAuthority: "panel.example:3030/_browser" }), other);
});
