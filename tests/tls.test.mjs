/**
 * The TLS the gateway terminates itself.
 *
 * What is checked here is not that openssl works: the end to end run on a real
 * container is what proves a browser can reach the gateway over https. What is
 * checked is the part a silent mistake would ruin: the names the certificate is
 * generated for, the argv openssl is called with, and the rules that decide
 * whether an existing certificate is kept or replaced.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_HOSTS,
  TLS_DAYS,
  certificateHosts,
  certificatePaths,
  loadOrCreateCertificate,
  opensslArgs,
  subjectAltNames,
} from "../gateway/lib/tls.mjs";


/**
 * A real, self-signed certificate, for the tests that need one to parse.
 *
 * Its subject alternative names are localhost, 127.0.0.1 and 10.0.0.5, and it
 * expires in 2036. The private key that went with it is not here: nothing in the
 * module reads a key beyond copying it, and a key in a repository is a smell even
 * when it protects nothing at all.
 */
const FIXTURE_CERT = `-----BEGIN CERTIFICATE-----
MIIDLTCCAhWgAwIBAgIUcHi3ZPkhFJV+fPshf4adbuhhwnMwDQYJKoZIhvcNAQEL
BQAwFTETMBEGA1UEAwwKei1jbG91ZGl1bTAeFw0yNjA5MjcxNzI3MDRaFw0zNjA5
MjQxNzI3MDRaMBUxEzARBgNVBAMMCnotY2xvdWRpdW0wggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDhh9iX/1g8QK4aH9Psj1MHSSpkT4J7/A2/EgB4k0qZ
H0PZ2rqN4KQY4RmC5O0ItiHnV5RdiZQAwMntOgDVs+/jQtQDrwfIGHhZ/qfQyqz5
7SztX55YReB2sAYm8QPG8m3EsPKMjYMLoo5Z+hcPvtywlpNCxdVFJmRv6P7aVbWJ
hNe2GZ3pKfXCA6M5Bd7G3BE/313zb3m0p3t3kSAuhWAw8dFXvsSmooa4esR+Cim6
hmuF/u3oUaYNVLzodOx6jQzREH8evRl9ARf0DeW+Bz3dqZiuQH0ac+MPpqSK63hd
EfopMXqZoaOrqt4wFHWQJ0fjwzMVBfrYmYUBIZXEyBqtAgMBAAGjdTBzMB0GA1Ud
DgQWBBQ4uYUgEZSEW1I/CLk3yV6173mF7TAfBgNVHSMEGDAWgBQ4uYUgEZSEW1I/
CLk3yV6173mF7TAPBgNVHRMBAf8EBTADAQH/MCAGA1UdEQQZMBeCCWxvY2FsaG9z
dIcEfwAAAYcECgAABTANBgkqhkiG9w0BAQsFAAOCAQEAKCmzrltiUbFB42AmBk+v
fLaHYAXk/A3RDGQK2xZ7t6lXEEJGjtuBGXiQH7Hj+4OHfQS7M/sfjoClgjQVOMly
xY7c+oZgGS9wa8/9hmFicZyHtq/h/XvYu0cx3Ti/6+tkR8MPid4IdvjBYR4QFzpa
MPNnY8Gbd47k/lHuZ+VFSNLaYD/IUkmOCecyOxIQBlL8bzuWA3GSUm6gpP5ZfSfj
tOT21g5sqrlUvJiLZqRXebFYyNZ8vdBPrwrOIFSnJgpykN77w6ogliROjNMlmvEz
5K0amol4jx53nCggs0k9CkzUoGTGE3tuvl3xRA0m6+94vrNrw7JU+i5c7DnwMgMn
9A==
-----END CERTIFICATE-----`;

/** The names that certificate carries, so a test can ask for exactly those. */
const FIXTURE_HOSTS = ["localhost", "127.0.0.1", "10.0.0.5"];

/** A fake openssl that writes the files it was asked for, and records the call. */
function fakeOpenssl({ certificate = FIXTURE_CERT, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async execute(file, args) {
      calls.push({ file, args });
      if (fail) {
        throw new Error(fail);
      }
      const flag = (name) => args[args.indexOf(name) + 1];
      await writeFile(flag("-keyout"), "-----BEGIN PRIVATE KEY-----\nnot a real key\n-----END PRIVATE KEY-----\n");
      await writeFile(flag("-out"), certificate ?? "-----BEGIN CERTIFICATE-----\nnot a real certificate\n-----END CERTIFICATE-----\n");
      return { stdout: "", stderr: "" };
    },
  };
}

