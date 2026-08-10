import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { identityHost } from "@/lib/identity";

/**
 * Next 16 proxy (formerly middleware): every route except /login and the
 * NextAuth endpoints requires a session. Security headers are applied to
 * every response, including redirects.
 */
const PUBLIC_PATHS = [
  "/login",
  // the OAuth round trip with Texco Identity
  "/auth/redirect",
  "/auth/callback",
  // ends the local session before handing the browser to identity
  "/logout",
  // Machine-to-machine callback from identity, authenticated by HMAC inside
  // the handler. Without this it would 302 to /login and identity would read
  // every delivery as a failure and retry forever.
  "/api/identity/webhook",
];

function applySecurityHeaders(res: NextResponse): NextResponse {
  const isDev = process.env.NODE_ENV === "development";
  // Next.js requires inline script/style without nonce plumbing; dev mode
  // additionally needs eval for react-refresh. Noted in README hardening list.
  // Sign-in now goes to Texco Identity, not straight to Microsoft — identity
  // performs the Entra hop itself. Read from the env rather than hardcoded,
  // because local development points at http://localhost:8001.
  const identity = identityHost();
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    // identity serves user avatars
    `img-src 'self' data: ${identity}`,
    "font-src 'self' data:",
    `connect-src 'self' ${identity}`,
    `form-action 'self' ${identity}`,
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
  // Everything except Next internals and static assets.
  //
  // Fonts have to be here: they are requested by the login page itself, which
  // a signed-out visitor sees, so gating them would redirect the request to
  // /login and the brand type would silently fall back to Arial for exactly
  // the people who aren't signed in yet.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|fonts/|.*\\.(?:png|svg|ico|woff2?)$).*)",
  ],
};
