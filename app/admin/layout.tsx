import Link from "next/link";
import { TexcoX, TexcoWordmark } from "@/components/TexcoBrand";
import AdminNav from "@/components/AdminNav";

/**
 * Chrome only. Layouts do NOT re-run on soft navigation, so no
 * authorisation happens here — every admin page, server action and route
 * handler authorises independently.
 */
export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <div className="flex min-h-screen flex-col">
      <div className="sticky top-0 z-40 flex items-center justify-between bg-[#191919] px-6 py-3">
        <div className="flex items-center">
          <TexcoX className="mr-2.5 h-[22px] w-[22px] shrink-0" />
          <TexcoWordmark className="mr-4 h-[18px] w-auto shrink-0" />
          <span className="hidden text-xs font-medium text-[#FC4D0F] sm:inline">
            Admin
          </span>
        </div>
        <Link
          href="/"
          className="border border-[#FC4D0F]/50 px-3.5 py-1.5 text-[11px] font-semibold tracking-wide text-[#F79470] transition-colors hover:bg-[#FC4D0F] hover:text-white"
        >
          Back to dashboard
        </Link>
      </div>
      <div className="mx-auto w-full max-w-[1100px]">
        <AdminNav />
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}
