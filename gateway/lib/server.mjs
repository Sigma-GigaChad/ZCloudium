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
import { hashPassword, verifyPassword, checkPasswordStrength } from "./password.mjs";
import { generateSecret, otpauthUri, totp, verifyTotp } from "./totp.mjs";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  findUnusedRecoveryCode,
} from "./recovery.mjs";
import {
  DEFAULT_SESSION_TTL_MS,
  PENDING_LOGIN_COOKIE,
  PENDING_SETUP_COOKIE,
  SESSION_COOKIE,
  clearedCookie,
  loadOrCreateSessionKey,
  rotateSessionKey,
  parseCookies,
  pendingCookie,
  sessionCookie,
  signSession,
  verifySession,
} from "./session.mjs";
import {
  findUser,
  hasUsers,
  ownerOf,
  readFailures,
  readUsers,
  sessionKeyPath,
  writeFailures,
  writeUsers,
} from "./store.mjs";
import * as pages from "./pages.mjs";

const AUTH_PREFIX = "/_auth";
const ISSUER = "ZCloudium";

const PENDING_TTL_SECONDS = 600;
/**
 * Failed attempts allowed from one rate limit key before it is blocked, and how
 * long the block lasts. The limit applies to the password step, the code step,
 * the enrolment step and the password change, so a six digit second factor
 * cannot be walked through.
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

/**
 * The headers every page of the gateway's own carries.
 *
 * The pages are static html with inline styles, and exactly one inline script
 * (the copy button of the enrolment page), so the policy can be closed to
 * everything except that: `default-src 'none'`, inline styles, and the one
 * script by its sha256 hash. An injected script of any other shape, from any
 * other source, is refused by the browser rather than by us.
 */
function pageHeaders() {
  return {
    "content-security-policy":
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${pages.COPY_SCRIPT_SHA256}'; ` +
      "img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cache-control": "no-store",
  };
}

