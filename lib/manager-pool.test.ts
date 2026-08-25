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
import { applyOverrides, computeScalesAndBonuses, getMaxDA } from "./calc";
import { FY26_PUBLISHED, attachFy26Carves, statePoolOf } from "./fy26-caps";

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

    it("Allocated is exactly sum(finalBonus) over the in-scope rows", () => {
      const expected = mine.reduce((s, e) => s + e.finalBonus, 0);
      expect(result.allocated).toBeCloseTo(expected, 6);
    });

    it("the old VIC-card total is still a plain sum of VIC finals", () => {
      const oldCard = mine
        .filter((e) => e.st === "VIC")
        .reduce((s, e) => s + e.finalBonus, 0);
      const sharedInScope = mine
        .filter((e) => e.st === "SHARED")
        .reduce((s, e) => s + e.finalBonus, 0);
      expect(oldCard + sharedInScope).toBeCloseTo(result.allocated, 6);
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
      expect(managerPool(scope, data, next).remaining).toBeGreaterThan(result.remaining);
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
        Math.floor(p.remaining + row.daEdit)
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
    rule: { type: "full", canEditCaps: true, canEditVicSiteManagers: false, canActAs: [], canDownloadLetter: false },
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
        Math.floor(p.remaining + row.daEdit)
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
        Math.floor(p.remaining + row.daEdit)
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
    // P is VIC-labelled but on a split: funded by the split-state carve the
    // pool is already net of, so charging P's payout against the pool would
    // charge it twice (the four part-split staff since 24 Aug 2026)
    const P = emp({ id: "P", vp: 0.9, np: 0.1, bipm: 300, pkg: 3000 });
    const carved: Dataset = { ...data, emp: [...data.emp, P], vCap: 1500, gCap: 2500 };
    const rows = applyOverrides(carved.emp, {});
    computeScalesAndBonuses(rows, carved);
    const final = (id: string) => rows.find((e) => e.id === id)!.finalBonus;
    const p = managerPool(lead, carved, {});
    expect(p.people).toBe(3);
    expect(p.pool).toBe(1500);
    expect(p.allocated).toBeCloseTo(final("A") + final("B"), 8);
    expect(p.remaining).toBeCloseTo(1500 - final("A") - final("B"), 8);
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
      expect(getMaxDA(row, rows, carved, "state")).toBe(Math.floor(p.remaining + row.daEdit));
    };
    check({}, "A");
    check({ A: { daEdit: 200 } }, "B");
    check({ P: { daEdit: 999 } }, "A"); // P's grant is invisible to A's ceiling
    const rows = applyOverrides(carved.emp, {});
    computeScalesAndBonuses(rows, carved);
    expect(getMaxDA(rows.find((e) => e.id === "P")!, rows, carved, "state")).toBe(Infinity);
  });

  it("an entitlement-budgeted rule still counts a carve-funded row: its entitlement is in the pool", () => {
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
    expect(p.pool).toBeCloseTo(by("A").calcBonus + by("P").calcBonus, 8);
    expect(p.allocated).toBeCloseTo(by("A").finalBonus + by("P").finalBonus, 8);
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
        canActAs: [], canDownloadLetter: false,
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
