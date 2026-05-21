import { NextResponse, type NextRequest } from "next/server";

import { clientIpFromHeaders, limitInviteAccept } from "@/lib/redis/rate-limit";
import { createClient } from "@/lib/supabase/server";

function redirectWithError(request: NextRequest, error: string, message?: string) {
  const url = new URL("/login", request.url);
  url.searchParams.set("error", error);

  if (message) {
    url.searchParams.set("message", message);
  }

  return NextResponse.redirect(url);
}

function safeNextPath(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/app";
  }

  return value;
}

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const inviteToken = requestUrl.searchParams.get("invite_token");
  const next = safeNextPath(requestUrl.searchParams.get("next"));

  if (!code) {
    return redirectWithError(request, "oauth_callback", "Google no devolvió un código OAuth.");
  }

  const supabase = await createClient();
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);

  if (exchangeError) {
    return redirectWithError(request, "oauth_exchange", exchangeError.message);
  }

  if (inviteToken) {
    const { data: userData, error: userError } = await supabase.auth.getUser();

    if (userError || !userData.user) {
      await supabase.auth.signOut();
      return redirectWithError(request, "invite_auth", "No se pudo validar el usuario autenticado.");
    }

    const inviteRateLimit = await limitInviteAccept({
      actorId: userData.user.id,
      ip: clientIpFromHeaders(request.headers)
    });

    if (!inviteRateLimit.success) {
      await supabase.auth.signOut();
      const response = redirectWithError(
        request,
        "invite_rate_limited",
        "Demasiados intentos de aceptar invitaciones. Reintenta mas tarde."
      );

      if (inviteRateLimit.reset) {
        response.headers.set(
          "retry-after",
          String(Math.max(1, Math.ceil((inviteRateLimit.reset - Date.now()) / 1000)))
        );
      }

      return response;
    }

    const { error: inviteError } = await supabase.rpc("accept_tenant_invite", {
      _invite_token: inviteToken
    });

    if (inviteError) {
      await supabase.auth.signOut();
      return redirectWithError(request, "invite_accept", inviteError.message);
    }

    const { error: refreshError } = await supabase.auth.refreshSession();

    if (refreshError) {
      await supabase.auth.signOut();
      return redirectWithError(request, "session_refresh", refreshError.message);
    }
  }

  return NextResponse.redirect(new URL(next, request.url));
}
