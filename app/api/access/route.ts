import { NextResponse } from "next/server";
import { z } from "zod";
import { allRules, isSeeded, AccessRuleSchema } from "@/lib/access";
import { requireWriter } from "@/lib/api-guard";
import { OWNER_EMAIL, describeEditing } from "@/lib/access-rules";
import { loadAccessOverlay, saveAccessOverlay, appendHistory } from "@/lib/store";
import { getDataset } from "@/lib/data";
import { takeSnapshot } from "@/lib/snapshots";

function describeRule(rule: z.infer<typeof AccessRuleSchema>): string {
  if (rule.type === "none") return "no access";
  if (rule.type === "full") return "full access";
  // The history has to record what they may CHANGE, not just what they see:
  // a rule going read-only is the whole point of the entry.
  const editing = describeEditing(rule);
  if (rule.type === "state") return `${rule.states.join(" + ")} / ${editing}`;
  if (rule.type === "group") {
    const where = rule.states.length ? rule.states.join(" + ") : "all states";
    const who = rule.positions.length ? rule.positions.join(", ") : "all roles";
    return `${where} / ${who} / ${editing}`;
  }
  return `${rule.employeeIds.length} selected employee${
    rule.employeeIds.length === 1 ? "" : "s"
  } / ${editing}`;
}

export const dynamic = "force-dynamic";

const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254);

async function requireAdmin(): Promise<
  { email: string } | { error: NextResponse }
> {
  const guard = await requireWriter("access-manage");
  if ("response" in guard) return { error: guard.response };
  return { email: guard.email };
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

  let body: { email: string; rule: z.infer<typeof AccessRuleSchema> };
  try {
    body = z
      .object({ email: EmailSchema, rule: AccessRuleSchema })
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

  await takeSnapshot(admin.email, "access-change");
  const overlay = await loadAccessOverlay();
  const existed = (await allRules())[body.email] !== undefined;
  overlay[body.email] = body.rule;
  await saveAccessOverlay(overlay);
  const ts = new Date().toISOString();
  await appendHistory([
    {
      ts,
      actor: admin.email,
      kind: "access",
      summary: `${existed ? "Changed" : "Granted"} access for ${body.email}: ${describeRule(body.rule)}`,
      target: body.email,
    },
  ]);
  console.log(
    `[audit] access-change by=${admin.email} target=${body.email} action=upsert rule=${body.rule.type} ts=${ts}`
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
