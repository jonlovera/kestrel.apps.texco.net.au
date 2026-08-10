# FY26 Employee Bonus Scheme — Texco

Next.js port of the single-file EBS dashboard prototype. Row- and field-level
access control is enforced **server-side**: the browser never receives rows or
fields the signed-in user isn't entitled to. Sign-in is delegated to Texco
Identity, the company's single sign-on provider — no passwords in this app.

- **Full access** users get the whole dataset with the prototype's instant
  recalculation, and drop the spreadsheet onto the dashboard to refresh it.
- **State**, **group** and **subset** users get server-computed views of only
  their permitted rows and fields — verified absent from the network payload,
  not hidden with CSS — and can set IPM and Discretionary on their own people.
- Employee ID, package and bonus % are read-only for **everyone**. They come
  from the spreadsheet, because a typo in one cascades through every figure.
- Nothing is written until Save; unsaved figures never leave the browser.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind 4 · NextAuth v5
(`microsoft-entra-id`) · zod · Neon Postgres (Vercel Marketplace) · Vitest.

---

## 1. Environment variables

Copy `.env.example` to `.env.local` and fill it in:

| Variable | What it is |
|---|---|
| `AUTH_SECRET` | Session-cookie signing secret. Generate: `openssl rand -base64 32` |
| `IDENTITY_URL` | `https://identity.texco.net.au` |
| `IDENTITY_CLIENT_ID` | From the registration at identity |
| `IDENTITY_CLIENT_SECRET` | Same registration — stored hashed there, so copy it once |
| `IDENTITY_WEBHOOK_SECRET` | Signs the logout/deactivation callbacks |
| `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` / `AZURE_TENANT_ID` | **Not login any more.** App-only Graph credentials behind the directory type-ahead on `/admin/access` |
| `DATABASE_URL` | Neon Postgres (auto-injected when you add the Vercel integration) |
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

### Directory lookup on the access page (optional, needs a directory admin)

So that granting access means picking a name rather than remembering how
someone's address is spelled, `/admin/access` types ahead against the company
directory. Turning it on is one permission:

*App registrations → (this app) → **API permissions** → Add a permission →
**Microsoft Graph** → **Application permissions** → `User.Read.All` → Add →
then **Grant admin consent** for the tenant.*

No new secrets: it reuses `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` /
`AZURE_TENANT_ID` via the client-credentials flow, so nothing is added to the
sign-in path and no per-user Graph token is stored.

**Until it is granted, the page still works** — the email field falls back to a
plain text box and explains why. Suggestions are a convenience, never a gate:
any address can always be typed in full, which matters because access is often
granted to people outside the bonus scheme (payroll, IT). Only full-access
users can search, and the lookup returns names, addresses and job titles only —
it never touches the bonus data.

## 2. Signing in — Texco Identity

Sign-in is delegated to **Texco Identity**, the company's single sign-on
provider, which performs the Microsoft Entra sign-in itself. This app never
talks to Microsoft for login: a session established in any other Texco app is
honoured here, signing out of one signs out of all, and deactivating someone in
identity ends their access here too.

There is no login screen. A signed-out visitor is forwarded straight into the
OAuth flow, and when they already have an identity session they see nothing but
the page they asked for. `/login` renders only to report an error or a
deliberate logout.

### Registering this app

The registration lives at `identity.texco.net.au/applications/12/edit`. Two
things must be set there:

| | |
|---|---|
| **Redirect URI** | `https://kestrel.apps.texco.net.au/api/auth/callback/texco-identity` |
| **Webhook URL** | `https://kestrel.apps.texco.net.au/api/identity/webhook` |

The redirect URI is derived by Auth.js from `AUTH_URL` and is **not**
configurable — register exactly that string or identity answers
`invalid_client`. It must be `https`: production sends HSTS with a two-year
max-age, so a browser will refuse the `http` form outright.
`/auth/callback` is also routed to the handler for anything still pointing at
the Laravel-convention path, but it is not what this app sends.

### Single logout and offboarding

Sessions here are stateless JWTs — there is nothing to delete server-side and
no way to enumerate the sessions one person holds. Instead each session is
stamped with an **epoch** at sign-in, and identity's webhooks
(`user.logged_out`, `user.deactivated`) increment that person's epoch. Every
session they hold then fails its next request.

The check lives in the `session` callback in `auth.ts` — deliberately not in
Auth.js's `authorized` callback, because `proxy.ts` wraps `auth()` with its own
gate and `authorized` is therefore never consulted. Epoch reads are cached for
`IDENTITY_EPOCH_TTL_MS` (30s) per server instance, so a revocation bites within
that window rather than costing every request a database round trip.

Deliveries are authenticated by HMAC over `{timestamp}.{raw body}` — the raw
bytes, because re-serialising the parsed JSON would not reproduce identity's
own encoding. An unset `IDENTITY_WEBHOOK_SECRET` answers 503: fail closed, never
"accept anything". Timestamps outside ±300s are refused so a captured delivery
cannot replay forever.

### Identity vs authorisation

Identity says *who someone is*; `lib/access.ts` still decides *what they may
see*, keyed by email. Because email is not stable, the m365_id↔email mapping is
stored (`kestrel:identity:users`), and someone signing in under a new address
keeps their access — their entry in the database overlay moves with them. A
code-seeded email that goes stale is logged loudly instead, since changing it
needs a deploy.

### Temporary password login (being retired)

