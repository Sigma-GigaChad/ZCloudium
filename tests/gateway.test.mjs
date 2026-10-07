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
    // One path answers a document, because the gateway edits documents and
    // nothing else, and a test of that edit needs something to edit.
    if (req.url.startsWith("/index.html")) {
      const body = "<!doctype html><html><body><div id=root></div></body></html>";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`UPSTREAM ${req.url}`);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket) => {
    if (req.url.includes("GONE")) {
      // What an application runtime may answer to an upgrade: a plain HTTP
      // response, no handshake.
      const body = "the runtime answers this upgrade with a page";
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
    // Regression guard (issue #7): the upstream server must not survive either.
    assert.equal(upstream.server.listening, false, "the upstream stub must not survive its test (issue #7 leak guard)");
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
  // ENVIRONMENT.md and SECURITY.md both quote five minutes for one block. This pins the
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
 * The security headers of every page the gateway itself serves. The policy is
 * closed: no source of anything, inline styles for the theme, and the one inline
 * script by its hash, so an injected script of any other shape is the browser's
 * problem to refuse, not only ours.
 */
test("every gateway page carries a closed content security policy", () =>
  withGateway(async ({ base }) => {
    const response = await fetch(`${base}/_auth/login`);
    const policy = response.headers.get("content-security-policy") ?? "";
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /script-src 'sha256-[A-Za-z0-9+/=]{43,44}'/, "the one script is allowed by hash, not by 'unsafe-inline'");
    assert.match(policy, /form-action 'self'/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-frame-options"), "DENY");

    const health = await fetch(`${base}/_auth/health`);
    assert.equal(health.headers.get("x-content-type-options"), "nosniff", "the plain answers carry it too");
  }));

/**
 * The sign-in code field must be able to carry a recovery code: nine
 * characters, letters included. A six character maxlength truncates one and a
 * numeric pattern refuses it, and a field that cannot carry the recovery shape
 * ships a dead feature: the browser blocks exactly the value the server
 * accepts.
 */
test("the sign-in code field can carry a recovery code", () =>
  withGateway(async ({ base, now }) => {
    await completeSetup(base, now);
    const login = await post(base, "/_auth/login", { username: USERNAME, password: PASSWORD });
    const loginCookie = cookieFrom(login, "zc_login");
    const response = await fetch(`${base}/_auth/verify`, { headers: { cookie: loginCookie } });
    const html = await response.text();
    assert.equal(html.includes('maxlength="10"'), true, "the field is long enough for a nine character recovery code");
    assert.equal(html.includes('pattern="[0-9]*"'), false, "a numeric pattern would refuse the letters of a recovery code");
  }));

/**
 * Recovery codes, end to end: shown once at enrolment, stored hashed, each one
 * a single sign in.
 */
test("enrolment shows a sheet of recovery codes, and only their hashes persist", () =>
  withGateway(async ({ base, dataDir, now }) => {
    const step1 = await post(base, "/_auth/setup", { username: USERNAME, password: PASSWORD, password2: PASSWORD });
    const setupCookie = cookieFrom(step1, "zc_setup");
    const enroll = await fetch(`${base}/_auth/setup/totp`, { headers: { cookie: setupCookie } });
    const page = await enroll.text();
    const shown = page.match(/class="secret recovery-sheet">([\s\S]*?)<\/code>/)?.[1] ?? "";
    const codes = [...shown.matchAll(/[A-Z2-9]{4}-[A-Z2-9]{4}/g)].map((match) => match[0]);
    assert.equal(codes.length, 10, "the whole sheet is on the enrolment page");

    const code = totp(page.match(/id="otp-secret"[^>]*>\s*([A-Z2-7\s]+?)\s*</)?.[1]?.replace(/\s+/g, ""), { at: now() });
    await post(base, "/_auth/setup/totp", { code }, setupCookie);

    const stored = JSON.parse(await readFile(join(dataDir, "auth", "users.json"), "utf8"));
    const sheet = stored.users[USERNAME].recoveryCodes;
    assert.equal(sheet.length, 10);
    assert.equal(sheet.every((entry) => /^[0-9a-f]{64}$/.test(entry.hash) && entry.used === false), true,
      "only hashes are stored, all unused");
    assert.equal(JSON.stringify(stored).includes(codes[0]), false, "the clear text codes never persist");
  }));

test("a recovery code signs in once, and the same code is refused afterwards", () =>
  withGateway(async ({ base, now }) => {
    const step1 = await post(base, "/_auth/setup", { username: USERNAME, password: PASSWORD, password2: PASSWORD });
    const setupCookie = cookieFrom(step1, "zc_setup");
    const enroll = await fetch(`${base}/_auth/setup/totp`, { headers: { cookie: setupCookie } });
    const page = await enroll.text();
    const recovery = page.match(/[A-Z2-9]{4}-[A-Z2-9]{4}/)?.[0];
    const secret = page.match(/id="otp-secret"[^>]*>\s*([A-Z2-7\s]+?)\s*</)?.[1]?.replace(/\s+/g, "");
    await post(base, "/_auth/setup/totp", { code: totp(secret, { at: now() }) }, setupCookie);

    // Password accepted, then the recovery code instead of a TOTP code.
    const login = await post(base, "/_auth/login", { username: USERNAME, password: PASSWORD });
    const loginCookie = cookieFrom(login, "zc_login");
    const first = await post(base, "/_auth/verify", { code: recovery.toLowerCase() }, loginCookie);
    assert.equal(first.status, 303, "a recovery code in any spelling completes the sign in");
    assert.ok(cookieFrom(first, "zc_sess"), "it issues a session");

    const second = await post(base, "/_auth/login", { username: USERNAME, password: PASSWORD });
    const secondLoginCookie = cookieFrom(second, "zc_login");
    const replay = await post(base, "/_auth/verify", { code: recovery }, secondLoginCookie);
    assert.equal(replay.status, 401, "the same code is not a way in twice");
  }));

/**
 * The password change: guarded by the current password, and it ends every
 * session by rotating the signing key.
 */
test("changing the password requires the current one and kills every session", () =>
  withGateway(async ({ base, now, dataDir }) => {
    const { session } = await completeSetup(base, now);
    const keyBefore = await readFile(join(dataDir, "auth", "secret.key"));

    const anonymous = await fetch(`${base}/_auth/password`, { redirect: "manual" });
    assert.equal(anonymous.status, 302, "the form asks for a session first");

    const wrong = await post(base, "/_auth/password", { current: "not-the-password", password: "another-horse-battery-2", password2: "another-horse-battery-2" }, session);
    assert.equal(wrong.status, 401, "a wrong current password is refused");

    const weak = await post(base, "/_auth/password", { current: PASSWORD, password: "short", password2: "short" }, session);
    assert.equal(weak.status, 400, "the strength rules apply to the new password too");

    const changed = await post(base, "/_auth/password", { current: PASSWORD, password: "another-horse-battery-2", password2: "another-horse-battery-2" }, session);
    assert.equal(changed.status, 303);
    assert.equal(changed.headers.get("location"), "/_auth/login?next=%2F");
    assert.equal(cookieFrom(changed, "zc_sess"), "zc_sess=", "the changing session itself is cleared");

    const keyAfter = await readFile(join(dataDir, "auth", "secret.key"));
    assert.notEqual(keyBefore.equals(keyAfter), true, "the signing key rotated");

    const stale = await fetch(`${base}/some/path`, { headers: { cookie: session }, redirect: "manual" });
    assert.equal(stale.status, 302, "a cookie signed with the old key authorises nothing");
    assert.match(stale.headers.get("location"), /\/_auth\/login/);

    const fresh = await post(base, "/_auth/login", { username: USERNAME, password: "another-horse-battery-2" });
    assert.equal(fresh.status, 303, "the new password signs in");
  }));

/**
 * The failure budget survives the process: the counter is persisted, so a
 * container restart must not hand back a fresh budget. A gateway that dies under
 * a brute force attempt, or a container that crash loops, keeps the blocks and
 * the counts it had.
 */
test("the failure block survives a gateway restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "zcloudium-gateway-"));
  let clock = Date.now();
  const now = () => clock;
  const first = await createGateway({ upstreamUrl: "http://127.0.0.1:1", dataDir, logger: () => {}, now });
  try {
    for (let index = 0; index < MAX_FAILURES; index += 1) {
      clock += 1_000;
      const response = await post(`http://127.0.0.1:${first.port}`, "/_auth/login", { username: USERNAME, password: "wrong" });
      assert.equal(response.status, 401);
    }
    const blocked = await post(`http://127.0.0.1:${first.port}`, "/_auth/login", { username: USERNAME, password: "wrong" });
    assert.equal(blocked.status, 429, "the eighth failure blocks, as always");
  } finally {
    await first.close();
  }

  const stored = JSON.parse(await readFile(join(dataDir, "auth", "failures.json"), "utf8"));
  assert.equal(Object.values(stored).some((entry) => entry.blockedUntil > clock), true,
    "the block is on disk before the second start");

  const second = await createGateway({ upstreamUrl: "http://127.0.0.1:1", dataDir, logger: () => {}, now });
  try {
    const afterRestart = await post(`http://127.0.0.1:${second.port}`, "/_auth/login", { username: USERNAME, password: PASSWORD });
    assert.equal(afterRestart.status, 429, "a restarted gateway keeps the block it was left");
  } finally {
    await second.close();
  }
  await rm(dataDir, { recursive: true, force: true });
});

/**
 * Metrics: behind the session, in the Prometheus text format, and the numbers
 * are the ones the gateway actually counted.
 */
test("metrics sit behind the session and count what happened", () =>
  withGateway(async ({ base, now }) => {
    const anonymous = await fetch(`${base}/_auth/metrics`, { redirect: "manual" });
    assert.equal(anonymous.status, 302, "a stranger is sent to the sign in page");

    await post(base, "/_auth/login", { username: USERNAME, password: "wrong" });
    const { session } = await completeSetup(base, now);
    const page = await (await fetch(`${base}/_auth/metrics`, { headers: { cookie: session } })).text();

    assert.match(page, /^gateway_auth_failures_total 1$/m, "the wrong password was counted");
    assert.match(page, /^gateway_sessions_issued_total 1$/m);
    assert.match(page, /^gateway_recovery_codes_used_total 0$/m);
    assert.match(page, /# TYPE gateway_auth_blocks_total counter/);
    const proxied = await fetch(`${base}/anything`, { headers: { cookie: session } });
    await proxied.text();
    const after = await (await fetch(`${base}/_auth/metrics`, { headers: { cookie: session } })).text();
    assert.match(after, /^gateway_upstream_requests_total 1$/m, "a proxied request was counted");
  }));

/**
 * Owner and accounts: the first account owns the instance, creates the others,
 * and nobody else can.
 */
test("the owner creates a second account, which signs in on its own credentials", () =>
  withGateway(async ({ base, now, advance }) => {
    const { session } = await completeSetup(base, now);

    const created = await post(base, "/_auth/users", { username: "colleague", password: "a-fine-long-passphrase", password2: "a-fine-long-passphrase" }, session);
    assert.equal(created.status, 303);
    assert.equal(created.headers.get("location"), "/_auth/setup/totp");
    const setupCookie = cookieFrom(created, "zc_setup");

    const enroll = await fetch(`${base}/_auth/setup/totp`, { headers: { cookie: setupCookie } });
    const page = await enroll.text();
    const secret = page.match(/id="otp-secret"[^>]*>\s*([A-Z2-7\s]+?)\s*</)?.[1]?.replace(/\s+/g, "");
    assert.ok(secret, "the new account's enrolment page shows its own secret");

    const confirmed = await post(base, "/_auth/setup/totp", { code: totp(secret, { at: now() }) }, setupCookie);
    assert.equal(confirmed.status, 303);
    assert.equal(confirmed.headers.get("location"), "/_auth/users?created=colleague",
      "the operator is taken back to the account list, not signed in as the new user");
    assert.equal(cookieFrom(confirmed, "zc_sess"), null, "no session is issued for the new user in the operator's browser");

    // A different TOTP step than the one the enrolment consumed, which is the
    // replay rule every sign in lives by.
    advance(30_000);
    const login = await post(base, "/_auth/login", { username: "colleague", password: "a-fine-long-passphrase" });
    const loginCookie = cookieFrom(login, "zc_login");
    const verified = await post(base, "/_auth/verify", { code: totp(secret, { at: now() }) }, loginCookie);
    const colleagueSession = cookieFrom(verified, "zc_sess");
    assert.ok(colleagueSession, "the new account signs in with its own credentials");

    const list = await fetch(`${base}/_auth/users`, { headers: { cookie: session } });
    assert.equal(list.status, 200);
    assert.match(await list.text(), /colleague/);

    const refused = await fetch(`${base}/_auth/users`, { headers: { cookie: colleagueSession } });
    assert.equal(refused.status, 403, "only the owner manages accounts");

    const duplicate = await post(base, "/_auth/users", { username: "colleague", password: "a-fine-long-passphrase", password2: "a-fine-long-passphrase" }, session);
    assert.equal(duplicate.status, 303);
    assert.match(duplicate.headers.get("location"), /error=That%20username%20already%20exists/);
  }));

test("the first-run wizard stays exclusive once an account exists", () =>
  withGateway(async ({ base, now }) => {
    await completeSetup(base, now);
    const attempt = await post(base, "/_auth/setup", { username: "intruder", password: "a-fine-long-passphrase", password2: "a-fine-long-passphrase" });
    assert.equal(attempt.status, 409, "with an owner present, the wizard answers for the owner only");
  }));

/**
 * The 502 page: an operator whose runtime is down gets a page that explains
 * itself and retries, not a bare string.
 */
test("a dead upstream answers with an html page that reloads itself", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "zcloudium-gateway-"));
  const gateway = await createGateway({
    // Port 1 on loopback: nothing listens there, so every proxied request fails.
    upstreamUrl: "http://127.0.0.1:1",
    dataDir,
    logger: () => {},
  });
  try {
    const setupStep = await post(`http://127.0.0.1:${gateway.port}`, "/_auth/setup", { username: USERNAME, password: PASSWORD, password2: PASSWORD });
    const setupCookie = cookieFrom(setupStep, "zc_setup");
    const enroll = await fetch(`http://127.0.0.1:${gateway.port}/_auth/setup/totp`, { headers: { cookie: setupCookie } });
    const secret = (await enroll.text()).match(/id="otp-secret"[^>]*>\s*([A-Z2-7\s]+?)\s*</)?.[1]?.replace(/\s+/g, "");
    const confirmed = await post(`http://127.0.0.1:${gateway.port}`, "/_auth/setup/totp", { code: totp(secret, { at: Date.now() }) }, setupCookie);
    const session = cookieFrom(confirmed, "zc_sess");

    const response = await fetch(`http://127.0.0.1:${gateway.port}/`, { headers: { cookie: session } });
    assert.equal(response.status, 502);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const body = await response.text();
    assert.match(body, /http-equiv="refresh" content="10"/, "the page retries on its own");
    assert.match(body, /not answering/i);
  } finally {
    await gateway.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("GitHub credentials: the owner stores a token once, the file is gh's own, non-owners are refused", () =>
  withGateway(
    async ({ base, dataDir, now, advance }) => {
      const { session } = await completeSetup(base, now);

      // Behind the same door as every gateway page.
      const anonymous = await fetch(`${base}/_auth/github`, { redirect: "manual" });
      assert.equal(anonymous.status, 302);
      assert.match(anonymous.headers.get("location") ?? "", /_auth\/login/);

      // The credentials every account's environments inherit are the owner's
      // decision, so a signed-in non-owner is refused like on /_auth/users.
      const created = await post(base, "/_auth/users", { username: "colleague", password: "a-fine-long-passphrase", password2: "a-fine-long-passphrase" }, session);
      const setupCookie = cookieFrom(created, "zc_setup");
      const enroll = await fetch(`${base}/_auth/setup/totp`, { headers: { cookie: setupCookie } });
      const secret = (await enroll.text()).match(/id="otp-secret"[^>]*>\s*([A-Z2-7\s]+?)\s*</)?.[1]?.replace(/\s+/g, "");
      // The account exists only once its enrolment is confirmed.
      const confirmed = await post(base, "/_auth/setup/totp", { code: totp(secret, { at: now() }) }, setupCookie);
      assert.equal(confirmed.status, 303);
      advance(30_000);
      const login = await post(base, "/_auth/login", { username: "colleague", password: "a-fine-long-passphrase" });
      const verified = await post(base, "/_auth/verify", { code: totp(secret, { at: now() }) }, cookieFrom(login, "zc_login"));
      const colleagueSession = cookieFrom(verified, "zc_sess");
      const refused = await fetch(`${base}/_auth/github`, { headers: { cookie: colleagueSession } });
      assert.equal(refused.status, 403);

      // The owner starts from an empty status.
      const empty = await fetch(`${base}/_auth/github`, { headers: { cookie: session } });
      assert.equal(empty.status, 200);
      assert.match(await empty.text(), /No GitHub credentials stored/);

      // A token GitHub refuses is not stored.
      const bad = await post(base, "/_auth/github", { token: "ghp_invalid_token_value" }, session);
      assert.equal(bad.status, 303);
      assert.match(bad.headers.get("location") ?? "", /error=/);
      await assert.rejects(() => readFile(join(dataDir, ".config", "gh", "hosts.yml")));

      // A token GitHub accepts is written where gh reads it, mode 0600.
      const good = await post(base, "/_auth/github", { token: "ghp_good_token_value_1234567890" }, session);
      assert.equal(good.status, 303);
      assert.match(good.headers.get("location") ?? "", /saved=octocat/);
      const path = join(dataDir, ".config", "gh", "hosts.yml");
      const stored = await readFile(path, "utf8");
      assert.match(stored, /^github\.com:$/m);
      assert.match(stored, /oauth_token: ghp_good_token_value_1234567890/m);
      assert.match(stored, /user: octocat/m);
      const { stat } = await import("node:fs/promises");
      assert.equal((await stat(path)).mode & 0o777, 0o600, "the token file is owner-only");
      const page = await fetch(`${base}/_auth/github`, { headers: { cookie: session } });
      assert.match(await page.text(), /Authenticated as <strong>octocat<\/strong>/);

      // Removal empties the status again.
      const removed = await post(base, "/_auth/github", { remove: "1" }, session);
      assert.equal(removed.status, 303);
      await assert.rejects(() => readFile(path));
      const after = await fetch(`${base}/_auth/github`, { headers: { cookie: session } });
      assert.match(await after.text(), /No GitHub credentials stored/);
    },
    {
      // The GitHub API stub: only tokens this test controls validate, so the
      // suite never touches the network and 401s are reproducible.
      githubApiFetch: async (_url, init) => {
        const token = String(init?.headers?.authorization ?? "").replace("Bearer ", "");
        const status = token.startsWith("ghp_good") ? 200 : 401;
        return new Response(JSON.stringify({ login: "octocat" }), {
          status,
          headers: { "content-type": "application/json" },
        });
      },
    },
  ));


test("GitHub device flow: the owner signs in like gh auth login, the token lands in hosts.yml", () =>
  withGateway(
    async ({ base, dataDir, advance }) => {
      const { session } = await completeSetup(base);

      // Step 1: starting the flow asks GitHub for a code pair, then the
      // waiting page shows the short code and the address to type it at.
      const start = await post(base, "/_auth/github/device", {}, session);
      assert.equal(start.status, 303);
      assert.equal(start.headers.get("location"), "/_auth/github/device");

      const waiting = await fetch(`${base}/_auth/github/device`, { headers: { cookie: session } });
      const waitingPage = await waiting.text();
      assert.match(waitingPage, /data-testid="device-user-code">WXYZ-1234</);
      assert.match(waitingPage, /github\.com\/login\/device/);
      assert.match(waitingPage, /http-equiv="refresh" content="5; url=\/_auth\/github\/device\/check"/);
      // The device code is the one secret of the flow and never reaches a page.
      assert.doesNotMatch(waitingPage, /device-flow-device-code/);

      // Step 2: the first check is held back (GitHub named a five second
      // interval), then reports pending while the code is not typed yet.
      const heldBack = await fetch(`${base}/_auth/github/device/check`, { headers: { cookie: session }, redirect: "manual" });
      assert.equal(heldBack.status, 303, "the first poll respects the interval GitHub named");
      advance(6_000);

      const pending = await fetch(`${base}/_auth/github/device/check`, { headers: { cookie: session }, redirect: "manual" });
      assert.equal(pending.status, 303);
      assert.equal(pending.headers.get("location"), "/_auth/github/device", "pending sends the browser back to the waiting page");

      // Step 3: the user has typed the code; the next check completes the
      // sign-in and writes the same hosts.yml the token form writes. The
      // gateway creeps its poll interval by one second per cycle, so clear it.
      advance(8_000);
      authorized = true;
      const done = await fetch(`${base}/_auth/github/device/check`, { headers: { cookie: session }, redirect: "manual" });
      assert.equal(done.status, 303);
      assert.equal(done.headers.get("location"), "/_auth/github?saved=octocat");

      const stored = await readFile(join(dataDir, ".config", "gh", "hosts.yml"), "utf8");
      assert.match(stored, /oauth_token: gho_device_flow_token/m);
      assert.match(stored, /user: octocat/m);
      const { stat } = await import("node:fs/promises");
      assert.equal((await stat(join(dataDir, ".config", "gh", "hosts.yml"))).mode & 0o777, 0o600);

      // The flow is spent: another check redirects to the credentials page.
      advance(6_000);
      const spent = await fetch(`${base}/_auth/github/device/check`, { headers: { cookie: session }, redirect: "manual" });
      assert.equal(spent.headers.get("location"), "/_auth/github");
    },
    {
      githubApiFetch: deviceFlowStub(),
    },
  ));

test("GitHub device flow: expired codes clean up, cancel clears the flow, non-owners are refused", () =>
  withGateway(
    async ({ base, now, advance }) => {
      const { session } = await completeSetup(base, now);

      const start = await post(base, "/_auth/github/device", {}, session);
      assert.equal(start.status, 303);

      // Expiry: GitHub's expires_in has passed, so the check cleans up and
      // says so instead of waiting forever.
      advance(16 * 60 * 1000);
      const expired = await fetch(`${base}/_auth/github/device/check`, { headers: { cookie: session }, redirect: "manual" });
      assert.equal(expired.status, 303);
      assert.match(expired.headers.get("location") ?? "", /error=The%20device%20code%20expired/);
      // And the flow is gone: the waiting page redirects back to the form.
      const gone = await fetch(`${base}/_auth/github/device`, { headers: { cookie: session }, redirect: "manual" });
      assert.equal(gone.headers.get("location"), "/_auth/github");

      // Cancel clears whatever flow was pending.
      await post(base, "/_auth/github/device", {}, session);
      const cancelled = await post(base, "/_auth/github/device/cancel", {}, session);
      assert.equal(cancelled.status, 303);
      assert.equal(cancelled.headers.get("location"), "/_auth/github");
      const afterCancel = await fetch(`${base}/_auth/github/device`, { headers: { cookie: session }, redirect: "manual" });
      assert.equal(afterCancel.headers.get("location"), "/_auth/github");

      // Non-owners are refused on every device route, like on the form.
      const created = await post(base, "/_auth/users", { username: "colleague", password: "a-fine-long-passphrase", password2: "a-fine-long-passphrase" }, session);
      const setupCookie = cookieFrom(created, "zc_setup");
      const enroll = await fetch(`${base}/_auth/setup/totp`, { headers: { cookie: setupCookie } });
      const secret = (await enroll.text()).match(/id="otp-secret"[^>]*>\s*([A-Z2-7\s]+?)\s*</)?.[1]?.replace(/\s+/g, "");
      await post(base, "/_auth/setup/totp", { code: totp(secret, { at: now() }) }, setupCookie);
      advance(30_000);
      const login = await post(base, "/_auth/login", { username: "colleague", password: "a-fine-long-passphrase" });
      const verified = await post(base, "/_auth/verify", { code: totp(secret, { at: now() }) }, cookieFrom(login, "zc_login"));
      const colleagueSession = cookieFrom(verified, "zc_sess");
      const refusedStart = await post(base, "/_auth/github/device", {}, colleagueSession);
      assert.equal(refusedStart.status, 403);
      const refusedCheck = await fetch(`${base}/_auth/github/device/check`, { headers: { cookie: colleagueSession } });
      assert.equal(refusedCheck.status, 403);
    },
    {
      githubApiFetch: deviceFlowStub(),
    },
  ));

/**
 * The GitHub device-flow stub, routed by URL: device/code always answers a
 * fixed pair, token polling stays pending until the test flips the flag, and
 * the /user lookup names the login. `authorized` is reset per test.
 */
let authorized = false;
function deviceFlowStub() {
  authorized = false;
  return async (url) => {
    if (String(url).endsWith("/login/device/code")) {
      return new Response(JSON.stringify({
        device_code: "device-flow-device-code",
        user_code: "WXYZ-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).endsWith("/login/oauth/access_token")) {
      if (!authorized) {
        return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ access_token: "gho_device_flow_token", token_type: "bearer", scope: "repo,read:org,gist,workflow" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url) === "https://api.github.com/user") {
      return new Response(JSON.stringify({ login: "octocat" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
}
