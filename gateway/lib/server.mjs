/**
 * The authentication gateway.
 *
 * It listens on the published port, owns the /_auth/* routes, and proxies
 * everything else to the ZCode server on loopback once a session is present.
 * It never imports application code, so an upstream update cannot break it.
 */

import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { hashPassword, verifyPassword, checkPasswordStrength } from "./password.mjs";
import { generateSecret, otpauthUri, totp, verifyTotp } from "./totp.mjs";
import {
  DEFAULT_SESSION_TTL_MS,
  PENDING_LOGIN_COOKIE,
  PENDING_SETUP_COOKIE,
  SESSION_COOKIE,
  clearedCookie,
  loadOrCreateSessionKey,
  parseCookies,
  pendingCookie,
  sessionCookie,
  signSession,
  verifySession,
} from "./session.mjs";
import { findUser, hasUsers, readUsers, sessionKeyPath, writeUsers } from "./store.mjs";
import * as pages from "./pages.mjs";

const AUTH_PREFIX = "/_auth";
const ISSUER = "ZCloudium";

const PENDING_TTL_SECONDS = 600;
/**
 * Failed attempts allowed from one rate limit key before it is blocked, and how
 * long the block lasts. The limit applies to the password step, the code step and
 * the enrolment step, so a six digit second factor cannot be walked through.
 *
 * The key is the connecting socket address by default. See `trustProxy` below.
 */
export const MAX_FAILURES = 8;
/**
 * How long one block lasts. The documentation quotes this bound, so it is
 * exported: tests measure the duration the gateway applies instead of a copy of
 * it, and a change here that is not also made to what is advertised fails.
 */
export const BLOCK_MS = 5 * 60 * 1000;

/** Raised against a fixed origin to prove that a `next` value stays on it. */
const NEXT_ORIGIN = "http://gateway.invalid";

function html(res, status, body) {
  const buffer = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": buffer.length,
    "cache-control": "no-store",
  });
  res.end(buffer);
}

function redirect(res, location) {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

function seeOther(res, location, cookies = []) {
  const headers = { location, "cache-control": "no-store" };
  if (cookies.length > 0) {
    headers["set-cookie"] = cookies;
  }
  res.writeHead(303, headers);
  res.end();
}

function withCookie(res, status, body, cookie) {
  const buffer = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": buffer.length,
    "cache-control": "no-store",
    ...(cookie ? { "set-cookie": cookie } : {}),
  });
  res.end(buffer);
}

/** The same answer on every throttled step, so a blocked client learns nothing else. */
function tooManyAttemptsPage() {
  return pages.messagePage({
    title: "Too many attempts",
    heading: "Too many attempts",
    message: "This address is temporarily blocked. Try again in a few minutes.",
  });
}

async function readForm(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new Error("request body too large");
    }
    chunks.push(chunk);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

/**
 * Only a same origin absolute path is honoured, so `next` cannot be turned into
 * an open redirect.
 *
 * The URL specification is generous with the characters it rewrites: a backslash
 * is a slash for special schemes and tabs or newlines are stripped before
 * parsing, so `/\evil.com` and `/<tab>/evil.com` both mean `//evil.com` to a
 * browser. The value is therefore refused when it carries a backslash, a percent
 * encoded backslash or slash, or any whitespace, and then resolved against a
 * fixed origin: a result that leaves that origin is refused. Returning the
 * resolved path is what the gateway then puts in its own redirect.
 *
 * Dot segment normalisation is the reason the resolved path needs its own check:
 * `/..//evil.com` resolves to `//evil.com` while the origin stays the fixed one,
 * so the origin test above cannot see it, and a browser reads a path that starts
 * with two slashes as a protocol relative URL, in other words another host.
 */
export function safeNext(value) {
  if (typeof value !== "string" || value === "" || !value.startsWith("/")) {
    return "/";
  }
  if (/\\/.test(value) || /%(2f|5c)/i.test(value) || /\s/.test(value)) {
    return "/";
  }
  try {
    const resolved = new URL(value, NEXT_ORIGIN);
    if (resolved.origin !== NEXT_ORIGIN) {
      return "/";
    }
    const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    if (path.startsWith("//")) {
      return "/";
    }
    return path;
  } catch {
    return "/";
  }
}

