import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@fontsource-variable/bricolage-grotesque/index.css";
import "@fontsource-variable/hanken-grotesk/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "SDA Framework",
  description: "Consola privada para documentos, tenants y agentes SDA."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
