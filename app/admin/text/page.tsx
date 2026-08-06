import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { scopeForUser } from "@/lib/access";
import { loadCopy, saveCopy, appendHistory } from "@/lib/store";
import { takeSnapshot } from "@/lib/snapshots";
import { CopySchema, DEFAULT_COPY } from "@/lib/copy";
import CopyEditor from "@/components/CopyEditor";

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

export default async function TextPage() {
  const email = await requireAdminPage();
  const copy = await loadCopy();

  async function saveAction(formData: FormData) {
    "use server";
    const actor = await requireAdminPage(); // authorise independently

    const raw = {
      schemeName: String(formData.get("schemeName") ?? ""),
      bannerText: String(formData.get("bannerText") ?? ""),
      bannerVisible: formData.get("bannerVisible") === "on",
      poolTitles: {
        vic: String(formData.get("poolVic") ?? ""),
        nsw: String(formData.get("poolNsw") ?? ""),
        group: String(formData.get("poolGroup") ?? ""),
      },
      footerText: String(formData.get("footerText") ?? ""),
    };
    const parsed = CopySchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        parsed.error.issues
          .map((i) => `${i.path.join(".") || "value"}: ${i.message}`)
          .join("; ")
      );
    }

    await takeSnapshot(actor, "copy");
    await saveCopy(parsed.data);
    await appendHistory([
      {
        ts: new Date().toISOString(),
        actor,
        kind: "copy",
        summary: `Changed dashboard wording (scheme name "${parsed.data.schemeName}", banner ${
          parsed.data.bannerVisible ? `"${parsed.data.bannerText}"` : "hidden"
        })`,
      },
    ]);
    console.log(`[audit] copy-change by=${actor} ts=${new Date().toISOString()}`);
    revalidatePath("/");
    revalidatePath("/admin/text");
  }

  async function resetAction() {
    "use server";
    const actor = await requireAdminPage();
    await takeSnapshot(actor, "copy");
    await saveCopy(DEFAULT_COPY);
    await appendHistory([
      {
        ts: new Date().toISOString(),
        actor,
        kind: "copy",
        summary: "Reset dashboard wording to the defaults",
      },
    ]);
    console.log(`[audit] copy-reset by=${actor} ts=${new Date().toISOString()}`);
    revalidatePath("/");
    revalidatePath("/admin/text");
  }

  console.log(
    `[audit] pageview page=admin/text email=${email} ts=${new Date().toISOString()}`
  );

  return (
    <CopyEditor
      initial={copy}
      defaults={DEFAULT_COPY}
      saveAction={saveAction}
      resetAction={resetAction}
    />
  );
}
