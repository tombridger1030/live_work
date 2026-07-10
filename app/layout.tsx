import "@heroui/styles/css";
import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { TopNav } from "@/components/TopNav";
import "./globals.css";

export const metadata: Metadata = {
  title: "tally",
  description: "Public desk-presence accountability status."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${GeistSans.className} dark`}>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <TopNav />
        {children}
      </body>
    </html>
  );
}
