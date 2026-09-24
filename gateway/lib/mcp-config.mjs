/**
 * The agent configuration merge for the baked browser MCP server.
 *
 * ZCode reads its MCP servers from `<home>/.zcode/cli/config.json`, under
 * `mcp.servers`. The image ships a browser MCP server so that browser
 * automation works in web mode, where the built-in Browser Use cannot start.
 *
 * This module only ever adds one entry, and only with the values it was given.
 * The file also holds the operator's provider keys, so every code path here is
 * written to leave it intact: refuse on anything unexpected, keep a copy of the
 * previous content before the first modification, write atomically.
 */

import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Name under `mcp.servers`: it is what the tools are prefixed with. */
export const BROWSER_SERVER_NAME = "chrome-devtools";

/** Baked at image build time, never installed at runtime. */
export const BROWSER_MCP_PACKAGE = "chrome-devtools-mcp";
export const BROWSER_MCP_VERSION = "1.10.1";
export const BROWSER_MCP_COMMAND = "/usr/local/bin/chrome-devtools-mcp";
/** Chromium from the distribution, the one `chromium --version` reports in the image. */
export const BROWSER_MCP_EXECUTABLE = "/usr/bin/chromium";

/**
 * `--headless`: the container has no display.
 * `--isolated`: a throwaway profile under the temporary directory, so the
 *   operator home stays clean and the read-only root filesystem needs nothing.
 * `--chromeArg=--no-sandbox`: the container runs with `no-new-privileges` and no
 *   capability, so Chromium cannot use its setuid or namespace sandbox. See
 *   SECURITY.md: the consequence is stated there, not hidden.
 * `--no-usage-statistics` and `--no-performance-crux`: upstream defaults are on
 *   and would send data to Google, which contradicts the rest of this image.
 */
export const BROWSER_MCP_ARGS = [
  "--headless",
  "--isolated",
  "--executablePath",
  BROWSER_MCP_EXECUTABLE,
  "--chromeArg=--no-sandbox",
  "--no-usage-statistics",
  "--no-performance-crux",
];

/** Chromium takes seconds to answer; the agent must not give up before that. */
export const BROWSER_MCP_TIMEOUT_MS = 60_000;

/** A fresh entry, so a caller cannot mutate the constants through it. */
export function browserServerEntry() {
  return {
    type: "stdio",
    command: BROWSER_MCP_COMMAND,
    args: [...BROWSER_MCP_ARGS],
    enabled: true,
    timeoutMs: BROWSER_MCP_TIMEOUT_MS,
  };
}

export function mcpConfigPath(home) {
  return join(home, ".zcode", "cli", "config.json");
}

/** Kept next to the file it protects, and created only once. */
export function backupPathFor(configPath) {
  return `${configPath}.zcloudium-backup`;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural comparison, key order insensitive: the file may be hand written. */
export function deepEqual(left, right) {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
    );
  }
  return false;
}

/**
 * Pure merge: returns the configuration to write and whether writing it would
 * change anything. Throws a TypeError instead of guessing when the structure is
 * not the one it knows, so the caller can refuse rather than damage the file.
 */
export function mergeMcpServer(config, name = BROWSER_SERVER_NAME, entry = browserServerEntry()) {
  if (!isPlainObject(config)) {
    throw new TypeError("the configuration must be a JSON object");
  }
  if (typeof name !== "string" || name === "") {
    throw new TypeError("the server name must be a non-empty string");
  }
  if (!isPlainObject(entry)) {
    throw new TypeError("the server entry must be a JSON object");
  }
  if (config.mcp !== undefined && !isPlainObject(config.mcp)) {
    throw new TypeError("mcp must be a JSON object");
  }
  if (config.mcp?.servers !== undefined && !isPlainObject(config.mcp.servers)) {
    throw new TypeError("mcp.servers must be a JSON object");
  }

  const existing = config.mcp?.servers?.[name];
  if (existing !== undefined && deepEqual(existing, entry)) {
    return { config, changed: false };
  }

  const merged = structuredClone(config);
  merged.mcp = { ...(merged.mcp ?? {}) };
  merged.mcp.servers = { ...(merged.mcp.servers ?? {}), [name]: structuredClone(entry) };
  return { config: merged, changed: true };
}

/** Atomic write in the same directory, so a crash cannot truncate the file. */
async function writeAtomic(path, body, mode) {
  const temporary = `${path}.zcloudium-tmp`;
  await writeFile(temporary, body, { mode });
  await chmod(temporary, mode).catch(() => {});
  await rename(temporary, path);
}

/** Keeps the content that was there before the very first modification. */
async function backupOnce(backupPath, content, mode) {
  try {
    await stat(backupPath);
    return false;
  } catch {
    // Absent: this is the first modification.
  }
  await writeFile(backupPath, content, { mode });
  await chmod(backupPath, mode).catch(() => {});
  return true;
}

/**
 * Applies the entry to `<home>/.zcode/cli/config.json`.
 *
 * Statuses:
 *   `created`   the file did not exist and was created
 *   `updated`   an existing file was modified (its previous content is in the backup)
 *   `unchanged` the entry was already there, the file was not touched
 *   `malformed` the file was refused and left strictly untouched
 */
export async function applyBrowserMcp({ home, name = BROWSER_SERVER_NAME, entry = browserServerEntry() } = {}) {
  if (typeof home !== "string" || home === "") {
    throw new Error("applyBrowserMcp requires the home directory");
  }

  const configPath = mcpConfigPath(home);
  const backupPath = backupPathFor(configPath);

  let raw;
  let exists = true;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    exists = false;
  }

  let parsed = {};
  if (exists && raw.trim() !== "") {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        status: "malformed",
        configPath,
        backupPath,
        message: `${configPath} is not valid JSON (${error.message}), the file was left untouched`,
      };
    }
  }

  let merged;
  try {
    merged = mergeMcpServer(parsed, name, entry);
  } catch (error) {
    return {
      status: "malformed",
      configPath,
      backupPath,
      message: `${configPath} cannot hold an MCP server (${error.message}), the file was left untouched`,
    };
  }

  if (!merged.changed) {
    return { status: "unchanged", configPath, backupPath };
  }

  await mkdir(dirname(configPath), { recursive: true });

  // The file may hold provider keys: keep its permissions, and use 0600 for a
  // file we create ourselves.
  const mode = exists ? (await stat(configPath)).mode & 0o777 : 0o600;
  if (exists) {
    await backupOnce(backupPath, raw, mode);
  }
  await writeAtomic(configPath, `${JSON.stringify(merged.config, null, 2)}\n`, mode);

  return { status: exists ? "updated" : "created", configPath, backupPath };
}
