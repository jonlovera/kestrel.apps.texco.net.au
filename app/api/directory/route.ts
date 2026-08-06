import { NextResponse } from "next/server";
import { searchDirectory } from "@/lib/graph";
import { requireEditor, noStore } from "@/lib/api-guard";

export const dynamic = "force-dynamic";

/**
 * Type-ahead for the access form: search the company directory by name and
 * get back the address to grant. Full-access users only — the same people who
 * can already see every salary in the scheme.
 *
 * Never fails the caller: if Graph isn't consented yet (or is down) this
 * answers `available: false` with a reason, and the form falls back to typing
 * the address by hand. Suggestions are a convenience, never a gate.
 */
export async function GET(req: Request) {
  const guard = await requireEditor("directory-search");
  if ("response" in guard) return guard.response;

  const q = new URL(req.url).searchParams.get("q") ?? "";
  if (q.trim().length < 2) {
    return noStore(NextResponse.json({ available: true, people: [] }));
  }

  const result = await searchDirectory(q);
  if (!result.ok) {
    return noStore(
      NextResponse.json({
        available: false,
        people: [],
        reason: result.reason,
        message:
          result.reason === "forbidden"
            ? "Directory lookup isn't switched on yet — ask IT to grant this app the Microsoft Graph 'User.Read.All' application permission. You can still type the address in full."
            : result.reason === "unconfigured"
              ? "Directory lookup isn't configured on this environment. Type the address in full."
              : "Directory lookup is unavailable right now. Type the address in full.",
      })
    );
  }

  return noStore(NextResponse.json({ available: true, people: result.people }));
}
