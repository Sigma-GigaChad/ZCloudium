/**
 * Drives the agent's browser MCP server inside the container, one tool call at a
 * time, and prints the raw answers.
 *
 * This is the Phase 0 observation harness. It reads the MCP entry the entrypoint
 * wrote into the container's configuration, runs exactly that command through
 * `docker exec -i`, and calls the tools the agent would call. What it prints is
 * what the agent sees, which is what the five observations have to be judged on.
 *
 *   node e2e/spike/agent.mjs --container <name> [--home /data] \
 *        [--steps '<json array>'] [--steps-file <path>] [--out <path>]
 *
 * A step is `{"tool": "navigate_page", "args": {"url": "..."}}`. Every step's
 * raw result is written to stdout and appended to `--out` as one JSON object per
 * line, so the evidence survives the run.
 *
 * `--list` prints the tools the server exposes and stops.
 */

import { execFile } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { connectMcp } from "./mcp-client.mjs";

const run = promisify(execFile);

function parseArgs(argv) {
  const out = { home: "/data", steps: [], outPath: null, list: false, docker: "docker" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    switch (key) {
      case "--container":
        out.container = value;
        index += 1;
        break;
      case "--home":
        out.home = value;
        index += 1;
        break;
      case "--steps":
        out.steps = JSON.parse(value);
        index += 1;
        break;
      case "--steps-file":
        out.stepsFile = value;
        index += 1;
        break;
      case "--out":
        out.outPath = value;
        index += 1;
        break;
      case "--list":
        out.list = true;
        break;
      default:
        throw new Error(`unknown argument: ${key}`);
    }
  }
  if (!out.container) {
    throw new Error("--container is required");
  }
  return out;
}

/** The MCP entry the entrypoint wrote, read from the container itself. */
async function readEntry(container, home) {
  const path = `${home}/.zcode/cli/config.json`;
  const { stdout } = await run("docker", ["exec", container, "cat", path]);
  const config = JSON.parse(stdout);
  const entry = config?.mcp?.servers?.["chrome-devtools"];
  if (!entry) {
    throw new Error(`${path} holds no chrome-devtools entry`);
  }
  return { path, entry, config };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { path, entry, config } = await readEntry(options.container, options.home);
  const steps = options.stepsFile ? JSON.parse(await readFile(options.stepsFile, "utf8")) : options.steps;

  process.stdout.write(
    `${JSON.stringify({ event: "entry", configPath: path, entry, otherServers: Object.keys(config?.mcp?.servers ?? {}) })}\n`,
  );

  const client = connectMcp({
    command: "docker",
    args: ["exec", "-i", options.container, entry.command, ...(entry.args ?? [])],
    logger: (line) => {
      if (line.trim() !== "") {
        process.stdout.write(`${JSON.stringify({ event: "mcp-stderr", line })}\n`);
      }
    },
  });

  const record = async (payload) => {
    const line = `${JSON.stringify(payload)}\n`;
    process.stdout.write(line);
    if (options.outPath) {
      await appendFile(options.outPath, line);
    }
  };

  try {
    const welcome = await client.initialize();
    await record({ event: "initialize", result: welcome });

    if (options.list) {
      await record({ event: "tools", result: await client.listTools() });
      return;
    }

    for (const [index, step] of steps.entries()) {
      const startedAt = new Date().toISOString();
      try {
        const result = await client.callTool(step.tool, step.args ?? {});
        await record({ event: "tool", index, tool: step.tool, args: step.args ?? {}, startedAt, result });
      } catch (error) {
        await record({ event: "tool-error", index, tool: step.tool, args: step.args ?? {}, startedAt, message: error.message });
      }
    }
  } finally {
    const stderr = client.stderr();
    await record({ event: "mcp-stderr-all", lines: stderr });
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`agent.mjs: ${error.stack ?? error.message}\n`);
  process.exit(1);
});
