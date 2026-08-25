# FY26 Bonus Scheme: app vs signed-off waterfall reconciliation

**Date:** 25 August 2026
**Source of truth:** Dee Gibson's waterfall, `FY26 EBS Model (1).xlsx`, confirmed 25/08/2026
**Scope:** investigation only. No code, data or configuration was changed. Fixes are proposed at the end, not applied.

**Method.** Three sources were cross-checked: (1) the code in this repo (all citations are `file:line` under `kestrel-app/`), (2) the workbook's own formulas, and (3) the live Neon store, via read-only `SELECT`s on `kestrel_docs` and `kestrel_log`, plus a read-only run of the app's own `applyParams` / `applyOverrides` / `computeScalesAndBonuses` / `poolCardTotals` against the live dataset, params and overrides docs. Every app figure quoted below was reproduced to the cent by that run.

---

## 1. Executive summary

1. **The VIC card showing 1,365,714 was bad stored data, not a code swap.** Pool caps are runtime-editable and persist to the Neon doc `kestrel:params:fy26`. The history log shows the VIC cap was set to 1,365,714 (NSW's total cap) at 07:34 UTC on 25 Aug and corrected back to 1,593,574 at 07:38. The reported screen was captured inside that four-minute window.
2. **The NSW cap is still wrong right now.** `params.nCap` holds 1,194,970, which is NSW's *state pool*, not its signed-off *total cap* of 1,365,714.16. It has held that value since 24 Aug (briefly corrected on 25 Aug at 06:14, reverted at 07:17).
3. **The claim that `lib/calc.ts:363` "nets shared services out internally" is refuted.** The netting term is always zero because no caller ever supplies the `shared` argument. There is no double-deduction in the engine today, but because of (2) there **is** a live double-deduction on the client for NSW: the client subtracts the carve-outs from a cap that is already a carved-out pool.
4. The part-split variance (90,050/23,959 vs 87,637/25,239) is a genuine methodology difference (with-locks vs no-locks scale weighting) compounded by post-sign-off overrides on the four affected employees.
5. Shared services 308,047 vs 308,046 is a $1 rounding artefact, not a real variance.
6. The group total (2,945,168) is the sum of every employee's final bonus and is internally consistent; it is not meant to equal the sum of the three pool headlines, which are pinned cap-side constants.

---

## 2. Reconciliation table

| Figure | App value | Signed-off value | Variance | Source (file:line) | Verdict |
|---|---|---|---|---|---|
| VIC pool | 1,343,396 | 1,343,396 | $0 | `components/DashboardClient.tsx:76` (`PINNED_CARD_HEADLINES.vic`) | Matches, but it is a hardcoded constant, not a derived figure |
| VIC cap shown | 1,365,714 | 1,593,574 | **-227,860** | `params.vCap` in Neon doc `kestrel:params:fy26`, rendered at `components/DashboardClient.tsx:1641` | **Data defect.** Held 1,365,714 between 07:34 and 07:38 UTC on 25 Aug (log ids 2539/2541); now 1,593,574 (whole dollars, cents lost) |
| VIC remaining | -81,965 | n/a (sheet's VIC Pool Unspent `O9` = 0) | reproduces as **-81,955.16**; would be **+145,905** against the correct cap | `components/DashboardClient.tsx:1642` (`vCap - vicHome`) | Consequence of the wrong `vCap`. The reported -81,965 is $10 from the reproducible -81,955; see 4.3 |
| NSW pool | 1,194,970 | 1,194,970 | $0 | `components/DashboardClient.tsx:77` | Matches, but hardcoded |
| NSW cap shown | 1,194,970 | 1,365,714 | **-170,744** | `params.nCap` in `kestrel:params:fy26`, rendered at `components/DashboardClient.tsx:1650` | **Data defect, still live.** The state pool was written into the total-cap slot on 24 Aug (log id 1281) and again on 25 Aug (id 2531) |
| NSW remaining | 5,084 | n/a | reproduces exactly (5,084.43) | `components/DashboardClient.tsx:1651` (`nCap - nswHome`) | Numerically a pool-based remaining, but only because `nCap` accidentally holds the pool |
| Shared services | 308,047 | 308,046 | **+1** | `components/DashboardClient.tsx:78` (pinned) | Rounding artefact, not real. See 4.2. The live derived figure is 307,613.08 |
| Part-split VIC | 90,050 | 87,637 | **+2,413** | `lib/calc.ts:687-694` via `:668`, rendered `components/DashboardClient.tsx:1668-1671` | Methodology + data. See 4.1 |
| Part-split NSW | 23,959 | 25,239 | **-1,280** | same | same |
| Group total | 2,945,168 | (sheet Cap Bonuses `O5` = 2,836,288) | +108,880 | `lib/calc.ts:650`, rendered `components/DashboardClient.tsx:1677` | Not a signed-off figure. The app includes post-sign-off overrides. See 4.5 |
| Group cap | 2,959,288 | 2,959,288 | $0 | `params.gCap` = 2,959,288.4843, rendered `components/DashboardClient.tsx:1678` | Matches. `gCap` is the one cap that was never corrupted |
| Group remaining | 14,121 | (sheet Pool Remaining `O8` = 123,000) | | `components/DashboardClient.tsx:1679` (`gCap - groupTotal`) | Internally consistent (2,959,288.48 - 2,945,167.82 = 14,120.67). The sheet's 123,000 is measured against the sheet's own lower spend |

Reproduced engine state at time of writing: `vicScale = 0.78715325`, `nswScale = 1` (pinned by `NSW_FULL_ENTITLEMENT`, `lib/calc.ts:183` and `:386`), `vicHome = 1,447,669.16`, `nswHome = 1,189,885.57`, `cards.shared = 307,613.08`.

---

## 3. Trace of every figure to code (task 1)

### `params.vCap` / `nCap` / `gCap`
- Type: `lib/calc.ts:98-102` (`interface Caps`). Validation: `lib/params-apply.ts:19-21` (positive, ≤ 50M state / 100M group; no cross-field check).
- Precedence at boot (`lib/data.ts:18-66`): stored params doc `kestrel:params:fy26` (`lib/store.ts:361-375`) **overrides** dataset caps via `applyParams` (`lib/params-apply.ts:56-68`); the dataset itself resolves DB doc `kestrel:data:fy26` > `BONUS_DATA` env (`lib/data.ts:22-36`) > `data/bonus.json`.
- Current live values (read-only SELECT, 25 Aug): params doc `{vCap: 1593574, nCap: 1194970, gCap: 2959288.4843493206}`; dataset doc caps (masked by params) are the correct signed-off `{1593574.3239, 1365714.1604, 2959288.4843}`.
- Consumed at: `lib/calc.ts:351,355,363,364,534,536,703,704`; `lib/manager-pool.ts:160-161` (a whole-state lead's pool IS the state cap); `lib/da-impact.ts:316-318,334`; `lib/scope-core.ts:80-89` (sent to the client); `components/DashboardClient.tsx:807-808,1631,1641-1652,1678-1680,1794-1795`.

### `poolCardTotals` (`lib/calc.ts:627-708`)
- `group` = Σ `finalBonus` over every row, no exclusions (`:650`).
- `vic` = Σ finals of VIC-home rows less `vicOther` (`:697`); `shared` = Σ finals of `st === "SHARED"` rows (`:655`).
- `vicPool`/`nswPool` = cap less `vicCarried`/`nswCarried` (`:703-704`) - **computed but never rendered** (shadowed by the pinned headlines, `components/DashboardClient.tsx:1640,1649`).
- `vicPartSplit`/`nswPartSplit` (`:687-694`): split rows whose `vp` differs from the modal ("corporate") `vp` (`modalVp`, `:719-741`), attributed by `fracVic`.

### `vicCarried` (`lib/calc.ts:644,659-671`)
Accumulated over rows with `vp > 0 && np > 0` using the scale-weighted fraction `fracVic = vp·vicScale / (vp·vicScale + np·nswScale)` (`:668`). Uses the **live, with-locks** scales.

### `stateVicAvail` (`lib/calc.ts:363`)
`stateVicAvail = caps.vCap - sharedVicFixed`. Syntactically a shared-services netting; **effectively a no-op**, see section 5.

### `computeScalesAndBonuses` (`lib/calc.ts:312-429`)
Signature `(emps, caps, shared = ZERO_SHARED)`. Mutates rows in place; `vicScale = clamp((stateVicAvail - empLockedVp)/empBipmVpUnlocked)` (`:375-378`); `nswScale` pinned at 1 (`:383-386`). Payout: `finalBonus = (baseAmount ?? (lockedFinal - daEdit) ?? calcBonus) + daEdit` (`:416-419`). `gCap` is never read here.

### `capRoom` (`lib/calc.ts:520-541`)
Compares Σ `finalBonus` **grouped by home state** against the **raw total state cap** (`:536-538`), plus the group cap when `bound === "both"` (`:534`). SHARED-home rows have no state bound (`stateCap === null`). Reached via `getMaxDA` (`:490-507`, `Math.floor`).

### `/api/state` gate 4 (`app/api/state/route.ts:208-254`)
Re-derives the ceiling server-side: `bound = fullAccess ? "both" : "state"` (`:228`), then `daHeadroom(row, judged, data, bound)` (`:238`) where `data` is `getEffectiveDataset()` (`:134`), i.e. the **raw caps**. The client clamps the same grant against `effectiveCaps` (state pools) instead; the asymmetry is documented as deliberate at `components/DashboardClient.tsx:797-803` ("every clamp here is TIGHTER than the gate behind it") - which holds only while the stored caps are total caps. See 5.3.

---

## 4. The five discrepancies (task 3)

### 4.1 Part-split staff: app 90,050 / 23,959 vs Dee 87,637 / 25,239

**Where the app derives it.** `lib/calc.ts:687-694`. The population is every row with `vp > 0 && np > 0` whose `vp` differs from the modal corporate ratio (0.61) - correctly the same four people as Dee's: Clements (0.70), Fairclough (0.90), Wali (0.92), Porter (0.96). Each person's payout is split by `fracVic = vp·vicScale / (vp·vicScale + np·nswScale)` (`:668`).

**Why it differs.** Two compounding causes:

1. **Different scale factors.** The workbook splits with the *no-locks* scales: `'EBS Group - FY26'!AW16 = AV·N·$I$13/(N·$I$13 + O·$L$13)` where `I13` (VIC scale, no locks) = 0.71420 and `L13` = 1. The app uses the *live, with-locks* `vicScale` = 0.78715 (`lib/calc.ts:668`). A higher VIC weight pushes more of each payout to VIC, which is why the app's VIC share is above Dee's and its NSW share below.
2. **Different amounts being split.** Dee splits the signed-off locked amounts (sum 112,875.85). The app splits live `finalBonus`, which now includes post-sign-off changes: Clements is locked at **49,065.00** in the app vs **47,932.60** in the workbook (+1,132.40), and there are discretionary edits on Fairclough (-2,074), Wali (+5,396) and Porter (-769) that roughly cancel. App sum: 114,009.22.

Reproduced exactly: 90,049.83 → renders 90,050; 23,959.39 → renders 23,959 (`lib/fmt.ts:5` rounds at display).

### 4.2 Shared services 308,047 vs 308,046: rounding, not real

Dee's figure is the sum of two already-rounded components: 162,541 + 145,505 = 308,046 (exact values 162,541.18 + 145,505.31 = 308,046.49). The app's pinned 308,047 (`components/DashboardClient.tsx:78`) matches the 21 Aug dataset's derived value `shared - partSplits` = 308,046.50, which `Math.round` takes up to 308,047. A $1 display artefact. Note the *live* derived figure is now 307,613.08, because the four part-split staff were moved out of `st === "SHARED"` on 24 Aug (see 4.5 and Questions for Dee).

### 4.3 VIC card showing 1,365,714 (NSW's total cap)

**There is no swap in the code.** The card array is four object literals with fixed keys; the VIC card's cap slot is `cap: vCap` (`components/DashboardClient.tsx:1636-1644`), the commit map is keyed (`vic → vCap`, `:1733-1737`), and the served bundle agrees. The value came from the **stored params doc**:

| When (UTC) | Actor | Change | Log id |
|---|---|---|---|
| 21 Aug 00:59 | dgibson | Import set VIC 1,593,574 / NSW 1,365,714 / Group 2,959,288 | 682 |
| 24 Aug 03:06 | jlovera | NSW cap 1,365,714.16 → **1,194,970** | 1281 |
| 24 Aug 04:03-04:31 | jlovera | NSW nudged 1,194,970 → 1,194,971 → back; → 1,234,562 → back | 1387-1582 |
| 25 Aug 06:14 | jlovera | NSW 1,194,970 → 1,365,714 (corrected) | 2470 |
| 25 Aug 07:17 | jlovera | NSW 1,365,714 → **1,194,970** (reverted) | 2531 |
| 25 Aug 07:34 | jlovera | **VIC 1,593,574.32 → 1,365,714** | 2539 |
| 25 Aug 07:38 | jlovera | VIC 1,365,714 → 1,593,574 (whole dollars) | 2541 |

The reported render matches the 07:34-07:38 state exactly: VIC remaining = 1,365,714 - vicHome(≈1,447,669) ≈ -81,955. The reported -81,965 is $10 away and does not reproduce from any stored state after the last override write (07:06 UTC); most likely a transcription slip, otherwise a transient override later undone.

The enabling defect is that `/api/params` (`app/api/params/route.ts:26-84`) accepts any positive caps with **no consistency check** that `vCap + nCap ≈ gCap`. `gCap` kept the true pair (1,593,574.32 + 1,365,714.16), which is what made the corruption detectable.

### 4.4 Is `remaining` computed against total cap or state pool?

Against the **raw stored cap**, on every card that has one, and always with the *un-netted* home-state spend:

| Card | Expression | file:line | Base |
|---|---|---|---|
| VIC | `vCap - vicHome` where `vicHome = cards.vic + cards.vicOther` | `components/DashboardClient.tsx:1642`, `:1612` | raw `params.vCap` |
| NSW | `nCap - nswHome` | `:1651`, `:1613` | raw `params.nCap` |
| Shared services | none (no cap, no remaining; footer suppressed) | `:1654-1673`, gate at `:1746` | n/a |
| Group | `gCap - groupTotal` | `:1679` | raw `params.gCap` |

So the **code** is consistent (documented intent at `:1609-1611`: the footers mirror what gate 4 enforces). The **data** is not: `vCap` currently holds a total cap while `nCap` holds a state pool, so VIC's remaining is cap-relative and NSW's is pool-relative. NSW's 5,084 looks like Dee's model only by accident.

### 4.5 Group 2,945,168 vs the sum of the three pool figures

They measure different things and share no common basis:

- **Group total 2,945,168** = Σ `finalBonus` over all 146 employees (`lib/calc.ts:650`): VIC-home 1,447,669.16 + NSW-home 1,189,885.57 + SHARED-home 307,613.08 = 2,945,167.82. It is a **spend-side** figure, includes every override, lock and discretionary amount, and includes the four part-split staff inside the VIC-home number (they were moved from Shared Services to VIC home state by dgibson on 24 Aug 03:14 UTC, log ids 1295-1301).
- **The three pool headlines** (1,343,396 + 1,194,970 + 308,047 = 2,846,413) are pinned **cap-side** constants (`components/DashboardClient.tsx:75-79`): two state pools (caps net of carve-outs) and one carve-out total. Pools and spend are different axes; their sum equalling the group spend was never an identity in Dee's model either (her pools sum to 2,538,366 = `Summary!J55`, ex shared services).
- Against the workbook: the sheet's total spend (Cap Bonuses, `'EBS Group - FY26'!O5`) is 2,836,288.32. The app's 2,945,167.82 is **+108,879.50** higher, which is the accumulated effect of in-app locks and discretionary edits made after the sign-off. Group remaining 14,121 = 2,959,288.48 - 2,945,167.82 = 14,120.67, rounded.

---

## 5. Shared services deduction map (task 4)

### 5.1 The `calc.ts:363` claim: refuted

`stateVicAvail = caps.vCap - sharedVicFixed` (`lib/calc.ts:363`) *looks* like an internal netting, but `sharedVicFixed` (`:359`) is built entirely from the optional third parameter `shared`, which defaults to `ZERO_SHARED` (`:315`, zeros defined `:116-121`) - and **no call site in the entire repo ever passes it** (verified across all 40+ calls). Therefore `stateVicAvail === vCap` and `stateNswAvail === nCap`, always; steps 1-3 (`:343-364`) are dead code as wired. The test suite confirms it (`lib/params-apply.test.ts:44` expects `stateVicAvail` to equal the raw cap). Shared services staff are instead accounted for as ordinary rows inside the scale denominators (their `bipm·vp`/`bipm·np` sits in `empBipmVpUnlocked`/`empBipmNpUnlocked`, `:331-341`).

Consequently the comment at `components/DashboardClient.tsx:94-99`, which justifies keeping the carve-outs out of `params` because "computeScalesAndBonuses already nets the shared-services allocation out of the cap itself (lib/calc.ts step 3)", describes behaviour that does not occur.

### 5.2 Every real deduction site

| Site | file:line | What it deducts | Rendered/enforced? |
|---|---|---|---|
| Card net figures `vic`/`nsw` | `lib/calc.ts:697-698` | carried shared money off home-state totals | computed; feeds `vicHome`/`nswHome` reconstruction at `DashboardClient.tsx:1612-1613` |
| Derived pool headlines `vicPool`/`nswPool` | `lib/calc.ts:703-704` | `vicCarried`/`nswCarried` off the caps | **never rendered** (shadowed by pins at `DashboardClient.tsx:1640,1649`) |
| `statePoolOf` | `components/DashboardClient.tsx:107-108` | hardcoded `FY26_CAPS` sharedServices + splitState off the live cap | yes: builds `effectiveCaps` (`:804-811`) which bounds the Discretionary ceiling (`:1296,:1341`) and the redistribution budget (`:1794-1795`) |
| Engine steps 1-3 | `lib/calc.ts:351,355,363,364` | zero (see 5.1) | inert |

No shared-services deduction exists in `lib/manager-pool.ts`, `lib/da-impact.ts`, `lib/scope-core.ts`, or `/api/state` gate 4 (all operate on raw caps).

### 5.3 Double-deduction: none in the engine, one live on the client

Because the engine deducts nothing, the code as designed has no double-deduction **provided `params` holds total caps**. That assumption is broken today: `params.nCap` = 1,194,970 is already the carved-out pool, and the client then computes `effectiveCaps.nCap = statePoolOf("NSW", 1,194,970) = 1,024,226` - shared services (145,505) and split state (25,239) subtracted **twice**. Right now every NSW discretionary ceiling and the NSW redistribution budget are understated by 170,744. VIC is not affected (`vCap` holds the total cap). This also inverts the documented "client is always tighter than the server" invariant only in magnitude, not direction, so no over-grant risk - the current risk is refusing/clamping grants the scheme can afford.

---

## 6. Runtime cap edit and override surfaces (task 5)

| # | Surface | file:line | Guard |
|---|---|---|---|
| 1 | Inline cap editors on the VIC/NSW/Group pool cards (`EditableText` footers) | `components/DashboardClient.tsx:1733-1737` (commit map), `:1705-1732` (render), via `updateParams` `:926-930` → POST `/api/params` | `canEditCapsNow` = editor + `canEditCaps` grant + not viewing-as (`:310-311`) |
| 2 | `POST /api/params` | `app/api/params/route.ts:26-84`; caps re-substituted or 403 at `:42-56` | `requireWriter` + `canChangeCaps` (`lib/params-apply.ts:48-50`: full access AND `canEditCaps === true`). Bounds: positive, ≤ 50M/100M. **No `vCap + nCap ≈ gCap` check** |
| 3 | Granting `canEditCaps` | `components/AccessManager.tsx:101,139,195,614`; schema default false `lib/access-rules.ts:57,90`; written via `POST /api/access` (`app/api/access/route.ts:43`) | `requireAdmin` |
| 4 | Spreadsheet import apply | `app/api/import/apply/route.ts:150-165` writes caps parsed from workbook labels (`lib/import-model.ts:429-438`; label scan `findNamedValue` `:68-84` takes the first match, a known ambiguity per its own docblock `:63-66`) | `requireWriter("import-apply")` only - **does not check `canEditCaps`** |
| 5 | Snapshot restore | `lib/snapshots.ts:94-101` (`saveParams`/`clearParams`), invoked from `app/admin/snapshots/page.tsx:117-122` | admin page |
| 6 | `BONUS_DATA` env var (whole dataset incl. caps) | `lib/data.ts:22-36` | deploy-time only |
| 7 | CLI `scripts/import.ts --vCap --nCap [--gCap]` | `scripts/import.ts:104-143` (`gCap` defaults to `vCap + nCap`, `:119,:139`) | operator |

**Per-user cap overrides: none exist.** Per-employee overrides are limited to `daEdit`/`ipmEdit`/`bpEdit`/`locked`/`baseAmount` via `/api/state` (`lib/schema.ts`). Related but display-only: the pinned headlines `PINNED_CARD_HEADLINES` (`components/DashboardClient.tsx:75-79`) and the carve-out constants `FY26_CAPS` (`:101-104`), both hardcoded and marked TEMPORARY (`:59-74`).

---

## 7. Proposed fixes (not applied), smallest blast radius first

1. **Data only: restore the caps in `kestrel:params:fy26`.** Set NSW cap to 1,365,714.1604075 and VIC cap to 1,593,574.3239418203 (via the card editor, `/api/params`, or by restoring the params of the 21 Aug import snapshot). Touches no files. Effects: NSW gate 4 bound and lead pool rise to the signed-off cap, the NSW double-deduction in `effectiveCaps` disappears, VIC regains its cents, card footers become cap-consistent. Nothing else recalculates (scales for NSW are pinned at 1; VIC's scale uses `vCap`, which only regains $0.32).
2. **Fix the wrong comment** at `components/DashboardClient.tsx:94-99` (and the stale docblock claim at `:788-789` that `effectiveCaps` feeds "each card's Remaining" - it does not). One file, zero behaviour change, prevents the next person from "removing a double-deduction" that does not exist in the engine.
3. **Add a consistency guard to `/api/params`** (`app/api/params/route.ts`): refuse or warn when `|vCap + nCap - gCap|` exceeds a small tolerance. One file. Would have blocked both corruptions; note it must allow a deliberate three-field update in one save.
4. **Un-pin the card headlines** (`components/DashboardClient.tsx:75-79,1640,1649,1658`): derive VIC/NSW headlines from `statePoolOf(st, cap)` (or `cards.vicPool`/`nswPool` once methodology is agreed) and the shared headline from live data, and wire the dead `buildUp` prop (`components/PoolCard.tsx:9,26,41-55`) so the cap → carve-outs → pool build-up is visible. Two files. This is the display that would have made the corrupted cap obvious on sight; it also changes the shared headline from 308,047 to the live population's figure, so agree the population with Dee first (Question 5).
5. **Move the carve-outs out of code** (`FY26_CAPS`, `components/DashboardClient.tsx:101-104`): store shared-services/split-state per state in params (or derive them from the SS rows once the methodology in Question 2 is settled). Touches params schema, `/api/params`, `DashboardClient`. Blocked on Dee's answers.
6. **Require `canEditCaps` on `/api/import/apply`** (`app/api/import/apply/route.ts:50-51,150-165`), which currently lets any writer replace all three caps via a workbook. One file; affects the import flow for admins without the caps grant.

---

## 8. Questions for Dee (business decisions, not code defects)

1. **What should the editable "cap" on each state card be** - the total cap (VIC 1,593,574 / NSW 1,365,714) or the state pool (1,343,396 / 1,194,970)? And which should `/api/state` gate 4 bind against? The workbook nets shared services out of the pools; the app currently binds home-state payouts against whatever is stored, which today is the total cap for VIC and the pool for NSW.
2. **Part-split funding methodology:** the workbook splits the four part-split staff with the *no-locks* scales (`I13`/`L13`); the app uses the *live with-locks* scales. Which is the FY26 rule? Also: the app infers the "corporate" ratio as the most common split (0.61) - should that be an explicit flag instead?
3. **Post-sign-off amounts on the four part-split staff:** Clements is locked at $49,065 in the app vs $47,932.60 in the signed-off model; discretionary edits exist on Wali (+5,396), Fairclough (-2,074) and Porter (-769). Are these intended supersessions of the sign-off?
4. **Moving the four part-split staff to VIC home state** (done 24 Aug): in the app this makes their entire bonus draw on VIC's cap in gate 4, while the signed-off model funds $25,239 of it from NSW. Intended?
5. **Which population should the Shared Services card show:** the signed-off 308,046 (corporate + part-split), the live corporate-only 307,613, or something else?
6. **The app's total payouts (2,945,168) exceed the signed-off Cap Bonuses (2,836,288) by 108,880** due to overrides made since sign-off. Does the sign-off need refreshing, or should some overrides be unwound?
7. **Cent precision:** the VIC cap is now stored as 1,593,574 even (the $0.32 was lost in the 07:38 correction). Restore full precision when fixing the NSW cap?
