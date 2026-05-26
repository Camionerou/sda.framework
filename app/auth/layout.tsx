import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Autenticación | SDA Framework",
  description: "Accede a tu cuenta en la plataforma SDA Framework",
};

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/40 px-4 py-12">
      {children}
    </div>
  );
}
