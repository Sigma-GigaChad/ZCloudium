import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The block duration is read from the gateway rather than copied here: a copy
// would keep the old value and the timing tests below would then measure a
// number the product no longer uses.
import { BLOCK_MS, createGateway, MAX_FAILURES, safeNext } from "../gateway/lib/server.mjs";
import { totp } from "../gateway/lib/totp.mjs";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const USERNAME = "operator";
const PASSWORD = "correct-horse-battery-staple";
/**
 * The bound the documentation advertises for one block, and therefore a contract.
 *
 * Deliberately a literal, and not the imported value: the timing tests below
 * measure BLOCK_MS, the duration the gateway applies, while this copy is the
 * number README.md and SECURITY.md promise, and the pin test compares the two.
 * A change to the duration that is not also made to the documents fails there.
 */
const ADVERTISED_BLOCK_MS = 5 * 60 * 1000;

/** Stub of the ZCode server: plain HTTP plus a WebSocket upgrade. */
async function startUpstream() {
  const sockets = new Set();
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`UPSTREAM ${req.url}`);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1")
      .update(String(req.headers["sec-websocket-key"]) + WS_GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    // An upgraded socket never ends on its own, and server.close() waits for every
    // connection to drain, so the suite would hang forever without this.
    destroy: () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
    },
  };
}

