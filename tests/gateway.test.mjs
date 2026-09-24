import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../gateway/lib/server.mjs";
import { totp } from "../gateway/lib/totp.mjs";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const USERNAME = "operator";
const PASSWORD = "correct-horse-battery-staple";

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

async function withGateway(run) {
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

function post(base, path, fields, cookie) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
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
function wsStatusLine(port, path, cookie) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      const key = randomBytes(16).toString("base64");
      const request = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
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
