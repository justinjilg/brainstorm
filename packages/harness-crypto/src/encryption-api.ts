/**
 * Encryption API surface — typed contracts plus thin wrappers over the
 * `age` CLI subprocess (see ./age-cli.ts).
 *
 * **v1 status.** The bodies that wrap age now do real work; the higher-
 * level orchestration (recipient resolution from bundle name, audit-log
 * encryption, master-identity bootstrap UX, sops integration) is the
 * v1.5 deliverable. This file's job is the safe, typed CLI bridge.
 *
 * Source-of-truth spec: ~/.claude/plans/snuggly-sleeping-hinton.md
 *   - `## Sensitive Data + GitHub Security + PQC` §3.3 (recommended stack)
 *   - PQC §4.4 (decryption flow), §4.5 (audit trail), §4.6 (recipient rotation)
 *   - PQC §7.1 / §7.2 (v1 vs v1.5 ship)
 */

import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  ageEncryptToFile,
  ageDecryptFile,
  ageKeygen,
  isAgeAvailable,
  isAgeKeygenAvailable,
} from "./age-cli.js";
import type { RecipientBundle } from "./recipient-bundle.js";

/** Sensitivity tier per Decision #4 + PQC §4.1. */
export type SensitivityTier = "T0" | "T1" | "T2" | "T3" | "T4";

export interface AgeIdentityHandle {
  /** Stable id; looked up from packages/vault. */
  id: string;
  /** Path to the identity file on disk (age-format secret key). The
   *  caller (typically packages/vault) materializes the secret to a
   *  short-lived file in tmpfs/ramdisk and passes the path here. */
  identity_file: string;
  /** Whether this is a hardware-backed key (YubiKey / TPM); informational. */
  hardware_backed: boolean;
}

export interface AuditContext {
  actor_type: "human" | "agent";
  actor_ref: string;
  reason: string;
  at: string;
}

export interface DecryptRequest {
  encryptedPath: string;
  identity: AgeIdentityHandle;
  audit: AuditContext;
}

export interface DecryptResult {
  plaintext: string;
  plaintext_sha256: string;
  /** Bundle id this file claimed (read from the recipient bundle). NOT
   *  necessarily the bundle the identity belongs to (caller may have
   *  multi-bundle access). */
  bundle_id: string | null;
}

export interface EncryptRequest {
  outputPath: string;
  plaintext: string | Buffer;
  bundle: RecipientBundle;
  audit: AuditContext;
}

export interface EncryptResult {
  outputPath: string;
  plaintext_sha256: string;
  ciphertext_sha256: string;
  bundle_id: string;
  bundle_version: number;
}

/**
 * Encrypt content to a recipient bundle. Writes the ciphertext to
 * `outputPath`; returns hashes + bundle metadata for envelope generation.
 *
 * Caller responsibilities (NOT done here):
 *   - Generate a `*.envelope.toml` companion with hashes + signer (PQC §4.5)
 *   - Append an audit-log entry to `.harness/audit/decrypt-log.md`
 *     (encrypted to founder + archive identity)
 *   - Verify the destination matches the privilege firewall constraints
 */
export async function encrypt(req: EncryptRequest): Promise<EncryptResult> {
  if (!(await isAgeAvailable())) {
    throw new Error(
      "encrypt(): age binary not found on $PATH. Install via `brew install age` (macOS) or your package manager.",
    );
  }
  if (req.bundle.recipients.length === 0) {
    throw new Error("encrypt(): bundle has no recipients");
  }

  const recipients = req.bundle.recipients.map((r) => r.public_key);
  await ageEncryptToFile({
    plaintext: req.plaintext,
    recipients,
    outputPath: req.outputPath,
  });

  const plaintext_sha256 = sha256(req.plaintext);
  const ciphertext_sha256 = sha256(readFileSync(req.outputPath));

  return {
    outputPath: req.outputPath,
    plaintext_sha256,
    ciphertext_sha256,
    bundle_id: req.bundle.id,
    bundle_version: req.bundle.version,
  };
}

/**
 * Decrypt a file using the given identity. Reads the encrypted file,
 * shells out to `age -d`, returns the plaintext + content hash for
 * audit-log purposes.
 *
 * The caller is responsible for:
 *   - Validating the caller has capability to read the file (per agent
 *     capability model, Decision #12)
 *   - Writing the audit-log entry AFTER the decrypt succeeds
 *   - NOT persisting the plaintext outside tmpfs/ramdisk per PQC §4.4
 */
