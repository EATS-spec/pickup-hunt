import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pickup Hunt — good phones, worth the hunt",
  description: "Pick your iPhone, choose your Apple Stores, and make a little hunt of it. Pickup Hunt keeps an eye on online pickup availability in the cloud.",
  icons: { icon: "/favicon.svg", apple: "/apple-touch-icon.png" },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Pickup Hunt", statusBarStyle: "default" },
  openGraph: {
    title: "Pickup Hunt — good phones, worth the hunt",
    description: "A little phone finder. Pick your prize, choose your stores, and share the hunt.",
    type: "website",
  },
};

export const viewport: Viewport = { themeColor: "#f5f2e9" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
