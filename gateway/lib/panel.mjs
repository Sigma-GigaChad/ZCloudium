/**
 * The operator panel: the live view and the viewport control in one page.
 *
 * Why this exists at all, given Phase 0 of issue #5. Chromium's own DevTools
 * frontend, served through the gateway against the container browser, gives live
 * view, live DOM, element picking and the console for free. What it does not give
 * is both halves of the workflow at once: `inspector.html` renders the page and
 * has no device toolbar, and with `can_dock=true` the toolbar exists and no page
 * is rendered into the operator's tab. Measured, twice, in Phase 0. So the
 * operator had to choose between seeing the page and sizing it, which is the one
 * trade this page removes: it owns the live view and the controls together, and
 * the DevTools button covers everything deeper (Elements, Network, Console,
 * Sources, Performance).
 *
 * What it is: one HTML page, inline JavaScript, no framework, no build step, no
 * new dependency. Chromium already provides everything it draws with:
 *
 *   - live view: `Page.startScreencast` JPEG frames painted into a canvas. This
 *     is a frame stream, not video: a frame arrives when the page produces one,
 *     which measured 8 to 20 ms after a visible change and never for an invisible
 *     one. There is no encoder, no ffmpeg and no video protocol.
 *   - viewport control: `Emulation.setDeviceMetricsOverride` with a width field,
 *     a height field and a fit option.
 *   - interaction: `Input.dispatchMouseEvent` for move, press, release, wheel and
 *     drag, `Input.dispatchKeyEvent` for the keyboard.
 *   - an indicator that the page is shared with the agent, which it is: the panel
 *     and the agent drive one single page.
 *
 * The pure functions are exported, unit tested, and serialized into the page: the
 * served page runs the code the tests cover, not a copy of it. That is what the
 * `toPageScript` block below and the last test in tests/panel.test.mjs pin.
 */

/** Where the page is served. A browser route, behind the session, like the rest. */
export const PANEL_PREFIX = "/_browser/";

/**
 * The viewport bounds the fields accept. The issue advertises 320x320 up to
 * 3840x2160, and this is that range. The agent's own `emulate` tool is looser (it
 * accepts any positive size), so the panel is deliberately the narrower of the
 * two: it can never ask for a size the agent would refuse, and an operator cannot
 * type a size that makes the picture useless.
 */
export const VIEWPORT_MIN = 320;
export const VIEWPORT_MAX_WIDTH = 3840;
export const VIEWPORT_MAX_HEIGHT = 2160;

/**
 * What the fields start at, and what the browser is taken to be until an operator
 * says otherwise.
 *
 * 1366x768 is the laptop layout the desktop build offers by default, and it is
 * what the panel adopts only when the page has no size of its own yet: opening the
 * panel still takes whatever the page reports, so this is the fallback rather than
 * an imposition.
 */
export const DEFAULT_VIEWPORT = { width: 1366, height: 768 };

/**
 * The sizes the preset selector offers, in the order it shows them.
 *
 * They stop at 1920x1080 on purpose: that is the picture cap below, so a larger
 * layout would stream a scaled picture, and the panel would be promising a
 * fidelity it cannot show. Choosing one fills the fields and applies them in the
 * same gesture, the way the desktop control does; the fields stay editable for
 * anything else.
 */
export const VIEWPORT_PRESETS = [
  { width: 1280, height: 720, label: "1280x720 (720p)" },
  { width: 1366, height: 768, label: "1366x768 (laptop)" },
  { width: 1600, height: 900, label: "1600x900" },
  { width: 1920, height: 1080, label: "1920x1080 (1080p)" },
];

/**
 * The picture bounds, independent of the layout size. Chromium scales the frame
 * down to fit inside these and keeps the aspect ratio, so a 3840x2160 viewport
 * still streams a bounded picture while the page itself lays out at full size.
 * Measured: maxWidth 320 on a 640x480 viewport produced a 320x240 frame.
 *
 * Measured as well, on the browser of the image (Chromium 153.0.8010.52): the
 * bounds are what the panel asks for at attach (`screencastParams` with no
 * argument), and the frame never grows past the page's own size, so a 640x480
 * page under these bounds still streams 640x480 and nothing is upscaled. A
 * screencast is started once per session because Chromium refuses a second
 * `Page.startScreencast` while one is running ("Screencast is already active"),
 * which is why the bounds, and not the values the fields hold at that moment,
 * are what has to be asked for.
 */
export const SCREENCAST_MAX_WIDTH = 1920;
export const SCREENCAST_MAX_HEIGHT = 1080;

/** The quality of the JPEG frames. Supervision, so this is deliberately modest. */
export const SCREENCAST_QUALITY = 70;

