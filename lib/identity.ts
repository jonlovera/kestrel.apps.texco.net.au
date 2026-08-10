import type { OAuthConfig } from "next-auth/providers";

/**
 * Texco Identity as an OAuth2 provider.
 *
 * Identity is a Laravel Passport server that performs the Microsoft Entra
 * sign-in itself, so this app no longer talks to Microsoft for login at all —
 * it talks to identity, and a session established in any other Texco app is
 * honoured here without the user seeing anything but their destination.
 *
 * The integration guide for this is written for Laravel + Socialite; this is
 * the same flow expressed as a NextAuth provider. Passport speaks standard
 * OAuth2, so only the endpoints and the profile shape differ.
 */

export const IDENTITY_PROVIDER_ID = "texco-identity";

export function identityHost(): string {
  return (process.env.IDENTITY_URL ?? "https://identity.texco.net.au").replace(
    /\/+$/,
    ""
  );
}

/** Where identity sends the browser to end its own session and notify every app. */
export function identityLogoutUrl(): string {
  return `${identityHost()}/logout`;
}

/** The raw userinfo payload, as much of it as we rely on. */
export interface IdentityProfile {
  id?: number | string;
  /** the stable Entra object id — the thing worth matching on */
  m365_id?: string;
  name?: string;
  email?: string;
  avatar?: string;
  /**
   * Offboarded people keep an Entra login until IT removes it, so identity
   * flags them and every downstream app has to refuse the session.
   */
  is_active?: boolean;
}

/** What the provider hands to the callbacks, once mapped. */
export interface IdentityUserResult {
  id: string;
  email: string;
  name: string;
  image?: string;
  m365Id?: string;
  isActive: boolean;
}

export function texcoIdentity(): OAuthConfig<IdentityProfile> {
  const host = identityHost();
  // Passport's userinfo route isn't fixed by the spec; the Socialite provider
  // defaults to /api/user. Configurable rather than assumed, so a difference
  // is one env var and not a code change.
  const userinfoPath = process.env.IDENTITY_USERINFO_PATH ?? "/api/user";

  return {
    id: IDENTITY_PROVIDER_ID,
    name: "Texco Identity",
    type: "oauth",
    authorization: { url: `${host}/oauth/authorize`, params: { scope: "" } },
    token: `${host}/oauth/token`,
    userinfo: `${host}${userinfoPath}`,
    clientId: process.env.IDENTITY_CLIENT_ID,
    clientSecret: process.env.IDENTITY_CLIENT_SECRET,
    // Passport issues confidential-client codes; state is the check it
    // supports. There is no discovery document to read PKCE support from.
    checks: ["state"],
    profile: (profile) => mapIdentityProfile(profile),
  };
}

/**
 * Pure so the mapping is testable without an OAuth round trip.
 *
 * `is_active` absent means active: an older identity that doesn't send the
 * field must not lock every user out of every app.
 */
export function mapIdentityProfile(profile: IdentityProfile): IdentityUserResult {
  return {
    id: profile.m365_id ?? String(profile.id ?? profile.email ?? ""),
    email: (profile.email ?? "").toLowerCase(),
    name: profile.name ?? profile.email ?? "",
    image: profile.avatar,
    m365Id: profile.m365_id,
    isActive: profile.is_active !== false,
  };
}
