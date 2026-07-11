import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Slack request signature per Slack's signing-secret scheme:
 * v0=hex(hmac_sha256(secret, "v0:" + timestamp + ":" + body))
 *
 * Rejects requests whose timestamp is more than 5 minutes (300s) away from
 * `nowSeconds` (defaults to current time) to guard against replay attacks.
 */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return false;
  }
  if (Math.abs(nowSeconds - ts) > 300) {
    return false;
  }

  const baseString = `v0:${timestamp}:${rawBody}`;
  const computed = `v0=${createHmac("sha256", signingSecret).update(baseString).digest("hex")}`;

  const computedBuf = Buffer.from(computed, "utf8");
  const signatureBuf = Buffer.from(signature, "utf8");

  if (computedBuf.length !== signatureBuf.length) {
    return false;
  }

  return timingSafeEqual(computedBuf, signatureBuf);
}