/** A number that is a positive integer, or the fallback. */
function positiveInteger(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

/**
 * The viewport the two fields ask for, clamped per axis into the bounds.
 *
 * The values arrive as strings from the DOM, and anything that is not a positive
 * number is replaced by the default on that axis only, so a typo in the width
 * does not silently discard a height the operator typed.
 */
export function clampViewport(value, fallback = DEFAULT_VIEWPORT) {
  const source = value && typeof value === "object" ? value : {};
  const width = positiveInteger(source.width, fallback.width);
  const height = positiveInteger(source.height, fallback.height);
  return {
    width: Math.min(Math.max(width, VIEWPORT_MIN), VIEWPORT_MAX_WIDTH),
    height: Math.min(Math.max(height, VIEWPORT_MIN), VIEWPORT_MAX_HEIGHT),
  };
}

/**
 * The emulation override.
 *
 * Deliberately the desktop one: `mobile: false` and a device scale factor of 1,
 * which is what an operator resizing a page wants to see. Emulating a phone is
 * the agent's tool's business (its `emulate` call takes a mobile tag), and mixing
 * the two would make the panel announce a size the page does not report.
 */
export function deviceMetricsParams({ width, height }) {
  return { width, height, deviceScaleFactor: 1, mobile: false };
}

/**
 * The screencast request. Frames are JPEG, one per produced frame, capped by the
 * picture bounds.
 *
 * Without a layout size the bounds themselves are asked for, which is the call
 * the panel makes at attach: at that moment the fields still hold the defaults
 * and the page has not reported its own size yet. Capping on those defaults would
 * hold the picture at 1280x800 for the whole session, and the caps themselves
 * would never be reached. The frame stays inside the page's own size either way,
 * so a page smaller than the bounds is not upscaled.
 */
export function screencastParams({ width = SCREENCAST_MAX_WIDTH, height = SCREENCAST_MAX_HEIGHT } = {}) {
  return {
    format: "jpeg",
    quality: SCREENCAST_QUALITY,
    maxWidth: Math.min(width, SCREENCAST_MAX_WIDTH),
    maxHeight: Math.min(height, SCREENCAST_MAX_HEIGHT),
    everyNthFrame: 1,
  };
}

/**
 * The size the frame is rendered at, from the metadata Chromium sends with it.
 *
 * This is not the bitmap size: with the picture capped, Chromium sends a smaller
 * bitmap and still reports the page's own size here. Input coordinates are
 * expressed in this size, so this is what the panel aims with. The fallback is
 * the viewport the panel itself applied, and null when there is nothing to aim
 * at, in which case the caller must send no input at all.
 */
export function viewportFromFrameMetadata(metadata, fallback = null) {
  if (!metadata || typeof metadata !== "object") {
    return fallback;
  }
  const width = metadata.deviceWidth;
  const height = metadata.deviceHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return fallback;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * Where a point on the canvas lands in the page's viewport.
 *
 * The canvas is displayed scaled to fit its box, so the mapping is the box into
 * the viewport, and the bitmap size cancels out of it: the picture and the
 * viewport share an aspect ratio, because the picture is the viewport. The result
 * is rounded because CDP wants whole pixels, and clamped inside the viewport so a
 * point on the edge cannot be sent out of bounds.
 *
 * The viewport is the size the frame was rendered at (see
 * `viewportFromFrameMetadata`), not the number in the fields: what the operator
 * aims at is the picture in front of them. When there is not enough information
 * to aim at, this returns null and the caller sends nothing.
 */
export function canvasToViewport(point, { rect, viewport } = {}) {
  if (!point || !rect || !viewport) {
    return null;
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return null;
  }
  if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
    return null;
  }
  if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) {
    return null;
  }
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const inside = (value, limit) => Math.min(Math.max(Math.round(value), 0), limit - 1);
  return {
    x: inside(((point.x - rect.left) / rect.width) * viewport.width, viewport.width),
    y: inside(((point.y - rect.top) / rect.height) * viewport.height, viewport.height),
  };
}

/**
 * The viewport input is mapped with, from the two things the panel knows: the last
 * frame it painted, and the override it last applied.
 *
 * The frame is the primary source, because the picture is what the operator is
 * aiming at. The exception is the window between an override landing and the first
 * frame at the new size: there the page has already been laid out again while the
 * picture is still the previous one, so a click has to be mapped into the layout
 * the page has rather than the one on screen. That window is short (tens of
 * milliseconds) and it is exactly the kind of thing that shows up only as a click
 * landing next to the field the operator aimed at, which is how the end to end
 * suite found it.
 *
 * The stamps come from a single counter in the page and are only ever compared
 * with each other. A tie goes to the frame, because a measured size beats a
 * requested one.
 */
export function inputViewport({ frame = null, frameStamp = null, applied = null, appliedStamp = null } = {}) {
  if (!frame) {
    return applied ?? null;
  }
  if (!applied) {
    return frame;
  }
  const frameOrder = Number.isFinite(frameStamp) ? frameStamp : -Infinity;
  const appliedOrder = Number.isFinite(appliedStamp) ? appliedStamp : -Infinity;
  return appliedOrder > frameOrder ? applied : frame;
}

/** The DOM button number as the name CDP expects. */
export function buttonName(button) {
  if (button === 1) {
    return "middle";
  }
  if (button === 2) {
    return "right";
  }
  if (button === 3) {
    return "back";
  }
  if (button === 4) {
    return "forward";
  }
  return "left";
}

/**
 * A mouse event as `Input.dispatchMouseEvent` params.
 *
 * The canvas is displayed scaled to fit, so the point (already mapped into the
 * viewport by `canvasToViewport`) is what goes on the wire, rounded, because CDP
 * wants whole pixels. `buttons` is the mask of what is held during the event,
 * which is how a drag is expressed: a press, then moves with the mask still set,
 * then a release.
 */
export function mouseParams(input = {}) {
  const { type, point, deltaX, deltaY, clickCount } = input;
  if (typeof type !== "string" || type === "" || !point) {
    return null;
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return null;
  }
  const passive = type === "mouseMoved" || type === "mouseWheel";
  const params = {
    type,
    x: Math.round(point.x),
    y: Math.round(point.y),
    button: input.button ?? (passive ? "none" : "left"),
    buttons: input.buttons ?? (type === "mousePressed" ? 1 : 0),
  };
  if (type === "mouseWheel") {
    params.deltaX = Number.isFinite(deltaX) ? deltaX : 0;
    params.deltaY = Number.isFinite(deltaY) ? deltaY : 0;
  } else if (!passive) {
    params.clickCount = Number.isFinite(clickCount) && clickCount >= 1 ? clickCount : 1;
  }
  return params;
}

