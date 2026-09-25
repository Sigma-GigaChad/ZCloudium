import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../gateway/lib/password.mjs";

test("a password verifies against its own hash", async () => {
  const record = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery staple", record), true);
});

test("a wrong password does not verify", async () => {
  const record = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("Correct horse battery staple", record), false);
  assert.equal(await verifyPassword("", record), false);
  assert.equal(await verifyPassword("correct horse battery stapl", record), false);
});

test("two hashes of the same password differ, because salts are unique", async () => {
  const a = await hashPassword("same password");
  const b = await hashPassword("same password");
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
});

test("the stored record never contains the plaintext and carries its parameters", async () => {
  const record = await hashPassword("a-very-recognisable-secret");
  assert.equal(JSON.stringify(record).includes("a-very-recognisable-secret"), false);
  assert.equal(record.algo, "scrypt");
  assert.equal(record.keylen, 64);
  assert.ok(record.N >= 16384, "scrypt cost should not be trivially low");
  assert.ok(record.r >= 8);
  assert.ok(record.p >= 1);
});

test("a corrupted or missing record fails closed instead of throwing", async () => {
  assert.equal(await verifyPassword("x", null), false);
  assert.equal(await verifyPassword("x", undefined), false);
  assert.equal(await verifyPassword("x", {}), false);
  assert.equal(await verifyPassword("x", { algo: "scrypt", salt: "!!", hash: "??" }), false);
  assert.equal(await verifyPassword("x", { algo: "md5", salt: "aa", hash: "bb" }), false);
});

test("verification rejects an empty stored hash", async () => {
  const record = await hashPassword("something");
  assert.equal(await verifyPassword("something", { ...record, hash: "" }), false);
});
