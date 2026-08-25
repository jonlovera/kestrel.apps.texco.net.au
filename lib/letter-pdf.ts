import "server-only";
import { spawn } from "node:child_process";
import { createBrotliDecompress } from "node:zlib";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { get } from "node:https";
import { extract } from "tar";

/**
 * Render a finished letter to PDF, by handing the .docx we already build to a
 * headless LibreOffice.
 *
 * Converting the REAL FILE rather than laying a PDF out ourselves is the whole
 * point: the two formats are the same document, so editing the Word template
 * moves both and they cannot drift apart. A hand-built PDF layout would change
 * only when someone remembered to change it.
 *
 * Every number below was measured on a Vercel preview in syd1, not assumed:
 *
 *   cold (download + extract + convert)  ~9s
 *   warm (convert only)                  ~1s
 *   /tmp available                       525MB, against ~430MB extracted
 *
 * server-only: this spawns processes and writes to /tmp. lib/letter-blocks.ts
 * is the half of this feature the browser is allowed to import; this is not.
 */

/**
 * LibreOffice 6.4.0.1 built for AWS Lambda — 92MB brotli, ~430MB extracted.
 *
 * Fetched at RUNTIME into /tmp rather than bundled at build time, which is a
 * deliberate reversal of the original plan. Bundling would put ~430MB into
 * every deployment for a feature most requests never touch, and this account
 * is on a plan with tighter function limits than Fluid Compute's 5GB headline.
 * The archive streams through brotli straight into the extractor so it never
 * lands on disk, and the unpacked copy survives in /tmp across warm
 * invocations — which is the difference between the 9s and the 1s above.
 *
 * The cost of this choice, stated plainly: producing a PDF on a cold function
 * depends on GitHub being reachable. A DOCX never does.
 */
const ARCHIVE =
  "https://github.com/vladgolubev/serverless-libreoffice/releases/download/v6.4.0.1/lo.tar.br";
const ROOT = "/tmp/lo";
const PROGRAM = `${ROOT}/instdir/program`;
/**
 * `soffice.bin` directly. This archive ships no `soffice` shell wrapper — its
 * program/ holds only oosplash, soffice.bin and sofficerc — so everything the
 * wrapper would normally arrange has to be arranged here instead.
 */
const SOFFICE = `${PROGRAM}/soffice.bin`;

/** Where the brand fonts are bundled; see scripts/fonts-from-woff2.ts. */
const FONT_DIR = join(process.cwd(), "lib", "templates", "fonts");

/**
 * What the missing wrapper would have set: LibreOffice's own libraries, a
 * headless VCL backend (there is no X server), a writable HOME, and a
 * fontconfig file.
 *
 * FONTCONFIG_FILE is not optional. There is no system fontconfig in this
 * runtime at all, and without one LibreOffice exits 81 with "Fontconfig error:
 * Cannot load default config file" before rendering a single page.
 */
const LO_ENV: Record<string, string> = {
  HOME: "/tmp",
  LD_LIBRARY_PATH: PROGRAM,
  SAL_USE_VCLPLUGIN: "svp",
  SAL_DISABLE_OPENCL: "1",
  FONTCONFIG_FILE: "/tmp/fonts.conf",
};

/**
 * Where to find fonts, and somewhere writable to cache what it finds.
 *
 * FONT_DIR carries Power Grotesk, and it is the difference between a PDF that
 * matches the Word letter and one that does not. Measured: without it the
 * first conversion came back embedding LinuxLibertineG — a serif, where the
 * letter is a rounded sans. With it, PowerGroteskRegular/Medium/Bold.
 */
const FONTS_CONF = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${ROOT}/instdir/share/fonts</dir>
  <dir>${FONT_DIR}</dir>
  <cachedir>/tmp/fontcache</cachedir>
</fontconfig>
`;

/** Conversion failed for a reason worth telling someone about. */
export class PdfConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfConversionError";
  }
}

function run(
  args: string[],
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(SOFFICE, args, { env: { ...process.env, ...LO_ENV } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new PdfConversionError(`LibreOffice timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new PdfConversionError(`LibreOffice could not start: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.slice(-2000), stderr: stderr.slice(-2000) });
    });
  });
}

/**
 * Stream the archive through brotli into the extractor.
 *
 * node-tar rather than the `tar` command, because the Vercel runtime has no
 * tar binary at all — `spawn tar ENOENT` was the first thing the spike found.
 */
async function install(): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const request = (url: string) =>
      get(url, { headers: { "User-Agent": "kestrel" } }, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          return request(res.headers.location);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(
            new PdfConversionError(`could not fetch LibreOffice (HTTP ${res.statusCode})`)
          );
        }
        const out = extract({ cwd: ROOT });
        out.on("error", (e: Error) =>
          reject(new PdfConversionError(`unpacking LibreOffice failed: ${e.message}`))
        );
        out.on("finish", () => resolve());
        res
          .pipe(createBrotliDecompress())
          .on("error", (e: Error) =>
            reject(new PdfConversionError(`unpacking LibreOffice failed: ${e.message}`))
          )
          .pipe(out);
      }).on("error", (e) =>
        reject(new PdfConversionError(`could not fetch LibreOffice: ${e.message}`))
      );
    request(ARCHIVE);
  });
}

/**
 * Whether a converter is already unpacked in this instance's /tmp.
 *
 * Exported so a caller can tell a fast request from a slow one without
 * triggering the install itself.
 */
export function converterReady(): boolean {
  return existsSync(SOFFICE);
}

/**
 * The .docx in, a PDF out.
 *
 * Serialised through one working directory per call, then cleaned up: two
 * concurrent conversions writing `letter.pdf` into the same folder would race
 * and one would return the other person's letter.
 */
export async function convertToPdf(docx: Uint8Array): Promise<Uint8Array> {
  if (!converterReady()) await install();

  await mkdir("/tmp/fontcache", { recursive: true });
  await writeFile("/tmp/fonts.conf", FONTS_CONF);

  const work = `/tmp/letter-${process.pid}-${Date.now()}`;
  await mkdir(work, { recursive: true });
  try {
    const src = join(work, "letter.docx");
    await writeFile(src, docx);

    // Exit 81 is LibreOffice asking to be restarted rather than failing — the
    // shell wrapper's job, and there is no wrapper. It happens on the first run
    // against a fresh profile, so retry instead of giving up.
    let result = await run(
      [
        "--headless",
        "--invisible",
        "--nodefault",
        "--nofirststartwizard",
        "--nolockcheck",
        "--nologo",
        "--norestore",
        "-env:UserInstallation=file:///tmp/lo-profile",
        "--convert-to",
        "pdf",
        "--outdir",
        work,
        src,
      ],
      120_000
    );
    for (let i = 0; i < 2 && result.code === 81; i++) {
      result = await run(
        [
          "--headless",
          "--invisible",
          "--nodefault",
          "--nofirststartwizard",
          "--nolockcheck",
          "--nologo",
          "--norestore",
          "-env:UserInstallation=file:///tmp/lo-profile",
          "--convert-to",
          "pdf",
          "--outdir",
          work,
          src,
        ],
        120_000
      );
    }

    const out = join(work, "letter.pdf");
    if (!existsSync(out)) {
      throw new PdfConversionError(
        `LibreOffice produced no PDF (exit ${result.code}): ${result.stderr || result.stdout || "no output"}`
      );
    }
    const pdf = await readFile(out);
    // Cheapest possible proof it is a PDF rather than a truncated write.
    if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new PdfConversionError("LibreOffice produced a file that is not a PDF");
    }
    return pdf;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
