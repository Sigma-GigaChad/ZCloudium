/**
 * TLS, terminated by the gateway, with a certificate it can make itself.
 *
 * The gateway speaks plain http today, and the README tells the operator to put
 * something in front of it. That is still the better answer, but it is a decision
 * this project can carry: a self-signed certificate is worth more than no
 * encryption at all, and it also makes the origin a secure context, which the
 * platform withholds over plain http and which a browser needs for the clipboard,
 * for service workers, and for the SHA-256 that attachments are hashed with (see
 * app-script.mjs for that last one).
 *
 * What this is not: trust. A self-signed certificate is not signed by anybody the
 * browser knows, so the first visit shows a warning and the operator has to accept
 * it. That is why the switch is off by default and the README says when not to use
 * it: a deployment that already has a reverse proxy terminating TLS must keep
 * letting that proxy do it.
 *
 * The certificate carries the names the deployment is reached by (localhost, the
 * loopback addresses, the container's hostname and every address it holds) as
 * subject alternative names, so accepting the warning is the only thing the
 * operator has to do: a certificate that does not name the host it was reached at
 * would fail after the warning, which is worse than the warning itself.
 *
 * openssl does the signing. Node can generate the key pair, but building an X.509
 * certificate by hand means DER encoding, and a certificate is not the place to
 * be clever: the image installs openssl for this, and the arguments it is called
 * with are a pure function with its own test.
 */

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { networkInterfaces, hostname as systemHostname } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Where the certificate lives, under the data volume so it survives a restart. */
export const TLS_DIR_NAME = "tls";

/** How long a generated certificate is valid. 825 days is the limit Apple enforces. */
export const TLS_DAYS = 825;

export function tlsDir(dataDir) {
  return join(dataDir, TLS_DIR_NAME);
}

export function certificatePaths(dataDir) {
  return { cert: join(tlsDir(dataDir), "cert.pem"), key: join(tlsDir(dataDir), "key.pem") };
}

/**
 * The names the certificate has to carry: the ones this deployment is reached by.
 *
 * Everything the machine currently answers to is included, because a certificate
 * is generated once and the address it is reached at is not knowable from inside
 * the container: the operator's browser uses a LAN address, a VPN address or a
 * hostname, and any of them may be the one. An address that appears later (a new
 * DHCP lease, a new tunnel) is not in the list, which is why the check below
 * regenerates when the names no longer cover the machine.
 */
export function certificateHosts({ interfaces = networkInterfaces(), hostname: name = systemHostname() } = {}) {
  const hosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (typeof name === "string" && name.trim() !== "") {
    hosts.add(name.trim());
  }
  for (const addresses of Object.values(interfaces ?? {})) {
    for (const address of addresses ?? []) {
      if (typeof address?.address === "string" && address.address !== "") {
        hosts.add(address.address.split("%")[0]);
      }
    }
  }
  return [...hosts].sort();
}

/** The subject alternative name list, in the form openssl takes it. */
export function subjectAltNames(hosts) {
  return hosts
    .map((host) => (host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host) ? `IP:${host}` : `DNS:${host}`))
    .join(",");
}

/**
 * The argv openssl is called with. Pure, so the test can assert the shape without
 * running anything: a wrong flag here is a certificate that silently misses the
 * names it exists for.
 */
export function opensslArgs({ cert, key, hosts, days = TLS_DAYS } = {}) {
  return [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-days",
    String(days),
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-subj",
    "/CN=z-cloudium",
    "-addext",
    `subjectAltName=${subjectAltNames(hosts)}`,
  ];
}

/** Whether the file exists, without throwing on the many ways it cannot. */
async function exists(path) {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The certificate on disk, or a new one.
 *
 * Regenerated when it is missing, when it cannot be read as a certificate, when
 * it is expired, or when it does not name a host this machine answers to. Kept
 * otherwise: regenerating on every start would make every restart a new warning
 * in the operator's browser.
 */
export async function loadOrCreateCertificate({
  dataDir,
  logger = () => {},
  hosts = certificateHosts(),
  days = TLS_DAYS,
  execute = (file, args) => run(file, args),
  now = () => Date.now(),
} = {}) {
  if (!dataDir) {
    throw new Error("loadOrCreateCertificate requires a dataDir");
  }
  const paths = certificatePaths(dataDir);

  const present = await Promise.all([exists(paths.cert), exists(paths.key)]);
  if (present[0] && present[1]) {
    const cert = await readFile(paths.cert, "utf8");
    const key = await readFile(paths.key, "utf8");
    try {
      const parsed = new X509Certificate(cert);
      const expired = Date.parse(parsed.validTo) <= now();
      const missing = hosts.filter((host) => !parsed.subjectAltName?.includes(host));
      if (!expired && missing.length === 0) {
        logger(
          `[tls] using the certificate in ${paths.cert}, valid until ${parsed.validTo}, fingerprint ${parsed.fingerprint256}`,
        );
        return { cert, key, created: false, fingerprint: parsed.fingerprint256, validTo: parsed.validTo };
      }
      logger(
        expired
          ? `[tls] the certificate in ${paths.cert} expired on ${parsed.validTo}, generating another one`
          : `[tls] the certificate in ${paths.cert} does not name ${missing.join(", ")}, generating another one`,
      );
    } catch (error) {
      logger(`[tls] the certificate in ${paths.cert} could not be read (${error.message}), generating another one`);
    }
  }

  await mkdir(tlsDir(dataDir), { recursive: true, mode: 0o700 });
  await execute("openssl", opensslArgs({ cert: paths.cert, key: paths.key, hosts, days }));
  // The key is the secret half: readable by its owner only, whatever the umask was.
  const key = await readFile(paths.key, "utf8");
  await writeFile(paths.key, key, { mode: 0o600 });
  const cert = await readFile(paths.cert, "utf8");
  const parsed = new X509Certificate(cert);
  logger(
    `[tls] generated a self-signed certificate for ${hosts.join(", ")} in ${paths.cert}, ` +
      `valid until ${parsed.validTo}, fingerprint ${parsed.fingerprint256}. Your browser will warn once: ` +
      "the certificate is not signed by an authority it knows, which is expected.",
  );
  return { cert, key, created: true, fingerprint: parsed.fingerprint256, validTo: parsed.validTo };
}
