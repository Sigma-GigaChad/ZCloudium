/**
 * An independent TOTP implementation for the suite.
 *
 * It is deliberately NOT imported from `gateway/lib/totp.mjs`: if the test used
 * the application's own generator, a bug in that generator would produce codes
 * the application accepts and the test would pass while the product is broken
 * for every real authenticator app. This file is written from RFC 4226 (HMAC
 * based one time passwords) and RFC 6238 (time based extension) instead, and
 * only from node:crypto.
 *
 * Parameters used by ZCloudium, taken from the otpauth:// URI the wizard
 * renders: SHA-1, 6 digits, a 30 second period.
 */

import { createHmac } from "node:crypto";

/** The parameters ZCloudium uses, taken from the otpauth:// URI the wizard renders. */
const ALGORITHM = "sha1";
const DIGITS = 6;
const PERIOD_SECONDS = 30;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const LOOKUP = new Map([...ALPHABET].map((char, index) => [char, index]));

/**
 * RFC 4648 base32, case insensitive, tolerating the blocks of four and the
 * spaces the wizard renders. Padding is accepted and ignored.
 */
export function base32Decode(value) {
  const normalized = String(value ?? "").replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let accumulator = 0;
  const bytes = [];
  for (const char of normalized) {
    const index = LOOKUP.get(char);
    if (index === undefined) {
      throw new Error(`not a base32 character: ${char}`);
    }
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bytes.length === 0) {
    throw new Error("the secret decodes to nothing");
  }
  return Buffer.from(bytes);
}

/** RFC 4226: the counter is a big endian 64 bit integer, truncated dynamically. */
export function hotp(secret, counter) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(ALGORITHM, key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const truncated =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(truncated % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** The step in progress: the counter RFC 6238 derives a code from. */
function currentStep(at = Date.now()) {
  return Math.floor(at / 1000 / PERIOD_SECONDS);
}

/** RFC 6238: the counter is the number of 30 second steps since the Unix epoch. */
export function totpAt(secret, at = Date.now()) {
  const step = currentStep(at);
  return { code: hotp(secret, step), step };
}

/** When the step in progress ends, in milliseconds since the epoch. */
function stepEndsAt(step) {
  return (step + 1) * PERIOD_SECONDS * 1000;
}

/**
 * A code the application has never accepted yet.
 *
 * TOTP replay protection is strict: a code whose step is not strictly greater
 * than the last accepted step is refused. Enrolling an account already spends a
 * code, so a sign in that follows immediately in the same 30 second window is
 * legitimately rejected. This waits for the next window instead of pretending
 * the rejection is a bug.
 *
 * `minRemainingSeconds` keeps the returned code usable for the whole of the spec
 * that follows: near the end of a window, the next one is used instead, so that
 * a code computed here and spent a few seconds later is still in its window and
 * a replay of it is rejected as a replay and not as an expired step.
 */
export async function nextUnusedCode(secret, { lastUsedStep, minRemainingSeconds = 12, at = Date.now() } = {}) {
  let moment = at;
  let { code, step } = totpAt(secret, moment);
  const spend = async (waitMs) => {
    await new Promise((resolve) => setTimeout(resolve, Math.max(waitMs, 0)));
    moment = Date.now();
    ({ code, step } = totpAt(secret, moment));
  };

  if (typeof lastUsedStep === "number" && step <= lastUsedStep) {
    await spend(stepEndsAt(lastUsedStep) - moment + 1500);
  }
  if (stepEndsAt(step) - moment < minRemainingSeconds * 1000) {
    await spend(stepEndsAt(step) - moment + 1500);
  }
  return { code, step };
}
