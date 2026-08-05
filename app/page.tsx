import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { scopeForUser } from "@/lib/access";
import { buildDashboardPayload } from "@/lib/scope";
import DashboardClient from "@/components/DashboardClient";

// Bland on purpose — browser tab titles end up in history and window lists.
export const metadata = { title: "Texco" };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect("/login"); // proxy already enforces this; belt-and-braces

  const scope = await scopeForUser(email);
  if (!scope) {
    console.log(
      `[audit] pageview email=${email} scope=NONE ts=${new Date().toISOString()}`
    );
    redirect("/no-access");
  }

  const payload = await buildDashboardPayload(scope, {
    name: session?.user?.name ?? email,
    email,
    scopeLabel: scope.label,
  });

  console.log(
    `[audit] pageview email=${email} scope=${scope.rule.type} rows=${
      payload.mode === "editor" ? payload.employees.length : payload.rows.length
    } ts=${new Date().toISOString()}`
  );

  return <DashboardClient payload={payload} />;
}
