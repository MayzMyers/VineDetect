import type { Metadata } from "next";
import { ClientActivityLogger } from "@/components/dev/ClientActivityLogger";
import "./globals.css";

export const metadata: Metadata = {
  title: "VineDetect",
  description: "Wine label scanner",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <ClientActivityLogger />
        {children}
      </body>
    </html>
  );
}
