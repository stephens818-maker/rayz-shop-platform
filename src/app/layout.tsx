import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Ray'z Barber Shop", template: "%s · Ray'z" },
  description: "Book at any of Ray'z Barber Shop's locations in Iowa and Illinois.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#111318" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