async function withGateway(run, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "zcloudium-gateway-"));
  const upstream = await startUpstream();
  // Time is injected so the suite can cross a TOTP step instead of sleeping 30s.
  let clock = Date.now();
  const now = () => clock;
  const advance = (ms) => {
    clock += ms;
  };
  const gateway = await createGateway({
    upstreamUrl: upstream.url,
    dataDir,
    logger: () => {},
    now,
    ...options,
  });
  try {
    await run({
      base: `http://127.0.0.1:${gateway.port}`,
      port: gateway.port,
      dataDir,
      now,
      advance,
    });
  } finally {
    await gateway.close();
    upstream.destroy();
    await new Promise((resolve) => upstream.server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
}

function post(base, path, fields, cookie, headers = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

function cookieFrom(response, name) {
  const all = response.headers.getSetCookie();
  const match = all.map((entry) => entry.split(";")[0]).find((entry) => entry.startsWith(`${name}=`));
  return match ?? null;
}

/** Runs the first-connection wizard and returns the session, the secret and the code used. */
async function completeSetup(base, now = Date.now) {
  const step1 = await post(base, "/_auth/setup", {
    username: USERNAME,
    password: PASSWORD,
    password2: PASSWORD,
  });
  assert.equal(step1.status, 303, "setup step 1 should redirect");
  assert.equal(step1.headers.get("location"), "/_auth/setup/totp");
  const setupCookie = cookieFrom(step1, "zc_setup");
  assert.ok(setupCookie, "setup should issue a pending cookie");

  const enroll = await fetch(`${base}/_auth/setup/totp`, {
    headers: { cookie: setupCookie },
    redirect: "manual",
  });
  assert.equal(enroll.status, 200);
  const html = await enroll.text();
  const secret = html.match(/id="otp-secret"[^>]*>\s*([A-Z2-7\s]+?)\s*</)?.[1]?.replace(/\s+/g, "");
  assert.ok(secret && secret.length >= 16, "the enrolment page must display the secret");

  const code = totp(secret, { at: now() });
  const step2 = await post(base, "/_auth/setup/totp", { code }, setupCookie);
  assert.equal(step2.status, 303, "confirming the code should redirect");
  const session = cookieFrom(step2, "zc_sess");
  assert.ok(session, "a confirmed enrolment must issue a session");
  return { session, secret, code };
}

/** Password step of an existing account, returns the pending login cookie. */
async function submitPassword(base, password = PASSWORD) {
  const response = await post(base, "/_auth/login", { username: USERNAME, password });
  return response;
}

test("health answers without any session", () =>
  withGateway(async ({ base }) => {
    const response = await fetch(`${base}/_auth/health`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /ok/i);
  }));

test("an unauthenticated request is redirected to the login page", () =>
  withGateway(async ({ base }) => {
    const response = await fetch(`${base}/`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/_auth/login?next=%2F");
  }));

test("the upstream is not reachable without a session", () =>
  withGateway(async ({ base }) => {
    for (const path of ["/", "/api/server-info", "/assets/index.js"]) {
      const response = await fetch(`${base}${path}`, { redirect: "manual" });
      assert.equal(response.status, 302, `${path} must not be proxied`);
    }
  }));

test("with no account yet, the login page leads to the setup wizard", () =>
  withGateway(async ({ base }) => {
    const response = await fetch(`${base}/_auth/login`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/_auth/setup");
  }));

test("the login page renders a password form once an account exists", () =>
  withGateway(async ({ base }) => {
    await completeSetup(base);
    const response = await fetch(`${base}/_auth/login`, { redirect: "manual" });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<form/i);
    assert.match(html, /name="password"/);
  }));

test("the setup wizard creates the account, enrols TOTP and logs in", () =>
  withGateway(async ({ base, dataDir }) => {
    const { session } = await completeSetup(base);

    const users = JSON.parse(await readFile(join(dataDir, "auth", "users.json"), "utf8"));
    assert.equal(users.users[USERNAME].totpSecret.length >= 16, true);
    assert.equal(JSON.stringify(users).includes(PASSWORD), false, "the password must not be stored in clear");

    const page = await fetch(`${base}/`, { headers: { cookie: session }, redirect: "manual" });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /^UPSTREAM \//);
  }));

test("the proxied session reaches the API and the assets", () =>
  withGateway(async ({ base }) => {
    const { session } = await completeSetup(base);
    const api = await fetch(`${base}/api/server-info`, { headers: { cookie: session } });
    assert.equal(api.status, 200);
    assert.match(await api.text(), /^UPSTREAM \/api\/server-info$/);
  }));

test("setup refuses a weak password and a mismatched confirmation", () =>
  withGateway(async ({ base }) => {
    for (const fields of [
      { username: USERNAME, password: "short", password2: "short" },
      { username: USERNAME, password: "long-enough-password", password2: "different-password" },
      { username: "", password: "long-enough-password", password2: "long-enough-password" },
    ]) {
      const response = await post(base, "/_auth/setup", fields);
      assert.equal(response.status, 400, JSON.stringify(fields));
    }
  }));

test("setup refuses to run twice", () =>
  withGateway(async ({ base }) => {
    await completeSetup(base);
    const response = await post(base, "/_auth/setup", {
      username: "intruder",
      password: "another-long-password",
      password2: "another-long-password",
    });
    assert.equal(response.status, 409);
  }));

test("a wrong TOTP code at enrolment does not create the account", () =>
  withGateway(async ({ base, dataDir }) => {
    const step1 = await post(base, "/_auth/setup", {
      username: USERNAME,
      password: PASSWORD,
      password2: PASSWORD,
    });
    const setupCookie = cookieFrom(step1, "zc_setup");
    const response = await post(base, "/_auth/setup/totp", { code: "000000" }, setupCookie);
    assert.equal(response.status, 400);
    await assert.rejects(readFile(join(dataDir, "auth", "users.json"), "utf8"));
  }));

test("a wrong password is rejected and issues no session", () =>
  withGateway(async ({ base }) => {
    await completeSetup(base);
    const response = await submitPassword(base, "not-the-password");
    assert.equal(response.status, 401);
    assert.equal(cookieFrom(response, "zc_sess"), null);
  }));

test("an unknown user is rejected like a wrong password", () =>
  withGateway(async ({ base }) => {
    await completeSetup(base);
    const response = await post(base, "/_auth/login", { username: "nobody", password: PASSWORD });
    assert.equal(response.status, 401);
  }));

test("a correct password leads to the TOTP step, not straight to a session", () =>
  withGateway(async ({ base }) => {
    await completeSetup(base);
    const response = await submitPassword(base);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/_auth/verify");
    assert.equal(cookieFrom(response, "zc_sess"), null, "the password alone must not open a session");
    assert.ok(cookieFrom(response, "zc_login"));
  }));

test("password then TOTP yields a session that reaches the upstream", () =>
  withGateway(async ({ base, now, advance }) => {
    const { secret } = await completeSetup(base, now);
    const step1 = await submitPassword(base);
    const loginCookie = cookieFrom(step1, "zc_login");
    // The enrolment step is spent, so signing in needs the next step: this is the
    // replay guard doing its job, and exactly what a user sees after enrolling.
    advance(30_000);
    const step2 = await post(base, "/_auth/verify", { code: totp(secret, { at: now() }) }, loginCookie);
    assert.equal(step2.status, 303);
    const session = cookieFrom(step2, "zc_sess");
    assert.ok(session);

    const page = await fetch(`${base}/`, { headers: { cookie: session } });
    assert.equal(page.status, 200);
  }));

test("a wrong TOTP code at login is rejected", () =>
  withGateway(async ({ base }) => {
    await completeSetup(base);
    const loginCookie = cookieFrom(await submitPassword(base), "zc_login");
    const response = await post(base, "/_auth/verify", { code: "000000" }, loginCookie);
    assert.equal(response.status, 401);
    assert.equal(cookieFrom(response, "zc_sess"), null);
  }));

test("the TOTP step cannot be reached without the password step", () =>
  withGateway(async ({ base }) => {
    await completeSetup(base);
    const response = await post(base, "/_auth/verify", { code: "123456" });
    assert.equal(response.status, 401);
  }));

test("the code used at enrolment cannot be replayed to sign in", () =>
  withGateway(async ({ base, now }) => {
    const { code } = await completeSetup(base, now);
    const loginCookie = cookieFrom(await submitPassword(base), "zc_login");
    const response = await post(base, "/_auth/verify", { code }, loginCookie);
    assert.equal(response.status, 401);
    assert.equal(cookieFrom(response, "zc_sess"), null);
  }));

test("a tampered session cookie is rejected", () =>
  withGateway(async ({ base }) => {
    const { session } = await completeSetup(base);
    const value = session.split("=")[1];
    const forged = `${Buffer.from(JSON.stringify({ user: USERNAME, exp: Date.now() + 1000 })).toString("base64url")}.${value.split(".").pop()}`;
    const response = await fetch(`${base}/`, { headers: { cookie: `zc_sess=${forged}` }, redirect: "manual" });
    assert.equal(response.status, 302);
  }));

test("an expired session cookie is rejected", () =>
  withGateway(async ({ base }) => {
    const { session } = await completeSetup(base);
    const body = JSON.parse(Buffer.from(session.split("=")[1].split(".")[0], "base64url").toString());
    assert.ok(body.exp > Date.now());
    const expired = Buffer.from(JSON.stringify({ ...body, exp: Date.now() - 1000 })).toString("base64url");
    const response = await fetch(`${base}/`, {
      headers: { cookie: `zc_sess=${expired}.${session.split("=")[1].split(".").pop()}` },
      redirect: "manual",
    });
    assert.equal(response.status, 302);
  }));

test("logout clears the session", () =>
  withGateway(async ({ base }) => {
    const { session } = await completeSetup(base);
    const response = await post(base, "/_auth/logout", {}, session);
    assert.equal(response.status, 303);
    const cleared = response.headers
      .getSetCookie()
      .find((entry) => entry.startsWith("zc_sess="));
    assert.ok(cleared, "logout must send a clearing cookie");
    assert.match(cleared, /Max-Age=0/);
  }));

test("the requested path survives the login round trip", () =>
  withGateway(async ({ base }) => {
    const response = await fetch(`${base}/settings?tab=model`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/_auth/login?next=%2Fsettings%3Ftab%3Dmodel");
  }));

/** Performs the raw WebSocket handshake and returns the status line. */
function wsStatusLine(port, path, cookie, { host, origin } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      const key = randomBytes(16).toString("base64");
      const request = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host ?? `127.0.0.1:${port}`}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        ...(origin === undefined ? [] : [`Origin: ${origin}`]),
        ...(cookie ? [`Cookie: ${cookie}`] : []),
        "",
        "",
      ].join("\r\n");
      socket.write(request);
    });
    let received = "";
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
      if (received.includes("\r\n")) finish(received.split("\r\n")[0]);
    });
    socket.on("error", reject);
    setTimeout(() => finish(received.split("\r\n")[0] || "TIMEOUT"), 3000).unref();
  });
}

