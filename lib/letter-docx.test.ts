/**
 * The letter itself, built from the real template and read back.
 *
 * The failure this file is really guarding against is a letter that opens
 * cleanly and is signed by the wrong person — nothing about the file would
 * look wrong, and nobody reviewing a diff would catch it. So the assertions
 * are about what is ABSENT as much as what is present: the eight blocks that
 * must not survive, and the FY27 placeholders that must.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import {
  buildLetter,
  letterFilename,
  OPENING_PARAGRAPH,
  type LetterEmployee,
} from "./letter-docx";
import { SIGNATORIES, signatureRouteFor } from "./letter-blocks";

const TEMPLATE = join(__dirname, "templates", "remuneration-letter.docx");
const template = existsSync(TEMPLATE) ? readFileSync(TEMPLATE) : null;

/** Fixed, so the date assertion does not drift with the calendar. */
const DATE = new Date("2026-08-25T00:00:00+10:00");

/** The media files a finished letter actually carries. */
async function mediaIn(bytes: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  return Object.keys(zip.files).filter(
    (p) => p.startsWith("word/media/") && !zip.files[p].dir
  );
}

function emp(over: Partial<LetterEmployee> = {}): LetterEmployee {
  return {
    gn: "Ann",
    sn: "Alpha",
    st: "VIC",
    mgr: "Clint Cassar",
    finalBonus: 24571,
    salaryPackage: 185000,
    increased: false,
    ...over,
  };
}

/** Build a letter and pull back the pieces the assertions look at. */
async function letter(e: LetterEmployee, tpl: Buffer | Uint8Array = template!) {
  const route = signatureRouteFor(e);
  if (!route) throw new Error(`no route for ${e.mgr}`);
  const bytes = await buildLetter(tpl, e, route, { date: DATE });
  const zip = await JSZip.loadAsync(bytes);
  const doc = await zip.file("word/document.xml")!.async("string");
  const rels = await zip.file("word/_rels/document.xml.rels")!.async("string");
  const texts = [...doc.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]);
  return {
    bytes,
    doc,
    texts,
    /**
     * One line per run. Used for ABSENCE checks, where joining runs end to end
     * could manufacture a match across a boundary that isn't really there.
     */
    body: texts.join("\n"),
    /**
     * Runs joined end to end, as the reader sees the sentence. Word splits a
     * line wherever formatting changes, so "Dear [Preferred Name]" is two runs
     * and only reads as one phrase here.
     */
    flat: texts.join(""),
    /** the signatory names printed in the surviving block, in order */
    signed: texts.filter((t) => (SIGNATORIES as readonly string[]).includes(t)),
    /** rId -> media target, for checking the images still resolve */
    rels: Object.fromEntries(
      [...rels.matchAll(/Id="(rId\d+)"[^>]*Target="(media\/[^"]+)"/g)].map((m) => [m[1], m[2]])
    ) as Record<string, string>,
    /** every drawing left in the document, with the box it is drawn in */
    drawings: [...doc.matchAll(/<wp:anchor[\s\S]*?<\/wp:anchor>/g)].map((m) => {
      const s = m[0];
      return {
        rel: /r:embed="(rId\d+)"/.exec(s)![1],
        extent: /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(s)!.slice(1, 3).map(Number) as [number, number],
        inner: [...s.matchAll(/<a:ext cx="(\d+)" cy="(\d+)"/g)].map(
          (x) => [Number(x[1]), Number(x[2])] as [number, number]
        ),
      };
    }),
  };
}