/**
 * The fields every key message carries: the key itself, the physical code, the
 * modifier bitmask (Alt 1, Ctrl 2, Meta 4, Shift 8) and whether the key is held
 * down by its own repeat.
 *
 * `windowsVirtualKeyCode` comes from the DOM's `keyCode`, which is deprecated and
 * still the only number a browser gives for the physical key. It is included only
 * when it is a positive integer, so a synthetic event cannot put a zero on the
 * wire.
 */
export function keyFields(event = {}) {
  const key = typeof event.key === "string" ? event.key : "";
  const code = typeof event.code === "string" ? event.code : "";
  const modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
  const fields = { key, code, modifiers, autoRepeat: Boolean(event.repeat) };
  if (Number.isInteger(event.keyCode) && event.keyCode > 0) {
    fields.windowsVirtualKeyCode = event.keyCode;
    fields.nativeVirtualKeyCode = event.keyCode;
  }
  return fields;
}

/** The text a key inserts, or null. A shortcut inserts nothing. */
function insertedText(fields) {
  // Alt, Ctrl and Meta held means a shortcut, not a character. Shift does not:
  // it is what produces the character, and the browser already applied it to
  // `event.key`, so "@" is what a shifted 2 inserts.
  if ((fields.modifiers & 0b0111) !== 0) {
    return null;
  }
  if (fields.key.length === 1) {
    return fields.key;
  }
  // The one named key that also inserts: this is what submits a form and what
  // sends a chat message.
  return fields.key === "Enter" ? "\r" : null;
}

/**
 * What pressing a key sends: the raw key down, then the character when the key
 * inserts one.
 *
 * `rawKeyDown` rather than `keyDown` on purpose, and it is what DevTools sends:
 * the physical key and the text it produces are two different events, and a page
 * that reads `event.key` on a keydown must not receive the character in place of
 * the key. Measured in a real browser: this pair puts the text in a focused input
 * and reports the right key to the page's own keydown listener.
 */
export function keyCommands(event = {}) {
  const fields = keyFields(event);
  if (fields.key === "" && fields.code === "") {
    return [];
  }
  const commands = [{ type: "rawKeyDown", ...fields }];
  const text = insertedText(fields);
  if (text !== null) {
    commands.push({ type: "char", text, key: fields.key, modifiers: fields.modifiers });
  }
  return commands;
}

/** What letting a key go sends. Its own message, because the operator's key up is what ends it. */
export function keyUpCommands(event = {}) {
  const fields = keyFields(event);
  if (fields.key === "" && fields.code === "") {
    return [];
  }
  return [{ type: "keyUp", ...fields }];
}

/**
 * The WebSocket for a page target, built on the authority of the page that asks.
 *
 * The path is the only part taken from the document the debug port sent, and it
 * must be a browser route path. The authority comes from the panel's own location
 * and never from the document: behind a TLS terminating proxy the Host header the
 * gateway sees can differ from the name the operator used, and a socket must
 * follow the page it lives in, not a document. The scheme follows the page too,
 * because a `ws://` socket opened from an `https://` page is blocked as mixed
 * content.
 */