test("a WebSocket upgrade is proxied once authenticated", () =>
  withGateway(async ({ base, port }) => {
    const { session } = await completeSetup(base);
    const status = await wsStatusLine(port, "/ws", session);
    assert.match(status, /101/, `expected a 101, got "${status}"`);
  }));

test("a WebSocket upgrade without a session is refused", () =>
  withGateway(async ({ base, port }) => {
    await completeSetup(base);
    const status = await wsStatusLine(port, "/ws", null);
    assert.equal(/101/.test(status), false, `expected no upgrade, got "${status}"`);
  }));

/**
 * The failure block is a rate limit, so what it is keyed on is part of its
 * contract: a client that can choose its own key has no rate limit at all.
 */
async function failPasswordTimes(base, times, addressOf) {
  const statuses = [];
  for (let attempt = 0; attempt < times; attempt += 1) {
    const headers = addressOf ? { "x-forwarded-for": addressOf(attempt) } : {};
    const response = await post(base, "/_auth/login", { username: USERNAME, password: "wrong-password" }, null, headers);
    statuses.push(response.status);
  }
  return statuses;
}

test("a varied x-forwarded-for header does not evade the failure block", () =>
  withGateway(async ({ base }) => {
    await completeSetup(base);

    // Every attempt claims a different source address. The socket is the same,
    // so the same budget must be spent.
    const rejects = await failPasswordTimes(base, MAX_FAILURES, (attempt) => `10.0.0.${attempt}`);
    assert.deepEqual(rejects, Array(MAX_FAILURES).fill(401));

    const blocked = await post(
      base,
      "/_auth/login",
      { username: USERNAME, password: PASSWORD },
      null,
      { "x-forwarded-for": "10.0.0.250" },
    );
    assert.equal(blocked.status, 429, "the block must be keyed on the socket address, not on a header the client controls");
    assert.equal(cookieFrom(blocked, "zc_sess"), null);
  }));

test("repeated wrong codes are refused with 429 instead of being tried forever", () =>
  withGateway(async ({ base, now, advance }) => {
    const { secret } = await completeSetup(base, now);
    const loginCookie = cookieFrom(await submitPassword(base), "zc_login");

    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      const response = await post(base, "/_auth/verify", { code: "000000" }, loginCookie);
      assert.equal(response.status, 401, `wrong code ${attempt + 1} must still be answered as a rejection`);
    }

    // The address is blocked now, so even the right code is refused: that is
    // what makes a six digit second factor impossible to walk through.
    advance(30_000);
    const blocked = await post(base, "/_auth/verify", { code: totp(secret, { at: now() }) }, loginCookie);
    assert.equal(blocked.status, 429);
    assert.equal(cookieFrom(blocked, "zc_sess"), null);
  }));

/**
 * The duration of the block is a number the documentation quotes, so it is a
 * contract and not an implementation detail. The timing below is deterministic:
 * the clock is injected, so no test waits five real minutes for it.
 */
test("the block lifts exactly after the configured duration, and not before", () =>
  withGateway(async ({ base, advance }) => {
    await completeSetup(base);
    const spent = await failPasswordTimes(base, MAX_FAILURES);
    assert.deepEqual(spent, Array(MAX_FAILURES).fill(401));

    // One millisecond short of the configured duration: still blocked, and the
    // correct password is refused rather than honoured.
    advance(BLOCK_MS - 1);
    const justBefore = await post(base, "/_auth/login", { username: USERNAME, password: PASSWORD });
    assert.equal(justBefore.status, 429, "the block must still hold one millisecond before the duration");

    // One millisecond later the block is over, at the boundary itself.
    advance(1);
    const justAfter = await post(base, "/_auth/login", { username: USERNAME, password: PASSWORD });
    assert.equal(justAfter.status, 303, "the block must lift at the duration it advertises");
  }));

test("the gateway applies the block duration the documentation advertises", () => {
  // README.md and SECURITY.md both quote five minutes for one block. This pins the
  // constant itself, so changing the duration without changing what is advertised
  // fails here, and the timing test above keeps measuring the real value.
  assert.equal(BLOCK_MS, ADVERTISED_BLOCK_MS, "the advertised block duration and the applied one must agree");
});

