import { NextResponse, type NextRequest } from "next/server";

import type { DocumentRow } from "@/lib/documents";
import { createClient } from "@/lib/supabase/server";

// Inline signed URL for the embedded PDF viewer (see docs/issues/01-pdf-inline-signed-url.md).
// Same security boundary as the download route: getClaims + RLS read.
// Difference: no forced `download` disposition (renders inline) and a longer TTL.
const SIGNED_URL_TTL_SECONDS = Number.parseInt(
  process.env.PDF_VIEWER_SIGNED_URL_TTL ?? "600",
  10
);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data: document, error: documentError } = await supabase
    .from("documents")
    .select("id, filename, mime_type, byte_size, r2_bucket, r2_key, status")
    .eq("id", id)
    .maybeSingle<
      Pick<
        DocumentRow,
        "id" | "filename" | "mime_type" | "byte_size" | "r2_bucket" | "r2_key" | "status"
      >
    >();

  if (documentError || !document) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const ttl = Number.isFinite(SIGNED_URL_TTL_SECONDS) ? SIGNED_URL_TTL_SECONDS : 600;

  const { data: signed, error: signError } = await supabase.storage
    .from(document.r2_bucket)
    .createSignedUrl(document.r2_key, ttl, { download: false });

  if (signError || !signed?.signedUrl) {
    return NextResponse.json({ error: "sign_failed" }, { status: 500 });
  }

  return NextResponse.json(
    {
      url: signed.signedUrl,
      // Refresh a bit before the real expiry to avoid mid-session 403s.
      expiresAt: Date.now() + (ttl - 30) * 1000,
      mimeType: document.mime_type,
      filename: document.filename,
      byteSize: document.byte_size
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
