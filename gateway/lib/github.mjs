/**
 * GitHub credentials, stored where gh itself looks for them.
 *
 * The operator authenticates once, in the container, through the /_auth/github
 * page: a personal access token is validated against the GitHub API and written
 * as a standard `hosts.yml`. Everything that provisions environments from this
 * container reads that same file and copies it into the new environment, so the
 * one enrolment covers gh and git in every cloud environment — and the
 * container's own gh, if one is ever installed, picks it up too for free,
 * because the file sits at $HOME/.config/gh/hosts.yml.
 *
 * The file is the single source of truth: there is no parallel gateway-side
 * copy to drift. Its mode is 0600 and its directory 0700, and it lives on the
 * same /data volume — the same trust boundary as users.json.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const GITHUB_HOST = "github.com";
const GITHUB_API_USER = "https://api.github.com/user";

export function hostsYmlPath(dataDir) {
  return join(dataDir, ".config", "gh", "hosts.yml");
}

/** The hosts.yml gh itself writes; a format any recent gh reads back. */
export function buildHostsYml({ login, token }) {
  return [
    `${GITHUB_HOST}:`,
    "    git_protocol: https",
    "    users:",
    `        ${login}:`,
    `            oauth_token: ${token}`,
    `    user: ${login}`,
    "",
  ].join("\n");
}

/**
 * Status for the page: whether a file is there and which login it carries.
 * The token itself never comes back out of this module.
 */
export async function readGitHubCredentials(dataDir) {
  let text;
  try {
    text = await readFile(hostsYmlPath(dataDir), "utf8");
  } catch {
    return { present: false, login: null };
  }
  // The login sits at the 8-space level (under `users:`); the flat
  // `user:` line is the fallback.
  const login =
    text.match(/^ {8}(\S+):\s*$/m)?.[1] ?? text.match(/^ {4}user:\s*(\S+)/m)?.[1] ?? null;
  const hasToken = /oauth_token:\s*\S+/.test(text);
  return { present: hasToken, login: hasToken ? login : null };
}

export async function writeGitHubCredentials(dataDir, { login, token }) {
  const path = hostsYmlPath(dataDir);
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, buildHostsYml({ login, token }), { mode: 0o600 });
  return path;
}

export async function removeGitHubCredentials(dataDir) {
  await rm(hostsYmlPath(dataDir), { force: true });
}

/**
 * Validate a token the operator pasted, by asking GitHub who it belongs to.
 * `fetchImpl` is injectable so tests never touch the network.
 */
export async function validateGitHubToken(token, fetchImpl = fetch) {
  if (!token || token.length < 20 || /\s/.test(token)) {
    return { ok: false, error: "That does not look like a GitHub token." };
  }
  let response;
  try {
    response = await fetchImpl(GITHUB_API_USER, {
      headers: {
        authorization: `Bearer ${token}`,
        "user-agent": "z-cloudium-gateway",
        accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return {
      ok: false,
      error: `GitHub did not answer: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (response.status === 401) {
    return { ok: false, error: "GitHub refused that token (401). Check that it is valid and not expired." };
  }
  if (!response.ok) {
    return { ok: false, error: `GitHub answered ${response.status}; the token was not stored.` };
  }
  let login;
  try {
    login = (await response.json())?.login;
  } catch {
    return { ok: false, error: "GitHub answered something this gateway cannot read." };
  }
  if (typeof login !== "string" || !login) {
    return { ok: false, error: "GitHub did not say which account the token belongs to." };
  }
  return { ok: true, login };
}
