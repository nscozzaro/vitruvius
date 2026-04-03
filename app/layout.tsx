import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vitruvius",
  description: "Vibe code your house — AI-powered building design and BIM generation",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-background text-foreground font-sans">
        {children}
      </body>
    </html>
  );
}
