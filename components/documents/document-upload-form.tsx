"use client";

import { CheckCircle2, FileUp } from "lucide-react";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

type UploadState = {
  error?: string;
  filename?: string;
  queueError?: string;
  status: "idle" | "uploading" | "deduped" | "success" | "error";
};

type CreatedUpload = {
  document_id: string;
  filename: string;
  r2_bucket: string;
  r2_key: string;
  status: string;
  storage_bucket?: string;
  storage_path?: string;
  tenant_id: string;
  checksum_sha256: string | null;
  deduped: boolean;
};

async function sha256Hex(file: File) {
  const buffer = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buffer);

  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function markUploadFailed(
  documentId: string,
  reason: string,
  supabase: ReturnType<typeof createClient>
) {
  await supabase.rpc("mark_document_upload_failed", {
    _document_id: documentId,
    _reason: reason
  });
}

type DocumentUploadFormProps = {
  workspaceId: string;
};

export function DocumentUploadForm({ workspaceId }: DocumentUploadFormProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<UploadState>({ status: "idle" });

  async function handleSubmit(formData: FormData) {
    const file = formData.get("file");
    const title = formData.get("title");

    if (!(file instanceof File) || file.size === 0) {
      setState({
        status: "error",
        error: "Seleccioná un archivo."
      });
      return;
    }

    setState({
      filename: file.name,
      status: "uploading"
    });

    const checksum = await sha256Hex(file);
    const supabase = createClient();
    const { data: uploadRows, error: createError } = await supabase.rpc(
      "create_document_upload",
      {
        _byte_size: file.size,
        _checksum_sha256: checksum,
        _filename: file.name,
        _metadata: {
          source: "app/documents"
        },
        _mime_type: file.type || "application/octet-stream",
        _title: typeof title === "string" && title.trim() ? title.trim() : null,
        _workspace_id: workspaceId
      }
    );

    if (createError) {
      setState({
        status: "error",
        error: createError.message
      });
      return;
    }

    const upload = (Array.isArray(uploadRows) ? uploadRows[0] : uploadRows) as
      | CreatedUpload
      | undefined;

    if (!upload) {
      setState({
        status: "error",
        error: "La API no devolvió el destino de storage."
      });
      return;
    }

    const storageBucket = upload.storage_bucket ?? upload.r2_bucket;
    const storagePath = upload.storage_path ?? upload.r2_key;

    if (!storageBucket || !storagePath) {
      setState({
        status: "error",
        error: "La API no devolvió el destino de storage."
      });
      return;
    }

    if (upload.deduped) {
      fileInputRef.current?.form?.reset();
      setState({
        filename: upload.filename,
        status: "deduped"
      });
      router.refresh();
      return;
    }

    const { error: storageError } = await supabase.storage
      .from(storageBucket)
      .upload(storagePath, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false
      });

    if (storageError) {
      await markUploadFailed(upload.document_id, storageError.message, supabase).catch(() => null);
      setState({
        filename: file.name,
        status: "error",
        error: storageError.message
      });
      return;
    }

    const { error: markError } = await supabase.rpc("mark_document_uploaded", {
      _byte_size: file.size,
      _checksum_sha256: checksum,
      _document_id: upload.document_id
    });

    if (markError) {
      setState({
        filename: file.name,
        status: "error",
        error: markError.message
      });
      return;
    }

    const queueResponse = await fetch(`/api/documents/${upload.document_id}/indexing/request`, {
      body: JSON.stringify({ source: "document_upload" }),
      headers: {
        "Content-Type": "application/json"
      },
      method: "POST"
    });
    const queuePayload = (await queueResponse.json().catch(() => null)) as
      | { error?: string }
      | null;

    fileInputRef.current?.form?.reset();
    setState({
      filename: file.name,
      queueError: queueResponse.ok ? undefined : queuePayload?.error ?? "No se pudo poner en cola.",
      status: "success"
    });
    router.refresh();
  }

  return (
    <form action={handleSubmit} className="form-grid">
      <div className="field">
        <label className="label" htmlFor="title">
          Título
        </label>
        <input
          className="input"
          id="title"
          name="title"
          placeholder="Nombre visible del documento"
          type="text"
        />
      </div>

      <div className="field">
        <label className="label" htmlFor="file">
          Archivo
        </label>
        <input
          accept=".pdf,.txt,.md,.doc,.docx,application/pdf,text/plain,text/markdown,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="file-input"
          id="file"
          name="file"
          ref={fileInputRef}
          required
          type="file"
        />
      </div>

      <Button
        disabled={state.status === "uploading"}
        leftIcon={<FileUp aria-hidden="true" size={16} />}
        type="submit"
        variant="primary"
      >
        {state.status === "uploading" ? "Subiendo..." : "Subir documento"}
      </Button>

      {state.status === "error" ? (
        <div className="alert alert-danger" role="alert">
          <strong>No se pudo subir el documento.</strong>
          <span>{state.error}</span>
        </div>
      ) : null}

      {state.status === "success" ? (
        <div className={`alert ${state.queueError ? "alert-warning" : "alert-success"}`}>
          <strong>Documento subido.</strong>
          <span>
            {state.queueError
              ? `La ingesta no se pudo iniciar automáticamente: ${state.queueError}`
              : `${state.filename} quedó guardado; la ingesta quedó en cola.`}
          </span>
          <CheckCircle2 aria-hidden="true" size={16} />
        </div>
      ) : null}

      {state.status === "deduped" ? (
        <div className="alert alert-success">
          <strong>Documento ya cargado.</strong>
          <span>No se volvió a subir el mismo archivo.</span>
          <CheckCircle2 aria-hidden="true" size={16} />
        </div>
      ) : null}
    </form>
  );
}
