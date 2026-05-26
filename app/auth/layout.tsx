import type { Metadata } from "next";
import Image from "next/image";
import { CheckCircle2, BarChart3, Users, Zap } from "lucide-react";

export const metadata: Metadata = {
  title: "Autenticación | SDA Framework",
  description: "Accede a tu cuenta en la plataforma SDA Framework",
};

const stats = [
  { value: "99.9%", label: "Uptime garantizado" },
  { value: "+500", label: "Proyectos activos" },
  { value: "2x", label: "Mas productividad" },
];

const features = [
  { icon: BarChart3, text: "Panel de control en tiempo real" },
  { icon: Users, text: "Gestion de equipos y roles" },
  { icon: Zap, text: "Automatizaciones de procesos" },
  { icon: CheckCircle2, text: "Acceso seguro con OAuth 2.0" },
];

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex">
      {/* Branding panel */}
      <div className="hidden lg:flex lg:w-[52%] relative flex-col overflow-hidden">
        {/* Background image */}
        <Image
          src="/auth-panel-bg.jpg"
          alt=""
          fill
          className="object-cover"
          priority
        />
        {/* Overlay */}
        <div className="absolute inset-0 bg-[oklch(0.22_0.1_264/0.88)]" />

        {/* Content */}
        <div className="relative z-10 flex flex-col justify-between h-full p-12">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-xl bg-white/15 border border-white/20 backdrop-blur-sm">
              <span className="text-sm font-bold text-white">SDA</span>
            </div>
            <span className="text-lg font-semibold tracking-tight text-white">
              SDA Framework
            </span>
          </div>

          {/* Middle content */}
          <div className="flex flex-col gap-10">
            <div className="flex flex-col gap-4">
              <div className="inline-flex items-center gap-2 bg-white/10 border border-white/15 rounded-full px-3 py-1 w-fit">
                <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-xs text-white/80 font-medium">Plataforma activa</span>
              </div>
              <h1 className="text-4xl font-bold tracking-tight text-white text-balance leading-tight">
                La plataforma que<br />potencia tu equipo.
              </h1>
              <p className="text-base text-white/60 leading-relaxed max-w-sm">
                Centraliza proyectos, automatiza procesos y colabora en tiempo real desde un solo lugar.
              </p>
            </div>

            {/* Features */}
            <div className="flex flex-col gap-3">
              {features.map(({ icon: Icon, text }) => (
                <div key={text} className="flex items-center gap-3">
                  <div className="flex size-7 items-center justify-center rounded-lg bg-white/10 border border-white/15 flex-shrink-0">
                    <Icon className="size-3.5 text-white/70" />
                  </div>
                  <span className="text-sm text-white/70">{text}</span>
                </div>
              ))}
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-4 border-t border-white/10 pt-8">
              {stats.map(({ value, label }) => (
                <div key={label} className="flex flex-col gap-1">
                  <span className="text-2xl font-bold text-white">{value}</span>
                  <span className="text-xs text-white/50">{label}</span>
                </div>
              ))}
            </div>
          </div>

          <p className="text-xs text-white/30">
            &copy; {new Date().getFullYear()} SDA Framework. Todos los derechos reservados.
          </p>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex flex-1 flex-col items-center justify-center bg-background px-6 py-12">
        {/* Mobile logo */}
        <div className="flex lg:hidden items-center gap-3 mb-10">
          <div className="flex size-9 items-center justify-center rounded-xl bg-primary">
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
