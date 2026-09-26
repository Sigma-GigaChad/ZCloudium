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
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
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
  debugPathFor,
  isAcceptableOrigin,
  isDiscoveryPath,
  isStaleSingletonLock,
  launchBrowser,
  normalizeAuthority,
  parseBrowserDebugPort,
  parseBrowserPanel,
  prepareBrowserProfile,
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

test("ZCLOUDIUM_BROWSER_PANEL is on unless it is explicitly turned off", () => {
  assert.equal(parseBrowserPanel(undefined), true, "the default is on: the browser is the point of the tool");
  assert.equal(parseBrowserPanel(null), true);
  assert.equal(parseBrowserPanel(""), true);
  assert.equal(parseBrowserPanel("   "), true);
  // An unclear value keeps the default rather than taking the feature away by
  // accident, which is the rule the browser MCP switch already follows.
  assert.equal(parseBrowserPanel("onward"), true);
  for (const value of ["off", "OFF", " off ", "0", "false", "no", "disabled"]) {
    assert.equal(parseBrowserPanel(value), false, `"${value}" must turn the panel off`);
  }
  for (const value of ["on", "ON", " on ", "true", "TRUE", "1", "yes"]) {
    assert.equal(parseBrowserPanel(value), true, `"${value}" must keep the panel on`);
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

/**
 * The Origin check for the browser route.
 *
 * The debug port is a control channel for a browser that holds the agent's
 * sessions. A session cookie is not enough to open it: any other service on the
 * operator's loopback is same-site, so its cookies are attached, and without an
 * Origin check a page served by one of those services could take the browser
 * over. The check is therefore on the gateway, and the browser's own guard stays
 * closed behind it.
 */
test("a request from another origin is refused, and one from this origin is not", () => {
  const host = "127.0.0.1:3041";
  assert.equal(isAcceptableOrigin("http://127.0.0.1:3041", host), true, "the frontend served here is this origin");
  assert.equal(isAcceptableOrigin("http://127.0.0.1:3041", "panel.example:3041"), false, "another name is another origin");
  assert.equal(isAcceptableOrigin("http://127.0.0.1:3038", host), false, "another service on loopback is another origin");
  assert.equal(isAcceptableOrigin("https://127.0.0.1:3041", host), false, "another scheme is another origin");
  assert.equal(isAcceptableOrigin("https://127.0.0.1:3041", host, { secure: true }), true);
  assert.equal(isAcceptableOrigin("http://127.0.0.1:3041", host, { secure: true }), false);
  assert.equal(isAcceptableOrigin("http://evil.example", host), false);
});

test("an absent Origin is allowed, because only a browser context sends one", () => {
  for (const absent of [undefined, null, "", "   "]) {
    assert.equal(isAcceptableOrigin(absent, "127.0.0.1:3041"), true, JSON.stringify(absent));
  }
});

/**
 * The TLS terminating proxy, which is a deployment README.md recommends.
 *
 * Behind that proxy the browser sends an `https` Origin while the gateway
 * serializes `http`, so the check above refuses the panel in a setup this project
 * documents as normal. The flag that already means "a proxy I control is in front"
 * is the one that says so, and it only ever adds the `https` variant of the
 * request's own authority: the authority must still match exactly.
 */
test("behind a trusted proxy an https Origin of this exact authority is accepted, and nothing else is", () => {
  const host = "panel.example:3041";

  // Off is the default, and off is exactly the behaviour before the flag existed.
  assert.equal(isAcceptableOrigin("https://panel.example:3041", host), false, "the flag is off unless it is asked for");
  assert.equal(isAcceptableOrigin("https://panel.example:3041", host, { trustProxy: false }), false);

  // On, with the same authority: the proxy terminated TLS, so the page is https
  // while the socket the gateway sees is not.
  assert.equal(isAcceptableOrigin("https://panel.example:3041", host, { trustProxy: true }), true);
  // The port is part of the authority, so another port is another origin.
  assert.equal(isAcceptableOrigin("https://panel.example:3042", host, { trustProxy: true }), false);
  assert.equal(isAcceptableOrigin("https://panel.example", host, { trustProxy: true }), false, "the default port is not this one");
  assert.equal(isAcceptableOrigin("https://evil.example", host, { trustProxy: true }), false);
  assert.equal(isAcceptableOrigin("https://127.0.0.1:3041", host, { trustProxy: true }), false, "another name is another origin");

  // The plain http path is unchanged, with the flag on or off.
  assert.equal(isAcceptableOrigin("http://panel.example:3041", host, { trustProxy: true }), true);
  assert.equal(isAcceptableOrigin("http://panel.example:3042", host, { trustProxy: true }), false);

  // A socket that really is TLS already accepts https: the flag adds nothing there.
  assert.equal(isAcceptableOrigin("https://panel.example:3041", host, { secure: true, trustProxy: true }), true);
  assert.equal(isAcceptableOrigin("http://panel.example:3041", host, { secure: true, trustProxy: true }), false, "a https socket is not this origin's http");

  // Everything the check refused before it is still refused.
  assert.equal(isAcceptableOrigin("null", host, { trustProxy: true }), false);
  assert.equal(isAcceptableOrigin("https://panel.example:3041/", host, { trustProxy: true }), false);
  assert.equal(isAcceptableOrigin("https://panel.example:3041", "host name", { trustProxy: true }), false);
  assert.equal(isAcceptableOrigin("https://panel.example:3041", undefined, { trustProxy: true }), false);
  // And a client that is not a page still carries no Origin at all.
  assert.equal(isAcceptableOrigin(undefined, host, { trustProxy: true }), true);
});

/**
 * The spelling of the authority, which is where a browser and a reverse proxy
 * disagree.
 *
 * A browser lower cases the host in the Origin header and never writes a port
 * that is the scheme's default. A reverse proxy writes the Host header from its
 * own configuration, and `proxy_set_header Host $host:$server_port` on an https
 * server appends `:443`, which is the default for https and invisible in the
 * origin. Comparing the two without normalising them refuses a deployment the
 * README recommends, with the trust flag on or off.
 */
test("the authority is normalised the way an origin spells it", () => {
  assert.equal(normalizeAuthority("panel.example:3041"), "panel.example:3041");
  assert.equal(normalizeAuthority("PANEL.EXAMPLE:3041"), "panel.example:3041", "an origin lower cases the host");
  assert.equal(normalizeAuthority("Panel.Example"), "panel.example");
  assert.equal(normalizeAuthority("panel.example:80"), "panel.example", "80 is the default for http");
  assert.equal(normalizeAuthority("panel.example:443"), "panel.example:443", "443 is not the default for http");
  assert.equal(normalizeAuthority("panel.example:443", "https:"), "panel.example", "443 is the default for https");
  assert.equal(normalizeAuthority("panel.example:8443", "https:"), "panel.example:8443");
  assert.equal(normalizeAuthority("panel.example", "https:"), "panel.example");
  assert.equal(normalizeAuthority("127.0.0.1:3030"), "127.0.0.1:3030");
  assert.equal(normalizeAuthority("[::1]:3041"), "[::1]:3041");
  assert.equal(normalizeAuthority("[::1]:443", "https:"), "[::1]");
  assert.equal(normalizeAuthority("[::1]:80"), "[::1]");
  assert.equal(normalizeAuthority("[::1]"), "[::1]");
  assert.equal(normalizeAuthority("  panel.example:3041  "), "panel.example:3041", "a Host header may carry spaces around it");

  // The same refusal as before: nothing that is not an authority gets through,
  // because the result still ends up in a comparison against an origin.
  for (const hostile of [undefined, null, "", "   ", "evil.example/../x", "evil.example x", "user:pass@host", "host\nSet-Cookie: x", "host/", "http://host", "panel.example:"]) {
    assert.equal(normalizeAuthority(hostile), null, JSON.stringify(hostile));
  }
});

test("the same origin in another spelling is still the same origin", () => {
  // The ordinary reverse proxy case: it maps its own port (443, the https
  // default) onto the container's Host while the browser sends no port at all.
  assert.equal(isAcceptableOrigin("https://panel.example", "panel.example:443", { trustProxy: true }), true);
  assert.equal(isAcceptableOrigin("https://panel.example", "PANEL.EXAMPLE:443", { trustProxy: true }), true);
  // An uppercase host on either side, and an explicit default port in the origin.
  assert.equal(isAcceptableOrigin("http://PANEL.EXAMPLE:3041", "panel.example:3041"), true);
  assert.equal(isAcceptableOrigin("http://panel.example:80", "panel.example"), true);
  assert.equal(isAcceptableOrigin("https://PANEL.EXAMPLE:443", "panel.example", { trustProxy: true }), true);
  // A real TLS socket already accepted the https variant, and still does.
  assert.equal(isAcceptableOrigin("https://panel.example:443", "panel.example:443", { secure: true }), true);

  // A port that is not the scheme's default is still a different origin, on
  // either side of the comparison.
  assert.equal(isAcceptableOrigin("https://panel.example", "panel.example:3041", { trustProxy: true }), false);
  assert.equal(isAcceptableOrigin("https://panel.example:3041", "panel.example", { trustProxy: true }), false);
  assert.equal(isAcceptableOrigin("http://panel.example:3041", "panel.example:80"), false);
  // And another name is still another origin, whatever the ports say.
  assert.equal(isAcceptableOrigin("https://evil.example", "panel.example:443", { trustProxy: true }), false);
  assert.equal(isAcceptableOrigin("https://panel.example.evil.example", "panel.example:443", { trustProxy: true }), false);

  // The shape check is not loosened by any of this: a trailing slash, a query, a
  // fragment or a userinfo section is not an origin.
  for (const odd of ["http://panel.example/", "http://panel.example:80/", "http://panel.example?x=1", "http://panel.example#a", "http://user:pass@panel.example", "null", "panel.example:443"]) {
    assert.equal(isAcceptableOrigin(odd, "panel.example:443", { trustProxy: true }), false, odd);
  }
});

test("an Origin that is not a plain origin is refused, and a broken Host refuses everything", () => {
  const host = "127.0.0.1:3041";
  for (const odd of ["null", "http://127.0.0.1:3041/", "http://127.0.0.1:3041?x=1", "not an origin", "127.0.0.1:3041"]) {
    assert.equal(isAcceptableOrigin(odd, host), false, odd);
  }
  for (const brokenHost of [undefined, null, "", "   ", "host name", "user:pass@host"]) {
    assert.equal(isAcceptableOrigin("http://127.0.0.1:3041", brokenHost), false, `host ${JSON.stringify(brokenHost)}`);
    assert.equal(isAcceptableOrigin(undefined, brokenHost), true, "with no Origin there is no browser context to judge");
  }
});

/**
 * The profile lock Chromium leaves behind.
 *
 * Chromium refuses to start on a profile whose `SingletonLock` names another
 * machine: that is what a container that was removed while running leaves in the
 * data volume, and it made the panel fall back to the launch shape on the next
 * start until the lock was removed by hand. The lock is a symlink named
 * `<hostname>-<pid>`, so a lock from another container is stale by construction.
 */
test("a profile lock left by another container is recognised as stale", () => {
  assert.equal(isStaleSingletonLock("6a9023f985d6-14", { hostname: "6a9023f985d6" }), false, "our own browser");
  assert.equal(isStaleSingletonLock("ee00d4e93237-14", { hostname: "6a9023f985d6" }), true, "a previous container");
  assert.equal(isStaleSingletonLock(`${hostname()}-1234`), false, "the default hostname is this one");
  assert.equal(isStaleSingletonLock("ee00d4e93237-14"), true);
  for (const odd of [undefined, null, "", "no-pid", "host-not-a-number", "/tmp/org.chromium.Chromium/SingletonSocket", 42]) {
    assert.equal(isStaleSingletonLock(odd, { hostname: "6a9023f985d6" }), false, `${JSON.stringify(odd)} must be left alone`);
  }
});

test("a stale lock is released, our own is left alone, and the profile content survives", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcloudium-profile-"));
  const profile = join(root, "browser-profile");
  try {
    await mkdir(profile);
    await writeFile(join(profile, "Preferences"), "the operator's cookies live around here");
    for (const name of ["SingletonSocket", "SingletonCookie"]) {
      await writeFile(join(profile, name), "");
    }
    await symlink("ee00d4e93237-14", join(profile, "SingletonLock"));

    const logs = [];
    const released = await prepareBrowserProfile(profile, { hostname: "6a9023f985d6", logger: (line) => logs.push(line) });
    assert.equal(released.status, "unlocked");
    assert.equal(released.target, "ee00d4e93237-14");
    assert.deepEqual((await readdir(profile)).sort(), ["Preferences"], "only the lock files may go");
    assert.equal(logs.some((line) => /ee00d4e93237-14/.test(line)), true, "the unlock must be reported");

    await symlink("6a9023f985d6-14", join(profile, "SingletonLock"));
    const kept = await prepareBrowserProfile(profile, { hostname: "6a9023f985d6" });
    assert.equal(kept.status, "kept", "a lock naming this container may be a browser that is still running");
    assert.equal((await readdir(profile)).includes("SingletonLock"), true);

    // Nothing to unlock, and nothing that is not a symlink is ever removed.
    await rm(join(profile, "SingletonLock"));
    assert.equal((await prepareBrowserProfile(profile, { hostname: "6a9023f985d6" })).status, "no-lock");
    await writeFile(join(profile, "SingletonLock"), "not a symlink");
    assert.equal((await prepareBrowserProfile(profile, { hostname: "6a9023f985d6" })).status, "no-lock");
    assert.equal((await readdir(profile)).includes("SingletonLock"), true, "an unknown file is never deleted");
  } finally {
    await rm(root, { recursive: true, force: true });
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
  assert.equal(classifyRoute("/_browser/", { browserEnabled: false }), "app");

  // With it on, the prefix root is the panel page the gateway serves itself, and
  // everything below it is proxied to the debug port.
  assert.equal(classifyRoute("/_browser", { browserEnabled: true }), "panel");
  assert.equal(classifyRoute("/_browser/", { browserEnabled: true }), "panel");
  assert.equal(classifyRoute("/_browser/json/version", { browserEnabled: true }), "browser");
  assert.equal(classifyRoute("/_browser/json/list", { browserEnabled: true }), "browser");
  assert.equal(classifyRoute("/_browser/devtools/inspector.html", { browserEnabled: true }), "browser");
  assert.equal(classifyRoute("/_browser/devtools/page/8B04", { browserEnabled: true }), "browser");
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
