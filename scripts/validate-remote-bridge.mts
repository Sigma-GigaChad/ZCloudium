/**
 * Round-trip validation of the review's P1 fix.
 *
 * The bug: ServiceCollection.exposeOnChannelServer wraps every registered value
 * in ProxyChannel.fromService, which dispatches by method name ON the object.
 * A raw {call, listen} IServerChannel adapter therefore died with
 * "Method not found" on the first browser RPC. The fix registers
 * ProxyChannel.toService proxies — this script proves the full path:
 *
 *   browser ChannelClient -> local ChannelServer (exposeOnChannelServer)
 *     -> toService proxy -> remote ChannelClient -> remote ChannelServer
 *
 * ...carries both a call and an event subscription end to end.
 */
import { Emitter, ChannelServer, ChannelClient, ProxyChannel, type VSBuffer } from "@zcode/rpc";
import { ServiceCollection } from "@zcode/services";

/** Two IMessagePassingProtocol ends wired through memory. */
function protocolPair() {
  const deliveredToA = new Emitter<VSBuffer>();
  const deliveredToB = new Emitter<VSBuffer>();
  const a = {
    send: (buffer: VSBuffer) => deliveredToB.fire(buffer),
    onMessage: deliveredToA.event,
  };
  const b = {
    send: (buffer: VSBuffer) => deliveredToA.fire(buffer),
    onMessage: deliveredToB.event,
  };
  return [a, b] as const;
}

// --- the "remote host" hop -------------------------------------------------
const [remoteServerProto, remoteClientProto] = protocolPair();
// The server fires its Initialize ack in its constructor: the client must
// already be subscribed, so the client is built first.
const remoteClient = new ChannelClient(remoteClientProto as never);
const remoteServer = new ChannelServer(remoteServerProto as never, "remote");
remoteServer.registerChannel("echo", {
  call: async (_ctx: unknown, command: string, args: unknown) => ({
    command,
    args,
    pong: true,
  }),
  listen: (_ctx: unknown, _event: string) => {
    const emitter = new Emitter<unknown>();
    setTimeout(() => emitter.fire("remote-event-payload"), 20);
    return emitter.event;
  },
});

// --- what the patched /ws/remote/:id does ----------------------------------
const collection = new ServiceCollection();
collection.register(
  { channelName: "echo" },
  ProxyChannel.toService<Record<string, unknown>>(remoteClient.getChannel("echo")),
);

const [localServerProto, browserProto] = protocolPair();
const browserClient = new ChannelClient(browserProto as never);
const localServer = new ChannelServer(localServerProto as never, "local");
collection.exposeOnChannelServer(localServer);

// --- assertions ------------------------------------------------------------
const echo = browserClient.getChannel("echo");
const callResult = (await echo.call("ping", ["one", 2])) as unknown;
console.log("call round-trip:", JSON.stringify(callResult));
if (JSON.stringify(callResult) !== JSON.stringify({ command: "ping", args: ["one", 2], pong: true })) {
  console.error("FAIL: call did not round-trip");
  process.exit(1);
}

const eventPayload = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("event never arrived")), 2000);
  echo.listen("onEveryChange", undefined)((value) => {
    clearTimeout(timeout);
    resolve(value);
  });
});
console.log("listen round-trip:", eventPayload);
if (eventPayload !== "remote-event-payload") {
  console.error("FAIL: event did not round-trip");
  process.exit(1);
}

console.log("ROUND-TRIP OK: the toService registration survives exposeOnChannelServer");

// ---------------------------------------------------------------------------
// The credential preference contract: installGhCredentialsFromHost must read
// the container's own $HOME/.config/gh/hosts.yml first (what the gateway's
// /_auth/github page writes), fall back to the SSH host's file, and treat
// "neither" as a clean no-op. os.homedir() follows $HOME, so the test points
// it at a temp directory instead of the real home.
// ---------------------------------------------------------------------------
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { installGhCredentialsFromHost } from "./src/cloudEnvironments.js";

function fakeBackend(remoteFile: string) {
  const commands: string[] = [];
  return {
    commands,
    exec: (command: string) => {
      commands.push(command);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      stdin.resume();
      const onClose = (listener: (code: number) => void) => {
        const subscription = { dispose: () => {} };
        setImmediate(() => {
          // The remote cat reads the host's file; everything else succeeds.
          if (command.includes("cat ~/.config/gh/hosts.yml")) {
            stdout.end(remoteFile);
            stderr.end();
            listener(0);
          } else if (command.includes("command -v git")) {
            // Git absent in the environment: the helper install is optional.
            stderr.end("/bin/sh: git: not found");
            listener(1);
          } else {
            stdout.end();
            stderr.end();
            listener(0);
          }
        });
        return subscription;
      };
      return Promise.resolve({ stdin, stdout, stderr, onClose });
    },
    dispose: () => {},
  } as never;
}

const originalHome = process.env.HOME;
try {
  const home = await mkdtemp(join(tmpdir(), "zc-gh-home-"));
  process.env.HOME = home;

  // 1. Local file present: it wins, and the host's file is never read.
  await mkdir(join(home, ".config", "gh"), { recursive: true });
  await writeFile(join(home, ".config", "gh", "hosts.yml"), "github.com:\n    user: local\n");
  const local = fakeBackend("host-copy");
  const propagated = await installGhCredentialsFromHost(local, "ctr");
  if (!propagated || !local.commands.some((c) => c.includes("cat > ~/.config/gh/hosts.yml")) || local.commands.some((c) => c.includes("cat ~/.config/gh/hosts.yml"))) {
    console.error("FAIL: local hosts.yml not preferred (commands:", local.commands, ")");
    process.exit(1);
  }

  // 2. Local file absent: the host's file is read and propagated.
  await rm(join(home, ".config", "gh"), { recursive: true, force: true });
  const remote = fakeBackend("host-copy");
  const propagatedRemote = await installGhCredentialsFromHost(remote, "ctr");
  if (!propagatedRemote || !remote.commands.some((c) => c.includes("cat ~/.config/gh/hosts.yml")) || !remote.commands.some((c) => c.includes("cat > ~/.config/gh/hosts.yml"))) {
    console.error("FAIL: remote hosts.yml fallback broken (commands:", remote.commands, ")");
    process.exit(1);
  }

  // 3. Neither: a clean no-op, false, no write attempted.
  const none = fakeBackend("");
  const propagatedNone = await installGhCredentialsFromHost(none, "ctr");
  if (propagatedNone !== false || none.commands.some((c) => c.includes("cat > ~/.config/gh/hosts.yml"))) {
    console.error("FAIL: missing credentials must be a clean no-op (commands:", none.commands, ")");
    process.exit(1);
  }

  await rm(home, { recursive: true, force: true });
  console.log("CREDENTIAL PREFERENCE OK: local hosts.yml wins, host fallback works, absence is a no-op");
} finally {
  process.env.HOME = originalHome;
}
process.exit(0);
