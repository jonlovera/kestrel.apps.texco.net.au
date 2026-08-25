import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The remuneration letter template is read from disk at request time, so it
  // has to be traced into the serverless bundle — nothing imports it, and the
  // tracer only follows imports.
  outputFileTracingIncludes: {
    // Covers the brand fonts under lib/templates/fonts too, which LibreOffice
    // needs on disk or the PDF comes out in a substituted typeface.
    "/api/letter": ["./lib/templates/**"],
  },
  async rewrites() {
    return [
      // A safety net, not the contract. Auth.js derives its own redirect_uri
      // from AUTH_URL and sends /api/auth/callback/texco-identity — that is
      // what must be registered at identity. This only means anything still
      // pointing at the Laravel-convention /auth/callback lands somewhere
      // sensible rather than a 404.
      {
        source: "/auth/callback",
        destination: "/api/auth/callback/texco-identity",
      },
    ];
  },
};

export default nextConfig;