export function socketUrlFor(url, { host, protocol } = {}) {
  if (typeof url !== "string" || url.trim() === "" || typeof host !== "string" || host.trim() === "") {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(url, "http://panel.invalid");
  } catch {
    return null;
  }
  const path = `${parsed.pathname}${parsed.search}`;
  if (!path.startsWith(`${PANEL_PREFIX}devtools/`)) {
    return null;
  }
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host.trim()}${path}`;
}

/**
 * The DevTools frontend for one target, as the gateway serves it.
 *
 * The discovery document's own `devtoolsFrontendUrl` field is not used: Chromium
 * writes a URL on the chrome-devtools-frontend.appspot.com CDN there, which an
 * offline deployment cannot reach, and its path (`/devtools/...`) is not the
 * proxied one. The path that works is the one the gateway serves, and it is the
 * one Phase 0 opened the Elements tree, the console and the network waterfall
 * through.
 */
export function devtoolsUrlFor(targetId, { host, protocol = "http:" } = {}) {
  if (typeof targetId !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(targetId)) {
    return null;
  }
  if (typeof host !== "string" || host.trim() === "") {
    return null;
  }
  // The scheme is part of the answer: the frontend takes this `ws=` value as is,
  // and a ws:// socket opened from an https page is mixed content, which every
  // browser blocks. The gateway serves https by default, so saying nothing here
  // would break the button on the default deployment.
  const scheme = protocol === "https:" ? "wss://" : "ws://";
  return `${PANEL_PREFIX}devtools/inspector.html?ws=${scheme}${host.trim()}${PANEL_PREFIX}devtools/page/${targetId}`;
}

/**
 * The targets the panel may show: the pages, in the order the debug port lists
 * them, with the browser's own UI targets and workers left out. A target without
 * an id cannot be attached to, so it is not offered.
 */
export function panelTargets(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  const targets = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || entry.type !== "page") {
      continue;
    }
    if (typeof entry.id !== "string" || entry.id === "") {
      continue;
    }
    const url = typeof entry.url === "string" ? entry.url : "";
    targets.push({
      id: entry.id,
      url,
      title: typeof entry.title === "string" && entry.title !== "" ? entry.title : url,
    });
  }
  return targets;
}

/**
 * The functions the page runs, in the order they are emitted.
 *
 * Every one of them is a pure function with no reference to anything but its
 * arguments and the constants below, which is what makes this work: the page gets
 * the same source the unit tests cover, executed from its own script block.
 *
 * `positiveInteger` and `insertedText` are in the list although nothing outside
 * this module imports them: they are called by the functions above, so they have
 * to travel with them. A helper that is only reachable from the module would be
 * undefined in the page, and the sandbox test at the end of tests/panel.test.mjs
 * is what catches that.
 *
 * `deviceMetricsParams` is deliberately absent (issue #9): the gesture that poses
 * a viewport left this page when the gateway took ownership of it, and the page
 * has no business describing an emulation override it no longer sends. The
 * function itself stays, because the gateway sends it on the page's behalf.
 */
const PAGE_HELPERS = [
  positiveInteger,
  clampViewport,
  screencastParams,
  viewportFromFrameMetadata,
  canvasToViewport,
  inputViewport,
  buttonName,
  mouseParams,
  keyFields,
  insertedText,
  keyCommands,
  keyUpCommands,
  socketUrlFor,
  devtoolsUrlFor,
  panelTargets,
];

/** The constants the helpers close over, emitted from the same values. */
function pageConstants() {
  return [
    `const VIEWPORT_MIN = ${VIEWPORT_MIN};`,
    `const VIEWPORT_MAX_WIDTH = ${VIEWPORT_MAX_WIDTH};`,
    `const VIEWPORT_MAX_HEIGHT = ${VIEWPORT_MAX_HEIGHT};`,
    `const DEFAULT_VIEWPORT = ${JSON.stringify(DEFAULT_VIEWPORT)};`,
    `const VIEWPORT_PRESETS = ${JSON.stringify(VIEWPORT_PRESETS)};`,
    `const SCREENCAST_MAX_WIDTH = ${SCREENCAST_MAX_WIDTH};`,
    `const SCREENCAST_MAX_HEIGHT = ${SCREENCAST_MAX_HEIGHT};`,
    `const SCREENCAST_QUALITY = ${SCREENCAST_QUALITY};`,
    `const PANEL_PREFIX = ${JSON.stringify(PANEL_PREFIX)};`,
  ].join("\n");
}

/** The helper block as the page receives it. */
export function panelHelpersScript() {
  return [`"use strict";`, pageConstants(), ...PAGE_HELPERS.map((fn) => fn.toString())].join("\n\n");
}

const STYLE = `
:root {
  color-scheme: dark;
  --background: #161616;
  --panel: #202020;
  --surface: #ffffff0d;
  --surface-hover: #ffffff1a;
  --border: #ffffff1a;
  --border-hover: #ffffff26;
  --foreground: #e5e5e5;
  --foreground-subtle: #e5e5e599;
  --foreground-subtlest: #e5e5e54d;
  --destructive: #ff5c5c;
  --brand: #fff;
  --radius: .375rem;
  --font-sans: ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  display: flex;
  flex-direction: column;
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.4;
  -webkit-font-smoothing: antialiased;
}
.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 12px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.bar.bottom { border-bottom: none; border-top: 1px solid var(--border); color: var(--foreground-subtle); }
.brand { display: flex; align-items: center; gap: 7px; letter-spacing: .04em; text-transform: uppercase; font-size: 11px; color: var(--foreground-subtle); }
.brand .dot { width: 6px; height: 6px; border-radius: 999px; background: var(--brand); }
.badge {
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, .18);
  background: var(--surface);
  font-size: 11px;
  color: var(--foreground-subtle);
  cursor: help;
}
.status { font-size: 11px; color: var(--foreground-subtle); }
.status[data-kind="connected"] { color: #7dd3a0; }
.status[data-kind="error"] { color: var(--destructive); }
label { color: var(--foreground-subtle); font-size: 11px; }
select, input[type="number"] {
  background: var(--surface);
  color: var(--foreground);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 5px 8px;
  font-family: inherit;
  font-size: 12px;
  outline: none;
}
input[type="number"] { width: 78px; font-family: var(--font-mono); }
input[type="number"]:disabled { opacity: .5; }
select { max-width: 320px; }
select:focus, input[type="number"]:focus { border-color: var(--border-hover); background: var(--surface-hover); }
button, a.button {
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  padding: 5px 11px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--foreground-subtle);
  text-decoration: none;
  transition: background .12s ease, color .12s ease;
}
button:hover, a.button:hover { background: var(--surface); color: var(--foreground); }
button.primary { background: var(--brand); color: #161616; border-color: transparent; font-weight: 500; }
button.primary:hover { opacity: .9; }
.sep { width: 1px; height: 18px; background: var(--border); }
.check { display: flex; align-items: center; gap: 5px; }
.nav { gap: 6px; padding: 6px 10px; }
.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  flex: none;
  color: var(--foreground-subtle);
}
.icon:hover { background: var(--surface-hover); color: var(--foreground); }
.icon[aria-disabled="true"] { opacity: .4; cursor: default; }
.address {
  flex: 1;
  min-width: 0;
  height: 28px;
  background: var(--surface);
  color: var(--foreground);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0 10px;
  font-family: var(--font-mono);
  font-size: 12px;
  outline: none;
}
.address:focus { border-color: var(--border-hover); background: var(--surface-hover); }
.stage { flex: 1; min-height: 0; overflow: hidden; display: flex; align-items: center; justify-content: center; background: var(--background); }
canvas { display: block; max-width: 100%; max-height: 100%; width: auto; height: auto; outline: none; cursor: crosshair; }
canvas:focus { box-shadow: 0 0 0 1px var(--border); }
`;

/**
 * The page's own script: the DOM wiring, deliberately separate from the helper
 * block so the tests can run the helpers on their own. Nothing here is unit
 * testable (painting a canvas is not), which is why it is small and why the end
 * to end suite drives it in a real browser.
 */
const PANEL_WIRING = `
"use strict";
const canvas = document.getElementById("screen");
const context2d = canvas.getContext("2d");
const stage = document.getElementById("stage");
const statusEl = document.getElementById("status");
const addressEl = document.getElementById("address");
const externalEl = document.getElementById("external");
const backEl = document.getElementById("back");
const forwardEl = document.getElementById("forward");
const reloadEl = document.getElementById("reload");
const detachEl = document.getElementById("detach");
const targetEl = document.getElementById("target");
const refreshEl = document.getElementById("refresh");
const devtoolsEl = document.getElementById("devtools");
const widthEl = document.getElementById("width");
const heightEl = document.getElementById("height");
const presetsEl = document.getElementById("presets");
const fitEl = document.getElementById("fit");
const applyEl = document.getElementById("apply");
const reportedEl = document.getElementById("reported");
const pictureEl = document.getElementById("picture");

