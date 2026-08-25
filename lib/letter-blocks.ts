/**
 * WHO SIGNS A PERSON'S REMUNERATION LETTER.
 *
 * The master template (lib/templates/remuneration-letter.docx) carries a MENU
 * of nine signature blocks — mostly a Director alongside a direct manager —
 * and producing a letter means keeping exactly one and deleting the other
 * eight. This module decides which one, and nothing else: it holds no XML and
 * reads no file, so the browser can import it to decide whether the download
 * icon is live while lib/letter-docx.ts uses the same answer to build the file.
 * One definition, two sides, the same reasoning `isDaEditable` carries.
 *
 * THE RULES, IN ORDER (owner decisions, 25 August 2026):
 *
 *  1. STATE. Every NSW employee is signed by Scott Griffin, whoever their
 *     manager is. This started life as five separate "manager X has no
 *     signature, use Scott's" delegations — Marcus Cooper, Tom McCreanor, Jon
 *     Benjamin, Jay Sharma, Matthew Henwood — and then turned out to be one
 *     rule wearing five hats: every one of them manages NSW people and only
 *     NSW people. Stated as a state rule it is also durable, where the list of
 *     names was not: a new NSW manager needs no change here at all.
 *
 *  2. MANAGER, for the VIC and Shared Services rows the state rule does not
 *     reach. Names come from the spreadsheet, so two of them need reconciling
 *     against the template's spelling (see ALIASES).
 *
 * A row that resolves to nothing gets no letter, and the table says why. That
 * is unreachable on today's data — all 155 route — and exists for the import
 * that introduces a manager nobody has mapped.
 *
 * WHY THE BLOCKS ARE NAMED, NOT NUMBERED. The nine blocks are identified by
 * the people in them rather than by position, because paragraph indices and
 * relationship ids both shift when someone re-saves the template in Word —
 * observed, not hypothetical: the two copies of this document we were given
 * differ by exactly that, identical letter text with every rId shifted by one.
 * lib/letter-docx.ts locates each block by its signatories' names and throws if
 * one is missing, so a re-save is caught rather than silently mis-signing.
 */

/** Everyone the template holds a signature for. */
export const SIGNATORIES = [
  "Tom Bull",
  "Jack Bull",
  "Clint Cassar",
  "Jonathan Glick",
  "Lachie Hill",
  "Scott Griffin",
  "Dee Gibson",
  "Jenilee Bell",
  "Matthew Barker",
  "Bill Petersen",
  "Paul Darby",
  "Neil Timms",
] as const;
export type Signatory = (typeof SIGNATORIES)[number];

/**
 * The nine blocks, in the order they appear, each named by its signatories.
 *
 * A one-name block is a single signature; a two-name block is a pair laid out
 * side by side, LEFT first. That order matters — it is how lib/letter-docx.ts
 * pairs each block's floating images (which it tells apart by their horizontal
 * offset) with the names printed underneath them.
 */
export const BLOCKS: readonly (readonly Signatory[])[] = [
  ["Tom Bull", "Jack Bull"],
  ["Clint Cassar", "Jonathan Glick"],
  ["Jack Bull", "Lachie Hill"],
  ["Scott Griffin"],
  ["Dee Gibson"],
  ["Jenilee Bell"],
  ["Matthew Barker", "Tom Bull"],
  ["Jack Bull", "Bill Petersen"],
  ["Paul Darby", "Neil Timms"],
];

/**
 * Spreadsheet spelling → template spelling, for the SAME person.
 *
 * Deliberately separate from the routing below, because it is a different kind
 * of fact with a different lifespan: these are two people whose names are
 * recorded one way in the import and another way in Word, and the day the
 * import data is tidied this table should simply be deleted. Folding them in
 * with the routing would make them look like decisions rather than typos.
 */
const ALIASES: Record<string, Signatory> = {
  "Matt Barker": "Matthew Barker",
  "Jon Glick": "Jonathan Glick",
};

/**
 * Which block a manager's people are signed by, and any slot substituted in it.
 *
 * `block` is an index into BLOCKS. `left`/`right` name a signatory to put in
 * that slot INSTEAD of the one the template has there — see SignatureRoute.
 */
