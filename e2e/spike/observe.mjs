/**
 * Phase 0 observation run: the five observations of the plan, made by looking.
 *
 * One viewer (a Playwright Chromium on this machine, standing in for the
 * operator's browser) opens Chromium's own DevTools frontend through the gateway,
 * on the page the agent drives. The agent's side comes from the MCP server the
 * container configured, through e2e/spike/agent.mjs, so what is reported as "the
 * agent's observation" is the tool output the agent really receives.
 *
 * Every step writes a screenshot and one JSON line, so the run leaves the raw
 * evidence behind rather than a summary of it.
 *
 *   node e2e/spike/observe.mjs --base http://127.0.0.1:3041 --cookie "zc_sess=..." \
 *        --container zcloudium-p0-panel --out <evidence dir>
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { base: null, cookie: null, container: null, out: null, keepOpen: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    switch (key) {
      case "--base":
        out.base = value;
        index += 1;
        break;
      case "--cookie":
        out.cookie = value;
        index += 1;
        break;
      case "--container":
        out.container = value;
        index += 1;
        break;
      case "--out":
        out.out = value;
        index += 1;
        break;
      case "--keep-open":
        out.keepOpen = true;
        break;
      default:
        throw new Error(`unknown argument: ${key}`);
    }
  }
  if (!out.base || !out.cookie || !out.container || !out.out) {
    throw new Error("--base, --cookie, --container and --out are required");
  }
  return out;
}

const DEFAULTS = { viewport: { width: 1440, height: 900 }, settleMs: 2500 };

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.out, { recursive: true });
  const logFile = join(options.out, "observe.jsonl");
  const notes = [];

  const note = async (payload) => {
    const line = `${JSON.stringify(payload)}\n`;
    process.stdout.write(line);
    await appendFile(logFile, line);
    notes.push(payload);
  };

  /** One agent step through the MCP server the container configured. */
  const agent = async (name, steps, page = "phase0-fixture.html") => {
    const outPath = join(options.out, `agent-${name}.jsonl`);
    const { stdout } = await run(
      process.execPath,
      [
        join(here, "agent.mjs"),
        "--container",
        options.container,
        "--page",
        page,
        "--steps",
        JSON.stringify(steps),
        "--out",
        outPath,
      ],
      { maxBuffer: 32 * 1024 * 1024, timeout: 240_000 },
    );
    const events = stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    const tools = events.filter((event) => event.event === "tool");
    await note({ observation: "agent", name, outPath, tools });
    return tools;
  };

  const textOf = (tool) => tool?.result?.content?.map((part) => part.text ?? "").join("\n") ?? "";

  /** The JSON an evaluate_script answer carries, behind its code fence. */
  const jsonFromTool = (tool) => {
    const text = textOf(tool);
    const fenced = text.match(/```json\s*([\s\S]*?)```/);
    return JSON.parse(fenced ? fenced[1] : text);
  };

  const targets = await (async () => {
    const response = await fetch(`${options.base}/_browser/json/list`, { headers: { cookie: options.cookie } });
    return response.json();
  })();
  const fixtureTarget = targets.find((target) => target.url.includes("phase0-fixture.html"));
  if (!fixtureTarget) {
    throw new Error(`the fixture page is not open: ${JSON.stringify(targets.map((target) => target.url))}`);
  }
  await note({ observation: "targets", fixtureTarget, all: targets.map(({ id, type, url }) => ({ id, type, url })) });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: DEFAULTS.viewport });
  const [cookieName, cookieValue] = options.cookie.split("=");
  await context.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  const consoleLines = [];
  const openViewer = async (targetId, label) => {
    const page = await context.newPage();
    page.on("console", (message) => consoleLines.push(`${label} ${message.type()}: ${message.text()}`));
    page.on("pageerror", (error) => consoleLines.push(`${label} error: ${error.message}`));
    const authority = options.base.replace(/^https?:\/\//, "");
    await page.goto(`${options.base}/_browser/devtools/inspector.html?ws=${authority}/_browser/devtools/page/${targetId}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(DEFAULTS.settleMs);
    return page;
  };

  /** Where a page coordinate falls inside the viewer, by reading the screencast canvas. */
  const screencastMap = (page) =>
    page.evaluate(() => {
      const canvas = document.querySelector(".screencast-canvas-container canvas") ?? document.querySelector("canvas");
      if (!canvas) {
        return null;
      }
      const box = canvas.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, intrinsicWidth: canvas.width, intrinsicHeight: canvas.height };
    });

  const shot = (page, name) => page.screenshot({ path: join(options.out, `${name}.png`) });

  /** The address bar of the frontend: what page the panel says it is showing. */
  const shownUrl = (page) =>
    page
      .locator('input[aria-label="Address bar"]')
      .first()
      .inputValue({ timeout: 5000 })
      .catch(() => null);

  /** A digest of a screenshot, so "the picture changed" is a number and not an impression. */
  const digestOf = async (name) => {
    const bytes = await readFile(join(options.out, `${name}.png`));
    return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16) };
  };

  /** Clicks a page coordinate through the panel, using the element's own rect. */
  const clickPagePoint = async (page, point) => {
    const map = await screencastMap(page);
    if (!map) {
      throw new Error("no screencast canvas in the viewer");
    }
    const scaleX = map.width / map.intrinsicWidth;
    const scaleY = map.height / map.intrinsicHeight;
    const x = map.x + point.x * scaleX;
    const y = map.y + point.y * scaleY;
    await page.mouse.click(x, y);
    return { map, x, y };
  };

  const viewer = await openViewer(fixtureTarget.id, "obs1");
  await note({
    observation: "obs1-setup",
    inspectorUrl: viewer.url(),
    shownUrl: await shownUrl(viewer),
    screencast: await screencastMap(viewer),
  });
  await shot(viewer, "obs1-a-before-navigation");
  const digestA = await digestOf("obs1-a-before-navigation");
  await agent("obs1-before", [
    {
      tool: "evaluate_script",
      args: {
        function:
          "() => ({ url: location.href, loadid: document.getElementById('loadid').textContent, size: document.getElementById('size').textContent })",
      },
    },
  ]);

  // Observation 1: the agent navigates, the picture follows.
  await agent("obs1-navigate", [
    { tool: "navigate_page", args: { type: "url", url: "http://127.0.0.1:3131/" } },
  ]);
  await viewer.waitForTimeout(DEFAULTS.settleMs);
  await shot(viewer, "obs1-b-after-agent-navigation");
  await note({
    observation: "obs1-after-navigation",
    shownUrl: await shownUrl(viewer),
    digests: [digestA, await digestOf("obs1-b-after-agent-navigation"), await digestOf("obs1-c-back-on-the-fixture")],
  });

  await agent(
    "obs1-back",
    [
      { tool: "navigate_page", args: { type: "url", url: "file:///workspace/phase0-fixture.html" } },
      { tool: "evaluate_script", args: { function: "() => ({ loadid: document.getElementById('loadid').textContent })" } },
    ],
    "127.0.0.1:3131",
  );
  await viewer.waitForTimeout(DEFAULTS.settleMs);
  await shot(viewer, "obs1-c-back-on-the-fixture");
  await note({ observation: "obs1-back", shownUrl: await shownUrl(viewer) });

  // Observation 2: what the viewport affordances of the frontend actually are.
  //
  // The frontend Chromium serves is the undocked presentation: a screencast view,
  // the Elements panel and the styles, with no main toolbar. This probes whether
  // any viewport control exists there, then whether the agent's own emulation
  // reaches the page the operator is watching.
  const viewportProbe = { attempts: [] };
  viewportProbe.attempts.push({ attempt: "ctrl-shift-m", before: await screencastMap(viewer) });
  await viewer.keyboard.press("Control+Shift+M");
  await viewer.waitForTimeout(1500);
  await shot(viewer, "obs2-a-after-device-mode-shortcut");
  viewportProbe.attempts[0].after = await screencastMap(viewer);
  viewportProbe.attempts[0].toolbar = await viewer.evaluate(() =>
    [...document.querySelectorAll("input, select, button")]
      .filter((element) => /width|height|device|viewport/i.test(`${element.getAttribute("aria-label") ?? ""} ${element.className} ${element.title}`))
      .map((element) => ({ tag: element.tagName, ariaLabel: element.getAttribute("aria-label"), className: element.className, value: element.value }))
      .slice(0, 30),
  );
  viewportProbe.attempts[0].mainToolbar = await viewer.evaluate(() => Boolean(document.querySelector(".main-toolbar")));
  await note({ observation: "obs2-probe", viewportProbe });

  const emulated = await agent("obs2-emulate", [
    { tool: "emulate", args: { viewport: "400x800x1,mobile" } },
    {
      tool: "evaluate_script",
      args: {
        function:
          "() => ({ innerWidth, innerHeight, narrow: matchMedia('(max-width: 500px)').matches, reported: document.getElementById('size').textContent })",
      },
    },
  ]);
  await viewer.waitForTimeout(2500);
  await shot(viewer, "obs2-b-after-agent-emulation");
  await note({
    observation: "obs2-emulation",
    reportedByPage: emulated[1] ? jsonFromTool(emulated[1]) : null,
    screencast: await screencastMap(viewer),
  });

  // Observation 3: the element picker, and the selector it yields.
  const geometry = await agent("obs3-geometry", [
    {
      tool: "evaluate_script",
      args: {
        function:
          "() => { const r = document.getElementById('target').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, innerWidth, innerHeight, outerHTML: document.getElementById('target').outerHTML }; }",
      },
    },
  ]);
  const targetPoint = jsonFromTool(geometry[0]);
  await note({ observation: "obs3-geometry", targetPoint });

  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: options.base });
  await viewer.keyboard.press("Control+Shift+C");
  await viewer.waitForTimeout(500);
  const clickAt = await clickPagePoint(viewer, targetPoint);
  await viewer.waitForTimeout(1500);
  await shot(viewer, "obs3-a-after-picking");
  const selected = await viewer.evaluate(() => ({
    selected: document.querySelector(".elements-wrap .selected")?.textContent ?? null,
    treeRows: [...document.querySelectorAll(".elements-wrap [role='treeitem']")].length,
    title: document.querySelector(".screencast-element-title")?.textContent ?? null,
  }));
  await note({ observation: "obs3-selection", clickAt, selected });

  // The selector, taken the way an operator takes it: right click on the selected
  // node, Copy, Copy selector, then read the clipboard.
  let copied = null;
  let copyError = null;
  try {
    const node = viewer.locator(".elements-wrap .selected").first();
    await node.click({ button: "right" });
    await viewer.waitForTimeout(800);
    await shot(viewer, "obs3-b-context-menu");
    const menuText = await viewer.evaluate(() =>
      [...document.querySelectorAll(".soft-context-menu-item, [role='menuitem']")].map((element) => element.textContent?.trim()),
    );
    await note({ observation: "obs3-menu", items: menuText });
    const copy = viewer.locator(".soft-context-menu-item", { hasText: /^Copy$/ }).first();
    await copy.hover();
    await viewer.waitForTimeout(900);
    await shot(viewer, "obs3-c-copy-submenu");
    await viewer.locator(".soft-context-menu-item", { hasText: /Copy selector/ }).first().click();
    await viewer.waitForTimeout(500);
    copied = await viewer.evaluate(() => navigator.clipboard.readText());
  } catch (error) {
    copyError = error.message;
  }
  await note({ observation: "obs3-copied-selector", copied, copyError });

  const resolved = copied
    ? await agent("obs3-resolve", [
        {
          tool: "evaluate_script",
          args: {
            function: `() => { const element = document.querySelector(${JSON.stringify(copied)}); return { found: Boolean(element), tag: element?.tagName ?? null, id: element?.id ?? null, text: element?.textContent ?? null }; }`,
          },
        },
      ])
    : null;
  await note({
    observation: "obs3-agent-view",
    resolved: resolved ? textOf(resolved[0]) : null,
    snapshot: resolved ? textOf(resolved[1]) : null,
    tools: await agent("obs3-snapshot", [{ tool: "take_snapshot", args: {} }]),
  });

  // Observation 4: the operator types in the page, the agent sees it.
  const inputGeometry = await agent("obs4-geometry", [
    {
      tool: "evaluate_script",
      args: {
        function:
          "() => { const r = document.getElementById('typed').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }",
      },
    },
  ]);
  const inputPoint = jsonFromTool(inputGeometry[0]);
  // The picker leaves inspect mode after a pick, and a click sends the pick
  // itself rather than the click: Escape makes sure this click lands on the page
  // as a click, which is what an operator does before typing.
  await viewer.keyboard.press("Escape");
  await viewer.waitForTimeout(400);
  const focusClick = await clickPagePoint(viewer, inputPoint);
  await viewer.waitForTimeout(700);
  const focusCheck = await agent("obs4-focus", [
    {
      tool: "evaluate_script",
      args: { function: "() => ({ active: document.activeElement?.id ?? null, tag: document.activeElement?.tagName ?? null })" },
    },
  ]);
  await note({ observation: "obs4-click-focus", clickAt: focusClick, agentSaw: jsonFromTool(focusCheck[0]) });

  await viewer.keyboard.type("hello-from-the-operator", { delay: 40 });
  await viewer.waitForTimeout(1200);
  await shot(viewer, "obs4-a-after-typing");
  await note({
    observation: "obs4-agent-view",
    typedIn: inputPoint,
    tools: await agent("obs4-read", [
      {
        tool: "evaluate_script",
        args: {
          function:
            "() => { const i = document.getElementById('typed'); return { value: i.value, mirror: document.getElementById('typedmirror').textContent, title: document.title, active: document.activeElement === i }; }",
        },
      },
    ]),
  });

  // Observation 5: the state before the viewer goes away.
  const readState = (name) =>
    agent(name, [
      {
        tool: "evaluate_script",
        args: {
          function:
            "() => ({ loadid: document.getElementById('loadid').textContent, value: document.getElementById('typed').value, href: location.href, clock: document.getElementById('clock').textContent })",
        },
      },
    ]);

  const beforeClose = await readState("obs5-before-close");
  await viewer.close();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const afterClose = await readState("obs5-after-close");
  await note({
    observation: "obs5-close",
    beforeClose: jsonFromTool(beforeClose[0]),
    afterClose: jsonFromTool(afterClose[0]),
  });

  const reopened = await openViewer(fixtureTarget.id, "obs5");
  await shot(reopened, "obs5-a-reopened-same-state");
  const afterReopen = await readState("obs5-after-reopen");
  await note({
    observation: "obs5-reopen",
    afterReopen: jsonFromTool(afterReopen[0]),
    reopenedShownUrl: await shownUrl(reopened),
  });

  // Still drivable with no viewer attached at all, which is the unattended case.
  const stillDrivable = await agent("obs5-still-drivable", [
    { tool: "navigate_page", args: { type: "reload" } },
    {
      tool: "evaluate_script",
      args: { function: "() => ({ loadid: document.getElementById('loadid').textContent, href: location.href })" },
    },
  ]);
  await note({ observation: "obs5-still-drivable", tools: stillDrivable.map(textOf) });

  await writeFile(join(options.out, "viewer-console.txt"), `${consoleLines.join("\n")}\n`);
  await note({ observation: "done", viewerConsole: consoleLines.length });
  if (!options.keepOpen) {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`observe.mjs: ${error.stack ?? error.message}\n`);
  process.exit(1);
});
