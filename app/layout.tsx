import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Stream Vy — Watch Movies & TV Shows",
    template: "%s — Stream Vy",
  },
  description: "High-end minimalist VOD streaming platform.",
  metadataBase: new URL("https://streamvy.me"),
  openGraph: {
    title: "Stream Vy — Watch Movies & TV Shows",
    description: "High-end minimalist VOD streaming platform.",
    url: "https://streamvy.me",
    siteName: "Stream Vy",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Stream Vy — Watch Movies & TV Shows",
    description: "High-end minimalist VOD streaming platform",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