const state = {
  socket: null,
  pending: new Map(),
  nextId: 1,
  targetId: null,
  targets: [],
  targetIds: "",
  frameViewport: null,
  frameStamp: 0,
  appliedViewport: null,
  appliedStamp: 0,
  stamp: 0,
  frames: 0,
  lastFrameAt: 0,
  painting: false,
  dirty: false,
  retry: null,
  fitTimer: null,
  href: null,
};

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind || "";
}

function send(method, params) {
  return new Promise(function (resolve, reject) {
    const socket = state.socket;
    if (!socket || socket.readyState !== 1) {
      reject(new Error("not connected"));
      return;
    }
    const id = state.nextId;
    state.nextId += 1;
    const timer = setTimeout(function () {
      state.pending.delete(id);
      reject(new Error(method + " did not answer"));
    }, 15000);
    state.pending.set(id, {
      resolve: function (value) {
        clearTimeout(timer);
        resolve(value);
      },
      reject: function (error) {
        clearTimeout(timer);
        reject(error);
      },
    });
    socket.send(JSON.stringify({ id: id, method: method, params: params || {} }));
  });
}

function quietly(method, params) {
  send(method, params).catch(function () {});
}

function evaluate(expression) {
  return send("Runtime.evaluate", { expression: expression, returnByValue: true }).then(function (result) {
    return result && result.result ? result.result.value : undefined;
  });
}

function onMessage(event) {
  const message = JSON.parse(event.data);
  if (message.id && state.pending.has(message.id)) {
    const entry = state.pending.get(message.id);
    state.pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(message.error.message));
      return;
    }
    if (message.result && message.result.exceptionDetails) {
      entry.reject(new Error(message.result.exceptionDetails.text || "the page raised"));
      return;
    }
    entry.resolve(message.result || {});
    return;
  }
  if (message.method === "Page.screencastFrame") {
    onFrame(message.params);
  }
}

function onFrame(params) {
  state.frames += 1;
  state.lastFrameAt = Date.now();
  const viewport = viewportFromFrameMetadata(params.metadata, state.frameViewport);
  if (viewport) {
    state.frameViewport = viewport;
    state.stamp += 1;
    state.frameStamp = state.stamp;
  }
  // The acknowledgement goes first and unconditionally: without it the browser
  // stops sending frames. A frame that is still being decoded is skipped rather
  // than queued, because this is a frame stream and the newest frame is the one
  // worth showing.
  quietly("Page.screencastFrameAck", { sessionId: params.sessionId });
  if (state.painting) {
    return;
  }
  state.painting = true;
  const image = new Image();
  image.onload = function () {
    if (canvas.width !== image.width || canvas.height !== image.height) {
      canvas.width = image.width;
      canvas.height = image.height;
    }
    context2d.drawImage(image, 0, 0);
    state.painting = false;
  };
  image.onerror = function () {
    state.painting = false;
  };
  image.src = "data:image/jpeg;base64," + params.data;
}

function closeSocket() {
  const socket = state.socket;
  state.socket = null;
  state.pending.clear();
  if (socket) {
    try {
      socket.close();
    } catch (error) {
      // Already closed: nothing to do.
    }
  }
}

/**
 * How the panel asks the gateway to do something to the page.
 *
 * One request shape for both endpoints, because they are one idea: the panel is a
 * viewer, the gateway holds the connection to the browser, and everything the
 * operator does to that page goes through it.
 *
 * The resolution is the historical half (issue #9). It replaces a call the panel
 * used to make on its own control channel: Chromium 154 clears an override when
 * the session that posed it detaches, and closing the panel detaches exactly that
 * session, so the operator's viewport died with the tab, which is the case the
 * pane exists for. The gateway poses it instead, on a session that lives as long
 * as the container, and the answer carries the numbers it applied.
 *
 * The other half is the page itself: the address bar and the history buttons. The
 * desktop pane drives its own browser through its host; this one asks the
 * gateway, so the panel never opens a channel of its own and there is one owner
 * per page.
 */
function askPanel(path, mode, extra) {
  return fetch(PANEL_PREFIX + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(Object.assign({ mode: mode, targetId: state.targetId }, extra || {})),
  }).then(function (response) {
    if (!response.ok) {
      return response.text().then(function (text) {
        throw new Error(text || "the " + path + " request failed with " + response.status);
      });
    }
    return response.json();
  });
}

