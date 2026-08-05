import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { scopeForUser } from "@/lib/access";

export const dynamic = "force-dynamic";

/** /admin lands on the first section; authorises like every admin page. */
export default async function AdminIndex() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect("/login");
  const scope = await scopeForUser(email);
  if (!scope) redirect("/no-access");
  if (!scope.canEdit) redirect("/");
  redirect("/admin/access");
}
