/**
 * Tests for the operator panel (gateway/lib/panel.mjs).
 *
 * The panel is the one page that owns the live view and the viewport control
 * together, because the DevTools frontend Chromium serves gives one or the other
 * and never both (Phase 0). Everything here is a pure function: the CDP message
 * builders, the canvas to viewport scaling, the viewport bounds, the target list,
 * the paths the page builds, and the page itself.
 *
 * The canvas painting and the input injection are not unit testable and are not
 * pretended to be: they are verified in a real browser and covered end to end.
 * What is testable is the arithmetic and the shape of what goes on the wire, and
 * that is what these tests pin.
 *
 * The one test that matters most is the last one: the helpers the served page
 * runs are the functions tested here, executed from the page's own script block.
 * A helper that drifts between the module and the page fails there.
 */

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  DEFAULT_VIEWPORT,
  PANEL_PREFIX,
  SCREENCAST_MAX_HEIGHT,
  SCREENCAST_MAX_WIDTH,
  SCREENCAST_QUALITY,
  VIEWPORT_MAX_HEIGHT,
  VIEWPORT_MAX_WIDTH,
  VIEWPORT_MIN,
  buttonName,
  canvasToViewport,
  clampViewport,
  deviceMetricsParams,
  devtoolsUrlFor,
  inputViewport,
  keyCommands,
  keyUpCommands,
  mouseParams,
  panelPage,
  panelTargets,
  screencastParams,
  socketUrlFor,
  viewportFromFrameMetadata,
} from "../gateway/lib/panel.mjs";

test("the viewport bounds are the ones the issue advertises", () => {
  assert.equal(VIEWPORT_MIN, 320);
  assert.equal(VIEWPORT_MAX_WIDTH, 3840);
  assert.equal(VIEWPORT_MAX_HEIGHT, 2160);
  assert.deepEqual(DEFAULT_VIEWPORT, { width: 1280, height: 800 });
  // The picture is capped independently of the layout size, so a huge viewport
  // still streams a bounded frame.
  assert.ok(SCREENCAST_MAX_WIDTH <= VIEWPORT_MAX_WIDTH);
  assert.ok(SCREENCAST_MAX_HEIGHT <= VIEWPORT_MAX_HEIGHT);
});

test("the viewport is clamped into the bounds, per axis, from what the fields hold", () => {
  assert.deepEqual(clampViewport({ width: 800, height: 600 }), { width: 800, height: 600 });
  // The two fields are read as strings, because that is what an input holds.
  assert.deepEqual(clampViewport({ width: "800", height: "600" }), { width: 800, height: 600 });
  assert.deepEqual(clampViewport({ width: " 1024 ", height: "768" }), { width: 1024, height: 768 });
  // Below the floor, above the ceiling, and one axis of each.
  assert.deepEqual(clampViewport({ width: 100, height: 100 }), { width: VIEWPORT_MIN, height: VIEWPORT_MIN });
  assert.deepEqual(clampViewport({ width: 5000, height: 5000 }), { width: VIEWPORT_MAX_WIDTH, height: VIEWPORT_MAX_HEIGHT });
  assert.deepEqual(clampViewport({ width: 1920, height: 4000 }), { width: 1920, height: VIEWPORT_MAX_HEIGHT });
  assert.deepEqual(clampViewport({ width: 4000, height: 900 }), { width: VIEWPORT_MAX_WIDTH, height: 900 });
  // A typo falls back to the default, and only on the axis it was typed on.
  assert.deepEqual(clampViewport({ width: "abc", height: 600 }), { width: DEFAULT_VIEWPORT.width, height: 600 });
  assert.deepEqual(clampViewport({ width: 800, height: "" }), { width: 800, height: DEFAULT_VIEWPORT.height });
  assert.deepEqual(clampViewport({}), { ...DEFAULT_VIEWPORT });
  assert.deepEqual(clampViewport(), { ...DEFAULT_VIEWPORT });
  assert.deepEqual(clampViewport({ width: "Infinity", height: "NaN" }), { ...DEFAULT_VIEWPORT });
  // Fractions are rounded: the fields are integers.
  assert.deepEqual(clampViewport({ width: 800.4, height: 600.6 }), { width: 800, height: 601 });
});

