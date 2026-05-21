export type TenantRole = "owner" | "admin" | "member" | "viewer";

export type AppClaims = {
  sub?: string;
  email?: string;
  exp?: number;
  tenant_id?: string;
  tenant_role?: TenantRole;
  tenant_slug?: string;
  tenant_status?: string;
  user_status?: string;
  claims_version?: number;
  app_metadata?: {
    tenant_id?: string;
    tenant_role?: TenantRole;
    tenant_slug?: string;
    tenant_status?: string;
    user_status?: string;
    claims_version?: number;
  };
};

export function getClaimValue<T extends string | number>(
  claims: AppClaims | null,
  key: keyof AppClaims,
  metadataKey?: keyof NonNullable<AppClaims["app_metadata"]>
): T | undefined {
  const directValue = claims?.[key];
  const metadataValue = metadataKey ? claims?.app_metadata?.[metadataKey] : undefined;

  return (directValue ?? metadataValue) as T | undefined;
}

export function formatUnixSeconds(value?: number) {
  if (!value) {
    return "Sin dato";
  }

  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value * 1000));
}

export function formatDateTime(value?: string | null) {
  if (!value) {
    return "Sin dato";
  }

  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function compactId(value?: string | null) {
  if (!value) {
    return "Sin dato";
  }

  if (value.length <= 16) {
    return value;
  }

  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}
