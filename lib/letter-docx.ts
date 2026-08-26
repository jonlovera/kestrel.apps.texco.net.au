/**
 * The FY27 Remuneration Review / FY26 EBS Award letter, built from the master
 * Word template by filling the person in and deleting the signatures that are
 * not theirs.
 *
 * Pure: takes the template's bytes and a resolved row, returns bytes. No I/O
 * and no server-only imports, so the suite builds a letter and reads it back
 * the way lib/export-xlsx.test.ts already does with the workbook — which
 * matters more here than there, because the thing that can go wrong is a
 * stranger's signature on someone's salary letter and no reviewer would catch
 * that by reading the diff.
 *
 * HOW THE TEMPLATE IS PUT TOGETHER (verified against the real file):
 *
 *  - 71 paragraphs, no tables. Every signature is a FLOATING image
 *    (<wp:anchor>), but each one is positioned relativeFrom="paragraph", so it
 *    travels with the paragraph it is anchored to. That is what makes deleting
 *    whole paragraph ranges safe: the surviving block keeps its own images and
 *    reflows up the page with them.
 *  - The signature area is a menu of nine blocks (see lib/letter-blocks.ts),
 *    laid out one or two abreast. Within a two-up block the LEFT and RIGHT
 *    signatures are told apart by their horizontal offset, never by their
 *    order in the file — the file order is not consistent between blocks.
 *  - Placeholders sit in single <w:t> runs, so plain substitution works, with
 *    one exception: "[Increase]" is split across runs. It is never touched
 *    here (the FY27 section is left for manual completion), so that costs
 *    nothing, but do not assume it can be matched.
 *
 * NOTHING IS ADDRESSED BY INDEX. Paragraph positions and relationship ids both
 * shift when the template is re-saved in Word — observed, not hypothetical: the
 * two copies of this document we were handed have identical letter text and
 * every rId shifted by one. So blocks are found by their signatories' printed
 * names, images are matched to signatories by geometry, and anything that
 * cannot be found throws. A template that has moved must fail loudly; the one
 * outcome to design against is a letter that still looks fine and is signed by
 * the wrong person.
 */
import JSZip from "jszip";
import {
  BLOCKS,
  TITLE_OVERRIDES,
  signatoriesFor,
  type SignatureRoute,
  type Signatory,
} from "./letter-blocks";
import { fmt } from "./fmt";

const DOC = "word/document.xml";

/** What the letter needs to know about the person it is for. */
export interface LetterEmployee {
  gn: string;
  sn: string;
  st: string;
  mgr: string;
  /** the frozen final bonus — the figure the FY26 award paragraph states */
  finalBonus: number;
  /**
   * The remuneration package the FY27 review paragraph states: what the person
   * moves TO when `increased`, and what they are held AT when not.
   *
   * This is the ACTUAL total salary package, not `pkg` / Eligible Salary, which
   * is what this field used to carry. Those are different figures — Eligible
   * Salary is the bonus calculation's input and is prorated for eligibility —
   * and stating it here told people their package was a number they had never
   * been paid (owner, 26 August 2026). The caller resolves it, in order of
   * authority: the FY27 remuneration review (lib/remuneration.ts), then the
   * roster's `totalPkg`, and only then `pkg`.
   */
  salaryPackage: number;
  /**
   * Which of the template's two alternative FY27 paragraphs this letter takes.
   * True keeps "your remuneration package will increase to …"; false keeps
   * "your salary package will remain at …". Both state `salaryPackage`.
   */
  increased: boolean;
}

export interface LetterOptions {
  /** letter date; defaults to today. Injected so tests are not time-dependent. */
  date?: Date;
}

/** One signature as the template holds it: its image and its natural size. */
interface SignatureImage {
  rel: string;
  cx: number;
  cy: number;
}

/** A paragraph of the body, with the span it occupies in the document XML. */
interface Para {
  start: number;
  end: number;
  xml: string;
  text: string;
}

class TemplateError extends Error {}

/** Every <w:t>'s text, in order — tabs and formatting runs ignored. */
function textsOf(xml: string): string[] {
  return [...xml.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) =>
    decode(m[1])
  );
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#8217;/g, "’")
    .replace(/&amp;/g, "&");
}