function connect(targetId) {
  const previous = state.targetId;
  if (previous && previous !== targetId) {
    // The page the panel moves away from keeps the size it has, but nothing
    // forces it any more: coming back to it later starts from what it reports.
    askPanel("viewport", "release").catch(function () {});
  }
  closeSocket();
  state.targetId = targetId;
  state.frameViewport = null;
  state.frameStamp = 0;
  // The override the previous panel applied belongs to the page it applied it to,
  // so a new attachment starts from what the new page reports.
  state.appliedViewport = null;
  state.appliedStamp = 0;
  state.frames = 0;
  state.dirty = false;
  const target = state.targets.filter(function (entry) {
    return entry.id === targetId;
  })[0];
  // The address bar starts on where the target is, before the page reports
  // anything: a target that never answers still says which page it is.
  if (target && document.activeElement !== addressEl) {
    addressEl.value = target.url;
  }
  devtoolsEl.href = devtoolsUrlFor(targetId, { host: location.host, protocol: location.protocol }) || "#";
  targetEl.value = targetId;
  const url = socketUrlFor(PANEL_PREFIX + "devtools/page/" + targetId, { host: location.host, protocol: location.protocol });
  if (!url) {
    setStatus("this target cannot be reached through the panel", "error");
    return;
  }
  setStatus("connecting");
  const socket = new WebSocket(url);
  state.socket = socket;
  socket.onopen = function () {
    setStatus("connected", "connected");
    quietly("Page.enable", {});
    // The picture bounds, not the values the fields hold: a round trip later
    // refreshReported adopts the size the page reports, and whatever is asked for
    // here is the cap for the rest of the session (Chromium refuses a second
    // startScreencast while one runs). Capping on the fields at this point would
    // freeze the picture at the defaults, 1280x800, even after the operator
    // widens the viewport.
    send("Page.startScreencast", screencastParams()).catch(function (error) {
      setStatus(error.message, "error");
    });
    // A size the operator already chose for this target is put back if something
    // else cleared it while nobody was watching, and the fields are filled from
    // what the page reports afterwards, so a page nobody resized is left exactly
    // as it was: opening the panel changes nothing until Apply is pressed.
    askPanel("viewport", "attach")
      .then(function (answer) {
        if (answer && answer.restored) {
          setStatus("viewport " + answer.width + "x" + answer.height + " restored", "connected");
        }
      })
      .catch(function (error) {
        setStatus(error.message, "error");
      })
      .then(function () {
        refreshReported(true);
      });
  };
  socket.onmessage = onMessage;
  socket.onerror = function () {
    setStatus("the connection failed", "error");
  };
  socket.onclose = function () {
    if (state.socket !== socket) {
      return;
    }
    state.socket = null;
    setStatus("disconnected, retrying");
    if (state.retry) {
      clearTimeout(state.retry);
    }
    state.retry = setTimeout(function () {
      state.retry = null;
      refreshTargets();
    }, 2000);
  };
}

function refreshReported(adopt) {
  // One round trip answers both questions the header and the footer ask: the size
  // the page reports, and the address it is at right now. The address matters
  // because the agent navigates this page under the operator: a panel that only
  // showed the URL it attached to would claim the wrong page after every
  // navigation.
  return evaluate("JSON.stringify([innerWidth + 'x' + innerHeight, location.href])")
    .then(function (value) {
      let size = null;
      let href = null;
      try {
        const parsed = JSON.parse(value);
        size = parsed[0];
        href = parsed[1];
      } catch (error) {
        return;
      }
      if (typeof href === "string" && href !== "") {
        // The address bar follows the page, except while the operator is typing in
        // it: a navigation the agent makes under their hands must not replace a
        // half-typed address.
        if (document.activeElement !== addressEl) {
          addressEl.value = href;
        }
        externalEl.href = href;
        externalEl.title = "Open in default browser: " + href;
        if (state.href !== null && state.href !== href) {
          // The page the panel is attached to navigated under it, which is what
          // the agent does all the time: the target list is asked again so the
          // selector, which carries the page title, stops describing the previous
          // document.
          refreshTargets();
        }
        state.href = href;
      }
      if (typeof size !== "string" || size.indexOf("x") < 1) {
        return;
      }
      reportedEl.textContent = "page reports " + size;
      if (adopt && !state.dirty && !fitEl.checked) {
        const parts = size.split("x");
        widthEl.value = parts[0];
        heightEl.value = parts[1];
        syncPresets(parts[0], parts[1]);
      }
    })
    .catch(function () {});
}

/**
 * Points the selector at the size in force.
 *
 * A size that is none of the presets is shown as custom rather than leaving the
 * previous preset selected: the selector describes the page, and a page that was
 * sized by hand, by the agent, or by an earlier panel is not one of these.
 */
function syncPresets(width, height) {
  const wanted = width + "x" + height;
  const known = VIEWPORT_PRESETS.filter(function (preset) {
    return preset.width + "x" + preset.height === wanted;
  })[0];
  presetsEl.value = known ? wanted : "custom";
}

