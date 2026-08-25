import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getEffectiveDataset } from "@/lib/data";
import { loadOverrides } from "@/lib/store";
import { resolveViewer } from "@/lib/view-as";
import { canDownloadLetters } from "@/lib/write-scope";
import { ruleMatches } from "@/lib/access-rules";
import { applyOverrides, computeScalesAndBonuses } from "@/lib/calc";
import { signatureRouteFor, signatoriesFor } from "@/lib/letter-blocks";
import { buildLetter, letterFilename } from "@/lib/letter-docx";

export const dynamic = "force-dynamic";

/**
 * Download one person's FY27 Remuneration Review / FY26 EBS Award letter.
 *
 * Four gates, and every one of them matters for a different reason:
 *
 *  1. THE GRANT. `canDownloadLetter` is its own permission held by admins and
 *     leads alike, or by neither — full access does not confer it (see
 *     lib/access-rules.ts). This letter goes out of the building over a
 *     director's signature.
 *  2. SCOPE. The row has to be one this person can already see. Without this a
 *     lead holding the grant could pull any employee's letter by guessing an
 *     id, which would hand them a salary they are not entitled to — the grant
 *     says "may produce letters", never "may produce anyone's".
 *  3. LOCKED. The letter states a final bonus, so there has to be a final
 *     bonus. An unlocked figure is still moving.
 *  4. A SIGNATURE. Someone whose manager routes to no signature block gets no
 *     letter rather than an unsigned one.
 *
 * The dashboard greys the control out for 3 and 4 and hides it for 1, so
 * reaching most of these means a crafted request — but each is decided here
 * regardless, because the table's state is a convenience and this is the
 * boundary.
 *
 * Resolved through the view-as layer like every other route, so an admin
 * looking at a lead's dashboard is treated as that lead: they see what that
 * person could actually download rather than what they themselves could.
 */
export async function GET(req: Request) {
  const { actor, scope } = await resolveViewer();
  if (!actor || !scope) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "No employee given" }, { status: 400 });
  }

  const deny = (reason: string, error: string, status = 403) => {
    console.log(
      `[audit] DENIED letter email=${actor} emp=${id} reason=${reason} scope=${scope.rule.type} ts=${new Date().toISOString()}`
    );
    return NextResponse.json({ error }, { status });
  };

  // 1. the grant
  if (!canDownloadLetters(scope)) {
    return deny("not-granted", "You don't have access to download letters.");
  }

  const [data, overrides] = await Promise.all([
    getEffectiveDataset(),
    loadOverrides(),
  ]);
  const rows = applyOverrides(data.emp, overrides);
  computeScalesAndBonuses(rows, data);

  const emp = rows.find((e) => e.id === id);
  // 2. scope — deliberately the same "not found" answer as a genuinely unknown
  // id, so this cannot be used to probe which ids exist outside their scope
  if (!emp || !ruleMatches(scope.rule, emp)) {
    return deny("out-of-scope", "That employee isn't in your view.", 404);
  }

  // 3. locked
  if (!emp.locked) {
    return deny(
      "not-locked",
      `${emp.gn} ${emp.sn} isn't locked yet. Lock the row first — the letter states a final bonus.`,
      409
    );
  }

  // 4. a signature to sign it with
  const route = signatureRouteFor(emp);
  if (!route) {
    return deny(
      "no-signature",
      `No signature on file for ${emp.mgr}, so a letter can't be produced for ${emp.gn} ${emp.sn}.`,
      409
    );
  }

  const template = await readFile(
    join(process.cwd(), "lib", "templates", "remuneration-letter.docx")
  );
  const bytes = await buildLetter(template, emp, route);

  console.log(
    `[audit] letter email=${actor} emp=${emp.id} name="${emp.gn} ${emp.sn}" signed="${signatoriesFor(route).join(" + ")}" bonus=${emp.finalBonus.toFixed(2)} ts=${new Date().toISOString()}`
  );

  const filename = letterFilename(emp);
  return new NextResponse(bytes as BodyInit, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
