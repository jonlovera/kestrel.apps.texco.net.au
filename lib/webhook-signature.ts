import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verification for Texco Identity's webhook deliveries — pure, so every
 * failure mode is testable without an HTTP request.
 *
 * The HMAC is over `{timestamp}.{raw body}`. The RAW body matters:
 * re-serialising the parsed JSON would not reproduce identity's `json_encode`
 * byte for byte, and the signature is over the bytes actually sent.
 */

/** How far out of step a delivery's timestamp may be before it is rejected. */
export const MAX_CLOCK_SKEW_SECONDS = 300;

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "unconfigured" | "malformed" | "stale" | "mismatch" };

export function verifyWebhookSignature(opts: {
  secret: string | undefined;
  signature: string | null;
  timestamp: string | null;
  rawBody: string;
  now?: number;
}): VerifyResult {
  // Fail closed. An unset secret must never mean "accept anything".
  if (!opts.secret) return { ok: false, reason: "unconfigured" };

  const signature = opts.signature ?? "";
  const timestamp = opts.timestamp ?? "";
  if (!signature || !/^\d+$/.test(timestamp)) {
    return { ok: false, reason: "malformed" };
  }

  // Without this a captured delivery replays forever.
  const now = opts.now ?? Date.now();
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: "stale" };
  }

  const expected =
    "sha256=" +
    createHmac("sha256", opts.secret)
      .update(`${timestamp}.${opts.rawBody}`)
      .digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // timingSafeEqual throws on a length mismatch, which is itself the answer
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}
