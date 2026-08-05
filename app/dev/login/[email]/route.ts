import { signIn } from "@/auth";

export const dynamic = "force-dynamic";

/**
 * Local-only convenience login, mirroring the tools app's
 * GET /dev/login/{email} (routes/web.php, env-guarded). Signs in as any email
 * via the dev-login credentials provider — which only exists during
 * `next dev` with DEV_LOGIN=1, so this 404s everywhere else.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ email: string }> }
) {
  if (process.env.NODE_ENV !== "development" || process.env.DEV_LOGIN !== "1") {
    return new Response("Not found", { status: 404 });
  }
  const { email } = await params;
  await signIn("dev-login", {
    email: decodeURIComponent(email),
    redirectTo: "/",
  });
}
