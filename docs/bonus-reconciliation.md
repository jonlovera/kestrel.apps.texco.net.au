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


---

## 9. Stage 4 — employee-level reconciliation (25 August 2026, live data)

**Source.** Read-only pull of the live Neon store at 25 Aug 2026 ~10:30 UTC (`kestrel:data:fy26` v19, `kestrel:overrides:fy26` v158, `kestrel:params:fy26` as corrected at 09:42 UTC, and all 726 `kestrel:history:fy26` entries), run through the app's own `applyParams → applyOverrides → computeScalesAndBonuses → poolCardTotals`, joined to `'EBS Group - FY26'` of `FY26 EBS Model (1).xlsx` on `Employee ID` = app `id`. **146 of 146 rows join; none unmatched.** Every card figure on the dashboard reproduces to the cent: VIC Remaining −16,636.16, NSW Remaining +30,323.43, Group 2,945,167.82, part-split 90,049.83 / 23,959.39.

Stages 1–3 of the reconciliation plan have shipped since sections 1–8 were written: the cards derive their headline from the total cap through the carve-outs (`lib/fy26-caps.ts`), the params route warns on `|vCap + nCap − gCap| > 1`, the NSW total cap has been corrected, and the carve-outs travel on `Caps` so client clamp and server gates net them identically. Commit `e3088f1` bound each state at `totalCap − sharedServices` ("Option A", which is what the −16,636 in the dashboard screenshot measures); the working tree since binds at the **full state pool** (`statePoolOf`, one identity for headline, lead pool, clamp and gate 4), under which the same data reads **VIC −104,273 / NSW +5,084**. Both readings are bridged below; the per-employee findings are identical under either. Engine scale at this data: `vicScale = 0.78715325`, `nswScale = 1`.

### 9.1 Where VIC's overage comes from (−16,636 under Option A; −104,273 at the state pool)

The signed-off sheet spends VIC **to the cent**, so any dollar added to VIC-home goes red:

| Sheet, what VIC funds | |
|---|---:|
| Pure-VIC rows (69 people, `VIC % = 100`) Σ FINAL FY26 BONUS | 1,343,396.63 (= sheet `J6` "VIC pool") |
| Part-split staff (4), share funded **from VIC** (`Locked → VIC`, AW) | 87,636.51 (= `F9` "split state" 87,637) |
| **Total charged to VIC** | **1,431,033.14** vs `totalCap − SS` 1,431,033.32 → **$0.18 of room at sign-off**; equivalently pure-VIC 1,343,396.63 vs the state pool 1,343,396.32 → **−0.31** |

The app's VIC-home total (1,447,669.16) differs from that in two ways:

