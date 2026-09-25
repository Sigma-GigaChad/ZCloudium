import test from "node:test";
import assert from "node:assert/strict";
import {
  base32Decode,
  base32Encode,
  hotp,
  totp,
  verifyTotp,
  generateSecret,
} from "../gateway/lib/totp.mjs";

// The RFC 6238 / RFC 4226 reference secret, as ASCII and as base32.
const RFC_SECRET_ASCII = "12345678901234567890";
const RFC_SECRET_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const RFC_KEY = Buffer.from(RFC_SECRET_ASCII, "ascii");

test("base32 encode and decode round trip", () => {
  assert.equal(base32Encode(RFC_KEY), RFC_SECRET_BASE32);
  assert.deepEqual(base32Decode(RFC_SECRET_BASE32), RFC_KEY);
});

test("base32 decoding tolerates spaces, padding and lower case", () => {
  assert.deepEqual(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq"), RFC_KEY);
  assert.deepEqual(base32Decode(`${RFC_SECRET_BASE32}====`), RFC_KEY);
  assert.deepEqual(base32Decode("GEZD GNBV GY3T QOJQ"), Buffer.from("1234567890", "ascii"));
});

test("HOTP matches the RFC 4226 appendix D vectors", () => {
  const expected = [
    "755224", "287082", "359152", "969429", "338314",
    "254676", "287922", "162583", "399871", "520489",
  ];
  expected.forEach((code, counter) => {
    assert.equal(hotp(RFC_KEY, counter), code, `counter ${counter}`);
  });
});

test("TOTP matches the RFC 6238 appendix B vectors", () => {
  const vectors = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [seconds, expected] of vectors) {
    assert.equal(totp(RFC_KEY, { at: seconds * 1000, digits: 8 }), expected, `t=${seconds}`);
  }
});

test("verifyTotp accepts the current step and one step of drift", () => {
  const secret = generateSecret();
  const at = 1_700_000_000_000;
  const code = totp(secret, { at });
  assert.equal(verifyTotp(secret, code, { at }).ok, true);
  assert.equal(verifyTotp(secret, code, { at: at + 30_000 }).ok, true);
  assert.equal(verifyTotp(secret, code, { at: at - 30_000 }).ok, true);
});

test("verifyTotp rejects a code outside the drift window", () => {
  const secret = generateSecret();
  const at = 1_700_000_000_000;
  const code = totp(secret, { at });
  assert.equal(verifyTotp(secret, code, { at: at + 90_000 }).ok, false);
  assert.equal(verifyTotp(secret, code, { at: at - 90_000 }).ok, false);
});

test("verifyTotp rejects malformed codes", () => {
  const secret = generateSecret();
  for (const bad of ["", "12345", "1234567", "abcdef", "12 34 56", undefined, null]) {
    assert.equal(verifyTotp(secret, bad).ok, false, `input ${JSON.stringify(bad)}`);
  }
});

test("verifyTotp rejects a replayed step and reports why", () => {
  const secret = generateSecret();
  const at = 1_700_000_000_000;
  const code = totp(secret, { at });

  const first = verifyTotp(secret, code, { at });
  assert.equal(first.ok, true);
  assert.equal(typeof first.step, "number");

  const second = verifyTotp(secret, code, { at, lastStep: first.step });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "replayed");
});

test("verifyTotp still accepts the next step after a use", () => {
  const secret = generateSecret();
  const at = 1_700_000_000_000;
  const first = verifyTotp(secret, totp(secret, { at }), { at });
  const later = verifyTotp(secret, totp(secret, { at: at + 30_000 }), {
    at: at + 30_000,
    lastStep: first.step,
  });
  assert.equal(later.ok, true);
});

test("generateSecret returns a decodable secret of the expected size", () => {
  const secret = generateSecret();
  assert.match(secret, /^[A-Z2-7]+$/);
  assert.equal(base32Decode(secret).length, 20);
  assert.notEqual(generateSecret(), generateSecret());
});

test("totp accepts a base32 secret and a raw buffer interchangeably", () => {
  const at = 1_700_000_000_000;
  assert.equal(totp(RFC_SECRET_BASE32, { at }), totp(RFC_KEY, { at }));
});
