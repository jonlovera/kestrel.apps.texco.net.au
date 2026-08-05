import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { scopeForUser } from "@/lib/access";
import { loadSnapshots } from "@/lib/store";
import { restoreSnapshot } from "@/lib/snapshots";
import SnapshotList from "@/components/SnapshotList";

export const metadata = { title: "Texco" };
export const dynamic = "force-dynamic";

async function requireAdminPage() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect("/login");
  const scope = await scopeForUser(email);
  if (!scope) redirect("/no-access");
  if (!scope.canEdit) redirect("/");
  return email;
}

export default async function SnapshotsPage() {
  const email = await requireAdminPage();
  const snapshots = await loadSnapshots();

  async function restoreAction(formData: FormData) {
    "use server";
    // authorise independently — server actions don't inherit page checks
    const actor = await requireAdminPage();
    const ts = String(formData.get("ts") ?? "");
    await restoreSnapshot(ts, actor);
    revalidatePath("/");
    revalidatePath("/admin/snapshots");
  }

  console.log(
    `[audit] pageview page=admin/snapshots email=${email} ts=${new Date().toISOString()}`
  );

  return (
    <SnapshotList
      snapshots={snapshots.map((s) => ({
        ts: s.ts,
        actor: s.actor,
        reason: s.reason,
        employees: s.state.dataset.emp.length,
        overrides: Object.keys(s.state.overrides).length,
      }))}
      restoreAction={restoreAction}
    />
  );
}
