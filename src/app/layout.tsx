import type { Metadata, Viewport } from "next";
import { HexField } from "../components/HexField";
import "./globals.css";

export const metadata: Metadata = {
  title: "Service Control",
  description: "Tap a switch. Everyone sees it.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#3b0d14",
  // `cover` lets the maroon run under the notch; the layout uses safe-area insets.
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <HexField />
        {children}
      </body>
    </html>
  );
}
