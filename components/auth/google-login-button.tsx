"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { GoogleIcon } from "@/components/auth/google-icon";
import { createClient } from "@/lib/supabase/client";

export function GoogleLoginButton({ inviteToken }: { inviteToken?: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleLogin() {
    setError(null);
    setPending(true);

    try {
      const supabase = createClient();
      const redirectTo = new URL("/auth/callback", window.location.origin);

      if (inviteToken) {
        redirectTo.searchParams.set("invite_token", inviteToken);
      }

      const { error: authError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: redirectTo.toString()
        }
      });

      if (authError) {
        setError(authError.message);
        setPending(false);
      }
    } catch (clientError) {
      setError(clientError instanceof Error ? clientError.message : "No se pudo iniciar sesión.");
      setPending(false);
    }
  }

  return (
    <div className="section-grid">
      <Button
        disabled={pending}
        full
        leftIcon={<GoogleIcon />}
        onClick={handleLogin}
        variant="primary"
      >
        {pending ? "Conectando..." : "Entrar con Google"}
      </Button>
      {error ? (
        <div className="alert alert-danger" role="alert">
          <strong>No se pudo iniciar Google OAuth.</strong>
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}
