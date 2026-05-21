import { createReadStream } from "node:fs";

import { SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from "./config.mjs";

export function requireSupabaseStorageConfig() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son requeridos para persistir artefactos.");
  }

  return {
    key: SUPABASE_SERVICE_ROLE_KEY,
    url: SUPABASE_URL
  };
}

export async function uploadStorageObject(bucket, path, filePath, contentType, byteSize) {
  const config = requireSupabaseStorageConfig();
  const encodedBucket = encodeURIComponent(bucket);
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${config.url}/storage/v1/object/${encodedBucket}/${encodedPath}`, {
    body: createReadStream(filePath),
    // Required by Node fetch when streaming a request body.
    duplex: "half",
    headers: {
      apikey: config.key,
      authorization: `Bearer ${config.key}`,
      "cache-control": "3600",
      "content-length": String(byteSize),
      "content-type": contentType,
      "x-upsert": "true"
    },
    method: "POST"
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Storage upload failed ${response.status}: ${text || response.statusText}`);
  }
}
