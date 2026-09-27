/**
 * Playwright configuration for the end to end suite.
 *
 * The suite never starts the product itself: it drives a container that is
 * already running, published on E2E_BASE_URL (3032 by default, which is the port
 * the run script publishes). Keeping the two apart is what lets the same suite
 * run against a local container and against one started by CI.
 *
 * One worker, deliberately. TOTP replay protection means two sign ins racing in
 * the same 30 second window cannot both succeed: the second one presents a code
 * the server has already accepted. A suite that signs in has to be sequential.
 */

import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "https://127.0.0.1:3032";

export default defineConfig({
  testDir: "./tests",
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // The interface is a full web application served by a Node process: give the
  // first paint room, the assertions themselves stay tight.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  outputDir: "test-results",
  use: {
    baseURL,
    // The gateway serves https by default, with a certificate it generated itself
    // and nobody signed. The suite drives that deployment, so it accepts it: what
    // is under test is the product, not the certificate.
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      // Runs first, creates the account, and leaves the credentials, the secret
      // and the browser session behind for the other projects.
      name: "wizard",
      testMatch: /wizard\.setup\.mjs/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "suite",
      testMatch: /.*\.spec\.mjs/,
      dependencies: ["wizard"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