function applyViewport(width, height) {
  const viewport = clampViewport({ width: width, height: height });
  widthEl.value = viewport.width;
  heightEl.value = viewport.height;
  setStatus("applying " + viewport.width + "x" + viewport.height);
  return askPanel("viewport", "apply", { width: viewport.width, height: viewport.height })
    .then(function (answer) {
      // The numbers the gateway applied, not the ones that were asked for: it
      // clamps on the same bounds, and those are the ones the page is at now.
      const applied = clampViewport({ width: answer.width, height: answer.height });
      widthEl.value = applied.width;
      heightEl.value = applied.height;
      syncPresets(applied.width, applied.height);
      // The page is at the new size the moment the override lands, while the
      // picture is still the previous frame for a few milliseconds. The stamp is
      // what tells the input mapping which of the two is the newer information,
      // so a click made in that window is aimed at the layout the page has; the
      // next frame replaces this with the same numbers, measured rather than
      // assumed.
      state.appliedViewport = applied;
      state.stamp += 1;
      state.appliedStamp = state.stamp;
      setStatus("viewport " + applied.width + "x" + applied.height, "connected");
      if (typeof answer.reported === "string") {
        reportedEl.textContent = "page reports " + answer.reported;
      }
      return refreshReported(false);
    })
    .catch(function (error) {
      setStatus(error.message, "error");
    });
}

