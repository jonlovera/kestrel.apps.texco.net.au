/**
 * One-off extraction: decode the `master` data blob embedded in the original
 * single-file prototype and write it to data/bonus.json in the app's shape.
 *
 * Usage: npx tsx scripts/extract-from-html.ts "../FY26 EBS Dashboard - Secure.html"
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { BonusDataSchema } from "../lib/schema";

const htmlPath = process.argv[2];
if (!htmlPath) {
  console.error('Usage: npx tsx scripts/extract-from-html.ts "<path to prototype html>"');
  process.exit(1);
}

const html = readFileSync(htmlPath, "utf-8");
const blobsMatch = html.match(/const BLOBS = \{([\s\S]*?)\};/);
if (!blobsMatch) {
  console.error("Could not find BLOBS in the HTML file.");
  process.exit(1);
}
const masterMatch = blobsMatch[1].match(/master:\s*'([A-Za-z0-9+/=]+)'/);
if (!masterMatch) {
  console.error("Could not find the master blob.");
  process.exit(1);
}

const raw = JSON.parse(Buffer.from(masterMatch[1], "base64").toString("utf-8"));
const data = BonusDataSchema.parse(raw);

const outPath = join(__dirname, "..", "data", "bonus.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(data, null, 1));

const totBipm = data.emp.reduce((s, e) => s + e.bipm, 0);
const totF25 = data.emp.reduce((s, e) => s + e.f25, 0);
console.log(`Wrote ${outPath}`);
console.log(`Employees: ${data.emp.length}`);
console.log(`vCap: ${data.vCap}  nCap: ${data.nCap}  gCap: ${data.gCap}`);
console.log(`Sum bipm (after IPM): ${totBipm}`);
console.log(`Sum FY25 bonuses:     ${totF25}`);
