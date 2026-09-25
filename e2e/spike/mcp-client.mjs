/**
 * A minimal MCP client over stdio, Node builtins only.
 *
 * The Phase 0 verification needs the agent's own path: the MCP server the
 * entrypoint configures, driven through the stdio transport, so the raw tool
 * output is the evidence. This is the smallest thing that can speak it:
 * newline delimited JSON-RPC, one request at a time.
 *
 * It is deliberately not a general client: no resources, no prompts, no
 * server initiated requests.
 */

import { spawn } from "node:child_process";

/** The revision this client announces. The server answers with the one it uses. */
export const PROTOCOL_VERSION = "2025-06-18";

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Starts a stdio MCP server and returns a client bound to it.
 *
 * `logger` receives the server's stderr as whole lines, which is where
 * chrome-devtools-mcp reports what it attached to, and every tool line worth
 * keeping as evidence.
 */
export function connectMcp({ command, args = [], env = process.env, cwd, logger = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env, cwd });
  const pending = new Map();
  const notifications = [];
  const stderrLines = [];
  let nextId = 1;
  let buffer = "";
  let stderrBuffer = "";
  let closed = null;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line === "") {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        notifications.push({ kind: "unparsable", line });
        continue;
      }
      const waiter = message.id !== undefined ? pending.get(message.id) : undefined;
      if (waiter) {
        pending.delete(message.id);
        if (message.error) {
          waiter.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
        } else {
          waiter.resolve(message.result);
        }
      } else {
        notifications.push(message);
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk;
    let index = stderrBuffer.indexOf("\n");
    while (index !== -1) {
      const line = stderrBuffer.slice(0, index);
      stderrBuffer = stderrBuffer.slice(index + 1);
      index = stderrBuffer.indexOf("\n");
      stderrLines.push(line);
      logger(line);
    }
  });

  child.on("exit", (code, signal) => {
    closed = { code, signal };
    for (const { reject } of pending.values()) {
      reject(new Error(`the MCP server exited (code ${code}, signal ${signal ?? "none"})`));
    }
    pending.clear();
  });

  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          reject(new Error(`MCP request timed out after ${timeoutMs} ms: ${method}`));
        }
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };

  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };

  return {
    pid: child.pid,
    stderr: () => [...stderrLines],
    notifications: () => [...notifications],
    exited: () => closed,
    /** Full handshake. Returns the server's initialize result. */
    async initialize({ clientName = "zcloudium-phase0", clientVersion = "0.0.0" } = {}) {
      const result = await request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: clientName, version: clientVersion },
      });
      notify("notifications/initialized", {});
      return result;
    },
    listTools: () => request("tools/list", {}),
    callTool: (name, args = {}) => request("tools/call", { name, arguments: args }),
    raw: request,
    close: () => {
      child.stdin.end();
      const done = new Promise((resolve) => child.once("close", resolve));
      // A server that ignores end of input is killed rather than waited for.
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      timer.unref();
      return done.finally(() => clearTimeout(timer));
    },
  };
}
