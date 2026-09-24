import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const COOKIE_NAME = "zc_sess";
const SETUP_COOKIE = "zc_setup";
const LOGIN_COOKIE = "zc_login";
export const SESSION_COOKIE = COOKIE_NAME;
export const PENDING_SETUP_COOKIE = SETUP_COOKIE;
export const PENDING_LOGIN_COOKIE = LOGIN_COOKIE;

/**
 * Twelve hours. This is the window during which a stolen cookie stays usable,
 * so it is deliberately short: the port can front an agent that runs with root
 * on the host in the full access profile. Raise it with
 * ZCLOUDIUM_SESSION_TTL_HOURS, and know what that extends.
 */
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function createSessionKey() {
  return randomBytes(32);
}

/** Reads the signing key from disk, creating it with restrictive permissions if absent. */
export async function loadOrCreateSessionKey(filePath) {
  try {
    const existing = await readFile(filePath);
    if (existing.length === 32) {
      return existing;
    }
  } catch {
    // Missing key: fall through and create one.
  }
  const key = createSessionKey();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, key, { mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => {});
  return key;
}

function sign(body, key) {
  return createHmac("sha256", key).update(body).digest("base64url");
}

export function signSession(payload, key) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, key)}`;
}

/** Returns the payload, or null for anything that is not provably ours and unexpired. */
export function verifySession(value, key, { at = Date.now() } = {}) {
  if (typeof value !== "string") {
    return null;
  }
  const parts = value.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [body, signature] = parts;
  if (!body || !signature) {
    return null;
  }

  const expected = Buffer.from(sign(body, key));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp <= at) {
    return null;
  }
  return payload;
}

export function serializeCookie(name, value, options = {}) {
  const { maxAge, httpOnly = false, sameSite, path = "/", secure = false } = options;
  const parts = [`${name}=${value}`, `Path=${path}`];
  if (typeof maxAge === "number") {
    parts.push(`Max-Age=${maxAge}`);
  }
  if (httpOnly) {
    parts.push("HttpOnly");
  }
  if (sameSite) {
    parts.push(`SameSite=${sameSite}`);
  }
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

/**
 * Session and pending cookies are HttpOnly and SameSite=Lax. Lax is the CSRF
 * defence here: a cross-site POST never carries them, and every state-changing
 * route is a POST.
 */
export function sessionCookie(value, { maxAgeSeconds = DEFAULT_SESSION_TTL_MS / 1000 } = {}) {
  return serializeCookie(COOKIE_NAME, value, {
    maxAge: maxAgeSeconds,
    httpOnly: true,
    sameSite: "Lax",
  });
}

export function pendingCookie(name, value, maxAgeSeconds = 600) {
  return serializeCookie(name, value, {
    maxAge: maxAgeSeconds,
    httpOnly: true,
    sameSite: "Lax",
  });
}

export function clearedCookie(name) {
  return serializeCookie(name, "", { maxAge: 0, httpOnly: true, sameSite: "Lax" });
}

export function parseCookies(header) {
  const result = {};
  if (typeof header !== "string" || header.length === 0) {
    return result;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (!name) {
      continue;
    }
    result[name] = part.slice(separator + 1).trim();
  }
  return result;
}
