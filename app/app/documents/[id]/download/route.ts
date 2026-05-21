import { NextResponse, type NextRequest } from "next/server";

import { isVisibleDocument, type DocumentRow } from "@/lib/documents";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const { data: document, error: documentError } = await supabase
    .from("documents")
    .select(
      "id, title, filename, mime_type, byte_size, storage_bucket, storage_path, status, status_reason, uploaded_at, indexed_at, created_at, indexing_pipeline_version, extraction_pipeline_version, tree_indexer_version, embedding_pipeline_version"
    )
    .eq("id", id)
    .maybeSingle<DocumentRow>();

  if (documentError || !document || !isVisibleDocument(document)) {
    return NextResponse.redirect(new URL("/app/documents?error=document_not_found", request.url));
  }

  const { data: signedUrl, error: signedUrlError } = await supabase.storage
    .from(document.storage_bucket)
    .createSignedUrl(document.storage_path, 60, {
      download: document.filename
    });

  if (signedUrlError || !signedUrl?.signedUrl) {
    return NextResponse.redirect(new URL("/app/documents?error=download_failed", request.url));
  }

  return NextResponse.redirect(signedUrl.signedUrl);
}