test("the emulation override is the desktop one, with the factor the agent's tool uses", () => {
  assert.deepEqual(deviceMetricsParams({ width: 800, height: 600 }), {
    width: 800,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // Deliberate: the panel emulates a desktop viewport. `mobile` changes the
  // layout viewport and the reported numbers, and that is the agent's tool to
  // choose (its `emulate` call takes a mobile tag), not the panel's.
  assert.equal(deviceMetricsParams({ width: 800, height: 600 }).mobile, false);
});

test("the screencast asks for JPEG frames capped at the picture bounds", () => {
  assert.deepEqual(screencastParams({ width: 800, height: 600 }), {
    format: "jpeg",
    quality: 70,
    maxWidth: 800,
    maxHeight: 600,
    everyNthFrame: 1,
  });
  // A viewport larger than the cap still streams a bounded picture; the page
  // itself keeps the size the operator asked for.
  assert.deepEqual(screencastParams({ width: 3840, height: 2160 }), {
    format: "jpeg",
    quality: 70,
    maxWidth: SCREENCAST_MAX_WIDTH,
    maxHeight: SCREENCAST_MAX_HEIGHT,
    everyNthFrame: 1,
  });
});

test("the picture bounds are what the panel asks for before the page size is known", () => {
  // The panel asks for these at attach, when the fields still hold the defaults
  // and the page has not reported its own size yet. Capping on the fields there
  // would freeze the picture at 1280x800 for the whole session, which is what
  // made the bounds below unreachable.
  const bounds = {
    format: "jpeg",
    quality: SCREENCAST_QUALITY,
    maxWidth: SCREENCAST_MAX_WIDTH,
    maxHeight: SCREENCAST_MAX_HEIGHT,
    everyNthFrame: 1,
  };
  assert.deepEqual(screencastParams(), bounds);
  assert.deepEqual(screencastParams({}), bounds);
  // The point of asking for them: they are wider and taller than the defaults the
  // fields hold at that moment, so there is a range in between to reach.
  assert.ok(SCREENCAST_MAX_WIDTH > DEFAULT_VIEWPORT.width);
  assert.ok(SCREENCAST_MAX_HEIGHT > DEFAULT_VIEWPORT.height);
});

test("the frame metadata is the size the page is rendered at, not the bitmap size", () => {
  // Measured: with maxWidth 320 on a 640x480 viewport, Chromium sends a 320x240
  // bitmap whose metadata still says deviceWidth 640, deviceHeight 480. The
  // metadata is therefore what the input coordinates are expressed in.
  assert.deepEqual(viewportFromFrameMetadata({ deviceWidth: 640, deviceHeight: 480 }), { width: 640, height: 480 });
  assert.deepEqual(viewportFromFrameMetadata({ deviceWidth: 320, deviceHeight: 240 }), { width: 320, height: 240 });
  for (const broken of [undefined, null, {}, { deviceWidth: 0, deviceHeight: 480 }, { deviceWidth: 640, deviceHeight: -1 }, { deviceWidth: "640", deviceHeight: 480 }]) {
    assert.deepEqual(viewportFromFrameMetadata(broken, { width: 800, height: 600 }), { width: 800, height: 600 }, JSON.stringify(broken));
  }
  // Without a fallback there is nothing to aim at, and the caller must not send.
  assert.equal(viewportFromFrameMetadata({}), null);
});

test("a canvas point becomes the viewport point the page is aiming at", () => {
  const rect = { left: 100, top: 50, width: 400, height: 300 };
  const viewport = { width: 800, height: 600 };
  assert.deepEqual(canvasToViewport({ x: 100, y: 50 }, { rect, viewport }), { x: 0, y: 0 });
  assert.deepEqual(canvasToViewport({ x: 300, y: 200 }, { rect, viewport }), { x: 400, y: 300 });
  assert.deepEqual(canvasToViewport({ x: 500, y: 350 }, { rect, viewport }), { x: 799, y: 599 });
  // A point just inside the last pixel maps inside the viewport.
  assert.deepEqual(canvasToViewport({ x: 499, y: 349 }, { rect, viewport }), { x: 798, y: 598 });
  // A rect at the origin, and a bitmap smaller than the viewport: the scaling is
  // the same, because the picture and the viewport share an aspect ratio.
  assert.deepEqual(canvasToViewport({ x: 160, y: 120 }, { rect: { left: 0, top: 0, width: 320, height: 240 }, viewport: { width: 640, height: 480 } }), { x: 320, y: 240 });
  // Fractional positions are rounded, and a point outside the rect is clamped
  // rather than sent out of bounds.
  assert.deepEqual(canvasToViewport({ x: 100.4, y: 50.2 }, { rect, viewport }), { x: 1, y: 0 });
  assert.deepEqual(canvasToViewport({ x: -500, y: -500 }, { rect, viewport }), { x: 0, y: 0 });
  assert.deepEqual(canvasToViewport({ x: 5000, y: 5000 }, { rect, viewport }), { x: 799, y: 599 });
  // Nothing to aim at: a canvas with no box, a viewport with no size, or a point
  // that is not a point. The caller must send nothing rather than guess.
  assert.equal(canvasToViewport({ x: 10, y: 10 }, { rect: { left: 0, top: 0, width: 0, height: 0 }, viewport }), null);
  assert.equal(canvasToViewport({ x: 10, y: 10 }, { rect, viewport: { width: 0, height: 0 } }), null);
  assert.equal(canvasToViewport({ x: 10, y: 10 }, { rect, viewport: null }), null);
  assert.equal(canvasToViewport(null, { rect, viewport }), null);
  assert.equal(canvasToViewport({ x: "10", y: 10 }, { rect, viewport }), null);
});

/**
 * Which viewport a click is mapped with, which is the one decision the panel makes
 * that a rendered page cannot show: between an override landing and the first frame
 * at the new size, the page is already at the new size while the picture is still
 * the previous one. The pure half is here; the wiring that consumes it is executed
 * in `panelRuntime` below, so deleting the line that stamps the override fails a
 * test rather than slipping through both suites.
 */
test("input is mapped with the newest of the frame and the override the panel applied", () => {
  const frame = { width: 780, height: 437 };
  const applied = { width: 640, height: 480 };
  assert.deepEqual(inputViewport({ frame, frameStamp: 1 }), frame, "no override: the picture is what the operator aims at");
  assert.deepEqual(inputViewport({ applied, appliedStamp: 2 }), applied, "no frame yet: the override is all we know about the page");
  assert.deepEqual(
    inputViewport({ frame, frameStamp: 1, applied, appliedStamp: 2 }),
    applied,
    "an override newer than the frame wins: the page has already been laid out again",
  );
  assert.deepEqual(
    inputViewport({ frame, frameStamp: 2, applied, appliedStamp: 1 }),
    frame,
    "a frame newer than the override wins: the size may have been changed by the agent, and the picture is the measurement",
  );
  assert.deepEqual(inputViewport({ frame, frameStamp: 2, applied, appliedStamp: 2 }), frame, "a tie goes to the measured size");
  assert.deepEqual(inputViewport({ frame, frameStamp: 2, applied, appliedStamp: null }), frame, "an override with no stamp counts as the oldest information");
  assert.equal(inputViewport({}), null);
  assert.equal(inputViewport(), null);
});

/**
 * The page's own wiring, executed outside a browser.
 *
 * The wiring is the part no pure function covers, and the decision above only
 * matters if the wiring really consumes it. So the served wiring block is run here
 * against a small DOM stub, and what is asserted is what it puts on the CDP wire:
 * the mouse message it sends for a click on the picture.
 */
function panelRuntime() {
  const blocks = [...panelPage().matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const sent = [];
  const sockets = [];
  const handlers = new Map();
  const elements = new Map();

  const element = (id) => ({
    id,
    value: id === "width" ? "1280" : id === "height" ? "800" : "",
    textContent: "",
    title: "",
    href: "",
    checked: false,
    disabled: false,
    dataset: {},
    style: {},
    width: 0,
    height: 0,
    addEventListener: (event, handler) => {
      const key = `${id}:${event}`;
      handlers.set(key, [...(handlers.get(key) ?? []), handler]);
    },
    appendChild: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
    getContext: () => ({ drawImage: () => {}, clearRect: () => {} }),
    focus: () => {},
    blur: () => {},
  });
  const elementFor = (id) => {
    if (!elements.has(id)) {
      elements.set(id, element(id));
    }
    return elements.get(id);
  };

  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      sockets.push(this);
    }
    send(text) {
      const message = JSON.parse(text);
      sent.push(message);
      // The debug port answers every command, and the wiring waits for the answer.
      Promise.resolve().then(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result: {} }) }));
    }
    close() {}
  }

  class FakeImage {
    constructor() {
      this.width = 640;
      this.height = 480;
    }
    set src(value) {
      this._src = value;
      if (this.onload) {
        this.onload();
      }
    }
    get src() {
      return this._src;
    }
  }

  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const location = { host: "panel.example:3040", protocol: "http:", href: "http://panel.example:3040/_browser/" };
  const context = {
    URL,
    location,
    window: { addEventListener: () => {}, location },
    document: { getElementById: elementFor, createElement: (tag) => element(`created:${tag}`), body: element("body") },
    fetch: async () => ({ ok: true, json: async () => [{ id: "AB", type: "page", url: "about:blank", title: "Fixture" }] }),
    WebSocket: FakeSocket,
    Image: FakeImage,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  vm.createContext(context);
  vm.runInContext(blocks[0], context);
  vm.runInContext(blocks[1], context);

  const invoke = async (id, event, payload) => {
    for (const handler of handlers.get(`${id}:${event}`) ?? []) {
      handler(payload);
    }
    await tick();
  };
  const lastSent = (method) => [...sent].reverse().find((message) => message.method === method);

  return {
    sent,
    lastSent,
    /** The params of the last command of that name, which is what goes on the wire. */
    lastParams: (method) => lastSent(method)?.params ?? null,
    async connected() {
      for (let attempt = 0; attempt < 50 && sockets.length === 0; attempt += 1) {
        await tick();
      }
      assert.equal(sockets.length, 1, "the wiring must have opened one socket to the target it found");
      sockets[0].onopen();
      await tick();
      return sockets[0];
    },
    deliverFrame(metadata) {
      sockets[0].onmessage({
        data: JSON.stringify({ method: "Page.screencastFrame", params: { data: "AAAA", sessionId: 1, metadata } }),
      });
    },
    /** Clicks an element of the panel by its id, as the operator would. */
    click(id) {
      return invoke(id, "click", {});
    },
    moveOnCanvas(point) {
      return invoke("screen", "mousemove", { clientX: point.x, clientY: point.y, button: 0, buttons: 0, detail: 0 });
    },
    fields: (width, height) => {
      elementFor("width").value = String(width);
      elementFor("height").value = String(height);
    },
  };
}

