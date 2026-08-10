import { redirect } from "next/navigation";
import { resolveViewer } from "@/lib/view-as";

export const dynamic = "force-dynamic";

/** /admin lands on the first section; authorises like every admin page. */
export default async function AdminIndex() {
  const { actor, scope } = await resolveViewer();
  if (!actor) redirect("/login");
  if (!scope) redirect("/no-access");
  if (!scope.canEdit) redirect("/");
  redirect("/admin/access");
}
