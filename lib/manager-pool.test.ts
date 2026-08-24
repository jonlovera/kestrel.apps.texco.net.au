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
 * figures use the entitlement definition of `pool` rather than a state cap —
 * see lib/manager-pool.ts. The state-cap case is covered separately below.
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
import { DatasetSchema, OverridesSchema } from "./schema";
import type { Dataset, Employee, Overrides } from "./schema";
import { ParamsSchema, applyParams } from "./params-apply";
import type { Scope } from "./access";
import { managerPool, managerPoolFrom, poolBreach } from "./manager-pool";
import { applyOverrides, computeScalesAndBonuses } from "./calc";

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

    it("Allocated reproduces the dashboard's bottom-right total to the cent", () => {
      // the $1,082,112 the stakeholder quoted — sum of finals over all 57
      expect(result.allocated).toBeCloseTo(1_082_111.79, 1);
    });

    it("documents the old mislabelled card: 'VIC pool' was a sum of finals", () => {
      // the $1,033,047 card was finalBonus over the 56 in-scope VIC rows —
      // a totals figure, never a pool. The $49,065 gap to Allocated is
      // exactly the one in-scope SHARED row's frozen final.
      const oldCard = mine
        .filter((e) => e.st === "VIC")
        .reduce((s, e) => s + e.finalBonus, 0);
      expect(oldCard).toBeCloseTo(1_033_046.79, 1);
    });

    // ── the composition, knob by knob ──

    it("pool is Σ calcBonus over exactly the rows the scope filter admits", () => {
      const expected = mine.reduce((s, e) => s + e.calcBonus, 0);
      expect(result.pool).toBe(expected);
      // and it is a pool, not a total: calcBonus, never finalBonus
      expect(result.pool).not.toBeCloseTo(result.allocated, 2);
    });

    it("locked rows are INCLUDED — they still draw from their manager's pool", () => {
      const locked = mine.filter((e) => e.locked);
      const unlocked = mine.filter((e) => !e.locked);
      // a real share of this scope, so the assertion has teeth
      expect(locked.length).toBeGreaterThan(20);

      const lockedDraw = locked.reduce((s, e) => s + e.calcBonus, 0);
      const unlockedDraw = unlocked.reduce((s, e) => s + e.calcBonus, 0);
      expect(result.pool).toBeCloseTo(unlockedDraw + lockedDraw, 6);
      // excluding them is the misreading that halves the cap
      expect(unlockedDraw).toBeLessThan(result.pool * 0.6);
    });

    it("shared services are excluded by the SCOPE, not by a state filter", () => {
      // 24 of the 25 SHARED rows never reach this sum because the access rule
      // doesn't admit them. The 25th (Peter Clements) does, and is counted —
      // a split is a statement about which caps fund someone, not a reason to
      // drop their draw from the pool their manager answers for. The fixture
      // is a 21 Aug 2026 capture, taken while he was still flagged SHARED.
      const sharedInScope = mine.filter((e) => e.st === "SHARED");
      const sharedAtLarge = population().filter((e) => e.st === "SHARED");
      expect(sharedInScope).toHaveLength(1);
      expect(sharedAtLarge.length).toBeGreaterThan(sharedInScope.length);

      const stateFiltered = mine
        .filter((e) => e.st !== "SHARED")
        .reduce((s, e) => s + e.calcBonus, 0);
      expect(result.pool - stateFiltered).toBeCloseTo(
        sharedInScope[0].calcBonus,
        6
      );
      expect(result.pool).not.toBeCloseTo(stateFiltered, 2);
    });

    it("out-of-scope rows are excluded", () => {
      const everyone = population().reduce((s, e) => s + e.calcBonus, 0);
      expect(result.pool).toBeLessThan(everyone);
    });

    it("a discretionary amount spends the pool: remaining falls by exactly the DA", () => {
      // 25 Aug 2026 reversal to DA-on-top: the DA moves no scale, so the pool
      // itself (Σ calcBonus in scope) does not move at all and the whole grant
      // lands on `allocated` — remaining falls by exactly the amount granted,
      // which is what makes a lead's own pool a clean bound on their grants.
      const target = mine.find((e) => !e.locked && !e.sm && e.vp + e.np > 0)!;
      const withDa = managerPool(scope, data, {
        ...overrides,
        [target.id]: { ...overrides[target.id], daEdit: 1_000 },
      });
      expect(withDa.pool).toBeCloseTo(result.pool, 6);
      expect(withDa.allocated).toBeCloseTo(result.allocated + 1_000, 6);
      expect(withDa.remaining).toBeCloseTo(result.remaining - 1_000, 6);
      expect(withDa.people).toBe(result.people);
    });

    it("managerPoolFrom agrees with managerPool on already-computed rows", () => {
      // the read path takes the cheaper one; they must not diverge
      expect(managerPoolFrom(scope.rule, population(), data)).toEqual(result);
    });

    it("resolves Clint's cap to $1,087,114 on this fixture", () => {
      // The CFO's sheet showed $1,091,427. The $4,313 gap is attributed to
      // lock drift — rows locked or re-locked between her extract and this
      // capture — pending her confirmation. The composition tests above are
      // the real contract; this is a reconciliation anchor and will move when
      // the locks do.
      expect(Math.round(result.pool)).toBe(1_087_114);
    });

    // ── the gate ──

    it("blocks a save that spends headroom the manager doesn't have", () => {
      const target = mine.find((e) => !e.locked && !e.sm && e.vp + e.np > 0)!;
      const over = Math.ceil(result.remaining) + 10_000;
      const breach = poolBreach(
        scope,
        data,
        { ...overrides, [target.id]: { ...overrides[target.id], daEdit: over } },
        overrides
      );
      expect(breach).not.toBeNull();
      expect(breach!.wasOver).toBe(0);
      // Under the pool-funded DA model the breach is AT LEAST the naive
      // overspend — the in-scope locked rows' live calc shrinks with the
      // scale, widening it further (see lib/manager-pool.ts's header note).
      expect(breach!.over).toBeGreaterThanOrEqual(over - result.remaining - 0.01);
    });

    it("lets a save through while it still fits inside the pool", () => {
      const target = mine.find((e) => !e.locked && !e.sm && e.vp + e.np > 0)!;
      // The effective DA headroom is less than `remaining` now: each DA
      // dollar also shrinks the in-scope locked rows' live calc (pool side)
      // while their frozen finals stay. remaining(X) is affine in X while
      // the scale stays unclamped, so two probes solve the true headroom.
      const probe = (daEdit: number) =>
        managerPool(scope, data, {
          ...overrides,
          [target.id]: { ...overrides[target.id], daEdit },
        }).remaining;
      const r1 = probe(1_000);
      const r2 = probe(2_000);
      const perDollar = (r1 - r2) / 1_000; // total remaining cost of one DA dollar
      const headroom = 1_000 + r1 / perDollar; // where remaining crosses 0
      const fits = Math.floor(headroom * 0.95);
      expect(fits).toBeGreaterThan(0); // there is genuinely headroom here
      const next = {
        ...overrides,
        [target.id]: { ...overrides[target.id], daEdit: fits },
      };
      expect(managerPool(scope, data, next).remaining).toBeGreaterThan(0);
      expect(poolBreach(scope, data, next, overrides)).toBeNull();
    });

    it("re-saving the stored document unchanged is never refused", () => {
      // these are sums over ~150 seven-digit floats; accumulated noise must
      // not turn a no-op save into a refusal
      expect(poolBreach(scope, data, overrides, overrides)).toBeNull();
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
      canActAs: [],
    },
    canEdit: false,
    visibleFields: ["da", "final"],
    label: "VIC lead",
  };
  const admin: Scope = {
    email: "admin@texco.net.au",
    rule: { type: "full", canEditCaps: true, canActAs: [] },
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

  it("several states sum their caps", () => {
    const both: Scope = {
      ...lead,
      rule: { ...lead.rule, type: "state", states: ["VIC", "NSW"] } as typeof lead.rule,
    };
    expect(managerPool(both, data, {}).pool).toBe(data.vCap + data.nCap);
  });

  it("Shared Services has no cap, so those rows fall back to their entitlement", () => {
    const shared: Dataset = {
      ...data,
      emp: [...data.emp, emp({ id: "S", st: "SHARED", vp: 0.5, np: 0.5, bipm: 200 })],
    };
    const rule = { ...lead.rule, states: ["VIC", "SHARED"] } as typeof lead.rule;
    const both: Scope = { ...lead, rule };
    const emps = applyOverrides(shared.emp, {});
    computeScalesAndBonuses(emps, shared);
    const sCalc = emps.find((e) => e.id === "S")!.calcBonus;
    expect(sCalc).toBeGreaterThan(0);
    expect(managerPool(both, shared, {}).pool).toBeCloseTo(shared.vCap + sCalc, 8);
  });

  it("a group rule keeps the entitlement definition — a state cap is not its budget", () => {
    const group: Scope = {
      ...lead,
      rule: {
        type: "group",
        states: ["VIC"],
        positions: ["Role"],
        visibleFields: ["da", "final"],
        editableFields: ["da"],
        canLock: true,
        canActAs: [],
      },
      label: "VIC group lead",
    };
    const roomy: Dataset = { ...data, vCap: 1500, gCap: 2500 };
    const p = managerPool(group, roomy, {});
    expect(p.pool).not.toBe(roomy.vCap);
    expect(p.pool).toBeCloseTo(p.allocated, 8); // entitlement, so no free room
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
