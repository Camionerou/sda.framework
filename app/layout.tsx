import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@fontsource-variable/bricolage-grotesque/index.css";
import "@fontsource-variable/hanken-grotesk/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "SDA Ops",
  description: "Workspace privado para documentos, tenants e indexación SDA."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
