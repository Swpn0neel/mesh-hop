import type { Metadata, Viewport } from "next";
import { Azeret_Mono, Onest } from "next/font/google";
import "./globals.css";

const onest = Onest({
  variable: "--font-onest",
  subsets: ["latin"],
  weight: "variable",
  display: "swap",
});

const azeretMono = Azeret_Mono({
  variable: "--font-azeret",
  subsets: ["latin"],
  weight: "variable",
  display: "swap",
});

export const metadata: Metadata = {
  title: "MeshHop — A working exit, earned.",
  description:
    "MeshHop discovers, measures, and verifies public proxy exits before opening a dedicated routed browser on Windows.",
  applicationName: "MeshHop",
  keywords: ["public proxy", "Windows", "proxy testing", "routed browser", "MeshHop"],
  authors: [{ name: "MeshHop" }],
  icons: {
    icon: "/meshhop-logo.png",
    shortcut: "/meshhop-logo.png",
  },
  openGraph: {
    title: "MeshHop — A working exit, earned.",
    description: "Discover. Measure. Verify. Route. A calmer way to find a working public exit.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "MeshHop — A working exit, earned.",
    description: "Public exits tested before your browser opens.",
  },
};

export const viewport: Viewport = {
  themeColor: "#0c0e12",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${onest.variable} ${azeretMono.variable} h-full antialiased`}>
      <head>
        <noscript>
          <style>{`
            .app-showcase,
            .pipeline-instrument,
            .scoreboard {
              opacity: 1 !important;
              visibility: visible !important;
            }
          `}</style>
        </noscript>
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
