/**
 * The authentication pages.
 *
 * The design tokens are copied from the ZCode web client stylesheet so the
 * wizard reads as part of the product and not as a bolt-on:
 *   --color-background #161616, --color-panel #202020, --color-card #2b2b2b,
 *   --color-surface rgba(255,255,255,.05), --color-border rgba(255,255,255,.1),
 *   --color-foreground #e5e5e5, --color-destructive #ff5c5c, --color-brand #fff,
 *   radii .25/.375/.5/.75rem, and the same system font stack.
 * The stylesheet is inline: no external asset, so nothing has to be proxied.
 */

import { createHash } from "node:crypto";

const STYLE = `
:root {
  color-scheme: dark;
  --background: #161616;
  --panel: #202020;
  --card: #2b2b2b;
  --surface: #ffffff0d;
  --surface-hover: #ffffff1a;
  --border: #ffffff1a;
  --border-hover: #ffffff26;
  --foreground: #e5e5e5;
  --foreground-subtle: #e5e5e599;
  --foreground-subtlest: #e5e5e54d;
  --destructive: #ff5c5c;
  --brand: #fff;
  --radius-sm: .25rem;
  --radius-md: .375rem;
  --radius-lg: .5rem;
  --radius-xl: .75rem;
  --font-sans: ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
main {
  width: 100%;
  max-width: 420px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: 28px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 20px;
  color: var(--foreground-subtle);
  font-size: 12px;
  letter-spacing: .06em;
  text-transform: uppercase;
}
.brand .dot { width: 6px; height: 6px; border-radius: 999px; background: var(--brand); }
h1 { margin: 0 0 6px; font-size: 18px; font-weight: 600; letter-spacing: -.01em; }
p.lead { margin: 0 0 22px; color: var(--foreground-subtle); font-size: 13px; }
p.step { margin: 0 0 18px; color: var(--foreground-subtlest); font-size: 12px; }
label { display: block; margin: 0 0 6px; font-size: 13px; color: var(--foreground-subtle); }
.field { margin-bottom: 16px; }
input[type="text"], input[type="password"] {
  width: 100%;
  padding: 9px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--foreground);
  font-family: inherit;
  font-size: 14px;
  outline: none;
  transition: border-color .12s ease, background .12s ease;
}
input[type="text"]:hover, input[type="password"]:hover { border-color: var(--border-hover); }
input[type="text"]:focus, input[type="password"]:focus {
  border-color: var(--border-hover);
  background: var(--surface-hover);
}
input.code {
  font-family: var(--font-mono);
  font-size: 20px;
  letter-spacing: .32em;
  text-align: center;
  padding: 12px;
}
button {
  font-family: inherit;
  font-size: 14px;
  cursor: pointer;
  border-radius: var(--radius-md);
  border: 1px solid transparent;
  padding: 9px 14px;
  transition: opacity .12s ease, background .12s ease;
}
button.primary { width: 100%; background: var(--brand); color: #161616; font-weight: 500; }
button.primary:hover { opacity: .9; }
button.ghost {
  background: transparent;
  border-color: var(--border);
  color: var(--foreground-subtle);
}
button.ghost:hover { background: var(--surface); color: var(--foreground); }
.row { display: flex; gap: 10px; align-items: center; margin-top: 8px; }
.error {
  margin: 0 0 16px;
  padding: 10px 12px;
  border: 1px solid rgba(255, 92, 92, .35);
  background: rgba(255, 92, 92, .08);
  border-radius: var(--radius-md);
  color: var(--destructive);
  font-size: 13px;
}
.secret {
  display: block;
  width: 100%;
  margin-bottom: 8px;
  padding: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--foreground);
  font-family: var(--font-mono);
  font-size: 14px;
  letter-spacing: .12em;
  word-break: break-all;
  user-select: all;
}
.hint { margin: 0 0 18px; color: var(--foreground-subtlest); font-size: 12px; }
.uri {
  margin: 0 0 18px;
  padding: 8px 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--foreground-subtle);
  font-family: var(--font-mono);
  font-size: 11px;
  word-break: break-all;
  max-height: 74px;
  overflow: hidden;
}
.recovery-sheet { letter-spacing: .18em; line-height: 1.9; text-align: center; }
.user-list { margin: 0 0 18px; padding: 0 0 0 18px; color: var(--foreground); font-size: 14px; }
`;

