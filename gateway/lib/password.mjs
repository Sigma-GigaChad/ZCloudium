import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

/** Cost chosen so a single verification stays well under 200ms on a small VM. */
export const DEFAULT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

const MAX_MEM = 256 * 1024 * 1024;

export async function hashPassword(password, params = DEFAULT_PARAMS) {
  const salt = randomBytes(32);
  const derived = await scrypt(String(password), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAX_MEM,
  });
  return {
    algo: "scrypt",
    N: params.N,
    r: params.r,
    p: params.p,
    keylen: params.keylen,
    salt: salt.toString("base64"),
    hash: Buffer.from(derived).toString("base64"),
  };
}

/** Fails closed: any malformed or unrecognised record is a rejection, never a throw. */
export async function verifyPassword(password, record) {
  if (!record || typeof record !== "object" || record.algo !== "scrypt") {
    return false;
  }
  try {
    const salt = Buffer.from(String(record.salt ?? ""), "base64");
    const expected = Buffer.from(String(record.hash ?? ""), "base64");
    if (salt.length === 0 || expected.length === 0) {
      return false;
    }
    const derived = Buffer.from(
      await scrypt(String(password), salt, expected.length, {
        N: Number(record.N) || DEFAULT_PARAMS.N,
        r: Number(record.r) || DEFAULT_PARAMS.r,
        p: Number(record.p) || DEFAULT_PARAMS.p,
        maxmem: MAX_MEM,
      }),
    );
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export const MIN_PASSWORD_LENGTH = 12;

export function checkPasswordStrength(password, confirmation) {
  const value = typeof password === "string" ? password : "";
  if (value.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (value !== confirmation) {
    return "The two passwords do not match.";
  }
  return null;
}
