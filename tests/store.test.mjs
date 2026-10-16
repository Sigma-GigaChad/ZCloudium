/**
 * Tests for the account store (gateway/lib/store.mjs).
 *
 * The read is cached because /_auth/health and /_auth/status are hit on every
 * page load and by the container healthcheck, yet they only need to know
 * whether an account exists: re-reading and re-parsing users.json on every hit
 * was pure overhead. What the cache may never do is hide a write: what the
 * gateway has just stored has to be what the next request reads.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUsers, usersPath, writeUsers } from "../gateway/lib/store.mjs";

/** A minimal account sheet, complete enough for the store's shape check. */
function sheet(names) {
  return {
    version: 1,
    users: Object.fromEntries(names.map((name) => [name, { username: name, password: "hash" }])),
  };
}

test("readUsers does not go back to the file between writes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "zcloudium-store-"));
  try {
    assert.equal(await readUsers(dataDir), null, "with no account yet the answer is null");

    await writeUsers(dataDir, sheet(["operator"]));
    const first = await readUsers(dataDir);
    const second = await readUsers(dataDir);
    assert.deepEqual(Object.keys(first.users), ["operator"]);
    // Identity rather than deep equality: a second parse of the file would
    // produce an equal but different object, and that is exactly the re-read
    // this cache exists to avoid.
    assert.equal(second, first, "a second read must come from the cache, not from the file");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a write invalidates the cache, and the next read reflects it", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "zcloudium-store-"));
  try {
    await writeUsers(dataDir, sheet(["operator"]));
    assert.deepEqual(Object.keys((await readUsers(dataDir)).users), ["operator"]);

    await writeUsers(dataDir, sheet(["operator", "colleague"]));
    const after = await readUsers(dataDir);
    assert.deepEqual(
      Object.keys(after.users).sort(),
      ["colleague", "operator"],
      "the account the gateway just stored must be the one the next read sees",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a cached null is dropped when the first account is written", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "zcloudium-store-"));
  try {
    assert.equal(await readUsers(dataDir), null);
    assert.equal(await readUsers(dataDir), null, "the missing sheet is cached like any other answer");

    await writeUsers(dataDir, sheet(["operator"]));
    assert.deepEqual(
      Object.keys((await readUsers(dataDir)).users),
      ["operator"],
      "the first-run wizard must be visible to the next request",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("writeUsers still stores the sheet on disk, atomically enough to parse", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "zcloudium-store-"));
  try {
    await writeUsers(dataDir, sheet(["operator"]));
    const stored = JSON.parse(await readFile(usersPath(dataDir), "utf8"));
    assert.deepEqual(stored, sheet(["operator"]));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
