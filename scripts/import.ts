/**
 * Import bonus data from CSV or JSON and write data/bonus.json.
 *
 *   npm run import -- path/to/data.json
 *   npm run import -- path/to/data.csv --vCap 1580414.50 --nCap 1038408.25 [--gCap 2618822.75]
 *
 * JSON input: either the full app shape ({ emp, vCap, nCap, gCap, ... }) or a
 * bare array of employee rows plus the --vCap/--nCap flags.
 *
 * CSV input: one employee per line, headers matching the employee fields:
 *   id,sn,gn,pos,dept,mgr,cat,st,vp,np,pkg,bp,ipm,bipm,da,f25,sm
 *
 * Every row is zod-validated; the pool totals are printed so you can
 * reconcile against the Excel before deploying.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { BonusDataSchema, EmployeeSchema, type Employee } from "../lib/schema";
import { applyOverrides, computeScalesAndBonuses } from "../lib/calc";

function parseArgs(argv: string[]) {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      flags[argv[i].slice(2)] = argv[++i];
    } else {
      positional.push(argv[i]);
    }
  }
  return { flags, positional };
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((c) => c !== "")) rows.push(row);
  }
  const [header, ...body] = rows;
  return body.map((cells) =>
    Object.fromEntries(header.map((h, i) => [h.trim(), (cells[i] ?? "").trim()]))
  );
}

const NUM_FIELDS = ["vp", "np", "pkg", "bp", "ipm", "bipm", "da", "f25", "sm"];

function coerceRow(raw: Record<string, string>): unknown {
  const out: Record<string, unknown> = { ...raw };
  for (const f of NUM_FIELDS) {
    if (typeof out[f] === "string") {
      const n = parseFloat((out[f] as string).replace(/[$,%\s]/g, ""));
      out[f] = isNaN(n) ? out[f] : n;
    }
  }
  if (out.sm === 0 || out.sm === 1) {
    // fine
  } else {
    out.sm = out.sm ? 1 : 0;
  }
  return out;
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const inputPath = positional[0];
if (!inputPath) {
  console.error(
    "Usage: npm run import -- <data.csv|data.json> [--vCap N --nCap N [--gCap N]]"
  );
  process.exit(1);
}

const text = readFileSync(inputPath, "utf-8");
let emp: Employee[];
let vCap: number, nCap: number, gCap: number;

if (extname(inputPath).toLowerCase() === ".json") {
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) {
    emp = parsed.map((r, i) => {
      const v = EmployeeSchema.safeParse(coerceRow(r));
      if (!v.success) {
        console.error(`Row ${i + 1} invalid:`, v.error.issues);
        process.exit(1);
      }
      return v.data;
    });
    vCap = parseFloat(flags.vCap);
    nCap = parseFloat(flags.nCap);
    gCap = flags.gCap ? parseFloat(flags.gCap) : vCap + nCap;
  } else {
    const v = BonusDataSchema.safeParse(parsed);
    if (!v.success) {
      console.error("JSON does not match the app shape:", v.error.issues.slice(0, 10));
      process.exit(1);
    }
    ({ emp, vCap, nCap, gCap } = v.data);
  }
} else {
  emp = parseCsv(text).map((r, i) => {
    const v = EmployeeSchema.safeParse(coerceRow(r));
    if (!v.success) {
      console.error(`CSV row ${i + 2} invalid:`, v.error.issues);
      process.exit(1);
    }
    return v.data;
  });
  vCap = parseFloat(flags.vCap);
  nCap = parseFloat(flags.nCap);
  gCap = flags.gCap ? parseFloat(flags.gCap) : vCap + nCap;
}

if (!(vCap > 0) || !(nCap > 0)) {
  console.error("Pool caps missing — pass --vCap and --nCap (and optionally --gCap).");
  process.exit(1);
}

const ids = new Set<string>();
for (const e of emp) {
  if (ids.has(e.id)) {
    console.error(`Duplicate employee id: ${e.id}`);
    process.exit(1);
  }
  ids.add(e.id);
}

const uniq = (xs: string[]) => [...new Set(xs)].sort();
const data = BonusDataSchema.parse({
  emp,
  vCap,
  nCap,
  gCap,
  cats: uniq(emp.map((e) => e.cat)),
  depts: uniq(emp.map((e) => e.dept)),
  mgrs: uniq(emp.map((e) => e.mgr)),
});

const outPath = join(__dirname, "..", "data", "bonus.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(data, null, 1));

// Reconciliation figures
const calcEmps = applyOverrides(data.emp, {});
const pool = computeScalesAndBonuses(calcEmps, data);
const sum = (f: (e: (typeof calcEmps)[number]) => number) =>
  calcEmps.reduce((s, e) => s + f(e), 0);
const money = (v: number) =>
  "$" + v.toLocaleString("en-AU", { maximumFractionDigits: 2 });

console.log(`Wrote ${outPath}`);
console.log(`Employees:            ${data.emp.length} (VIC ${data.emp.filter((e) => e.st === "VIC").length}, NSW ${data.emp.filter((e) => e.st === "NSW").length}, SHARED ${data.emp.filter((e) => e.st === "SHARED").length})`);
console.log(`Pool caps:            VIC ${money(vCap)}  NSW ${money(nCap)}  Group ${money(gCap)}`);
console.log(`Sum package:          ${money(sum((e) => e.pkg))}`);
console.log(`Sum after-IPM (bipm): ${money(sum((e) => e.bipmCalc))}`);
console.log(`Sum FY25 bonuses:     ${money(sum((e) => e.f25))}`);
console.log(`Baseline scales:      VIC ${pool.vicScale.toFixed(4)}x  NSW ${pool.nswScale.toFixed(4)}x`);
console.log(`TOTAL BONUS POOL:     ${money(sum((e) => e.finalBonus))}  ← reconcile this against the Excel`);
