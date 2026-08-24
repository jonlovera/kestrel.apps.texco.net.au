import { signIn } from "@/auth";
import {
  PREVIEW_LOGIN_ID,
  devConvenienceLoginEnabled,
} from "@/lib/preview-login";

export const dynamic = "force-dynamic";

/**
 * Local-only convenience login, mirroring the tools app's
 * GET /dev/login/{email} (routes/web.php, env-guarded). Signs in as any email
 * through the shared-password provider — which only exists outside production
 * and only with a password configured, so this 404s everywhere else.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ email: string }> }
) {
  if (!devConvenienceLoginEnabled()) {
    return new Response("Not found", { status: 404 });
  }
  const { email } = await params;
  await signIn(PREVIEW_LOGIN_ID, {
    email: decodeURIComponent(email),
    // Injected server-side so the shortcut stays a one-click affair without
    // the shared password ever appearing in a URL or browser history.
    password: process.env.PREVIEW_LOGIN_PASSWORD ?? "",
    redirectTo: "/",
  });
}
