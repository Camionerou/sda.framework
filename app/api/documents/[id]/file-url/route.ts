import { NextResponse, type NextRequest } from "next/server";

import type { DocumentRow } from "@/lib/documents";
import { createClient } from "@/lib/supabase/server";

const DEFAULT_PDF_VIEWER_SIGNED_URL_TTL_SECONDS = 900;

type RouteContext = {
  params: Promise<unknown>;
};

function documentIdFromParams(params: unknown) {
  if (!params || typeof params !== "object" || !("id" in params)) {
    return null;
  }

  const id = (params as { id?: unknown }).id;
  return typeof id === "string" && id ? id : null;
}

function getPdfViewerSignedUrlTtlSeconds() {
  const rawValue = process.env.PDF_VIEWER_SIGNED_URL_TTL;
  if (!rawValue) {
    return DEFAULT_PDF_VIEWER_SIGNED_URL_TTL_SECONDS;
  }

  const value = Number.parseInt(rawValue, 10);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_PDF_VIEWER_SIGNED_URL_TTL_SECONDS;
}

export async function GET(
  _request: NextRequest,
  { params }: RouteContext
) {
  const id = documentIdFromParams(await params);
  if (!id) {
    return NextResponse.json({ error: "invalid_document_id" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data: document, error: documentError } = await supabase
    .from("documents")
    .select(
      "id, title, filename, mime_type, byte_size, r2_bucket, r2_key, status, status_reason, uploaded_at, indexed_at, created_at, indexing_pipeline_version, extraction_pipeline_version, tree_indexer_version, embedding_pipeline_version"
    )
    .eq("id", id)
    .maybeSingle<DocumentRow>();

  if (documentError) {
    return NextResponse.json({ error: "document_lookup_failed" }, { status: 500 });
  }

  if (!document) {
    return NextResponse.json({ error: "document_not_found" }, { status: 404 });
  }

  const ttlSeconds = getPdfViewerSignedUrlTtlSeconds();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const { data: signedUrl, error: signedUrlError } = await supabase.storage
    .from(document.r2_bucket)
    .createSignedUrl(document.r2_key, ttlSeconds);

  if (signedUrlError || !signedUrl?.signedUrl) {
    return NextResponse.json({ error: "file_url_failed" }, { status: 502 });
  }

  return NextResponse.json(
    {
      byteSize: document.byte_size,
      expiresAt,
      filename: document.filename,
      mimeType: document.mime_type,
      url: signedUrl.signedUrl
    },
    {
      headers: {
        "Cache-Control": "no-store"
      }
    }
  );
}