test("a click right after a viewport change is mapped into the size the page has", async () => {
  const panel = panelRuntime();
  await panel.connected();
  // The picture is the old, small layout.
  panel.deliverFrame({ deviceWidth: 780, deviceHeight: 437 });
  // The operator types a new size and applies it: the override lands, and the
  // frame at that size is still on its way.
  panel.fields(1280, 960);
  await panel.click("apply");
  await panel.moveOnCanvas({ x: 320, y: 240 });
  const duringTheWindow = panel.lastParams("Input.dispatchMouseEvent");
  assert.deepEqual(
    { x: duringTheWindow.x, y: duringTheWindow.y },
    { x: 640, y: 480 },
    "the click must be mapped with the override the panel just applied, not with the previous frame",
  );

  // Once a frame at the new size arrives, the frame is the source again: the size
  // may have been changed by something other than this panel.
  panel.deliverFrame({ deviceWidth: 500, deviceHeight: 400 });
  await panel.moveOnCanvas({ x: 320, y: 240 });
  const afterTheFrame = panel.lastParams("Input.dispatchMouseEvent");
  assert.deepEqual(
    { x: afterTheFrame.x, y: afterTheFrame.y },
    { x: 250, y: 200 },
    "a frame newer than the override must win, and it is the measured size that is used",
  );
  // And the override really was applied: this is not a mapping over a size that
  // never reached the page.
  assert.deepEqual(panel.lastParams("Emulation.setDeviceMetricsOverride"), {
    width: 1280,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  });
});

