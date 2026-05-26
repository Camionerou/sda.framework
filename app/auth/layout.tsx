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
    <div className="min-h-screen flex">
      {/* Branding panel — hidden on mobile */}
      <div className="hidden lg:flex lg:w-1/2 flex-col justify-between p-12 bg-card border-r border-border">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary">
            <span className="text-sm font-bold text-primary-foreground">SDA</span>
          </div>
          <span className="text-lg font-semibold tracking-tight text-foreground">
            SDA Framework
          </span>
        </div>

        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <h1 className="text-4xl font-bold tracking-tight text-foreground text-balance">
              La plataforma para equipos que construyen en serio.
            </h1>
            <p className="text-base text-muted-foreground leading-relaxed">
              Gestioná tus proyectos, equipos y procesos desde un solo lugar.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            {[
              "Acceso seguro con autenticacion empresarial",
              "Panel de control centralizado",
              "Colaboracion en tiempo real",
            ].map((feature) => (
              <div key={feature} className="flex items-center gap-3">
                <div className="size-1.5 rounded-full bg-primary flex-shrink-0" />
                <span className="text-sm text-muted-foreground">{feature}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          &copy; {new Date().getFullYear()} SDA Framework. Todos los derechos reservados.
        </p>
      </div>

      {/* Form panel */}
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-12">
        {/* Mobile logo */}
        <div className="flex lg:hidden items-center gap-3 mb-10">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary">
            <span className="text-sm font-bold text-primary-foreground">SDA</span>
          </div>
          <span className="text-lg font-semibold tracking-tight text-foreground">
            SDA Framework
          </span>
        </div>

        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}
