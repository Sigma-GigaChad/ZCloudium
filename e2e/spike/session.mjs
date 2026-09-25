/**
 * Gets one authenticated session on a Phase 0 container, for the observation run.
 *
 * The observations need the viewer to be behind the gateway like any operator,
 * and the operator session is a cookie. This script obtains one the same way a
 * person does: the first run wizard on a clean data volume, or a sign in with a
 * code the server has not seen yet when the account already exists.
 *
 *   node e2e/spike/session.mjs --base http://127.0.0.1:3041 --container <name> [--out <path>]
 *
 * It prints one JSON line: the Cookie header, the account, and where the session
 * came from. The secret of an existing account is read from the container's own
 * user store, which is what makes a second run possible at all.
 */

import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { nextUnusedCode } from "../lib/totp.mjs";

const run = promisify(execFile);

function parseArgs(argv) {
  const out = {
    base: null,
    container: null,
    username: "phase0-operator",
    password: "phase0-Correct-Horse-Battery",
    outPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    switch (key) {
      case "--base":
        out.base = value;
        index += 1;
        break;
      case "--container":
        out.container = value;
        index += 1;
        break;
      case "--username":
        out.username = value;
        index += 1;
        break;
      case "--password":
        out.password = value;
        index += 1;
        break;
      case "--out":
        out.outPath = value;
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${key}`);
    }
  }
  if (!out.base || !out.container) {
    throw new Error("--base and --container are required");
  }
  return out;
}

function cookieFrom(response, name) {
  const all = response.headers.getSetCookie();
  const match = all.map((entry) => entry.split(";")[0]).find((entry) => entry.startsWith(`${name}=`));
  return match ?? null;
}

function post(base, path, fields, cookie) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

/** The account as the container stores it: the secret, and the step already spent. */
async function readAccount(container) {
  const { stdout } = await run("docker", ["exec", container, "cat", "/data/auth/users.json"]);
  const users = JSON.parse(stdout);
  const user = Object.values(users.users ?? {})[0];
  if (!user) {
    throw new Error("the container holds no account");
  }
  return { username: user.username, secret: user.totpSecret, lastUsedStep: user.totpLastStep };
}

async function firstRunWizard(base, { username, password }) {
  const step1 = await post(base, "/_auth/setup", { username, password, password2: password });
  if (step1.status !== 303) {
    return null;
  }
  const setupCookie = cookieFrom(step1, "zc_setup");
  const enroll = await fetch(`${base}/_auth/setup/totp`, { headers: { cookie: setupCookie } });
  const html = await enroll.text();
  const secret = html.match(/id="otp-secret"[^>]*>\s*([A-Z2-7\s]+?)\s*</)?.[1]?.replace(/\s+/g, "");
  if (!secret) {
    throw new Error("the enrolment page displayed no secret");
  }
  const { code, step } = await nextUnusedCode(secret);
  const step2 = await post(base, "/_auth/setup/totp", { code }, setupCookie);
  const session = cookieFrom(step2, "zc_sess");
  if (!session) {
    throw new Error(`the enrolment was refused (status ${step2.status})`);
  }
  return { cookie: session, username, secret, lastUsedStep: step, source: "setup" };
}

async function signIn(base, { username, password, secret, lastUsedStep }) {
  const step1 = await post(base, "/_auth/login", { username, password });
  if (step1.status !== 303) {
    throw new Error(`the password step was refused (status ${step1.status})`);
  }
  const loginCookie = cookieFrom(step1, "zc_login");
  const { code, step } = await nextUnusedCode(secret, { lastUsedStep });
  const step2 = await post(base, "/_auth/verify", { code }, loginCookie);
  const session = cookieFrom(step2, "zc_sess");
  if (!session) {
    throw new Error(`the code step was refused (status ${step2.status})`);
  }
  return { cookie: session, username, secret, lastUsedStep: step, source: "signin" };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fresh = await firstRunWizard(options.base, options);
  let result = fresh;

  if (!result) {
    const account = await readAccount(options.container);
    result = await signIn(options.base, { ...account, password: options.password });
    if (result.username !== account.username) {
      throw new Error("the account that signed in is not the one in the container");
    }
  }

  const line = `${JSON.stringify(result)}\n`;
  process.stdout.write(line);
  if (options.outPath) {
    await writeFile(options.outPath, line);
  }
}

main().catch((error) => {
  process.stderr.write(`session.mjs: ${error.stack ?? error.message}\n`);
  process.exit(1);
});
