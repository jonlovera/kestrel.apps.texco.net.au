import { signIn } from "@/auth";
import {
  PREVIEW_LOGIN_ID,
  devConvenienceLoginEnabled,
} from "@/lib/preview-login";

export const dynamic = "force-dynamic";

/** GET /dev/login — defaults to jlovera, like tools defaults to bellett. */
export async function GET() {
  if (!devConvenienceLoginEnabled()) {
    return new Response("Not found", { status: 404 });
  }
  await signIn(PREVIEW_LOGIN_ID, {
    email: "jlovera@texco.net.au",
    // Injected server-side so the shortcut stays a one-click affair without
    // the shared password ever appearing in a URL or browser history.
    password: process.env.PREVIEW_LOGIN_PASSWORD ?? "",
    redirectTo: "/",
  });
}
