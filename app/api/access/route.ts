import { NextResponse } from "next/server";
import { z } from "zod";
import { allRules, isSeeded, peerRules, AccessRuleSchema } from "@/lib/access";
import { requireWriter } from "@/lib/api-guard";
import type { Scope } from "@/lib/access";
import { OWNER_EMAIL, describeRule } from "@/lib/access-rules";
import { loadAccessOverlay, saveAccessOverlay, appendHistory } from "@/lib/store";
import { getDataset, getEffectiveDataset } from "@/lib/data";
import { takeSnapshot } from "@/lib/snapshots";
import { loadOverrides } from "@/lib/store";
import { applyOverrides, computeScalesAndBonuses } from "@/lib/calc";
import {
  EPSILON,
  capIsStatePool,
  countsAgainstPool,
  maxAdditionalAllocation,
} from "@/lib/manager-pool";
import { canChangeCaps } from "@/lib/params-apply";
import { ruleMatches } from "@/lib/access-rules";
import { fmt } from "@/lib/fmt";

export const dynamic = "force-dynamic";

const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254);

async function requireAdmin(): Promise<
  { email: string; scope: Scope } | { error: NextResponse }
> {
  const guard = await requireWriter("access-manage");
  if ("response" in guard) return { error: guard.response };
  // The scope rides along, not just the email: setting a lead's pool cap is
  // gated on `canEditCaps` (canChangeCaps), which needs the rule and not only
  // who they are.
  return { email: guard.email, scope: guard.scope };
}

function noStore<T extends NextResponse>(res: T): T {
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}

export async function GET() {
  const admin = await requireAdmin();
  if ("error" in admin) return noStore(admin.error);

  const rules = await allRules();
  const list = Object.entries(rules)
    .map(([email, eff]) => ({ email, rule: eff.rule, source: eff.source }))
    .sort((a, b) => a.email.localeCompare(b.email));
  return noStore(NextResponse.json({ rules: list }));
}