test("the panel asks for the picture bounds on attach, not the values the fields hold", async () => {
  const panel = panelRuntime();
  await panel.connected();
  // One command, sent once: the browser refuses a second startScreencast while
  // one is running ("Screencast is already active", measured on Chromium 153), so
  // a cap asked for here is the cap for the whole session. The fields hold the
  // defaults at this moment, which is why asking for them capped the picture at
  // 1280x800 and made SCREENCAST_MAX_* unreachable.
  assert.deepEqual(panel.lastParams("Page.startScreencast"), {
    format: "jpeg",
    quality: SCREENCAST_QUALITY,
    maxWidth: SCREENCAST_MAX_WIDTH,
    maxHeight: SCREENCAST_MAX_HEIGHT,
    everyNthFrame: 1,
  });
});

test("the mouse messages carry the fields CDP expects, for every kind of gesture", () => {
  const point = { x: 120.4, y: 240.6 };
  assert.deepEqual(mouseParams({ type: "mouseMoved", point }), { type: "mouseMoved", x: 120, y: 241, button: "none", buttons: 0 });
  assert.deepEqual(mouseParams({ type: "mousePressed", point }), { type: "mousePressed", x: 120, y: 241, button: "left", buttons: 1, clickCount: 1 });
  assert.deepEqual(mouseParams({ type: "mouseReleased", point }), { type: "mouseReleased", x: 120, y: 241, button: "left", buttons: 0, clickCount: 1 });
  // The right button, and the mask of a left button still held during a drag.
  assert.deepEqual(mouseParams({ type: "mousePressed", point, button: "right", buttons: 2 }), { type: "mousePressed", x: 120, y: 241, button: "right", buttons: 2, clickCount: 1 });
  assert.deepEqual(mouseParams({ type: "mouseMoved", point, button: "left", buttons: 1 }), { type: "mouseMoved", x: 120, y: 241, button: "left", buttons: 1 });
  // The wheel is a mouse event too, and it carries its deltas.
  assert.deepEqual(mouseParams({ type: "mouseWheel", point, deltaX: 0, deltaY: 120 }), {
    type: "mouseWheel",
    x: 120,
    y: 241,
    button: "none",
    buttons: 0,
    deltaX: 0,
    deltaY: 120,
  });
  assert.equal(mouseParams({ type: "mouseMoved" }), null, "without a point there is nothing to send");
});

