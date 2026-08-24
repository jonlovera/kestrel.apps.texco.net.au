import { describe, it, expect } from "vitest";
import {
  previewLoginEnabled,
  checkPreviewPassword,
  devConvenienceLoginEnabled,
} from "./preview-login";

/**
 * The environment is mutated per test and restored in a finally, the same
 * pattern lib/admin-gate.test.ts uses for ADMIN_PASSWORD — these functions
 * read process.env fresh on every call rather than caching it, which is what
 * makes that enough.
 *
 * VERCEL_ENV is the variable under test as much as the password is: a Vercel
 * preview builds with NODE_ENV === "production", so gating on NODE_ENV (as
 * the old dev login did) is exactly the bug this module exists to avoid.
 */
type Env = {
  password?: string;
  vercelEnv?: string;
  nodeEnv?: string;
  devLogin?: string;
};

function withEnv(env: Env, run: () => void) {
  const keys = {
    password: "PREVIEW_LOGIN_PASSWORD",
    vercelEnv: "VERCEL_ENV",
    nodeEnv: "NODE_ENV",
    devLogin: "DEV_LOGIN",
  } as const;
  // NODE_ENV is typed read-only on ProcessEnv, hence the mutable view.
  const bag = process.env as Record<string, string | undefined>;
  const original: Record<string, string | undefined> = {};
  try {
    for (const [field, key] of Object.entries(keys)) {
      original[key] = bag[key];
      const value = env[field as keyof Env];
      if (value === undefined) delete bag[key];
      else bag[key] = value;
    }
    run();
  } finally {
    for (const key of Object.values(keys)) {
      if (original[key] === undefined) delete bag[key];
      else bag[key] = original[key];
    }
  }
}

const PASSWORD = "preview-shared-2026";

describe("previewLoginEnabled", () => {
  it("is off when no password is configured", () => {
    withEnv({ vercelEnv: "preview" }, () => {
      expect(previewLoginEnabled()).toBe(false);
    });
  });

  it("is off in production even with a password configured", () => {
    // The regression this guards: the variable being created for the
    // production target by mistake must not open a password door there.
    withEnv({ password: PASSWORD, vercelEnv: "production" }, () => {
      expect(previewLoginEnabled()).toBe(false);
    });
  });

  it("is on for a Vercel preview with a password configured", () => {
    withEnv({ password: PASSWORD, vercelEnv: "preview" }, () => {
      expect(previewLoginEnabled()).toBe(true);
    });
  });

  it("is on locally, where VERCEL_ENV does not exist at all", () => {
    withEnv({ password: PASSWORD }, () => {
      expect(previewLoginEnabled()).toBe(true);
    });
  });

  it("treats an empty password as unconfigured", () => {
    withEnv({ password: "", vercelEnv: "preview" }, () => {
      expect(previewLoginEnabled()).toBe(false);
    });
  });
});

describe("checkPreviewPassword", () => {
  it("accepts the configured password", () => {
    withEnv({ password: PASSWORD, vercelEnv: "preview" }, () => {
      expect(checkPreviewPassword(PASSWORD)).toBe(true);
    });
  });

  it("rejects anything else", () => {
    withEnv({ password: PASSWORD, vercelEnv: "preview" }, () => {
      expect(checkPreviewPassword("wrong")).toBe(false);
      expect(checkPreviewPassword("")).toBe(false);
      // length-mismatch path, and a near miss of the same length
      expect(checkPreviewPassword(`${PASSWORD} `)).toBe(false);
      expect(checkPreviewPassword(PASSWORD.slice(0, -1) + "X")).toBe(false);
    });
  });

  it("fails closed when no password is configured", () => {
    withEnv({ vercelEnv: "preview" }, () => {
      expect(checkPreviewPassword("")).toBe(false);
      expect(checkPreviewPassword("anything")).toBe(false);
    });
  });

  it("fails closed in production even given the correct password", () => {
    withEnv({ password: PASSWORD, vercelEnv: "production" }, () => {
      expect(checkPreviewPassword(PASSWORD)).toBe(false);
    });
  });
});

describe("devConvenienceLoginEnabled", () => {
  it("needs development, the opt-in flag, and a password", () => {
    withEnv({ password: PASSWORD, nodeEnv: "development", devLogin: "1" }, () => {
      expect(devConvenienceLoginEnabled()).toBe(true);
    });
  });

  it("is off without the opt-in flag", () => {
    withEnv({ password: PASSWORD, nodeEnv: "development" }, () => {
      expect(devConvenienceLoginEnabled()).toBe(false);
    });
  });

  it("is off without a password, so the GET shortcut cannot outlive the form", () => {
    withEnv({ nodeEnv: "development", devLogin: "1" }, () => {
      expect(devConvenienceLoginEnabled()).toBe(false);
    });
  });

  it("is off outside development, which is what a preview build is", () => {
    withEnv(
      {
        password: PASSWORD,
        nodeEnv: "production",
        devLogin: "1",
        vercelEnv: "preview",
      },
      () => {
        expect(devConvenienceLoginEnabled()).toBe(false);
      }
    );
  });
});
