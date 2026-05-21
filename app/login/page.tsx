import { redirect } from "next/navigation";

import { GoogleLoginButton } from "@/components/auth/google-login-button";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type LoginSearchParams = {
  error?: string;
  invite_token?: string;
  message?: string;
};

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<LoginSearchParams>;
}) {
  const params = await searchParams;
  let configError: string | null = null;
  let hasSession = false;

  try {
    const supabase = await createClient();
    const { data: claimsData } = await supabase.auth.getClaims();
    hasSession = Boolean(claimsData?.claims);
  } catch (error) {
    configError = error instanceof Error ? error.message : "No se pudo leer la sesión.";
  }

  if (hasSession) {
    redirect("/app");
  }

  return (
    <div className="ws">
      <div className="ws-auth">
        <div className="glass auth-card">
          <div className="auth-brand">
            <span className="brand" aria-hidden="true">
              S
            </span>
            <div>
              <div className="kicker">Workspace privado</div>
              <h1>SDA</h1>
              <p>Acceso seguro a documentos, indexación y memoria semántica, aislados por tenant.</p>
            </div>
          </div>

          {params.invite_token ? (
            <div className="alert alert-success">
              <strong>Invitación detectada.</strong>
              <span>Después del login se activa tu usuario y se refrescan los claims.</span>
            </div>
          ) : (
            <div className="alert alert-warning">
              <strong>Invite-only activo.</strong>
              <span>Sin link de invitación, el login no asigna tenant automáticamente.</span>
            </div>
          )}

          {params.error ? (
            <div className="alert alert-danger" role="alert">
              <strong>{params.error}</strong>
              <span>{params.message ?? "Reintentá con el link de invitación correcto."}</span>
            </div>
          ) : null}

          {configError ? (
            <div className="alert alert-danger" role="alert">
              <strong>Falta configuración local.</strong>
              <span>{configError}</span>
            </div>
          ) : (
            <GoogleLoginButton inviteToken={params.invite_token} />
          )}
        </div>
      </div>
    </div>
  );
}
