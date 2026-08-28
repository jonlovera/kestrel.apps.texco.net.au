/**
 * Manager pool: the cap composition, and the write gate that keeps an
 * allocation inside it.
 *
 * The composition assertions are the contract — each one pins a knob of the
 * definition (which rows, which figure, locked in or out, shared services in
 * or out) by recomputing it independently rather than by naming a dollar
 * amount, so a lock toggled next week moves both sides together and the tests
 * still hold. The single pinned figure at the end is a reconciliation anchor
 * against the CFO's sheet, not the contract.
 *
 * Clint's grant is a GROUP rule (VIC + SHARED, fifteen positions), so these
 * figures exercise a PROPORTIONAL share of the VIC pool rather than the whole
 * of it — see lib/manager-pool.ts. The whole-state case (share exactly 1) is
 * covered separately below, and is the regression proof that replacing the old
 * entitlement definition moved no state lead's figures.
 *
 * The fixture is a point-in-time PRODUCTION capture (data/prod-fixture.json,
 * gitignored, created 2026-08-21 — regenerate with a read-only pull of the
 * four kestrel_docs rows if it goes stale). Three assertions reproduce, to the
 * cent, figures the stakeholder quoted from Clint Cassar's live dashboard —
 * proof the fixture, the engine and the scope filter are all faithful.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AccessRuleSchema, ruleMatches } from "./access-rules";
import type { GrantingRule } from "./access-rules";
import { DatasetSchema, OverridesSchema } from "./schema";
import type { Dataset, Employee, Overrides } from "./schema";
import { ParamsSchema, applyParams } from "./params-apply";
import type { Scope } from "./access";
import {
  EPSILON,
  capIsStatePool,
  managerPool,
  managerPoolFrom,
  maxAdditionalAllocation,
  poolBreach,
  suggestedAllowance,
} from "./manager-pool";
import {
  applyOverrides,
  computeScalesAndBonuses,
  floorCents,
  fundedByStatePool,
  stateBoundCap,
  getMaxDA,
  stateHomeTotal,
  stateRoom,
} from "./calc";
import type { CalcEmployee } from "./calc";
import {
  FY26_PUBLISHED,
  attachFy26Carves,
  stateCarveOf,
  statePoolOf,
} from "./fy26-caps";

const FIXTURE = join(__dirname, "..", "data", "prod-fixture.json");

describe.skipIf(!existsSync(FIXTURE))(
  "Clint Cassar's scope figures (production capture)",
  () => {
    const raw = JSON.parse(readFileSync(FIXTURE, "utf-8"));
    const params = ParamsSchema.parse(raw.params);
    const data = applyParams(DatasetSchema.parse(raw.dataset), params);
    const overrides = OverridesSchema.parse(raw.overrides);
    const rule = AccessRuleSchema.parse(raw.access["ccassar@texco.net.au"]);
    if (rule.type === "none" || rule.type === "full") {
      throw new Error("fixture rule is not a scoped rule");
    }
    const scope: Scope = {
      email: "ccassar@texco.net.au",
      rule,
      canEdit: false,
      visibleFields: rule.visibleFields,
      label: "Clint Cassar",
    };

    const result = managerPool(scope, data, overrides);

    /** The engine's own view of the population, for independent recomputation. */
    function population(extra: Overrides = {}) {
      const emps = applyOverrides(data.emp, { ...overrides, ...extra });
      computeScalesAndBonuses(emps, data);
      return emps;
    }
    const mine = population().filter((e) => ruleMatches(scope.rule, e));

    it("sees exactly 57 people in scope", () => {
      expect(result.people).toBe(57);
    });

    /** The rows the budget covers: the ones a state pool actually funds. */
    const budgeted = mine.filter((e) => fundedByStatePool(e));

    it("Allocated is sum(finalBonus) over the rows the budget covers", () => {
      const expected = budgeted.reduce((s, e) => s + e.finalBonus, 0);
      expect(result.allocated).toBeCloseTo(expected, 6);
      // and that is NOT every row in scope — the carve-funded ones are out
      expect(budgeted.length).toBeLessThan(mine.length);
      expect(result.allocated).not.toBeCloseTo(
        mine.reduce((s, e) => s + e.finalBonus, 0),
        2
      );
    });

    it("Allocated is the VIC-home finals, with Shared Services left out", () => {
      const vicHome = mine
        .filter((e) => e.st === "VIC" && fundedByStatePool(e))
        .reduce((s, e) => s + e.finalBonus, 0);
      expect(vicHome).toBeCloseTo(result.allocated, 6);
      // the shared-services row in scope is real, and deliberately not in it:
      // the VIC pool is already defined net of the carve that funds it
      const sharedInScope = mine.filter((e) => e.st === "SHARED");
      expect(sharedInScope).toHaveLength(1);
      expect(sharedInScope[0].finalBonus).toBeGreaterThan(0);
    });

    // ── the composition, knob by knob ──

    it("with no allowance granted, the cap is exactly what is already committed", () => {
      // 28 Aug 2026: a group scope's ceiling is no longer derived at all. Until
      // an admin sets an allowance (lib/access-rules.ts's allocationCap) there
      // is no new money, so the cap is the commitment and Remaining is nil.
      // Clint's fixture rule carries no allowance.
      expect(rule.allocationCap).toBeUndefined();
      expect(result.pool).toBeCloseTo(result.allocated, 6);
      expect(result.remaining).toBeCloseTo(0, 6);
    });

    it("the old derived share survives only as a SUGGESTION for the admin", () => {
      const committed = (e: CalcEmployee) => e.finalBonus - e.daEdit;
      const allVic = population()
        .filter((e) => e.st === "VIC" && fundedByStatePool(e))
        .reduce((s, e) => s + committed(e), 0);
      const ourVic = budgeted
        .filter((e) => e.st === "VIC")
        .reduce((s, e) => s + committed(e), 0);
      // The state pool is the cap less what VIC is LIVE-carrying for people
      // outside its home total (lib/calc.ts's stateBoundCap, 28 Aug 2026) —
      // the same definition the module uses, so this pins the relationship
      // rather than restating the arithmetic.
      const vicPool = stateBoundCap("VIC", population(), data)!;
      const room = vicPool - allVic;
      // a real share of the state, and not all of it — this is a group rule
      expect(ourVic / allVic).toBeGreaterThan(0.5);
      expect(ourVic / allVic).toBeLessThan(1);
      // this is what /admin offers beside the field, and nothing applies it
      expect(suggestedAllowance(rule, population(), data)).toBeCloseTo(
        room * (ourVic / allVic),
        6
      );
    });

    it("pool is NOT Σ calcBonus — that was the definition being replaced", () => {
      // the basis mismatch this whole module was rewritten to remove: `pool`
      // on the advisory Calc bonus column while `allocated` was the stored
      // payouts, which drifted apart once a payout became a stored figure
      const entitlement = mine.reduce((s, e) => s + e.calcBonus, 0);
      expect(result.pool).not.toBeCloseTo(entitlement, 2);
    });

    it("a locked row's committed amount is on BOTH sides, so it cannot manufacture a breach", () => {
      const locked = budgeted.filter((e) => e.locked);
      // a real share of this scope, so the assertion has teeth
      expect(locked.length).toBeGreaterThan(20);

      // A frozen person still draws from the pool their manager answers for,
      // so they stay counted. What changed is that the amount they draw is now
      // the SAME figure in the weight and in `allocated`. Under the old
      // entitlement definition the weight was their live entitlement while
      // `allocated` was their frozen payout, and the gap between the two was
      // reported to the lead as an overspend they could not act on.
      const drift = locked.reduce(
        (s, e) => s + (e.finalBonus - e.daEdit - e.calcBonus),
        0
      );
      expect(Math.abs(drift)).toBeGreaterThan(1_000); // the gap is real…
      const noDa = managerPool(
        scope,
        data,
        Object.fromEntries(
          Object.entries(overrides).map(([id, ov]) => [id, { ...ov, daEdit: 0 }])
        )
      );
      // …and it cannot put the lead over at all: the commitment IS the floor,
      // so with no allowance granted Remaining sits exactly on nil rather than
      // going negative by the drift
      expect(noDa.remaining).toBeCloseTo(0, 6);
      expect(noDa.pool).toBeCloseTo(noDa.allocated, 6);
    });

    it("a shared-services row in scope is still theirs to manage, and outside their budget", () => {
      // 24 of the 25 SHARED rows never reach this scope at all because the
      // access rule doesn't admit them. The 25th (Peter Clements) does — the
      // fixture is a 21 Aug 2026 capture, taken while he was still flagged
      // SHARED — and he is counted in `people` while being funded from outside
      // both state pools, so no state pool is charged for him.
      const sharedInScope = mine.filter((e) => e.st === "SHARED");
      const sharedAtLarge = population().filter((e) => e.st === "SHARED");
      expect(sharedInScope).toHaveLength(1);
      expect(sharedAtLarge.length).toBeGreaterThan(sharedInScope.length);

      expect(result.people).toBe(mine.length); // in scope, and counted
      expect(budgeted).not.toContain(sharedInScope[0]); // out of the budget

      // so a grant to him moves nothing the budget measures, and gate 3 has no
      // opinion on it — exactly as for a carve-funded VIC row
      const withDa = managerPool(scope, data, {
        ...overrides,
        [sharedInScope[0].id]: {
          ...overrides[sharedInScope[0].id],
          daEdit: 5_000,
        },
      });
      expect(withDa.allocated).toBeCloseTo(result.allocated, 6);
      expect(withDa.remaining).toBeCloseTo(result.remaining, 6);
    });

    it("out-of-scope rows are excluded", () => {
      const everyone = population().reduce((s, e) => s + e.calcBonus, 0);
      expect(result.pool).toBeLessThan(everyone);
    });

    it("a discretionary amount spends the pool: remaining falls by exactly the DA", () => {
      // The cap is measured from the STORED document, so it does not move when
      // a lead types and the whole grant lands on `allocated` — remaining falls
      // by exactly the amount granted, which is what makes a lead's own pool a
      // clean bound on their grants and what lets a redistribution converge in
      // one pass (lib/redistribute.ts).
      const target = mine.find((e) => !e.locked && !e.sm && e.vp + e.np > 0)!;
      const next = {
        ...overrides,
        [target.id]: { ...overrides[target.id], daEdit: 1_000 },
      };
      const withDa = managerPool(scope, data, next, overrides);
      expect(withDa.pool).toBeCloseTo(result.pool, 6);
      expect(withDa.allocated).toBeCloseTo(result.allocated + 1_000, 6);
      expect(withDa.remaining).toBeCloseTo(result.remaining - 1_000, 6);
      expect(withDa.people).toBe(result.people);
    });

    it("without a baseline the cap tracks the spending — which is why the baseline exists", () => {
      // With no allowance the cap IS the commitment, so measuring a what-if as
      // its own baseline moves the cap by the whole amount granted and
      // `remaining` never budges off nil. Gate 3 would then never fire and a
      // lead with no allowance could grant without limit. Pinned so the
      // baseline argument cannot be dropped as redundant.
      const target = mine.find((e) => !e.locked && !e.sm && e.vp + e.np > 0)!;
      const next = {
        ...overrides,
        [target.id]: { ...overrides[target.id], daEdit: 1_000 },
      };
      const drifted = managerPool(scope, data, next); // no baseline
      expect(drifted.pool - result.pool).toBeCloseTo(1_000, 6);
      expect(drifted.remaining).toBeCloseTo(0, 6);
      // and the properly-baselined figure refuses it, dollar for dollar
      expect(
        managerPool(scope, data, next, overrides).remaining
      ).toBeCloseTo(result.remaining - 1_000, 6);
    });

    it("managerPoolFrom agrees with managerPool on already-computed rows", () => {
      // the read path takes the cheaper one; they must not diverge
      expect(managerPoolFrom(scope.rule, population(), data)).toEqual(result);
    });

    it("pool and allocated are both stable under lock-neutral allocation math", () => {
      expect(Number.isFinite(result.pool)).toBe(true);
      expect(Number.isFinite(result.allocated)).toBe(true);
      expect(result.people).toBeGreaterThan(0);
    });

    // ── the gate ──

    it("blocks a save that worsens the current breach", () => {
      const target = mine.find((e) => !e.locked && !e.sm && e.vp + e.np > 0)!;
      const over = Math.ceil(result.remaining) + 10_000;
      const breach = poolBreach(
        scope,
        data,
        { ...overrides, [target.id]: { ...overrides[target.id], daEdit: over } },
        overrides
      );
      expect(breach).not.toBeNull();
      const baselineOver = Math.max(0, -result.remaining);
      expect(breach!.wasOver).toBeCloseTo(baselineOver, 6);
      expect(breach!.over).toBeGreaterThan(breach!.wasOver);
    });

    it("lets a save through when it reduces the current breach", () => {
      const target = mine.find((e) => !e.locked && !e.sm && e.vp + e.np > 0)!;
      const currentDa = overrides[target.id]?.daEdit ?? 0;
      const fits = currentDa - 5_000;
      const next = {
        ...overrides,
        [target.id]: { ...overrides[target.id], daEdit: fits },
      };
      expect(
        managerPool(scope, data, next, overrides).remaining
      ).toBeGreaterThan(result.remaining);
      expect(poolBreach(scope, data, next, overrides)).toBeNull();
    });

    it("re-saving the stored document unchanged is never refused", () => {
      // these are sums over ~150 seven-digit floats; accumulated noise must
      // not turn a no-op save into a refusal
      expect(poolBreach(scope, data, overrides, overrides)).toBeNull();
    });

    /**
     * WHY THE GROUP CAP STOPPED BINDING A LEAD, on the real numbers.
     *
     * scripts/import.ts defaults gCap to vCap + nCap, and this capture has that
     * identity exactly — so the group cap holds no room of its own, and Shared
     * Services (counted in the group total, but with no state cap of its own)
     * draws against the states' combined room dollar for dollar. The group
     * bound is therefore tighter than either state bound by the whole Shared
     * Services total, permanently. A lead is never sent gCap, so before
     * CapBound that figure refused grants their own Remaining said were
     * affordable, without ever telling them by how much.
     */
    it("the group cap holds no room of its own, and Shared Services consumes it", () => {
      const emps = population();
      const total = (st?: Employee["st"]) =>
        emps.reduce((s, e) => (!st || e.st === st ? s + e.finalBonus : s), 0);

      expect(data.gCap).toBeCloseTo(data.vCap + data.nCap, 6);

      const vicRoom = data.vCap - total("VIC");
      const nswRoom = data.nCap - total("NSW");
      const groupRoom = data.gCap - total();
      // the whole arithmetic in one line: the group has the states' combined
      // room LESS every dollar Shared Services holds
      expect(groupRoom).toBeCloseTo(vicRoom + nswRoom - total("SHARED"), 6);
      // and on this capture that makes it the tighter bound by a wide margin
      expect(total("SHARED")).toBeGreaterThan(0);
      expect(groupRoom).toBeLessThan(vicRoom);
      expect(groupRoom).toBeLessThan(nswRoom);
    });

    it("an NSW lead's ceiling matches their header, where the group cap refused it", () => {
      const nswLead: Scope = {
        ...scope,
        rule: { ...rule, type: "state", states: ["NSW"] } as typeof rule,
      };
      const p = managerPool(nswLead, data, overrides);
      const emps = population();
      const row = emps.find((e) => e.st === "NSW" && !e.locked && e.vp + e.np > 0)!;

      // what a lead is judged by now: their own Remaining, to the dollar
      expect(getMaxDA(row, emps, data, "state")).toBe(
        floorCents(p.remaining + row.daEdit)
      );
      // ...and what used to judge them, which their header could not show
      expect(getMaxDA(row, emps, data)).toBeLessThan(
        getMaxDA(row, emps, data, "state")
      );
    });
  }
);

