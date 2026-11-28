import type { Metadata } from "next";
import { AuthProvider } from "@/lib/auth";
import { Outfit } from "next/font/google";
import { THEME_BOOT } from "@/components/ThemeToggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "Research · India equities",
  description: "India equities research",
};

/** App font (clean geometric sans). Separate var so theme CSS can stack fallbacks. */
const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  display: "swap",
});

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