export async function createGateway({
  upstreamUrl,
  dataDir,
  host = "127.0.0.1",
  port = 0,
  logger = () => {},
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  maxBodyBytes = 64 * 1024,
  /**
   * Whether the rate limit key may be read from the x-forwarded-for header.
   *
   * Off by default, and that is the safe direction: a header a client can set is
   * a key a client can change, which turns the block into decoration. Turn it on
   * only behind a reverse proxy that overwrites the header with the address it
   * saw, and know that the proxy then becomes the only thing separating two
   * clients. Behind the Docker port mapping, the socket address is the bridge
   * address, so every client shares one key: that is the price of not trusting a
   * header, and it is the failure mode to prefer.
   */
  trustProxy = false,
  // Injectable so tests can advance time instead of sleeping through TOTP steps.
  now = () => Date.now(),
} = {}) {
  if (!dataDir) {
    throw new Error("createGateway requires a dataDir");
  }
  if (!upstreamUrl) {
    throw new Error("createGateway requires an upstreamUrl");
  }

  const key = await loadOrCreateSessionKey(sessionKeyPath(dataDir));
  const target = new URL(upstreamUrl);
  const failures = new Map();
  // Upgraded sockets leave the HTTP connection tracking, so close() would wait for
  // them forever. They are tracked here and destroyed explicitly on shutdown.
  const upgradedSockets = new Set();

  const clientAddress = (req) => {
    if (trustProxy) {
      const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
      if (forwarded) {
        return forwarded;
      }
    }
    return req.socket.remoteAddress || "unknown";
  };

  const blocked = (address) => {
    const entry = failures.get(address);
    return Boolean(entry) && entry.blockedUntil > now();
  };
  const noteFailure = (address) => {
    const at = now();
    const stored = failures.get(address);
    // A block that has ended also ends the budget behind it, so the count starts
    // again. Without this the count stays at the threshold after a block ends, and
    // one failure per block period keeps the key blocked forever: a permanent
    // denial of service on the sign in page, and the advertised bound made false.
    const blockExpired = Boolean(stored && stored.blockedUntil > 0 && stored.blockedUntil <= at);
    const entry = blockExpired ? { count: 0, blockedUntil: 0 } : (stored ?? { count: 0, blockedUntil: 0 });
    entry.count += 1;
    if (entry.count >= MAX_FAILURES) {
      entry.blockedUntil = at + BLOCK_MS;
      logger(`[auth] too many failures from ${address}, temporarily blocked`);
    }
    failures.set(address, entry);
  };
  const noteSuccess = (address) => failures.delete(address);

  const cookiesOf = (req) => parseCookies(req.headers.cookie);
  const sessionOf = (req) => verifySession(cookiesOf(req)[SESSION_COOKIE], key, { at: now() });
  const pendingSetupOf = (req) =>
    verifySession(cookiesOf(req)[PENDING_SETUP_COOKIE], key, { at: now() });
  const pendingLoginOf = (req) =>
    verifySession(cookiesOf(req)[PENDING_LOGIN_COOKIE], key, { at: now() });

  async function handleAuth(req, res, url) {
    const { pathname } = url;
    const address = clientAddress(req);
    const users = await readUsers(dataDir);

    if (pathname === `${AUTH_PREFIX}/health`) {
      const buffer = Buffer.from("ok\n", "utf8");
      res.writeHead(200, { "content-type": "text/plain", "content-length": buffer.length });
      res.end(buffer);
      return;
    }

    if (pathname === `${AUTH_PREFIX}/login`) {
      if (req.method === "GET") {
        if (!hasUsers(users)) {
          redirect(res, `${AUTH_PREFIX}/setup`);
          return;
        }
        html(res, 200, pages.loginPage({ error: url.searchParams.get("error"), next: safeNext(url.searchParams.get("next")) }));
        return;
      }

      if (req.method === "POST") {
        if (blocked(address)) {
          html(res, 429, pages.loginPage({ error: "Too many attempts. Try again in a few minutes." }));
          return;
        }
        const form = await readForm(req, maxBodyBytes);
        const user = findUser(users, String(form.username ?? ""));
        const ok = user ? await verifyPassword(String(form.password ?? ""), user.password) : false;
        if (!ok) {
          noteFailure(address);
          logger(`[auth] failed password attempt from ${address}`);
          html(res, 401, pages.loginPage({ error: "Incorrect username or password." }));
          return;
        }
        noteSuccess(address);
        const pending = signSession(
          {
            user: String(form.username),
            next: safeNext(form.next),
            exp: now() + PENDING_TTL_SECONDS * 1000,
          },
          key,
        );
        seeOther(res, `${AUTH_PREFIX}/verify`, [pendingCookie(PENDING_LOGIN_COOKIE, pending, PENDING_TTL_SECONDS)]);
        return;
      }
    }

    if (pathname === `${AUTH_PREFIX}/verify`) {
      const pending = pendingLoginOf(req);
      if (!pending) {
        html(res, 401, pages.messagePage({
          title: "Session expired",
          heading: "Sign in again",
          message: "This step expired. Start again from the sign-in page.",
        }));
        return;
      }

      if (req.method === "GET") {
        html(res, 200, pages.verifyPage({ error: url.searchParams.get("error") }));
        return;
      }

      if (req.method === "POST") {
        // The code step is throttled too, otherwise the six digits can be tried
        // forever once the password is known.
        if (blocked(address)) {
          logger(`[auth] refusing a two-factor attempt from ${address}: temporarily blocked`);
          html(res, 429, tooManyAttemptsPage());
          return;
        }
        const user = findUser(users, pending.user);
        if (!user) {
          html(res, 401, pages.verifyPage({ error: "Unknown account." }));
          return;
        }
        const form = await readForm(req, maxBodyBytes);
        const result = verifyTotp(user.totpSecret, String(form.code ?? ""), {
          at: now(),
          lastStep: user.totpLastStep,
        });
        if (!result.ok) {
          noteFailure(address);
          logger(`[auth] rejected two-factor code from ${address} (${result.reason})`);
          html(res, 401, pages.verifyPage({ error: "That code is not valid." }));
          return;
        }
        user.totpLastStep = result.step;
        await writeUsers(dataDir, users);
        noteSuccess(address);

        const session = signSession({ user: user.username, exp: now() + sessionTtlMs }, key);
        seeOther(res, safeNext(pending.next), [
          sessionCookie(session, { maxAgeSeconds: Math.floor(sessionTtlMs / 1000) }),
          clearedCookie(PENDING_LOGIN_COOKIE),
        ]);
        return;
      }
    }

    if (pathname === `${AUTH_PREFIX}/setup`) {
      if (hasUsers(users)) {
        if (req.method === "GET") {
          redirect(res, `${AUTH_PREFIX}/login`);
          return;
        }
        html(res, 409, pages.messagePage({
          title: "Already configured",
          heading: "This instance already has an account",
          message: "Setup runs once. Sign in with the existing credentials.",
        }));
        return;
      }

      if (req.method === "GET") {
        html(res, 200, pages.setupAccountPage({ error: url.searchParams.get("error") }));
        return;
      }

      if (req.method === "POST") {
        const form = await readForm(req, maxBodyBytes);
        const username = String(form.username ?? "").trim();
        const problem = checkPasswordStrength(form.password, form.password2);
        if (!username || problem) {
          html(res, 400, pages.setupAccountPage({
            error: !username ? "A username is required." : problem,
          }));
          return;
        }

        const pending = signSession(
          {
            username,
            password: await hashPassword(String(form.password)),
            totpSecret: generateSecret(),
            exp: now() + PENDING_TTL_SECONDS * 1000,
          },
          key,
        );
        seeOther(res, `${AUTH_PREFIX}/setup/totp`, [
          pendingCookie(PENDING_SETUP_COOKIE, pending, PENDING_TTL_SECONDS),
        ]);
        return;
      }
    }

    if (pathname === `${AUTH_PREFIX}/setup/totp`) {
      const pending = pendingSetupOf(req);
      if (!pending) {
        redirect(res, `${AUTH_PREFIX}/setup`);
        return;
      }

      if (req.method === "GET") {
        html(res, 200, pages.setupTotpPage({
          secret: pending.totpSecret,
          uri: otpauthUri({ secret: pending.totpSecret, issuer: ISSUER, account: pending.username }),
          account: pending.username,
          error: url.searchParams.get("error"),
        }));
        return;
      }

      if (req.method === "POST") {
        // The enrolment step is reachable without any session, so it is throttled
        // like the sign in code step: an attacker must not be able to walk the
        // six digits, and the account must not be created by one who tries.
        if (blocked(address)) {
          logger(`[auth] refusing an enrolment attempt from ${address}: temporarily blocked`);
          html(res, 429, tooManyAttemptsPage());
          return;
        }
        const form = await readForm(req, maxBodyBytes);
        const result = verifyTotp(pending.totpSecret, String(form.code ?? ""), { at: now() });
        if (!result.ok) {
          noteFailure(address);
          html(res, 400, pages.setupTotpPage({
            secret: pending.totpSecret,
            uri: otpauthUri({ secret: pending.totpSecret, issuer: ISSUER, account: pending.username }),
            account: pending.username,
            error: "That code is not valid. Check the clock on your device and try again.",
          }));
          return;
        }

        const fresh = (await readUsers(dataDir)) ?? { version: 1, users: {} };
        if (hasUsers(fresh)) {
          html(res, 409, pages.messagePage({
            title: "Already configured",
            heading: "This instance already has an account",
            message: "Setup runs once. Sign in with the existing credentials.",
          }));
          return;
        }
        fresh.users[pending.username] = {
          username: pending.username,
          password: pending.password,
          totpSecret: pending.totpSecret,
          totpLastStep: result.step,
          createdAt: new Date().toISOString(),
        };
        await writeUsers(dataDir, fresh);
        logger(`[auth] account "${pending.username}" created with two-factor authentication`);

        const session = signSession({ user: pending.username, exp: now() + sessionTtlMs }, key);
        seeOther(res, "/", [
          sessionCookie(session, { maxAgeSeconds: Math.floor(sessionTtlMs / 1000) }),
          clearedCookie(PENDING_SETUP_COOKIE),
        ]);
        return;
      }
    }

    if (pathname === `${AUTH_PREFIX}/logout`) {
      if (req.method === "POST" || req.method === "GET") {
        seeOther(res, `${AUTH_PREFIX}/login`, [clearedCookie(SESSION_COOKIE), clearedCookie(PENDING_LOGIN_COOKIE)]);
        return;
      }
    }

    html(res, 404, pages.messagePage({
      title: "Not found",
      heading: "Unknown authentication route",
      message: "Go back to the sign-in page.",
    }));
  }

  function proxy(req, res) {
    const headers = { ...req.headers, host: target.host };
    headers["x-forwarded-for"] = clientAddress(req);
    headers["x-forwarded-proto"] = req.socket.encrypted ? "https" : "http";
    delete headers["connection"];

    const upstream = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 80,
        method: req.method,
        path: req.url,
        headers,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      logger(`[auth] upstream error: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
      }
      res.end("Bad gateway");
    });
    req.pipe(upstream);
  }

  function handleUpgrade(req, socket, head) {
    if (!sessionOf(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const headers = { ...req.headers, host: target.host };
    const upstream = httpRequest({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 80,
      method: "GET",
      path: req.url,
      headers,
    });

    upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage ?? ""}`.trim()];
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead?.length) {
        upstreamSocket.unshift(upstreamHead);
      }
      if (head?.length) {
        upstreamSocket.write(head);
      }
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      upgradedSockets.add(socket);
      upgradedSockets.add(upstreamSocket);
      const drop = () => {
        upgradedSockets.delete(socket);
        upgradedSockets.delete(upstreamSocket);
        upstreamSocket.destroy();
        socket.destroy();
      };
      upstreamSocket.on("error", drop);
      socket.on("error", drop);
      upstreamSocket.on("close", drop);
      socket.on("close", drop);
    });

    upstream.on("error", (error) => {
      logger(`[auth] upgrade error: ${error.message}`);
      socket.destroy();
    });
    upstream.end();
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    const run = async () => {
      if (pathname === `${AUTH_PREFIX}/health`) {
        await handleAuth(req, res, url);
        return;
      }
      if (pathname === AUTH_PREFIX || pathname.startsWith(`${AUTH_PREFIX}/`)) {
        await handleAuth(req, res, url);
        return;
      }
      if (!sessionOf(req)) {
        redirect(res, `${AUTH_PREFIX}/login?next=${encodeURIComponent(req.url ?? "/")}`);
        return;
      }
      proxy(req, res);
    };

    run().catch((error) => {
      logger(`[auth] request failed: ${error.message}`);
      if (!res.headersSent) {
        html(res, 500, pages.messagePage({
          title: "Error",
          heading: "Something went wrong",
          message: "Reload the page and try again.",
        }));
      } else {
        res.end();
      }
    });
  });

  server.on("upgrade", handleUpgrade);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const actualPort = server.address().port;
  logger(`[auth] gateway listening on ${host}:${actualPort}, proxying to ${target.origin}`);

  return {
    server,
    port: actualPort,
    /** Exposed for tests and for a future "change password" flow. */
    key,
    close: () =>
      new Promise((resolve) => {
        for (const socket of upgradedSockets) {
          socket.destroy();
        }
        upgradedSockets.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
