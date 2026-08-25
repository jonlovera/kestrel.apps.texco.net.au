/**
 * Stands in for the `server-only` marker package under vitest — see the alias
 * in vitest.config.ts for why. Deliberately empty: the real package's whole
 * job is to fail the BUILD when a client component imports it, which Next
 * still does. Nothing should ever import this file directly.
 */
export {};
