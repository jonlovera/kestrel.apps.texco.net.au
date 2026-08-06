import "server-only";

/**
 * Microsoft Graph directory lookup — the name→email dropdown on /admin/access.
 *
 * App-only (client credentials) rather than delegated: the app already holds
 * AZURE_CLIENT_ID/SECRET/TENANT_ID, so no Graph scopes have to be added to the
 * sign-in flow and no per-user access token has to be stored or refreshed. It
 * also means the lookup works no matter which provider the admin signed in
 * with, including the temporary password login.
 *
 * This needs ONE Azure setup step, done once by a directory admin:
 *   App registration → API permissions → Microsoft Graph → Application
 *   permissions → User.Read.All → then "Grant admin consent".
 *
 * Until that is granted every call returns { ok: false, reason: "forbidden" }
 * and the access form silently falls back to typing the address by hand — the
 * page keeps working, it just stops suggesting.
 *
 * Nothing here reads the bonus dataset; it only ever returns names, addresses
 * and job titles from the company directory, and the route that calls it is
 * full-access only.
 */

const GRAPH = "https://graph.microsoft.com/v1.0";

export interface DirectoryPerson {
  id: string;
  name: string;
  email: string;
  jobTitle?: string;
  department?: string;
}

export type DirectoryResult =
  | { ok: true; people: DirectoryPerson[] }
  | { ok: false; reason: "unconfigured" | "forbidden" | "error" };

/** Cached app token — Graph issues these for ~1h; re-fetch a minute early. */
let cachedToken: { value: string; expiresAt: number } | null = null;

async function appToken(): Promise<string | null> {
  const tenant = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  if (!tenant || !clientId || !clientSecret) return null;

  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;

  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
      cache: "no-store",
    }
  );
  if (!res.ok) {
    console.error("[graph] token request failed:", res.status, await res.text());
    return null;
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) return null;
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + Math.max(0, (body.expires_in ?? 3600) - 60) * 1000,
  };
  return cachedToken.value;
}

/**
 * Graph's $search takes a quoted OData string, so anything that could close
 * the quote or add a clause is stripped rather than escaped. What's left is a
 * plain word or two, which is all a name search needs.
 */
function sanitise(query: string): string {
  return query.replace(/["'\\()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** Search the company directory by name or address. Never throws. */
export async function searchDirectory(query: string): Promise<DirectoryResult> {
  const q = sanitise(query);
  if (q.length < 2) return { ok: true, people: [] };

  try {
    const token = await appToken();
    if (!token) return { ok: false, reason: "unconfigured" };

    const params = new URLSearchParams({
      $search: `"displayName:${q}" OR "mail:${q}" OR "userPrincipalName:${q}"`,
      $select: "id,displayName,mail,userPrincipalName,jobTitle,department,accountEnabled,userType",
      $top: "25",
    });
    const res = await fetch(`${GRAPH}/users?${params}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        // $search on users requires the eventually-consistent index
        ConsistencyLevel: "eventual",
      },
      cache: "no-store",
    });

    if (res.status === 401 || res.status === 403) {
      // by far the likeliest failure: User.Read.All not granted/consented yet
      console.error("[graph] directory search denied:", res.status, await res.text());
      cachedToken = null; // a revoked or stale token shouldn't be reused
      return { ok: false, reason: "forbidden" };
    }
    if (!res.ok) {
      console.error("[graph] directory search failed:", res.status, await res.text());
      return { ok: false, reason: "error" };
    }

    const body = (await res.json()) as {
      value?: {
        id: string;
        displayName?: string;
        mail?: string;
        userPrincipalName?: string;
        jobTitle?: string;
        department?: string;
        accountEnabled?: boolean;
        userType?: string;
      }[];
    };

    const people = (body.value ?? [])
      // guests and disabled accounts can't sign in, so offering them would
      // only ever create an access rule nobody can use
      .filter((u) => u.accountEnabled !== false && u.userType !== "Guest")
      .map((u) => ({
        id: u.id,
        name: u.displayName ?? u.mail ?? u.userPrincipalName ?? "",
        email: (u.mail ?? u.userPrincipalName ?? "").toLowerCase(),
        jobTitle: u.jobTitle ?? undefined,
        department: u.department ?? undefined,
      }))
      .filter((p) => p.email.includes("@"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 15);

    return { ok: true, people };
  } catch (err) {
    console.error("[graph] directory search threw:", err);
    return { ok: false, reason: "error" };
  }
}