While identity sign-in is proven, setting `TEMP_LOGIN_PASSWORD` still adds an
email + password form. **This bypasses Entra MFA and is a shared secret:
remove the env var and redeploy as soon as SSO is confirmed working**
(`vercel env rm TEMP_LOGIN_PASSWORD production && vercel deploy --prod`).

## 3. Adding a user

Authentication only proves someone works at Texco; they see **nothing** until
granted access. Any full-access user can manage this in the app: **Manage
access** in the dashboard header (or `/admin`) — add an email, pick one of the
three access types, save. Changes are stored in the database and apply
immediately, no deploy:

- `full` — every employee, every field, can edit everything, can manage access
- `state` — all employees in the listed state(s), with an explicit
  visible-fields list (leave Package/Bonus% unticked to keep salary figures
  out entirely — they're flagged "salary" in the form)
- `group` — a state and/or a role, e.g. "all VIC site managers". A standing
  rule: it keeps matching as people join and leave, where a subset goes stale
- `subset` — an explicit list of employees, explicit fields

Everyone except `full` sees only their own rows and can set IPM and
Discretionary on them — nothing else, and never anyone else's row.

Precedence per email: `lib/access.ts` (code seed — the owners, always present)
< `BONUS_USERS` env var (optional JSON of the same shape) < the `/admin`
database entries. Removing a code-seeded person in the UI stores a shadow
entry; `jlovera@texco.net.au` is protected in code and can never be locked
out. Every access change is audit-logged (who, whom, what, when).

## 4. Data, parameters and presentation (self-service, no deploy)

Editing happens **in place on the dashboard**: press **Edit mode** (top right)
and the figures you're allowed to change become typeable. Press **Done
editing** and it goes back to plain text — the view to share on a screen.

**Nothing is written until you press Save.** Unsaved figures are local to your
browser, invisible to everyone else, and gone if the tab closes — the tool is
used to ask "if I move this person to $15k, what happens to everyone else?",
and those experiments must not reach anyone else or the record. Discard puts
them back. Each save takes one snapshot.

Who can change what:

| | Admin / finance | State lead |
|---|---|---|
| IPM, Discretionary | ✅ | ✅ own rows only |
| After IPM ("Bonus") | ✅ | ✕ |
| Lock a bonus | ✅ | ✕ |
| Employee ID, Package/REM, Bonus % | ✕ | ✕ |
| Names, roles, states, who exists | ✕ | ✕ |
| Caps, columns, wording, banner | ✅ | ✕ |

The read-only fields come from the spreadsheet, and only from there: a typo in
an employee ID or a package cascades through every calculation in the scheme.
Terminations, promotions and new starters arrive by import.

A state lead never calculates locally — their browser is never given the pool
it would need. Their what-ifs go to `/api/preview`, which runs the real engine
server-side and returns only their own scope-stripped rows, persisting
nothing. `lib/write-scope.ts` decides every write, and `lib/scope-core.ts`
every read; both share one definition of "in scope".

Also in edit mode: bulk IPM across everyone shown, the pool caps typed onto
the cards (the summary is frozen so "remaining to allocate" stays visible),
the column menu, and the headings, banner and footer.

**Export** — the Export button downloads an Excel workbook: one sheet of data
with employee ID and headers matching the import, plus a Summary sheet with
provenance and totals. It can be edited and imported straight back. Snapshots
export the same way.

### The two write paths

Deliberately kept apart:

| | Fields | Stored in | Survives an import? |
|---|---|---|---|
| **Your judgement** | IPM, Discretionary, locks | overrides doc | **Yes** |
| **Payroll facts** | After IPM, and everything read-only | the dataset | **No** — the spreadsheet wins |

**Source data is not in git.** `data/bonus.json` (155 salary packages) is
gitignored; the app reads the dataset from the database (`kestrel_docs` key
`kestrel:data:fy26`), then the `BONUS_DATA` env var (base64 JSON, gzip
accepted), then the local file (dev only). Seed the database with
`npx tsx scripts/seed-store.ts`; the old `npm run import` script still writes
the local dev file.

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
jlovera (same idea as tools' `/dev/login/{email}`). Without a `DATABASE_URL`,
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
   **Neon Postgres** (this injects `DATABASE_URL`; pick region Sydney —
   functions are pinned to `syd1` in `vercel.json` to match).
2. Create the tables (once): `vercel env pull .env.local` then
   `npx tsx scripts/init-db.ts` (remove `DATABASE_URL` from `.env.local`
   afterwards, or local dev will write to production).
3. Project → **Settings → Environment Variables** → add `AUTH_SECRET`,
   `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`.
4. Deploy:

```bash
vercel deploy --prod
```

5. Add the production URL to the Entra app registration's redirect URIs
   (step 1.2) if you didn't know it beforehand.

Page views and edit writes are logged to the console with email, scope and
timestamp — visible under the project's **Logs** tab in Vercel.

## 7. History and privacy lock

- **History tab** (full-access users, in the dashboard): who did what and
  when — every Bonus%/IPM%/Disc adj change (old → new value), every
  lock/unlock, and every access grant/change/removal. Stored in the database
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
8. **Data at rest in Neon is not application-encrypted** — the edit state
   (which includes adjusted bonus figures) relies on Neon's own encryption
   and staff-access controls, plus Vercel's env-var handling for the
   connection string.
9. **Trust in third parties**: Vercel and Neon staff/infrastructure could
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
- Add rate limiting on `/api/state` and sign-in.
- Move to a nonce-based CSP without `unsafe-inline`.
- Turn on Vercel's deployment protection (password/SSO gate) as a second
  layer in front of the app.
