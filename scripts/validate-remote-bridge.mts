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
process.exit(0);
