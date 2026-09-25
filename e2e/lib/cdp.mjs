/**
 * A CDP client for the end to end suite, running inside the browser.
 *
 * The panel talks to the page target over `/_browser/devtools/page/<id>`, behind
 * the session, and the gateway refuses that path to a request that does not carry
 * the cookie. A WebSocket opened from Node cannot carry one: the standard
 * library's client sends no header of its own (`headers` in its options object is
 * accepted and ignored, measured), so the handshake arrives anonymous and the
 * gateway answers 401 before any upgrade. The honest client is therefore a page
 * served by the gateway, which attaches the cookie and the Origin exactly like
 * the panel does, and that is what these helpers use: the suite observes the
 * target through the same door the operator's panel uses.
 */

/** The discovery document the panel itself reads to find the targets. */
export const TARGETS_PATH = "/_browser/json/list";

/**
 * The page targets, in the order the debug port lists them. `browser_ui` and
 * `service_worker` entries are filtered out: the panel only ever shows a page.
 */
export async function listPanelTargets(request) {
  const response = await request.get(TARGETS_PATH);
  if (response.status() !== 200) {
    throw new Error(`${TARGETS_PATH} answered ${response.status()}: is the browser panel on for this container?`);
  }
  const targets = await response.json();
  return Array.isArray(targets) ? targets.filter((target) => target?.type === "page") : [];
}

/**
 * Sends one CDP command to a page target, from a page of the gateway's own
 * origin, and returns the `result` object of the answer.
 *
 * The socket is opened for one command and closed again: the suite drives the
 * target the way the panel does, but it must not hold a session open while a
 * panel under test is being opened and closed, or a failure to detach would be
 * invisible.
 */
export function cdpCall(page, { targetId, method, params = {}, timeoutMs = 20_000 }) {
  return page.evaluate(
    async ({ targetId, method, params, timeoutMs }) => {
      const scheme = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${scheme}//${location.host}/_browser/devtools/page/${targetId}`);
      const answer = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no answer to ${method} within ${timeoutMs} ms`)), timeoutMs);
        const done = (value) => {
          clearTimeout(timer);
          socket.close();
          resolve(value);
        };
        socket.onerror = () => {
          clearTimeout(timer);
          reject(new Error(`the WebSocket to ${targetId} failed`));
        };
        socket.onopen = () => socket.send(JSON.stringify({ id: 1, method, params }));
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.id === 1) {
            done(message);
          }
        };
      });
      if (answer.error) {
        throw new Error(`${method} refused: ${answer.error.message}`);
      }
      if (answer.result?.exceptionDetails) {
        throw new Error(`${method} raised: ${answer.result.exceptionDetails.exception?.description ?? answer.result.exceptionDetails.text}`);
      }
      return answer.result ?? null;
    },
    { targetId, method, params, timeoutMs },
  );
}

/**
 * Evaluates an expression in the page target and returns its value, which is the
 * fixture's own answer about itself. That is what makes "the viewport control
 * changes what the page reports" a measurement rather than a claim: the number
 * compared is the page's, read over CDP, not the panel's.
 */
export async function cdpEvaluate(page, { targetId, expression, timeoutMs }) {
  const result = await cdpCall(page, { targetId, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true }, timeoutMs });
  return result?.result?.value;
}