export async function decrypt(req: DecryptRequest): Promise<DecryptResult> {
  if (!(await isAgeAvailable())) {
    throw new Error("decrypt(): age binary not found on $PATH");
  }

  const plaintext = await ageDecryptFile({
    encryptedPath: req.encryptedPath,
    identityFile: req.identity.identity_file,
  });

  return {
    plaintext,
    plaintext_sha256: sha256(plaintext),
    bundle_id: null, // Reading the bundle id from the file header is a v1.5 enhancement
  };
}

/**
 * Generate a fresh PQ-hybrid age identity (ML-KEM-768 + X25519). Used by
 * `brainstorm harness init` to mint the founder's master identity, by
 * `brainstorm harness recipients add` for new team members, and by
 * `brainstorm harness agents create` for new agent identities (Decision #12).
 *
 * The caller stores the secret_key via packages/vault and adds the
 * public_key to the appropriate recipient bundle via a ChangeSet.
 */
export async function generatePqIdentity(): Promise<{
  public_key: string;
  secret_key: string;
}> {
  if (!(await isAgeKeygenAvailable())) {
    throw new Error(
      "generatePqIdentity(): age-keygen binary not found on $PATH",
    );
  }
  return ageKeygen({ pq: true });
}

/** Generate a non-PQ (classical X25519) identity — used for agents and
 *  team members who do not need HNDL defense in v1. */
export async function generateClassicalIdentity(): Promise<{
  public_key: string;
  secret_key: string;
}> {
  if (!(await isAgeKeygenAvailable())) {
    throw new Error(
      "generateClassicalIdentity(): age-keygen binary not found on $PATH",
    );
  }
  return ageKeygen({ pq: false });
}

/** True when both age and age-keygen are usable; false otherwise. The
 *  desktop calls this at startup to decide whether the encryption pipeline
 *  is operational and surface guidance to the user when it's not. */
export async function isEncryptionPipelineReady(): Promise<boolean> {
  return (await isAgeAvailable()) && (await isAgeKeygenAvailable());
}

/**
 * Plaintext envelope companion for an encrypted artifact (PQC §4.5).
 * Records the chain of custody so auditors can verify provenance without
 * holding decryption keys.
 */
export interface EnvelopeCompanion {
  artifact: string;
  plaintext_sha256: string;
  ciphertext_sha256: string;
  bundles_used: string[];
  signer: string;
  signature?: string;
  created_at: string;
  schema: string;
  summary_redacted?: string;
}

/** Build envelope path for an encrypted artifact:
 *  `team/feedback/jane.md.age` → `team/feedback/jane.md.age.envelope.toml`. */
export function envelopePath(encryptedPath: string): string {
  return `${encryptedPath}.envelope.toml`;
}

/** Persist an envelope companion as plaintext TOML alongside its artifact. */
export function writeEnvelope(
  encryptedPath: string,
  envelope: EnvelopeCompanion,
): void {
  const lines = [
    `artifact         = ${quote(envelope.artifact)}`,
    `plaintext_sha256 = ${quote(envelope.plaintext_sha256)}`,
    `ciphertext_sha256 = ${quote(envelope.ciphertext_sha256)}`,
    `bundles_used     = [${envelope.bundles_used.map(quote).join(", ")}]`,
    `signer           = ${quote(envelope.signer)}`,
    envelope.signature ? `signature        = ${quote(envelope.signature)}` : "",
    `created_at       = ${quote(envelope.created_at)}`,
    `schema           = ${quote(envelope.schema)}`,
    envelope.summary_redacted
      ? `summary_redacted = ${quote(envelope.summary_redacted)}`
      : "",
  ].filter(Boolean);
  writeFileSync(envelopePath(encryptedPath), lines.join("\n") + "\n", {
    encoding: "utf-8",
  });
}

function quote(s: string): string {
  // TOML basic-string with conservative escapes
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function sha256(content: string | Buffer): string {
  return createHash("sha256")
    .update(
      typeof content === "string" ? Buffer.from(content, "utf-8") : content,
    )
    .digest("hex");
}
