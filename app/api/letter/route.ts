import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getEffectiveDataset } from "@/lib/data";
import { loadOverrides, loadPackageIncreases } from "@/lib/store";
import { resolveViewer } from "@/lib/view-as";
import { canDownloadLetters } from "@/lib/write-scope";
import { ruleMatches } from "@/lib/access-rules";
import { applyOverrides, computeScalesAndBonuses } from "@/lib/calc";
import { signatureRouteFor, signatoriesFor } from "@/lib/letter-blocks";
import { buildLetter, letterFilename, type LetterFormat } from "@/lib/letter-docx";
import { resolveLetterPackage } from "@/lib/remuneration";
import { convertToPdf, converterReady, PdfConversionError } from "@/lib/letter-pdf";

export const dynamic = "force-dynamic";
// A cold PDF is ~9s (fetching and unpacking LibreOffice); a warm one ~1s.
export const maxDuration = 300;

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

  const params = new URL(req.url).searchParams;
  const id = params.get("id");
  if (!id) {
    return NextResponse.json({ error: "No employee given" }, { status: 400 });
  }

  // An allow-list, not a truthy check: an unrecognised format is a mistake
  // worth reporting, never a silent fall back to Word when someone asked for
  // a PDF and will send on whatever arrives.
  const requested = params.get("format") ?? "docx";
  if (requested !== "docx" && requested !== "pdf") {
    return NextResponse.json(
      { error: `Unknown format "${requested}" — expected docx or pdf.` },
      { status: 400 }
    );
  }
  const format: LetterFormat = requested;

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

  const [data, overrides, review] = await Promise.all([
    getEffectiveDataset(),
    loadOverrides(),
    // The FY27 remuneration review, uploaded on /admin/package-increase. Absent
    // until somebody has uploaded one, which resolveLetterPackage treats as
    // "nobody reviewed" rather than as an error: every letter then states the
    // roster's own package and takes the "held" paragraph, as it did before.
    loadPackageIncreases(),
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
  const reviewed = review?.rows.find((r) => r.id === emp.id);
  const { salaryPackage, increased } = resolveLetterPackage(reviewed, emp);
  const docx = await buildLetter(
    template,
    { ...emp, salaryPackage, increased },
    route
  );

  // The conversion is LAST, after every gate and after the letter itself is
  // built, so a refusal never costs anyone a LibreOffice cold start.
  let bytes: Uint8Array = docx;
  if (format === "pdf") {
    const cold = !converterReady();
    const started = Date.now();
    try {
      bytes = await convertToPdf(docx);
    } catch (err) {
      console.log(
        `[audit] letter PDF-FAILED email=${actor} emp=${emp.id} cold=${cold} err="${err instanceof Error ? err.message : String(err)}" ts=${new Date().toISOString()}`
      );
      // The Word letter is fine — it is only the rendering that failed, and
      // saying so points at the way out rather than leaving a dead button.
      return NextResponse.json(
        {
          error:
            err instanceof PdfConversionError
              ? `The PDF couldn't be produced. Download it as Word instead, or try again in a moment.`
              : "The PDF couldn't be produced.",
        },
        { status: 502 }
      );
    }
    console.log(
      `[audit] letter pdf-converted emp=${emp.id} cold=${cold} ms=${Date.now() - started} ts=${new Date().toISOString()}`
    );
  }

  console.log(
    `[audit] letter email=${actor} emp=${emp.id} name="${emp.gn} ${emp.sn}" format=${format} signed="${signatoriesFor(route).join(" + ")}" bonus=${emp.finalBonus.toFixed(2)} ts=${new Date().toISOString()}`
  );

  const filename = letterFilename(emp, format);
  return new NextResponse(bytes as BodyInit, {
    headers: {
      "Content-Type":
        format === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
