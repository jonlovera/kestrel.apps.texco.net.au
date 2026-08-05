# FY26 Employee Bonus Scheme — Texco

Next.js port of the single-file EBS dashboard prototype. Row- and field-level
access control is enforced **server-side**: the browser never receives rows or
fields the signed-in user isn't entitled to. Sign-in is Microsoft Entra ID
(the same method as the tools app) — no passwords in this app at all.

- **Full access** users get the whole dataset and edit it in the browser with
  the prototype's instant recalculation; every change is revalidated
  server-side and persisted to Redis, so results survive across sessions.
- **State** and **subset** users get read-only, server-computed views with
  only their permitted rows and fields — verified absent from the network
  payload, not hidden with CSS.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind 4 · NextAuth v5
(`microsoft-entra-id`) · zod · Upstash Redis (Vercel Marketplace) · Vitest.

---

## 1. Environment variables

Copy `.env.example` to `.env.local` and fill it in:

| Variable | What it is |
|---|---|
| `AUTH_SECRET` | Session-cookie signing secret. Generate: `openssl rand -base64 32` |
| `AZURE_CLIENT_ID` | From the Entra app registration (below) |
| `AZURE_CLIENT_SECRET` | Client secret from the same registration |
| `AZURE_TENANT_ID` | The Texco directory (tenant) id — restricts sign-in to Texco accounts |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash Redis (auto-injected when you add the Vercel integration) |
| `BONUS_USERS` | *(optional)* JSON access rules merged over `lib/access.ts` |
| `DEV_LOGIN` | *(local only)* `1` shows an email-only dev login during `next dev`. Never set on Vercel |

### Entra app registration (one-off)

Azure portal → **App registrations** → *New registration* (same tenant as the
tools app):

1. Name: e.g. `Texco EBS Dashboard`. Supported account types: **this
   organizational directory only** (single tenant — this is the gatekeeper).
2. Redirect URI (type **Web**):
   `https://<your-app>.vercel.app/api/auth/callback/microsoft-entra-id`
   and for local dev add
   `http://localhost:3000/api/auth/callback/microsoft-entra-id`.
