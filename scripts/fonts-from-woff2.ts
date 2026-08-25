/**
 * Unwrap the brand webfonts into the .ttf that LibreOffice can actually read.
 *
 *   npx tsx scripts/fonts-from-woff2.ts
 *
 * A one-off, not a build step. woff2 is a Brotli-compressed sfnt, so this is a
 * lossless unwrap of the same outlines rather than a re-render, and committing
 * the .ttf output keeps the deployment bundle deterministic — a build that
 * converts fonts every time is a build that can start failing for reasons
 * nothing to do with the code.
 *
 * WHY AT ALL: the letter's Normal style is Power Grotesk and the template
 * embeds no font, so a PDF rendered without it silently comes out in whatever
 * LibreOffice substitutes. Measured, not assumed — the first conversion on
 * Vercel came back embedding LinuxLibertineG, a serif, where the letter is a
 * rounded sans.
 *
 * LICENCE, from the source directory's own README:
 *   "Power Grotesk (Light/Regular/Medium/Bold) — commercial webfont from Power
 *    Type Foundry, licensed under the Texco brand pack. Internal LAN use only,
 *    same posture as the tools site. Confirm with marketing before using in
 *    anything public-facing."
 * Embedding it into PDFs sent to individual employees is a broader use than
 * serving it on an internal site. The owner took that decision on 25 August
 * 2026; this note is here so the next person sees the qualification rather
 * than assuming it was cleared.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { decompress } from "wawoff2";

const SOURCE =
  "/Users/jlovera/Documents/texco-ai-project-intelligence/texco-index/static/fonts";
const DEST = join(process.cwd(), "lib", "templates", "fonts");

const FACES = [
  "PowerGrotesk-Regular",
  "PowerGrotesk-Medium",
  "PowerGrotesk-Bold",
  "PowerGrotesk-Light",
];

/** The family and subfamily an sfnt announces to fontconfig (name IDs 1 and 2). */
function readNames(ttf: Buffer): { family?: string; subfamily?: string; full?: string } {
  const numTables = ttf.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    if (ttf.toString("latin1", off, off + 4) !== "name") continue;
    const tableOff = ttf.readUInt32BE(off + 8);
    const count = ttf.readUInt16BE(tableOff + 2);
    const stringOff = tableOff + ttf.readUInt16BE(tableOff + 4);
    const out: Record<number, string> = {};
    for (let r = 0; r < count; r++) {
      const rec = tableOff + 6 + r * 12;
      const platform = ttf.readUInt16BE(rec);
      const nameId = ttf.readUInt16BE(rec + 6);
      const len = ttf.readUInt16BE(rec + 8);
      const strOff = stringOff + ttf.readUInt16BE(rec + 10);
      if (nameId > 4) continue;
      const raw = ttf.subarray(strOff, strOff + len);
      // platform 3 (Windows) is UTF-16BE; platform 1 (Mac) is single-byte
      out[nameId] = platform === 3 ? raw.toString("utf16le").replace(/\0/g, "")
        : raw.toString("latin1");
      if (platform === 3) {
        out[nameId] = Buffer.from(raw).swap16().toString("utf16le");
      }
    }
    return { family: out[1], subfamily: out[2], full: out[4] };
  }
  return {};
}

/** Does this face carry the characters the letter actually prints? */
function missingGlyphs(ttf: Buffer, chars: string): string[] {
  const numTables = ttf.readUInt16BE(4);
  let cmapOff = -1;
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    if (ttf.toString("latin1", off, off + 4) === "cmap") cmapOff = ttf.readUInt32BE(off + 8);
  }
  if (cmapOff < 0) return ["(no cmap table)"];
  const covered = new Set<number>();
  const n = ttf.readUInt16BE(cmapOff + 2);
  for (let i = 0; i < n; i++) {
    const rec = cmapOff + 4 + i * 8;
    const sub = cmapOff + ttf.readUInt32BE(rec + 4);
    if (ttf.readUInt16BE(sub) !== 4) continue; // format 4 is enough for Latin
    const segX2 = ttf.readUInt16BE(sub + 6);
    for (let s = 0; s < segX2 / 2; s++) {
      const end = ttf.readUInt16BE(sub + 14 + s * 2);
      const start = ttf.readUInt16BE(sub + 16 + segX2 + s * 2);
      if (start === 0xffff) continue;
      for (let c = start; c <= end && c - start < 4096; c++) covered.add(c);
    }
  }
  return [...new Set(chars)].filter((c) => !covered.has(c.codePointAt(0)!));
}

async function main() {
  await mkdir(DEST, { recursive: true });
  // Everything the letter can print, plus the curly apostrophe in "this year's"
  // and the dollar sign every figure starts with — the characters a subset
  // webfont is most likely to have dropped.
  const NEEDED =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,:;'’\"()-–—/$%&@[]";

  for (const face of FACES) {
    const woff2 = await readFile(join(SOURCE, `${face}.woff2`));
    const ttf = Buffer.from(await decompress(woff2));
    await writeFile(join(DEST, `${face}.ttf`), ttf);
    const names = readNames(ttf);
    const missing = missingGlyphs(ttf, NEEDED);
    console.log(
      `${face}.ttf  ${(ttf.length / 1024).toFixed(0)}KB  ` +
        `family="${names.family}" subfamily="${names.subfamily}"` +
        (missing.length ? `  MISSING: ${JSON.stringify(missing.join(""))}` : "  full coverage")
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
