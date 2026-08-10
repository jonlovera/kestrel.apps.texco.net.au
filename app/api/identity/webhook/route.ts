import { NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import { revokeSessions } from "@/lib/identity-users";

export const dynamic = "force-dynamic";

/**
 * Revocation notifications from Texco Identity: offboarding
 * (`user.deactivated`) and single logout (`user.logged_out`).
 *
 * Sessions here are stateless JWTs, so there is nothing to delete and no way
 * to enumerate the sessions one person holds. Bumping their epoch ends all of
 * them on their next request instead.
 *
 * Authenticated by HMAC signature, not by session or token middleware — this
 * is machine to machine. proxy.ts has to let the path through, or every
 * delivery would 302 to /login and identity would retry forever.
 */
export async function POST(req: Request) {
  // read the raw bytes before parsing: the signature covers what was sent
  const rawBody = await req.text();

  const verdict = verifyWebhookSignature({
    secret: process.env.IDENTITY_WEBHOOK_SECRET,
    signature: req.headers.get("X-Webhook-Signature"),
    timestamp: req.headers.get("X-Webhook-Timestamp"),
    rawBody,
  });

  if (!verdict.ok) {
    if (verdict.reason === "unconfigured") {
      console.error(
        "[identity] webhook received but IDENTITY_WEBHOOK_SECRET is not set"
      );
      return NextResponse.json({ message: "Not configured." }, { status: 503 });
    }
    console.warn(`[identity] webhook rejected: ${verdict.reason}`);
    return NextResponse.json({ message: "Invalid signature." }, { status: 401 });
  }

  let payload: {
    event?: string;
    m365_id?: string;
    user_email?: string;
    reason?: string;
  };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ message: "Invalid payload." }, { status: 400 });
  }

  const event = String(payload.event ?? "");
  // Anything else is acknowledged rather than refused, so identity does not
  // treat an event we simply don't act on as a delivery failure.
  if (event !== "user.deactivated" && event !== "user.logged_out") {
    return NextResponse.json({ message: "Ignored." }, { status: 202 });
  }

  const revoked = await revokeSessions(
    payload.m365_id ?? null,
    payload.user_email ?? null
  );

  if (!revoked) {
    // Identity knows about everyone; this app has only seen the people who
    // have signed in here. Not an error.
    return NextResponse.json({ message: "Unknown user." }, { status: 202 });
  }

  if (event === "user.deactivated") {
    console.warn(
      `[identity] account deactivated; sessions invalid email=${revoked.user.email} m365=${revoked.m365Id} reason=${payload.reason ?? "-"} epoch=${revoked.user.epoch}`
    );
  } else {
    console.log(
      `[identity] single logout; sessions ended email=${revoked.user.email} epoch=${revoked.user.epoch}`
    );
  }

  const res = NextResponse.json({ message: "Revoked." }, { status: 200 });
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}
