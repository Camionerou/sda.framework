import { ALLOW_UNAUTHENTICATED_WORKER, MAX_REQUEST_BODY_BYTES, TOKEN } from "./config.mjs";

export function json(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

export class RequestBodyTooLargeError extends Error {
  constructor(limit) {
    super(`Request body exceeds ${limit} bytes.`);
    this.name = "RequestBodyTooLargeError";
    this.limit = limit;
  }
}

export function requireAuth(request, response) {
  if (!TOKEN) {
    if (ALLOW_UNAUTHENTICATED_WORKER) {
      return true;
    }

    json(response, 503, { error: "Worker auth token is not configured." });
    return false;
  }

  const header = request.headers.authorization ?? "";

  if (header === `Bearer ${TOKEN}`) {
    return true;
  }

  json(response, 401, { error: "Unauthorized" });
  return false;
}

export async function readRequestBody(request, limit = MAX_REQUEST_BODY_BYTES) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > limit) {
      throw new RequestBodyTooLargeError(limit);
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

export async function readJson(request) {
  return JSON.parse((await readRequestBody(request)).toString("utf8"));
}

export async function readText(request) {
  return (await readRequestBody(request)).toString("utf8");
}