export interface SignatureRoute {
  block: number;
  left?: Signatory;
  right?: Signatory;
}

/**
 * The state rule. Everything else falls through to the manager map.
 */
const NSW_BLOCK = 3; // ["Scott Griffin"]

/**
 * Manager (after aliasing) → route, for VIC and Shared Services.
 *
 * Every entry but one is a plain block: the template already pairs that
 * manager with the Director who co-signs for them, and the pair is the unit.
 *
 * BROCK ELLETT IS THE EXCEPTION, and it is the reason routes carry slots at
 * all. His two people are to be signed by Matt Barker and Dee Gibson (owner,
 * 25 August 2026) — a pairing the template does not contain and never did.
 * Matthew Barker appears only ever beside Tom Bull, and Dee Gibson only ever
 * alone. So this one is built: take the Matthew Barker + Tom Bull block and
 * put Dee Gibson in the right-hand slot.
 */
const BY_MANAGER: Record<string, SignatureRoute> = {
  "Clint Cassar": { block: 1 },
  "Jonathan Glick": { block: 1 },
  "Jack Bull": { block: 0 },
  "Tom Bull": { block: 0 },
  "Matthew Barker": { block: 6 },
  "Brock Ellett": { block: 6, right: "Dee Gibson" },
  "Dee Gibson": { block: 4 },
  "Paul Darby": { block: 8 },
  "Neil Timms": { block: 8 },
  "Scott Griffin": { block: NSW_BLOCK },
  // Nobody currently reports to these three, but the template holds their
  // signatures, so the map is complete rather than merely sufficient.
  "Lachie Hill": { block: 2 },
  "Jenilee Bell": { block: 5 },
  "Bill Petersen": { block: 7 },
};

/** The template's spelling of a manager's name, or the name unchanged. */
export function canonicalManager(mgr: string): string {
  return ALIASES[mgr.trim()] ?? mgr.trim();
}

/**
 * Who signs this person's letter, or null when nothing covers them.
 *
 * Takes only the two fields the decision needs, so both a CalcEmployee and a
 * lead's ScopedRow satisfy it without either module knowing about the other.
 */
export function signatureRouteFor(e: {
  st: string;
  mgr: string;
}): SignatureRoute | null {
  if (e.st === "NSW") return { block: NSW_BLOCK };
  return BY_MANAGER[canonicalManager(e.mgr)] ?? null;
}

/**
 * Why a row's letter cannot be downloaded, or null when it can.
 *
 * `savedLocked` is the lock as STORED, which is not the same question as the
 * row's own `locked` and is the distinction this function exists for. Anything
 * typed since the last Save is scratch — local to that browser and invisible to
 * the server — so a row can read as locked on screen while /api/letter, which
 * builds the letter from the saved document, sees an unlocked row. The control
 * used to go live on the on-screen lock, which meant a perfectly ordinary
 * "lock, then download" produced a refusal instead of a letter.
 *
 * The two failing states are told apart on purpose. "Never locked" and "locked
 * but not saved" need different things done about them, and a single message
 * covering both would send someone to lock a row that is already locked.
 *
 * Pure and client-safe so the table's tooltip and /api/letter's refusal are
 * the same rule in the same order, rather than two that can drift.
 */
export function letterUnavailableReason(
  row: { st: string; mgr: string; locked: boolean },
  savedLocked: boolean
): string | null {
  if (!signatureRouteFor(row)) return `No signature on file for ${row.mgr}`;
  if (savedLocked) return null;
  return row.locked
    ? "Save this lock before downloading — the letter is built from the saved figures"
    : "Lock this row first — the letter states a final bonus";
}

/** The signatories a route actually prints, LEFT first, with slots applied. */
export function signatoriesFor(route: SignatureRoute): Signatory[] {
  const base = BLOCKS[route.block];
  if (!base) return [];
  const out = [...base];
  if (route.left) out[0] = route.left;
  if (route.right && out.length > 1) out[1] = route.right;
  return out;
}
