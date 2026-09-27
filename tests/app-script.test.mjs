/**
 * The script the gateway adds to the application's document.
 *
 * The interesting half is the SHA-256 it provides: a wrong implementation would
 * be worse than the fault it replaces, because the attachment would be uploaded
 * and then refused, or stored wrong. So the hash is checked against Node's own
 * implementation, on inputs chosen for the cases that break implementations: the
 * empty message, the block boundary, more than one block, and non ASCII bytes.
 * And the script is run the way the page runs it, in a context where
 * `crypto.subtle` is absent, because that is the only case where it does anything.
 *
 * The other half is the injection: the document must come out as it went in when
 * there is nothing to do, and twice through must not double the block.
 */

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { appScript, injectAppScript } from "../gateway/lib/app-script.mjs";

/** The script, run in a context without crypto.subtle, the way an insecure page gets it. */
function insecurePage({ crypto = { getRandomValues: () => {} } } = {}) {
  const context = {
    globalThis: null,
    Crypto: class Crypto {},
    ArrayBuffer,
    Uint8Array,
    Uint32Array,
    DataView,
    Math,
    Promise,
    Error,
    TypeError,
    String,
    Object,
  };
  context.globalThis = context;
  // A real page's crypto is an instance of the platform's Crypto, not a plain
  // object, so the harness gives it one too.
  context.crypto = Object.assign(new context.Crypto(), crypto);
  vm.createContext(context);
  vm.runInContext(appScript(), context);
  return context;
}

/** What the page's `crypto.subtle.digest` answers for some bytes, as hex. */
async function digestOf(context, bytes, algorithm = "SHA-256") {
  const buffer = await context.crypto.subtle.digest(algorithm, bytes);
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What Node answers for the same bytes, which is what the test compares against. */
const expected = (bytes) => createHash("sha256").update(Buffer.from(bytes)).digest("hex");

test("the SHA-256 agrees with the reference implementation, boundary cases included", async () => {
  const page = insecurePage();
  assert.equal(typeof page.crypto.subtle, "object", "the script must define what the browser withheld");

  const cases = {
    "the empty message": new Uint8Array(),
    "one byte": new Uint8Array([0x61]),
    "the published abc vector": new TextEncoder().encode("abc"),
    // 55 bytes fits one block with room for the padding; 56 is where the padding
    // has to spill into a second block, which is the classic off by one.
    "the padding boundary": new TextEncoder().encode("a".repeat(55)),
    "one byte past the boundary": new TextEncoder().encode("a".repeat(56)),
    "two blocks exactly": new TextEncoder().encode("a".repeat(64)),
    "more than two blocks": new TextEncoder().encode("Le renard brun saute par dessus le chien paresseux, et recommence."),
    "non ASCII bytes": new TextEncoder().encode("ete, cafe, garcon, accents graves et aigus: e e e a a a"),
    "a long message": new TextEncoder().encode("x".repeat(200_000)),
  };
  for (const [what, bytes] of Object.entries(cases)) {
    assert.equal(await digestOf(page, bytes), expected(bytes), what);
  }
  // The vector everybody quotes, so the comparison itself is anchored.
  assert.equal(
    await digestOf(page, new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("the script does nothing where crypto.subtle already exists", () => {
  const real = { subtle: { digest: () => Promise.resolve(new ArrayBuffer(32)) } };
  const page = insecurePage({ crypto: real });
  assert.equal(page.crypto.subtle, real.subtle, "a secure origin must keep the browser's own implementation");
});

test("only SHA-256 is answered, and the answer is a promise either way", async () => {
  const page = insecurePage();
  await assert.rejects(() => page.crypto.subtle.digest("SHA-512", new Uint8Array()), /only SHA-256/);
  // The application passes a typed array and expects an ArrayBuffer back.
  const buffer = await page.crypto.subtle.digest("SHA-256", new Uint8Array([1, 2, 3]));
  assert.equal(buffer instanceof ArrayBuffer, true);
  assert.equal(buffer.byteLength, 32);
  await assert.rejects(() => page.crypto.subtle.digest("SHA-256", "not bytes"), /unsupported data/);
});

test("the document gets the script before its closing body tag, once", () => {
  const html = "<!doctype html><html><body><div id=root></div></body></html>";
  const once = injectAppScript(html);
  assert.equal(once.slice(0, html.indexOf("</body>")), html.slice(0, html.indexOf("</body>")), "nothing before the block changes");
  assert.match(once, /SHA-256/);
  assert.ok(once.indexOf("<script>") < once.indexOf("</body>"), "the script goes in the body");
  assert.equal(injectAppScript(once), once, "a second pass must not double the block");
});

test("a document this function does not recognise is returned untouched", () => {
  for (const untouched of ["", "not html at all", "<html><body>sans fin", null, undefined, 42]) {
    assert.equal(injectAppScript(untouched), untouched);
  }
});
