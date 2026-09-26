/**
 * The viewport owner, against a fake engine.
 *
 * What is under test here is not that Chromium resizes a page: the end to end
 * suite measures that from the page itself. It is the ownership rules that make
 * the resize survive the panel closing, which is the bug this module exists for
 * (issue #9):
 *
 * - the connection is opened once, lazily, and kept;
 * - the protocol call goes on a session the owner never detaches, and it is sent
 *   again even when the numbers did not change, because the panel's Apply button
 *   has to work the second time it is pressed;
 * - a size the operator chose is put back when the panel comes back, and only
 *   when the page actually drifted;
 * - a page nobody resized is left alone, which is what makes opening the panel
 *   change nothing.
 *
 * The real behaviour these rules were derived from was measured on the pinned
 * Chromium before the module was written: an override dies with the session that
 * posed it, and a session that poses replaces the override for the whole page.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PLAYWRIGHT_CANDIDATES, absoluteHttpUrl, createPageOwner, resolvePlaywright } from "../gateway/lib/page-owner.mjs";

/**
 * A browser that answers like the debug port, and records what it was asked.
 *
 * Each page spec is live: a test that wants the page to report another size
 * writes `spec.reported`, which is exactly what a wipe by another session looks
 * like from the owner's side.
 */
function fakeBrowser({ pages = [{ targetId: "AB", reported: "800x600" }] } = {}) {
  const events = [];
  const sessions = [];
  const pageObjects = pages.map((spec) => ({
    spec,
    isClosed: () => Boolean(spec.closed),
    evaluate: async () => spec.reported,
    goto: async (url) => {
      (spec.visited ??= []).push(url);
      spec.url = url;
    },
    goBack: async () => {
      (spec.moves ??= []).push("back");
    },
    goForward: async () => {
      (spec.moves ??= []).push("forward");
    },
    reload: async () => {
      (spec.moves ??= []).push("reload");
    },
    url: () => spec.url ?? "about:blank",
  }));

  const context = {
    pages: () => pageObjects.filter((page) => !page.isClosed()),
    newCDPSession: async (page) => {
      const session = {
        targetId: page.spec.targetId,
        sent: [],
        send: async (method, params) => {
          if (method === "Target.getTargetInfo") {
            return { targetInfo: { targetId: page.spec.targetId } };
          }
          session.sent.push({ method, params });
          return {};
        },
      };
      sessions.push(session);
      events.push({ type: "session", targetId: page.spec.targetId });
      return session;
    },
  };
  const browser = {
    contexts: () => [context],
    newContext: async () => context,
    close: async () => {
      events.push({ type: "close" });
    },
  };
  const engine = {
    connectOverCDP: async (url) => {
      events.push({ type: "connect", url });
      return browser;
    },
  };
  return { engine, events, sessions, specs: pages };
}

function ownerFor(browser, options = {}) {
  return createPageOwner({
    debugUrl: "http://127.0.0.1:9222",
    engine: browser.engine,
    ...options,
  });
}

const metricsCalls = (session) => session.sent.filter((call) => call.method === "Emulation.setDeviceMetricsOverride");

test("the connection is opened on the first call, not when the owner is created", async () => {
  const browser = fakeBrowser();
  const owner = ownerFor(browser);
  assert.deepEqual(browser.events, [], "creating the owner must not talk to the browser");
  assert.equal(owner.state().connected, false);

  await owner.apply({ targetId: "AB", width: 800, height: 600 });
  assert.deepEqual(browser.events, [
    { type: "connect", url: "http://127.0.0.1:9222" },
    { type: "session", targetId: "AB" },
  ]);
  assert.equal(owner.state().connected, true);

  await owner.apply({ targetId: "AB", width: 640, height: 480 });
  assert.equal(browser.events.filter((event) => event.type === "connect").length, 1, "one connection for the life of the owner");
  assert.equal(browser.events.filter((event) => event.type === "session").length, 1, "one session per page, reused");
});

test("applying poses the override on the owner's session and reports what the page says", async () => {
  const browser = fakeBrowser();
  const owner = ownerFor(browser);
  const answer = await owner.apply({ targetId: "AB", width: 1366, height: 768 });
  assert.deepEqual(answer, { width: 1366, height: 768, reported: "800x600" });
  assert.deepEqual(metricsCalls(browser.sessions[0]), [
    { method: "Emulation.setDeviceMetricsOverride", params: { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false } },
  ]);
  assert.deepEqual(owner.state().desired, [{ targetId: "AB", width: 1366, height: 768 }]);
});

test("the same size is sent again, because a second press of Apply must work", async () => {
  const browser = fakeBrowser();
  const owner = ownerFor(browser);
  await owner.apply({ targetId: "AB", width: 800, height: 600 });
  await owner.apply({ targetId: "AB", width: 800, height: 600 });
  assert.equal(metricsCalls(browser.sessions[0]).length, 2, "an override can be cleared by something else, so it is re-sent");
});

