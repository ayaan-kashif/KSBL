import type { Metadata, Viewport } from "next";
import { Inter, Outfit, Noto_Sans_Arabic, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { ToastProvider } from "@/components/ToastContext";
import { LanguageProvider } from "@/components/LanguageContext";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit", display: "swap" });
const notoSansArabic = Noto_Sans_Arabic({ subsets: ["arabic"], variable: "--font-noto-arabic", display: "swap" });
const jetBrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono", display: "swap" });

export const metadata: Metadata = {
  title: "ShelfWatch AI Verification",
  description: "AI Verification System",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // viewportFit lets env(safe-area-inset-*) resolve to real values on
  // notched devices, which the fixed nav bars depend on for clearance.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#070910" },
    { media: "(prefers-color-scheme: light)", color: "#eaeef6" },
  ],
};

/**
 * Applies the stored theme (or the OS preference) to <html> before the first
 * paint. Running this as a normal effect would let the default theme render
 * first and then snap to the other one — a visible flash on every load.
 *
 * The attribute is always stamped with the RESOLVED value, never left off:
 * globals.css keys its dark palette on [data-theme='dark'], so an absent
 * attribute means light, and "no stored preference on a dark-mode OS" has to
 * resolve to an explicit 'dark' rather than falling through to the default.
 */
const THEME_BOOTSTRAP = `
(function () {
  try {
    var stored = localStorage.getItem('shelfwatch-theme');
    var theme = stored === 'light' || stored === 'dark'
      ? stored
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
  } catch (e) {
    document.documentElement.dataset.theme = 'light';
  }
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${outfit.variable} ${notoSansArabic.variable} ${jetBrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* The four text faces above load through next/font, which self-hosts
            them. Material Symbols cannot: next/font's Google catalogue excludes
            icon fonts, so there is no module to import and the stylesheet has to
            be linked. In the App Router this root layout IS the document head,
            so the link applies to every route — the rule below is a Pages Router
            check for fonts added outside pages/_document, which does not apply. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className={inter.className}>
        {/* Providers wrap {children} rather than <html> so the static parts of
            the server tree stay server-rendered. */}
        <LanguageProvider>
          <ToastProvider>{children}</ToastProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