test("the DOM button number becomes the CDP button name", () => {
  assert.equal(buttonName(0), "left");
  assert.equal(buttonName(1), "middle");
  assert.equal(buttonName(2), "right");
  assert.equal(buttonName(3), "back");
  assert.equal(buttonName(4), "forward");
  // Anything unknown is the primary button, never a name CDP would refuse.
  for (const odd of [undefined, null, -1, 5, "0"]) {
    assert.equal(buttonName(odd), "left", JSON.stringify(odd));
  }
});

test("a printable key is a raw down and the character that inserts it", () => {
  assert.deepEqual(keyCommands({ key: "a", code: "KeyA", keyCode: 65 }), [
    { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 0, autoRepeat: false },
    { type: "char", text: "a", key: "a", modifiers: 0 },
  ]);
  // The up comes from the operator letting the key go, not from the down.
  assert.deepEqual(keyUpCommands({ key: "a", code: "KeyA", keyCode: 65 }), [
    { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 0, autoRepeat: false },
  ]);
});

test("the modifiers are the CDP bitmask, and a shortcut inserts no text", () => {
  const shifted = keyCommands({ key: "A", code: "KeyA", keyCode: 65, shiftKey: true });
  assert.equal(shifted.length, 2, "a shifted character still produces its text");
  assert.equal(shifted[0].modifiers, 8);
  assert.equal(shifted[1].text, "A");
  assert.equal(keyUpCommands({ key: "A", code: "KeyA", keyCode: 65, shiftKey: true })[0].modifiers, 8);

  // Ctrl+A is a shortcut: the down carries the modifier, and there is no char,
  // which is what keeps the page from receiving a literal "a".
  const shortcut = keyCommands({ key: "a", code: "KeyA", keyCode: 65, ctrlKey: true });
  assert.equal(shortcut.length, 1);
  assert.equal(shortcut[0].type, "rawKeyDown");
  assert.equal(shortcut[0].modifiers, 2);

  const everything = keyCommands({ key: "a", code: "KeyA", keyCode: 65, ctrlKey: true, altKey: true, shiftKey: true, metaKey: true, repeat: true });
  assert.equal(everything.length, 1, "with ctrl, alt or meta held nothing is inserted");
  assert.equal(everything[0].modifiers, 1 + 2 + 4 + 8);
  assert.equal(everything[0].autoRepeat, true);
});

