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
  status: "idle" | "uploading" | "success" | "error";
};

type CreatedUpload = {
  document_id: string;
  filename: string;
  r2_bucket: string;
  r2_key: string;
  status: string;
  tenant_id: string;
};

export function DocumentUploadForm() {
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

    const supabase = createClient();
    const { data: uploadRows, error: createError } = await supabase.rpc(
      "create_document_upload",
      {
        _byte_size: file.size,
        _filename: file.name,
        _metadata: {
          source: "app/documents"
        },
        _mime_type: file.type || "application/octet-stream",
        _title: typeof title === "string" && title.trim() ? title.trim() : null
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

    if (!upload?.r2_bucket || !upload.r2_key) {
      setState({
        status: "error",
        error: "La API no devolvió el destino de storage."
      });
      return;
    }

    const { error: storageError } = await supabase.storage
      .from(upload.r2_bucket)
      .upload(upload.r2_key, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false
      });

    if (storageError) {
      setState({
        filename: file.name,
        status: "error",
        error: storageError.message
      });
      return;
    }

    const { error: markError } = await supabase.rpc("mark_document_uploaded", {
      _byte_size: file.size,
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

    const { error: queueError } = await supabase.rpc("request_document_indexing", {
      _document_id: upload.document_id,
      _metadata: {
        source: "document_upload"
      }
    });

    fileInputRef.current?.form?.reset();
    setState({
      filename: file.name,
      queueError: queueError?.message,
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
          <strong>{state.queueError ? "Documento subido." : "Documento subido y en cola."}</strong>
          <span>
            {state.queueError
              ? `No se pudo poner en cola automáticamente: ${state.queueError}`
              : `${state.filename} quedó listo para SDA Tree Index.`}
          </span>
          <CheckCircle2 aria-hidden="true" size={16} />
        </div>
      ) : null}
    </form>
  );
}