function encode(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function paragraphs(doc: string): Para[] {
  const out: Para[] = [];
  for (const m of doc.matchAll(/<w:p\b[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g)) {
    const xml = m[0];
    out.push({
      start: m.index,
      end: m.index + xml.length,
      xml,
      text: textsOf(xml).join(""),
    });
  }
  return out;
}

/**
 * Replace the nth <w:t> in a paragraph, leaving its run properties alone —
 * the name keeps its bold, the title keeps its spacing.
 */
function replaceNthText(xml: string, n: number, value: string): string {
  let i = 0;
  return xml.replace(/(<w:t(?: [^>]*)?>)([\s\S]*?)(<\/w:t>)/g, (whole, open, _mid, close) =>
    i++ === n ? `${open}${encode(value)}${close}` : whole
  );
}

/** Replace every occurrence of a literal placeholder inside one paragraph. */
function fillIn(xml: string, placeholder: string, value: string): string {
  return xml.split(placeholder).join(encode(value));
}

/**
 * Strip a marker off the front of a paragraph, however many runs it spans.
 *
 * "[No Increase]" is two runs — `[No ` and `Increase]` — because Word split it
 * when someone edited mid-word, so no single-run substitution can see it. This
 * walks the <w:t> elements in order, eating the marker's characters as it goes,
 * and empties the runs it consumes rather than deleting them: the runs sit
 * between paired <w:proofErr> elements, and removing one of a pair is how you
 * get a document Word offers to repair.
 */
function stripLeading(xml: string, marker: string): string {
  let left = marker;
  return xml.replace(/(<w:t(?: [^>]*)?>)([\s\S]*?)(<\/w:t>)/g, (whole, open, text: string, close) => {
    if (!left) return whole;
    const plain = decode(text);
    if (!plain.startsWith(left.slice(0, plain.length))) {
      // The marker is not where it was — leave everything alone rather than
      // eating real sentence text.
      left = "";
      return whole;
    }
    const eaten = Math.min(plain.length, left.length);
    left = left.slice(eaten);
    return `${open}${encode(plain.slice(eaten))}${close}`;
  });
}

/**
 * The letter's opening paragraph (owner, 26 August 2026), replacing the copy the
 * template was written with.
 *
 * Held here rather than corrected in the .docx for the same reason
 * TITLE_OVERRIDES is: the master is re-supplied by hand, and a correction made
 * inside it is reverted by the next copy with nothing to show that it happened.
 */
export const OPENING_PARAGRAPH =
  "Thank you for the part you have played in our success this year. It has been " +
  "another solid year for Texco, particularly in what remains a tight and highly " +
  "competitive market. As our team continues to grow, the collective effort, " +
  "contribution and high standards of delivery across the business are helping us " +
  "maintain our reputation, win new work and continue to build on our success. " +
  "Your contribution to that effort has not gone unnoticed.";

/** The words the opening paragraph is FOUND by — stable across both wordings. */
const OPENING_ANCHOR = "Thank you for the part you have played";

/**
 * The FY26 award section: its heading, and the sentence that states the figure.
 *
 * Two distinct substrings rather than one — the heading reads "…Bonus Scheme
 * Award" and the sentence "…Bonus Scheme for the period", so neither can match
 * the other by accident, and the section can be removed as a whole.
 */
const BONUS_HEADING = "Employee Bonus Scheme Award";
const BONUS_BODY = "Employee Bonus Scheme for the period";

/**
 * Corrections to the template's own sentences, applied wherever they are found.
 *
 * "reflected the in the pay run" sat in the increase paragraph, which was
 * dropped from every letter until the FY27 review arrived to drive it — so the
 * typo had never reached a finished document and nobody had cause to catch it
 * (owner, 26 August 2026).
 *
 * Unlike OPENING_PARAGRAPH these are NOT required to match. A fix that finds
 * nothing means the template has since been corrected upstream, which is the
 * outcome to want, not one to throw on. Each `find` must be long enough to be
 * unambiguous and must sit inside a single run — Word splits a line wherever
 * formatting changes, and a phrase spanning a boundary is not there to match.
 */
const WORDING_FIXES: readonly { find: string; replace: string }[] = [
  { find: "reflected the in the pay run", replace: "reflected in the pay run" },
];

/** Apply every correction that this paragraph happens to carry. */
function applyWordingFixes(xml: string): string {
  return WORDING_FIXES.reduce(
    (acc, { find, replace }) => acc.split(encode(find)).join(encode(replace)),
    xml
  );
}

/**
 * Replace a paragraph's entire text, however many runs Word has split it into.
 *
 * The whole replacement goes into the first run and the rest are EMPTIED rather
 * than deleted — the same reasoning as stripLeading: the runs sit between paired
 * <w:proofErr> elements and removing one of a pair produces a document Word
 * offers to repair. Emptying keeps the first run's formatting, which is the
 * paragraph's body formatting, for the whole sentence.
 */
function replaceParagraphText(xml: string, value: string): string {
  let first = true;
  return xml.replace(
    /(<w:t(?: [^>]*)?>)([\s\S]*?)(<\/w:t>)/g,
    (_whole, open: string, _mid: string, close: string) => {
      if (!first) return `${open}${close}`;
      first = false;
      // xml:space="preserve" matters: without it Word trims the run, and this
      // sentence has no leading space to lose but the next edit might.
      const tag = open.includes("xml:space")
        ? open
        : open.replace("<w:t", '<w:t xml:space="preserve"');
      return `${tag}${encode(value)}${close}`;
    }
  );
}

/**
 * Remove Word's editorial highlighting from the whole document.
 *
 * The template marks every fill-in field in yellow and the two branch markers
 * in cyan, which is right for a master someone completes by hand and wrong the
 * moment the filling is done for them: without this the letter goes out with
 * the person's own name and bonus sitting in highlighter pen.
 */
function stripHighlights(doc: string): string {
  return doc.replace(/<w:highlight w:val="[^"]*"\s*\/>/g, "");
}

/** The <wp:anchor> elements of a paragraph, with the facts we need from each. */
function anchorsOf(xml: string): { rel: string; cx: number; cy: number; x: number }[] {
  const out: { rel: string; cx: number; cy: number; x: number }[] = [];
  for (const m of xml.matchAll(/<wp:anchor[\s\S]*?<\/wp:anchor>/g)) {
    const s = m[0];
    const rel = /r:embed="(rId\d+)"/.exec(s)?.[1];
    const ext = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(s);
    const x = /<wp:positionH[\s\S]*?<wp:posOffset>(-?\d+)<\/wp:posOffset>/.exec(s);
    if (!rel || !ext) continue;
    out.push({
      rel,
      cx: Number(ext[1]),
      cy: Number(ext[2]),
      x: x ? Number(x[1]) : 0,
    });
  }
  return out;
}

/** Where one signature block lives, and what is printed in it. */
interface FoundBlock {
  /** index into BLOCKS */
  index: number;
  /** first and last paragraph of the block, inclusive */
  from: number;
  to: number;
  /** the paragraph holding the names, and the one holding the titles */
  nameIdx: number;
  titleIdx: number;
  /** each slot's image, LEFT first */
  images: SignatureImage[];
}

/**
 * Locate all nine blocks by the names printed in them.
 *
 * A block's name line is the paragraph whose <w:t> texts are exactly that
 * block's signatories, in order. Its title line is the paragraph straight
 * after. The block STARTS where the previous one ended, so the images and
 * blank lines that belong to it — which sit above its names, sometimes several
 * paragraphs above — are carried with it rather than orphaned.
 */
function findBlocks(paras: Para[]): FoundBlock[] {
  const kindRegards = paras.findIndex((p) => p.text.trim() === "Kind regards");
  if (kindRegards < 0) {
    throw new TemplateError('template has no "Kind regards" line to anchor the signatures to');
  }

  const found: FoundBlock[] = [];
  // The first block opens after "Kind regards" and the blank line under it.
  let from = kindRegards + 2;

  BLOCKS.forEach((names, index) => {
    const nameIdx = paras.findIndex(
      (p, i) =>
        i >= from &&
        arrayEq(
          textsOf(p.xml).map((t) => t.trim()).filter(Boolean),
          [...names]
        )
    );
    if (nameIdx < 0) {
      throw new TemplateError(
        `template no longer contains the signature block for ${names.join(" + ")} — it has been edited, and a letter cannot be signed safely until this is updated`
      );
    }
    const titleIdx = nameIdx + 1;
    const to = titleIdx;

    // LEFT vs RIGHT by horizontal offset, never by order in the file: the two
    // are not the same, and reading the file order gives a mirrored pair.
    const images = paras
      .slice(from, nameIdx)
      .flatMap((p) => anchorsOf(p.xml))
      .sort((a, b) => a.x - b.x)
      .map(({ rel, cx, cy }) => ({ rel, cx, cy }));

    if (images.length !== names.length) {
      throw new TemplateError(
        `signature block for ${names.join(" + ")} has ${images.length} image(s) for ${names.length} name(s)`
      );
    }
    found.push({ index, from, to, nameIdx, titleIdx, images });
    from = to + 1;
  });

  return found;
}

function arrayEq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Every signatory's own signature, derived from the template rather than
 * hard-coded — the registry a slot swap draws on.
 *
 * Also an integrity check worth having: several people sign in more than one
 * block, so if the geometry-based LEFT/RIGHT pairing were wrong anywhere, the
 * same person would come back with two different images and this throws.
 */
function signatureRegistry(blocks: FoundBlock[]): Map<Signatory, SignatureImage> {
  const reg = new Map<Signatory, SignatureImage>();
  for (const b of blocks) {
    BLOCKS[b.index].forEach((name, slot) => {
      const img = b.images[slot];
      const seen = reg.get(name);
      if (seen && seen.rel !== img.rel) {
        throw new TemplateError(
          `${name} resolves to two different signature images (${seen.rel} and ${img.rel}) — the template's layout is not as expected`
        );
      }
      reg.set(name, img);
    });
  }
  return reg;
}

/**
 * Put a different signatory into one slot of the kept block.
 *
 * Four things move together: the image, its size, the name and the title. The
 * SIZE is the one that is easy to forget and impossible to miss on the page —
 * signatures here run from 56x60 to 166x33, so leaving the outgoing one's box
 * in place stretches the incoming signature out of shape. Both the drawing's
 * <wp:extent> and the shape's inner <a:ext> carry it.
 *
 * The anchor's offsets, its behindDoc flag and its docPr id are all left as
 * they are: the slot already sits where it should on the page, and keeping the
 * id avoids any chance of colliding with another drawing's.
 */
function swapSlot(
  paras: Para[],
  block: FoundBlock,
  slot: number,
  to: Signatory,
  title: string,
  reg: Map<Signatory, SignatureImage>
): void {
  const img = reg.get(to);
  if (!img) {
    throw new TemplateError(`the template holds no signature for ${to}`);
  }
  const outgoing = block.images[slot];

  // The image and its box, wherever in the block that anchor lives.
  for (let i = block.from; i < block.nameIdx; i++) {
    if (!paras[i].xml.includes(`r:embed="${outgoing.rel}"`)) continue;
    paras[i].xml = paras[i].xml.replace(
      /<wp:anchor[\s\S]*?<\/wp:anchor>/g,
      (anchor) => {
        if (!anchor.includes(`r:embed="${outgoing.rel}"`)) return anchor;
        return anchor
          .replace(/r:embed="rId\d+"/, `r:embed="${img.rel}"`)
          .replace(
            /<wp:extent cx="\d+" cy="\d+"/,
            `<wp:extent cx="${img.cx}" cy="${img.cy}"`
          )
          .replace(
            /<a:ext cx="\d+" cy="\d+"/g,
            `<a:ext cx="${img.cx}" cy="${img.cy}"`
          );
      }
    );
  }

  paras[block.nameIdx].xml = replaceNthText(paras[block.nameIdx].xml, slot, to);
  paras[block.titleIdx].xml = replaceNthText(paras[block.titleIdx].xml, slot, title);
}

/**
 * The title printed under a signatory: the correction in TITLE_OVERRIDES where
 * there is one, otherwise whatever the template already prints for them.
 */
function titleOf(paras: Para[], blocks: FoundBlock[], who: Signatory): string {
  const override = TITLE_OVERRIDES[who];
  if (override) return override;
  for (const b of blocks) {
    const slot = BLOCKS[b.index].indexOf(who);
    if (slot < 0) continue;
    const titles = textsOf(paras[b.titleIdx].xml).map((t) => t.trim()).filter(Boolean);
    if (titles[slot]) return titles[slot];
  }
  throw new TemplateError(`no title found for ${who}`);
}

/**
 * Apply TITLE_OVERRIDES to the block this letter keeps.
 *
 * Only the surviving block needs it — the other eight are deleted — and only
 * the slots that actually carry an override, because writing a title back
 * unchanged is not free: replaceNthText addresses the nth <w:t>, and a title
 * Word has split across runs (Scott Griffin's is "Director" + ", NSW") would be
 * written into the first run with the remainder left dangling after it. So a
 * mismatch between names and title runs throws instead, rather than putting a
 * mangled line under somebody's signature.
 *
 * Runs after the swaps, so an overridden signatory substituted into a slot is
 * corrected too — swapSlot writes titleOf's answer, and this agrees with it.
 */
function applyTitleOverrides(
  paras: Para[],
  block: FoundBlock,
  signatories: readonly Signatory[]
): void {
  const overridden = signatories
    .map((who, slot) => ({ slot, title: TITLE_OVERRIDES[who], who }))
    .filter((x): x is { slot: number; title: string; who: Signatory } => !!x.title);
  if (overridden.length === 0) return;

  const runs = textsOf(paras[block.titleIdx].xml).filter((t) => t.trim());
  if (runs.length !== signatories.length) {
    throw new TemplateError(
      `cannot set ${overridden
        .map((o) => o.who)
        .join(" and ")}'s title: the template prints ${runs.length} title run(s) for ${
        signatories.length
      } name(s) in this block, so which run belongs to whom is not decidable`
    );
  }
  for (const { slot, title } of overridden) {
    paras[block.titleIdx].xml = replaceNthText(paras[block.titleIdx].xml, slot, title);
  }
}

/** Australian long form: 25 August 2026. */
function formatDate(d: Date): string {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Australia/Melbourne",
  }).format(d);
}

