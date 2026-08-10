import type { Metadata } from "next";
import "./globals.css";

// Deliberately bland: unauthenticated surfaces (login, no-access, 404) must
// not reveal what this application is.
export const metadata: Metadata = {
  title: "Texco",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-surface-sunken text-brand-95">
        {children}
      </body>
    </html>
  );
}