function html(res, status, body) {
  const buffer = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": buffer.length,
    ...pageHeaders(),
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

/**
 * The counters /_auth/metrics exposes. Plain increments: the page is for an
 * operator reading it, not for a dashboard that needs histograms, and every
 * number here is one the gateway already knows.
 */
function newCounters() {
  return {
    authFailures: 0,
    authBlocks: 0,
    sessionsIssued: 0,
    recoveryCodesUsed: 0,
    upstreamRequests: 0,
    upstreamDurationMs: 0,
  };
}

function metricsPage(counters) {
  const lines = [
    "# HELP gateway_auth_failures_total Failed authentication attempts, every step counted.",
    "# TYPE gateway_auth_failures_total counter",
    `gateway_auth_failures_total ${counters.authFailures}`,
    "# HELP gateway_auth_blocks_total Rate limit blocks applied.",
    "# TYPE gateway_auth_blocks_total counter",
    `gateway_auth_blocks_total ${counters.authBlocks}`,
    "# HELP gateway_sessions_issued_total Sessions issued by sign in and enrolment.",
    "# TYPE gateway_sessions_issued_total counter",
    `gateway_sessions_issued_total ${counters.sessionsIssued}`,
    "# HELP gateway_recovery_codes_used_total Recovery codes consumed at sign in.",
    "# TYPE gateway_recovery_codes_used_total counter",
    `gateway_recovery_codes_used_total ${counters.recoveryCodesUsed}`,
    "# HELP gateway_upstream_requests_total Requests proxied to the runtime.",
    "# TYPE gateway_upstream_requests_total counter",
    `gateway_upstream_requests_total ${counters.upstreamRequests}`,
    "# HELP gateway_upstream_duration_milliseconds_total Cumulative milliseconds spent proxying to the runtime.",
    "# TYPE gateway_upstream_duration_milliseconds_total counter",
    `gateway_upstream_duration_milliseconds_total ${counters.upstreamDurationMs}`,
  ];
  return `${lines.join("\n")}\n`;
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
  /**
   * The certificate to serve https with, when the deployment wants TLS terminated
   * here rather than by a proxy in front.
   *
   * `null` (the default) keeps the plain http listener this gateway has always
   * had. Everything else about the gateway is unaware of the difference: the
   * session cookie and the upgrade handling work the same over TLS, and
   * `req.socket.encrypted` is what the trust-proxy rules already read.
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

  let key = await loadOrCreateSessionKey(sessionKeyPath(dataDir));
  const target = new URL(upstreamUrl);
  const counters = newCounters();
  // The budget survives the process: a restarted container keeps the blocks and
  // the counts it had, which is the whole point of persisting it.
  const failures = new Map(Object.entries(await readFailures(dataDir)));
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

  /**
   * Persists the budget with every change, minus what has fully expired. A write
   * per failure is cheap (a map of a few keys) and keeps the file an exact
   * picture of what the gateway is enforcing.
   */
  const persistFailures = () => {
    const at = now();
    const remaining = {};
    for (const [address, entry] of failures) {
      if (entry.blockedUntil > at || entry.count > 0) {
        remaining[address] = entry;
      }
    }
    return writeFailures(dataDir, remaining);
  };

  const noteFailure = async (address) => {
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
      counters.authBlocks += 1;
      logger(`[auth] too many failures from ${address}, temporarily blocked`);
    }
    failures.set(address, entry);
    counters.authFailures += 1;
    await persistFailures();
  };
  const noteSuccess = (address) => {
    if (failures.delete(address)) {
      persistFailures().catch((error) => logger(`[auth] the failure budget could not be persisted: ${error.message}`));
    }
  };

  const cookiesOf = (req) => parseCookies(req.headers.cookie);
  const sessionOf = (req) => verifySession(cookiesOf(req)[SESSION_COOKIE], key, { at: now() });
  const pendingSetupOf = (req) =>
    verifySession(cookiesOf(req)[PENDING_SETUP_COOKIE], key, { at: now() });
  const pendingLoginOf = (req) =>
    verifySession(cookiesOf(req)[PENDING_LOGIN_COOKIE], key, { at: now() });

  /** A displayed sheet becomes a stored sheet: only the hashes persist. */
  const recoverySheetOf = (codes) =>
    (codes ?? []).map((code) => ({ hash: hashRecoveryCode(code), used: false }));

  /**
   * The enrolment page context of a pending setup: everything its account will
   * need, with the recovery codes that are shown exactly here.
   */
  const enrolmentContext = (pending) => ({
    secret: pending.totpSecret,
    uri: otpauthUri({ secret: pending.totpSecret, issuer: ISSUER, account: pending.username }),
    account: pending.username,
    recoveryCodes: pending.recoveryCodes,
  });

  async function handleAuth(req, res, url) {
    const { pathname } = url;
    const address = clientAddress(req);
    const users = await readUsers(dataDir);

    if (pathname === `${AUTH_PREFIX}/health`) {
      const buffer = Buffer.from("ok\n", "utf8");
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-length": buffer.length,
        "x-content-type-options": "nosniff",
      });
      res.end(buffer);
      return;
    }

    if (pathname === `${AUTH_PREFIX}/metrics`) {
      // Behind the session like everything else: the counters name no one, but
      // they describe an instance's authentication, which is not a stranger's
      // business.
      if (!sessionOf(req)) {
        redirect(res, `${AUTH_PREFIX}/login?next=${encodeURIComponent(pathname)}`);
        return;
      }
      const body = Buffer.from(metricsPage(counters), "utf8");
      res.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "content-length": body.length,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      res.end(body);
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
          await noteFailure(address);
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
        const typed = String(form.code ?? "");

        // A recovery code signs in once: it is the way back in when the
        // authenticator is lost. Six digits is never a recovery code, and a
        // recovery shape is never a TOTP code, so the order costs nothing.
        const result = verifyTotp(user.totpSecret, typed, {
          at: now(),
          lastStep: user.totpLastStep,
        });
        if (result.ok) {
          user.totpLastStep = result.step;
          await writeUsers(dataDir, users);
        } else if (looksLikeRecoveryCode(typed)) {
          const sheetIndex = findUnusedRecoveryCode(user.recoveryCodes, typed);
          if (sheetIndex !== null) {
            user.recoveryCodes[sheetIndex].used = true;
            await writeUsers(dataDir, users);
            counters.recoveryCodesUsed += 1;
            logger(`[auth] ${pending.user} signed in with a recovery code (${sheetIndex + 1} of the sheet used)`);
            noteSuccess(address);
            counters.sessionsIssued += 1;
            const session = signSession({ user: user.username, exp: now() + sessionTtlMs }, key);
            seeOther(res, safeNext(pending.next), [
              sessionCookie(session, { maxAgeSeconds: Math.floor(sessionTtlMs / 1000) }),
              clearedCookie(PENDING_LOGIN_COOKIE),
            ]);
            return;
          }
        }
        if (!result.ok) {
          await noteFailure(address);
          logger(`[auth] rejected two-factor code from ${address} (${result.reason})`);
          html(res, 401, pages.verifyPage({ error: "That code is not valid." }));
          return;
        }
        noteSuccess(address);
        counters.sessionsIssued += 1;

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

        // The first account owns the instance: it is the one that will be allowed
        // to create the others. The recovery codes travel in the pending cookie,
        // which is signed, HttpOnly and short lived; only their hashes persist.
        const pending = signSession(
          {
            username,
            password: await hashPassword(String(form.password)),
            totpSecret: generateSecret(),
            recoveryCodes: generateRecoveryCodes(),
            owner: true,
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
        html(res, 200, pages.setupTotpPage({ ...enrolmentContext(pending), error: url.searchParams.get("error") }));
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
          await noteFailure(address);
          html(res, 400, pages.setupTotpPage({
            ...enrolmentContext(pending),
            error: "That code is not valid. Check the clock on your device and try again.",
          }));
          return;
        }

        const fresh = (await readUsers(dataDir)) ?? { version: 1, users: {} };
        // The first-run wizard is exclusive: with an account present, the only
        // way in is the owner adding one from /_auth/users, which signs its
        // pending payload with createdBy. A pending cookie that claims neither
        // position honestly is refused.
        const createdByOwner =
          typeof pending.createdBy === "string" && findUser(fresh, pending.createdBy)?.owner === true;
        if (hasUsers(fresh) && !createdByOwner) {
          html(res, 409, pages.messagePage({
            title: "Already configured",
            heading: "This instance already has an account",
            message: "Setup runs once. Sign in with the existing credentials.",
          }));
          return;
        }
        if (findUser(fresh, pending.username)) {
          html(res, 409, pages.messagePage({
            title: "Name taken",
            heading: "That username already exists",
            message: "Go back and choose another name.",
          }));
          return;
        }
        fresh.users[pending.username] = {
          username: pending.username,
          password: pending.password,
          totpSecret: pending.totpSecret,
          totpLastStep: result.step,
          recoveryCodes: recoverySheetOf(pending.recoveryCodes),
          owner: pending.owner === true,
          createdAt: new Date().toISOString(),
        };
        await writeUsers(dataDir, fresh);
        logger(
          `[auth] account "${pending.username}" created${pending.owner === true ? " (owner)" : ""} with two-factor authentication`,
        );

        if (createdByOwner) {
          // The operator created this account on someone's behalf: no session is
          // issued for the new user here, because the browser in front of this
          // form belongs to the operator. The enrolment page carried the secret
          // and the recovery codes to relay.
          seeOther(res, `${AUTH_PREFIX}/users?created=${encodeURIComponent(pending.username)}`, [
            clearedCookie(PENDING_SETUP_COOKIE),
          ]);
          return;
        }
        counters.sessionsIssued += 1;
        const session = signSession({ user: pending.username, exp: now() + sessionTtlMs }, key);
        seeOther(res, "/", [
          sessionCookie(session, { maxAgeSeconds: Math.floor(sessionTtlMs / 1000) }),
          clearedCookie(PENDING_SETUP_COOKIE),
        ]);
        return;
      }
    }

    if (pathname === `${AUTH_PREFIX}/password`) {
      const session = sessionOf(req);
      if (!session) {
        redirect(res, `${AUTH_PREFIX}/login?next=${encodeURIComponent(`${AUTH_PREFIX}/password`)}`);
        return;
      }

      if (req.method === "GET") {
        html(res, 200, pages.passwordPage({ error: url.searchParams.get("error") }));
        return;
      }

      if (req.method === "POST") {
        // The current password is asked even to a signed-in operator, and a wrong
        // one costs a failure from the same budget as a wrong sign in: this route
        // changes the credentials, so it is guarded like the door it rekeys.
        if (blocked(address)) {
          html(res, 429, tooManyAttemptsPage());
          return;
        }
        const fresh = await readUsers(dataDir);
        const user = findUser(fresh, session.user);
        if (!user) {
          html(res, 401, pages.messagePage({
            title: "Unknown account",
            heading: "Sign in again",
            message: "This account no longer exists.",
          }));
          return;
        }
        const form = await readForm(req, maxBodyBytes);
        const currentOk = await verifyPassword(String(form.current ?? ""), user.password);
        if (!currentOk) {
          await noteFailure(address);
          logger(`[auth] wrong current password on the change form from ${address}`);
          html(res, 401, pages.passwordPage({ error: "The current password is not correct." }));
          return;
        }
        const problem = checkPasswordStrength(form.password, form.password2);
        if (problem) {
          html(res, 400, pages.passwordPage({ error: problem }));
          return;
        }
        user.password = await hashPassword(String(form.password));
        await writeUsers(dataDir, fresh);

        // Every session ends here, on purpose: a cookie stolen before the change
        // must not outlive it. The signing key rotates, old cookies stop
        // verifying, and the operator signs in again with the new password.
        key = await rotateSessionKey(sessionKeyPath(dataDir));
        logger(`[auth] password of "${session.user}" changed; every session ended`);
        seeOther(res, `${AUTH_PREFIX}/login?next=${encodeURIComponent("/")}`, [
          clearedCookie(SESSION_COOKIE),
          clearedCookie(PENDING_LOGIN_COOKIE),
          clearedCookie(PENDING_SETUP_COOKIE),
        ]);
        return;
      }
    }

    if (pathname === `${AUTH_PREFIX}/users`) {
      const session = sessionOf(req);
      if (!session) {
        redirect(res, `${AUTH_PREFIX}/login?next=${encodeURIComponent(`${AUTH_PREFIX}/users`)}`);
        return;
      }
      const fresh = await readUsers(dataDir);
      const owner = ownerOf(fresh);
      const isOwner = owner !== null && owner.name === session.user;

      if (req.method === "GET") {
        if (!isOwner) {
          html(res, 403, pages.messagePage({
            title: "Not allowed",
            heading: "Owner only",
            message: "Only the account that ran the first wizard manages accounts.",
          }));
          return;
        }
        html(res, 200, pages.usersPage({
          usernames: Object.keys(fresh.users),
          owner: owner.name,
          created: safeNext(url.searchParams.get("created")).slice(1) || null,
          error: url.searchParams.get("error"),
        }));
        return;
      }

      if (req.method === "POST") {
        if (!isOwner) {
          html(res, 403, pages.messagePage({
            title: "Not allowed",
            heading: "Owner only",
            message: "Only the account that ran the first wizard manages accounts.",
          }));
          return;
        }
        const form = await readForm(req, maxBodyBytes);
        const username = String(form.username ?? "").trim();
        const problem = checkPasswordStrength(form.password, form.password2);
        if (!username || problem) {
          seeOther(res, `${AUTH_PREFIX}/users?error=${encodeURIComponent(!username ? "A username is required." : problem)}`);
          return;
        }
        if (findUser(fresh, username)) {
          seeOther(res, `${AUTH_PREFIX}/users?error=${encodeURIComponent("That username already exists.")}`);
          return;
        }
        const pending = signSession(
          {
            username,
            password: await hashPassword(String(form.password)),
            totpSecret: generateSecret(),
            recoveryCodes: generateRecoveryCodes(),
            createdBy: session.user,
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
    const startedAt = now();

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
        counters.upstreamRequests += 1;
        counters.upstreamDurationMs += Math.max(0, now() - startedAt);
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      logger(`[auth] upstream error: ${error.message}`);
      if (!res.headersSent) {
        // A page rather than a bare string: the operator's browser then shows
        // something that explains itself and retries, instead of a raw
        // "Bad gateway" line that says nothing about what to do next.
        const body = Buffer.from(pages.badGatewayPage(), "utf8");
        res.writeHead(502, {
          "content-type": "text/html; charset=utf-8",
          "content-length": body.length,
          ...pageHeaders(),
        });
        res.end(body);
        return;
      }
      res.end();
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

  function handleUpgrade(req, socket, head) {
    if (!sessionOf(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const upstream = httpRequest({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 80,
      method: "GET",
      path: req.url,
      headers: { ...req.headers, host: target.host },
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

  const handler = (req, res) => {
    const url = requestUrl(req);
    const pathname = url.pathname;

    const run = async () => {
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
      }),
  };
}
