import "server-only";
import { loadIdentityUsers, saveIdentityUsers } from "./store";
import type { IdentityUser, IdentityUsers } from "./identity-schema";

/**
 * What Kestrel remembers about the people who sign in through Texco Identity.
 *
 * Kestrel has no users table — authorisation is a config keyed by email
 * (lib/access.ts). This document exists for the two jobs that email alone
 * can't do:
 *
 *  - **Revocation.** Sessions here are stateless JWTs, so there is nothing to
 *    invalidate server-side and no way to enumerate a person's sessions. An
 *    epoch stamped into the token at sign-in and compared on each request
 *    turns "end all their sessions" into a single increment.
 *  - **Identity that survives an email change.** Identity's webhooks name
 *    people by `m365_id`, the stable Entra object id, so the mapping has to
 *    be stored somewhere to resolve one to the other — and it lets a changed
 *    email carry its access rule across (see lib/access.ts).
 *
 * One record per person, keyed by m365_id:
 *
 *     kestrel:identity:users → { [m365Id]: { email, name, epoch } }
 */

export type { IdentityUser, IdentityUsers };

/**
 * The epoch is read on every request via the proxy, so it is cached briefly
 * per server instance rather than costing a database round trip each time.
 * A revocation therefore bites within the window rather than instantly —
 * immaterial for offboarding and single logout, and the alternative is
 * charging every page view for a check that almost never changes anything.
 */
const TTL_MS = Number(process.env.IDENTITY_EPOCH_TTL_MS ?? 30_000);
let cache: { users: IdentityUsers; readAt: number } | null = null;

async function read(force = false): Promise<IdentityUsers> {
  if (!force && cache && Date.now() - cache.readAt < TTL_MS) return cache.users;
  const users = await loadIdentityUsers();
  cache = { users, readAt: Date.now() };
  return users;
}

/** Drop the cache — after any write, so this instance sees its own change. */
function invalidate(users: IdentityUsers) {
  cache = { users, readAt: Date.now() };
}

export async function getIdentityUser(
  m365Id: string,
  opts: { fresh?: boolean } = {}
): Promise<IdentityUser | null> {
  return (await read(opts.fresh))[m365Id] ?? null;
}

/** The epoch a session for this person must carry to still be valid. */
export async function currentEpoch(m365Id: string): Promise<number> {
  return (await getIdentityUser(m365Id))?.epoch ?? 0;
}

/**
 * Record a sign-in. Returns the previous record so the caller can tell
 * whether the email moved — the epoch is never touched here, because signing
 * in must not invalidate the session being created.
 */
export async function rememberIdentityUser(
  m365Id: string,
  email: string,
  name?: string
): Promise<IdentityUser | null> {
  const users = await read(true);
  const previous = users[m365Id] ?? null;
  const next: IdentityUsers = {
    ...users,
    [m365Id]: { email, name, epoch: previous?.epoch ?? 0 },
  };
  await saveIdentityUsers(next);
  invalidate(next);
  return previous;
}

/**
 * End every session this person holds, on their next request. Returns null
 * when identity names someone who has never signed in here, which is normal —
 * not every Texco person uses this tool.
 */
export async function revokeSessions(
  m365Id: string | null,
  email: string | null
): Promise<{ m365Id: string; user: IdentityUser } | null> {
  const users = await read(true);

  let key = m365Id && users[m365Id] ? m365Id : null;
  if (!key && email) {
    // fall back to email so a person who signed in before this shipped, or
    // whose m365_id identity didn't send, can still be revoked
    const found = Object.entries(users).find(
      ([, u]) => u.email.toLowerCase() === email.toLowerCase()
    );
    key = found?.[0] ?? null;
  }
  if (!key) return null;

  const user = { ...users[key], epoch: users[key].epoch + 1 };
  const next: IdentityUsers = { ...users, [key]: user };
  await saveIdentityUsers(next);
  invalidate(next);
  return { m365Id: key, user };
}

/** Test seam — the module-level cache would otherwise leak between cases. */
export function __resetIdentityCache() {
  cache = null;
}
