import test from "node:test";
import assert from "node:assert/strict";
import {
  createSessionKey,
  signSession,
  verifySession,
  serializeCookie,
  parseCookies,
} from "../gateway/lib/session.mjs";

const KEY = Buffer.alloc(32, 7);
const AT = 1_700_000_000_000;

test("a signed session verifies and round trips its payload", () => {
  const value = signSession({ user: "delta", exp: AT + 1000 }, KEY);
  const payload = verifySession(value, KEY, { at: AT });
  assert.equal(payload.user, "delta");
});

test("a tampered payload is rejected", () => {
  const value = signSession({ user: "delta", exp: AT + 1000 }, KEY);
  const signature = value.split(".").pop();
  const forged = Buffer.from(JSON.stringify({ user: "root", exp: AT + 1000 })).toString("base64url");
  assert.equal(verifySession(`${forged}.${signature}`, KEY, { at: AT }), null);
});

test("a tampered signature is rejected", () => {
  const value = signSession({ user: "delta", exp: AT + 1000 }, KEY);
  const body = value.split(".").shift();
  const wrongSignature = Buffer.alloc(32, 1).toString("base64url");
  assert.equal(verifySession(`${body}.${wrongSignature}`, KEY, { at: AT }), null);
});

test("a session signed with another key is rejected", () => {
  const value = signSession({ user: "delta", exp: AT + 1000 }, Buffer.alloc(32, 9));
  assert.equal(verifySession(value, KEY, { at: AT }), null);
});

test("an expired session is rejected", () => {
  const value = signSession({ user: "delta", exp: AT - 1 }, KEY);
  assert.equal(verifySession(value, KEY, { at: AT }), null);
});

test("malformed values are rejected without throwing", () => {
  for (const bad of ["", "x", "x.y", "....", "a.b.c", null, undefined, 42]) {
    assert.equal(verifySession(bad, KEY, { at: AT }), null, `input ${JSON.stringify(bad)}`);
  }
});

test("createSessionKey returns a stable, sufficiently long key", async () => {
  const first = await createSessionKey();
  const second = await createSessionKey();
  assert.equal(first.length, 32);
  assert.notDeepEqual(first, second);
});

test("cookies serialize with the attributes we rely on", () => {
  const header = serializeCookie("zc_sess", "a.b", {
    maxAge: 60,
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
  });
  assert.match(header, /^zc_sess=a\.b/);
  assert.match(header, /Path=\//);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Max-Age=60/);
});

test("clearing a cookie sets an immediate expiry", () => {
  const header = serializeCookie("zc_sess", "", { maxAge: 0 });
  assert.match(header, /Max-Age=0/);
});

test("cookie headers parse into a map", () => {
  assert.deepEqual(parseCookies("a=1; zc_sess=x.y; b=2"), { a: "1", zc_sess: "x.y", b: "2" });
  assert.deepEqual(parseCookies(""), {});
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies("broken; =nokey; ok=1"), { ok: "1" });
});