export async function POST(req: Request) {
  const admin = await requireAdmin();
  if ("error" in admin) return noStore(admin.error);

  let body: {
    email: string;
    rule: z.infer<typeof AccessRuleSchema>;
    allocationAllowance?: number;
  };
  try {
    body = z
      .object({
        email: EmailSchema,
        rule: AccessRuleSchema,
        // ADDITIONAL allocation, in dollars — what /admin's editor actually
        // takes. A sibling of `rule` rather than a field on it, because what
        // gets STORED is the resulting cap and only this route may work that
        // out: it needs the lead's live allocation, and an admin page rendered
        // a minute ago would compute it from a stale figure. Absent means "no
        // opinion", which carries the stored cap forward untouched.
        allocationAllowance: z.number().min(0).max(50_000_000).optional(),
      })
      .parse(await req.json());
  } catch {
    return noStore(NextResponse.json({ error: "Invalid payload" }, { status: 400 }));
  }
  if (body.rule.type === "none") {
    return noStore(NextResponse.json({ error: "Use DELETE to remove access" }, { status: 400 }));
  }
  if (body.email === admin.email && body.rule.type !== "full") {
    return noStore(
      NextResponse.json({ error: "You can't downgrade your own access" }, { status: 400 })
    );
  }
  // Subset rules must reference real employee ids.
  if (body.rule.type === "subset") {
    const known = new Set((await getDataset()).emp.map((e) => e.id));
    const bad = body.rule.employeeIds.filter((id) => !known.has(id));
    if (bad.length) {
      return noStore(
        NextResponse.json({ error: `Unknown employee ids: ${bad.join(", ")}` }, { status: 400 })
      );
    }
  }
  // A group naming a position nobody holds would silently grant access to
  // nothing, which looks identical to a working rule from the access table.
  if (body.rule.type === "group" && body.rule.positions.length) {
    const known = new Set((await getDataset()).emp.map((e) => e.pos));
    const bad = body.rule.positions.filter((p) => !known.has(p));
    if (bad.length) {
      return noStore(
        NextResponse.json(
          { error: `No such role${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}` },
          { status: 400 }
        )
      );
    }
  }

  // Normalise the "can act for" delegation once, here, so the stored list is
  // always clean emails: the schema deliberately keeps the element a plain
  // string (a stored oddity must never fail the whole overlay parse).
  {
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of body.rule.canActAs) {
      const parsed = EmailSchema.safeParse(raw);
      if (!parsed.success) {
        return noStore(
          NextResponse.json(
            { error: `Invalid email in Can act for: ${raw}` },
            { status: 400 }
          )
        );
      }
      // self-delegation is inert by construction (viewing yourself is a
      // no-op), so dropping it keeps the stored list honest
      if (parsed.data === body.email || seen.has(parsed.data)) continue;
      seen.add(parsed.data);
      cleaned.push(parsed.data);
    }
    body.rule.canActAs = cleaned;
  }

  // ── the pool cap ────────────────────────────────────────────────────────
  //
  // What arrives is an ALLOWANCE (additional dollars); what is stored is the
  // resulting cap. See lib/access-rules.ts's allocationCap for why the frozen
  // sum has to be the persisted one.
  if (body.rule.type === "full" && body.allocationAllowance !== undefined) {
    return noStore(
      NextResponse.json(
        { error: "Full access has no pool cap to set." },
        { status: 400 }
      )
    );
  }
  const before = (await allRules())[body.email]?.rule;
  const existed = before !== undefined;
  const storedCap =
    before && before.type !== "full" ? before.allocationCap : undefined;

  let capBy = before && before.type !== "full" ? before.allocationCapBy : undefined;
  let capAt = before && before.type !== "full" ? before.allocationCapAt : undefined;
  // Carried forward by default. The editor rebuilds the whole rule on every
  // save, so without this an admin correcting somebody's visible fields would
  // silently wipe their allowance.
  let cap = storedCap;

  if (body.rule.type !== "full" && body.allocationAllowance !== undefined) {
    if (!canChangeCaps(admin.scope)) {
      return noStore(
        NextResponse.json(
          { error: "You don't have permission to set a bonus allocation." },
          { status: 403 }
        )
      );
    }
    if (capIsStatePool(body.rule)) {
      // A whole-state lead's cap IS the state pool, and that identity is not an
      // admin's to override (owner decision, 28 Aug 2026). Refused rather than
      // ignored, so nobody believes they set something that did nothing.
      return noStore(
        NextResponse.json(
          {
            error:
              "A whole-state scope's pool cap is the state pool itself and can't be set by hand.",
          },
          { status: 400 }
        )
      );
    }

    // Measured HERE, from live figures, so a stale admin page cannot write a
    // wrong ceiling.
    const data = await getEffectiveDataset();
    const emps = applyOverrides(data.emp, await loadOverrides());
    computeScalesAndBonuses(emps, data);

    let allocated = 0;
    for (const e of emps) {
      if (ruleMatches(body.rule, e) && countsAgainstPool(e)) {
        allocated += e.finalBonus;
      }
    }

    const peers = await peerRules(body.email);
    const most = maxAdditionalAllocation(body.rule, peers, emps, data);
    if (body.allocationAllowance > most + EPSILON) {
      return noStore(
        NextResponse.json(
          {
            error: `That's more than the pool has left to give. At most ${fmt(
              Math.max(0, most)
            )} can be allocated to ${body.email} right now.`,
            max: Math.max(0, most),
          },
          { status: 400 }
        )
      );
    }

    // The cap is allocation + allowance, so it can never land below what is
    // already committed and an admin cannot manufacture a historical overspend.
    cap = allocated + body.allocationAllowance;
    capBy = admin.email;
    capAt = new Date().toISOString();
  }

  if (body.rule.type !== "full") {
    if (capIsStatePool(body.rule)) {
      // Nothing to store for a whole-state scope, and leaving a stale figure on
      // one would be a trap for whoever reads the rule next.
      delete body.rule.allocationCap;
      delete body.rule.allocationCapBy;
      delete body.rule.allocationCapAt;
    } else {
      body.rule.allocationCap = cap;
      body.rule.allocationCapBy = cap === undefined ? undefined : capBy;
      body.rule.allocationCapAt = cap === undefined ? undefined : capAt;
    }
  }

  await takeSnapshot(admin.email, "access-change");
  const overlay = await loadAccessOverlay();
  overlay[body.email] = body.rule;
  await saveAccessOverlay(overlay);
  const ts = new Date().toISOString();
  const entries = [
    {
      ts,
      actor: admin.email,
      kind: "access" as const,
      summary: `${existed ? "Changed" : "Granted"} access for ${body.email}: ${describeRule(body.rule)}`,
      target: body.email,
    },
  ];
  // The cap change gets its own entry with the before/after triple the history
  // schema already carries, so the figure is queryable and not only prose.
  if (cap !== storedCap) {
    entries.push({
      ts,
      actor: admin.email,
      kind: "access" as const,
      summary:
        cap === undefined
          ? `Removed the bonus allocation cap for ${body.email}`
          : `Set ${body.email}'s bonus allocation cap to ${fmt(cap)} (${fmt(
              body.allocationAllowance ?? 0
            )} additional)`,
      target: body.email,
      field: "allocationCap",
      from: storedCap ?? null,
      to: cap ?? null,
    } as (typeof entries)[number]);
  }
  await appendHistory(entries);
  console.log(
    `[audit] access-change by=${admin.email} target=${body.email} action=upsert rule=${body.rule.type} cap=${cap ?? "none"} ts=${ts}`
  );
  return GET();
}

export async function DELETE(req: Request) {
  const admin = await requireAdmin();
  if ("error" in admin) return noStore(admin.error);

  let email: string;
  try {
    ({ email } = z.object({ email: EmailSchema }).parse(await req.json()));
  } catch {
    return noStore(NextResponse.json({ error: "Invalid payload" }, { status: 400 }));
  }
  if (email === admin.email) {
    return noStore(
      NextResponse.json({ error: "You can't remove your own access" }, { status: 400 })
    );
  }
  if (email === OWNER_EMAIL) {
    return noStore(
      NextResponse.json(
        { error: "This account is protected and can only be changed in code" },
        { status: 400 }
      )
    );
  }

  await takeSnapshot(admin.email, "access-change");
  const overlay = await loadAccessOverlay();
  if (await isSeeded(email)) {
    overlay[email] = { type: "none" }; // shadow the code/env-seeded entry
  } else {
    delete overlay[email];
  }
  await saveAccessOverlay(overlay);
  const ts = new Date().toISOString();
  await appendHistory([
    {
      ts,
      actor: admin.email,
      kind: "access",
      summary: `Removed access for ${email}`,
      target: email,
    },
  ]);
  console.log(
    `[audit] access-change by=${admin.email} target=${email} action=remove ts=${ts}`
  );
  return GET();
}
