import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";

const env = process.env;

function loadLocalEnv() {
  if (!existsSync(".env.local")) {
    return;
  }

  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#")) {
      continue;
    }

    const index = line.indexOf("=");
    if (index === -1) {
      continue;
    }

    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();

    if (key && env[key] === undefined) {
      env[key] = value;
    }
  }
}

function required(name, fallbackName) {
  const value = env[name] || (fallbackName ? env[fallbackName] : undefined);

  if (!value) {
    const fallbackText = fallbackName ? ` o ${fallbackName}` : "";
    throw new Error(`Falta ${name}${fallbackText}.`);
  }

  return value;
}

function addHours(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

async function main() {
  loadLocalEnv();

  const url = required("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = required("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY");
  const inviteEmail = required("INVITE_EMAIL").trim().toLowerCase();
  const appOrigin = env.APP_ORIGIN || "http://localhost:3000";
  const tenantSlug = env.TENANT_SLUG || "sda-framework";
  const tenantName = env.TENANT_NAME || "SDA Framework";
  const inviteRole = env.INVITE_ROLE || "owner";
  const ttlHours = Number(env.INVITE_TTL_HOURS || 168);

  if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
    throw new Error("INVITE_TTL_HOURS debe ser un número positivo.");
  }

  const supabase = createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

  let tenantId = env.TENANT_ID;

  if (!tenantId) {
    const { data: existingTenant, error: tenantLookupError } = await supabase
      .from("tenants")
      .select("id, slug, name")
      .eq("slug", tenantSlug)
      .maybeSingle();

    if (tenantLookupError) {
      throw tenantLookupError;
    }

    if (existingTenant) {
      tenantId = existingTenant.id;
    } else {
      const { data: tenant, error: tenantCreateError } = await supabase
        .from("tenants")
        .insert({
          slug: tenantSlug,
          name: tenantName,
          settings: {
            source: "bootstrap-owner-invite"
          }
        })
        .select("id, slug, name")
        .single();

      if (tenantCreateError) {
        throw tenantCreateError;
      }

      tenantId = tenant.id;
    }
  }

  const { data: inviteRows, error: inviteError } = await supabase.rpc(
    "create_tenant_invite",
    {
      _email: inviteEmail,
      _role: inviteRole,
      _tenant_id: tenantId,
      _expires_at: addHours(ttlHours),
      _metadata: {
        source: "bootstrap-owner-invite"
      }
    }
  );

  if (inviteError) {
    throw inviteError;
  }

  const invite = Array.isArray(inviteRows) ? inviteRows[0] : inviteRows;
  const inviteUrl = new URL("/login", appOrigin);
  inviteUrl.searchParams.set("invite_token", invite.invite_token);

  console.log("Tenant:", tenantId);
  console.log("Invite:", invite.invite_id);
  console.log("Email:", invite.email);
  console.log("Role:", invite.role);
  console.log("Expires:", invite.expires_at);
  console.log("URL:", inviteUrl.toString());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
