import { z } from "zod";

/**
 * Shape of the identity-user document, in its own module so the store and the
 * server-only logic can both import it without a cycle — the same split
 * lib/columns.ts and lib/copy.ts already use.
 */
export const IdentityUserSchema = z.object({
  email: z.string(),
  name: z.string().optional(),
  /** bumped by identity's webhooks; a mismatch ends every session they hold */
  epoch: z.number().int().min(0),
});
export type IdentityUser = z.infer<typeof IdentityUserSchema>;

/** Keyed by m365_id — the stable Entra object id, which survives an email change. */
export const IdentityUsersSchema = z.record(z.string(), IdentityUserSchema);
export type IdentityUsers = z.infer<typeof IdentityUsersSchema>;
