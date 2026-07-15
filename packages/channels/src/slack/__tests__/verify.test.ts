import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "../verify.js";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a";

function sign(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

describe("verifySlackSignature", () => {
  it("accepts a valid signature computed with the real HMAC algorithm", () => {
    const timestamp = "1531420618";
    const body =
      "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&api_app_id=A2H9RRUZM";
    const signature = sign(SIGNING_SECRET, timestamp, body);
    const nowSeconds = 1531420618;

    expect(
      verifySlackSignature(
        SIGNING_SECRET,
        timestamp,
        body,
        signature,
        nowSeconds,
      ),
    ).toBe(true);
  });

  it("rejects when the body has been tampered with", () => {
    const timestamp = "1531420618";
    const body =
      "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&api_app_id=A2H9RRUZM";
    const signature = sign(SIGNING_SECRET, timestamp, body);
    const tamperedBody = body + "&evil=true";

    expect(
      verifySlackSignature(
        SIGNING_SECRET,
        timestamp,
        tamperedBody,
        signature,
        1531420618,
      ),
    ).toBe(false);
  });

  it("rejects an expired timestamp (older than 300s)", () => {
    const timestamp = "1531420618";
    const body =
      "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&api_app_id=A2H9RRUZM";
    const signature = sign(SIGNING_SECRET, timestamp, body);
    const farFuture = 1531420618 + 301;

    expect(
      verifySlackSignature(
        SIGNING_SECRET,
        timestamp,
        body,
        signature,
        farFuture,
      ),
    ).toBe(false);
  });

  it("does not throw when the signature has the wrong length", () => {
    const timestamp = "1531420618";
    const body = "token=abc";
    expect(() =>
      verifySlackSignature(
        SIGNING_SECRET,
        timestamp,
        body,
        "v0=short",
        1531420618,
      ),
    ).not.toThrow();
    expect(
      verifySlackSignature(
        SIGNING_SECRET,
        timestamp,
        body,
        "v0=short",
        1531420618,
      ),
    ).toBe(false);
  });

  it("rejects a non-numeric timestamp without throwing", () => {
    expect(() =>
      verifySlackSignature(
        SIGNING_SECRET,
        "not-a-number",
        "body",
        "v0=deadbeef",
        1531420618,
      ),
    ).not.toThrow();
    expect(
      verifySlackSignature(
        SIGNING_SECRET,
        "not-a-number",
        "body",
        "v0=deadbeef",
        1531420618,
      ),
    ).toBe(false);
  });
});
