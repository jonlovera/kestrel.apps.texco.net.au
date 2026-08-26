/**
 * The PDF conversion, exercised only where a converter actually exists.
 *
 * Skipped on a laptop and in CI unless LibreOffice has already been unpacked
 * into /tmp — the same shape lib/manager-pool.test.ts uses for the gitignored
 * production fixture. That is honest rather than convenient: the conversion is
 * a 430MB binary and a subprocess, and a test that quietly mocked it would
 * assert nothing about the thing that can break.
 *
 * What actually proves this works is the deployed check, not this file. The
 * numbers in lib/letter-pdf.ts were measured on a Vercel preview in syd1.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { converterReady, convertToPdf, PdfConversionError } from "./letter-pdf";
import { buildLetter, type LetterEmployee } from "./letter-docx";
import { signatureRouteFor } from "./letter-blocks";

const TEMPLATE = join(__dirname, "templates", "remuneration-letter.docx");

describe("PdfConversionError", () => {
  it("is distinguishable, so the route can say something useful", () => {
    // /api/letter answers a conversion failure with "download it as Word
    // instead" rather than a generic 500, which only works if the error type
    // survives the throw.
    const err = new PdfConversionError("nope");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PdfConversionError");
  });
});

describe.skipIf(!converterReady() || !existsSync(TEMPLATE))(
  "convertToPdf (LibreOffice present)",
  () => {
    const emp: LetterEmployee = {
      gn: "Ann",
      sn: "Alpha",
      st: "VIC",
      mgr: "Clint Cassar",
      finalBonus: 24571,
      salaryPackage: 185000,
      increased: false,
    };

    it("turns a finished letter into a real PDF", async () => {
      const docx = await buildLetter(
        readFileSync(TEMPLATE),
        emp,
        signatureRouteFor(emp)!,
        { date: new Date("2026-08-25T00:00:00+10:00") }
      );
      const pdf = Buffer.from(await convertToPdf(docx));
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      // A blank or truncated render would still start %PDF-; a real letter
      // with a letterhead and a signature image does not fit in 10KB.
      expect(pdf.length).toBeGreaterThan(10_000);
    }, 180_000);

    it("embeds the brand font rather than substituting one", async () => {
      // The whole reason the fonts are bundled. Measured on Vercel before they
      // were: LibreOffice fell back to LinuxLibertineG, a serif, where the
      // letter is a rounded sans — a PDF that looks nothing like the Word one.
      const docx = await buildLetter(
        readFileSync(TEMPLATE),
        emp,
        signatureRouteFor(emp)!
      );
      const pdf = Buffer.from(await convertToPdf(docx));
      const fonts = [
        ...new Set(
          [...pdf.toString("latin1").matchAll(/\/BaseFont\s*\/([A-Za-z0-9+\-_]+)/g)].map(
            (m) => m[1]
          )
        ),
      ].join(" ");
      expect(fonts).toMatch(/PowerGrotesk/);
      expect(fonts).not.toMatch(/Libertine/);
    }, 180_000);
  }
);
