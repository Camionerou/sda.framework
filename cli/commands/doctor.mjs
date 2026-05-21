import { defineCommand } from "citty";
import { existsSync, readFileSync } from "node:fs";

import { loadSdaEnv } from "../shared/env.mjs";
import { printCheck, printJson, printSummary, printTitle } from "../shared/output.mjs";
import { run } from "../shared/process.mjs";
import { redisConfig } from "../shared/redis.mjs";

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Health check operacional de env, Redis, Inngest, gateway y DB"
  },
  args: {
    deep: {
      type: "boolean",
      description: "Agrega indexing health contra Supabase"
    },
    json: {
      type: "boolean",
      description: "Imprime output JSON"
    },
    quick: {
      type: "boolean",
      description: "Saltea checks lentos como secret scan"
    }
  },
  async run({ args }) {
    loadSdaEnv();

    const checks = [];

    checks.push(await envDoctor());

    if (!args.quick) {
      checks.push(await secretScan());
    }

    checks.push(await redisHealth());
    checks.push(inngestHealth());
    checks.push(await computeGatewayHealth());
    checks.push(versionHealth());

    if (args.deep) {
      checks.push(await indexingHealth());
    }

    if (args.json) {
      printJson({
        checks,
        summary: {
          errors: checks.filter((check) => check.status === "error").length,
          ok: checks.filter((check) => check.status === "ok").length,
          warnings: checks.filter((check) => check.status === "warn").length
        }
      });
      return;
    }

    printTitle("SDA Doctor");

    for (const check of checks) {
      printCheck(check.label, check.status, check.message);
    }

    printSummary(checks);
  }
});

async function envDoctor() {
  const result = await run("node", ["scripts/health/env-doctor.mjs", "--json"], {
    allowFailure: true
  });

  try {
    const body = JSON.parse(result.stdout);
    const summary = body.summary ?? {};
    const status = summary.errors > 0 ? "error" : summary.warnings > 0 ? "warn" : "ok";

    return {
      details: body,
      label: "Env",
      message: `${summary.ok ?? 0} ok, ${summary.info ?? 0} info, ${summary.warnings ?? 0} warnings, ${summary.errors ?? 0} errors`,
      status
    };
  } catch {
    return {
      details: result.stdout || result.stderr,
      label: "Env",
      message: "no se pudo parsear env-doctor",
      status: result.code === 0 ? "warn" : "error"
    };
  }
}

async function secretScan() {
  const result = await run("node", ["scripts/ci/secret-scan.mjs"], { allowFailure: true });

  return {
    details: result.stdout || result.stderr,
    label: "Secrets",
    message: result.code === 0 ? "sin secretos trackeables" : "secret scan detecto problemas",
    status: result.code === 0 ? "ok" : "error"
  };
}

async function redisHealth() {
  const config = redisConfig();
  const result = await run("node", ["scripts/health/redis-health.mjs"], { allowFailure: true });

  try {
    const body = JSON.parse(result.stdout);
    const status = body.ok ? "ok" : body.configured ? "error" : "warn";
    const message = body.ok
      ? `${body.response} (${body.latency_ms}ms) · prefix=${config?.keyPrefix ?? "sin-config"}`
      : body.reason ?? body.error ?? "Redis no disponible";

    return {
      details: body,
      label: "Redis",
      message,
      status
    };
  } catch {
    return {
      details: result.stdout || result.stderr,
      label: "Redis",
      message: "no se pudo parsear redis-health",
      status: result.code === 0 ? "warn" : "error"
    };
  }
}

function inngestHealth() {
  const routePath = "app/api/inngest/route.ts";
  const route = existsSync(routePath) ? readFileSync(routePath, "utf8") : "";
  const functionsMatch = route.match(/functions:\s*\[([^\]]*)\]/s);
  const functionCount = functionsMatch
    ? functionsMatch[1].split(",").map((part) => part.trim()).filter(Boolean).length
    : 0;
  const hasEventKey = Boolean(process.env.INNGEST_EVENT_KEY?.trim());
  const hasSigningKey = Boolean(process.env.INNGEST_SIGNING_KEY?.trim());

  return {
    details: {
      app_id: process.env.INNGEST_APP_ID || "sda-framework",
      event_key_configured: hasEventKey,
      functions: functionCount,
      signing_key_configured: hasSigningKey
    },
    label: "Inngest",
    message: `${hasEventKey ? "event-key OK" : "event-key missing"} · ${functionCount} functions declaradas`,
    status: hasEventKey && hasSigningKey ? "ok" : "warn"
  };
}

async function computeGatewayHealth() {
  const url = process.env.COMPUTE_GATEWAY_URL?.trim();
  const token = process.env.COMPUTE_GATEWAY_TOKEN?.trim();

  if (!url || !token) {
    return {
      details: { configured: false },
      label: "Gateway",
      message: "COMPUTE_GATEWAY_URL/TOKEN no configurados en este entorno",
      status: "warn"
    };
  }

  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/v1/health`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    const body = await response.json();

    return {
      details: body,
      label: "Gateway",
      message: response.ok
        ? `${body.service ?? "compute"} ${body.compute_gateway_version ?? ""}`.trim()
        : `HTTP ${response.status}`,
      status: response.ok && body.ok ? "ok" : "error"
    };
  } catch (error) {
    return {
      details: { error: error instanceof Error ? error.message : String(error) },
      label: "Gateway",
      message: error instanceof Error ? error.message : "gateway error",
      status: "error"
    };
  }
}

function versionHealth() {
  const versions = JSON.parse(readFileSync("lib/system-versions.json", "utf8"));

  return {
    details: versions,
    label: "Versions",
    message: `app=${versions.app} · indexing=${versions.indexing_pipeline} · tree=${versions.tree_indexer_python}`,
    status: "ok"
  };
}

async function indexingHealth() {
  const result = await run("node", ["scripts/health/indexing-health.mjs"], { allowFailure: true });

  try {
    const body = JSON.parse(result.stdout);
    const anomalies = body.anomalies?.length ?? 0;
    const drift = body.versions?.indexed_document_reindex_required_count ?? 0;

    return {
      details: body,
      label: "Indexing",
      message: `${anomalies} anomalies · ${drift} docs requieren reindex`,
      status: result.code === 0 ? "ok" : "warn"
    };
  } catch {
    return {
      details: result.stdout || result.stderr,
      label: "Indexing",
      message: "no se pudo parsear indexing-health",
      status: result.code === 0 ? "warn" : "error"
    };
  }
}