test("a named key is sent without a character, and Enter keeps its carriage return", () => {
  assert.deepEqual(keyCommands({ key: "Backspace", code: "Backspace", keyCode: 8 }), [
    { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, modifiers: 0, autoRepeat: false },
  ]);
  assert.deepEqual(keyCommands({ key: "Tab", code: "Tab", keyCode: 9 }).map((command) => command.type), ["rawKeyDown"]);
  assert.deepEqual(keyCommands({ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }).map((command) => command.type), ["rawKeyDown"]);
  // Enter is the one named key that also produces text, because that is what
  // submits a form or sends a chat message.
  assert.deepEqual(keyCommands({ key: "Enter", code: "Enter", keyCode: 13 }).map((command) => command.type), ["rawKeyDown", "char"]);
  assert.equal(keyCommands({ key: "Enter", code: "Enter", keyCode: 13 })[1].text, "\r");
  // A key with nothing to say, or no key at all, sends nothing.
  assert.deepEqual(keyCommands({}), []);
  assert.deepEqual(keyCommands(undefined), []);
  assert.deepEqual(keyUpCommands(undefined), []);
  assert.equal(keyCommands({ key: "Unidentified", keyCode: 0 }).length, 1, "an unprintable key still travels as a down");
  assert.deepEqual(
    keyCommands({ key: "F5", code: "F5", keyCode: 116 })[0],
    { type: "rawKeyDown", key: "F5", code: "F5", windowsVirtualKeyCode: 116, nativeVirtualKeyCode: 116, modifiers: 0, autoRepeat: false },
    "a key code outside the printable range still travels",
  );
});

test("the panel's socket goes to this gateway, to a browser route path, and nowhere else", () => {
  const host = "panel.example:3040";
  // The rewritten discovery document names this gateway, and the page rebuilds
  // the socket from its own authority: a TLS terminating proxy may hand the
  // gateway another Host header, and the socket must follow the page's origin.
  assert.equal(
    socketUrlFor("ws://127.0.0.1:9222/_browser/devtools/page/AB", { host, protocol: "http:" }),
    "ws://panel.example:3040/_browser/devtools/page/AB",
  );
  assert.equal(
    socketUrlFor("ws://127.0.0.1:9222/_browser/devtools/page/AB", { host, protocol: "https:" }),
    "wss://panel.example:3040/_browser/devtools/page/AB",
  );
  // The panel can build it from the path alone, which is what it does.
  assert.equal(
    socketUrlFor("/_browser/devtools/page/AB", { host, protocol: "http:" }),
    "ws://panel.example:3040/_browser/devtools/page/AB",
  );
  assert.equal(
    socketUrlFor("ws://panel.example:3040/_browser/devtools/page/16F34C955E7B21E7305AD506D4CBC609?x=1", { host, protocol: "http:" }),
    "ws://panel.example:3040/_browser/devtools/page/16F34C955E7B21E7305AD506D4CBC609?x=1",
  );
  // A document that names another host cannot point the panel anywhere: the
  // authority is always the page's own, and the path is the only thing taken.
  assert.equal(
    socketUrlFor("http://evil.example/_browser/devtools/page/AB", { host, protocol: "http:" }),
    "ws://panel.example:3040/_browser/devtools/page/AB",
  );
  // Anything that is not a browser route path is refused, so a stray document
  // cannot turn the panel into a client for another service.
  for (const hostile of [
    "ws://127.0.0.1:9222/devtools/page/AB",
    "ws://127.0.0.1:9222/_browser/json/list",
    "/_browser/devtools/page/../../../etc/passwd",
    "not a url at all",
    "",
    undefined,
  ]) {
    assert.equal(socketUrlFor(hostile, { host, protocol: "http:" }), null, JSON.stringify(hostile));
  }
  // Without a usable page authority there is no socket to build.
  for (const brokenHost of [undefined, null, "", "  "]) {
    assert.equal(socketUrlFor("/_browser/devtools/page/AB", { host: brokenHost, protocol: "http:" }), null, JSON.stringify(brokenHost));
  }
});

