import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Spectral } from "next/font/google";
import "./globals.css";

const spectral = Spectral({
  variable: "--font-spectral",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  display: "swap",
});

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

// TODO(founder): set NEXT_PUBLIC_SITE_URL to the real domain before deploying,
// so Open Graph / Twitter image URLs resolve to absolute production URLs.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

const title = "Horos — the only-tighten safety layer for agent payments";
const description =
  "One call before your AI agent pays in USDC: allow, cap, hold or block, with a reason and a calibrated confidence. Horos writes a per-counterparty limit to a smart contract on Arc that the agent cannot exceed. Early access.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  applicationName: "Horos",
  keywords: [
    "agent payments",
    "USDC",
    "Arc",
    "counterparty screening",
    "AI agents",
    "x402",
    "MCP",
    "spending limits",
  ],
  openGraph: {
    type: "website",
    title,
    description,
    siteName: "Horos",
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#161c21" },
    { media: "(prefers-color-scheme: light)", color: "#edefec" },
  ],
};

// Runs before paint so a viewer who chose light never sees a dark flash.
const themeScript = `try{var t=localStorage.getItem("horos-theme");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t}}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-theme="dark"
      suppressHydrationWarning
      className={`${spectral.variable} ${plexSans.variable} ${plexMono.variable} antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
