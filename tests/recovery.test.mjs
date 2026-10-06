/**
 * Recovery codes: the shape, the normalisation, and the single-use rule.
 *
 * The end to end path (a code signing in, the same code refused) is covered in
 * gateway.test.mjs against the running gateway; what is pinned here is the
 * arithmetic underneath, where a silent mistake would corrupt every sheet.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  RECOVERY_CODE_COUNT,
  findUnusedRecoveryCode,
  generateRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  normalizeRecoveryCode,
} from "../gateway/lib/recovery.mjs";

test("a code is eight unambiguous characters grouped in the middle", () => {
  for (let index = 0; index < 50; index += 1) {
    const code = generateRecoveryCode();
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/,
      `"${code}" must be two groups of four from the unambiguous alphabet`);
  }
});

test("a sheet holds the documented number of distinct codes", () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, RECOVERY_CODE_COUNT);
  assert.equal(new Set(codes).size, RECOVERY_CODE_COUNT, "a sheet with a duplicate is a shorter sheet");
  const again = generateRecoveryCodes();
  assert.notDeepEqual(codes.sort(), again.sort(), "two sheets must not be the same sheet");
});

test("normalisation erases everything a human might type around the code", () => {
  assert.equal(normalizeRecoveryCode("ABCD-WXYZ"), "ABCDWXYZ");
  assert.equal(normalizeRecoveryCode("abcd wxyz"), "ABCDWXYZ");
  assert.equal(normalizeRecoveryCode("  abcd-wxyz\n"), "ABCDWXYZ");
  assert.equal(normalizeRecoveryCode(""), "");
});

test("six digits is a TOTP code, eight alphanumerics is a recovery code", () => {
  assert.equal(looksLikeRecoveryCode("123456"), false, "a TOTP code must go to the TOTP path");
  assert.equal(looksLikeRecoveryCode(" 123456 "), false);
  assert.equal(looksLikeRecoveryCode("ABCDWXYZ"), true);
  assert.equal(looksLikeRecoveryCode("abcd-wxyz"), true);
  assert.equal(looksLikeRecoveryCode("ABCWXYZ"), false, "seven characters is neither");
  assert.equal(looksLikeRecoveryCode("ABCDWXYZ0"), false, "nine neither");
});

test("the hash is the hash of the normalised form, so spellings agree", () => {
  assert.equal(hashRecoveryCode("ABCD-WXYZ"), hashRecoveryCode("abcd wxyz"));
  assert.equal(hashRecoveryCode("ABCDWXYZ").length, 64);
  assert.notEqual(hashRecoveryCode("ABCDWXYZ"), hashRecoveryCode("ABCDWXYA"));
});

test("the sheet match returns one unused index, and skips what is used", () => {
  const sheet = [
    { hash: hashRecoveryCode("AAAA1111"), used: false },
    { hash: hashRecoveryCode("BBBB2222"), used: true },
    { hash: hashRecoveryCode("CCCC3333"), used: false },
  ];
  assert.equal(findUnusedRecoveryCode(sheet, "aaaa 1111"), 0, "spelling and case are normalised");
  assert.equal(findUnusedRecoveryCode(sheet, "BBBB-2222"), null, "a used code is not a way in");
  assert.equal(findUnusedRecoveryCode(sheet, "cccc3333"), 2);
  assert.equal(findUnusedRecoveryCode(sheet, "DDDD4444"), null);
  assert.equal(findUnusedRecoveryCode(null, "AAAA1111"), null, "an account from before the sheet existed");
  assert.equal(findUnusedRecoveryCode([], "AAAA1111"), null);
});
