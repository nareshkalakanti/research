import type { Metadata } from "next";
import { AuthProvider } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "Research · Theme",
  description: "India equities research — Theme",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
