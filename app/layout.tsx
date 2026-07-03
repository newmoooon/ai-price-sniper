import type { Metadata } from "next";
import { Fraunces, Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

// The theme's `font-sans` token resolves to `--font-sans`, so the font must
// register under exactly that name — otherwise the whole app silently falls
// back to the browser's serif default.
const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Display serif for headlines — the soft-luxury editorial voice. The theme
// maps `font-heading` to this variable in globals.css.
const fraunces = Fraunces({
  variable: "--font-serif",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI Price Sniper — name your price, we'll catch the drop",
  description:
    "LLM-powered price tracking: paste any product link, set a target price, and get emailed the moment it drops. No fragile scrapers — Gemini reads the page.",
  openGraph: {
    title: "AI Price Sniper",
    description: "Paste a product link, name your price, get emailed when it drops.",
    type: "website",
  },
};

/**
 * Theme resolution before first paint: an explicit user choice (persisted
 * by the nav toggle in localStorage) wins; otherwise follow the OS
 * preference. Toggles the `.dark` class that the shadcn theme (and the
 * chart's --viz-* tokens) key off. `suppressHydrationWarning` on <html>
 * covers the class mismatch this creates during hydration.
 */
const themeScript = `try{var t=localStorage.getItem('theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {children}
        <Toaster position="bottom-center" />
      </body>
    </html>
  );
}
