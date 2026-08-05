import { auth } from "@/auth";
import { NextResponse } from "next/server";

/**
 * Next 16 proxy (formerly middleware): every route except /login and the
 * NextAuth endpoints requires a session. Security headers are applied to
 * every response, including redirects.
 */
const PUBLIC_PATHS = ["/login"];

function applySecurityHeaders(res: NextResponse): NextResponse {
  const isDev = process.env.NODE_ENV === "development";
  // Next.js requires inline script/style without nonce plumbing; dev mode
  // additionally needs eval for react-refresh. Noted in README hardening list.
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self' https://login.microsoftonline.com",
    "form-action 'self' https://login.microsoftonline.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ].join("; ");

  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isPublic =
    PUBLIC_PATHS.includes(pathname) ||
    pathname.startsWith("/api/auth") ||
    // local-only convenience login; the route 404s outside `next dev`
    pathname.startsWith("/dev/login");

  if (!req.auth?.user?.email && !isPublic) {
    const loginUrl = new URL("/login", req.nextUrl.origin);
    if (pathname !== "/") loginUrl.searchParams.set("callbackUrl", pathname);
    return applySecurityHeaders(NextResponse.redirect(loginUrl));
  }

  return applySecurityHeaders(NextResponse.next());
});

export const config = {
  // Everything except Next internals and static assets
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|ico)$).*)"],
};
