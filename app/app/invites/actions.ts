"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getClaimValue, type AppClaims, type TenantRole } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

const INVITE_ROLES = new Set(["admin", "member", "viewer"]);

export type CreateInviteState = {
  email?: string;
  error?: string;
  expiresAt?: string;
  inviteUrl?: string;
  role?: string;
  status: "idle" | "success" | "error";
};

function normalizeFormValue(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

async function getAppOrigin() {
  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin");

  if (origin) {
    return origin;
  }

  if (process.env.APP_ORIGIN) {
    return process.env.APP_ORIGIN;
  }

  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }

  return "http://localhost:3000";
}

export async function createInviteAction(
  _previousState: CreateInviteState,
  formData: FormData
): Promise<CreateInviteState> {
  const email = normalizeFormValue(formData.get("email")).toLowerCase();
  const role = normalizeFormValue(formData.get("role")) as TenantRole;
  const expiresDays = Number(normalizeFormValue(formData.get("expires_days")) || "7");

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return {
      status: "error",
      error: "Ingresá un email válido."
    };
  }

  if (!INVITE_ROLES.has(role)) {
    return {
      status: "error",
      error: "Elegí un rol válido para la invitación."
    };
  }

  if (!Number.isFinite(expiresDays) || expiresDays < 1 || expiresDays > 30) {
    return {
      status: "error",
      error: "La expiración debe estar entre 1 y 30 días."
    };
  }

  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims) {
    return {
      status: "error",
      error: "La sesión venció. Volvé a ingresar."
    };
  }

  const claims = claimsData.claims as AppClaims;
  const currentRole = getClaimValue<TenantRole>(claims, "tenant_role", "tenant_role");

  if (currentRole !== "owner" && currentRole !== "admin") {
    return {
      status: "error",
      error: "Solo owners y admins pueden crear invitaciones."
    };
  }

  const expiresAt = new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000);
  const { data, error } = await supabase.rpc("create_tenant_invite", {
    _email: email,
    _expires_at: expiresAt.toISOString(),
    _metadata: {
      source: "app/invites"
    },
    _role: role,
    _tenant_id: null
  });

  if (error) {
    return {
      status: "error",
      error: error.message
    };
  }

  const invite = Array.isArray(data) ? data[0] : data;

  if (!invite?.invite_token) {
    return {
      status: "error",
      error: "La invitación se creó, pero la API no devolvió token."
    };
  }

  const inviteUrl = new URL("/login", await getAppOrigin());
  inviteUrl.searchParams.set("invite_token", invite.invite_token);

  revalidatePath("/app");
  revalidatePath("/app/invites");

  return {
    email,
    expiresAt: invite.expires_at,
    inviteUrl: inviteUrl.toString(),
    role,
    status: "success"
  };
}

export async function revokeInviteAction(formData: FormData) {
  const inviteId = normalizeFormValue(formData.get("invite_id"));

  if (!inviteId) {
    redirect("/app/invites?error=missing_invite");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("revoke_tenant_invite", {
    _invite_id: inviteId
  });

  if (error) {
    redirect(`/app/invites?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/app");
  revalidatePath("/app/invites");
  redirect("/app/invites?revoked=1");
}