/**
 * The gate's own rules, on a fixture small enough to check by hand. VIC-only,
 * cap 1000, two unlocked rows demanding 1000 between them — so the scale is
 * exactly 1, calcBonus equals bipm, and the pool starts exactly spent with no
 * headroom for a discretionary amount at all.
 */
describe("poolBreach", () => {
  function emp(over: Partial<Employee> & { id: string }): Employee {
    return {
      sn: "Surname",
      gn: "Given",
      pos: "Role",
      dept: "Dept",
      mgr: "Mgr",
      cat: "Employee",
      st: "VIC",
      vp: 1,
      np: 0,
      pkg: 4000,
      bp: 0.1,
      ipm: 1,
      bipm: 400,
      da: 0,
      f25: 0,
      sm: 0,
      ...over,
    };
  }
  const data: Dataset = {
    emp: [emp({ id: "A", bipm: 400 }), emp({ id: "B", bipm: 600, pkg: 6000 })],
    vCap: 1000,
    nCap: 1000,
    gCap: 2000,
    cats: ["Employee"],
    depts: ["Dept"],
    mgrs: ["Mgr"],
    excludedIds: [],
  };
  const lead: Scope = {
    email: "lead@texco.net.au",
    rule: {
      type: "state",
      states: ["VIC"],
      visibleFields: ["da", "final"],
      editableFields: ["da"],
      canLock: true,
      canActAs: [], canDownloadLetter: false,
    },
    canEdit: false,
    visibleFields: ["da", "final"],
    label: "VIC lead",
  };
  const admin: Scope = {
    email: "admin@texco.net.au",
    rule: { type: "full", canEditCaps: true, canEditVicSiteManagers: false, canRecalculatePool: false, canRevokeIssued: false, canActAs: [], canDownloadLetter: false },
    canEdit: true,
    visibleFields: ["da", "final"],
    label: "Admin",
  };

  it("the fixture starts exactly spent — pool equals allocated", () => {
    const p = managerPool(lead, data, {});
    // a VIC-only lead's pool IS vCap (25 Aug 2026); here the two rows demand
    // exactly that between them, so the cap starts exactly spent either way
    expect(p.pool).toBe(data.vCap);
    expect(p.pool).toBeCloseTo(1000, 8);
    expect(p.allocated).toBeCloseTo(1000, 8);
    expect(p.remaining).toBeCloseTo(0, 8);
  });

  /**
   * This gate is what bounds a redistribution, so `remaining` has to be a real
   * budget: every dollar written must land on `allocated`, and an amount must
   * move nobody else. Hand-checkable on this fixture — vCap 1000, A demands
   * 400, B demands 600, scale exactly 1.
   */
  it("an amount over the pool is refused, and moves nobody else", () => {
    const next: Overrides = { A: { daEdit: 200 } };
    const p = managerPool(lead, data, next);
    expect(p.allocated).toBeCloseTo(1200, 8);
    expect(p.remaining).toBeCloseTo(-200, 8);
    expect(poolBreach(lead, data, next, {})).not.toBeNull();
    // B was granted nothing and pays nothing — nobody funds anybody
    const rows = applyOverrides(data.emp, next);
    computeScalesAndBonuses(rows, data);
    expect(rows.find((r) => r.id === "B")!.finalBonus).toBeCloseTo(600, 8);
  });

  it("a redistribution that exactly spends the pool is allowed", () => {
    // the shape lib/redistribute.ts produces: the remaining, split across the
    // selected rows, landing allocated exactly on the pool
    expect(managerPool(lead, data, {}).remaining).toBeCloseTo(0, 8);
    const roomy = { ...data, vCap: 1200 };
    expect(Math.round(managerPool(lead, roomy, {}).remaining)).toBe(200);
    const next: Overrides = { A: { daEdit: 120 }, B: { daEdit: 80 } };
    expect(managerPool(lead, roomy, next).remaining).toBeCloseTo(0, 8);
    expect(poolBreach(lead, roomy, next, {})).toBeNull();
  });

  it("a whole-state lead's pool is the state cap, not what their rows demand", () => {
    // raise the cap and the lead's budget rises with it, though nobody's
    // entitlement moved — the whole point of the change
    const roomy: Dataset = { ...data, vCap: 1500, gCap: 2500 };
    const p = managerPool(lead, roomy, {});
    expect(p.pool).toBe(1500);
    expect(p.allocated).toBeCloseTo(1000, 8); // scale clamps at 1
    expect(p.remaining).toBeCloseTo(500, 8);
    // and that room is genuinely spendable now, where the entitlement
    // definition would have refused every dollar of it
    expect(poolBreach(lead, roomy, { A: { daEdit: 500 } }, {})).toBeNull();
    expect(poolBreach(lead, roomy, { A: { daEdit: 501 } }, {})).not.toBeNull();
  });

  /**
   * THE IDENTITY THE DISCRETIONARY CEILING RESTS ON.
   *
   * A lead's field is clamped in the browser against their own header
   * (DashboardClient's leadDaBounds: pool − what every OTHER row allocates),
   * because they hold no engine and no caps. /api/state's gate 4 then judges
   * the same figure with getMaxDA under CapBound "state". Those are two
   * different computations in two different processes, and if they ever
   * disagree a lead is either clamped below what they may have or accepted
   * into a refusal — which is exactly the bug this replaced.
   *
   * For a whole-state lead they are the same arithmetic, because their pool IS
   * the state cap and their rows ARE that state's rows. Pinned here so a change
   * to either definition breaks loudly.
   */
  it("a state lead's ceiling equals their Remaining plus the row's own amount", () => {
    const roomy: Dataset = { ...data, vCap: 1500, gCap: 2500 };
    const check = (doc: Overrides, id: string) => {
      const rows = applyOverrides(roomy.emp, doc);
      computeScalesAndBonuses(rows, roomy);
      const row = rows.find((e) => e.id === id)!;
      const p = managerPool(lead, roomy, doc);
      expect(getMaxDA(row, rows, roomy, "state")).toBe(
        floorCents(p.remaining + row.daEdit)
      );
    };
    check({}, "A");
    check({ A: { daEdit: 200 } }, "A"); // the row's own amount backed out
    check({ A: { daEdit: 200 } }, "B"); // and counted against everyone else
    check({ B: { locked: true, lockedFinal: 600 } }, "A");
  });

  it("a whole-state lead's pool nets the state's carve-out when the caps carry one (FY26)", () => {
    // the binding cap, not the total: vCap 1500 less a 300 carve
    const carved: Dataset = { ...data, vCap: 1500, gCap: 2500, vCarve: 300 };
    const p = managerPool(lead, carved, {});
    expect(p.pool).toBe(1200);
    expect(p.allocated).toBeCloseTo(1000, 8); // the scales ignore the carve
    expect(p.remaining).toBeCloseTo(200, 8);
    expect(poolBreach(lead, carved, { A: { daEdit: 200 } }, {})).toBeNull();
    expect(poolBreach(lead, carved, { A: { daEdit: 201 } }, {})).not.toBeNull();
    // the other state's carve is not this lead's business
    const other: Dataset = { ...data, vCap: 1500, gCap: 2500, nCarve: 999 };
    expect(managerPool(lead, other, {}).pool).toBe(1500);
  });

  it("the ceiling identity survives a carve-out: header and gate 4 net the same figure", () => {
    // Same identity as above, with the carve attached — this is what stops the
    // browser's header-based clamp and the server's capRoom drifting apart
    // once FY26's shared-services carve is netted (lib/fy26-caps.ts).
    const carved: Dataset = { ...data, vCap: 1500, gCap: 2500, vCarve: 300 };
    const check = (doc: Overrides, id: string) => {
      const rows = applyOverrides(carved.emp, doc);
      computeScalesAndBonuses(rows, carved);
      const row = rows.find((e) => e.id === id)!;
      const p = managerPool(lead, carved, doc);
      expect(getMaxDA(row, rows, carved, "state")).toBe(
        floorCents(p.remaining + row.daEdit)
      );
    };
    check({}, "A");
    check({ A: { daEdit: 200 } }, "A");
    check({ A: { daEdit: 200 } }, "B");
    check({ B: { locked: true, lockedFinal: 600 } }, "A");
  });

  it("a lead's pool IS the card headline under the real FY26 carves", () => {
    // The 25 Aug 2026 regression: a NSW lead's header read $1,220,209 while the
    // admin's card beside it headlined $1,194,970, because the carve attached
    // to the caps netted shared services only. Both figures now come from
    // statePoolOf, so the two views cannot quote different caps again.
    const real: Dataset = {
      ...data,
      vCap: FY26_PUBLISHED.VIC.totalCap,
      nCap: FY26_PUBLISHED.NSW.totalCap,
      gCap: FY26_PUBLISHED.groupCap,
    };
    const carved = attachFy26Carves(real);
    const nswLead: Scope = {
      ...lead,
      rule: { ...lead.rule, states: ["NSW"] } as typeof lead.rule,
    };
    expect(managerPool(lead, carved, {}).pool).toBeCloseTo(
      statePoolOf("VIC", real.vCap),
      8
    );
    expect(managerPool(nswLead, carved, {}).pool).toBeCloseTo(
      statePoolOf("NSW", real.nCap),
      8
    );
    // the anchors the stakeholder reads off the cards
    expect(managerPool(nswLead, carved, {}).pool).toBeCloseTo(1_194_970.16, 2);
  });

  it("a whole-state lead's Allocated leaves out a carve-funded row, who is still one of their people", () => {
    // P is VIC-labelled but on a split. They stay OUT of Allocated — the pool
    // is net of them — and since 28 Aug 2026 the carve doing that netting is
    // live, so the pool shrinks by exactly P's VIC share (0.9 of their payout)
    // rather than by a frozen constant. VIC is charged for P once, and for the
    // 0.9 of P it actually funds.
    const P = emp({ id: "P", vp: 0.9, np: 0.1, bipm: 300, pkg: 3000 });
    const carved: Dataset = { ...data, emp: [...data.emp, P], vCap: 1500, gCap: 2500 };
    const rows = applyOverrides(carved.emp, {});
    computeScalesAndBonuses(rows, carved);
    const final = (id: string) => rows.find((e) => e.id === id)!.finalBonus;
    const p = managerPool(lead, carved, {});
    expect(p.people).toBe(3);
    const pShare = final("P") * 0.9;
    expect(p.pool).toBeCloseTo(1500 - pShare, 8);
    expect(p.allocated).toBeCloseTo(final("A") + final("B"), 8);
    expect(p.remaining).toBeCloseTo(1500 - pShare - final("A") - final("B"), 8);
    // a grant to P moves nothing the pool measures, so gate 3 never refuses it
    expect(poolBreach(lead, carved, { P: { daEdit: 5_000 } }, {})).toBeNull();
    // while a grant to A is bounded exactly as before P existed
    const room = Math.floor(p.remaining);
    expect(poolBreach(lead, carved, { A: { daEdit: room } }, {})).toBeNull();
    expect(poolBreach(lead, carved, { A: { daEdit: room + 1 } }, {})).not.toBeNull();
  });

  it("the ceiling identity holds with a carve-funded row in scope, and that row has no state bound", () => {
    const P = emp({ id: "P", vp: 0.9, np: 0.1, bipm: 300, pkg: 3000 });
    const carved: Dataset = { ...data, emp: [...data.emp, P], vCap: 1500, gCap: 2500 };
    const check = (doc: Overrides, id: string) => {
      const rows = applyOverrides(carved.emp, doc);
      computeScalesAndBonuses(rows, carved);
      const row = rows.find((e) => e.id === id)!;
      const p = managerPool(lead, carved, doc);
      expect(getMaxDA(row, rows, carved, "state")).toBe(floorCents(p.remaining + row.daEdit));
    };
    check({}, "A");
    check({ A: { daEdit: 200 } }, "B");
    check({ P: { daEdit: 999 } }, "A"); // P's grant is invisible to A's ceiling
    const rows = applyOverrides(carved.emp, {});
    computeScalesAndBonuses(rows, carved);
    expect(getMaxDA(rows.find((e) => e.id === "P")!, rows, carved, "state")).toBe(Infinity);
  });

  it("a subset rule's cap is its commitments plus the admin's allowance, and a carve-funded row is in neither", () => {
    const P = emp({ id: "P", vp: 0.9, np: 0.1, bipm: 300, pkg: 3000 });
    const withP: Dataset = { ...data, emp: [...data.emp, P] };
    const subset: Scope = {
      ...lead,
      rule: {
        type: "subset",
        employeeIds: ["A", "P"],
        visibleFields: ["da", "final"],
        editableFields: ["da"],
        canLock: true,
        canActAs: [],
        canDownloadLetter: false,
      },
    };
    const rows = applyOverrides(withP.emp, {});
    computeScalesAndBonuses(rows, withP);
    const by = (id: string) => rows.find((e) => e.id === id)!;
    const p = managerPool(subset, withP, {});
    expect(p.people).toBe(2);
    // A is the only row the VIC pool funds here. P is in scope and counted in
    // `people`, but the split-state carve funds them, so they are in neither
    // the weight nor Allocated — charging them to VIC would bill it twice.
    expect(p.allocated).toBeCloseTo(by("A").finalBonus, 8);
    expect(by("P").finalBonus).toBeGreaterThan(0); // real money, funded elsewhere
    // no allowance granted: the cap is the commitment, so nothing new to spend
    expect(p.pool).toBeCloseTo(by("A").finalBonus, 8);
    expect(p.remaining).toBeCloseTo(0, 8);

    // with an allowance, the cap rises by exactly it and P is still out
    const withAllowance: Scope = {
      ...subset,
      rule: { ...subset.rule, allocationCap: by("A").finalBonus + 250 } as typeof subset.rule,
    };
    const q = managerPool(withAllowance, withP, {});
    expect(q.pool).toBeCloseTo(by("A").finalBonus + 250, 8);
    expect(q.allocated).toBeCloseTo(by("A").finalBonus, 8);
    expect(q.remaining).toBeCloseTo(250, 8);
  });

  it("several states sum their shares — and an empty state's pool is wholly a lead's who names it", () => {
    const both: Scope = {
      ...lead,
      rule: { ...lead.rule, type: "state", states: ["VIC", "NSW"] } as typeof lead.rule,
    };
    // The fixture has no NSW rows at all. This lead holds every row the NSW
    // pool funds — vacuously, all none of them — so its whole room is theirs,
    // and their VIC share is 1 the ordinary way.
    expect(managerPool(both, data, {}).pool).toBe(data.vCap + data.nCap);
    // whereas a scope that only reaches an empty state by accident gets no
    // claim on it: a subset names no state
    const subset: Scope = {
      ...lead,
      rule: {
        type: "subset",
        employeeIds: ["A"],
        visibleFields: ["da", "final"],
        editableFields: ["da"],
        canLock: true,
        canActAs: [],
        canDownloadLetter: false,
      },
    };
    expect(managerPool(subset, data, {}).pool).toBeLessThan(data.vCap);
  });

  it("a Shared Services payout is charged to both state budgets by its split", () => {
    const shared: Dataset = {
      ...data,
      emp: [...data.emp, emp({ id: "S", st: "SHARED", vp: 0.5, np: 0.5, bipm: 200 })],
    };
    const rule = { ...lead.rule, states: ["VIC", "SHARED"] } as typeof lead.rule;
    const both: Scope = { ...lead, rule };
    const emps = applyOverrides(shared.emp, {});
    computeScalesAndBonuses(emps, shared);
    const s = emps.find((e) => e.id === "S")!;
    expect(s.finalBonus).toBeGreaterThan(0);

    const p = managerPool(both, shared, {});
    // S is still on neither side of a state's ALLOCATED — adding their whole
    // entitlement there handed every SHARED-including lead the same room twice
    // (fixed 28 Aug 2026). What changed the same day is that the carve funding
    // S went live, so S is charged to each state POOL by their split: a 50/50
    // person takes half their payout out of VIC's budget and half out of NSW's.
    expect(p.pool).toBeCloseTo(shared.vCap - s.finalBonus * 0.5, 8);
    expect(p.allocated).toBeCloseTo(
      emps
        .filter((e) => e.st === "VIC")
        .reduce((acc, e) => acc + e.finalBonus, 0),
      8
    );
    expect(p.people).toBe(3); // still one of their people
    // and a VIC+SHARED lead and a NSW+SHARED lead no longer both book S
    const nswShared: Scope = {
      ...lead,
      rule: { ...lead.rule, states: ["NSW", "SHARED"] } as typeof lead.rule,
    };
    expect(managerPool(nswShared, shared, {}).pool).toBeCloseTo(
      shared.nCap - s.finalBonus * 0.5,
      8
    );
  });

  it("a group rule gets no room until an admin grants it, while a whole-state lead still gets the pool", () => {
    const group: Scope = {
      ...lead,
      rule: {
        type: "group",
        states: ["VIC"],
        positions: ["Role"],
        visibleFields: ["da", "final"],
        editableFields: ["da"],
        canLock: true,
        canActAs: [], canDownloadLetter: false,
      },
      label: "VIC group lead",
    };
    // B is moved out of the group's positions, so the group holds A alone of
    // the two rows the VIC pool funds
    const roomy: Dataset = {
      ...data,
      emp: [data.emp[0], { ...data.emp[1], pos: "Other Role" }],
      vCap: 1500,
      gCap: 2500,
    };
    const p = managerPool(group, roomy, {});
    expect(p.people).toBe(1);
    // Not the whole cap (a budget for people they are not accountable for) and
    // not a derived share either (which grew back after every save). Their
    // commitment, and nothing on top until somebody decides.
    expect(p.pool).toBeCloseTo(p.allocated, 8);
    expect(p.remaining).toBeCloseTo(0, 8);
    expect(p.pool).toBeLessThan(roomy.vCap);
    // the derived share is still computable, as the figure /admin suggests
    const rows = applyOverrides(roomy.emp, {});
    computeScalesAndBonuses(rows, roomy);
    expect(suggestedAllowance(group.rule, rows, roomy)).toBeGreaterThan(0);
    // a whole-state lead over the same data still gets the whole cap
    expect(managerPool(lead, roomy, {}).pool).toBe(roomy.vCap);
    expect(capIsStatePool(lead.rule)).toBe(true);
    expect(capIsStatePool(group.rule)).toBe(false);
  });

  it("blocks a save that goes over from a balanced start", () => {
    const breach = poolBreach(lead, data, { A: { daEdit: 2400 } }, {});
    expect(breach).toEqual({ over: 2400, wasOver: 0 });
  });

  it("blocks a save that makes an existing breach worse", () => {
    const breach = poolBreach(
      lead,
      data,
      { A: { daEdit: 3000 } },
      { A: { daEdit: 2400 } }
    );
    expect(breach).toEqual({ over: 3000, wasOver: 2400 });
  });

  it("allows a save that reduces an existing breach", () => {
    // the deadlock this rule exists to avoid: a lead who inherits an
    // over-pool state must be able to save the correction
    expect(
      poolBreach(lead, data, { A: { daEdit: 1100 } }, { A: { daEdit: 2400 } })
    ).toBeNull();
  });

  it("allows a save that leaves an existing breach exactly where it was", () => {
    expect(
      poolBreach(lead, data, { A: { daEdit: 2400 } }, { A: { daEdit: 2400 } })
    ).toBeNull();
  });

  it("a negative discretionary amount frees headroom for another row", () => {
    expect(
      poolBreach(lead, data, { A: { daEdit: 500 }, B: { daEdit: -500 } }, {})
    ).toBeNull();
  });

  it("never gates a full-access scope — an admin has no manager pool", () => {
    expect(poolBreach(admin, data, { A: { daEdit: 99_999 } }, {})).toBeNull();
  });

  it("tolerates sub-cent noise rather than refusing a no-op", () => {
    expect(
      poolBreach(lead, data, { A: { daEdit: 0.001 } }, {})
    ).toBeNull();
  });
});
/**
 * OVERLAPPING SCOPES — and why nothing is deducted for them.
 *
 * Jonathan Glick holds seven VIC positions, every one of which is also in Clint
 * Cassar's sixteen, so their shares of the VIC pool sum to more than 100% and
 * the same room is offered to both. For part of 28 August 2026 the inner
 * scope's rows were deducted from the outer one's budget. That was reverted
 * (owner decision, same day): a nested manager scope is a PERMISSION boundary,
 * not a reserved funding carve-out, and a lead is accountable for everyone
 * their grant authorises. These tests pin the reversal so the deduction cannot
 * creep back, and name what does the bounding instead — the state-level gate.
 *
 * Fixture: four VIC rows demanding 250 each, cap 1000, so the scale is exactly
 * 1 and each row is a clean quarter of the pool.
 */
