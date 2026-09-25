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
