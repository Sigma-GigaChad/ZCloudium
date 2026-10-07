/**
 * The persistence pre-check: refuse to start on directories that will not
 * survive the container.
 *
 * The image declares VOLUME /data, which means Docker always mounts something
 * there — including a throwaway anonymous volume when the operator forgot the
 * -v. That case is the classic loss: everything the agent writes dies with the
 * container, and the next `docker run` meets the setup wizard again. This
 * module reads /proc/self/mountinfo (no Docker socket needed — the container
 * can see its own mounts), classifies what covers the data directory and the
 * workspace, and tells the operator exactly what to mount.
 *
 * What counts as persisted: a named volume, a bind mount (host directory), or
 * a path living under one (the full access profile mounts / on /host and puts
 * both directories there). What does not: the container's own filesystem (the
 * root overlay), a fresh anonymous volume, and tmpfs.
 */

import { readFileSync } from "node:fs";

/**
 * The mount table of this container, or null where it cannot be read (a
 * non-Linux development machine, a hardened kernel without procfs): the check
 * then reports that it cannot verify instead of guessing.
 */
export function readMountInfo() {
  try {
    return readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return null;
  }
}

/** Parse the kernel mountinfo table into the fields this check needs. */
export function parseMountInfo(text) {
  return String(text)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      // "36 35 98:0 /root /mount rw,... - fstype source superoptions"
      const separator = line.indexOf(" - ");
      if (separator < 0) {
        return null;
      }
      const [left, right] = [line.slice(0, separator), line.slice(separator + 3)];
      const leftFields = left.split(" ");
      const rightFields = right.split(" ");
      if (leftFields.length < 5 || rightFields.length < 2) {
        return null;
      }
      return {
        root: leftFields[3],
        mountPoint: leftFields[4],
        type: rightFields[0],
        source: rightFields[1],
      };
    })
    .filter((mount) => mount !== null);
}

/**
 * Every container runtime ends its volume mounts with `/_data` — Docker
 * (rootful at /var/lib/docker/volumes, rootless under ~/.local/share/docker),
 * Podman, any custom data-root — and the segment before it names the volume.
 * Anonymous volumes are a 64-hex hash on every one of those runtimes; named
 * ones are not. A bind mount of a host directory that happens to end in
 * /_data classifies as a named volume, which is the safe direction: it never
 * gets refused, only mis-described.
 */
export function classifyMount(mount) {
  if (mount.root.endsWith("/_data")) {
    const before = mount.root.slice(0, -"/_data".length);
    const name = before.slice(before.lastIndexOf("/") + 1);
    return /^[0-9a-f]{64}$/.test(name) ? "anonymous-volume" : "named-volume";
  }
  if (mount.mountPoint === "/" && mount.root === "/") {
    return "rootfs";
  }
  if (mount.type === "tmpfs") {
    return "tmpfs";
  }
  return "bind";
}

/**
 * The mount that holds `path`: the deepest mount point that is the path itself
 * or an ancestor. The root overlay is returned like any other mount; callers
 * decide whether it counts as persistence.
 */
export function coveringMount(mounts, path) {
  const normalized = path.replace(/\/+$/, "") || "/";
  let best = null;
  let bestDepth = -1;
  for (const mount of mounts) {
    const point = mount.mountPoint.replace(/\/+$/, "") || "/";
    // The root mount "/" covers everything; deeper points cover their subtree.
    const covers = point === "/" || normalized === point || normalized.startsWith(`${point}/`);
    if (covers && point.length > bestDepth) {
      best = mount;
      bestDepth = point.length;
    }
  }
  return best;
}

/**
 * The assessment itself. `dirState` answers whether a directory already holds
 * anything ("content") or is empty ("empty") — only asked for anonymous
 * volumes, where an existing container restart reuses its volume while a fresh
 * `docker run` creates a new empty one. Both protected paths get the same
 * policy: the workspace losing the agent's work is as unacceptable as the data
 * directory losing it.
 */
export function assessVolumes({ dataDir, workspace, mounts, dirState = () => "empty" }) {
  const errors = [];
  const warnings = [];

  const assess = (path, volumeHint) => {
    const mount = coveringMount(mounts, path);
    if (!mount) {
      errors.push(
        `${path} is not a mount at all: it lives on the container filesystem, and everything written there dies with the container.`,
      );
      return;
    }
    const kind = classifyMount(mount);
    if (kind === "rootfs") {
      errors.push(
        `${path} lives on the container filesystem (no volume is mounted there): everything written there dies with the container. Mount a volume: -v ${volumeHint}:${path}`,
      );
    } else if (kind === "tmpfs") {
      errors.push(
        `${path} is on tmpfs: everything written there is gone at the next restart. Mount a real volume instead: -v ${volumeHint}:${path}`,
      );
    } else if (kind === "anonymous-volume") {
      if (dirState(path) === "content") {
        warnings.push(
          `${path} is an anonymous volume Docker created because no -v was given. This container reuses it, so nothing is lost while it lives — but the volume is unnamed and unmanaged: a docker rm followed by a docker run silently starts over. Create a named volume: docker volume create ${volumeHint}, then -v ${volumeHint}:${path}`,
        );
      } else {
        errors.push(
          `${path} is a throwaway anonymous volume (no -v was given for it): a fresh docker run created it empty, and everything written there dies with the container — the setup wizard would run again from zero. Mount a volume: -v ${volumeHint}:${path}`,
        );
      }
    }
  };

  assess(dataDir, "z-cloudium-data");
  assess(workspace, "z-cloudium-workspace");

  return { ok: errors.length === 0, errors, warnings };
}