/**
 * The block is documented as bounded, so the budget behind it has to expire with
 * it. A counter that is never reset leaves the key at the threshold forever, and
 * one failure every block period then keeps every client, the operator included,
 * locked out of the sign in page for good.
 */
test("a failure after the block expires starts a fresh budget instead of re-blocking", () =>
  withGateway(async ({ base, advance }) => {
    await completeSetup(base);

    const spent = await failPasswordTimes(base, MAX_FAILURES);
    assert.deepEqual(spent, Array(MAX_FAILURES).fill(401));

    // The block still fires at the threshold: the correct password is refused.
    const blocked = await post(base, "/_auth/login", { username: USERNAME, password: PASSWORD });
    assert.equal(blocked.status, 429);

    advance(BLOCK_MS + 1000);

    // The budget behind the block expires with it, and the observable is the
    // sequence, not the first answer. A counter that is still at the threshold
    // re-blocks on the first failure after the expiry, and that request is
    // answered 401 with the same page either way, because the block is consulted
    // when a request enters and not when a failure is recorded: asserting one
    // 401 here would hold under the unfixed code and prove nothing. What the
    // reset means is that the seven failures after it are all rejections, so
    // that is what this asserts.
    const freshBudget = await failPasswordTimes(base, MAX_FAILURES - 1);
    assert.deepEqual(
      freshBudget,
      Array(MAX_FAILURES - 1).fill(401),
      "the failures after the block expires must spend a fresh budget, not re-block on the first one",
    );

    const correct = await post(base, "/_auth/login", { username: USERNAME, password: PASSWORD });
    assert.equal(correct.status, 303, "the operator must be able to sign in again once the block expires");
  }));

test("the enrolment step is throttled like the sign in code step", () =>
  withGateway(async ({ base, dataDir }) => {
    const step1 = await post(base, "/_auth/setup", { username: USERNAME, password: PASSWORD, password2: PASSWORD });
    const setupCookie = cookieFrom(step1, "zc_setup");
    const enroll = await fetch(`${base}/_auth/setup/totp`, { headers: { cookie: setupCookie } });
    const secret = (await enroll.text()).match(/id="otp-secret"[^>]*>\s*([A-Z2-7\s]+?)\s*</)?.[1]?.replace(/\s+/g, "");
    assert.ok(secret, "the enrolment page must display the secret");

    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      const response = await post(base, "/_auth/setup/totp", { code: "000000" }, setupCookie);
      assert.equal(response.status, 400, `wrong enrolment code ${attempt + 1}`);
    }

    const blocked = await post(base, "/_auth/setup/totp", { code: totp(secret) }, setupCookie);
    assert.equal(blocked.status, 429);
    await assert.rejects(
      readFile(join(dataDir, "auth", "users.json"), "utf8"),
      "the throttle must keep the account from being created",
    );
  }));

test("trustProxy keys the block on the forwarded address, which is the documented opt in", () =>
  withGateway(
    async ({ base }) => {
      await completeSetup(base);
      await failPasswordTimes(base, MAX_FAILURES, () => "10.0.0.1");

      const otherClient = await post(
        base,
        "/_auth/login",
        { username: USERNAME, password: "wrong-password" },
        null,
        { "x-forwarded-for": "10.0.0.2" },
      );
      assert.equal(otherClient.status, 401, "a second forwarded address keeps its own budget once the header is trusted");

      const blocked = await post(
        base,
        "/_auth/login",
        { username: USERNAME, password: "wrong-password" },
        null,
        { "x-forwarded-for": "10.0.0.1" },
      );
      assert.equal(blocked.status, 429, "the exhausted forwarded address stays blocked");
    },
    { trustProxy: true },
  ));

test("safeNext refuses anything a browser would resolve outside this origin", () => {
  const refused = [
    "",
    "   ",
    "relative/path",
    "//evil.com",
    "/\\evil.com",
    "/\\/evil.com",
    "/\\\\evil.com",
    "\\\\evil.com",
    "/%5Cevil.com",
    "/%5cevil.com",
    "/a%5Cb",
    "/%2F%2Fevil.com",
    // Dot segment normalisation turns these into `//evil.com` while the origin
    // stays the fixed one, so only the resolved path can reveal them.
    "/..//evil.com",
    "/..//evil.com?x=1",
    "/.//evil.com",
    "/%2e%2e//evil.com",
    "/a/..//evil.com",
    "/a/b/../../..//evil.com",
    "/..././..//evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "/\r\nLocation: http://evil.com",
    "http://evil.com",
    "https://evil.com",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    null,
    undefined,
    42,
    {},
  ];
  for (const value of refused) {
    assert.equal(safeNext(value), "/", `${JSON.stringify(value)} must not be honoured`);
  }
});

test("safeNext keeps a same origin path, with its query and its fragment", () => {
  assert.equal(safeNext("/"), "/");
  assert.equal(safeNext("/settings"), "/settings");
  assert.equal(safeNext("/settings?tab=model"), "/settings?tab=model");
  assert.equal(safeNext("/settings?tab=model#anchor"), "/settings?tab=model#anchor");
  assert.equal(safeNext("/a/b/c"), "/a/b/c");
});

test("a backslash in next cannot turn a successful sign in into an open redirect", () =>
  withGateway(async ({ base, now, advance }) => {
    const { secret } = await completeSetup(base, now);

    for (const next of ["/\\evil.com", "/%5Cevil.com", "//evil.com", "/\\/evil.com", "/\\\\evil.com"]) {
      advance(30_000);
      const step1 = await post(base, "/_auth/login", { username: USERNAME, password: PASSWORD, next });
      assert.equal(step1.status, 303, `next=${next}`);
      const loginCookie = cookieFrom(step1, "zc_login");

      const step2 = await post(base, "/_auth/verify", { code: totp(secret, { at: now() }) }, loginCookie);
      assert.equal(step2.status, 303, `next=${next}`);
      assert.equal(step2.headers.get("location"), "/", `next=${next} must land on the root of this origin`);
    }
  }));

