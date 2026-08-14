import { describe, it, expect } from "vitest";
import {
  truncateIp,
  clientIpFrom,
  PageviewEntrySchema,
  AnonVisitEntrySchema,
} from "./pageviews";

describe("truncateIp", () => {
  it("zeroes the last IPv4 octet", () => {
    expect(truncateIp("203.45.67.89")).toBe("203.45.67.0");
  });

  it("zeroes the trailing IPv6 groups", () => {
    expect(truncateIp("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe("2001:db8:85a3::");
  });

  it("leaves an unrecognised value as-is rather than guessing", () => {
    expect(truncateIp("not-an-ip")).toBe("not-an-ip");
  });

  it("handles a compressed short address (e.g. loopback) without doubling colons", () => {
    expect(truncateIp("::1")).toBe("1::");
  });
});

describe("clientIpFrom", () => {
  it("reads the first hop of x-forwarded-for", () => {
    const headers = new Headers({ "x-forwarded-for": "203.45.67.89, 10.0.0.1" });
    expect(clientIpFrom(headers)).toBe("203.45.67.89");
  });

  it("returns null when the header is absent", () => {
    expect(clientIpFrom(new Headers())).toBeNull();
  });
});

describe("PageviewEntrySchema / AnonVisitEntrySchema", () => {
  it("accepts a well-formed signed-in page view", () => {
    const parsed = PageviewEntrySchema.safeParse({
      ts: "2026-08-14T00:00:00.000Z",
      path: "/admin/visitors",
      email: "jlovera@texco.net.au",
      name: "Jose Lovera",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an anonymous visit with a null ipPrefix", () => {
    const parsed = AnonVisitEntrySchema.safeParse({
      ts: "2026-08-14T00:00:00.000Z",
      path: "/",
      ipPrefix: null,
    });
    expect(parsed.success).toBe(true);
  });
});
