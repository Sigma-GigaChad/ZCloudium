/**
 * Recovery codes: the way back into an instance whose authenticator is lost.
 *
 * Without them, losing the phone that holds the TOTP secret means losing the
 * instance: the only recovery is deleting /data/auth, which reopens the window
 * where the first visitor owns everything. A sheet of one-time codes closes that
 * hole the same way every major service does it.
 *
 * The codes are random, not user chosen, so a plain SHA-256 is the right hash:
 * there is no entropy to stretch. They are stored hashed and single use. The
 * clear text exists only inside the wizard's pending window: the codes are
 * rendered on the enrolment page whenever the pending cookie is presented (up
 * to its ten minute life) and travel inside that signed, HttpOnly cookie;
 * outside that window, only the hashes exist.
 */

import { createHash, randomBytes } from "node:crypto";

/** How many codes a fresh sheet holds. */
export const RECOVERY_CODE_COUNT = 10;

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * One code: eight characters from an unambiguous alphabet (no 0/O, 1/I/L),
 * grouped in the middle the way humans copy them. 8 chars of 31-symbol alphabet
 * is about 40 bits: enough for a code that is verified against a sheet of ten,
 * online-rate-limited, and single use.
 */
export function generateRecoveryCode() {
  const bytes = randomBytes(8);
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    code += ALPHABET[bytes[index] % ALPHABET.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const codes = new Set();
  while (codes.size < count) {
    codes.add(generateRecoveryCode());
  }
  return [...codes];
}

/**
 * What the user typed, as the one canonical form: upper case, digits and
 * letters only, so "abcd wxyz", "abcd-wxyz" and "abcdwxyz" are the same code.
 */
export function normalizeRecoveryCode(raw) {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Whether a value could be a recovery code rather than a TOTP code, by shape.
 *
 * A TOTP code is exactly six digits. Anything else made of letters and digits,
 * long enough to be one of ours, is tried as a recovery code: the wrong guess
 * costs one failure against the same budget as a wrong password, so trying
 * shapes costs the attacker exactly what trying passwords costs.
 */
export function looksLikeRecoveryCode(raw) {
  const normalized = normalizeRecoveryCode(raw);
  return /^[A-Z0-9]{8}$/.test(normalized);
}

export function hashRecoveryCode(raw) {
  return createHash("sha256").update(normalizeRecoveryCode(raw)).digest("hex");
}

/**
 * Matches a typed value against a user's sheet, and marks the match used.
 *
 * Returns the index of the code that matched, or null. Single use is enforced
 * by the caller persisting the updated sheet; this function only decides.
 */
export function findUnusedRecoveryCode(sheet, raw) {
  if (!Array.isArray(sheet)) {
    return null;
  }
  const hash = hashRecoveryCode(raw);
  const index = sheet.findIndex((entry) => entry && entry.hash === hash && entry.used !== true);
  return index === -1 ? null : index;
}
