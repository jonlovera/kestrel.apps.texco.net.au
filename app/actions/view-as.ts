"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { startViewAs, stopViewAs } from "@/lib/view-as-users";

/**
 * Server actions behind the View as control. Both re-authorise inside
 * lib/view-as-users.ts rather than trusting the caller.
 */
export async function beginViewAs(formData: FormData) {
  await startViewAs(String(formData.get("email") ?? ""));
  revalidatePath("/");
  redirect("/");
}

export async function endViewAs() {
  await stopViewAs();
  revalidatePath("/");
  redirect("/");
}