test("the size is clamped on the bounds the panel shows", async () => {
  const browser = fakeBrowser();
  const owner = ownerFor(browser);
  const answer = await owner.apply({ targetId: "AB", width: 5000, height: 100 });
  assert.deepEqual({ width: answer.width, height: answer.height }, { width: 3840, height: 320 });
  assert.deepEqual(metricsCalls(browser.sessions[0])[0].params, { width: 3840, height: 320, deviceScaleFactor: 1, mobile: false });
});

test("a size the operator chose is put back when the panel comes back, and only when the page drifted", async () => {
  const browser = fakeBrowser();
  const owner = ownerFor(browser);
  const spec = browser.specs[0];
  await owner.apply({ targetId: "AB", width: 800, height: 600 });

  // The page is at the wanted size: attaching changes nothing.
  browser.sessions[0].sent.length = 0;
  const settled = await owner.attach({ targetId: "AB" });
  assert.equal(settled.restored, false);
  assert.deepEqual({ width: settled.width, height: settled.height }, { width: 800, height: 600 });
  assert.equal(metricsCalls(browser.sessions[0]).length, 0, "a page already at the right size is not touched");

  // Another session posed its own override and detached: the page falls back to
  // the window size, which is the drift the attach has to repair.
  spec.reported = "780x493";
  const restored = await owner.attach({ targetId: "AB" });
  assert.equal(restored.restored, true);
  assert.deepEqual({ width: restored.width, height: restored.height }, { width: 800, height: 600 });
  assert.equal(metricsCalls(browser.sessions[0]).length, 1, "the operator's size is posed again");
});

test("a page nobody resized is left alone when the panel opens", async () => {
  const browser = fakeBrowser();
  const owner = ownerFor(browser);
  const answer = await owner.attach({ targetId: "AB" });
  assert.deepEqual(answer, { restored: false, targetId: "AB", reported: "800x600" });
  assert.deepEqual(browser.sessions[0].sent, [], "opening the panel must change nothing on a page nobody resized");
});

test("releasing stops forcing a target without touching its page", async () => {
  const browser = fakeBrowser();
  const owner = ownerFor(browser);
  const spec = browser.specs[0];
  await owner.apply({ targetId: "AB", width: 800, height: 600 });
  assert.deepEqual(owner.release({ targetId: "AB" }), { released: true });
  assert.deepEqual(owner.state().desired, []);
  assert.equal(owner.release({ targetId: "AB" }).released, false, "releasing twice is not an error");

  // The page drifted afterwards, and coming back does not put the size back: the
  // panel moved away from this target, which is not the same as closing on it.
  spec.reported = "780x493";
  browser.sessions[0].sent.length = 0;
  const again = await owner.attach({ targetId: "AB" });
  assert.equal(again.restored, false);
  assert.equal(metricsCalls(browser.sessions[0]).length, 0);
});

test("a target the browser does not list has no page to pose a viewport on", async () => {
  const browser = fakeBrowser();
  const owner = ownerFor(browser);
  await assert.rejects(() => owner.apply({ targetId: "GONE", width: 800, height: 600 }), /no page target/);
  assert.deepEqual(owner.state().desired, [], "a size is only remembered once it was posed");
});

test("a page that closed is forgotten instead of pinning a stale session", async () => {
  const browser = fakeBrowser();
  const owner = ownerFor(browser);
  const spec = browser.specs[0];
  await owner.apply({ targetId: "AB", width: 800, height: 600 });
  spec.closed = true;
  // There is nothing left to pose on, and the answer says so rather than
  // pretending the size was restored. The size stays remembered for the target id
  // it was posed on, which a new page does not reuse.
  const answer = await owner.attach({ targetId: "AB" });
  assert.deepEqual(answer, { restored: false, targetId: "AB", reported: null });
  assert.deepEqual(owner.state().desired, [{ targetId: "AB", width: 800, height: 600 }]);
  await assert.rejects(() => owner.apply({ targetId: "AB", width: 640, height: 480 }), /no page target/);
});

test("a browser that stops answering fails the call instead of hanging", async () => {
  const stalling = createPageOwner({
    debugUrl: "http://127.0.0.1:9222",
    engine: {
      connectOverCDP: async () => ({
        contexts: () => [
          {
            pages: () => [{ isClosed: () => false, evaluate: async () => "800x600" }],
            newCDPSession: async () => ({
              send: async (method) => {
                if (method === "Target.getTargetInfo") {
                  return { targetInfo: { targetId: "AB" } };
                }
                // A session whose send never answers stands in for a browser that
                // stopped talking, which the operator sees as a stuck Apply button.
                return new Promise(() => {});
              },
            }),
          },
        ],
        close: async () => {},
      }),
    },
    timeoutMs: 30,
  });
  await assert.rejects(() => stalling.apply({ targetId: "AB", width: 800, height: 600 }), /did not answer within 30 ms/);
});

