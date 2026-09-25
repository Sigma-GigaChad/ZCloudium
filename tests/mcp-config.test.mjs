/**
 * Tests for the agent configuration merge (gateway/lib/mcp-config.mjs).
 *
 * The merge adds the baked browser MCP server to <home>/.zcode/cli/config.json.
 * It runs on every container start, in both profiles, on a file that may hold
 * the operator's provider keys: every test here is about not damaging it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_EXECUTABLE } from "../gateway/lib/browser.mjs";
import {
  BROWSER_MCP_ARGS,
  BROWSER_MCP_COMMAND,
  BROWSER_MCP_EXECUTABLE,
  BROWSER_MCP_PACKAGE,
  BROWSER_MCP_TIMEOUT_MS,
  BROWSER_MCP_VERSION,
  BROWSER_SERVER_NAME,
  applyBrowserMcp,
  backupPathFor,
  browserServerEntry,
  deepEqual,
  mcpConfigPath,
  mergeMcpServer,
} from "../gateway/lib/mcp-config.mjs";

const ENTRY = { type: "stdio", command: "/bin/true", args: ["--x"], enabled: true };

/** A realistic configuration file: provider keys, plugins, and another MCP server. */
const REALISTIC = {
  provider: { "builtin:zai": { kind: "anthropic", options: { apiKey: "redacted", baseURL: "https://api.z.ai" } } },
  model: "builtin:zai/glm-5",
  mcp: {
    servers: {
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
      "microsoft-todo": { type: "stdio", command: "uvx", args: ["microsoft-todo-mcp-server"], enabled: true, timeoutMs: 60000 },
    },
  },
  plugins: { enabledPlugins: { context7: true } },
};