/**
 * Phase 0 of issue #5: the debug port behind the gateway.
 *
 * The panel hypothesis is that an authenticated operator can open Chromium's own
 * DevTools frontend against the agent's page, through the gateway, with no panel
 * code. These tests cover the gateway's half of that: the route, the refusal
 * without a session, the path mapping, and the discovery documents that would
 * otherwise send the frontend to 127.0.0.1.
 */

/** Stub of the browser debug port: discovery JSON, frontend assets, one upgrade. */
async function startDebugStub() {
  const requests = [];
  const sockets = new Set();
  let port = 0;
  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, host: req.headers.host, origin: req.headers.origin ?? null });
    const authority = `127.0.0.1:${port}`;
    if (req.url.startsWith("/json/version")) {
      const body = JSON.stringify({
        Browser: "Chrome/153.0.8010.52",
        webSocketDebuggerUrl: `ws://${authority}/devtools/browser/b1d98492`,
      });
      res.writeHead(200, { "content-type": "application/json; charset=UTF-8", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (req.url.startsWith("/json/list")) {
      const body = JSON.stringify([
        { id: "8B04", type: "page", url: "about:blank", webSocketDebuggerUrl: `ws://${authority}/devtools/page/8B04` },
      ]);
      res.writeHead(200, { "content-type": "application/json; charset=UTF-8", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (req.url.startsWith("/devtools/")) {
      const body = "<!DOCTYPE html><html><title>DevTools</title></html>";
      res.writeHead(200, { "content-type": "text/html", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("debug: not found");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket) => {
    requests.push({ method: "UPGRADE", path: req.url, host: req.headers.host, origin: req.headers.origin ?? null });
    if (req.url.includes("GONE")) {
      // What the real debug port does when the target is not there any more: a
      // plain HTTP answer instead of a handshake.
      const body = "no such target";
      socket.write(`HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\ncontent-length: ${body.length}\r\n\r\n${body}`);
      return;
    }
    const accept = createHash("sha1")
      .update(String(req.headers["sec-websocket-key"]) + WS_GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    authority: `127.0.0.1:${port}`,
    requests,
    destroy: () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
    },
  };
}

/** A gateway with a debug port behind it: the panel switch on. */
async function withPanelGateway(run, options = {}) {
  const debug = await startDebugStub();
  try {
    await withGateway((context) => run({ ...context, debug }), { debugUrl: debug.url, ...options });
  } finally {
    debug.destroy();
  }
}

test("with the panel off, /_browser is ordinary application traffic", () =>
  withGateway(async ({ base }) => {
    const anonymous = await fetch(`${base}/_browser/json/version`, { redirect: "manual" });
    assert.equal(anonymous.status, 302, "no session, so the login page, exactly like any other path");
    assert.match(String(anonymous.headers.get("location")), /^\/_auth\/login/);

    const { session } = await completeSetup(base);
    const proxied = await fetch(`${base}/_browser/json/version`, { headers: { cookie: session } });
    assert.equal(await proxied.text(), "UPSTREAM /_browser/json/version", "with the panel off it reaches the application, untouched");
  }));

test("an unauthenticated /_browser request is refused exactly like the rest of the gateway", () =>
  withPanelGateway(async ({ base }) => {
    for (const path of ["/_browser", "/_browser/", "/_browser/json/version", "/_browser/json/list", "/_browser/devtools/inspector.html"]) {
      const response = await fetch(`${base}${path}`, { redirect: "manual" });
      assert.equal(response.status, 302, `${path} must not be served without a session`);
      assert.equal(response.headers.get("location"), `/_auth/login?next=${encodeURIComponent(path)}`, path);
      const body = await response.text();
      assert.equal(/webSocketDebuggerUrl|DevTools/.test(body), false, `${path} must leak nothing before authentication`);
    }
  }));

test("the debug port is proxied behind the session, and the discovery JSON points back at the gateway", () =>
  withPanelGateway(async ({ base, port, debug }) => {
    const { session } = await completeSetup(base);
    const response = await fetch(`${base}/_browser/json/version`, { headers: { cookie: session } });
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get("content-type")), /application\/json/);

    const body = await response.json();
    assert.equal(body.Browser, "Chrome/153.0.8010.52", "the debug document must arrive intact");
    assert.equal(
      body.webSocketDebuggerUrl,
      `ws://127.0.0.1:${port}/_browser/devtools/browser/b1d98492`,
      "the frontend must be told to reach the gateway, not the loopback debug port",
    );
    assert.equal(JSON.stringify(body).includes(debug.authority), false, "the loopback authority must not survive the rewrite");
    assert.equal(response.headers.get("cache-control"), "no-store", "a rewritten document is per origin and must not be cached");

    const list = await fetch(`${base}/_browser/json/list`, { headers: { cookie: session } });
    const targets = await list.json();
    assert.equal(targets[0].webSocketDebuggerUrl, `ws://127.0.0.1:${port}/_browser/devtools/page/8B04`);
    assert.equal(targets[0].id, "8B04");
  }));

test("the debug port is asked with the loopback Host it insists on", () =>
  withPanelGateway(async ({ base, debug }) => {
    const { session } = await completeSetup(base);
    await fetch(`${base}/_browser/json/version`, { headers: { cookie: session } });
    const seen = debug.requests.at(-1);
    assert.equal(seen.path, "/json/version", "the proxy prefix must be stripped, the rest kept");
    assert.equal(seen.host, debug.authority, "Chromium answers 500 to any other Host, so the proxy must rewrite it");
  }));

test("the frontend assets and the query string cross the proxy untouched", () =>
  withPanelGateway(async ({ base, debug }) => {
    const { session } = await completeSetup(base);
    const response = await fetch(`${base}/_browser/devtools/inspector.html?ws=panel.example/_browser/devtools/page/8B04`, {
      headers: { cookie: session },
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /DevTools/);
    const seen = debug.requests.at(-1);
    assert.equal(seen.path, "/devtools/inspector.html?ws=panel.example/_browser/devtools/page/8B04");
  }));

/**
 * The panel itself, served by the gateway at the prefix root.
 *
 * This is the change Phase 1 makes to the route Phase 0 built: `/_browser/` used
 * to map to the debug port's root (a 404, nothing is invented for it) and is now
 * the operator panel. The debug port must not be reached for it, the page must
 * carry nothing secret, and the same Origin rule applies, because the panel is
 * the page that opens the control channel.
 */
test("the panel is served at the prefix root, with no session and no debug port involved", () =>
  withPanelGateway(async ({ base, port, debug }) => {
    for (const path of ["/_browser", "/_browser/"]) {
      const anonymous = await fetch(`${base}${path}`, { redirect: "manual" });
      assert.equal(anonymous.status, 302, `${path} must not be served without a session`);
      assert.equal(anonymous.headers.get("location"), `/_auth/login?next=${encodeURIComponent(path)}`, path);
    }
    assert.equal(debug.requests.length, 0, "the panel is the gateway's own page: nothing may reach the debug port for it");

    const { session } = await completeSetup(base);
    const response = await fetch(`${base}/_browser/`, { headers: { cookie: session } });
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get("content-type")), /text\/html/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.text();
    assert.match(body, /Page\.startScreencast/, "the live view is the screencast");
    assert.match(body, /Emulation\.setDeviceMetricsOverride/, "the viewport control is the emulation override");
    assert.match(body, /Shared with the agent/, "the indicator that the page is shared with the agent");
    // The button's URL is built at runtime from the same prefix, so what can be
    // asserted on the served page is the frontend path it points at.
    assert.match(body, /devtools\/inspector\.html/, "the DevTools button points at the proxied frontend");
    // The page holds no secret and no target id: it reads the target list from
    // the proxied discovery document, behind the session, when it opens.
    assert.equal(/webSocketDebuggerUrl|[0-9A-F]{32}/.test(body), false, "the panel must not carry a target id or a socket url");
    assert.equal(debug.requests.length, 0, "serving the panel must not touch the debug port");

    // The panel is a browser route, so the Origin rule applies to it too.
    const foreign = await rawGet(port, "/_browser/", { host: `127.0.0.1:${port}`, origin: "http://127.0.0.1:3038", cookie: session });
    assert.match(foreign.split("\r\n")[0], /403/, "another origin must not read the panel");
    const own = await rawGet(port, "/_browser/", { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, cookie: session });
    assert.match(own.split("\r\n")[0], /200/, "this origin serves its own panel");
  }));

test("an upgrade to the panel path is refused, and reaches neither the debug port nor the application", () =>
  withPanelGateway(async ({ base, port, debug }) => {
    const { session } = await completeSetup(base);
    for (const path of ["/_browser", "/_browser/"]) {
      const status = await wsStatusLine(port, path, session);
      assert.notEqual(status, "TIMEOUT", `${path} must get an answer, not a hung socket`);
      assert.match(status, /400/, `${path} is a page, not a socket, got "${status}"`);
    }
    assert.equal(debug.requests.length, 0, "the debug port must not be reached");
  }));

test("a browser WebSocket upgrade without a session is refused", () =>
  withPanelGateway(async ({ base, port, debug }) => {
    await completeSetup(base);
    const status = await wsStatusLine(port, "/_browser/devtools/page/8B04", null);
    assert.equal(/101/.test(status), false, `expected no upgrade, got "${status}"`);
    assert.equal(debug.requests.some((request) => request.method === "UPGRADE"), false, "the debug port must not be reached at all");
  }));

test("with a session, the browser upgrade is proxied, without the Origin Chromium would reject", () =>
  withPanelGateway(async ({ base, port, debug }) => {
    const { session } = await completeSetup(base);
    const status = await wsStatusLine(port, "/_browser/devtools/page/8B04", session);
    assert.match(status, /101/, `expected a 101, got "${status}"`);
    const upgrade = debug.requests.find((request) => request.method === "UPGRADE");
    assert.ok(upgrade, "the debug port must have received the upgrade");
    assert.equal(upgrade.path, "/devtools/page/8B04");
    assert.equal(upgrade.host, debug.authority);
    // Chromium refuses a WebSocket handshake carrying a foreign Origin, which is
    // its defence against a page controlling its own browser. The gateway is the
    // authenticated way in, so it strips the header instead of loosening Chrome.
    assert.equal(upgrade.origin, null, "the operator browser's Origin must not reach the debug port");
  }));

test("an unauthenticated browser upgrade is refused before the debug port is touched", () =>
  withPanelGateway(async ({ base, port, debug }) => {
    await completeSetup(base);
    for (const path of ["/_browser", "/_browser/json/version", "/_browser/devtools/page/8B04"]) {
      const status = await wsStatusLine(port, path, null);
      assert.equal(/101/.test(status), false, path);
    }
    assert.equal(debug.requests.length, 0, "nothing may reach the debug port without a session");
  }));

/** Raw HTTP/1.1 request: the only way to send a Host or an Origin of one's choosing. */
function rawGet(port, path, { host, cookie, origin } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${host}`,
          "Connection: close",
          ...(origin === undefined ? [] : [`Origin: ${origin}`]),
          ...(cookie ? [`Cookie: ${cookie}`] : []),
          "",
          "",
        ].join("\r\n"),
      );
    });
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
    });
    socket.on("end", () => resolve(received));
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      resolve(received);
    }, 3000).unref();
  });
}

test("a Host header that is not an authority is refused, never echoed into the discovery document", () =>
  withPanelGateway(async ({ base, port }) => {
    const { session } = await completeSetup(base);
    for (const hostile of ["evil.example/../x", "user:pass@host", "host name", "evil.example"]) {
      const response = await rawGet(port, "/_browser/json/version", { host: hostile, cookie: session });
      const [status] = response.split("\r\n");
      if (hostile === "evil.example") {
        // A plain hostname is a valid authority: it is rewritten like any other,
        // and the frontend it is served to is the one that asked for it.
        assert.match(status, /200/, hostile);
        assert.match(response, /ws:\/\/evil\.example\/_browser\/devtools\/browser/, hostile);
        continue;
      }
      assert.match(status, /400/, `${hostile} must be refused, got "${status}"`);
      assert.equal(response.includes("ws://"), false, `nothing may be rewritten from ${hostile}`);
    }
  }));

/**
 * The Origin check, which is the difference between "a session is required" and
 * "a session is enough".
 *
 * Any other service on the operator's loopback is same-site, so a page served by
 * one of them arrives with the gateway session cookie attached. Without this
 * check that page could open the browser route, and the gateway would then delete
 * the Origin that Chromium uses to refuse a handshake it did not generate, which
 * is what hands the whole browser over. The check belongs to the gateway because
 * the gateway is the authenticated boundary; the strip upstream stays, because
 * Chromium refuses any origin at all on that hop.
 */
test("a hostile Origin is refused on the browser route, with a session", () =>
  withPanelGateway(async ({ base, port, debug }) => {
    const { session } = await completeSetup(base);

    // The session is checked first, as on every other path: without one there is
    // no browser route, whatever the Origin says.
    const anonymous = await rawGet(port, "/_browser/json/version", { host: `127.0.0.1:${port}`, origin: "http://127.0.0.1:3038" });
    assert.match(anonymous.split("\r\n")[0], /302/, "no session means the sign in page, before any origin rule");

    for (const hostile of ["http://127.0.0.1:3038", "http://127.0.0.1:3030", "http://evil.example", `https://127.0.0.1:${port}`, "null"]) {
      for (const path of ["/_browser", "/_browser/json/version", "/_browser/json/list", "/_browser/devtools/inspector.html"]) {
        const response = await rawGet(port, path, { host: `127.0.0.1:${port}`, origin: hostile, cookie: session });
        assert.match(response.split("\r\n")[0], /403/, `${path} from ${hostile} must be refused, got "${response.split("\r\n")[0]}"`);
        assert.equal(response.includes("webSocketDebuggerUrl"), false, `${path} from ${hostile} must leak nothing`);
      }
    }
    assert.equal(debug.requests.length, 0, "the debug port must not be reached at all");
  }));

test("the gateway's own origin passes, and so does a request that carries none", () =>
  withPanelGateway(async ({ base, port, debug }) => {
    const { session } = await completeSetup(base);
    const own = await rawGet(port, "/_browser/json/version", { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, cookie: session });
    assert.match(own.split("\r\n")[0], /200/, "the frontend served by this gateway is this origin");
    assert.match(own, /ws:\/\/127\.0\.0\.1:\d+\/_browser\/devtools\/browser/, "and the document is still rewritten");

    const absent = await fetch(`${base}/_browser/json/version`, { headers: { cookie: session } });
    assert.equal(absent.status, 200, "a client that is not a page sends no Origin, and keeps working");

    // A real browser sends an Origin on a WebSocket handshake, so the upgrade is
    // checked too: this one is refused, the one below is not.
    const refused = await wsStatusLine(port, "/_browser/devtools/page/8B04", session, { origin: `http://127.0.0.1:3038` });
    assert.equal(/101/.test(refused), false, `a foreign origin must not upgrade, got "${refused}"`);
    assert.match(refused, /403/);

    const allowed = await wsStatusLine(port, "/_browser/devtools/page/8B04", session, { origin: `http://127.0.0.1:${port}` });
    assert.match(allowed, /101/, `this origin must upgrade, got "${allowed}"`);
    assert.equal(
      debug.requests.filter((request) => request.method === "UPGRADE").length,
      1,
      "only the allowed handshake may reach the debug port",
    );
  }));

/**
 * The TLS terminating proxy, which is a deployment the README recommends.
 *
 * The proxy terminates TLS and forwards plain http, so the browser sends an
 * `https` Origin while the gateway's own origin, as it computes it from the
 * socket, is `http`. The checked case above would refuse the panel there.
 * ZCLOUDIUM_TRUST_PROXY is the flag that already means "a proxy I control is in
 * front", so it is the one that says the https variant of this exact authority
 * may pass. The authority still has to match exactly, and the flag off path is
 * unchanged, which the hostile origin test above pins.
 */
test("behind a trusted proxy, an https Origin of this exact authority is accepted", () =>
  withPanelGateway(
    async ({ base, port, debug }) => {
      const { session } = await completeSetup(base);
      const host = `panel.example:${port}`;

      const accepted = await rawGet(port, "/_browser/json/version", { host, origin: `https://${host}`, cookie: session });
      assert.match(accepted.split("\r\n")[0], /200/, "the https variant of this exact authority is this gateway's frontend");
      assert.match(accepted, /ws:\/\/panel\.example:\d+\/_browser\/devtools\/browser/, "and the document is rewritten to the host the browser used");

      // The spelling a reverse proxy actually produces, and the reason the
      // comparison normalises the authority first: `proxy_set_header Host
      // $host:$server_port` on the https server hands the container
      // `panel.example:443`, while the browser's Origin carries no port at all,
      // because 443 is the default for https. Refusing this would break the
      // deployment the README recommends, with the flag on.
      const proxied = await rawGet(port, "/_browser/json/version", { host: "panel.example:443", origin: "https://panel.example", cookie: session });
      assert.match(proxied.split("\r\n")[0], /200/, `the proxy's Host spelling must be accepted, got "${proxied.split("\r\n")[0]}"`);
      const upper = await rawGet(port, "/_browser/json/version", { host: "PANEL.EXAMPLE:443", origin: "https://panel.example", cookie: session });
      assert.match(upper.split("\r\n")[0], /200/, `an uppercase host in the Host header must be accepted, got "${upper.split("\r\n")[0]}"`);
      // A port that is not the scheme's default is still another origin.
      const otherPort = await rawGet(port, "/_browser/json/version", { host: "panel.example:3041", origin: "https://panel.example", cookie: session });
      assert.match(otherPort.split("\r\n")[0], /403/, "another port is another origin");
      const proxiedUpgrade = await wsStatusLine(port, "/_browser/devtools/page/8B04", session, { host: "panel.example:443", origin: "https://panel.example" });
      assert.match(proxiedUpgrade, /101/, `the panel's own handshake must be allowed through that spelling too, got "${proxiedUpgrade}"`);

      // The authority is still compared character for character.
      for (const foreign of ["https://panel.example:3042", "https://panel.example", "https://evil.example", "https://127.0.0.1:3041"]) {
        const response = await rawGet(port, "/_browser/json/version", { host, origin: foreign, cookie: session });
        assert.match(response.split("\r\n")[0], /403/, `${foreign} must be refused, got "${response.split("\r\n")[0]}"`);
        assert.equal(response.includes("webSocketDebuggerUrl"), false, `${foreign} must leak nothing`);
      }

      // The upgrade is the path that matters: it carries the control channel, and
      // it is the one the panel itself opens.
      const upgrade = await wsStatusLine(port, "/_browser/devtools/page/8B04", session, { host, origin: `https://${host}` });
      assert.match(upgrade, /101/, `the frontend's own handshake must be allowed, got "${upgrade}"`);
      const refusedUpgrade = await wsStatusLine(port, "/_browser/devtools/page/8B04", session, { host, origin: "https://evil.example" });
      assert.match(refusedUpgrade, /403/, `a foreign https origin must not upgrade, got "${refusedUpgrade}"`);
      assert.equal(
        debug.requests.filter((request) => request.method === "UPGRADE").length,
        2,
        "only the two accepted handshakes (this authority, and the proxy's spelling of it) may reach the debug port",
      );
    },
    { trustProxy: true },
  ));

test("an upgrade the debug port answers with an HTTP response does not hang the operator", () =>
  withPanelGateway(async ({ base, port, debug }) => {
    const { session } = await completeSetup(base);
    // A tab that was closed under the operator, or a stale target id in a URL a
    // browser kept: the debug port answers a plain 404 instead of upgrading, and
    // that answer has to reach the operator rather than leave the socket hanging
    // until the browser gives up.
    const status = await wsStatusLine(port, "/_browser/devtools/page/GONE", session);
    assert.notEqual(status, "TIMEOUT", "the socket must get an answer, not hang");
    assert.match(status, /404/, `the debug port's own answer must reach the operator, got "${status}"`);
    assert.equal(
      debug.requests.filter((request) => request.method === "UPGRADE" && request.path.includes("GONE")).length,
      1,
      "the debug port must have been asked, and asked once",
    );
  }));

test("the application route keeps its own model: the origin check is the browser route's", () =>
  withPanelGateway(async ({ base }) => {
    const { session } = await completeSetup(base);
    // Deliberate scope. The application's upstream decides what it accepts, and
    // with the switch off the gateway must behave exactly as it did before the
    // panel existed, so no Origin rule is imposed on the application path here.
    const response = await fetch(`${base}/api/server-info`, {
      headers: { cookie: session, origin: "http://evil.example" },
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /^UPSTREAM \/api\/server-info$/);
  }));

test("a browser upgrade with an unusable Host is refused, not thrown out of the listener", () =>
  withPanelGateway(async ({ base, port, debug }) => {
    const { session } = await completeSetup(base);
    for (const hostile of ["", "   ", "host name", "user:pass@host", "evil.example/../x"]) {
      const status = await wsStatusLine(port, "/_browser/devtools/page/8B04", session, { host: hostile, origin: `http://127.0.0.1:${port}` });
      assert.notEqual(status, "TIMEOUT", `${JSON.stringify(hostile)} must get an answer, not a hung socket`);
      assert.match(status, /400/, `${JSON.stringify(hostile)} must be refused, got "${status}"`);
    }
    assert.equal(debug.requests.length, 0, "the debug port must not be reached");
  }));
