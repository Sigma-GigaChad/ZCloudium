import test from "node:test";
import assert from "node:assert/strict";
import { assessVolumes, classifyMount, coveringMount, parseMountInfo } from "../gateway/lib/volumes.mjs";

/**
 * A mountinfo table shaped like the containers this project ships: the root
 * overlay, an anonymous volume on /data (what Docker creates when the -v is
 * forgotten), a named volume on /workspace, a bind mount at /host (the full
 * access profile) and a tmpfs.
 */
const MOUNTS = parseMountInfo(
  [
    "808 802 0:792 / / rw,relatime - overlay overlay rw",
    "820 808 0:94 /var/lib/docker/volumes/9f2c1e88d1c64d0c9b61d0c5c8f0e7a2b3d4c5e6f7a8b9c0d1e2f3a4b5c6d7e8/_data /data rw,relatime - ext4 /dev/sda1 rw",
    "821 808 0:95 /var/lib/docker/volumes/z-cloudium-workspace/_data /workspace rw,relatime - ext4 /dev/sda1 rw",
    "822 808 0:96 / /host rw,relatime - ext4 /dev/sda2 rw",
    "823 808 0:97 / /tmp rw,relatime - tmpfs tmpfs rw",
  ].join("\n"),
);

test("the mountinfo table is parsed into root, mount point, type and source", () => {
  assert.equal(MOUNTS.length, 5);
  assert.deepEqual(MOUNTS[1], {
    root: "/var/lib/docker/volumes/9f2c1e88d1c64d0c9b61d0c5c8f0e7a2b3d4c5e6f7a8b9c0d1e2f3a4b5c6d7e8/_data",
    mountPoint: "/data",
    type: "ext4",
    source: "/dev/sda1",
  });
});

test("mounts classify as rootfs, anonymous volume, named volume, bind or tmpfs", () => {
  assert.equal(classifyMount(MOUNTS[0]), "rootfs");
  assert.equal(classifyMount(MOUNTS[1]), "anonymous-volume");
  assert.equal(classifyMount(MOUNTS[2]), "named-volume");
  assert.equal(classifyMount(MOUNTS[3]), "bind");
  assert.equal(classifyMount(MOUNTS[4]), "tmpfs");
});

test("the covering mount is the deepest ancestor, and boundaries are respected", () => {
  assert.equal(coveringMount(MOUNTS, "/data").mountPoint, "/data");
  assert.equal(coveringMount(MOUNTS, "/data/auth").mountPoint, "/data");
  // /dataX must not be covered by a mount at /data.
  assert.equal(coveringMount(MOUNTS, "/dataX").mountPoint, "/");
  // The full access home sits under the /host bind, not under any volume.
  assert.equal(coveringMount(MOUNTS, "/host/home/delta").mountPoint, "/host");
  // A trailing slash on the mount point must not break the prefix match.
  const sloppy = [{ root: "/srv/ws", mountPoint: "/workspace/", type: "ext4", source: "/dev/sdb" }];
  assert.equal(coveringMount(sloppy, "/workspace/project").mountPoint, "/workspace/");
});

test("named volumes, bind mounts and paths under them pass the check", () => {
  // /data in this table is an anonymous volume: an inhabited one passes with a
  // warning, which is what a restarted `docker run` container looks like.
  const ok = assessVolumes({ dataDir: "/data", workspace: "/workspace", mounts: MOUNTS, dirState: () => "content" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.warnings.length, 1);

  // The full access profile: both directories under the /host bind.
  const fullAccess = assessVolumes({
    dataDir: "/host/home/delta",
    workspace: "/host/home/delta",
    mounts: MOUNTS,
  });
  assert.equal(fullAccess.ok, true);
});

test("a fresh anonymous volume refuses to start, an inhabited one only warns", () => {
  const fresh = assessVolumes({ dataDir: "/data", workspace: "/workspace", mounts: MOUNTS, dirState: () => "empty" });
  assert.equal(fresh.ok, false);
  assert.match(fresh.errors[0], /throwaway anonymous volume/);
  assert.match(fresh.errors[0], /-v z-cloudium-data:\/data/);

  const reused = assessVolumes({ dataDir: "/data", workspace: "/workspace", mounts: MOUNTS, dirState: () => "content" });
  assert.equal(reused.ok, true);
  assert.match(reused.warnings[0], /anonymous volume Docker created/);
  assert.match(reused.warnings[0], /docker volume create/);
});

test("data or workspace on the bare container filesystem is refused", () => {
  const bare = assessVolumes({ dataDir: "/state", workspace: "/work", mounts: MOUNTS });
  assert.equal(bare.ok, false);
  assert.match(bare.errors[0], /\/state lives on the container filesystem/);
  assert.match(bare.errors[1], /\/work is not a mount/);
});

test("tmpfs as the data directory is refused: it evaporates at restart", () => {
  const ramdisk = assessVolumes({ dataDir: "/tmp", workspace: "/workspace", mounts: MOUNTS });
  assert.equal(ramdisk.ok, false);
  assert.match(ramdisk.errors[0], /tmpfs/);
});
