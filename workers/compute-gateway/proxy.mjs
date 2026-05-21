import { TREE_INDEXER_TOKEN, TREE_INDEXER_URL } from "./config.mjs";
import { json, readText, RequestBodyTooLargeError, requireAuth } from "./http.mjs";

export function isTreeIndexerPath(pathname) {
  return (
    pathname === "/v1/tree-index-jobs" ||
    /^\/v1\/tree-index-jobs\/[a-f0-9-]+(?:\/result)?$/.test(pathname)
  );
}

export async function proxyTreeIndexer(request, response, url) {
  if (!requireAuth(request, response)) {
    return;
  }

  if (!["GET", "POST"].includes(request.method)) {
    json(response, 405, { error: "Method not allowed." });
    return;
  }

  let body;

  try {
    body = request.method === "POST" ? await readText(request) : undefined;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      json(response, 413, {
        error: error.message,
        max_body_bytes: error.limit
      });
      return;
    }

    throw error;
  }

  const upstreamResponse = await fetch(`${TREE_INDEXER_URL}${url.pathname}${url.search}`, {
    body,
    headers: {
      ...(TREE_INDEXER_TOKEN ? { authorization: `Bearer ${TREE_INDEXER_TOKEN}` } : {}),
      ...(request.headers["content-type"] ? { "content-type": request.headers["content-type"] } : {})
    },
    method: request.method
  });
  const text = await upstreamResponse.text();

  response.writeHead(upstreamResponse.status, {
    "content-type": upstreamResponse.headers.get("content-type") ?? "application/json; charset=utf-8"
  });
  response.end(text);
}