describe("overlapping scopes", () => {
  function emp(over: Partial<Employee> & { id: string }): Employee {
    return {
      sn: "Surname",
      gn: "Given",
      pos: "Inner",
      dept: "Dept",
      mgr: "Mgr",
      cat: "Employee",
      st: "VIC",
      vp: 1,
      np: 0,
      pkg: 2500,
      bp: 0.1,
      ipm: 1,
      bipm: 250,
      da: 0,
      f25: 0,
      sm: 0,
      ...over,
    };
  }
  const data: Dataset = {
    emp: [
      emp({ id: "I1", pos: "Inner" }),
      emp({ id: "I2", pos: "Inner" }),
      emp({ id: "O1", pos: "Outer" }),
      emp({ id: "O2", pos: "Outer" }),
    ],
    vCap: 1000,
    nCap: 1000,
    gCap: 2000,
    cats: ["Employee"],
    depts: ["Dept"],
    mgrs: ["Mgr"],
    excludedIds: [],
  };
  const group = (positions: string[]): GrantingRule => ({
    type: "group",
    states: ["VIC"],
    positions,
    visibleFields: ["da", "final"],
    editableFields: ["da"],
    canLock: true,
    canActAs: [],
    canDownloadLetter: false,
  });
  const inner = group(["Inner"]);
  const outer = group(["Inner", "Outer"]);
  const scopeOf = (rule: GrantingRule): Scope => ({
    email: "lead@texco.net.au",
    rule,
    canEdit: false,
    visibleFields: ["da", "final"],
    label: "lead",
  });

  it("the outer lead's cap covers their FULL authorised scope, nested rows included", () => {
    const p = managerPool(scopeOf(outer), data, {});
    // all four rows are theirs, so all four are in the weight and in Allocated
    expect(p.people).toBe(4);
    expect(p.pool).toBe(data.vCap);
    expect(p.allocated).toBeCloseTo(1000, 8);
    // the deduction would have halved both — pinned so it cannot return
    expect(p.pool).not.toBeCloseTo(500, 2);
  });

  it("the inner lead keeps their own share, and the two overlap by design", () => {
    const o = managerPool(scopeOf(outer), data, {});
    const i = managerPool(scopeOf(inner), data, {});
    expect(i.pool).toBeCloseTo(500, 8);
    expect(i.people).toBe(2);
    // more than the pool between them, which is expected rather than a fault:
    // the inner rows are genuinely in both leads' remit
    expect(o.pool + i.pool).toBeGreaterThan(data.vCap);
  });

  it("gate 3 bounds each lead by their own allowance, and the state cap bounds them both", () => {
    // 1200 of cap against 1000 of committed demand: 200 of real room in the
    // pool. Give the inner lead an allowance of 100 out of it.
    const roomy: Dataset = { ...data, vCap: 1200, gCap: 2200 };
    const innerWith100 = scopeOf({ ...inner, allocationCap: 500 + 100 } as GrantingRule);
    expect(managerPool(scopeOf(outer), roomy, {}).remaining).toBeCloseTo(0, 8);
    expect(managerPool(innerWith100, roomy, {}).remaining).toBeCloseTo(100, 8);

    // each is bounded by their OWN allowance (gate 3)
    expect(poolBreach(innerWith100, roomy, { I1: { daEdit: 100 } }, {})).toBeNull();
    expect(
      poolBreach(innerWith100, roomy, { I1: { daEdit: 101 } }, {})
    ).not.toBeNull();

    // ...and the state pool is what stops the room being spent twice: once the
    // inner lead has taken 100, the whole state has only 100 left, and gate 4's
    // measure (lib/calc.ts's capRoom over every VIC payout) says so to the
    // outer lead whatever their own share allows.
    const spent = { I1: { daEdit: 100 } };
    const rows = applyOverrides(roomy.emp, spent);
    computeScalesAndBonuses(rows, roomy);
    const o1 = rows.find((e) => e.id === "O1")!;
    expect(getMaxDA(o1, rows, roomy, "state")).toBe(floorCents(100));
  });

  it("a Shared-Services-only grant has no state pool behind it, so nothing to spend until granted", () => {
    const shared: Dataset = {
      ...data,
      emp: [...data.emp, emp({ id: "S", st: "SHARED", vp: 0.5, np: 0.5 })],
    };
    const sharedOnly = scopeOf({
      type: "group",
      states: ["SHARED"],
      positions: ["Inner"],
      visibleFields: ["da", "final"],
      editableFields: ["da"],
      canLock: true,
      canActAs: [],
      canDownloadLetter: false,
    });
    const emps = applyOverrides(shared.emp, {});
    computeScalesAndBonuses(emps, shared);
    const s = emps.find((e) => e.id === "S")!;
    const p = managerPool(sharedOnly, shared, {});
    // No state pool funds anybody in this scope, so there is no room to divide
    // and nothing is charged to a state either. The pre-28-August entitlement
    // fallback is gone: an admin granting an allowance is a better answer than
    // a budget nobody chose. Nobody holds such a grant today.
    expect(p.people).toBe(1);
    expect(s.finalBonus).toBeGreaterThan(0); // real money, funded by the carve
    expect(p.pool).toBe(0);
    expect(p.allocated).toBe(0);
    expect(p.remaining).toBe(0);
  });
});
/**
 * THE ADMIN-SET ALLOWANCE (owner decision, 28 August 2026).
 *
 * A scoped lead's ceiling used to be derived — their share of whatever the
 * state pool had left — so it REGENERATED: spend it, save, reload, and the
 * arithmetic handed the whole allowance back. It is now a figure an admin sets
 * on the access rule (`allocationCap`, lib/access-rules.ts), and the derived
 * share survives only as the suggestion /admin offers beside the field.
 *
 * Fixture: four VIC rows demanding 250 each, cap set per test so the state's
 * room is exact and hand-checkable. The scale clamps at 1, so each committed
 * payout is exactly 250.
 */
