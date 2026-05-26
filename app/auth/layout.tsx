import type { Metadata } from "next";
import Image from "next/image";
import { CheckCircle2, BarChart3, Users, Zap } from "lucide-react";

export const metadata: Metadata = {
  title: "Autenticación | SDA Framework",
  description: "Accede a tu cuenta en la plataforma SDA Framework",
};

const features = [
  { icon: BarChart3, text: "Panel de control en tiempo real" },
  { icon: Users, text: "Gestión de equipos y roles" },
  { icon: Zap, text: "Automatización de procesos" },
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
      <div className="hidden lg:flex lg:w-[55%] relative flex-col overflow-hidden">
        <Image
          src="/auth-bg.jpg"
          alt=""
          fill
          className="object-cover"
          priority
        />
        {/* Deep overlay */}
        <div className="absolute inset-0 bg-[oklch(0.2_0.08_255/0.92)]" />

        {/* Content */}
        <div className="relative z-10 flex flex-col justify-between h-full p-14">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-lg bg-white/15 border border-white/20">
              <span className="text-xs font-bold text-white tracking-wider">SDA</span>
            </div>
            <span className="text-sm font-semibold tracking-widest text-white/80 uppercase">
              SDA Framework
            </span>
          </div>

          {/* Main copy */}
          <div className="flex flex-col gap-8">
            <div className="flex flex-col gap-5">
              <h1 className="text-5xl font-bold tracking-tight text-white text-balance leading-[1.1]">
                La plataforma que<br />potencia tu equipo.
              </h1>
              <p className="text-base text-white/50 leading-relaxed max-w-xs">
                Centraliza proyectos, automatiza procesos y colabora en tiempo real desde un solo lugar.
              </p>
            </div>

            {/* Features list */}
            <div className="flex flex-col gap-2.5">
              {features.map(({ icon: Icon, text }) => (
                <div key={text} className="flex items-center gap-3">
                  <Icon className="size-4 text-white/40 flex-shrink-0" />
                  <span className="text-sm text-white/60">{text}</span>
                </div>
              ))}
            </div>
          </div>

          <p className="text-xs text-white/25 tracking-wide">
            &copy; {new Date().getFullYear()} SDA Framework
          </p>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex flex-1 flex-col items-center justify-center bg-background px-8 py-12">
        {/* Mobile logo */}
        <div className="flex lg:hidden items-center gap-3 mb-10">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary">
            <span className="text-xs font-bold text-primary-foreground tracking-wider">SDA</span>
          </div>
          <span className="text-sm font-semibold tracking-widest text-foreground uppercase">
            SDA Framework
          </span>
        </div>

        <div className="w-full max-w-[340px]">{children}</div>
      </div>
    </div>
  );
}
