import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { Sidebar } from "@/components/layout/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/layout/theme-provider";

const font = Plus_Jakarta_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Renting Freedom Dashboard",
  description: "Property and lockbox management for Renting Freedom",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${font.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="h-full flex bg-gray-50 dark:bg-gray-950 font-sans">
        <ClerkProvider afterSignOutUrl="/sign-in">
          <ThemeProvider>
            <Sidebar />
            <main className="flex-1 flex flex-col min-h-full overflow-x-hidden">
              {children}
            </main>
            <Toaster richColors position="top-right" />
          </ThemeProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
