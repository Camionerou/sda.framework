import { loadEnvFiles } from "../shared/env-loader.mjs";

loadEnvFiles();

const DEFAULT_APP_ID = "sda-framework";
const DEFAULT_APP_URL = "https://sda-framework.vercel.app/api/inngest";

const apiKey = process.env.INNGEST_API_KEY?.trim();
const appId = process.env.INNGEST_APP_ID?.trim() || DEFAULT_APP_ID;
const appUrl = process.env.INNGEST_APP_URL?.trim() || DEFAULT_APP_URL;

if (!apiKey) {
  console.error("Missing INNGEST_API_KEY. Add it to .env.local or export it before running sync.");
  process.exit(2);
}

let parsedAppUrl;

try {
  parsedAppUrl = new URL(appUrl);
} catch {
  console.error(`Invalid INNGEST_APP_URL: ${appUrl}`);
  process.exit(2);
}

if (parsedAppUrl.protocol !== "https:") {
  console.error(`INNGEST_APP_URL must be public HTTPS for cloud sync: ${appUrl}`);
  process.exit(2);
}

const syncUrl = `https://api.inngest.com/v2/apps/${encodeURIComponent(appId)}/syncs`;
const response = await fetch(syncUrl, {
  body: JSON.stringify({ url: parsedAppUrl.toString() }),
  headers: {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json"
  },
  method: "POST"
});

const text = await response.text();
let body = null;

try {
  body = text ? JSON.parse(text) : null;
} catch {
  body = text;
}

if (!response.ok) {
  console.error(
    JSON.stringify(
      {
        app_id: appId,
        app_url: parsedAppUrl.toString(),
        error: body,
        status: response.status
      },
      null,
      2
    )
  );
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      app_id: appId,
      app_url: parsedAppUrl.toString(),
      ok: true,
      response: body
    },
    null,
    2
  )
);
