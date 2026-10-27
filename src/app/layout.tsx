import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { DisplaySync } from "@/components/display-sync";
import { demoMode } from "@/lib/deployment";
import { loadDisplay } from "@/server/display";
import "./globals.css";

const inter = localFont({
  src: "../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  weight: "100 900",
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Ray'z Barber Shop", template: "%s · Ray'z" },
  description: "Book at any Ray'z Barber Shop location.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#111318" };

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const display = await loadDisplay();
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body>
        <DisplaySync clockFormat={display.clockFormat} payrollHours={display.payrollHours} />
        {demoMode() && (
          <div role="note" className="bg-amber-300 px-4 py-1 text-center text-xs font-medium text-amber-950">
            Demo preview on sample data. Cards aren&apos;t charged, and no texts or emails are sent; see them under Notifications.
          </div>
        )}
        {children}
      </body>
    </html>
  );
}
