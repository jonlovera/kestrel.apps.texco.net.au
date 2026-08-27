import { NextResponse } from "next/server";
import { getEffectiveDataset } from "@/lib/data";
import { requireWriter, noStore } from "@/lib/api-guard";
import {
  loadOverrides,
  saveOverridesCas,
  loadOverridesVersion,
  appendHistory,
} from "@/lib/store";
import { takeSnapshot } from "@/lib/snapshots";
import { canLockRows, canRevokeIssued } from "@/lib/write-scope";
import { applyOverrides, computeScalesAndBonuses } from "@/lib/calc";
import type { Overrides } from "@/lib/schema";
import { fmt } from "@/lib/fmt";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * MARK AS ISSUED — commit one row's Final Bonus.
 *
 * The workflow is unlocked → locked → issued, and this is the last step of it.
 * A lock is a temporary freeze that an admin flips back and forth and that
 * "Unlock all" clears in bulk; an issue is a decision that has left the
 * building. So the amount is captured here, stored on the row, and from that
 * moment nothing derives it: lib/calc.ts reads `issued.amount` straight out as
 * finalBonus, and the three editability predicates refuse the row outright.
 * That single stored figure is what protects it from a Recalculate, an IPM
 * edit, a discretionary edit and an unlock alike.
 *
 * Its own route rather than a field on /api/state, deliberately. `issued` is
 * absent from WRITABLE_BY_ADMIN (lib/write-scope.ts), so no ordinary save can
 * set one, clear one or alter one no matter what it sends — the protection is
 * the absence, and it only holds while there is exactly one writer.
 *
 * THE AMOUNT IS NEVER TAKEN FROM THE CLIENT. It is re-derived here from the
 * stored document, for the same reason every other figure in this app is: the
 * client sends what it wants and the server decides what is true. A client
 * that sent its own number could commit a figure nobody's screen ever showed.
 *
 * Reverting is possible, but only for the holders of a separate grant — see the
 * DELETE handler below. Issuing stays a one-way door for everybody else, which
 * is the whole point of it.
 */
export async function POST(req: Request) {
  const guard = await requireWriter("issue");
  if ("response" in guard) return guard.response;
  const { email, scope } = guard;

  // Issuing is bounded by the authority to LOCK, which full access confers and
  // a lead may be granted. There is no separate "can issue" grant: the brief
  // did not ask for one, and issuing is the terminal step of the lock workflow
  // rather than a different kind of act.
  if (!canLockRows(scope)) {
    console.log(
      `[audit] issue DENIED email=${email} reason=not-granted ts=${new Date().toISOString()}`
    );
    return noStore(
      NextResponse.json(
        { error: "You don't have permission to issue a bonus." },
        { status: 403 }
      )
    );
  }

  let empId: string;
  let clientVersion: number;
  try {
    const body = z
      .object({ empId: z.string().min(1), version: z.number().int().min(0) })
      .parse(await req.json());
    empId = body.empId;
    clientVersion = body.version;
  } catch {
    return noStore(
      NextResponse.json({ error: "Invalid payload" }, { status: 400 })
    );
  }

  const [data, previous] = await Promise.all([
    getEffectiveDataset(),
    loadOverrides(),
  ]);

  if (!data.emp.some((e) => e.id === empId)) {
    return noStore(
      NextResponse.json({ error: "Unknown employee" }, { status: 404 })
    );
  }

  const stored = previous[empId] ?? {};
  if (stored.issued !== undefined) {
    return noStore(
      NextResponse.json(
        { error: "That bonus has already been issued." },
        { status: 409 }
      )
    );
  }
  // The STORED lock, not one typed a moment ago and not yet saved. Issuing
  // freezes a figure permanently, so the freeze it is built on has to be one
  // the server can actually see — the same rule the letter button applies
  // before it will produce a document.
  if (stored.locked !== true) {
    return noStore(
      NextResponse.json(
        { error: "Lock the row and save before issuing it." },
        { status: 422 }
      )
    );
  }

  const emps = applyOverrides(data.emp, previous);
  computeScalesAndBonuses(emps, data);
  const row = emps.find((e) => e.id === empId)!;
  const amount = row.finalBonus;

  const ts = new Date().toISOString();
  const next: Overrides = {
    ...previous,
    [empId]: { ...stored, issued: { amount, at: ts, by: email } },
  };

  await takeSnapshot(email, "issue");
  const cas = await saveOverridesCas(next, clientVersion);
  if (!cas.ok) {
    const current = await loadOverridesVersion();
    console.log(
      `[audit] issue CONFLICT email=${email} emp=${empId} sent=${clientVersion} current=${current} ts=${ts}`
    );
    return noStore(
      NextResponse.json(
        {
          error:
            "Someone else saved changes since you loaded. Reload and issue again.",
          current,
        },
        { status: 409 }
      )
    );
  }

  await appendHistory([
    {
      ts,
      actor: email,
      kind: "lock",
      summary: `Issued ${row.gn} ${row.sn}'s bonus at ${fmt(amount)} — committed, and no longer affected by recalculation, IPM, discretionary or unlocking`,
      empId,
      field: "issued",
      from: null,
      to: Math.round(amount),
    },
  ]);

  console.log(
    `[audit] issue email=${email} emp=${empId} amount=${amount.toFixed(2)} version=${cas.version} ts=${ts}`
  );

  return noStore(
    NextResponse.json({
      ok: true,
      empId,
      issued: { amount, at: ts, by: email },
      version: cas.version,
    })
  );
}

