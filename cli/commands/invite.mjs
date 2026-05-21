import { confirm, isCancel } from "@clack/prompts";
import { defineCommand } from "citty";

import { loadSdaEnv } from "../shared/env.mjs";
import { createAdminClient, resolveTenantId } from "../shared/supabase.mjs";
import { formatAge, truncate } from "../shared/output.mjs";

const ownerCommand = defineCommand({
  meta: {
    name: "owner",
    alias: "o",
    description: "Crea una invitacion owner sin expiracion por defecto"
  },
  args: {
    email: {
      type: "positional",
      required: true,
      description: "Email"
    }
  },
  async run({ args }) {
    await createInvite({
      email: args.email,
      expiresDays: "never",
      role: "owner"
    });
  }
});

const listCommand = defineCommand({
  meta: {
    name: "list",
    alias: ["ls", "l"],
    description: "Lista invitaciones"
  },
  args: {
    status: {
      type: "enum",
      alias: "s",
      options: ["pending", "accepted", "revoked", "all"],
      default: "pending",
      description: "Estado"
    }
  },
  async run({ args }) {
    loadSdaEnv();
    const supabase = createAdminClient();
    const tenantId = await resolveTenantId(supabase);
    let query = supabase
      .from("tenant_invites")
      .select("id, email, role, status, expires_at, created_at, accepted_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (args.status !== "all") {
      query = query.eq("status", args.status);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    for (const invite of data ?? []) {
      console.log(
        [
          truncate(invite.id, 10).padEnd(11),
          invite.status.padEnd(9),
          invite.role.padEnd(6),
          invite.email.padEnd(32),
          invite.expires_at ? `expira ${formatAge(invite.expires_at)}` : "sin expiracion"
        ].join(" ")
      );
    }
  }
});

const revokeCommand = defineCommand({
  meta: {
    name: "revoke",
    alias: ["rm", "del"],
    description: "Revoca una invitacion por id o email"
  },
  args: {
    target: {
      type: "positional",
      required: true,
      description: "Invite ID o email"
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "No pedir confirmacion"
    }
  },
  async run({ args }) {
    loadSdaEnv();
    const supabase = createAdminClient();
    const invite = await findInvite(supabase, args.target);

    if (!invite) {
      throw new Error("Invitacion pendiente no encontrada.");
    }

    if (!args.yes) {
      const accepted = await confirm({
        message: `Revocar invitacion de ${invite.email}?`,
        initialValue: false
      });

      if (isCancel(accepted) || !accepted) {
        console.log("Cancelado.");
        return;
      }
    }

    const { error } = await supabase.rpc("revoke_tenant_invite", {
      _invite_id: invite.id
    });

    if (error) {
      throw error;
    }

    console.log(`Revoked ${invite.id}`);
  }
});

const resendCommand = defineCommand({
  meta: {
    name: "resend",
    alias: "rs",
    description: "Revoca una invitacion pendiente y crea una nueva"
  },
  args: {
    target: {
      type: "positional",
      required: true,
      description: "Invite ID o email"
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "No pedir confirmacion"
    }
  },
  async run({ args }) {
    loadSdaEnv();
    const supabase = createAdminClient();
    const invite = await findInvite(supabase, args.target);

    if (!invite) {
      throw new Error("Invitacion pendiente no encontrada.");
    }

    if (!args.yes) {
      const accepted = await confirm({
        message: `Reenviar invitacion a ${invite.email}?`,
        initialValue: false
      });

      if (isCancel(accepted) || !accepted) {
        console.log("Cancelado.");
        return;
      }
    }

    const { error: revokeError } = await supabase.rpc("revoke_tenant_invite", {
      _invite_id: invite.id
    });

    if (revokeError) {
      throw revokeError;
    }

    await createInvite({
      email: invite.email,
      expiresDays: invite.expires_at ? "7" : "never",
      role: invite.role,
      tenantId: invite.tenant_id
    });
  }
});

async function createInvite(input) {
  loadSdaEnv();
  const supabase = createAdminClient();
  const tenantId = input.tenantId ?? (await resolveTenantId(supabase));
  const expiresAt = inviteExpiration(input.expiresDays, input.role);
  const email = input.email.trim().toLowerCase();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error("Email invalido.");
  }

  const { data, error } = await supabase.rpc("create_tenant_invite", {
    _email: email,
    _expires_at: expiresAt,
    _metadata: {
      never_expires: expiresAt === null,
      source: "sda-cli"
    },
    _role: input.role,
    _tenant_id: tenantId
  });

  if (error) {
    throw error;
  }

  const invite = Array.isArray(data) ? data[0] : data;
  const origin = process.env.APP_ORIGIN || process.env.INNGEST_APP_URL?.replace(/\/api\/inngest$/, "") || "http://localhost:3000";
  const inviteUrl = new URL("/login", origin);
  inviteUrl.searchParams.set("invite_token", invite.invite_token);

  console.log("Tenant:", tenantId);
  console.log("Invite:", invite.invite_id);
  console.log("Email:", invite.email);
  console.log("Role:", invite.role);
  console.log("Expires:", invite.expires_at ?? "Sin expiracion");
  console.log("URL:", inviteUrl.toString());
}

async function findInvite(supabase, target) {
  const tenantId = await resolveTenantId(supabase);
  const query = supabase
    .from("tenant_invites")
    .select("id, tenant_id, email, role, expires_at")
    .eq("tenant_id", tenantId)
    .eq("status", "pending")
    .limit(1);
  const idLike = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(target);
  const { data, error } = idLike
    ? await query.eq("id", target)
    : await query.eq("email", target.trim().toLowerCase());

  if (error) {
    throw error;
  }

  return data?.[0] ?? null;
}

function inviteExpiration(rawValue, role) {
  const value = String(rawValue || (role === "owner" ? "never" : "7")).trim().toLowerCase();

  if (["never", "none", "null"].includes(value)) {
    return null;
  }

  const days = Number(value);

  if (!Number.isFinite(days) || days <= 0 || days > 365) {
    throw new Error("expires-days debe ser un numero entre 1 y 365, o never.");
  }

  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

const createCommand = defineCommand({
  meta: {
    name: "create",
    alias: ["c", "add"],
    description: "Crea una invitacion"
  },
  args: {
    email: {
      type: "positional",
      required: true,
      description: "Email a invitar"
    },
    role: {
      type: "enum",
      alias: "r",
      options: ["owner", "admin", "member", "viewer"],
      default: "member",
      description: "Rol"
    },
    "expires-days": {
      type: "string",
      alias: "e",
      description: "Dias hasta expiracion; usa never para sin expiracion",
      default: "7"
    }
  },
  async run({ args }) {
    await createInvite({
      email: args.email,
      expiresDays: args["expires-days"],
      role: args.role
    });
  }
});

export const inviteCommand = defineCommand({
  meta: {
    name: "invite",
    alias: ["v", "inv"],
    description: "Gestion de invitaciones desde shell"
  },
  subCommands: {
    create: createCommand,
    list: listCommand,
    owner: ownerCommand,
    resend: resendCommand,
    revoke: revokeCommand
  }
});