describe.skipIf(!template)("buildLetter", () => {
  it("keeps only the signature block the person routes to", async () => {
    const l = await letter(emp());
    expect(l.signed).toEqual(["Clint Cassar", "Jonathan Glick"]);
    // and every other signatory is GONE — the assertion that actually matters,
    // since a stray block is someone else's signature on a salary letter
    for (const who of SIGNATORIES) {
      if (who === "Clint Cassar" || who === "Jonathan Glick") continue;
      expect(l.body).not.toContain(who);
    }
  });

  it("fills the person in, leaving no placeholder behind", async () => {
    const l = await letter(emp());
    expect(l.texts[0]).toBe("25 August 2026");
    expect(l.flat).toContain("Ann Alpha");
    expect(l.flat).toContain("Dear Ann");
    expect(l.flat).toContain("bonus of $24,571 (gross)");
    // Nothing square-bracketed survives anywhere. The letter is posted to the
    // person it names, so a leftover marker is not a cosmetic problem.
    expect(l.flat).not.toMatch(/\[[A-Za-z ]+\]/);
  });

  describe("the FY27 review section", () => {
    it("states the package being held, not the bonus", async () => {
      // Two different figures in two different sentences — the bug a blanket
      // [Amount] replace would introduce is putting the bonus in both.
      const l = await letter(emp({ salaryPackage: 185000, finalBonus: 24571 }));
      expect(l.flat).toContain("salary package will remain at $185,000 (gross)");
      expect(l.flat).toContain("bonus of $24,571 (gross)");
    });

    it("drops the increase paragraph for somebody held at their package", async () => {
      const l = await letter(emp({ increased: false }));
      expect(l.flat).not.toContain("will increase to");
      expect(l.flat).toContain("will remain at");
    });

    it("keeps the increase paragraph, and only that one, for a rise", async () => {
      const l = await letter(emp({ increased: true, salaryPackage: 205000 }));
      expect(l.flat).toContain(
        "remuneration package will increase to $205,000 (gross)"
      );
      // the held paragraph must not survive alongside it — a letter stating
      // both is worse than one stating neither
      expect(l.flat).not.toContain("will remain at");
      expect(l.flat).not.toContain("As part of this year");
    });

    it("still states the bonus separately on an increase letter", async () => {
      const l = await letter(
        emp({ increased: true, salaryPackage: 205000, finalBonus: 24571 })
      );
      expect(l.flat).toContain("bonus of $24,571 (gross)");
      expect(l.flat).toContain("increase to $205,000 (gross)");
    });

    it("strips the [No Increase] marker, which Word split across two runs", async () => {
      // `[No ` and `Increase]` are separate runs, so no single-run replace can
      // see the marker — and leaving it in opens the paragraph with editorial
      // scaffolding in a letter going to an employee.
      const l = await letter(emp({ increased: false }));
      expect(l.flat).not.toContain("[No Increase]");
      expect(l.flat).not.toContain("Increase]");
      expect(l.flat).toContain("As part of this year");
    });

    it("corrects the template's typo in the increase sentence", async () => {
      // The increase paragraph was dropped from every letter until the review
      // arrived to drive it, so this had never reached a finished document.
      const l = await letter(emp({ increased: true }));
      expect(l.flat).toContain("will be reflected in the pay run");
      expect(l.flat).not.toContain("reflected the in the pay run");
    });

    it("strips the [Increase] marker, which Word also split", async () => {
      const l = await letter(emp({ increased: true }));
      expect(l.flat).not.toContain("[Increase]");
      expect(l.flat).not.toContain("Increase]");
      expect(l.flat).toContain("We are pleased to inform you");
    });
  });

  describe("the FY26 award section", () => {
    it("states the award when there is one", async () => {
      const l = await letter(emp({ finalBonus: 24571 }));
      expect(l.flat).toContain("FY26 Employee Bonus Scheme Award");
      expect(l.flat).toContain("bonus of $24,571 (gross)");
    });

    it("drops the whole section when the award is nothing", async () => {
      // heading and sentence both — a heading standing over nothing is as wrong
      // as the "$0" sentence it was introducing
      const l = await letter(emp({ finalBonus: 0 }));
      expect(l.flat).not.toContain("FY26 Employee Bonus Scheme Award");
      expect(l.flat).not.toContain("you will receive a bonus of");
      expect(l.flat).not.toContain("$0");
      // and the letter is otherwise intact
      expect(l.flat).toContain("FY27 Remuneration Review");
      expect(l.flat).toContain("will remain at $185,000 (gross)");
      expect(l.flat).toContain("Kind regards");
      expect(l.signed).toEqual(["Clint Cassar", "Jonathan Glick"]);
    });

    it("drops it for a figure that merely rounds to nothing", async () => {
      // fmt rounds, so this would have printed "$0" too
      const l = await letter(emp({ finalBonus: 0.4 }));
      expect(l.flat).not.toContain("FY26 Employee Bonus Scheme Award");
    });

    it("keeps a negative award, which is a real figure", async () => {
      const l = await letter(emp({ finalBonus: -1500 }));
      expect(l.flat).toContain("FY26 Employee Bonus Scheme Award");
      expect(l.flat).toContain("(gross)");
    });

    it("leaves no square-bracketed marker behind on a no-award letter", async () => {
      const l = await letter(emp({ finalBonus: 0 }));
      expect(l.flat).not.toMatch(/\[[A-Za-z ]+\]/);
    });

    it("refuses to half-remove the section if the template changed", async () => {
      const zip = await JSZip.loadAsync(template!);
      const doc = await zip.file("word/document.xml")!.async("string");
      // Word split the heading as `FY2` + `6 Employee Bonus Scheme Award`, so
      // the tampering has to stay inside one run to actually land — which is
      // the same reason the heading is detected on joined text, not on the XML.
      zip.file(
        "word/document.xml",
        doc.replace("6 Employee Bonus Scheme Award", "6 Award")
      );
      const broken = await zip.generateAsync({ type: "uint8array" });
      await expect(letter(emp({ finalBonus: 0 }), broken)).rejects.toThrow(
        /FY26 award section/
      );
      // an ordinary letter is unaffected — nothing is being removed
      await expect(letter(emp({ finalBonus: 24571 }), broken)).resolves.toBeTruthy();
    });
  });

  describe("the opening paragraph", () => {
    it("uses the current wording, not the template's", async () => {
      const l = await letter(emp());
      expect(l.flat).toContain(OPENING_PARAGRAPH);
      // the copy this replaced, which the template still carries
      expect(l.flat).not.toContain("the importance of consistency, sound delivery");
    });

    it("refuses to build a letter if the template lost that paragraph", async () => {
      // Superseded copy on a letter that otherwise looks perfect is exactly the
      // silent-wrongness this module refuses everywhere else.
      const zip = await JSZip.loadAsync(template!);
      const doc = await zip.file("word/document.xml")!.async("string");
      zip.file(
        "word/document.xml",
        doc.replace("Thank you for the part you have played", "Thanks for everything")
      );
      const broken = await zip.generateAsync({ type: "uint8array" });
      await expect(letter(emp(), broken)).rejects.toThrow(/opening paragraph/);
    });
  });

  describe("signature titles", () => {
    it("prints Clint Cassar's current title, not the template's", async () => {
      const l = await letter(emp({ mgr: "Clint Cassar" }));
      expect(l.signed).toEqual(["Clint Cassar", "Jonathan Glick"]);
      expect(l.body.split("\n")).toContain("General Manager, Construction");
      // his co-signatory keeps the title the template gives him
      expect(l.body.split("\n")).toContain("Delivery Manager, VIC");
      expect(l.body.split("\n")).not.toContain("Director");
    });

    it("leaves a block with no override exactly as the template has it", async () => {
      // Scott Griffin's title is split across runs ("Director" + ", NSW"), so
      // this is also the case that would break if overrides were applied blindly
      const l = await letter(emp({ st: "NSW", mgr: "Tom McCreanor" }));
      expect(l.signed).toEqual(["Scott Griffin"]);
      expect(l.flat).toContain("Director, NSW");
    });
  });

  it("takes Word's editorial highlighting off the finished letter", async () => {
    // The template marks every fill-in field yellow and the branch markers
    // cyan. Right for a master someone completes by hand; wrong the moment it
    // is filled for them — the name and the bonus would go out in highlighter.
    const l = await letter(emp());
    expect(l.doc).not.toContain("<w:highlight");
  });

  it("keeps only the office the person belongs to", async () => {
    const vic = await letter(emp({ st: "VIC" }));
    expect(vic.body).toContain("HAWTHORN EAST VIC 3123");
    expect(vic.body).not.toContain("ALEXANDRIA NSW 2015");

    const nsw = await letter(emp({ st: "NSW", mgr: "Scott Griffin" }));
    expect(nsw.body).toContain("ALEXANDRIA NSW 2015");
    expect(nsw.body).not.toContain("1 Hall Street");

    // Shared Services keeps both: their cost splits across the two states and
    // the template offers nothing to choose on, so the sender picks.
    const shared = await letter(emp({ st: "SHARED", mgr: "Dee Gibson" }));
    expect(shared.body).toContain("HAWTHORN EAST VIC 3123");
    expect(shared.body).toContain("ALEXANDRIA NSW 2015");
  });

  it("signs an NSW letter by Scott Griffin whoever the manager is", async () => {
    const l = await letter(emp({ st: "NSW", mgr: "Marcus Cooper" }));
    expect(l.signed).toEqual(["Scott Griffin"]);
    expect(l.body).not.toContain("Marcus Cooper");
  });

  it("leaves every surviving image resolvable", async () => {
    const l = await letter(emp());
    expect(l.drawings.length).toBeGreaterThan(0);
    for (const d of l.drawings) expect(l.rels[d.rel]).toMatch(/^media\//);
  });

  describe("the other signatures leave the file entirely", () => {
    // Deleting a signature block removes the drawing that DISPLAYS an image,
    // not the image. Without pruning, every employee receives a document they
    // can unzip to extract every director's signature in the company — and
    // unlike most leaks this one is posted to them deliberately.
    it("ships only the images the letter actually shows", async () => {
      const l = await letter(emp({ st: "NSW", mgr: "Marcus Cooper" }));
      const media = await mediaIn(l.bytes);

      // Scott Griffin signed it, so his image and the letterhead stay...
      expect(media).toContain("word/media/image7.png");
      expect(media).toContain("word/media/image1.png");
      // ...and every other signature is gone from the package, not merely
      // hidden. image2-image6 and image8-image13 are the other eleven.
      for (const n of [2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13]) {
        expect(media).not.toContain(`word/media/image${n}.png`);
      }
    });

    it("keeps the branding the headers and footers use", async () => {
      // Those live in a different part with its own relationships, so they
      // must not be collected as collateral — losing them would strip the
      // letterhead off every letter.
      const media = await mediaIn((await letter(emp())).bytes);
      for (const f of ["image14.png", "image15.svg", "image16.png", "image17.svg"]) {
        expect(media).toContain(`word/media/${f}`);
      }
    });

    it("leaves no relationship pointing at a file it removed", async () => {
      // A dangling relationship is worse than the leak it was meant to fix:
      // Word calls the document corrupt and offers to repair it.
      const zip = await JSZip.loadAsync((await letter(emp())).bytes);
      const media = await mediaIn((await letter(emp())).bytes);
      for (const path of Object.keys(zip.files)) {
        if (!path.endsWith(".rels")) continue;
        const body = await zip.file(path)!.async("string");
        for (const m of body.matchAll(/Target="(media\/[^"]+)"/g)) {
          expect(media, `${path} points at ${m[1]}`).toContain(`word/${m[1]}`);
        }
      }
    });
  });

  describe("Brock Ellett's composed pair", () => {
    it("prints Matthew Barker and Dee Gibson, and not Tom Bull", async () => {
      const l = await letter(emp({ st: "SHARED", mgr: "Brock Ellett" }));
      expect(l.signed).toEqual(["Matthew Barker", "Dee Gibson"]);
      expect(l.body).not.toContain("Tom Bull");
      // the title travels with the signatory, or the pair reads as two Directors
      expect(l.body).toContain("Chief Financial Officer");
    });

    it("draws Dee Gibson's signature at its own size, not Tom Bull's box", async () => {
      // The failure a reader WOULD notice and no name check would: swapping the
      // image without its dimensions stretches the signature into the outgoing
      // one's box. Dee Gibson's is roughly 126x37 and Tom Bull's 92x52 —
      // nothing alike, so a miss is visible on the page.
      //
      // Measured against the template's own figures rather than a literal, so
      // this keeps testing the right thing if a signature is ever re-cropped.
      const swapped = await letter(emp({ st: "SHARED", mgr: "Brock Ellett" }));
      const kept = await letter(emp({ st: "SHARED", mgr: "Matt Barker" }));
      const alone = await letter(emp({ st: "SHARED", mgr: "Dee Gibson" }));

      const sig = (l: typeof swapped, media: string) =>
        l.drawings.find((d) => l.rels[d.rel] === media);

      const deeNative = sig(alone, "media/image8.png")!;
      const deeSwapped = sig(swapped, "media/image8.png");
      expect(deeSwapped, "Dee Gibson's signature should be in the letter").toBeDefined();
      expect(deeSwapped!.extent).toEqual(deeNative.extent);
      for (const inner of deeSwapped!.inner) expect(inner).toEqual(deeNative.extent);

      // and it is emphatically NOT the box it replaced
      const tomBox = sig(kept, "media/image3.png")!.extent;
      expect(deeSwapped!.extent).not.toEqual(tomBox);

      // Tom Bull's image is gone entirely, box and all
      expect(sig(swapped, "media/image3.png")).toBeUndefined();
    });
  });

  it("throws rather than sign a template it no longer recognises", async () => {
    // A re-save in Word moves paragraphs and renumbers relationships, so the
    // one outcome to design against is a letter that still looks right and is
    // signed by the wrong person. Losing a block must fail loudly.
    const zip = await JSZip.loadAsync(template!);
    const doc = await zip.file("word/document.xml")!.async("string");
    zip.file("word/document.xml", doc.replace(/<w:t>Jenilee Bell<\/w:t>/, "<w:t>Someone Else</w:t>"));
    const broken = await zip.generateAsync({ type: "uint8array" });

    await expect(letter(emp(), broken)).rejects.toThrow(/Jenilee Bell/);
  });
});

