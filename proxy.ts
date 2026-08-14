import { auth } from "@/auth";
import { NextResponse, after } from "next/server";
import { identityHost } from "@/lib/identity";
import { scopeForUser } from "@/lib/access";
import { ADMIN_GATE_COOKIE, verifyAdminGateToken } from "@/lib/admin-gate";
import { appendPageview, appendAnonVisit } from "@/lib/store";
import { truncateIp, clientIpFrom } from "@/lib/pageviews";

/**
 * Next 16 proxy (formerly middleware): every route except /login and the
 * NextAuth endpoints requires a session. Security headers are applied to
 * every response, including redirects.
 *
 * Full-access admins face a second gate on top of that, checked here rather
 * than per-page so it covers every route — pages, API routes, and the POST a
 * server action's own button submits — in one place: full access is what
 * carries "View as" (impersonating anyone), and a same-day fix for a few IT
 * staff holding that needs to close every door, not just the dashboard's.
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

// The gate's own page: must stay reachable by a signed-in admin who hasn't
// passed it yet, or there is no way to ever pass it.
const ADMIN_GATE_PATH = "/admin-gate";

/**
 * Whether this request represents someone actually looking at a page, as
 * opposed to an API call, a static asset, or the browser speculatively
 * prefetching a route it hasn't navigated to. Only GET requests outside
 * /api qualify; `next-router-prefetch` is Next's own header for hover/viewport
 * prefetch (see node_modules/next/dist/client/components/app-router-headers.js)
 * and must not be counted as a visit. A soft client-side navigation the user
 * actually triggered still carries the `rsc` header but not the prefetch one,
 * so it's still counted.
 */
function isLoggablePageview(req: {
  method: string;
  nextUrl: { pathname: string };
  headers: Headers;
}): boolean {
  return (
    req.method === "GET" &&
    !req.nextUrl.pathname.startsWith("/api") &&
    !req.headers.get("next-router-prefetch")
  );
}

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

export default auth(async (req) => {
  const { pathname } = req.nextUrl;
  const isPublic =
    PUBLIC_PATHS.includes(pathname) ||
    pathname.startsWith("/api/auth") ||
    // local-only convenience login; the route 404s outside `next dev`
    pathname.startsWith("/dev/login");

  const email = req.auth?.user?.email;

  // Durable visitor logging — see lib/store.ts (kestrel:pageviews:fy26 /
  // kestrel:visits:anon:fy26) and /admin/visitors. Scheduled with `after()` so
  // the write never delays the redirect/response below.
  if (isLoggablePageview(req)) {
    if (email) {
      const name = req.auth?.user?.name ?? undefined;
      after(() =>
        appendPageview({ ts: new Date().toISOString(), path: pathname, email, name })
      );
    } else if (!isPublic) {
      // Anonymous and not one of the always-open paths (that excludes /login
      // itself) — this is a random visitor's attempt to reach a real page.
      const ipPrefix = (() => {
        const ip = clientIpFrom(req.headers);
        return ip ? truncateIp(ip) : null;
      })();
      after(() =>
        appendAnonVisit({ ts: new Date().toISOString(), path: pathname, ipPrefix })
      );
    }
  }

  if (!email && !isPublic) {
    const loginUrl = new URL("/login", req.nextUrl.origin);
    if (pathname !== "/") loginUrl.searchParams.set("callbackUrl", pathname);
    return applySecurityHeaders(NextResponse.redirect(loginUrl));
  }

  // Signed in, and somewhere real (not the gate page itself, and not one of
  // the always-open paths above): full admins need the password too.
  if (email && !isPublic && pathname !== ADMIN_GATE_PATH) {
    const scope = await scopeForUser(email);
    if (scope?.canEdit) {
      const token = req.cookies.get(ADMIN_GATE_COOKIE)?.value;
      if (!verifyAdminGateToken(email, token)) {
        const gateUrl = new URL(ADMIN_GATE_PATH, req.nextUrl.origin);
        if (pathname !== "/") gateUrl.searchParams.set("callbackUrl", pathname);
        return applySecurityHeaders(NextResponse.redirect(gateUrl));
      }
    }
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