/**
 * REVERT an issued bonus — back to merely locked.
 *
 * Issuing is a one-way door by design, and stays one for everybody except the
 * holders of `canRevokeIssued` (lib/access-rules.ts), which is its own grant and
 * NOT implied by the ability to issue. The person who commits an amount is not
 * automatically the person who may un-commit one.
 *
 * Why the door needs a key at all: without one, a mis-click on a button sitting
 * beside the padlock could only be undone by restoring a snapshot, which rolls
 * back everybody else's work in the same motion. A targeted revert is the far
 * smaller blast radius.
 *
 * NUMBER-NEUTRAL, by construction. The row comes back to exactly the payout it
 * was issued at:
 *  - `baseAmount` cannot have moved while the row was issued — Recalculate skips
 *    issued rows (lib/recalculate.ts's isFixed), lib/reprice.ts skips them, and
 *    no client can write the field at all (lib/write-scope.ts);
 *  - `daEdit` cannot have moved either — gate 2 reverts every edit aimed at an
 *    issued row (lib/scheme-gate.ts);
 *  - so `baseAmount + daEdit` is still the figure captured in the stamp, which
 *    is what the engine falls back to the moment the stamp is gone.
 * The one row that could drift is a legacy one carrying no `baseAmount` at all
 * (its payout falls back to the advisory calc bonus, which a Recalculate in the
 * meantime WOULD have moved). For that row the base is materialised from the
 * stamp below, so neutrality holds for every row rather than for most of them.
 *
 * The lock is kept. Reverting steps back exactly one place in
 * unlocked -> locked -> issued: the row stays frozen, so nothing can reach it in
 * the moment it stops being committed, and it can be re-issued immediately.
 */
export async function DELETE(req: Request) {
  const guard = await requireWriter("issue-revoke");
  if ("response" in guard) return guard.response;
  const { email, scope } = guard;

  if (!canRevokeIssued(scope)) {
    console.log(
      `[audit] issue-revoke DENIED email=${email} reason=not-granted ts=${new Date().toISOString()}`
    );
    return noStore(
      NextResponse.json(
        { error: "You don't have permission to revert an issued bonus." },
        { status: 403 }
      )
    );
  }

  let empId: string;
  let clientVersion: number;
  try {
    const body = z
      .object({ empId: z.string().min(1), version: z.number().int().min(0) })
      .parse(await req.json());
    empId = body.empId;
    clientVersion = body.version;
  } catch {
    return noStore(
      NextResponse.json({ error: "Invalid payload" }, { status: 400 })
    );
  }

  const [data, previous] = await Promise.all([
    getEffectiveDataset(),
    loadOverrides(),
  ]);

  if (!data.emp.some((e) => e.id === empId)) {
    return noStore(
      NextResponse.json({ error: "Unknown employee" }, { status: 404 })
    );
  }

  const stored = previous[empId] ?? {};
  const issued = stored.issued;
  if (issued === undefined) {
    return noStore(
      NextResponse.json(
        { error: "That bonus has not been issued." },
        { status: 409 }
      )
    );
  }

  // Priced WITH the stamp still on, so daEdit is the frozen figure the stamp was
  // captured against — the one that makes the base below reconstruct exactly.
  const emps = applyOverrides(data.emp, previous);
  computeScalesAndBonuses(emps, data);
  const row = emps.find((e) => e.id === empId)!;

  const restored: Overrides[string] = { ...stored, locked: true };
  delete restored.issued;
  // Only when the row has no stored base of its own: writing one otherwise would
  // swap a settled figure for the same figure re-derived through a subtraction,
  // and pick up a float's worth of noise for nothing.
  if (restored.baseAmount === undefined) {
    restored.baseAmount = issued.amount - row.daEdit;
  }

  const ts = new Date().toISOString();
  const next: Overrides = { ...previous, [empId]: restored };

  await takeSnapshot(email, "issue-revoke");
  const cas = await saveOverridesCas(next, clientVersion);
  if (!cas.ok) {
    const current = await loadOverridesVersion();
    console.log(
      `[audit] issue-revoke CONFLICT email=${email} emp=${empId} sent=${clientVersion} current=${current} ts=${ts}`
    );
    return noStore(
      NextResponse.json(
        {
          error:
            "Someone else saved changes since you loaded. Reload and try again.",
          current,
        },
        { status: 409 }
      )
    );
  }

  await appendHistory([
    {
      ts,
      actor: email,
      kind: "lock",
      summary: `Reverted ${row.gn} ${row.sn}'s issued bonus of ${fmt(issued.amount)} back to locked — it had been issued by ${issued.by} on ${issued.at.slice(0, 10)}. The amount is unchanged; the row is no longer committed.`,
      empId,
      field: "issued",
      from: Math.round(issued.amount),
      to: null,
    },
  ]);

  console.log(
    `[audit] issue-revoke email=${email} emp=${empId} amount=${issued.amount.toFixed(2)} version=${cas.version} ts=${ts}`
  );

  return noStore(
    NextResponse.json({ ok: true, empId, version: cas.version })
  );
}