function stageViewport() {
  const rect = stage.getBoundingClientRect();
  return clampViewport({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
}

function refreshTargets() {
  return fetch(PANEL_PREFIX + "json/list", { headers: { accept: "application/json" } })
    .then(function (response) {
      if (!response.ok) {
        throw new Error("the target list answered " + response.status);
      }
      return response.json();
    })
    .then(function (list) {
      const targets = panelTargets(list);
      state.targets = targets;
      // The label carries the page title and the url does not, so both are part
      // of what has to change before the selector is rebuilt.
      const signature = targets
        .map(function (entry) {
          return entry.id + "|" + entry.title;
        })
        .join(" ");
      if (signature !== state.targetIds) {
        state.targetIds = signature;
        targetEl.textContent = "";
        targets.forEach(function (entry) {
          const option = document.createElement("option");
          option.value = entry.id;
          option.textContent = entry.title + " (" + entry.id.slice(0, 8) + ")";
          targetEl.appendChild(option);
        });
        // Replacing the options resets the selection to the first one, so the
        // target the panel is attached to is selected again.
        if (state.targetId) {
          targetEl.value = state.targetId;
        }
      }
      if (!targets.length) {
        setStatus("no page target: ask the agent to open one", "error");
        return;
      }
      const current = targets.filter(function (entry) {
        return entry.id === state.targetId;
      })[0];
      if (!current) {
        connect(targets[0].id);
      }
    })
    .catch(function (error) {
      setStatus(error.message, "error");
    });
}

/**
 * One navigation, from the address bar or a history button.
 *
 * The gateway answers with the address the page ended on, so the bar shows the
 * truth even when the site redirected, and the same round trip updates the
 * reported size: a navigation is a layout change like any other.
 */
function drivePage(mode, extra) {
  setStatus(mode === "navigate" ? "opening" : mode);
  return askPanel("page", mode, extra)
    .then(function (answer) {
      if (answer && typeof answer.url === "string" && document.activeElement !== addressEl) {
        addressEl.value = answer.url;
      }
      setStatus("connected", "connected");
      return refreshReported(false);
    })
    .catch(function (error) {
      setStatus(error.message, "error");
      // The bar goes back to where the page really is: a refused address must not
      // stay in the field looking like the current one.
      return refreshReported(false);
    });
}

function mappedPoint(event) {
  const viewport = inputViewport({
    frame: state.frameViewport,
    frameStamp: state.frameStamp,
    applied: state.appliedViewport,
    appliedStamp: state.appliedStamp,
  });
  return canvasToViewport({ x: event.clientX, y: event.clientY }, { rect: canvas.getBoundingClientRect(), viewport });
}

function sendMouse(type, event, extra) {
  const point = mappedPoint(event);
  if (!point) {
    return;
  }
  const passive = type === "mouseMoved" || type === "mouseWheel";
  const params = mouseParams(
    Object.assign(
      {
        type: type,
        point: point,
        button: passive ? undefined : buttonName(event.button),
        buttons: event.buttons,
        clickCount: event.detail,
      },
      extra || {},
    ),
  );
  if (params) {
    quietly("Input.dispatchMouseEvent", params);
  }
}

canvas.addEventListener("mousemove", function (event) {
  sendMouse("mouseMoved", event);
});
canvas.addEventListener("mousedown", function (event) {
  sendMouse("mousePressed", event);
});
canvas.addEventListener("mouseup", function (event) {
  sendMouse("mouseReleased", event);
});
canvas.addEventListener(
  "wheel",
  function (event) {
    event.preventDefault();
    sendMouse("mouseWheel", event, { deltaX: event.deltaX, deltaY: event.deltaY });
  },
  { passive: false },
);
canvas.addEventListener("contextmenu", function (event) {
  event.preventDefault();
});
canvas.addEventListener("keydown", function (event) {
  // Tab is the one key the panel must swallow: without it the operator's focus
  // walks out of the canvas and the next keystrokes go to the panel's own
  // controls instead of the page.
  if (event.key === "Tab") {
    event.preventDefault();
  }
  keyCommands(event).forEach(function (command) {
    quietly("Input.dispatchKeyEvent", command);
  });
});
canvas.addEventListener("keyup", function (event) {
  keyUpCommands(event).forEach(function (command) {
    quietly("Input.dispatchKeyEvent", command);
  });
});

refreshEl.addEventListener("click", function () {
  refreshTargets();
});
targetEl.addEventListener("change", function () {
  connect(targetEl.value);
});
addressEl.addEventListener("keydown", function (event) {
  if (event.key !== "Enter") {
    return;
  }
  event.preventDefault();
  const typed = addressEl.value.trim();
  if (typed === "") {
    return;
  }
  addressEl.blur();
  drivePage("navigate", { url: typed });
});
backEl.addEventListener("click", function () {
  drivePage("back");
});
forwardEl.addEventListener("click", function () {
  drivePage("forward");
});
reloadEl.addEventListener("click", function () {
  drivePage("reload");
});
detachEl.addEventListener("click", function () {
  // The web app cannot host this page in its own side pane (its browser pane is a
  // desktop guest, see README.md), so the third column is this page in a window of
  // its own, opened at the size the desktop pane is usually given.
  window.open(location.href, "_blank", "noopener,width=1366,height=900");
});
presetsEl.addEventListener("change", function () {
  const parts = String(presetsEl.value).split("x");
  if (parts.length !== 2) {
    return;
  }
  // One gesture, like the desktop control: choosing a preset is applying it. The
  // fields follow the answer, so a clamped size is shown as the page has it.
  state.dirty = false;
  applyViewport(parts[0], parts[1]);
});
applyEl.addEventListener("click", function () {
  state.dirty = false;
  applyViewport(widthEl.value, heightEl.value);
});
widthEl.addEventListener("input", function () {
  state.dirty = true;
});
heightEl.addEventListener("input", function () {
  state.dirty = true;
});
fitEl.addEventListener("change", function () {
  const on = fitEl.checked;
  widthEl.disabled = on;
  heightEl.disabled = on;
  state.dirty = false;
  if (on) {
    const viewport = stageViewport();
    applyViewport(viewport.width, viewport.height);
    observer.observe(stage);
  } else {
    observer.disconnect();
  }
});

const observer = new ResizeObserver(function () {
  if (!fitEl.checked) {
    return;
  }
  if (state.fitTimer) {
    clearTimeout(state.fitTimer);
  }
  state.fitTimer = setTimeout(function () {
    state.fitTimer = null;
    const viewport = stageViewport();
    applyViewport(viewport.width, viewport.height);
  }, 250);
});

setInterval(function () {
  if (state.socket && state.socket.readyState === 1) {
    refreshReported(false);
  }
  const age = state.lastFrameAt ? Math.round((Date.now() - state.lastFrameAt) / 1000) : null;
  pictureEl.textContent =
    "frames " + state.frames + (age === null ? "" : ", last one " + age + "s ago") + (state.frameViewport ? ", " + state.frameViewport.width + "x" + state.frameViewport.height : "");
}, 1000);

window.addEventListener("pagehide", function () {
  closeSocket();
});

refreshTargets();
`;

/**
 * The page. `panelHelpersScript()` must be the first script block and the wiring
 * the second: the test that runs the served helpers in a sandbox takes the first
 * block, and the wiring has no business being unit tested.
 */
export function panelPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<title>Browser panel | ZCloudium</title>
<style>${STYLE}</style>
</head>
<body>
<header class="bar">
<span class="brand"><span class="dot"></span>Browser panel</span>
<span class="badge" id="shared" title="The agent drives this same page: your clicks and its actions land in one browser, and neither side blocks the other.">Shared with the agent</span>
<span class="status" id="status">starting</span>
</header>
<div class="bar nav">
<button id="back" class="icon" type="button" aria-label="Back" title="Back"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
<button id="forward" class="icon" type="button" aria-label="Forward" title="Forward"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></button>
<button id="reload" class="icon" type="button" aria-label="Refresh" title="Refresh"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg></button>
<input id="address" class="address" type="text" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Address" placeholder="Enter a URL and press Enter">
<a id="external" class="icon" href="#" target="_blank" rel="noopener" aria-label="Open in default browser" title="Open in default browser"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg></a>
<button id="detach" class="icon" type="button" aria-label="Detach panel" title="Open the panel in its own window"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-8 8"/><rect x="3" y="9" width="11" height="12" rx="2"/></svg></button>
</div>
<div class="bar">
<label for="target">target</label>
<select id="target"></select>
<button id="refresh" type="button">Refresh targets</button>
<span class="sep"></span>
<label for="presets">preset</label>
<select id="presets">
${VIEWPORT_PRESETS.map(
  (preset) =>
    `<option value="${preset.width}x${preset.height}"${preset.width === DEFAULT_VIEWPORT.width && preset.height === DEFAULT_VIEWPORT.height ? " selected" : ""}>${preset.label}</option>`,
).join("\n")}
<option value="custom">custom</option>
</select>
<label for="width">width</label>
<input id="width" type="number" min="${VIEWPORT_MIN}" max="${VIEWPORT_MAX_WIDTH}" step="1" value="${DEFAULT_VIEWPORT.width}" inputmode="numeric">
<label for="height">height</label>
<input id="height" type="number" min="${VIEWPORT_MIN}" max="${VIEWPORT_MAX_HEIGHT}" step="1" value="${DEFAULT_VIEWPORT.height}" inputmode="numeric">
<label class="check" for="fit"><input id="fit" type="checkbox"> fit</label>
<button id="apply" class="primary" type="button">Apply</button>
<span class="sep"></span>
<a id="devtools" class="button" href="#" target="_blank" rel="noopener">Open DevTools</a>
</div>
<div class="stage" id="stage"><canvas id="screen" tabindex="0"></canvas></div>
<footer class="bar bottom">
<span id="reported">page reports ?</span>
<span id="picture">frames 0</span>
<span>Click the picture to focus it, then type. The picture is a frame stream, not video: it updates when the page changes.</span>
</footer>
<script>${panelHelpersScript()}</script>
<script>${PANEL_WIRING}</script>
</body>
</html>
`;
}