test("the DevTools button points at the proxied frontend for this target", () => {
  assert.equal(
    devtoolsUrlFor("8B04", { host: "panel.example:3040" }),
    "/_browser/devtools/inspector.html?ws=panel.example:3040/_browser/devtools/page/8B04",
  );
  // Only a target id can end up in the URL.
  for (const hostile of ["../../etc/passwd", "8B04?ws=evil.example", "8B04/../x", "", undefined, "8B 04"]) {
    assert.equal(devtoolsUrlFor(hostile, { host: "panel.example:3040" }), null, JSON.stringify(hostile));
  }
});

test("the target list offers the pages and nothing else", () => {
  const list = [
    { id: "AB", type: "page", url: "file:///workspace/x.html", title: "Fixture" },
    { id: "CD", type: "browser_ui", url: "chrome://omnibox-popup.top-chrome/" },
    { id: "EF", type: "page", url: "about:blank" },
    { id: "GH", type: "service_worker", url: "https://example.test/sw.js" },
    { type: "page", url: "about:blank" },
    null,
  ];
  assert.deepEqual(panelTargets(list), [
    { id: "AB", url: "file:///workspace/x.html", title: "Fixture" },
    { id: "EF", url: "about:blank", title: "about:blank" },
  ]);
  for (const broken of [undefined, null, {}, "nope", 42]) {
    assert.deepEqual(panelTargets(broken), [], JSON.stringify(broken));
  }
});

test("the panel is served at the browser prefix, which is a browser route", () => {
  assert.equal(PANEL_PREFIX, "/_browser/");
});