/**
 * Build one letter.
 *
 * `route` is passed in rather than derived here so the caller has already
 * decided the person is entitled to a letter at all — /api/letter refuses an
 * unlocked row and an unroutable manager before it gets this far, and the
 * table greys the control out for the same two reasons.
 */
export async function buildLetter(
  template: ArrayBuffer | Uint8Array,
  emp: LetterEmployee,
  route: SignatureRoute,
  opts: LetterOptions = {}
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(template);
  const file = zip.file(DOC);
  if (!file) throw new TemplateError(`${DOC} missing — not a Word document`);
  const doc = await file.async("string");

  const paras = paragraphs(doc);
  const blocks = findBlocks(paras);
  const reg = signatureRegistry(blocks);

  const keep = blocks.find((b) => b.index === route.block);
  if (!keep) throw new TemplateError(`no signature block ${route.block}`);

  // ── the person ────────────────────────────────────────────────────────────
  const drop = new Set<number>();
  let openingFound = false;
  let bonusHeadingFound = false;
  let bonusBodyFound = false;
  /** Whether this letter has an award to state at all — see the FY26 branch. */
  const statesBonus = Math.round(emp.finalBonus) !== 0;

  paras.forEach((p, i) => {
    // The date line, which is the letter's own date rather than the template's.
    if (i < 3 && /^\d{1,2} [A-Za-z]+ \d{4}$/.test(p.text.trim())) {
      paras[i].xml = replaceNthText(p.xml, 0, formatDate(opts.date ?? new Date()));
      return;
    }
    if (p.xml.includes("[First Name]") || p.xml.includes("[Last Name]")) {
      paras[i].xml = fillIn(fillIn(p.xml, "[First Name]", emp.gn), "[Last Name]", emp.sn);
    }
    if (paras[i].xml.includes("[Preferred Name]")) {
      paras[i].xml = fillIn(paras[i].xml, "[Preferred Name]", emp.gn);
    }
    // THE FY26 AWARD. Each [Amount] is filled from its OWN paragraph's figure —
    // there are two in the finished letter and they are different numbers, so a
    // blanket replace would put the bonus into the salary sentence.
    //
    // With nothing to award, the whole section goes — heading and sentence both
    // (owner, 26 August 2026). "We're pleased to advise that you will receive a
    // bonus of $0" is not a sentence to send anybody, and deleting only the
    // figure would leave a heading standing over nothing.
    //
    // The test is what the letter would PRINT, not the raw figure: fmt rounds,
    // so a residual fraction of a cent shows as "$0" and must count as none. A
    // genuinely negative award is a real figure and is stated as one.
    if (p.text.includes(BONUS_BODY)) {
      bonusBodyFound = true;
      if (statesBonus) {
        paras[i].xml = fillIn(paras[i].xml, "[Amount]", fmt(emp.finalBonus));
      } else {
        drop.add(i);
      }
    } else if (p.text.includes(BONUS_HEADING)) {
      bonusHeadingFound = true;
      if (!statesBonus) drop.add(i);
    }
    // THE FY27 REVIEW. The template offers two alternative paragraphs and the
    // letter keeps exactly one of them: the person either moved package or was
    // held at theirs, and `increased` is the FY27 remuneration review's answer
    // (lib/remuneration.ts, via /api/letter). The other is dropped, and the kept
    // one loses its marker so what remains reads as a finished sentence rather
    // than a template someone forgot to tidy.
    //
    // The two are told apart by what they SAY ("will increase to" / "will
    // remain at") rather than by their markers, which Word split across runs
    // and which no single-run match can see.
    //
    // Both state `salaryPackage` — the actual total package. Each [Amount] is
    // still filled from its OWN paragraph, never blanket-replaced, which is
    // what keeps the bonus out of the salary sentence.
    if (p.text.includes("remuneration package will increase to")) {
      if (emp.increased) {
        paras[i].xml = fillIn(
          stripLeading(paras[i].xml, "[Increase]"),
          "[Amount]",
          fmt(emp.salaryPackage)
        );
      } else {
        drop.add(i);
      }
    }
    if (p.text.includes("salary package will remain at")) {
      if (emp.increased) {
        drop.add(i);
      } else {
        paras[i].xml = fillIn(
          stripLeading(paras[i].xml, "[No Increase]"),
          "[Amount]",
          fmt(emp.salaryPackage)
        );
      }
    }
    // The opening paragraph, replaced wholesale with the current wording
    // (OPENING_PARAGRAPH). Matched on the words both versions open with.
    if (p.text.trimStart().startsWith(OPENING_ANCHOR)) {
      paras[i].xml = replaceParagraphText(p.xml, OPENING_PARAGRAPH);
      openingFound = true;
    }
    // Last, so it also reaches sentences the branches above have just rewritten.
    paras[i].xml = applyWordingFixes(paras[i].xml);
  });

  // A letter that opens with superseded copy would look completely fine, which
  // is exactly the outcome this module is written to refuse — the same reason
  // a missing signature block throws rather than degrading.
  if (!openingFound) {
    throw new TemplateError(
      `template no longer has an opening paragraph starting "${OPENING_ANCHOR}" — it has been edited, and the letter's wording cannot be applied`
    );
  }
  // Only when the section is being removed: half a removal is a heading with
  // nothing under it, or a stray "$0" sentence under no heading. Either would
  // go out looking like a mistake nobody made on purpose.
  if (!statesBonus && !(bonusHeadingFound && bonusBodyFound)) {
    throw new TemplateError(
      `template no longer has both parts of the FY26 award section ("${BONUS_HEADING}" and "${BONUS_BODY}"), so it cannot be removed cleanly for a letter with no award`
    );
  }

  // ── the address: keep the office this person belongs to ───────────────────
  // A SHARED row keeps both, deliberately: their cost is split across the two
  // states and the template gives us nothing to choose on, so the sender picks.
  if (emp.st === "VIC" || emp.st === "NSW") {
    const other = emp.st === "VIC"
      ? ["182-184 Bourke Road", "ALEXANDRIA NSW 2015"]
      : ["1 Hall Street", "HAWTHORN EAST VIC 3123"];
    const idx = paras
      .map((p, i) => (other.includes(p.text.trim()) ? i : -1))
      .filter((i) => i >= 0);
    if (idx.length === other.length) {
      idx.forEach((i) => drop.add(i));
      // and the blank line that separated the two addresses, so the block does
      // not end up with a gap where the other office used to be
      const after = Math.max(...idx) + 1;
      const before = Math.min(...idx) - 1;
      if (paras[after] && !paras[after].text.trim()) drop.add(after);
      else if (paras[before] && !paras[before].text.trim()) drop.add(before);
    }
  }

  // ── the signatures: keep one block, then substitute any named slot ────────
  for (const b of blocks) {
    if (b.index === route.block) continue;
    for (let i = b.from; i <= b.to; i++) drop.add(i);
  }

  const wanted = signatoriesFor(route);
  BLOCKS[keep.index].forEach((was, slot) => {
    const now = wanted[slot];
    if (now && now !== was) {
      swapSlot(paras, keep, slot, now, titleOf(paras, blocks, now), reg);
    }
  });
  applyTitleOverrides(paras, keep, wanted);

  // ── stitch the document back together ─────────────────────────────────────
  let out = "";
  let cursor = 0;
  paras.forEach((p, i) => {
    out += doc.slice(cursor, p.start);
    if (!drop.has(i)) out += p.xml;
    cursor = p.end;
  });
  out += doc.slice(cursor);
  // Last, so it catches the whole finished document rather than whichever
  // paragraphs happened to be rewritten above.
  out = stripHighlights(out);

  zip.file(DOC, out);
  await stripUnusedMedia(zip, out);

  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

/**
 * Throw away the images the finished letter no longer shows.
 *
 * NOT housekeeping — this is the point at which the letter stops carrying
 * eleven other people's signatures. Deleting a signature block removes the
 * drawing that displays the image, but the PNG itself stays in the package, so
 * without this every employee receives a file they can unzip to extract every
 * director's signature in the company. The images are the sensitive part of
 * this document, and they travel to whoever the letter is sent to.
 *
 * A media file is kept only while some surviving part still points at it:
 *
 *  - the body, through a relationship in word/_rels/document.xml.rels that the
 *    rewritten document.xml still references (the letterhead, and the one
 *    signature that survived);
 *  - a header or footer, through its own rels — the Texco branding lives there
 *    and must not be collected as collateral.
 *
 * The orphaned relationships go too. A relationship pointing at a part that no
 * longer exists is not harmless: Word reports the document as corrupt and
 * offers to repair it, which is a worse outcome than the leak.
 */
async function stripUnusedMedia(zip: JSZip, doc: string): Promise<void> {
  const DOC_RELS = "word/_rels/document.xml.rels";
  const relsFile = zip.file(DOC_RELS);
  if (!relsFile) return;

  const used = new Set(
    [...doc.matchAll(/r:(?:embed|link)="(rId\d+)"/g)].map((m) => m[1])
  );

  // Prune the body's relationships to what the rewritten body still uses. Only
  // media: every other relationship (styles, fonts, the headers themselves) is
  // referenced by machinery rather than by an r:embed, and dropping one on that
  // basis would break the document.
  const rels = await relsFile.async("string");
  const pruned = rels.replace(/<Relationship\b[^>]*\/>/g, (rel) => {
    const id = /Id="([^"]+)"/.exec(rel)?.[1];
    const target = /Target="([^"]+)"/.exec(rel)?.[1] ?? "";
    if (!id || !target.startsWith("media/")) return rel;
    return used.has(id) ? rel : "";
  });
  zip.file(DOC_RELS, pruned);

  // Now every media target still claimed by ANY part, this one included.
  const keep = new Set<string>();
  for (const path of Object.keys(zip.files)) {
    if (!path.endsWith(".rels")) continue;
    const body = path === DOC_RELS ? pruned : await zip.file(path)!.async("string");
    for (const m of body.matchAll(/Target="(media\/[^"]+)"/g)) {
      keep.add(`word/${m[1]}`);
    }
  }

  for (const path of Object.keys(zip.files)) {
    if (path.startsWith("word/media/") && !zip.files[path].dir && !keep.has(path)) {
      zip.remove(path);
    }
  }
}

/** The two things a letter can be downloaded as. */
export type LetterFormat = "docx" | "pdf";

/** "Ann Alpha - FY27 Remuneration Review and FY26 EBS Award.docx" */
export function letterFilename(
  emp: Pick<LetterEmployee, "gn" | "sn">,
  format: LetterFormat = "docx"
): string {
  const name = `${emp.gn} ${emp.sn}`.replace(/[^\w\s'-]/g, "").trim();
  return `${name} - FY27 Remuneration Review and FY26 EBS Award.${format}`;
}