async function withHome(content, run) {
  const root = await mkdtemp(join(tmpdir(), "zcloudium-mcp-"));
  const home = join(root, "home");
  const configPath = mcpConfigPath(home);
  await mkdir(join(home, ".zcode", "cli"), { recursive: true });
  if (content !== undefined) {
    await writeFile(configPath, content, { mode: 0o600 });
  }
  try {
    await run({ root, home, configPath, backupPath: backupPathFor(configPath) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the configuration lives in <home>/.zcode/cli/config.json", () => {
  assert.equal(mcpConfigPath("/data"), "/data/.zcode/cli/config.json");
  assert.equal(mcpConfigPath("/host/home/delta"), "/host/home/delta/.zcode/cli/config.json");
});

test("the baked browser MCP server is chrome-devtools-mcp, headless, on the image's Chromium", () => {
  assert.equal(BROWSER_SERVER_NAME, "chrome-devtools");
  assert.equal(BROWSER_MCP_PACKAGE, "chrome-devtools-mcp");
  assert.match(BROWSER_MCP_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(BROWSER_MCP_COMMAND, "/usr/local/bin/chrome-devtools-mcp");
  assert.equal(BROWSER_MCP_EXECUTABLE, "/usr/bin/chromium");

  const entry = browserServerEntry();
  assert.equal(entry.type, "stdio");
  assert.equal(entry.command, BROWSER_MCP_COMMAND);
  assert.equal(entry.enabled, true);
  assert.equal(entry.args.includes("--headless"), true, "--headless is required: the image has no display");
  assert.equal(entry.args.includes("--isolated"), true, "--isolated keeps the profile out of the operator home");
  const index = entry.args.indexOf("--executablePath");
  assert.equal(entry.args[index + 1], BROWSER_MCP_EXECUTABLE, "the server must use the Chromium installed in the image");
  assert.equal(JSON.stringify(entry).includes("--no-sandbox"), true, "the container has no sandbox: see SECURITY.md");
});

/**
 * Phase 0: the entry has two shapes. The attach shape points the server at the
 * browser the container already runs, the launch shape is today's behaviour and
 * the fallback. The decision between them lives in gateway/lib/browser.mjs
 * (resolveBrowserMode) and is tested there; here is what each shape is.
 */
test("the attach shape connects to the running browser instead of launching one", () => {
  const entry = browserServerEntry({ browserUrl: "http://127.0.0.1:9222" });
  assert.equal(entry.type, "stdio");
  assert.equal(entry.command, BROWSER_MCP_COMMAND);
  assert.equal(entry.enabled, true);
  assert.equal(entry.args.includes("--browserUrl"), true);
  assert.equal(entry.args[entry.args.indexOf("--browserUrl") + 1], "http://127.0.0.1:9222");
  // Attaching means the browser is not ours to launch: none of the launch
  // arguments may survive, or the server would start a second browser and the
  // agent would drive a page nobody is watching.
  assert.equal(entry.args.includes("--executablePath"), false, "attaching must not name a browser to launch");
  assert.equal(entry.args.includes("--isolated"), false, "attaching must not create a throwaway profile");
  assert.equal(entry.args.includes("--headless"), false, "the browser's mode is the launcher's decision, not the attacher's");
  assert.equal(JSON.stringify(entry).includes("--no-sandbox"), false, "no browser is launched, so there is nothing to pass it to");
  assert.equal(entry.args.includes("--no-usage-statistics"), true, "no telemetry in either shape");
  assert.equal(entry.args.includes("--no-performance-crux"), true, "no telemetry in either shape");
});

test("without a browser url the entry is exactly the one the image shipped before", () => {
  for (const empty of [undefined, null, "", "   "]) {
    assert.deepEqual(browserServerEntry({ browserUrl: empty }), browserServerEntry(), `browserUrl=${JSON.stringify(empty)}`);
  }
  assert.deepEqual(browserServerEntry(), {
    type: "stdio",
    command: BROWSER_MCP_COMMAND,
    args: [...BROWSER_MCP_ARGS],
    enabled: true,
    timeoutMs: BROWSER_MCP_TIMEOUT_MS,
  });
});

test("switching between the shapes rewrites the entry rather than leaving a stale one", async () => {
  await withHome(undefined, async ({ home, configPath }) => {
    const attach = browserServerEntry({ browserUrl: "http://127.0.0.1:9222" });
    await applyBrowserMcp({ home, entry: attach });
    assert.deepEqual((await readJson(configPath)).mcp.servers[BROWSER_SERVER_NAME], attach);

    // The next start, with the panel off: the entry must go back to launching.
    const result = await applyBrowserMcp({ home });
    assert.equal(result.status, "updated");
    assert.deepEqual((await readJson(configPath)).mcp.servers[BROWSER_SERVER_NAME], browserServerEntry());
  });
});

test("one executable, named once: the panel and the MCP launch the same Chromium", () => {
  // Two constants for one path is how an image ends up with an agent driving a
  // browser that is not the one the operator attached to.
  assert.equal(BROWSER_MCP_EXECUTABLE, BROWSER_EXECUTABLE);
});

test("mergeMcpServer adds the entry without mutating its input", () => {
  const input = structuredClone(REALISTIC);
  const { config, changed } = mergeMcpServer(input, "browser", ENTRY);
  assert.equal(changed, true);
  assert.deepEqual(config.mcp.servers.browser, ENTRY);
  assert.equal(input.mcp.servers.browser, undefined, "the input object must not be mutated");
});

test("mergeMcpServer preserves every existing key and every existing server", () => {
  const { config } = mergeMcpServer(REALISTIC, "browser", ENTRY);
  assert.deepEqual(config.provider, REALISTIC.provider);
  assert.equal(config.model, REALISTIC.model);
  assert.deepEqual(config.plugins, REALISTIC.plugins);
  assert.deepEqual(config.mcp.servers.context7, REALISTIC.mcp.servers.context7);
  assert.deepEqual(config.mcp.servers["microsoft-todo"], REALISTIC.mcp.servers["microsoft-todo"]);
});

test("mergeMcpServer creates the mcp.servers containers when they are missing", () => {
  const { config, changed } = mergeMcpServer({}, "browser", ENTRY);
  assert.equal(changed, true);
  assert.deepEqual(config, { mcp: { servers: { browser: ENTRY } } });

  const withoutServers = mergeMcpServer({ mcp: {} }, "browser", ENTRY);
  assert.deepEqual(withoutServers.config.mcp.servers.browser, ENTRY);

  const withoutMcp = mergeMcpServer({ model: "x" }, "browser", ENTRY);
  assert.equal(withoutMcp.config.model, "x");
  assert.deepEqual(withoutMcp.config.mcp.servers.browser, ENTRY);
});

test("mergeMcpServer is idempotent", () => {
  const first = mergeMcpServer(REALISTIC, "browser", ENTRY);
  const second = mergeMcpServer(first.config, "browser", ENTRY);
  assert.equal(second.changed, false, "applying the same entry twice must change nothing");
  assert.equal(JSON.stringify(second.config), JSON.stringify(first.config));
});

test("an entry that is identical but written in another key order is still identical", () => {
  const reordered = { enabled: true, args: ["--x"], command: "/bin/true", type: "stdio" };
  const config = { mcp: { servers: { browser: reordered } } };
  const { changed } = mergeMcpServer(config, "browser", ENTRY);
  assert.equal(changed, false);
});

test("mergeMcpServer replaces an entry that differs", () => {
  const config = { mcp: { servers: { browser: { type: "stdio", command: "/old", args: [], enabled: true } } } };
  const { config: merged, changed } = mergeMcpServer(config, "browser", ENTRY);
  assert.equal(changed, true);
  assert.deepEqual(merged.mcp.servers.browser, ENTRY);
});

test("mergeMcpServer refuses to guess when the structure is not the one it knows", () => {
  for (const broken of [
    null,
    undefined,
    [],
    "config",
    42,
    { mcp: [] },
    { mcp: "servers" },
    { mcp: { servers: [] } },
    { mcp: { servers: "x" } },
  ]) {
    assert.throws(
      () => mergeMcpServer(broken, "browser", ENTRY),
      (error) => error instanceof TypeError,
      `expected a TypeError for ${JSON.stringify(broken)}`,
    );
  }
});

test("deepEqual is structural and order insensitive", () => {
  assert.equal(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), true);
  assert.equal(deepEqual([1, { a: 2 }], [1, { a: 2 }]), true);
  assert.equal(deepEqual({ a: 1 }, { a: 2 }), false);
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(deepEqual([1, 2], [2, 1]), false);
  assert.equal(deepEqual(null, {}), false);
});

test("an absent file is created with the entry, and no empty backup is left behind", async () => {
  await withHome(undefined, async ({ configPath, home, backupPath }) => {
    const result = await applyBrowserMcp({ home });
    assert.equal(result.status, "created");
    assert.equal(result.configPath, configPath);
    const config = await readJson(configPath);
    assert.deepEqual(config.mcp.servers[BROWSER_SERVER_NAME], browserServerEntry());
    assert.deepEqual(await readdir(join(home, ".zcode", "cli")), ["config.json"], "no temporary or backup file must remain");
    await assert.rejects(stat(backupPath), "there was nothing to back up");
  });
});

test("an empty file is treated as a fresh configuration and backed up", async () => {
  await withHome("", async ({ configPath, home, backupPath }) => {
    const result = await applyBrowserMcp({ home });
    assert.equal(result.status, "updated");
    assert.deepEqual((await readJson(configPath)).mcp.servers[BROWSER_SERVER_NAME], browserServerEntry());
    assert.equal(await readFile(backupPath, "utf8"), "", "the previous content must be kept, even when empty");
  });
});

test("a configuration that already holds other servers keeps all of them", async () => {
  await withHome(JSON.stringify(REALISTIC, null, 2), async ({ home, backupPath }) => {
    const result = await applyBrowserMcp({ home });
    assert.equal(result.status, "updated");
    assert.equal(result.backupPath, backupPath);

    const config = await readJson(result.configPath);
    assert.deepEqual(config.mcp.servers.context7, REALISTIC.mcp.servers.context7);
    assert.deepEqual(config.mcp.servers["microsoft-todo"], REALISTIC.mcp.servers["microsoft-todo"]);
    assert.deepEqual(config.provider, REALISTIC.provider);
    assert.equal(config.model, REALISTIC.model);
    assert.deepEqual(config.plugins, REALISTIC.plugins);
    assert.deepEqual(config.mcp.servers[BROWSER_SERVER_NAME], browserServerEntry());

    const backup = await readJson(backupPath);
    assert.deepEqual(backup, REALISTIC, "the backup must be the file as it was before the merge");
  });
});

test("an already correct entry leaves the file untouched", async () => {
  const already = { ...REALISTIC, mcp: { servers: { ...REALISTIC.mcp.servers, [BROWSER_SERVER_NAME]: browserServerEntry() } } };
  await withHome(`${JSON.stringify(already, null, 2)}\n`, async ({ configPath, home, backupPath }) => {
    const before = await stat(configPath);
    await sleep(20);
    const result = await applyBrowserMcp({ home });
    const after = await stat(configPath);

    assert.equal(result.status, "unchanged");
    assert.equal(after.mtimeMs, before.mtimeMs, "the file must not be rewritten");
    assert.equal(await readFile(configPath, "utf8"), `${JSON.stringify(already, null, 2)}\n`, "the file must be byte for byte identical");
    await assert.rejects(stat(backupPath), "an unchanged file must not be backed up");
  });
});

test("running the merge twice is a no-op the second time, with a single backup", async () => {
  await withHome(JSON.stringify(REALISTIC, null, 2), async ({ configPath, home, backupPath }) => {
    const first = await applyBrowserMcp({ home });
    const afterFirst = await readFile(configPath, "utf8");
    const before = await stat(configPath);
    await sleep(20);

    const second = await applyBrowserMcp({ home });
    const afterSecond = await readFile(configPath, "utf8");
    const after = await stat(configPath);

    assert.equal(first.status, "updated");
    assert.equal(second.status, "unchanged");
    assert.equal(afterSecond, afterFirst);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(await readFile(backupPath, "utf8"), JSON.stringify(REALISTIC, null, 2), "the backup keeps the pristine version");
  });
});

test("a malformed file is left strictly untouched", async () => {
  const broken = '{"mcp": {"servers": {"context7": ';
  await withHome(broken, async ({ configPath, home, backupPath }) => {
    const before = await stat(configPath);
    await sleep(20);
    const result = await applyBrowserMcp({ home });
    const after = await stat(configPath);

    assert.equal(result.status, "malformed");
    assert.equal(await readFile(configPath, "utf8"), broken, "the operator file must not be repaired in place");
    assert.equal(after.mtimeMs, before.mtimeMs, "the file must not be rewritten");
    await assert.rejects(stat(backupPath), "no backup must be created for a refused merge");
  });
});

test("a file whose mcp section has the wrong shape is refused, not clobbered", async () => {
  for (const content of ['{"mcp": []}', '{"mcp": {"servers": []}}', "[]", "null", "42"]) {
    await withHome(content, async ({ configPath, home, backupPath }) => {
      const result = await applyBrowserMcp({ home });
      assert.equal(result.status, "malformed", content);
      assert.equal(await readFile(configPath, "utf8"), content, `${content} must be preserved`);
      await assert.rejects(stat(backupPath));
    });
  }
});

test("the merge never writes a file readable by others, and keeps an existing mode", async () => {
  await withHome(undefined, async ({ configPath, home }) => {
    await applyBrowserMcp({ home });
    assert.equal((await stat(configPath)).mode & 0o777, 0o600, "a new configuration holds provider keys");
  });

  await withHome(JSON.stringify(REALISTIC), async ({ configPath, home }) => {
    await chmod(configPath, 0o640);
    await applyBrowserMcp({ home });
    assert.equal((await stat(configPath)).mode & 0o777, 0o640, "an existing mode must be preserved");
  });
});

test("the merge creates the intermediate directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcloudium-mcp-"));
  try {
    const home = join(root, "fresh-home");
    const result = await applyBrowserMcp({ home });
    assert.equal(result.status, "created");
    assert.deepEqual((await readJson(result.configPath)).mcp.servers[BROWSER_SERVER_NAME], browserServerEntry());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
