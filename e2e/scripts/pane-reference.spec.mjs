/**
 * Visual reference of the current panel, before it is rewritten.
 *
 * Temporary: it exists to look at the operator pane and at the application it
 * sits in, so the rewrite has something to be compared against.
 */

import { test } from "@playwright/test";
import { STORAGE_STATE } from "../lib/state.mjs";

test.describe("panel reference", () => {
  test.use({ storageState: STORAGE_STATE });

  test("the panel as it stands, with a viewport applied", async ({ page }) => {
    await page.goto("/_browser/");
    await page.waitForTimeout(6000);
    await page.screenshot({ path: "test-results/panel-before.png" });

    const status = await page.locator("#status").innerText().catch(() => "(pas de statut)");
    console.log("PANEL-STATUS", JSON.stringify(status));
    const picture = await page.locator("#picture").innerText().catch(() => "(pas d'image)");
    console.log("PANEL-PICTURE", JSON.stringify(picture));

    const width = page.locator("#width");
    const height = page.locator("#height");
    if ((await width.count()) > 0) {
      await width.fill("800");
      await height.fill("600");
      const apply = page.getByRole("button", { name: /apply/i });
      if ((await apply.count()) > 0) {
        await apply.first().click();
        await page.waitForTimeout(4000);
      }
    }
    console.log("PANEL-PICTURE-AFTER", JSON.stringify(await page.locator("#picture").innerText().catch(() => "(illisible)")));
    await page.screenshot({ path: "test-results/panel-after.png" });
  });

  test("the application around the panel", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(6000);
    const skip = page.getByTestId("login-api-key-skip-button");
    if ((await skip.count()) > 0) {
      await skip.first().click();
      await page.waitForTimeout(4000);
    }
    await page.screenshot({ path: "test-results/app.png" });
  });
});
