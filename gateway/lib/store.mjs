import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function authDir(dataDir) {
  return join(dataDir, "auth");
}

export function usersPath(dataDir) {
  return join(authDir(dataDir), "users.json");
}

export function sessionKeyPath(dataDir) {
  return join(authDir(dataDir), "secret.key");
}

/** Returns null when no account exists yet, which is what drives the setup wizard. */
export async function readUsers(dataDir) {
  try {
    const parsed = JSON.parse(await readFile(usersPath(dataDir), "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.users !== "object" || !parsed.users) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Atomic write, mode 0600: the file holds password hashes and TOTP secrets. */
export async function writeUsers(dataDir, data) {
  await mkdir(authDir(dataDir), { recursive: true });
  const target = usersPath(dataDir);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, target);
}

export function findUser(data, username) {
  if (!data || typeof username !== "string") {
    return null;
  }
  const user = data.users[username];
  return user && typeof user === "object" ? user : null;
}

export function hasUsers(data) {
  return Boolean(data && data.users && Object.keys(data.users).length > 0);
}

/**
 * The account that ran the first wizard owns the instance: only it may create
 * other accounts. Flagged at creation, and a users.json without the flag (from
 * an older version) still has one: the first account in insertion order.
 */
export function ownerOf(data) {
  if (!hasUsers(data)) {
    return null;
  }
  const names = Object.keys(data.users);
  const flagged = names.find((name) => data.users[name].owner === true);
  const chosen = flagged ?? names[0];
  return { name: chosen, user: data.users[chosen] };
}

export function failuresPath(dataDir) {
  return join(authDir(dataDir), "failures.json");
}

/**
 * The failure budget, as it was last persisted. An empty object when there is
 * nothing to read: a restarted container then starts from the budget it had,
 * which is the point of persisting it.
 */
export async function readFailures(dataDir) {
  try {
    const parsed = JSON.parse(await readFile(failuresPath(dataDir), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

/**
 * Atomic write of the failure budget, minus the entries that have fully expired:
 * a key whose block is over and whose budget would restart does not need to
 * travel to the next start.
 */
export async function writeFailures(dataDir, entries) {
  await mkdir(authDir(dataDir), { recursive: true });
  const target = failuresPath(dataDir);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(entries)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, target);
}
