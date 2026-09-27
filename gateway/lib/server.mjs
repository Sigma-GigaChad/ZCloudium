/**
 * The authentication gateway.
 *
 * It listens on the published port, owns the /_auth/* routes, and proxies
 * everything else to the ZCode server on loopback once a session is present.
 * It never imports application code, so an upstream update cannot break it.
 */

import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { createServer as createSecureServer } from "node:https";
import {
  classifyRoute,
  debugPathFor,
  isAcceptableOrigin,
  isDiscoveryPath,
  proxyAuthorityFor,
  rewriteDiscovery,
} from "./browser.mjs";
import { panelPage } from "./panel.mjs";
import { absoluteHttpUrl, createPageOwner } from "./page-owner.mjs";
import { injectAppScript } from "./app-script.mjs";
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
 * The body of the panel's viewport requests, as an object.
 *
 * It is read under the same limit as every other body, and anything that is not a
 * JSON object is refused rather than coerced: the only caller is the panel, and a
 * document that is not the one it sends is a caller that should not be here.
 */
async function readJson(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new Error("request body too large");
    }
    chunks.push(chunk);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the body must be a JSON object");
  }
  return parsed;
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
   * The browser debug endpoint, when there is one (Phase 0 of issue #5).
   *
   * With it set, `/_browser/...` is proxied to that port behind the session, and
   * the discovery documents are rewritten so the DevTools frontend connects back
   * through the gateway. Without it, the gateway does not know the browser exists:
   * `/_browser/...` is ordinary application traffic, which is what makes the off
   * switch total. It is only ever set to a port that is bound to loopback inside
   * the container, never one published to the host.
   */
  debugUrl = null,
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
  /**
   * Whether the gateway supplies the browser APIs an insecure origin withholds.
   *
   * On by default, because without it sending a file fails on any plain http
   * origin that is not localhost, which is exactly the deployment the README
   * describes as the common one (a container reached over a LAN or a VPN address).
   * On an https origin, and on localhost, the script it adds does nothing at all.
   */
  insecureHelpers = true,
  /**
   * The certificate to serve https with, when the deployment wants TLS terminated
   * here rather than by a proxy in front.
   *
   * `null` (the default) keeps the plain http listener this gateway has always
   * had. Everything else about the gateway is unaware of the difference: the
   * session cookie, the Origin rules and the upgrade handling work the same over
   * TLS, and `req.socket.encrypted` is what the trust-proxy rules already read.
   */
  tls = null,
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
  const browserEnabled = typeof debugUrl === "string" && debugUrl.trim() !== "";
  const debug = browserEnabled ? new URL(debugUrl) : null;
  /**
   * The owner of the emulated viewport (issue #9).
   *
   * Created here, once, and only when there is a browser to pose it on. It holds
   * a connection to the debug port for the life of the process, which is what
   * makes the operator's resolution outlive the panel: an application that came
   * and went cannot clear an override it does not own.
   */
  const pageOwner = browserEnabled ? createPageOwner({ debugUrl, logger }) : null;
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

  /**
   * Whether this request is the application's own document.
   *
   * The document is the one answer the gateway edits on its way through, so it is
   * the one answer that has to arrive uncompressed: a gzipped body cannot be
   * edited without decoding it, and decoding what the runtime sent is more of the
   * runtime's business than ours. Asking for identity is a standard, explicit
   * negotiation, and it is limited to the document.
   */
  function wantsDocument(req) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return false;
    }
    const accept = String(req.headers.accept ?? "");
    return accept.includes("text/html");
  }

  function proxy(req, res) {
    const headers = { ...req.headers, host: target.host };
    headers["x-forwarded-for"] = clientAddress(req);
    headers["x-forwarded-proto"] = req.socket.encrypted ? "https" : "http";
    delete headers["connection"];
    const document = insecureHelpers && wantsDocument(req);
    if (document) {
      headers["accept-encoding"] = "identity";
    }

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
        const type = String(response.headers["content-type"] ?? "");
        if (!document || !type.includes("text/html")) {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
          return;
        }
        // Buffered, because the script goes in before the closing body tag. The
        // document is a few kilobytes; anything else keeps streaming.
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.from(injectAppScript(Buffer.concat(chunks).toString("utf8")), "utf8");
          res.writeHead(response.statusCode ?? 502, {
            ...response.headers,
            "content-length": body.length,
            "cache-control": "no-store",
          });
          res.end(body);
        });
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

  /**
   * The request target, resolved against a Host header that may be anything at
   * all. It is attacker controlled and is only used to build a base for a
   * relative path, so a value that cannot be an authority falls back to a fixed
   * one instead of throwing out of a listener.
   */
  function requestUrl(req) {
    const raw = req.url ?? "/";
    try {
      return new URL(raw, `http://${req.headers.host ?? "localhost"}`);
    } catch {
      return new URL(raw.startsWith("/") ? raw : "/", "http://localhost");
    }
  }

  /**
   * Whether this request may use the browser route. See isAcceptableOrigin: the
   * session says who the caller is, the origin says it is this gateway's own
   * frontend and not a page served by another service on the same machine.
   *
   * `trustProxy` is passed through because it is the flag that already means "a
   * TLS terminating proxy I control is in front": it lets the https variant of
   * the request's own authority pass, which is what makes the panel usable in the
   * deployment README.md recommends. Nothing else about the check changes.
   */
  function originAcceptable(req) {
    return isAcceptableOrigin(req.headers.origin, req.headers.host, {
      secure: Boolean(req.socket.encrypted),
      trustProxy,
    });
  }

  function refuseForeignOrigin(req, socket, path) {
    logger(
      `[auth] refusing a browser request with a foreign Origin: ${JSON.stringify(req.headers.origin)} ` +
        `for ${path} (the gateway serves its own frontend on ${JSON.stringify(req.headers.host)})`,
    );
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }

  /**
   * The operator panel, served by the gateway itself (issue #5, Phase 1).
   *
   * It lives at the browser prefix root because that is the one path of the two
   * halves that must be ours: the panel is the page that owns the live view and
   * the viewport control, while everything below the prefix goes to Chromium. It
   * carries the same Origin rule as the proxy, because it is the page that opens
   * the control channel, and the session is checked before this function is
   * reached, like every other path.
   *
   * The page holds no secret: it is static HTML. What it reaches, once it is open
   * in the operator's browser, is the agent's browser.
   */
  function servePanel(req, res, url) {
    if (!originAcceptable(req)) {
      logger(
        `[auth] refusing a browser request with a foreign Origin: ${JSON.stringify(req.headers.origin)} ` +
          `for ${url.pathname}`,
      );
      res.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("Forbidden");
      return;
    }
    const body = Buffer.from(panelPage(), "utf8");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": body.length,
      "cache-control": "no-store",
    });
    res.end(body);
  }

  /** A failure the panel endpoint answers as is, with the status it deserves. */
  function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
  }

  /**
   * The shape every panel endpoint has: this gateway's own frontend, the panel on,
   * a POST, and a small JSON document in and out.
   *
   * Shared rather than copied because the interesting part of these routes is the
   * rule they enforce, and two copies of a rule drift apart. The handler receives
   * the parsed body and answers an object; it throws to be reported, with a
   * `status` when the request itself was wrong.
   */
  async function panelEndpoint(req, res, { name, handle }) {
    if (!originAcceptable(req)) {
      logger(
        `[auth] refusing a browser request with a foreign Origin: ${JSON.stringify(req.headers.origin)} ` +
          `for the ${name} endpoint`,
      );
      res.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("Forbidden");
      return;
    }
    if (!pageOwner) {
      // Unreachable through classifyRoute, which only answers for these routes
      // when the panel is on. Kept because it is the honest answer if that ever
      // changes.
      res.writeHead(503, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("The browser panel is off");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST", "content-type": "text/plain", "cache-control": "no-store" });
      res.end("Method not allowed");
      return;
    }

    let answer;
    try {
      answer = await handle(await readJson(req, maxBodyBytes));
    } catch (error) {
      // 502 by default: the gateway is fine, the browser it was asked to drive is
      // not. The panel shows the message, which is the only diagnostic the
      // operator gets.
      logger(`[${name}] ${req.method} failed: ${error.message}`);
      res.writeHead(Number.isInteger(error.status) ? error.status : 502, {
        "content-type": "text/plain",
        "cache-control": "no-store",
      });
      res.end(error.message);
      return;
    }

    const payload = Buffer.from(JSON.stringify(answer ?? {}), "utf8");
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": payload.length,
      "cache-control": "no-store",
    });
    res.end(payload);
  }

  /**
   * The resolution the panel asks for (issue #9).
   *
   * This is where the fix for the viewport lifetime lives, seen from the panel's
   * side: the operator's Apply button used to pose an override on the panel's own
   * session, and Chromium 154 clears an override when the session that posed it
   * detaches, which is what closing the panel did. The panel now asks the gateway,
   * which poses it on a session that never detaches.
   *
   * Three modes, one per thing the panel does:
   *
   * - `apply` poses the numbers the operator typed, and re-sends them even when
   *   they are the ones already in force, because an override can be replaced by
   *   anything else talking to the same browser;
   * - `attach` is sent when the panel opens on a target, and puts a size the
   *   operator already chose back when it drifted. It is what makes reopening the
   *   pane find the state intact;
   * - `release` stops forcing a target the panel has moved away from, without
   *   touching that page: it keeps whatever size it has.
   */
  function serveViewport(req, res) {
    return panelEndpoint(req, res, {
      name: "viewport",
      handle: (body) => {
        const targetId = typeof body.targetId === "string" && body.targetId !== "" ? body.targetId : null;
        if (body.mode === "apply") {
          return pageOwner.apply({ targetId, width: body.width, height: body.height });
        }
        if (body.mode === "attach") {
          return pageOwner.attach({ targetId });
        }
        if (body.mode === "release") {
          return pageOwner.release({ targetId });
        }
        throw httpError(400, `unknown viewport mode: ${JSON.stringify(body.mode)}`);
      },
    });
  }

  /**
   * The page the panel drives: its address bar, and the three history buttons.
   *
   * The address is validated here rather than in the owner, so a typo answers 400
   * with the sentence the panel shows, while a browser that fails to load a valid
   * address answers 502. `absoluteHttpUrl` is the same function the owner checks
   * with, so the two cannot disagree about what an address is.
   */
  function servePage(req, res) {
    return panelEndpoint(req, res, {
      name: "page",
      handle: (body) => {
        const targetId = typeof body.targetId === "string" && body.targetId !== "" ? body.targetId : null;
        if (body.mode === "navigate") {
          const url = absoluteHttpUrl(body.url);
          if (url === null) {
            throw httpError(400, "only http and https addresses can be opened in the panel");
          }
          return pageOwner.navigate({ targetId, url });
        }
        if (body.mode === "back" || body.mode === "forward" || body.mode === "reload") {
          return pageOwner.history({ targetId, direction: body.mode });
        }
        throw httpError(400, `unknown page mode: ${JSON.stringify(body.mode)}`);
      },
    });
  }

  /**
   * The debug port, behind the session (Phase 0 of issue #5).
   *
   * Two things have to change on the way through, and both are Chromium's own
   * defences rather than ours:
   *
   * - the Host header becomes the loopback authority, because Chromium answers
   *   500 to any Host that is not an IP address or localhost;
   * - the Origin header is dropped, because Chromium refuses a WebSocket
   *   handshake carrying an Origin it did not generate.
   *
   * The security check on the Origin is not the deletion, it is `originAcceptable`
   * above: only a request that arrived as this gateway's own frontend gets this
   * far, so deleting the header on the last hop removes nothing that was still
   * protecting anything.
   *
   * The discovery documents are the reason a proxy is needed at all: they name
   * `ws://127.0.0.1:9222/...`, which only resolves on the machine the container
   * runs on. They are rewritten to point back at the gateway origin the frontend
   * was served from, which its own `connect-src 'self'` then allows.
   */
  function proxyBrowser(req, res, url) {
    if (!originAcceptable(req)) {
      logger(
        `[auth] refusing a browser request with a foreign Origin: ${JSON.stringify(req.headers.origin)} ` +
          `for ${url.pathname}`,
      );
      res.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("Forbidden");
      return;
    }

    const authority = proxyAuthorityFor(req.headers.host);
    if (authority === null) {
      // The Host header ends up inside the document the frontend reads, so a
      // value that is not an authority is refused rather than echoed.
      logger(`[auth] refusing a browser request with an unusable Host header: ${JSON.stringify(req.headers.host)}`);
      res.writeHead(400, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("Bad request");
      return;
    }

    const debugPathname = debugPathFor(url.pathname);
    const upstream = httpRequest(
      {
        protocol: debug.protocol,
        hostname: debug.hostname,
        port: debug.port || 80,
        method: req.method,
        path: `${debugPathname}${url.search}`,
        headers: debugHeaders(req),
      },
      (response) => {
        const encoding = response.headers["content-encoding"];
        if (!isDiscoveryPath(debugPathname) || (encoding && encoding !== "identity")) {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
          return;
        }
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const rewritten = rewriteDiscovery(Buffer.concat(chunks).toString("utf8"), {
            authority: debug.host,
            proxyAuthority: authority,
          });
          res.writeHead(response.statusCode ?? 502, {
            ...response.headers,
            "content-length": Buffer.byteLength(rewritten),
            "cache-control": "no-store",
          });
          res.end(rewritten);
        });
      },
    );
    upstream.on("error", (error) => {
      logger(`[auth] browser upstream error: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain", "cache-control": "no-store" });
      }
      res.end("Bad gateway");
    });
    req.pipe(upstream);
  }

  /**
   * The headers the debug port is asked with: the loopback Host, and no Origin.
   *
   * The removal is interoperability, not the security check: Chromium refuses a
   * handshake carrying an Origin it did not generate, and by this point the
   * request comes from the gateway. What keeps a foreign page out is
   * `originAcceptable` in proxyBrowser and handleUpgrade.
   */
  function debugHeaders(req) {
    const headers = { ...req.headers, host: debug.host };
    delete headers.origin;
    return headers;
  }

  function handleUpgrade(req, socket, head) {
    if (!sessionOf(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const url = requestUrl(req);
    const route = classifyRoute(url.pathname, { browserEnabled });
    if (route === "panel" || route === "viewport" || route === "page") {
      // None is a socket: the panel is a page, and the other two endpoints are
      // plain JSON. There is nothing at those paths to upgrade to, and they must
      // not fall through to the application either.
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const browserRoute = route === "browser";
    if (browserRoute && proxyAuthorityFor(req.headers.host) === null) {
      logger(`[auth] refusing a browser upgrade with an unusable Host header: ${JSON.stringify(req.headers.host)}`);
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (browserRoute && !originAcceptable(req)) {
      refuseForeignOrigin(req, socket, url.pathname);
      return;
    }

    const upstreamUrl = browserRoute ? debug : target;
    const headers = browserRoute
      ? debugHeaders(req)
      : { ...req.headers, host: target.host };
    const upstream = httpRequest({
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || 80,
      method: "GET",
      path: browserRoute ? `${debugPathFor(url.pathname)}${url.search}` : req.url,
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

    /**
     * The debug port answered a plain HTTP response instead of upgrading, which is
     * what it does when the target is not there any more (a tab closed under the
     * operator, a target id a browser kept in its history). Passing that answer on
     * is the difference between an error the operator can read and a socket that
     * hangs until the browser gives up, so the status line, the headers and the body
     * all travel back and the socket is then closed.
     *
     * Scoped to the browser route on purpose. The application's own upgrade path is
     * not this gateway's to change: with the panel off, and on every path that is
     * not `/_browser/...` with it on, an answer the runtime gives to an upgrade is
     * left exactly where it was, which is what keeps "off means unchanged" true of
     * the application's WebSocket.
     */
    if (browserRoute) {
      upstream.on("response", (response) => {
        const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage ?? ""}`.trim()];
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
        }
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
        // The same guard as the handshake path, and for the same reason: the
        // operator can go away in the middle of the body, and an unhandled reset on
        // either side of the relay is an uncaught error that would take the gateway
        // down with it.
        const drop = () => {
          response.destroy();
          socket.destroy();
        };
        socket.on("error", drop);
        socket.on("close", drop);
        response.on("error", drop);
        response.pipe(socket);
        response.on("end", () => socket.end());
      });
    }

    upstream.on("error", (error) => {
      logger(`[auth] upgrade error: ${error.message}`);
      socket.destroy();
    });
    upstream.end();
  }

  const handler = (req, res) => {
    const url = requestUrl(req);
    const pathname = url.pathname;

    const run = async () => {
      const route = classifyRoute(pathname, { browserEnabled });
      if (route === "auth") {
        await handleAuth(req, res, url);
        return;
      }
      if (!sessionOf(req)) {
        redirect(res, `${AUTH_PREFIX}/login?next=${encodeURIComponent(req.url ?? "/")}`);
        return;
      }
      if (route === "panel") {
        servePanel(req, res, url);
        return;
      }
      if (route === "viewport") {
        await serveViewport(req, res);
        return;
      }
      if (route === "page") {
        await servePage(req, res);
        return;
      }
      if (route === "browser") {
        proxyBrowser(req, res, url);
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
  };

  // The only difference between the two: who terminates the connection. The
  // handler, the sockets it tracks and the upgrade path below are shared.
  const server = tls ? createSecureServer({ cert: tls.cert, key: tls.key }, handler) : createServer(handler);

  server.on("upgrade", handleUpgrade);

  /**
   * Every socket the server accepted, tracked here rather than trusted to Node.
   *
   * `server.closeAllConnections()` is not enough for this gateway: when a request
   * is upgraded, Node stops tracking that socket as a connection, so a socket that
   * was never read (an upgrade the gateway answers with nothing, which is what an
   * application route does when the runtime answers with a page instead of a
   * handshake) stays open, keeps `server.close()` from ever resolving, and would
   * hold a container's graceful shutdown until the SIGKILL. Destroying what was
   * accepted here covers it.
   */
  const connections = new Set();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const actualPort = server.address().port;
  logger(
    `[auth] gateway listening on ${tls ? "https" : "http"}://${host}:${actualPort}, proxying to ${target.origin}`,
  );

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
        for (const socket of connections) {
          socket.destroy();
        }
        connections.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
        // The viewport owner holds a connection of its own: closing it detaches
        // from the browser and leaves Chromium running, which is the runtime's
        // browser, not the gateway's.
        pageOwner?.close().catch((error) => logger(`[viewport] closing failed: ${error.message}`));
      }),
  };
}
