import { NextResponse } from "next/server";
import { getEffectiveDataset } from "@/lib/data";
import { requireScopedWriter } from "@/lib/api-guard";
import { saveOverridesCas, loadOverrides, appendHistory } from "@/lib/store";
import { OverridesSchema, type Overrides } from "@/lib/schema";
import { z } from "zod";
import { diffOverrides } from "@/lib/history-diff";
import { takeSnapshot } from "@/lib/snapshots";
import { sanitiseOverrideWrite, scopeOverridesView } from "@/lib/write-scope";
import {
  applyOverrides,
  computeScalesAndBonuses,
  isDaEditable,
  isLockable,
  rowRule,
} from "@/lib/calc";
import { poolBreach } from "@/lib/manager-pool";
import {
  EPSILON as DA_EPSILON,
  daHeadroom,
  daImpact,
  type DaGrant,
} from "@/lib/da-impact";
import { fmt } from "@/lib/fmt";

export const dynamic = "force-dynamic";

/**
 * Commit the allocation. Full access and state leads both, which is the change
 * this route exists to absorb: it used to refuse anyone without `canEdit`, and
 * a lead can now set IPM and Discretionary for their own people.
 *
 * Three gates, in order:
 *   1. lib/write-scope.ts — is this row theirs, and is this field theirs?
 *      Anything else is dropped and the stored value kept.
 *   2. the scheme's own rules below — nobody outside the pools takes a
 *      discretionary adjustment or a lock, and nor does a VIC site manager.
 *      NSW site managers take both (owner decision, 24 August 2026).
 *   3. the manager's pool — a save that would push a scoped lead further above
 *      their own pool is refused outright, naming the unabsorbable amount.
 *      Nothing is clamped and nothing moves silently: the figure the user
 *      typed is the figure they keep, or the figure they are told they cannot
 *      have.
 *   4. discretionary headroom — the hard limit (owner decision, 25 August
 *      2026: "it will get refused automatically by each discretionary field").
 *      A discretionary amount adds to its pool's total rather than being
 *      funded from inside it, so the bound is the cap: how much room is left
 *      under the row's home-state cap and the group cap, measured off the same
 *      totals the pool cards show (lib/da-impact.ts's daHeadroom). The editor
 *      holds every entry to it at type time and shows it on the field; this
 *      gate is the guarantee, judging only the amounts THIS save changes, so
 *      an inherited over-cap figure stays correctable. Refused, never trimmed
 *      — same principle as gate 3.
 *   5. confirmation — a grant is a decision about money nobody else approved,
 *      so it is never committed silently. A save carrying changed
 *      discretionary amounts is refused with 428 and the impact figures (what
 *      is being granted and where it leaves each pool against its cap) until
 *      the client sends `confirmDa` with the person's explicit consent. The
 *      confirmation is enforced here rather than in the browser so an
 *      autosave, a tab-close flush or a direct API call cannot bypass it.
 *
 * Every grant that gets through is written to the history as its own `grant`
 * entry — who, what, when and the headroom that bounded it — recomputed
 * server-side rather than taken from the client.
 *
 * The client is never trusted for a figure. It sends what it wants; the server
 * decides what is true and hands the result back, which is why the dashboard
 * adopts the response rather than its own optimistic state.
 */
