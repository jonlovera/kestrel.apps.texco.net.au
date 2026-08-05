import { signIn } from "@/auth";

export const dynamic = "force-dynamic";

/** GET /dev/login — defaults to jlovera, like tools defaults to bellett. */
export async function GET() {
  if (process.env.NODE_ENV !== "development" || process.env.DEV_LOGIN !== "1") {
    return new Response("Not found", { status: 404 });
  }
  await signIn("dev-login", {
    email: "jlovera@texco.net.au",
    redirectTo: "/",
  });
}