test("the served page is one file, with no external asset and no framework", () => {
  const html = panelPage();
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<canvas/);
  assert.match(html, /Page\.startScreencast/);
  assert.match(html, /Emulation\.setDeviceMetricsOverride/);
  assert.match(html, /Input\.dispatchMouseEvent/);
  assert.match(html, /Input\.dispatchKeyEvent/);
  assert.match(html, /inspector\.html/);
  // The indicator that the page is shared, which is the point of the panel.
  assert.match(html, /Shared with the agent/);
  // Nothing is loaded from anywhere: both script blocks are inline, there is no
  // stylesheet link, no image, no frame, and no form that posts somewhere.
  const withoutSentinel = html.split('"http://panel.invalid"').join('"sentinel"');
  assert.equal(/https?:\/\//.test(withoutSentinel), false, "the page must not reference another host");
  assert.equal(/<script[^>]*\ssrc/i.test(html), false, "the scripts must be inline");
  assert.equal(/<link|<img|<iframe|<video|<audio|<source|<object|<embed|<form|@import/i.test(html), false, "no external resource and no form");
  assert.equal(/require\(|\bimport\s*\(/.test(html), false, "no module system");
  assert.equal(html.includes("</script>\n<script>"), true, "the helpers and the wiring are separate blocks on purpose");
});

test("every theme token the served page references is one the page defines", () => {
  const html = panelPage();
  // Only the :root block defines tokens, so only it is read as definitions: a
  // `var(--x, #fff)` use must never count as one.
  const rootStart = html.indexOf(":root {");
  assert.notEqual(rootStart, -1, "the served page must still carry its theme block");
  const root = html.slice(rootStart, html.indexOf("}", rootStart));
  const defined = new Set([...root.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
  const used = [...new Set([...html.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]))];

  assert.ok(used.length >= 10, `the page is expected to use the theme tokens, found ${used.length}`);
  for (const token of used) {
    assert.ok(defined.has(token), `${token} is referenced but never defined in the :root block`);
  }
  // The token the panel shipped with, named so that it cannot come back through a
  // copy and paste of the pages.mjs palette: the panel defines `subtle` and
  // `subtlest`, and nothing in between.
  assert.equal(defined.has("--foreground-subtler"), false);
});

test("the helpers the page runs are the helpers these tests cover", () => {
  const html = panelPage();
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(blocks.length, 2, "one block of helpers, one block of wiring");

  // The page's own block, executed as the browser would: no DOM, no imports.
  // `URL` is a host API rather than a language one, so the sandbox is given the
  // same constructor the browser provides; everything else the helpers touch has
  // to be in the block itself.
  const page = { URL };
  vm.createContext(page);
  vm.runInContext(blocks[0], page);
  // Function declarations land on the context object; `const` bindings do not,
  // so a constant has to be read by evaluating it, exactly as the browser would.
  const inPage = (expression) => vm.runInContext(expression, page);

  const panelModule = { clampViewport, deviceMetricsParams, screencastParams, viewportFromFrameMetadata, canvasToViewport, buttonName, mouseParams, keyCommands, keyUpCommands, socketUrlFor, devtoolsUrlFor, panelTargets };
  // Cross realm objects have another prototype, so the comparison is on the
  // serialized answer, which is also what goes on the wire.
  const same = (name, args) => {
    const inPageFn = page[name];
    assert.equal(typeof inPageFn, "function", `${name} is not a function in the served page`);
    assert.equal(
      JSON.stringify(inPageFn(...args)),
      JSON.stringify(panelModule[name](...args)),
      `${name} in the served page must answer exactly like the tested one (args: ${JSON.stringify(args)})`,
    );
  };

  same("clampViewport", [{ width: 5000, height: "abc" }]);
  same("clampViewport", [{ width: 800, height: 600 }]);
  same("deviceMetricsParams", [{ width: 800, height: 600 }]);
  same("screencastParams", [{ width: 3840, height: 2160 }]);
  // With no size at all the page asks for the picture bounds themselves, which is
  // what the wiring does at attach: the default has to travel into the page too.
  same("screencastParams", []);
  same("viewportFromFrameMetadata", [{ deviceWidth: 640, deviceHeight: 480 }]);
  same("viewportFromFrameMetadata", [{}, { width: 800, height: 600 }]);
  same("canvasToViewport", [{ x: 300, y: 200 }, { rect: { left: 100, top: 50, width: 400, height: 300 }, viewport: { width: 800, height: 600 } }]);
  same("canvasToViewport", [null, { rect: { left: 0, top: 0, width: 1, height: 1 }, viewport: { width: 1, height: 1 } }]);
  same("buttonName", [2]);
  same("mouseParams", [{ type: "mouseWheel", point: { x: 1.5, y: 2.5 }, deltaY: 120 }]);
  same("mouseParams", [{ type: "mousePressed", point: { x: 1, y: 2 }, button: "right", buttons: 2 }]);
  same("keyCommands", [{ key: "A", code: "KeyA", keyCode: 65, shiftKey: true }]);
  same("keyCommands", [{ key: "Enter", code: "Enter", keyCode: 13 }]);
  same("keyUpCommands", [{ key: "Enter", code: "Enter", keyCode: 13 }]);
  same("socketUrlFor", ["ws://127.0.0.1:9222/_browser/devtools/page/AB", { host: "panel.example:3040", protocol: "https:" }]);
  same("socketUrlFor", ["http://evil.example/_browser/devtools/page/AB", { host: "panel.example:3040", protocol: "http:" }]);
  same("devtoolsUrlFor", ["8B04", { host: "panel.example:3040" }]);
  same("panelTargets", [[{ id: "AB", type: "page", url: "x", title: "t" }, { id: "CD", type: "browser_ui", url: "y" }]]);

  // The constants the helpers close over must be in the page's block too.
  assert.equal(inPage("VIEWPORT_MIN"), VIEWPORT_MIN);
  assert.equal(inPage("VIEWPORT_MAX_WIDTH"), VIEWPORT_MAX_WIDTH);
  assert.equal(inPage("VIEWPORT_MAX_HEIGHT"), VIEWPORT_MAX_HEIGHT);
  assert.equal(JSON.stringify(inPage("DEFAULT_VIEWPORT")), JSON.stringify(DEFAULT_VIEWPORT));
  assert.equal(inPage("SCREENCAST_MAX_WIDTH"), SCREENCAST_MAX_WIDTH);
  assert.equal(inPage("SCREENCAST_MAX_HEIGHT"), SCREENCAST_MAX_HEIGHT);
  assert.equal(inPage("SCREENCAST_QUALITY"), SCREENCAST_QUALITY);
  assert.equal(inPage("PANEL_PREFIX"), PANEL_PREFIX);
});
