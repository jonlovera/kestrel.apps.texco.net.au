import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import {
  scopeForUser,
  allRules,
  isSeeded,
  AccessRuleSchema,
} from "@/lib/access";
import { OWNER_EMAIL } from "@/lib/access-rules";
import { loadAccessOverlay, saveAccessOverlay } from "@/lib/store";
import { getBonusData } from "@/lib/data";

export const dynamic = "force-dynamic";

const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254);

async function requireAdmin() {
  const session = await auth();
  const email = session?.user?.email;
  const scope = await scopeForUser(email);
  if (!email || !scope) return { error: 401 as const };
  if (!scope.canEdit) {
    console.log(
      `[audit] DENIED access-manage email=${email} ts=${new Date().toISOString()}`
    );
    return { error: 403 as const };
  }
  return { email };
}

function noStore<T extends NextResponse>(res: T): T {
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}

export async function GET() {
  const admin = await requireAdmin();
  if ("error" in admin)
    return noStore(NextResponse.json({ error: "Denied" }, { status: admin.error }));

  const rules = await allRules();
  const list = Object.entries(rules)
    .map(([email, eff]) => ({ email, rule: eff.rule, source: eff.source }))
    .sort((a, b) => a.email.localeCompare(b.email));
  return noStore(NextResponse.json({ rules: list }));
}

export async function POST(req: Request) {
  const admin = await requireAdmin();
  if ("error" in admin)
    return noStore(NextResponse.json({ error: "Denied" }, { status: admin.error }));

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
    const known = new Set(getBonusData().emp.map((e) => e.id));
    const bad = body.rule.employeeIds.filter((id) => !known.has(id));
    if (bad.length) {
      return noStore(
        NextResponse.json({ error: `Unknown employee ids: ${bad.join(", ")}` }, { status: 400 })
      );
    }
  }

  const overlay = await loadAccessOverlay();
  overlay[body.email] = body.rule;
  await saveAccessOverlay(overlay);
  console.log(
    `[audit] access-change by=${admin.email} target=${body.email} action=upsert rule=${body.rule.type} ts=${new Date().toISOString()}`
  );
  return GET();
}

export async function DELETE(req: Request) {
  const admin = await requireAdmin();
  if ("error" in admin)
    return noStore(NextResponse.json({ error: "Denied" }, { status: admin.error }));

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

  const overlay = await loadAccessOverlay();
  if (await isSeeded(email)) {
    overlay[email] = { type: "none" }; // shadow the code/env-seeded entry
  } else {
    delete overlay[email];
  }
  await saveAccessOverlay(overlay);
  console.log(
    `[audit] access-change by=${admin.email} target=${email} action=remove ts=${new Date().toISOString()}`
  );
  return GET();
}
