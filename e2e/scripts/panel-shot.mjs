/**
 * A look at the panel, for the eyes only.
 *
 * Not a test, and not run by the suite: it opens the panel of a running container
 * with the session the end to end suite leaves behind, chooses a viewport preset,
 * and writes a screenshot. It is what to reach for while working on the panel,
 * where the acceptance is visual and the suite's assertions are about behaviour:
 *
 *   E2E_BASE_URL=http://127.0.0.1:3032 SHOT=panel.png node scripts/panel-shot.mjs
 *
 * PRESET picks the size to apply, by its `widthxheight` value (default 1920x1080),
 * and NAVIGATE, when set, is an address typed into the panel's address bar first.
 * The container must be one the suite has run against, so that `../lib/state.mjs`
 * holds a session that signs in; start one with start-container.sh, then run the
 * suite once.
 */

import { chromium } from "@playwright/test";
import { STORAGE_STATE } from "../lib/state.mjs";

const base = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3032";
const shot = process.env.SHOT ?? "panel.png";
const preset = process.env.PRESET ?? "1920x1080";
const navigate = process.env.NAVIGATE ?? "";

const browser = await chromium.launch();
const context = await browser.newContext({
  storageState: STORAGE_STATE,
  baseURL: base,
  viewport: { width: 1440, height: 900 },
});
const panel = await context.newPage();
await panel.goto("/_browser/");
await panel.waitForFunction(() => document.getElementById("status")?.textContent === "connected", null, { timeout: 20_000 });
await panel.waitForTimeout(2_500);
const adopted = await panel.locator("#address").inputValue();

if (navigate !== "") {
  await panel.locator("#address").fill(navigate);
  await panel.locator("#address").press("Enter");
  await panel.waitForTimeout(2_500);
}

await panel.selectOption("#presets", preset);
await panel.waitForFunction((size) => new RegExp(size).test(document.getElementById("reported")?.textContent ?? ""), preset, {
  timeout: 15_000,
});
await panel.waitForTimeout(1_500);
await panel.screenshot({ path: shot });

console.log(
  JSON.stringify(
    {
      adoptedOnOpen: adopted,
      address: await panel.locator("#address").inputValue(),
      preset: await panel.locator("#presets").inputValue(),
      width: await panel.locator("#width").inputValue(),
      height: await panel.locator("#height").inputValue(),
      reported: await panel.locator("#reported").innerText(),
      picture: await panel.locator("#picture").innerText(),
      shot,
    },
    null,
    2,
  ),
);
await browser.close();
