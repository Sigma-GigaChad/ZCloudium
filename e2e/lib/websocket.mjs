/**
 * A raw WebSocket handshake, at the HTTP level.
 *
 * The gateway refuses an upgrade without a session by answering 401 before any
 * upgrade happens, which is invisible to a plain page fetch: nothing on the HTML
 * side reports it. This module speaks the upgrade request itself, so the status
 * line can be asserted exactly, with or without the session cookie.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** The path the interface connects to, read from a live run: ws://host/ws. */
export const WEBSOCKET_PATH = "/ws";

/** The key of RFC 6455 section 1.3, whose accept value is known and can be checked. */
const KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const EXPECTED_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";

/**
 * Returns what the server answered to an upgrade request:
 *   { upgraded: true, status: 101, headers } when the socket was allowed through,
 *   { upgraded: false, status, headers } when it was refused.
 */
export function upgradeRequest(baseURL, { cookie, path = WEBSOCKET_PATH } = {}) {
  const target = new URL(baseURL);
  const headers = {
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": KEY,
  };
  if (cookie) {
    headers.Cookie = cookie;
  }

  // The gateway serves https by default, so the handshake has to be made the same
  // way a browser makes it: over TLS, and accepting the certificate it generated
  // itself, because the suite drives that deployment rather than testing it.
  const secure = target.protocol === "https:";
  const request = secure ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const client = request(
      {
        hostname: target.hostname,
        port: target.port || (secure ? 443 : 80),
        path,
        method: "GET",
        headers,
        ...(secure ? { rejectUnauthorized: false } : {}),
      },
      (response) => {
        response.resume();
        resolve({ upgraded: false, status: response.statusCode, headers: response.headers });
      },
    );
    client.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve({ upgraded: true, status: response.statusCode, headers: response.headers });
    });
    client.on("error", reject);
    client.end();
  });
}

export { EXPECTED_ACCEPT };