test("closing detaches from the browser, and the next call connects again", async () => {
  const browser = fakeBrowser();
  const owner = ownerFor(browser);
  await owner.apply({ targetId: "AB", width: 800, height: 600 });
  await owner.close();
  assert.deepEqual(browser.events.at(-1), { type: "close" });
  assert.equal(owner.state().connected, false);

  await owner.apply({ targetId: "AB", width: 640, height: 480 });
  assert.equal(browser.events.filter((event) => event.type === "connect").length, 2, "a closed owner reconnects rather than throwing");
});

test("an owner without a debug url is refused at construction", () => {
  assert.throws(() => createPageOwner({}), /requires a debugUrl/);
  assert.throws(() => createPageOwner({ debugUrl: "  " }), /requires a debugUrl/);
});

test("the address bar takes a bare host, and only http and https", () => {
  // What people type: a host, with or without a path.
  assert.equal(absoluteHttpUrl("trip.com"), "https://trip.com/");
  assert.equal(absoluteHttpUrl("  trip.com/hotels?x=1  "), "https://trip.com/hotels?x=1");
  assert.equal(absoluteHttpUrl("www.trip.com"), "https://www.trip.com/");
  // Loopback is the one host that is never served over https.
  assert.equal(absoluteHttpUrl("localhost:3030"), "http://localhost:3030/");
  assert.equal(absoluteHttpUrl("127.0.0.1:9222/json/list"), "http://127.0.0.1:9222/json/list");
  assert.equal(absoluteHttpUrl("[::1]:3030"), "http://[::1]:3030/");
  assert.equal(absoluteHttpUrl("http://example.test/a"), "http://example.test/a");
  assert.equal(absoluteHttpUrl("https://example.test"), "https://example.test/");

  for (const refused of [
    // The desktop pane also takes these, and this one does not on purpose: a data
    // page or a file from the container is indistinguishable from a site inside
    // the panel, and a session holder already reaches both through the agent.
    "file:///etc/passwd",
    "data:text/html,<h1>hi</h1>",
    "about:blank",
    "javascript:alert(1)",
    "chrome://settings",
    // No scheme and no host: a search term is not an address.
    "how do magnets work",
    "",
    "   ",
    "/workspace/notes.md",
    "https://",
    null,
    undefined,
    42,
  ]) {
    assert.equal(absoluteHttpUrl(refused), null, JSON.stringify(refused));
  }
});

test("navigating goes to the page, with the address this module validated", async () => {
  const browser = fakeBrowser();
  const owner = ownerFor(browser);
  const answer = await owner.navigate({ targetId: "AB", url: "trip.com" });
  assert.deepEqual(answer, { url: "https://trip.com/", reported: "800x600" });
  assert.deepEqual(browser.specs[0].visited, ["https://trip.com/"]);
  // An address the browser cannot be given is refused before anything is asked of
  // the page, which is the second of the two checks: the server refuses first.
  await assert.rejects(() => owner.navigate({ targetId: "AB", url: "file:///etc/passwd" }), /only http and https/);
  assert.deepEqual(browser.specs[0].visited, ["https://trip.com/"]);
});

test("back, forward and reload are three directions of the same call", async () => {
  const browser = fakeBrowser();
  const owner = ownerFor(browser);
  const spec = browser.specs[0];
  await owner.history({ targetId: "AB", direction: "back" });
  await owner.history({ targetId: "AB", direction: "forward" });
  await owner.history({ targetId: "AB", direction: "reload" });
  assert.deepEqual(spec.moves, ["back", "forward", "reload"]);
  await assert.rejects(() => owner.history({ targetId: "AB", direction: "sideways" }), /unknown history direction/);
});

test("playwright-core is looked for where the image keeps it, then by name", () => {
  assert.deepEqual(PLAYWRIGHT_CANDIDATES, ["/opt/zcodium/agent/node_modules/playwright-core", "playwright-core"]);

  // What comes back is the chromium object, not the module that carries it: a
  // caller poses a viewport with `chromium.connectOverCDP`, and handing back the
  // module makes that undefined. The end to end suite caught exactly that.
  const engine = { connectOverCDP: () => {} };
  const seen = [];
  assert.equal(
    resolvePlaywright({
      load: (id) => {
        seen.push(id);
        return { chromium: engine };
      },
    }),
    engine,
  );
  assert.deepEqual(seen, ["/opt/zcodium/agent/node_modules/playwright-core"]);

  // A module that loads but carries no chromium is not a candidate, and the
  // failure names every path that was tried.
  assert.throws(
    () =>
      resolvePlaywright({
        load: (id) => {
          if (id === PLAYWRIGHT_CANDIDATES[0]) {
            return {};
          }
          throw new Error("Cannot find module");
        },
      }),
    (error) => /no chromium export/.test(error.message) && /Cannot find module/.test(error.message),
  );

  // The bare name is reached when the runtime's copy is not there.
  const second = { connectOverCDP: () => {} };
  assert.equal(
    resolvePlaywright({
      load: (id) => {
        if (id === PLAYWRIGHT_CANDIDATES[0]) {
          throw new Error("Cannot find module");
        }
        return { chromium: second };
      },
    }),
    second,
  );
});
