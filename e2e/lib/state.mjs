/**
 * Shared state between the wizard run and the rest of the suite.
 *
 * The wizard spec is the only thing that can create the account: setup runs
 * once per data volume, and the container is started with a clean one. What it
 * learned (the credentials, the base32 secret, the TOTP step that enrolment
 * spent) is written here, and the other specs read it. Without the step, a sign
 * in that follows enrolment would present a code the server already accepted and
 * would be refused as a replay, which is correct behaviour and not a bug to
 * paper over.
 *
 * The browser session itself travels through Playwright's storageState file,
 * next to it in the same directory.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const AUTH_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".auth");
export const STORAGE_STATE = join(AUTH_DIR, "session.json");
export const ACCOUNT_STATE = join(AUTH_DIR, "account.json");

/** The account the suite creates for itself. Nothing here comes from the image. */
export const ACCOUNT = {
  username: "e2e-operator",
  password: "e2e-Correct-Horse-Battery",
};

export async function writeAccount(account) {
  await mkdir(AUTH_DIR, { recursive: true });
  await writeFile(ACCOUNT_STATE, `${JSON.stringify(account, null, 2)}\n`, "utf8");
}

export async function readAccount() {
  return JSON.parse(await readFile(ACCOUNT_STATE, "utf8"));
}

/**
 * Records that the server has now accepted a code from this step, so the next
 * sign in asks the authenticator for a code the server has not seen yet.
 */
export async function noteUsedStep(step) {
  const account = await readAccount();
  account.lastUsedStep = Math.max(Number(account.lastUsedStep ?? -1), step);
  await writeAccount(account);
  return account;
}