| Component | Sheet | App | Δ |
|---|---:|---:|---:|
| Pure-VIC rows (69) | 1,343,396.63 | 1,333,659.94 | **−9,736.69** |
| Part-split four, charged to VIC | 87,636.51 (VIC-funded share only) | 114,009.22 (full payouts, `st = "VIC"` since 24 Aug) | **+26,372.71** |
| → of which the sheet funds from **NSW** | 25,239.33 | 0 | +25,239.33 |
| → of which post-sign-off movement on those four | | | +1,133.37 (Clements' lock 47,932.60 → 49,065.00 is +1,132.40) |
| **Remaining, Option A** (`totalCap − SS` = 1,431,033) | +0.18 | **−16,636.16** | |
| **Remaining, state pool** (`totalCap − SS − split` = 1,343,396) | −0.31 | **−104,272.84** | |

Bridges (cents aside — `vCap` lost its 32¢ on 25 Aug, see 9.5): Option A **0.18 + 9,736.69 − 26,372.71 = −16,635.84**. State pool: the pool is *defined* net of the part-split staff, so it charges VIC nothing for them while the app charges their full 114,009.22 → **−0.31 + 9,736.69 − 114,009.22 = −104,272.84**.

**Reading.** The 69 VIC employees are collectively **9,737 under** their signed-off amounts. Under either identity the red card is the 24 Aug move of Clements, Fairclough, Wali and Porter to `st = "VIC"` (log 1295–1301, dgibson 03:14 UTC): their whole payouts now sit on VIC's ledger. Under Option A that over-charges VIC by the 25,239 the sheet funds from NSW; under the state-pool identity it charges VIC all 114,009 of payouts the sheet has already carved out of the pool — the double-count `lib/fy26-caps.ts` now describes as "absorbed". It need not be absorbed: it is a data artefact, see 9.6 (1).

The mirror image on NSW confirms it: NSW rows are **+117,916.23** over sign-off and the sheet had 123,000.16 unspent (`O10`). At the state pool, NSW Remaining = 1,194,969.16 − 1,189,885.57 = **+5,084**; under Option A the 25,239 no longer charged to NSW lifts it to the 30,323 the screenshot showed.

### 9.2 VIC-home rows — every variance, attributed

Baseline for "who/when" is the 21 Aug 00:59 UTC import (log 682, dgibson) that set the signed-off caps and 35 locks; entries before it are listed only where nothing later touched the row. "as X" = an admin acting through **View as**.

| Δ app − sheet | Employee | Id | App final | Sheet final | What moved it | Who / when (UTC) |
|---:|---|---|---:|---:|---|---|
| −28,777 | Richard Porter | RIPOR | 28,614.76 | 57,391.70 | Discretionary grant: DA 801 (sheet 0); IPM 40% (sheet 90%) | jbull, jlovera · 24 Aug 00:14 → 25 Aug 02:16 |
| −10,088 | Paul Dwyer | PADWY | 19,369.64 | 29,458.00 | Unlocked in app (sheet locked): sheet lock 29,458.00 | ccassar (as jglick) · 21 Aug 01:11 |
| −8,677 | Morgan Walker | MOMAR | 0.00 | 8,677.38 | IPM changed: IPM 0% (sheet 90%) | ccassar · 21 Aug 01:23 → 24 Aug 04:27 |
| −8,492 | Martin Lipshut | MALIP | 36,253.90 | 44,746.07 | IPM changed: IPM 65% (sheet 90%) | ccassar, ccassar (as jglick) · 21 Aug 01:20 → 21 Aug 01:53 |
| +7,348 | Paul Darby | PADAR | 67,658.05 | 60,309.92 | Discretionary grant: DA 1,895 (sheet 0) | jlovera, dgibson, jlovera (as ccassar) · 24 Aug 00:33 → 25 Aug 04:35 |
| +6,992 | Lachlan Hill | LAHIL | 64,383.97 | 57,391.70 | Discretionary grant: DA 1,803 (sheet 0) | jlovera · 25 Aug 02:14 → 25 Aug 02:16 |
| +6,992 | Jonathan Glick | JOGLI | 64,383.97 | 57,391.70 | Discretionary grant: DA 1,803 (sheet 0) | ccassar, jlovera · 24 Aug 04:27 → 25 Aug 04:04 |
| +6,163 | Ayrton Solar | AYSOL | 56,745.24 | 50,582.52 | Locked in app (sheet unlocked): lock 56,745.24 | ccassar (as jglick) · 21 Aug 01:53 |
| +6,163 | Andrew Jelbart | ANJEL | 56,745.24 | 50,582.52 | Locked in app (sheet unlocked): lock 56,745.24 | ccassar (as jglick), ccassar · 21 Aug 01:11 → 21 Aug 01:53 |
| −6,002 | Scott Richards | SCRIC | 41,088.16 | 47,090.38 | IPM changed: IPM 70% (sheet 90%) | ccassar, ccassar (as jglick) · 21 Aug 01:23 → 21 Aug 01:53 |
| −5,951 | Nicholas Preston | NIPRE | 40,740.17 | 46,691.55 | IPM changed: IPM 70% (sheet 90%) | ccassar, ccassar (as jglick) · 21 Aug 01:20 → 21 Aug 01:53 |
| +5,762 | Brett Holst | BRHOL | 29,136.66 | 23,375.09 | IPM changed: IPM 100% (sheet 90%) | ccassar (as jglick) · 21 Aug 01:53 |
| −5,730 | Stefan Howley | STHOW | 23,727.81 | 29,458.00 | Unlocked in app (sheet locked): sheet lock 29,458.00 | ccassar (as jglick) · 21 Aug 01:11 |
| +5,689 | William Peterson | WIPET | 52,380.33 | 46,691.55 | Discretionary grant: DA 1,467 (sheet 0) | jbull, jlovera · 24 Aug 00:19 → 25 Aug 02:18 |
| +4,735 | Neil Timms | NETIM | 43,601.63 | 38,866.39 | Discretionary grant: DA 1,221 (sheet 0) | ccassar, jlovera, dgibson · 21 Aug 01:23 → 25 Aug 04:03 |
| −4,628 | Joshua Smith | JOSMI | 31,680.60 | 36,308.55 | IPM changed: IPM 70% (sheet 90%) | ccassar, ccassar (as jglick) · 21 Aug 01:20 → 21 Aug 01:53 |
| +3,082 | Sam Cutts | SACUT | 28,373.05 | 25,291.26 | Discretionary grant: DA 795 (sheet 0) | jlovera · 25 Aug 04:17 |
| +3,042 | Michael Franklin | MIFRA | 28,009.49 | 24,967.01 | Discretionary grant: DA 785 (sheet 0) | jlovera · 25 Aug 04:18 |
| −2,976 | Stephanie Nash | STNAS | 20,369.63 | 23,345.78 | Discretionary grant: DA 570 (sheet 0); IPM 70% (sheet 90%) | ccassar, jlovera · 21 Aug 01:23 → 25 Aug 02:20 |
| +2,765 | Kim Nguyen | KINGU | 25,462.54 | 22,697.28 | Discretionary grant: DA 713 (sheet 0) | jlovera · 25 Aug 04:18 → 25 Aug 04:19 |
| +2,765 | Jacob Rockwell | JAROC | 25,462.54 | 22,697.28 | Discretionary grant: DA 713 (sheet 0) | jbull, jlovera · 24 Aug 00:19 → 25 Aug 04:19 |
| +2,763 | Joshua Abell | JOABE | 17,840.37 | 15,077.48 | IPM changed: IPM 95% (sheet 90%) | ccassar, ccassar (as jglick) · 21 Aug 01:20 → 21 Aug 01:35 |
| +2,674 | Luke Bettio | LUBET | 17,264.88 | 14,591.11 | IPM changed: IPM 95% (sheet 90%) | ccassar, ccassar (as jglick) · 21 Aug 01:20 → 21 Aug 01:35 |
| +2,674 | Benjamin Watson | BEWAT | 17,264.88 | 14,591.11 | IPM changed: IPM 95% (sheet 90%) | ccassar, ccassar (as jglick) · 21 Aug 01:20 → 21 Aug 01:35 |
| +2,674 | Thomas Haddon | TOHAD | 17,264.88 | 14,591.11 | IPM changed: IPM 95% (sheet 90%) | ccassar, ccassar (as jglick) · 21 Aug 01:17 → 21 Aug 01:35 |
| −2,574 | Giuseppe Tassone | GITAS | 17,619.68 | 20,194.10 | Discretionary grant: DA 493 (sheet 0); IPM 70% (sheet 90%) | ccassar, jlovera · 21 Aug 01:14 → 25 Aug 03:57 |
| −2,375 | Matthew Morris | MAMOR | 21,375.00 | 23,750.00 | IPM changed: IPM 90% (sheet 100%) | ccassar (as jglick), jlovera · 21 Aug 01:11 → 24 Aug 04:20 |
| +2,316 | Timothy McSweeney | TIMCS | 23,484.00 | 21,167.89 | IPM changed: IPM 100% (sheet 90%) | ccassar (as jglick), jlovera · 21 Aug 01:11 → 24 Aug 04:20 |
| +1,948 | Jamie Chartres | JACHA | 17,938.43 | 15,990.26 | Locked in app (sheet unlocked): lock 17,938.43 | ccassar (as jglick) · 21 Aug 01:53 |
| +1,896 | Vern Hun Ng | VERNG | 17,460.11 | 15,563.85 | Discretionary grant: DA 489 (sheet 0) | jlovera · 25 Aug 02:29 |
| +1,883 | Adam Bull | ADBUL | 17,446.61 | 15,563.85 | Locked in app (sheet unlocked): lock 17,446.61 | ccassar (as jglick) · 21 Aug 01:35 |
| +1,718 | Nicholas Chan | NICHA | 15,823.07 | 14,104.74 | Discretionary grant: DA 443 (sheet 0) | jlovera · 25 Aug 02:29 |
| −1,576 | Ayla Mesic | AYMES | 0.00 | 1,576.00 | IPM changed: IPM 0% (sheet 90%) | ccassar, ccassar (as jglick) · 21 Aug 01:14 → 21 Aug 01:32 |
| −1,477 | Maie Cumbrae-Stewart | MACUM | 4,357.39 | 5,834.67 | IPM changed: IPM 60% (sheet 90%) | ccassar, ccassar (as jglick) · 21 Aug 01:17 → 21 Aug 01:32 |
| −1,396 | Hamish Wild | HAWIL | 4,116.57 | 5,512.20 | IPM changed: IPM 60% (sheet 90%) | ccassar, ccassar (as jglick) · 21 Aug 01:14 → 21 Aug 01:32 |
| −1,263 | Songlin Li | SOLI | 3,725.81 | 4,988.96 | IPM changed: IPM 60% (sheet 90%) | ccassar, ccassar (as jglick) · 21 Aug 01:14 → 21 Aug 01:32 |
| +1,132 | Peter Clements | PECLE | 49,065.00 | 47,932.60 | Lock amount changed: lock 49,065.00 (sheet 47,932.60) | — · — |
| +948 | Georgia Sibly | GESIB | 8,729.56 | 7,781.93 | Discretionary grant: DA 244 (sheet 0) | jlovera · 25 Aug 02:30 |
| −714 | Michael Holland | MIHOL | 4,834.39 | 5,548.62 | IPM changed: IPM 70% (sheet 90%) | ccassar, ccassar (as jglick) · 21 Aug 01:17 → 21 Aug 01:32 |
| +649 | Chengcheng Huang | CHHUA | 5,973.36 | 5,323.98 | Discretionary grant: DA 168 (sheet 0) | jlovera · 25 Aug 02:29 |
| −453 | Paris Waters | PAWAT | 6,362.51 | 6,815.67 | IPM changed: IPM 75% (sheet 90%) | ccassar, ccassar (as jglick) · 21 Aug 01:17 → 21 Aug 01:32 |
| −56 | Robert Hughes | ROHUG | 14,851.60 | 14,907.65 | Unlocked in app (sheet locked): sheet lock 14,907.65 | ccassar (as jglick) · 21 Aug 01:11 |
| −52 | Corey Tucker | COTUC | 12,645.80 | 12,697.63 | Unlocked in app (sheet locked): sheet lock 12,697.63 | ccassar (as jglick) · 21 Aug 01:11 |
| −50 | Mitchell Parker | MIPAR | 13,879.75 | 13,929.65 | IPM changed: IPM 80% (sheet 90%) | ccassar, ccassar (as jglick) · 21 Aug 01:17 → 21 Aug 01:35 |
| −49 | Niklas Derungs | NIDER | 13,569.59 | 13,618.37 | IPM changed: IPM 80% (sheet 90%) | ccassar, ccassar (as jglick) · 21 Aug 01:17 → 21 Aug 01:35 |
| −20 | Jonathan Grimwade | JOGRI | 5,537.60 | 5,557.50 | IPM changed: IPM 80% (sheet 90%) | ccassar (as jglick) · 21 Aug 01:32 |
| +1 | Elizabeth Porter | ELPOR | 8,771.24 | 8,770.65 | Discretionary grant: DA −769 (sheet 0) | dgibson · 21 Aug 01:23 → 21 Aug 01:48 |
| **−8,604** | **47 rows differ** (26 match) | | | | | |

Grouped:

| Cause | Rows | Σ Δ | Who |
|---|---:|---:|---|
| IPM changed (with locks) | 21 | −24,262 | ccassar 21 Aug 01:14–01:53 (VIC lead determinations, ~20–55 min after the import), jlovera 24 Aug (Morris, McSweeney) |
| Locked in app, sheet unlocked | 4 | +16,156 | ccassar as jglick, 21 Aug 01:35–01:53 (Solar, Jelbart, Chartres, Bull) |
| Unlocked in app, sheet locked | 4 | −15,926 | jlovera 20 Aug 07:22, then ccassar as jglick 21 Aug 01:11 (Dwyer, Howley, Hughes, Tucker) |
| Discretionary grants | 17 | +14,296 | **jlovera, 25 Aug 02:11–04:35 UTC** (16 grants totalling 14,403; several recorded with "room under the caps at the time $0"), dgibson 21 Aug (E. Porter −769) |
| Lock amount changed | 1 | +1,132 | Clements 47,932.60 → 49,065.00 — no lock entry in the log; came in with the 24 Aug state move / import |

### 9.3 NSW-home rows — every variance, attributed

| Δ app − sheet | Employee | Id | App final | Sheet final | What moved it | Who / when (UTC) |
|---:|---|---|---:|---:|---|---|
| +246,000 | Marcus Cooper | MACOO | 246,000.00 | 0.00 | Discretionary grant: DA 246,000 (sheet 0); IPM 100% (sheet 90%) | dgibson, jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 00:28 → 25 Aug 07:06 |
| −21,850 | David Massoud | DAMAS | 0.00 | 21,850.00 | IPM changed: IPM 0% (sheet 100%) | jlovera (as sgriffin) · 24 Aug 07:45 → 24 Aug 23:45 |
| −20,460 | Anne-Kristin Kahra | ANNKA | 61,378.77 | 81,838.36 | IPM changed: IPM 75% (sheet 100%) | jlovera (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:50 |
| −18,412 | Dileen Kumar | DIKUM | 27,618.08 | 46,030.14 | IPM changed: IPM 60% (sheet 100%) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| −13,500 | Thomas McCreanor | THMCC | 76,500.00 | 90,000.00 | IPM changed: IPM 85% (sheet 100%) | dgibson, jlovera (as sgriffin) · 24 Aug 03:12 → 24 Aug 07:50 |
| −12,000 | Patricia Albarracin | PAALB | 18,000.00 | 30,000.00 | IPM changed: IPM 60% (sheet 100%) | jlovera (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:50 |
| −11,705 | Nicholas Baird | NIBAI | 17,557.40 | 29,262.33 | IPM changed: IPM 60% (sheet 100%) | jlovera (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:50 |
| −11,496 | Kenneth Talbot | KETAL | 7,664.08 | 19,160.20 | IPM changed: IPM 40% (sheet 100%) | jlovera (as sgriffin) · 24 Aug 07:45 → 24 Aug 23:45 |
| −10,335 | Santiago Luperdi | SALUP | 69,165.00 | 79,500.00 | IPM changed: IPM 87% (sheet 100%) | jlovera (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:50 |
| +10,000 | Matthew Henwood | MAHEN | 10,000.00 | 0.00 | Discretionary grant: DA 10,000 (sheet 0); IPM 100% (sheet 90%) | jlovera (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:50 |
| +10,000 | Jaimen Driene | JADRI | 10,000.00 | 0.00 | Discretionary grant: DA 10,000 (sheet 0); IPM 100% (sheet 90%) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| −9,327 | Luke Townsend | LUTOW | 62,422.50 | 71,750.00 | IPM changed: IPM 87% (sheet 100%) | jlovera (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:50 |
| −8,850 | Scott Porth | SCPOR | 20,650.00 | 29,500.00 | IPM changed: IPM 70% (sheet 100%) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| −8,409 | Vinesh Rao | VIRAO | 19,622.05 | 28,031.51 | IPM changed: IPM 70% (sheet 100%) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| −8,100 | Michael Liu | MALIU | 18,900.00 | 27,000.00 | IPM changed: IPM 70% (sheet 100%) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| −7,200 | Jyoti Sharma | JYSHA | 64,800.00 | 72,000.00 | IPM changed: IPM 90% (sheet 100%) | jlovera (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:50 |
| −6,843 | Jonathan Benjamin | JOBEN | 38,777.47 | 45,620.55 | IPM changed: IPM 85% (sheet 100%) | jlovera (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:50 |
| −6,431 | Ana Martha Alves | ANAAL | 9,646.03 | 16,076.71 | IPM changed: IPM 60% (sheet 100%) | dgibson, jlovera (as sgriffin) · 24 Aug 00:43 → 24 Aug 07:50 |
| −5,462 | Ben Smith | BESMI | 16,387.50 | 21,850.00 | IPM changed: IPM 75% (sheet 100%) | jlovera (as sgriffin) · 24 Aug 07:45 → 24 Aug 23:45 |
| −5,075 | Erica Vicenzi Blanco | ERBLA | 15,226.03 | 20,301.37 | IPM changed: IPM 75% (sheet 100%) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| +5,000 | Marc Joshua | MAJOS | 15,202.05 | 10,202.05 | Discretionary grant: DA 5,000 (sheet 0) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| +5,000 | Novica Perendic | NOPER | 15,500.00 | 10,500.00 | Discretionary grant: DA 5,000 (sheet 0) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| +5,000 | Lee Brown | LEBRO | 14,500.00 | 9,500.00 | Discretionary grant: DA 5,000 (sheet 0) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| +5,000 | Matthew Hooper | MAHOO | 14,000.00 | 9,000.00 | Discretionary grant: DA 5,000 (sheet 0) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| +5,000 | Mitchell Shaw | MISHA | 13,750.00 | 8,750.00 | Discretionary grant: DA 5,000 (sheet 0) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| −5,000 | Matthew Carr | MACAR | 15,000.00 | 20,000.00 | IPM changed: IPM 75% (sheet 100%) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| −4,875 | Michael Jarevski | MIJAR | 27,625.00 | 32,500.00 | IPM changed: IPM 85% (sheet 100%) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:49 |
| +4,847 | Riley Moss | RIMOS | 10,000.42 | 5,153.42 | Discretionary grant: DA 4,847 (sheet 0) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| −3,071 | Frances Zuza | FRYAN | 12,284.05 | 15,355.07 | IPM changed: IPM 80% (sheet 100%) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| +2,518 | Michael Briggs | MIBRI | 25,175.00 | 22,657.50 | IPM changed: IPM 100% (sheet 90%) | jlovera (as sgriffin) · 24 Aug 23:45 |
| +2,500 | Ava-Rose Robertson | AVROB | 2,500.00 | 0.00 | Discretionary grant: DA 2,500 (sheet 0); IPM 100% (sheet 90%) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| +2,500 | Jacqueline Alves | JAALV | 2,500.00 | 0.00 | Discretionary grant: DA 2,500 (sheet 0); IPM 100% (sheet 90%) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| +2,500 | Mark Rubelj | MARUB | 2,500.00 | 0.00 | Discretionary grant: DA 2,500 (sheet 0); IPM 100% (sheet 90%) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| +2,500 | Thomas Hanzis | THHAN | 2,500.00 | 0.00 | Discretionary grant: DA 2,500 (sheet 0); IPM 100% (sheet 90%) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| +2,500 | Dhruval Amin | DHAMI | 2,500.00 | 0.00 | Discretionary grant: DA 2,500 (sheet 0); IPM 100% (sheet 90%) | jlovera, jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 04:20 → 24 Aug 07:51 |
| +2,500 | Zachary Kalogerou | ZAKAL | 2,500.00 | 0.00 | Discretionary grant: DA 2,500 (sheet 0); IPM 100% (sheet 90%) | jlovera, jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 04:20 → 24 Aug 07:51 |
| −2,014 | Benjamin Jenkins | BEJEN | 18,126.00 | 20,140.00 | IPM changed: IPM 90% (sheet 100%) | jlovera (as sgriffin) · 24 Aug 07:45 → 24 Aug 23:45 |
| +2,000 | Luke Guilfoyle | LUGUI | 12,208.22 | 10,208.22 | Discretionary grant: DA 2,000 (sheet 0) | jlovera (as sgriffin) · 24 Aug 07:45 → 24 Aug 23:45 |
| −1,600 | Luke Alker | LUALK | 14,400.00 | 16,000.00 | IPM changed: IPM 90% (sheet 100%) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| +1,326 | Katelyn Petracca | KAPET | 4,999.97 | 3,673.97 | Discretionary grant: DA 1,326 (sheet 0) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| +1,250 | Benjamin Forwood | BENFO | 25,000.00 | 23,750.00 | Discretionary grant: DA 1,250 (sheet 0) | jlovera (as sgriffin) · 24 Aug 07:45 → 24 Aug 23:45 |
| +1,250 | Grant Griffin | GRGRI | 25,000.00 | 23,750.00 | Discretionary grant: DA 1,250 (sheet 0) | jlovera (as sgriffin) · 24 Aug 07:45 → 24 Aug 23:45 |
| −1,200 | Christopher Duong | CHDUO | 10,800.00 | 12,000.00 | IPM changed: IPM 90% (sheet 100%) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| +1,192 | Carl Manalang | CAMAN | 5,000.22 | 3,808.22 | Discretionary grant: DA 1,192 (sheet 0) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| +500 | Ruben Cunniappen | RUCUN | 10,000.00 | 9,500.00 | Discretionary grant: DA 500 (sheet 0) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| +250 | Taylor Nicholls | TANIC | 10,000.00 | 9,750.00 | Discretionary grant: DA 250 (sheet 0) | jlovera (as sgriffin), dgibson (as sgriffin) · 24 Aug 07:45 → 24 Aug 07:51 |
| **+117,916** | **46 rows differ** (6 match) | | | | | |

**One event.** All 46 NSW variances trace to a single batch at **24 Aug 07:45 UTC by jlovera acting as sgriffin** (24 IPM reductions from 100%, 22 discretionary grants), locked at 07:49–07:51 by jlovera/dgibson as sgriffin and at 23:45 by jlovera as sgriffin. The sheet has every NSW row at IPM 100% with no discretionary — i.e. **the signed-off model predates the NSW lead's determinations**. Marcus Cooper's **+246,000** (sheet FINAL = 0) was entered, removed by dgibson-as-sgriffin at 09:47 ("reduced from $246,000 to $0"), re-entered at 23:46, and toggled four more times on 25 Aug 07:05–07:06 before settling at 246,000 locked. It is 2.3× the whole NSW drift and the single largest open item.

Grouped: IPM reductions −200,699 across 24 rows; discretionary grants +318,615 across 22 rows (246,000 Cooper + 72,615 others).

### 9.4 Shared Services rows

| Δ app − sheet | Employee | Id | App final | Sheet final | What moved it | Who / when (UTC) |
|---:|---|---|---:|---:|---|---|
| −220 | Alan Bidychak | ALBID | 45,150.32 | 45,369.96 | Lock amount changed: lock 45,150.32 (sheet 45,369.96) | dgibson · 24 Aug 03:28 |
| −214 | Deanne Gibson | DEGIB | 46,523.56 | 46,737.34 | Lock amount changed: lock 46,523.56 (sheet 46,737.34) | dgibson · 24 Aug 03:28 |
| **−433** | **2 rows differ** (19 match) | | | | | |

Both are dgibson on 24 Aug 03:28 UTC: the 5,000 discretionary each had carried was removed and the lock re-struck ~215 lower. Together −433.42 — which is exactly why the live shared figure is 307,613.08 against the pinned 308,047 (the other 0.50 is the F9/F10 rounding noted in 4.2).

### 9.5 Part-split lines: 90,050 / 23,959 vs 87,637 / 25,239

Same four people; the difference is method and amount, fully quantified at live data:

| | VIC share | NSW share |
|---|---:|---:|
| Sheet: signed-off locked amounts (Σ 112,875.85), split at the **no-locks** scale `I13 = 0.71420` (`AW = AV·N·I13/(N·I13 + O·L13)`) | 87,636.51 | 25,239.33 |
| App amounts (Σ 114,009.22) at the sheet's no-locks scale | 88,345.12 | 25,664.10 |
| App: live amounts at the live **with-locks** `vicScale = 0.78715` (`lib/calc.ts` `fracVic`) | 90,049.83 | 23,959.39 |
| **Scale effect** | **+1,704.71** | **−1,704.71** |
| **Amount effect** (Clements +1,132.40 split ≈ 62/38; Fairclough/Wali/Porter cents) | **+708.61** | **+424.77** |
| Total | +2,413.32 | −1,279.94 |

(The sheet's own with-locks scale is `I11 = 0.72055`; the app's is 0.78715 because its lock set — Clint's 21 Aug locks, the NSW batch — is not the sheet's.)

**Cents.** The 25 Aug 09:42 correction set `nCap = 1365714` and `vCap = 1593574` — whole dollars; 16¢ and 32¢ lost respectively. Re-paste `1593574.3239418203` and `1365714.1604075` when convenient. No conclusion above depends on it.

### 9.6 Decision list for Dee

1. **The four part-split staff's home state — the whole of the red card.** The sheet's state pools are defined *net* of these four (their locked amounts are the "split state" carve), so a pool-bound VIC must not also carry their payouts in its home total. With the tree now binding at the state pool, **moving Clements, Fairclough, Wali and Porter back to `st = "SHARED"` is a data-only change (the 24 Aug 03:14 moves, log 1295–1301, reversed through the employee edit modal) and reproduces the sheet's ledgers exactly at today's data: VIC Remaining +9,736, NSW Remaining +5,084.** No payout moves; the Shared Services card's part-split lines keep reporting their split. The alternative — keep `st = "VIC"` and accept VIC at −104,273 — books to VIC 114,009 the sheet has already taken out of VIC's pool.
2. **Marcus Cooper +246,000** (locked, sheet FINAL 0). Confirm or unwind. If unwound, NSW's drift falls to −128,084 and its Remaining (state pool) to +251,084.
3. **The NSW batch of 24 Aug 07:45** (Simon Griffin's determinations, entered via View-as): 24 IPM cuts −200,699 and 21 grants +72,615. These are absent from the signed-off model. Refresh the sign-off to include them, or treat the sheet as superseded for NSW.
4. **Clint Cassar's VIC determinations of 21 Aug 01:14–01:53** (21 IPM changes, 4 new locks, 4 unlocks): net −8,603 vs the sheet before discretionary. Same question — the sheet was imported at 00:59 and these followed within the hour.
5. **The 16 VIC discretionary grants of 25 Aug 02:11–04:35 UTC by jlovera (+14,403).** Several were accepted with "room under the caps at the time $0" and all are on rows that were locked–unlocked–granted–relocked within a minute. Confirm whether these are real awards or gate-4 test entries; if test, unwind them (VIC pure-row drift becomes −24,140).
6. **Four sheet locks the app dropped** (Dwyer 29,458 → 19,370; Howley 29,458 → 23,728; Hughes; Tucker): unlocked 20 Aug by jlovera and again 21 Aug by ccassar-as-jglick after the import re-locked them. Intended?
7. **Part-split split method** for the Shared Services card lines: adopt the sheet's no-locks scale in `poolCardTotals` (small code change: compute `(I5+I6+I8)/I12`-style no-locks scale in the engine output), or restate `F9`/`F10` on the with-locks method. Independent of (1).
8. **Clements 49,065 vs 47,932.60** — no lock-amount entry exists in the log for the change; it arrived with the 24 Aug move. Confirm which figure stands.
9. **Shared headline pin 308,047 vs live 307,613** (Bidychak/Gibson −433 on 24 Aug): un-pin once the population question (Q5 in §8) is settled.

Recommendation on the VIC card specifically: nothing in (2)–(9) is needed to clear it — (1) alone does, with no code change and without moving a single payout.