test("the names the certificate carries are the ones the machine answers to", () => {
  const hosts = certificateHosts({
    hostname: "zcloudium-host",
    interfaces: {
      eth0: [{ address: "192.168.51.224", family: "IPv4" }],
      docker0: [{ address: "172.17.0.1", family: "IPv4" }],
      lo: [
        { address: "127.0.0.1", family: "IPv4" },
        { address: "::1", family: "IPv6" },
      ],
      fe80: [{ address: "fe80::42:acff:fe11:2%eth0", family: "IPv6" }],
    },
  });
  for (const expected of [
    "localhost",
    "127.0.0.1",
    "::1",
    "zcloudium-host",
    "192.168.51.224",
    "172.17.0.1",
    "fe80::42:acff:fe11:2",
    // The families an operator's network names live in: a hostname is covered
    // without anybody declaring it, which is the whole point of the wildcards.
    "*.local",
    "*.lan",
    "*.internal",
  ]) {
    assert.ok(hosts.includes(expected), `${expected} must be in the certificate`);
  }
  // A zone index is not part of an address, and openssl refuses it in a SAN.
  assert.equal(hosts.some((host) => host.includes("%")), false);
  // Sorted and unique, so the argv is stable for a given machine.
  assert.deepEqual(hosts, [...new Set(hosts)].sort());
  // A machine with nothing to say still gets the loopback names and the families.
  assert.deepEqual(certificateHosts({ hostname: "  ", interfaces: {} }), [...DEFAULT_HOSTS].sort());
});

test("addresses are IP entries and names are DNS entries", () => {
  assert.equal(subjectAltNames(["localhost", "127.0.0.1", "::1", "nas.local"]), "DNS:localhost,IP:127.0.0.1,IP:::1,DNS:nas.local");
});

test("openssl is asked for a self-signed ECDSA certificate with those names", () => {
  const args = opensslArgs({ cert: "/data/tls/cert.pem", key: "/data/tls/key.pem", hosts: ["localhost", "10.0.0.5"], days: 30 });
  assert.deepEqual(args, [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-sha256",
    "-days",
    "30",
    "-nodes",
    "-keyout",
    "/data/tls/key.pem",
    "-out",
    "/data/tls/cert.pem",
    "-subj",
    "/CN=z-cloudium",
    "-addext",
    "subjectAltName=DNS:localhost,IP:10.0.0.5",
  ]);
  // P-256 rather than RSA: a handshake is an order of magnitude cheaper to sign,
  // for a curve everything agrees on. A certificate already on a volume is kept
  // whatever its algorithm, so the win applies to new certificates only.
  assert.ok(opensslArgs({ cert: "c", key: "k", hosts: [] }).includes("ec_paramgen_curve:P-256"));
  // The default lifetime is the one the module documents.
  assert.equal(opensslArgs({ cert: "c", key: "k", hosts: ["localhost"] })[8], String(TLS_DAYS));
  // -nodes is what keeps the key unencrypted, which is what a server needs: a
  // passphrase would have to be stored somewhere, which is worse than a file
  // mode of 600 on a volume only this container can read.
  assert.ok(opensslArgs({ cert: "c", key: "k", hosts: [] }).includes("-nodes"));
});

test("a certificate is generated when there is none, and the key is written for its owner only", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "zcloudium-tls-"));
  try {
    const openssl = fakeOpenssl();
    const logs = [];
    const result = await loadOrCreateCertificate({
      dataDir,
      hosts: ["localhost", "10.0.0.5"],
      logger: (line) => logs.push(line),
      execute: openssl.execute,
    });
    assert.equal(openssl.calls.length, 1);
    assert.equal(openssl.calls[0].file, "openssl");
    assert.deepEqual(openssl.calls[0].args.slice(0, 3), ["req", "-x509", "-newkey"]);
    const paths = certificatePaths(dataDir);
    assert.equal(await readFile(paths.cert, "utf8"), result.cert);
    assert.equal(result.created, true);
    assert.ok(logs.some((line) => /generated a self-signed certificate/.test(line)), "the operator has to learn about the warning");
    assert.ok(
      logs.some((line) => /10\.0\.0\.5/.test(line)),
      "the log must name what the certificate covers",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an unusable certificate is replaced rather than trusted", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "zcloudium-tls-"));
  try {
    const paths = certificatePaths(dataDir);
    const openssl = fakeOpenssl();
    const logs = [];
    // Something that is not a certificate: a truncated file, a placeholder, a
    // file somebody edited. Loading it must not be fatal, and must not be kept.
    await loadOrCreateCertificate({ dataDir, hosts: ["localhost"], logger: () => {}, execute: openssl.execute });
    await writeFile(paths.cert, "-----BEGIN CERTIFICATE-----\ntruncated\n");
    openssl.calls.length = 0;
    await loadOrCreateCertificate({
      dataDir,
      hosts: ["localhost"],
      logger: (line) => logs.push(line),
      execute: openssl.execute,
    });
    assert.equal(openssl.calls.length, 1, "an unreadable certificate must be generated again");
    assert.ok(logs.some((line) => /could not be read/.test(line)));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a certificate without a data directory is refused", async () => {
  await assert.rejects(() => loadOrCreateCertificate({}), /requires a dataDir/);
});
