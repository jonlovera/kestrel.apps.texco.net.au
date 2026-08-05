import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FY26 Employee Bonus Scheme — Texco",
  description: "Confidential — Texco FY26 employee bonus scheme model",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-[#f5f5f5] text-[#191919]">
        {children}
      </body>
    </html>
  );
}
