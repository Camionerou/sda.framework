"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2, Eye, EyeOff, CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

export default function SignUpPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingGoogle, setLoadingGoogle] = useState(false);
  const [success, setSuccess] = useState(false);

  async function handleGoogleSignUp() {
    setLoadingGoogle(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo:
            process.env.NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL ??
            `${window.location.origin}/auth/callback`,
        },
      });
      if (error) toast.error(error.message);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Error de configuración. Agrega las variables de entorno de Supabase."
      );
      setLoadingGoogle(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (password !== confirmPassword) {
      toast.error("Las contraseñas no coinciden");
      return;
    }

    if (password.length < 6) {
      toast.error("La contraseña debe tener al menos 6 caracteres");
      return;
    }

    setLoading(true);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo:
            process.env.NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL ??
            `${window.location.origin}/auth/callback`,
        },
      });

      if (error) {
        toast.error(error.message);
        return;
      }

      setSuccess(true);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Error de configuración. Agrega las variables de entorno de Supabase."
      );
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <Card className="w-full max-w-sm text-center">
        <CardHeader>
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10">
            <CheckCircle2 className="size-6 text-primary" />
          </div>
          <CardTitle className="text-2xl">Revisa tu correo</CardTitle>
          <CardDescription>
            Te enviamos un enlace de confirmación a{" "}
            <span className="font-medium text-foreground">{email}</span>. Haz
            clic en el enlace para activar tu cuenta.
          </CardDescription>
        </CardHeader>
        <CardFooter className="flex justify-center">
          <Link
            href="/auth/login"
            className="text-sm font-medium underline-offset-4 hover:underline"
          >
            Volver al inicio de sesión
          </Link>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-primary">
          <span className="text-lg font-bold text-primary-foreground">SDA</span>
        </div>
        <CardTitle className="text-2xl">Crear cuenta</CardTitle>
        <CardDescription>
          Completa los datos para registrarte en la plataforma
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <Button
          variant="outline"
          className="w-full"
          onClick={handleGoogleSignUp}
          disabled={loadingGoogle || loading}
          type="button"
        >
          {loadingGoogle ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <GoogleIcon />
          )}
          Continuar con Google
        </Button>

        <div className="flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-xs text-muted-foreground">o continúa con email</span>
          <Separator className="flex-1" />
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Correo electrónico</Label>
            <Input
              id="email"
              type="email"
              placeholder="nombre@empresa.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Contraseña</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                placeholder="Mínimo 6 caracteres"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
              >
                {showPassword ? (
                  <EyeOff className="size-4" />
                ) : (
                  <Eye className="size-4" />
                )}
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="confirm-password">Confirmar contraseña</Label>
            <Input
              id="confirm-password"
              type={showPassword ? "text" : "password"}
              placeholder="Repite tu contraseña"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
          </div>

          <Button type="submit" className="w-full" disabled={loading || loadingGoogle}>
            {loading && <Loader2 data-icon="inline-start" className="animate-spin" />}
            {loading ? "Creando cuenta..." : "Crear cuenta"}
          </Button>
        </form>
      </CardContent>

      <Separator />

      <CardFooter className="flex justify-center pt-4">
        <p className="text-sm text-muted-foreground">
          ¿Ya tienes cuenta?{" "}
          <Link
            href="/auth/login"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Inicia sesión
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
