import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { scopeForUser } from "@/lib/access";
import { getBonusData } from "@/lib/data";
import { saveOverrides, loadOverrides, appendHistory } from "@/lib/store";
import { OverridesSchema, type Overrides } from "@/lib/schema";
import { diffOverrides } from "@/lib/history-diff";
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
  try {
    incoming = OverridesSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const data = getBonusData();
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

  // Record who changed what before overwriting the previous doc.
  const previous = await loadOverrides();
  await saveOverrides(sanitised);
  await appendHistory(
    diffOverrides(data.emp, previous, sanitised, email, new Date().toISOString())
  );
  console.log(
    `[audit] state-write email=${email} entries=${Object.keys(sanitised).length} ts=${new Date().toISOString()}`
  );

  const res = NextResponse.json({ ok: true, overrides: sanitised });
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}