describe("letterFilename", () => {
  it("names the file after the person, defaulting to Word", () => {
    expect(letterFilename({ gn: "Ann", sn: "Alpha" })).toBe(
      "Ann Alpha - FY27 Remuneration Review and FY26 EBS Award.docx"
    );
  });

  it("carries the format through to the extension", () => {
    // The extension is what tells the recipient's machine what to open it
    // with, so a PDF named .docx is a file nobody can read.
    expect(letterFilename({ gn: "Ann", sn: "Alpha" }, "pdf")).toBe(
      "Ann Alpha - FY27 Remuneration Review and FY26 EBS Award.pdf"
    );
    expect(letterFilename({ gn: "Ann", sn: "Alpha" }, "docx")).toBe(
      letterFilename({ gn: "Ann", sn: "Alpha" })
    );
  });

  it("keeps the apostrophes and hyphens real names have", () => {
    expect(letterFilename({ gn: "Mary-Anne", sn: "O'Brien" })).toBe(
      "Mary-Anne O'Brien - FY27 Remuneration Review and FY26 EBS Award.docx"
    );
  });

  it("strips anything that would break a Content-Disposition header", () => {
    expect(letterFilename({ gn: 'Bad"', sn: "Name\\/" })).toBe(
      "Bad Name - FY27 Remuneration Review and FY26 EBS Award.docx"
    );
  });
});
