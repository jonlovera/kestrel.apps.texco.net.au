import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import Credentials from "next-auth/providers/credentials";
import type { Provider } from "next-auth/providers";

/**
 * Microsoft Entra ID single-tenant sign-in — the same method as the tools app
 * (there: Laravel Socialite `azure` driver). The tenant restriction is the
 * gatekeeper: only accounts in the Texco directory can complete the flow.
 * Authorisation (who sees which rows/fields) is separate — see lib/access.ts.
 */
const providers: Provider[] = [
  MicrosoftEntraID({
    clientId: process.env.AZURE_CLIENT_ID,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
    issuer: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/v2.0`,
  }),
];

// Temporary shared-password login while Entra sign-in is being set up.
// Exists ONLY while the TEMP_LOGIN_PASSWORD env var is set — remove the var
// and redeploy to kill it. Sessions are identical to Entra ones; access
// control (lib/access.ts) still decides what each email can see.
if (process.env.TEMP_LOGIN_PASSWORD) {
  providers.push(
    Credentials({
      id: "password",
      name: "Email and password",
      credentials: { email: { label: "Email" }, password: { label: "Password" } },
      authorize: (creds) => {
        const email =
          typeof creds?.email === "string" ? creds.email.trim().toLowerCase() : "";
        const password = typeof creds?.password === "string" ? creds.password : "";
        if (!email.includes("@")) return null;
        if (!password || password !== process.env.TEMP_LOGIN_PASSWORD) return null;
        return { email, name: email.split("@")[0] };
      },
    })
  );
}

// Local-only dev backdoor, equivalent to tools' env-guarded /dev/login/{email}.
// Never registered outside `next dev`.
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
  },
  callbacks: {
    authorized: ({ auth }) => !!auth?.user?.email,
  },
});
