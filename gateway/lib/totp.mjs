import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE32_LOOKUP = new Map([...BASE32_ALPHABET].map((char, index) => [char, index]));

/** Lowercase, strips spaces and padding, rejects anything else. */
function normalizeBase32(value) {
  return String(value ?? "").replace(/[\s=]/g, "").toUpperCase();
}

export function base32Encode(buffer) {
  const bytes = Buffer.from(buffer);
  let bits = 0;
  let accumulator = 0;
  let output = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(accumulator >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(value) {
  const normalized = normalizeBase32(value);
  if (normalized.length === 0) {
    return Buffer.alloc(0);
  }
  let bits = 0;
  let accumulator = 0;
  const output = [];
  for (const char of normalized) {
    const index = BASE32_LOOKUP.get(char);
    if (index === undefined) {
      throw new Error(`Invalid base32 character: ${char}`);
    }
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((accumulator >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function toKey(secret) {
  if (Buffer.isBuffer(secret)) {
    return secret;
  }
  return base32Decode(secret);
}

/** 20 random bytes, base32 encoded: the size recommended for SHA-1 TOTP. */
export function generateSecret(bytes = 20) {
  return base32Encode(randomBytes(bytes));
}

/** RFC 4226. */
export function hotp(key, counter, { digits = 6 } = {}) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", toKey(key)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** RFC 6238. */
export function totp(secret, { at = Date.now(), step = 30, digits = 6 } = {}) {
  return hotp(secret, Math.floor(at / 1000 / step), { digits });
}

/**
 * Verifies a code with a symmetric drift window.
 *
 * Pass `lastStep` (the step of the last accepted code for this user) to make
 * replay impossible: a code whose step is not strictly greater is refused.
 *
 * Returns { ok: true, step } or { ok: false, reason }.
 */
export function verifyTotp(
  secret,
  code,
  { at = Date.now(), step = 30, digits = 6, window = 1, lastStep } = {},
) {
  const candidate = typeof code === "string" ? code.trim() : "";
  if (!new RegExp(`^\\d{${digits}}$`).test(candidate)) {
    return { ok: false, reason: "malformed" };
  }

  const key = toKey(secret);
  const currentStep = Math.floor(at / 1000 / step);
  const expected = Buffer.from(candidate);

  for (let drift = -window; drift <= window; drift += 1) {
    const candidateStep = currentStep + drift;
    if (candidateStep < 0) {
      continue;
    }
    const actual = Buffer.from(hotp(key, candidateStep, { digits }));
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
      if (typeof lastStep === "number" && candidateStep <= lastStep) {
        return { ok: false, reason: "replayed" };
      }
      return { ok: true, step: candidateStep };
    }
  }

  return { ok: false, reason: "mismatch" };
}

/** The otpauth:// URI an authenticator app expects. */
export function otpauthUri({ secret, issuer = "ZCloudium", account }) {
  const label = encodeURIComponent(`${issuer}:${account ?? ""}`);
  const params = new URLSearchParams({
    secret: normalizeBase32(secret),
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
