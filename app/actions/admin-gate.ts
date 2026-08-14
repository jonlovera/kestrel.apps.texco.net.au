"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { scopeForUser } from "@/lib/access";
import { checkAdminPassword, adminGateToken, ADMIN_GATE_COOKIE } from "@/lib/admin-gate";
import { appendHistory } from "@/lib/store";

/**
 * Verifies the shared admin password and, on success, marks this browser
 * session as gate-passed for this email. Re-resolves the signed-in user and
 * their scope itself rather than trusting anything the page sent — the same
 * caution every other mutating action in this app takes.
 */
export async function verifyAdminPassword(formData: FormData) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect("/login");

  const scope = await scopeForUser(email);
  if (!scope?.canEdit) redirect("/");

  const callbackUrl = String(formData.get("callbackUrl") ?? "");
  const destination = callbackUrl.startsWith("/") ? callbackUrl : "/";
  const password = String(formData.get("password") ?? "");

  if (!checkAdminPassword(password)) {
    console.log(
      `[audit] admin-gate-fail email=${email} ts=${new Date().toISOString()}`
    );
    const retry = `/admin-gate?error=1${
      callbackUrl ? `&callbackUrl=${encodeURIComponent(callbackUrl)}` : ""
    }`;
    redirect(retry);
  }

  (await cookies()).set(ADMIN_GATE_COOKIE, adminGateToken(email), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // No maxAge: a session cookie, gone when the browser fully closes — the
    // password is required "every time you open the app", not once ever.
  });

  await appendHistory([
    {
      ts: new Date().toISOString(),
      actor: email,
      kind: "access",
      summary: "Verified the admin password for this browser session",
    },
  ]);
  console.log(
    `[audit] admin-gate-ok email=${email} ts=${new Date().toISOString()}`
  );

  redirect(destination);
}
