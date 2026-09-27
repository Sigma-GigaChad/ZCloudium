/**
 * What the gateway puts into the application's document.
 *
 * The web build of ZCode is served as it is: the gateway proxies the runtime's
 * own `index.html` and never patches the artifact. This module is the one place
 * where that document is touched on the way through, and it is additive: a script
 * block appended before `</body>`, whose content this project owns and tests.
 *
 * It exists because of a real, reported failure: sending a file fails with
 * `fault.attachment.checksumUnavailable` on any origin that is not a secure
 * context. The client hashes the attachment before uploading it
 * (`crypto.subtle.digest("SHA-256", ...)`) and throws that fault when
 * `crypto.subtle` is absent, which browsers withhold over plain `http://` on
 * anything but `localhost`. That is a platform rule, not a bug in the runtime,
 * and it hits exactly the deployment this project documents: a container on a
 * LAN or a VPN address, reached over http.
 *
 * So the script below provides the missing piece, and only the missing piece:
 *
 * - it does nothing at all when `crypto.subtle` exists, which is every https
 *   origin and `localhost`, so nothing changes for a deployment that was working;
 * - it defines `Crypto.prototype.subtle.digest` for SHA-256, the one method the
 *   bundle uses (measured: `digest` in `index-*.js` and in the IME chunk, and
 *   nothing else from `subtle`);
 * - it computes the SHA-256 constants from the primes they come from rather than
 *   carrying a table of 64 magic values, so a typo cannot silently produce wrong
 *   hashes: a wrong hash would be worse than the fault it replaces, since the
 *   upload would then be refused by the server or, worse, stored wrong.
 *
 * A secure origin is still the better answer, and the README says so: TLS in
 * front of the port is a deployment decision this project documents rather than
 * performs. This block is what keeps a plain http deployment usable, in the
 * meantime and afterwards.
 */

/**
 * The path this script is served from when a caller prefers a file to an inline
 * block. It lives under the browser prefix, so it is behind the session like
 * everything else the gateway adds.
 */
export const APP_SCRIPT_PATH = "/_browser/app.js";

/**
 * The script, as the page runs it.
 *
 * `crypto.subtle` is a getter on `Crypto.prototype`, and an insecure context
 * simply does not define it. The shim is defined on the crypto object itself
 * rather than on the prototype: an own property shadows whatever the platform
 * put there, an assignment would fail against a getter only property, and an
 * object the browser froze would refuse both, which the try below reports rather
 * than hides.
 */
export function appScript() {
  return `"use strict";
// The gateway's own addition to this page: the SHA-256 the browser withholds on
// insecure origins. See gateway/lib/app-script.mjs for why it exists.
(() => {
  const cryptoObject = globalThis.crypto;
  if (!cryptoObject || cryptoObject.subtle) {
    return;
  }

  // The first n primes, by trial division: 64 for the round constants, 8 for the
  // initial state. Deriving them is deliberate, see the module comment.
  const primes = (count) => {
    const found = [];
    for (let candidate = 2; found.length < count; candidate += 1) {
      let prime = true;
      for (let divisor = 2; divisor * divisor <= candidate; divisor += 1) {
        if (candidate % divisor === 0) {
          prime = false;
          break;
        }
      }
      if (prime) {
        found.push(candidate);
      }
    }
    return found;
  };

  // The first 32 bits of the fractional part of the k-th root, which is where the
  // SHA-2 constants come from: square roots for the initial state, cube roots for
  // the round constants.
  const fractionalBits = (value, root) => {
    const rooted = Math.pow(value, 1 / root);
    return Math.floor((rooted - Math.floor(rooted)) * 4294967296) >>> 0;
  };

  const K = primes(64).map((prime) => fractionalBits(prime, 3));
  const H0 = primes(8).map((prime) => fractionalBits(prime, 2));

  const rotateRight = (value, bits) => (value >>> bits) | (value << (32 - bits));

  const hash = (message) => {
    const length = message.length;
    const bitLength = length * 8;
    // One 0x80 byte, the length in 64 bits, zero padding up to a multiple of 64.
    const padded = new Uint8Array((((length + 9) + 63) & ~63));
    padded.set(message);
    padded[length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bitLength / 4294967296));
    view.setUint32(padded.length - 4, bitLength >>> 0);

    const state = H0.slice();
    const schedule = new Uint32Array(64);
    for (let offset = 0; offset < padded.length; offset += 64) {
      for (let i = 0; i < 16; i += 1) {
        schedule[i] = view.getUint32(offset + i * 4);
      }
      for (let i = 16; i < 64; i += 1) {
        const s0 = rotateRight(schedule[i - 15], 7) ^ rotateRight(schedule[i - 15], 18) ^ (schedule[i - 15] >>> 3);
        const s1 = rotateRight(schedule[i - 2], 17) ^ rotateRight(schedule[i - 2], 19) ^ (schedule[i - 2] >>> 10);
        schedule[i] = (schedule[i - 16] + s0 + schedule[i - 7] + s1) >>> 0;
      }

      let [a, b, c, d, e, f, g, h] = state;
      for (let i = 0; i < 64; i += 1) {
        const S1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const choice = (e & f) ^ (~e & g);
        const temp1 = (h + S1 + choice + K[i] + schedule[i]) >>> 0;
        const S0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + majority) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }
      state[0] = (state[0] + a) >>> 0;
      state[1] = (state[1] + b) >>> 0;
      state[2] = (state[2] + c) >>> 0;
      state[3] = (state[3] + d) >>> 0;
      state[4] = (state[4] + e) >>> 0;
      state[5] = (state[5] + f) >>> 0;
      state[6] = (state[6] + g) >>> 0;
      state[7] = (state[7] + h) >>> 0;
    }

    const digest = new Uint8Array(32);
    const digestView = new DataView(digest.buffer);
    state.forEach((word, index) => digestView.setUint32(index * 4, word));
    return digest;
  };

  const asBytes = (data) => {
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (Array.isArray(data)) {
      return Uint8Array.from(data);
    }
    throw new TypeError("unsupported data for digest");
  };

  const subtle = {
    digest(algorithm, data) {
      const name = typeof algorithm === "string" ? algorithm : algorithm && algorithm.name;
      if (String(name).toUpperCase() !== "SHA-256") {
        return Promise.reject(new Error("only SHA-256 is provided here"));
      }
      try {
        return Promise.resolve(hash(asBytes(data)).buffer);
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };

  Object.defineProperty(globalThis.crypto, "subtle", {
    get: () => subtle,
    configurable: true,
  });
})();
`;
}

/** The script as it is written into the document, so the marker can be found again. */
const INJECTION_MARKER = "<!-- gateway: insecure-origin helpers -->";

/**
 * The document with the script appended, or the same document when there is
 * nothing to do.
 *
 * Idempotent by construction: a document that already carries the marker is
 * returned untouched, so a proxy that runs twice cannot double the block. A
 * document without a closing body tag is returned untouched too: an answer this
 * function does not recognise must reach the browser exactly as it was.
 */
export function injectAppScript(html, { script = appScript() } = {}) {
  if (typeof html !== "string" || html === "") {
    return html;
  }
  if (html.includes(INJECTION_MARKER)) {
    return html;
  }
  const closing = html.lastIndexOf("</body>");
  if (closing === -1) {
    return html;
  }
  const block = `${INJECTION_MARKER}\n<script>${script}</script>\n`;
  return `${html.slice(0, closing)}${block}${html.slice(closing)}`;
}