/**
 * The one inline script the pages carry, as a constant so its hash can be
 * computed for the Content-Security-Policy header: the policy allows exactly
 * this script and nothing else, rather than allowing every inline script.
 */
const COPY_SCRIPT = `
document.getElementById("copy-secret").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(button.dataset.secret);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed";
  }
});
`;

export const COPY_SCRIPT_SHA256 = createHash("sha256")
  .update(COPY_SCRIPT)
  .digest("base64");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function layout({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} | ZCloudium</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="brand"><span class="dot"></span><span>ZCloudium</span></div>
${body}
</main>
</body>
</html>
`;
}

function errorBlock(message) {
  return message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : "";
}

export function loginPage({ error, next } = {}) {
  return layout({
    title: "Sign in",
    body: `
<h1>Sign in</h1>
<p class="lead">Authentication is required to reach the workspace.</p>
${errorBlock(error)}
<form method="post" action="/_auth/login" autocomplete="on">
  <input type="hidden" name="next" value="${escapeHtml(next ?? "/")}">
  <div class="field">
    <label for="username">Username</label>
    <input id="username" name="username" type="text" autocomplete="username" autofocus required>
  </div>
  <div class="field">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
  </div>
  <button class="primary" type="submit">Continue</button>
</form>`,
  });
}

export function verifyPage({ error } = {}) {
  return layout({
    title: "Two-factor code",
    body: `
<h1>Two-factor code</h1>
<p class="lead">Enter the 6-digit code from your authenticator app.</p>
${errorBlock(error)}
<form method="post" action="/_auth/verify">
  <div class="field">
    <label for="code">Verification code</label>
    <input id="code" class="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code"
           pattern="[0-9]*" maxlength="6" autofocus required>
  </div>
  <button class="primary" type="submit">Sign in</button>
</form>
<form method="post" action="/_auth/logout">
  <div class="row"><button class="ghost" type="submit">Cancel</button></div>
</form>`,
  });
}

export function setupAccountPage({ error } = {}) {
  return layout({
    title: "Create the account",
    body: `
<h1>Create the account</h1>
<p class="step">Step 1 of 2</p>
<p class="lead">This is the first start. Choose the credentials that will protect this instance.</p>
${errorBlock(error)}
<form method="post" action="/_auth/setup" autocomplete="off">
  <div class="field">
    <label for="username">Username</label>
    <input id="username" name="username" type="text" autocomplete="username" autofocus required>
  </div>
  <div class="field">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="new-password" required>
  </div>
  <div class="field">
    <label for="password2">Confirm password</label>
    <input id="password2" name="password2" type="password" autocomplete="new-password" required>
  </div>
  <button class="primary" type="submit">Continue</button>
</form>`,
  });
}

export function setupTotpPage({ secret, uri, account, recoveryCodes, error } = {}) {
  const grouped = String(secret ?? "").replace(/(.{4})/g, "$1 ").trim();
  const recovery =
    Array.isArray(recoveryCodes) && recoveryCodes.length > 0
      ? `
<h1 style="margin-top:26px">Recovery codes</h1>
<p class="lead">If you lose the authenticator, each of these codes signs you in once. Save them now: they are never shown again.</p>
<code class="secret recovery-sheet">${recoveryCodes.map((code) => escapeHtml(code)).join("<br>")}</code>
<p class="hint">Codes are single use, and each one also works in place of the code field at sign in.</p>`
      : "";
  return layout({
    title: "Enrol the authenticator",
    body: `
<h1>Enrol the authenticator</h1>
<p class="step">Step 2 of 2</p>
<p class="lead">Add this account to your authenticator app, then confirm with a generated code.</p>
${errorBlock(error)}
<code class="secret" id="otp-secret">${escapeHtml(grouped)}</code>
<p class="hint">Paste this key into your app if you prefer manual entry.</p>
<p class="uri">${escapeHtml(uri ?? "")}</p>
${recovery}
<form method="post" action="/_auth/setup/totp">
  <div class="field">
    <label for="code">Code from the app</label>
    <input id="code" class="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code"
           pattern="[0-9]*" maxlength="6" autofocus required>
  </div>
  <button class="primary" type="submit">Finish setup</button>
</form>
<p class="hint" style="margin-top:14px">Account: ${escapeHtml(account ?? "")}</p>
<button class="ghost" type="button" id="copy-secret" data-secret="${escapeHtml(secret ?? "")}">Copy key</button>
<script>${COPY_SCRIPT}</script>`,
  });
}

export function passwordPage({ error } = {}) {
  return layout({
    title: "Change the password",
    body: `
<h1>Change the password</h1>
<p class="lead">Every session ends when the password changes, this one included: you will sign in again.</p>
${errorBlock(error)}
<form method="post" action="/_auth/password" autocomplete="off">
  <div class="field">
    <label for="current">Current password</label>
    <input id="current" name="current" type="password" autocomplete="current-password" autofocus required>
  </div>
  <div class="field">
    <label for="password">New password</label>
    <input id="password" name="password" type="password" autocomplete="new-password" required>
  </div>
  <div class="field">
    <label for="password2">Confirm new password</label>
    <input id="password2" name="password2" type="password" autocomplete="new-password" required>
  </div>
  <button class="primary" type="submit">Change and sign out everywhere</button>
</form>`,
  });
}

export function usersPage({ usernames, owner, created, error } = {}) {
  const list = (usernames ?? [])
    .map(
      (name) =>
        `<li>${escapeHtml(name)}${name === owner ? ' <span class="hint" style="display:inline">owner</span>' : ""}</li>`,
    )
    .join("");
  const createdBlock = created
    ? `<p class="hint">Account "${escapeHtml(created)}" is created: hand over its authenticator secret and recovery codes, which were shown on the enrolment page.</p>`
    : "";
  return layout({
    title: "Accounts",
    body: `
<h1>Accounts</h1>
<p class="lead">Everyone listed here can sign in to this instance. Only the owner can add accounts.</p>
${errorBlock(error)}
${createdBlock}
<ul class="user-list">${list}</ul>
<form method="post" action="/_auth/users" autocomplete="off">
  <div class="field">
    <label for="username">New username</label>
    <input id="username" name="username" type="text" autocomplete="off" required>
  </div>
  <div class="field">
    <label for="password">Password (12 characters minimum)</label>
    <input id="password" name="password" type="password" autocomplete="new-password" required>
  </div>
  <div class="field">
    <label for="password2">Confirm password</label>
    <input id="password2" name="password2" type="password" autocomplete="new-password" required>
  </div>
  <button class="primary" type="submit">Create and enrol</button>
</form>
<p class="hint">The next page shows the new account's authenticator secret and recovery codes: relay them to their owner, then they sign in and change the password themselves.</p>`,
  });
}

export function badGatewayPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="refresh" content="10">
<title>Not answering | ZCloudium</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="brand"><span class="dot"></span><span>ZCloudium</span></div>
<h1>The application is not answering</h1>
<p class="lead">The gateway is up, but the runtime behind it is not. This page reloads itself every 10 seconds; if it stays here, read the container logs.</p>
</main>
</body>
</html>
`;
}

export function messagePage({ title, heading, message }) {
  return layout({
    title,
    body: `
<h1>${escapeHtml(heading)}</h1>
<p class="lead">${escapeHtml(message)}</p>`,
  });
}
