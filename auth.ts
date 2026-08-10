import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import type { Provider } from "next-auth/providers";
import { texcoIdentity, IDENTITY_PROVIDER_ID } from "@/lib/identity";

/**
 * Sign-in is delegated to Texco Identity, the company's single sign-on
 * provider. Identity performs the Microsoft Entra sign-in itself, so this app
 * never talks to Microsoft for login: a session established in any other Texco
 * app carries across, signing out of one signs out of all, and deactivating
 * someone in identity ends their access here too.
 *
 * Authorisation is separate and unchanged — lib/access.ts decides what each
 * email may see, and identity has no say in it.
 */
const providers: Provider[] = [texcoIdentity()];


// Local-only dev backdoor, so the app can be worked on without an identity
// server running. Never registered outside `next dev`.
if (process.env.NODE_ENV === "development" && process.env.DEV_LOGIN === "1") {
  providers.push(
    Credentials({
      id: "dev-login",
      name: "Dev login (local only)",
      credentials: { email: { label: "Email" } },
      authorize: (creds) => {
        const email = typeof creds?.email === "string" ? creds.email : "";
        if (!email.includes("@")) return null;
        return { email, name: `Dev: ${email}` };
      },
    })
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: {
    strategy: "jwt",
    maxAge: 8 * 60 * 60, // 8 hours, per brief
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    /**
     * Refuse a deactivated account at the door. Identity flags people who
     * have been offboarded but whose Entra login IT hasn't removed yet.
     */
    signIn({ user, account }) {
      if (account?.provider !== IDENTITY_PROVIDER_ID) return true;
      const active = (user as { isActive?: boolean }).isActive;
      if (active === false) return "/login?error=AccountDeactivated";
      return true;
    },

    /**
     * Carry the stable Entra id and the session epoch on the token. The epoch
     * is stamped once at sign-in and compared in the session callback below,
     * which is what lets a webhook end sessions it cannot enumerate.
     */
    async jwt({ token, user, account }) {
      // The dev backdoor takes the same path as identity, with a synthetic id,
      // so local development exercises the real revocation gate rather than a
      // shortcut around it. It is already NODE_ENV-gated.
      const viaIdentity =
        account?.provider === IDENTITY_PROVIDER_ID ||
        account?.provider === "dev-login";

      if (user && viaIdentity) {
        const m365Id =
          (user as { m365Id?: string }).m365Id ??
          (account?.provider === "dev-login" ? `dev:${user.email}` : undefined);
        if (m365Id) {
          const { rememberIdentityUser } = await import("@/lib/identity-users");
          const { adoptNewEmail } = await import("@/lib/access");
          const email = (user.email ?? "").toLowerCase();
          const previous = await rememberIdentityUser(
            m365Id,
            email,
            user.name ?? undefined
          );
          // an email change in Entra must not silently cost them their access
          if (previous && previous.email.toLowerCase() !== email) {
            await adoptNewEmail(previous.email, email);
          }
          token.m365Id = m365Id;
          token.epoch = previous?.epoch ?? 0;
        }
      }
      return token;
    },

    /**
     * Where revocation actually bites.
     *
     * This runs wherever `auth()` is called — including proxy.ts, which gates
     * every request — so dropping the user here is what ends a revoked
     * session. It deliberately does NOT live in the `authorized` callback:
     * proxy.ts wraps `auth()` with its own check rather than exporting it
     * directly, so `authorized` is never consulted.
     */
    async session({ session, token }) {
      const m365Id = token.m365Id as string | undefined;
      const stamped = token.epoch as number | undefined;

      if (session.user) {
        (session.user as { m365Id?: string }).m365Id = m365Id;
      }

      // Sessions predating this — and the password provider — carry no stamp.
      // Treat them as current rather than logging everyone out on deploy; the
      // epoch only ever moves on a real revocation.
      if (!m365Id || typeof stamped !== "number") return session;

      try {
        const { currentEpoch } = await import("@/lib/identity-users");
        if (stamped !== (await currentEpoch(m365Id))) {
          console.log(
            `[identity] session revoked email=${session.user?.email} stamped=${stamped}`
          );
          // no user ⇒ proxy.ts redirects to /login, and every page's own
          // `session?.user?.email` check fails too
          return { ...session, user: undefined } as unknown as typeof session;
        }
      } catch (err) {
        // A storage outage must not lock everyone out of the tool; reads fail
        // soft everywhere else in this app for the same reason.
        console.error("[identity] could not check the session epoch:", err);
      }
      return session;
    },

  },
});
