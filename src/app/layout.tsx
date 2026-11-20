import type { Metadata } from "next";
import { AuthProvider } from "@/lib/auth";
import { Outfit } from "next/font/google";
import { THEME_BOOT } from "@/components/ThemeToggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "Research · Theme",
  description: "India equities research — Theme",
};

/** App font (clean geometric sans) — sets --font-sans used across globals.css. */
const outfit = Outfit({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`h-full ${outfit.variable}`} data-theme="dark" suppressHydrationWarning>
      <head>
        {/* Saved light/dark choice applied before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="min-h-full antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