export async function POST(req: Request) {
  // The one route that takes writes from people without full access, so it
  // uses the weaker guard: it settles only "a real user, as themselves". Which
  // rows and fields they may touch is sanitiseOverrideWrite's call, below.
  const guard = await requireScopedWriter("state-write");
  if ("response" in guard) return guard.response;
  const { email, scope, viewingAs } = guard;

  let incoming: Overrides;
  let clientVersion: number;
  let source: "manual" | "auto";
  let viewFor: string | undefined;
  let confirmDa: boolean;
  try {
    const body = z
      .object({
        version: z.number().int().min(0),
        overrides: OverridesSchema,
        // "auto" marks the periodic autosave and the tab-close flush, so the
        // snapshot policy can coalesce them; a manual Save stays one
        // deliberate act with its own restore point
        source: z.enum(["manual", "auto"]).optional().default("manual"),
        // Sent while an act-as view is active: the target the client believes
        // it is saving for. Checked below.
        viewFor: z.string().optional(),
        // The person's explicit consent to the discretionary grants in this
        // document, after being shown who pays for them (gate 5). Absent by
        // default, so nothing is ever committed by omission.
        confirmDa: z.boolean().optional().default(false),
      })
      .parse(await req.json());
    incoming = body.overrides;
    clientVersion = body.version;
    source = body.source;
    viewFor = body.viewFor;
    confirmDa = body.confirmDa;
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  // The view-expiry safeguard. A client mounted for someone else's dashboard
  // holds THAT person's baseline; if the view cookie lapses (or the view is
  // stopped in another tab) before an autosave lands, the same request would
  // be judged against the actor's OWN scope — for an admin, a full window,
  // where the incoming doc is authoritative for everyone and would clear
  // every override outside the target's rows. So the client names who it
  // thinks it is saving for, and a mismatch is refused outright.
  if (viewFor !== undefined && viewFor.trim().toLowerCase() !== (viewingAs ?? "")) {
    console.log(
      `[audit] state-write STALE-VIEW email=${email} viewFor=${viewFor} actual=${viewingAs ?? "none"} ts=${new Date().toISOString()}`
    );
    return noStore(
      NextResponse.json(
        { error: "Your View as session has ended. Reopen the view before saving." },
        { status: 403 }
      )
    );
  }

  const data = await getEffectiveDataset();
  const known = new Map(data.emp.map((e) => [e.id, e]));
  const previous = await loadOverrides();

  // Gate 1: scope. Merges over the stored document, so a lead saving their own
  // state cannot erase another lead's rows or the admin's locks.
  const { overrides: scoped, rejected } = sanitiseOverrideWrite(
    scope,
    data.emp,
    incoming,
    previous
  );
  if (rejected.length > 0) {
    console.log(
      `[audit] state-write REJECTED email=${email} scope=${scope.rule.type} items=${rejected.length} detail=${rejected.slice(0, 10).join("; ")} ts=${new Date().toISOString()}`
    );
  }

  // Gate 2: the scheme's rules, applied to the merged result rather than to
  // what arrived — a lead's save carries the whole stored document forward.
  const sanitised: Overrides = {};
  for (const [id, ov] of Object.entries(scoped)) {
    const emp = known.get(id);
    if (!emp) continue;
    const clean: Overrides[string] = { ...ov };
    if (clean.ipmEdit !== undefined) clean.ipmEdit = Math.max(0, clean.ipmEdit);
    if (clean.bpEdit !== undefined) clean.bpEdit = Math.max(0, clean.bpEdit);
    if (!isLockable(rowRule(emp))) {
      // a row drawing from no pool has nothing to lock, and a VIC site
      // manager's fixed bonus is deliberately left alone
      delete clean.locked;
      delete clean.lockedFinal;
    }
    // A row drawing from no pool has no pool for a discretionary amount to add
    // to. An NSW site manager's IS adjustable (24 Aug 2026) — it rides on top of
    // their fixed bonus — but a VIC site manager's is not, so the VIC fixed
    // bonuses stay untouchable. isDaEditable holds that rule.
    if (!isDaEditable(rowRule(emp))) delete clean.daEdit;
    // daEdit is deliberately not floored: an adjustment may be negative
    // (owner decision, kept through every change of funding model — a negative
    // DA lowers the recipient's final and its pool's total with it)
    if (!clean.locked) delete clean.lockedFinal;
    if (Object.keys(clean).length > 0) sanitised[id] = clean;
  }

  // A locked row's frozen final is legitimately historical (its value at lock
  // time), so a well-formed client value is kept. If it's missing, fall back
  // to the row's current calc with its own lock released.
  const needFallback = Object.entries(sanitised).filter(
    ([, ov]) => ov.locked && typeof ov.lockedFinal !== "number"
  );
  for (const [id, ov] of needFallback) {
    const doc: Overrides = { ...sanitised, [id]: { ...ov, locked: false } };
    const emps = applyOverrides(data.emp, doc);
    computeScalesAndBonuses(emps, data);
    // finalBonus, not calcBonus: the frozen figure is the actual payout,
    // which includes the row's discretionary adjustment
    ov.lockedFinal = emps.find((e) => e.id === id)!.finalBonus;
  }

  // Gate 3: the manager's pool. Runs here rather than earlier because it reads
  // the frozen finals the fallback loop above may just have resolved, and
  // BEFORE takeSnapshot because a refused save must not leave a restore point
  // behind. Judged against the stored document, not against zero, so a lead
  // who inherits an over-pool state (a cap moved, an admin locked a row above
  // its entitlement) can still save the correction — see poolBreach.
  const breach = poolBreach(scope, data, sanitised, previous);
  if (breach) {
    console.log(
      `[audit] state-write OVER-POOL email=${email} scope=${scope.rule.type} over=${breach.over.toFixed(2)} wasOver=${breach.wasOver.toFixed(2)} ts=${new Date().toISOString()}`
    );
    return noStore(
      NextResponse.json(
        { error: overPoolMessage(breach.over, breach.wasOver), breach },
        { status: 422 }
      )
    );
  }

  // Gates 4 and 5 both need the same measurement: what this save does to the
  // discretionary amounts, and where that leaves each pool. One pass, computed
  // here rather than trusted from the client.
  const impact = daImpact(data.emp, data, previous, sanitised);

  // Gate 4: the hard limit. Only the amounts this save CHANGES are judged, so a
  // figure inherited from a lowered cap or an earlier funding model stays
  // correctable — the same reasoning as poolBreach's comparison against stored.
  // The ceiling is re-derived from the document being saved, so several grants
  // in one save are judged against each other rather than each in isolation:
  // each one eats the room the next one would have had.
  const nextRows = applyOverrides(data.emp, sanitised);
  computeScalesAndBonuses(nextRows, data);
  for (const grant of impact.grants) {
    const row = nextRows.find((e) => e.id === grant.empId);
    if (!row) continue;
    const ceiling = daHeadroom(row, nextRows, data);
    if (!Number.isFinite(ceiling)) continue;
    if (row.daEdit <= ceiling + DA_EPSILON) continue;
    console.log(
      `[audit] state-write OVER-HEADROOM email=${email} emp=${grant.empId} asked=${row.daEdit.toFixed(2)} ceiling=${ceiling.toFixed(2)} ts=${new Date().toISOString()}`
    );
    return noStore(
      NextResponse.json(
        { error: overHeadroomMessage(grant, ceiling), ceiling, empId: grant.empId },
        { status: 422 }
      )
    );
  }

  // Gate 5: explicit confirmation. A grant spends pool money on top of the
  // calculated bonuses, so the person making it has to see what it does to the
  // pool and say yes. Refused rather than recorded, which is what stops an
  // autosave or a tab-close flush committing one on their behalf.
  if (impact.grants.length > 0 && !confirmDa) {
    console.log(
      `[audit] state-write NEEDS-CONFIRM email=${email} grants=${impact.grants.length} granted=${impact.granted.toFixed(2)} pools=${impact.pools.map((p) => p.key).join(",")} ts=${new Date().toISOString()}`
    );
    return noStore(NextResponse.json({ error: "Confirmation required", impact }, { status: 428 }));
  }

  // Snapshot, then save with optimistic concurrency: a stale version means
  // someone else saved since this client loaded — 409, never silently clobber.
  await takeSnapshot(email, source === "auto" ? "autosave" : "edit");
  const cas = await saveOverridesCas(sanitised, clientVersion);
  if (!cas.ok) {
    console.log(
      `[audit] state-write CONFLICT email=${email} sent=${clientVersion} current=${cas.current} ts=${new Date().toISOString()}`
    );
    // Hand back what is actually stored (scoped to the caller's window) so
    // the client can three-way merge and retry instead of throwing the
    // user's work away. `previous` predates the CAS attempt, so re-load.
    const latest = await loadOverrides();
    return noStore(
      NextResponse.json(
        {
          error: "Someone else saved changes since you loaded",
          current: cas.current,
          overrides: scopeOverridesView(scope, data.emp, latest),
        },
        { status: 409 }
      )
    );
  }
  const ts = new Date().toISOString();
  await appendHistory(
    diffOverrides(data.emp, previous, sanitised, email, ts, viewingAs ?? undefined)
  );
  // The grant log. Separate from the figure-by-figure diff above because a
  // grant is a decision about other people's money, and the record has to hold
  // what bounded it and what it cost them — not just "da 0 → 50,000".
  if (impact.grants.length > 0) {
    await appendHistory(
      impact.grants.map((g) => ({
        ts,
        actor: email,
        kind: "grant" as const,
        summary: grantSummary(g),
        empId: g.empId,
        field: "daEdit",
        from: Math.round(g.from),
        to: Math.round(g.to),
        ...(viewingAs ? { viewingAs } : {}),
      }))
    );
  }
  console.log(
    `[audit] state-write email=${email}${viewingAs ? ` viewing-as=${viewingAs}` : ""} scope=${scope.rule.type} entries=${Object.keys(sanitised).length} version=${cas.version} ts=${new Date().toISOString()}`
  );

  return noStore(
    NextResponse.json({
      ok: true,
      // scoped: an admin gets the whole document back as before, a lead only
      // their own window — the full merged doc would leak out-of-scope figures
      overrides: scopeOverridesView(scope, data.emp, sanitised),
      version: cas.version,
    })
  );
}

/**
 * The refusal, naming the amount. Two shapes, because the honest ask differs:
 * from a balanced starting point the whole overshoot has to come back out,
 * whereas a lead who was already over only has to undo what this save added.
 */
function overPoolMessage(over: number, wasOver: number): string {
  const excess = fmt(over);
  if (wasOver <= 0.01) {
    return `Not saved: ${excess} of this allocation can't be absorbed by your pool. Reduce discretionary amounts by ${excess} and save again.`;
  }
  return `Not saved: this takes you ${fmt(over - wasOver)} further above your pool, which was already over by ${fmt(wasOver)}. Reduce discretionary amounts by ${fmt(over - wasOver)} and save again.`;
}

/**
 * The hard limit's refusal. Names the ceiling, because that is the one figure
 * that lets someone fix it without guessing.
 */
function overHeadroomMessage(grant: DaGrant, ceiling: number): string {
  const room = fmt(Math.max(0, Math.floor(ceiling)));
  return `Not saved: ${fmt(grant.to)} for ${grant.name} would take the pool past its cap. At most ${room} can be granted before the pool reaches its cap. Reduce it to ${room} or less and save again.`;
}

/**
 * One line for the audit trail: what was granted and what bounded it. The
 * headroom is the room the caps had left at the time, which is the figure that
 * makes the decision reviewable later — a grant that used most of it reads very
 * differently from one that barely touched it.
 */
function grantSummary(grant: DaGrant): string {
  const who = grant.name;
  const headroom = Number.isFinite(grant.headroom)
    ? `room under the caps at the time ${fmt(Math.max(0, Math.floor(grant.headroom)))}`
    : "no cap bound";
  if (grant.amount < 0) {
    return `Discretionary for ${who} reduced from ${fmt(grant.from)} to ${fmt(grant.to)} (${headroom})`;
  }
  return `Discretionary grant of ${fmt(grant.amount)} to ${who}, now ${fmt(grant.to)} (${headroom})`;
}

function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}
