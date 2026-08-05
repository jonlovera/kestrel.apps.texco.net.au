import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { scopeForUser } from "@/lib/access";
import { getEffectiveDataset } from "@/lib/data";
import { saveOverridesCas, loadOverrides, appendHistory } from "@/lib/store";
import { OverridesSchema, type Overrides } from "@/lib/schema";
import { z } from "zod";
import { diffOverrides } from "@/lib/history-diff";
import { takeSnapshot } from "@/lib/snapshots";
import {
  applyOverrides,
  computeScalesAndBonuses,
  getMaxDA,
} from "@/lib/calc";

export const dynamic = "force-dynamic";

/**
 * Persist the editors' adjustments. Full-access users only. The client sends
 * the whole overrides doc; the server never trusts client-computed numbers —
 * it re-applies the prototype's input rules and recomputes/refreezes locked
 * finals from the base data before storing.
 */
export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  const scope = await scopeForUser(email);

  if (!email || !scope) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!scope.canEdit) {
    console.log(
      `[audit] DENIED state-write email=${email} scope=${scope.rule.type} ts=${new Date().toISOString()}`
    );
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let incoming: Overrides;
  let clientVersion: number;
  try {
    const body = z
      .object({
        version: z.number().int().min(0),
        overrides: OverridesSchema,
      })
      .parse(await req.json());
    incoming = body.overrides;
    clientVersion = body.version;
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const data = await getEffectiveDataset();
  const known = new Map(data.emp.map((e) => [e.id, e]));

  // Sanitise: drop unknown ids and clamp ranges. Prototype rules: Bonus%/IPM%
  // are editable on all rows (site managers included — it changes their fixed
  // bonus); DA and locks don't apply to site managers or zero-weight rows.
  const sanitised: Overrides = {};
  for (const [id, ov] of Object.entries(incoming)) {
    const emp = known.get(id);
    if (!emp) continue;
    const clean: Overrides[string] = {};
    if (ov.bpEdit !== undefined) clean.bpEdit = Math.max(0, ov.bpEdit);
    if (ov.ipmEdit !== undefined) clean.ipmEdit = Math.max(0, ov.ipmEdit);
    if (!emp.sm) {
      if (ov.daEdit !== undefined && emp.vp + emp.np > 0)
        clean.daEdit = Math.max(0, ov.daEdit);
      if (ov.locked) {
        clean.locked = true;
        clean.lockedFinal = ov.lockedFinal; // recomputed below if absent/bogus
      }
    }
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
    ov.lockedFinal = emps.find((e) => e.id === id)!.calcBonus;
  }

  // Clamp DAs to what the pool (with locks in place) can absorb — the
  // prototype's updateDA rule.
  const emps = applyOverrides(data.emp, sanitised);
  const pool = computeScalesAndBonuses(emps, data);
  const byId = new Map(emps.map((e) => [e.id, e]));
  for (const [id, ov] of Object.entries(sanitised)) {
    if (ov.daEdit !== undefined && !ov.locked) {
      const maxDa = getMaxDA(byId.get(id)!, pool);
      if (ov.daEdit > maxDa) ov.daEdit = maxDa;
    }
  }

  // Snapshot (coalesced for rapid edits), then save with optimistic
  // concurrency: a stale version means someone else saved since this
  // client loaded — 409, never silently clobber their changes.
  await takeSnapshot(email, "edit");
  const previous = await loadOverrides();
  const cas = await saveOverridesCas(sanitised, clientVersion);
  if (!cas.ok) {
    console.log(
      `[audit] state-write CONFLICT email=${email} sent=${clientVersion} current=${cas.current} ts=${new Date().toISOString()}`
    );
    const res = NextResponse.json(
      { error: "Version conflict — someone else saved changes", current: cas.current },
      { status: 409 }
    );
    res.headers.set("Cache-Control", "no-store, max-age=0");
    return res;
  }
  await appendHistory(
    diffOverrides(data.emp, previous, sanitised, email, new Date().toISOString())
  );
  console.log(
    `[audit] state-write email=${email} entries=${Object.keys(sanitised).length} version=${cas.version} ts=${new Date().toISOString()}`
  );

  const res = NextResponse.json({
    ok: true,
    overrides: sanitised,
    version: cas.version,
  });
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}