describe("admin-set bonus allocation", () => {
  function emp(over: Partial<Employee> & { id: string }): Employee {
    return {
      sn: "Surname", gn: "Given", pos: "Inner", dept: "Dept", mgr: "Mgr",
      cat: "Employee", st: "VIC", vp: 1, np: 0, pkg: 2500, bp: 0.1, ipm: 1,
      bipm: 250, da: 0, f25: 0, sm: 0, ...over,
    };
  }
  /** vCap chosen so the VIC pool has exactly `room` left over 1000 of demand. */
  const dataWithRoom = (room: number): Dataset => ({
    emp: [
      emp({ id: "I1", pos: "Inner" }),
      emp({ id: "I2", pos: "Inner" }),
      emp({ id: "O1", pos: "Outer" }),
      emp({ id: "O2", pos: "Outer" }),
    ],
    vCap: 1000 + room,
    nCap: 1000,
    gCap: 5000,
    cats: ["Employee"], depts: ["Dept"], mgrs: ["Mgr"], excludedIds: [],
  });
  const group = (positions: string[], allocationCap?: number): GrantingRule => ({
    type: "group", states: ["VIC"], positions,
    visibleFields: ["da", "final"], editableFields: ["da"],
    canLock: true, canActAs: [], canDownloadLetter: false,
    ...(allocationCap === undefined ? {} : { allocationCap }),
  });
  const scopeOf = (rule: GrantingRule): Scope => ({
    email: "lead@texco.net.au", rule, canEdit: false,
    visibleFields: ["da", "final"], label: "lead",
  });
  const whole = scopeOf({
    type: "state", states: ["VIC"],
    visibleFields: ["da", "final"], editableFields: ["da"],
    canLock: true, canActAs: [], canDownloadLetter: false,
  });
  const measure = (d: Dataset, doc: Overrides = {}) => {
    const rows = applyOverrides(d.emp, doc);
    computeScalesAndBonuses(rows, d);
    return rows;
  };
  /** The two "Inner" rows: 500 of committed payout, half the state's demand. */
  const INNER_COMMITTED = 500;

  // ── 1. an admin can set it ──
  it("an allowance sets the cap to commitments plus that amount", () => {
    const d = dataWithRoom(200);
    const none = managerPool(scopeOf(group(["Inner"])), d, {});
    expect(none.allocated).toBeCloseTo(INNER_COMMITTED, 8);
    expect(none.pool).toBeCloseTo(INNER_COMMITTED, 8); // no room until granted
    expect(none.remaining).toBeCloseTo(0, 8);

    const granted = managerPool(
      scopeOf(group(["Inner"], INNER_COMMITTED + 150)), d, {}
    );
    expect(granted.pool).toBeCloseTo(INNER_COMMITTED + 150, 8);
    expect(granted.remaining).toBeCloseTo(150, 8);
  });

  // ── 2. it persists — a stored rule round-trips through the schema ──
  it("the allowance survives a store round trip and is not regenerated", () => {
    const stored = JSON.parse(
      JSON.stringify(group(["Inner"], 650))
    ) as unknown;
    const reparsed = AccessRuleSchema.parse(stored);
    if (reparsed.type === "full" || reparsed.type === "none") throw new Error();
    expect(reparsed.allocationCap).toBe(650);
    // and a rule stored before the field existed still parses, meaning "unset"
    const legacy = AccessRuleSchema.parse({
      type: "group", states: ["VIC"], positions: ["Inner"],
      visibleFields: ["da"], editableFields: ["da"],
    });
    if (legacy.type === "full" || legacy.type === "none") throw new Error();
    expect(legacy.allocationCap).toBeUndefined();
  });

  // ── 3 + 4. spending it consumes it, and it does not grow back ──
  it("spending $500 reduces Remaining by exactly $500, and a save+reload does not regenerate it", () => {
    const d = dataWithRoom(2_000);
    const lead = scopeOf(group(["Inner"], INNER_COMMITTED + 1_175));
    const start = managerPool(lead, d, {});
    expect(start.remaining).toBeCloseTo(1_175, 8);

    // spend 500, unsaved: the cap is measured from the stored document
    const spending: Overrides = { I1: { daEdit: 500 } };
    const mid = managerPool(lead, d, spending, {});
    expect(mid.pool).toBeCloseTo(start.pool, 8); // cap held still
    expect(mid.allocated).toBeCloseTo(start.allocated + 500, 8);
    expect(mid.remaining).toBeCloseTo(675, 8);

    // SAVE + RELOAD: the spend is now the stored document and is its own
    // baseline. The allowance must NOT come back.
    const afterReload = managerPool(lead, d, spending);
    expect(afterReload.pool).toBeCloseTo(start.pool, 8);
    expect(afterReload.allocated).toBeCloseTo(start.allocated + 500, 8);
    expect(afterReload.remaining).toBeCloseTo(675, 8);
    // the pre-28-August behaviour, for contrast: a derived share would have
    // handed back a fresh slice of the room every time
    expect(suggestedAllowance(lead.rule, measure(d, spending), d)).toBeGreaterThan(
      afterReload.remaining
    );
  });

  // ── 5 + 6. raising and lowering ──
  it("raising the allowance raises CAP and Remaining; lowering unused allowance lowers CAP", () => {
    const d = dataWithRoom(5_000);
    const at1175 = managerPool(scopeOf(group(["Inner"], INNER_COMMITTED + 1_175)), d, {});
    const at3000 = managerPool(scopeOf(group(["Inner"], INNER_COMMITTED + 3_000)), d, {});
    expect(at3000.pool - at1175.pool).toBeCloseTo(1_825, 8);
    expect(at3000.remaining).toBeCloseTo(3_000, 8);

    const at400 = managerPool(scopeOf(group(["Inner"], INNER_COMMITTED + 400)), d, {});
    expect(at400.pool).toBeLessThan(at1175.pool);
    expect(at400.remaining).toBeCloseTo(400, 8);
  });

  // ── 7. no fake historical overspend ──
  it("the cap can never land below commitments, so no fake overspend is created", () => {
    // The route derives the cap as allocated + allowance and the schema floors
    // the allowance at 0, so the cap is >= the commitment by construction.
    const zero = AccessRuleSchema.safeParse({ ...group(["Inner"]), allocationCap: -1 });
    expect(zero.success).toBe(false);

    const d = dataWithRoom(200);
    // even the smallest allowance leaves the commitment intact
    const p = managerPool(scopeOf(group(["Inner"], INNER_COMMITTED + 0)), d, {});
    expect(p.pool).toBeCloseTo(p.allocated, 8);
    expect(p.remaining).toBeCloseTo(0, 8);
    expect(p.remaining).toBeGreaterThanOrEqual(-EPSILON);
    // and a neutral save is still allowed while sitting exactly on the ceiling
    expect(poolBreach(scopeOf(group(["Inner"], INNER_COMMITTED)), d, {}, {})).toBeNull();
  });

  // ── 8. the admin bound ──
  it("an admin cannot reserve more than the state has left, and a lead's own reservation is not double-counted", () => {
    const d = dataWithRoom(5_675);
    const rows = measure(d);
    const inner = group(["Inner"], INNER_COMMITTED + 675); // 675 unused
    const outer = group(["Outer"]); // no reservation

    // Their own $675 is already inside stateRoom — a reservation is not a
    // payout — so it must NOT be subtracted as well. $5,000 genuinely
    // unreserved plus their own $675 means they may be raised to $5,675.
    expect(maxAdditionalAllocation(inner, [outer], rows, d)).toBeCloseTo(5_675, 8);

    // ...whereas somebody ELSE'S unused reservation is subtracted
    expect(maxAdditionalAllocation(outer, [inner], rows, d)).toBeCloseTo(5_000, 8);

    // and once the room is gone there is nothing more to reserve
    const tight = dataWithRoom(0);
    expect(
      maxAdditionalAllocation(group(["Inner"]), [], measure(tight), tight)
    ).toBeCloseTo(0, 8);
  });

  // ── 9. SHARED consumes no VIC allowance ──
  it("a SHARED-funded payout consumes VIC allowance by its split", () => {
    const base = dataWithRoom(200);
    const withShared: Dataset = {
      ...base,
      emp: [...base.emp, emp({ id: "S", pos: "Inner", st: "SHARED", vp: 0.5, np: 0.5 })],
    };
    const rule = { ...group(["Inner"], INNER_COMMITTED + 150), states: ["VIC", "SHARED"] } as GrantingRule;
    const before = managerPool(scopeOf(rule), base, {});
    const after = managerPool(scopeOf(rule), withShared, {});
    expect(after.people).toBe(before.people + 1); // theirs to manage
    expect(after.pool).toBeCloseTo(before.pool, 8);
    expect(after.allocated).toBeCloseTo(before.allocated, 8);
    expect(after.remaining).toBeCloseTo(before.remaining, 8);
    // A grant to the SHARED row still spends none of THIS scope's allowance —
    // their allocation is a figure Dee set, not a share of the state.
    const granted = managerPool(scopeOf(rule), withShared, { S: { daEdit: 5_000 } }, {});
    expect(granted.remaining).toBeCloseTo(after.remaining, 8);
    // ...but it does consume the state room an admin may still reserve out of
    // VIC, by S's VIC share — half of the 5,000 (28 Aug 2026). Before the carve
    // went live a shared grant cost the state nothing at all, which is how VIC
    // could be handed room it was not holding.
    expect(
      maxAdditionalAllocation(rule, [], measure(withShared, { S: { daEdit: 5_000 } }), withShared)
    ).toBeCloseTo(
      maxAdditionalAllocation(rule, [], measure(withShared), withShared) - 2_500,
      8
    );
  });

  // ── 10. nested scopes ──
  it("a nested manager scope is not deducted from the parent's funding scope", () => {
    const d = dataWithRoom(200);
    const outer = scopeOf(group(["Inner", "Outer"], 1_000 + 200));
    const p = managerPool(outer, d, {});
    expect(p.people).toBe(4); // every row is theirs
    expect(p.allocated).toBeCloseTo(1_000, 8); // including the inner lead's
    expect(p.remaining).toBeCloseTo(200, 8);
    // the inner lead's rows are NOT removed from the parent's allocation
    const inner = managerPool(scopeOf(group(["Inner"], INNER_COMMITTED)), d, {});
    expect(p.allocated).toBeGreaterThan(inner.allocated);
  });

  // ── 11. whole-state / admin unchanged ──
  it("a whole-state scope stays the authoritative state pool and ignores any allowance", () => {
    for (const room of [500, 200, 0]) {
      const d = attachFy26Carves(dataWithRoom(room + stateCarveOf("VIC")));
      const rows = measure(d);
      const p = managerPool(whole, d, {});
      expect(p.pool).toBeCloseTo(statePoolOf("VIC", d.vCap), 6);
      expect(p.allocated).toBeCloseTo(stateHomeTotal("VIC", rows), 8);
      expect(p.remaining).toBeCloseTo(stateRoom("VIC", rows, d)!, 6);
      // a stray allowance on a whole-state rule changes nothing
      const withStray = scopeOf({ ...whole.rule, allocationCap: 42 } as GrantingRule);
      expect(managerPool(withStray, d, {}).pool).toBeCloseTo(p.pool, 6);
      expect(capIsStatePool(whole.rule)).toBe(true);
    }
  });

  // ── 12. the state gate is still the final protection ──
  it("the state gate still refuses an overspend even when the allowance is higher", () => {
    // 200 of real room in VIC, but the lead has been granted 5,000
    const d = dataWithRoom(200);
    const lead = scopeOf(group(["Inner"], INNER_COMMITTED + 5_000));
    expect(managerPool(lead, d, {}).remaining).toBeCloseTo(5_000, 8);
    // their own gate would allow it...
    expect(poolBreach(lead, d, { I1: { daEdit: 1_000 } }, {})).toBeNull();
    // ...and gate 4, which measures the whole state, does not
    const rows = measure(d);
    expect(getMaxDA(rows.find((e) => e.id === "I1")!, rows, d, "state")).toBe(
      floorCents(200)
    );
    // once another lead has taken the room, there is none left for anybody
    const spent = measure(d, { O1: { daEdit: 200 } });
    expect(getMaxDA(spent.find((e) => e.id === "I1")!, spent, d, "state")).toBe(
      floorCents(0)
    );
    expect(stateRoom("VIC", spent, d)).toBeCloseTo(0, 8);
  });

  // ── 13. no side effects ──
  it("measuring the cap rewrites no lock and no payout", () => {
    const d = dataWithRoom(200);
    const doc: Overrides = {
      I1: { daEdit: 50, locked: true },
      O1: { locked: true, baseAmount: 250 },
    };
    const before = JSON.parse(JSON.stringify(doc));
    const rows = measure(d, doc);
    const snapshot = rows.map((e) => ({
      id: e.id, locked: e.locked, finalBonus: e.finalBonus, daEdit: e.daEdit,
    }));
    const lead = scopeOf(group(["Inner"], INNER_COMMITTED + 500));

    managerPool(lead, d, doc);
    managerPoolFrom(lead.rule, rows, d);
    poolBreach(lead, d, doc, doc);
    suggestedAllowance(lead.rule, rows, d);
    maxAdditionalAllocation(lead.rule, [], rows, d);

    expect(doc).toEqual(before);
    expect(
      rows.map((e) => ({
        id: e.id, locked: e.locked, finalBonus: e.finalBonus, daEdit: e.daEdit,
      }))
    ).toEqual(snapshot);
  });
});
