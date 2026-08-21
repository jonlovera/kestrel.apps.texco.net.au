import { NextResponse } from "next/server";
import { getEffectiveDataset } from "@/lib/data";
import { requireScopedWriter } from "@/lib/api-guard";
import { saveOverridesCas, loadOverrides, appendHistory } from "@/lib/store";
import { OverridesSchema, type Overrides } from "@/lib/schema";
import { z } from "zod";
import { diffOverrides } from "@/lib/history-diff";
import { takeSnapshot } from "@/lib/snapshots";
import { sanitiseOverrideWrite, scopeOverridesView } from "@/lib/write-scope";
import { applyOverrides, computeScalesAndBonuses } from "@/lib/calc";

export const dynamic = "force-dynamic";

/**
 * Commit the allocation. Full access and state leads both, which is the change
 * this route exists to absorb: it used to refuse anyone without `canEdit`, and
 * a lead can now set IPM and Discretionary for their own people.
 *
 * Two gates, in order:
 *   1. lib/write-scope.ts — is this row theirs, and is this field theirs?
 *      Anything else is dropped and the stored value kept.
 *   2. the scheme's own rules below — site managers take no discretionary
 *      adjustment, nor does anyone outside the pools, and an adjustment is
 *      clamped to what the pool can actually absorb.
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
      })
      .parse(await req.json());
    incoming = body.overrides;
    clientVersion = body.version;
    source = body.source;
    viewFor = body.viewFor;
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
    if (emp.sm || emp.vp + emp.np <= 0) {
      // a fixed bonus has nothing to adjust, and neither does a row that
      // draws from no pool
      delete clean.daEdit;
      delete clean.locked;
      delete clean.lockedFinal;
    }
    // daEdit is deliberately not floored: an adjustment may be negative
    // (owner decision — DA is a manual +/- amount on top of the pool calc)
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
  await appendHistory(
    diffOverrides(
      data.emp,
      previous,
      sanitised,
      email,
      new Date().toISOString(),
      viewingAs ?? undefined
    )
  );
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

function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}