3. *Certificates & secrets* → new client secret → copy the **value** into
   `AZURE_CLIENT_SECRET` (it's shown once).
4. Overview page → copy **Application (client) ID** and **Directory (tenant)
   ID** into `AZURE_CLIENT_ID` / `AZURE_TENANT_ID`.

## 2. Passwords

There are none. Authentication is delegated to Microsoft Entra ID, exactly
like the tools app — staff sign in with their normal M365 account (and
whatever MFA/conditional-access policies IT enforces there). Removing someone
from the tenant removes their ability to sign in.

### Temporary password login (stop-gap)

While Entra sign-in is being set up, setting the `TEMP_LOGIN_PASSWORD` env var
adds an email + password form to the login page: any email paired with that
one shared password gets a session. Access control still applies — the email
must be granted access (see §3) or they land on the no-access page. **This
bypasses Entra MFA and is a shared secret: remove the env var and redeploy as
soon as Microsoft sign-in works** (`vercel env rm TEMP_LOGIN_PASSWORD
production && vercel deploy --prod`). The custom-domain deployment also pins
`AUTH_URL=https://kestrel.apps.texco.net.au` so OAuth callbacks are always
built with the https custom domain.

## 3. Adding a user

Authentication only proves someone works at Texco; they see **nothing** until
granted access. Any full-access user can manage this in the app: **Manage
access** in the dashboard header (or `/admin`) — add an email, pick one of the
three access types, save. Changes are stored in Redis and apply immediately,
no deploy:

- `full` — every employee, every field, can edit, can manage access
- `state` — all employees in the listed state(s), read-only, with an explicit
  visible-fields list (leave Package/Bonus% unticked to keep salary figures
  out entirely — they're flagged "salary" in the form)
- `subset` — an explicit list of employees, read-only, explicit fields

Precedence per email: `lib/access.ts` (code seed — the owners, always present)
< `BONUS_USERS` env var (optional JSON of the same shape) < the `/admin`
database entries. Removing a code-seeded person in the UI stores a shadow
entry; `jlovera@texco.net.au` is protected in code and can never be locked
out. Every access change is audit-logged (who, whom, what, when).

## 4. Data, parameters and presentation (self-service, no deploy)

Everything a finance lead needs day-to-day lives under **/admin** (full-access
users only; every page and API authorises independently):

- **Access** — grant/revoke who can sign in and what they see.
- **Columns** — show/hide/rename/reorder/reformat the table columns, and hide
  the pool-card scale factor. Display only: never changes entitlement or
  calculations (tested).
- **Params** — the VIC/NSW/group caps and the company-wide modifier, with a
  live preview of the impact before saving. Defaults match the source data
  exactly (modifier 1.0 = today's behaviour).
- **Import** — upload the .xlsx/.csv (headers: ID, Surname, Given name,
  Position, Department, Manager, Category, State, VIC %, NSW %, Package,
  Bonus %, IPM %, After IPM, Disc adj, FY25 bonus, Site manager). Preview
  shows added/removed people and the pool total before/after for
  reconciliation; removals of people with entered figures need explicit
  confirmation; manager-entered IPMs/adjustments/locks are never overwritten.
- **Snapshots** — a full copy of everything is taken before every change;
  one-click restore (itself undoable) and per-snapshot JSON download. Last
  50 kept.

Concurrent editing is safe: saves carry a version and a stale save gets a
"someone else saved" reload instead of silently overwriting.

**Source data is not in git.** `data/bonus.json` (155 salary packages) is
gitignored; the app reads the dataset from Redis (`kestrel:data:fy26`), then
the `BONUS_DATA` env var (base64 JSON), then the local file (dev only). Seed
Redis with `npx tsx scripts/seed-store.ts`; the old `npm run import` script
still writes the local dev file.

The calc engine (`lib/calc.ts`) is frozen and protected by golden tests
(`lib/calc-golden.test.ts`, strict bit-for-bit equality on all 155 rows plus
lock/adjustment scenarios) — any change that moves a figure fails the suite.

## 5. Local development

```bash
npm install
cp .env.example .env.local   # fill in AUTH_SECRET at minimum; set DEV_LOGIN=1
npm run dev
```

With `DEV_LOGIN=1` you can sign in as anyone without Entra (local only):
open `http://localhost:3000/dev/login/<email>` — e.g.
`/dev/login/jlovera@texco.net.au` — or bare `/dev/login` which defaults to
jlovera (same idea as tools' `/dev/login/{email}`). Without Redis credentials,
edits persist to `.data/overrides.json` and access rules to `.data/access.json`.

```bash
npm test        # Vitest — includes the pro-rata/lock redistribution suite
npm run build   # production build
```

## 6. Deploying to Vercel

```bash
npm i -g vercel
vercel link            # create/link the project
```

1. In the Vercel dashboard → project → **Storage** (Marketplace) → add
   **Upstash for Redis** (this injects `KV_REST_API_URL`/`KV_REST_API_TOKEN`).
2. Project → **Settings → Environment Variables** → add `AUTH_SECRET`,
   `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`.
3. Deploy:

```bash
vercel deploy --prod
```

4. Add the production URL to the Entra app registration's redirect URIs
   (step 1.2) if you didn't know it beforehand.

Page views and edit writes are logged to the console with email, scope and
timestamp — visible under the project's **Logs** tab in Vercel.

## 7. History and privacy lock

- **History tab** (full-access users, in the dashboard): who did what and
  when — every Bonus%/IPM%/Disc adj change (old → new value), every
  lock/unlock, and every access grant/change/removal. Stored in Redis
  (newest first, capped at 2,000 entries).
- **Privacy by default**: per-employee figures in the table load masked
  (`••••`) — names and positions are visible, individual numbers aren't.
  Pool cards and the summary totals at the top are always visible. Click a
  row to reveal just that person; use the **Show everything** button (top
  right) or press <kbd>Space</kbd> outside an input to toggle the whole
  table, and Space again to instantly re-mask when someone walks past. The
  table's totals row and the history detail stay masked until
  "Show everything". Every page load starts masked.

---

## What is still insecure about this setup

Be clear-eyed about what this is: appropriate for a short-lived, low-user-count
draft tool, not a system of record.

1. **Salary data is committed to the repo and baked into every deployment.**
   Anyone with repo read access or a Vercel project member sees everything.
   The repo must stay private; collaborator lists ARE the access control for
   the raw data.
2. **Authorisation is a hardcoded allowlist.** Anyone in the Entra tenant can
   *authenticate*; only `lib/access.ts` stands between them and a 403. A typo
   there (or a stale entry for someone who changed roles) is a data breach.
   There's no approval workflow and no periodic review.
3. **Full-access editors download the entire dataset to their browser** (by
   design, for instant recalculation). A compromised editor account or
   machine leaks all 155 salary packages at once.
4. **Sessions can't be revoked.** JWT sessions live up to 8 hours with no
   server-side revocation — removing someone's access doesn't kick out an
   active session until it expires.
5. **No rate limiting or anomaly detection** on the data or state endpoints.
6. **The audit trail is console logs** — mutable, retention-limited (Vercel
   log retention is short on lower tiers), and not tamper-evident. Edits
   overwrite each other with no history; there's no record of *what* changed,
   only that a write happened.
7. **CSP allows `unsafe-inline` scripts** (Next.js without nonce plumbing), so
   XSS isn't fully mitigated by policy.
8. **Data at rest in Upstash is not application-encrypted** — the edit state
   (which includes adjusted bonus figures) relies on Upstash's own encryption
   and staff-access controls, plus Vercel's env-var handling for the token.
9. **Trust in third parties**: Vercel and Upstash staff/infrastructure could
   technically access the deployment bundle and stored state.

### To make it production-grade

- Move the dataset out of the repo into a real database (Postgres + row-level
  security, or at minimum encrypted-at-rest storage keyed per deployment),
  with the import script writing there instead of a JSON file.
- Replace the allowlist with Entra **group-based** authorisation (app roles or
  security groups on the token), so IT joiner/leaver processes govern access.
- Add an append-only audit log (who changed which employee's figure, old →
  new value, when) in durable storage, not console output.
- Shorten sessions and/or use database sessions so access removal is
  immediate; rely on Entra Conditional Access + MFA policies.
- Add rate limiting (e.g. Upstash Ratelimit) on `/api/state` and sign-in.
- Move to a nonce-based CSP without `unsafe-inline`.
- Turn on Vercel's deployment protection (password/SSO gate) as a second
  layer in front of the app.
