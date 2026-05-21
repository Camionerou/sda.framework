import pc from "picocolors";

export function statusIcon(status) {
  if (status === "ok") {
    return pc.green("✓");
  }

  if (status === "warn") {
    return pc.yellow("⚠");
  }

  if (status === "error") {
    return pc.red("✕");
  }

  return pc.cyan("•");
}

export function printCheck(label, status, message = "") {
  const padded = label.padEnd(18);
  console.log(`${padded} ${statusIcon(status)}  ${message}`);
}

export function printTitle(title) {
  console.log(pc.bold(title));
  console.log(pc.dim("━".repeat(56)));
}

export function printSummary(checks) {
  const errors = checks.filter((check) => check.status === "error").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  const ok = checks.filter((check) => check.status === "ok").length;

  console.log(pc.dim("━".repeat(56)));
  console.log(`${ok} ok, ${warnings} warnings, ${errors} errors`);

  if (errors > 0) {
    process.exitCode = 1;
  }
}

export function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

export function truncate(value, length = 12) {
  const text = String(value ?? "");

  return text.length > length ? `${text.slice(0, length)}…` : text;
}

export function formatAge(value) {
  if (!value) {
    return "-";
  }

  const diff = Date.now() - Date.parse(value);
  const minutes = Math.round(diff / 60_000);

  if (!Number.isFinite(minutes)) {
    return "-";
  }

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 48) {
    return `${hours}h`;
  }

  return `${Math.round(hours / 24)}d`;
}
