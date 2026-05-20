import { documentIndexRequested, inngest } from "@/inngest/client";
import {
  createComputeGatewayIndexJob,
  getSignedUrlTtlSeconds,
  isComputeGatewayConfigured,
  type ComputeGatewayIndexJobResponse
} from "@/lib/compute-gateway";
import { createAdminClient } from "@/lib/supabase/admin";

type DocumentForIndexing = {
  byte_size: number | null;
  filename: string;
  id: string;
  mime_type: string;
  r2_bucket: string;
  r2_key: string;
  tenant_id: string;
};

export const processDocumentIndex = inngest.createFunction(
  {
    id: "process-document-index",
    name: "Process Document Index",
    triggers: [documentIndexRequested]
  },
  async ({ event, step }) => {
    await step.run("record-orchestrator-received", async () => {
      const supabase = createAdminClient();
      const { error } = await supabase.from("indexing_events").insert({
        document_id: event.data.document_id,
        event_type: "indexing.orchestrator.received",
        metadata: {
          actor_id: event.data.actor_id,
          inngest_event_id: event.id,
          source: event.data.source
        },
        message: "Inngest recibio la corrida de indexacion",
        progress: 0,
        run_id: event.data.run_id,
        severity: "info",
        stage: "queued",
        tenant_id: event.data.tenant_id
      });

      if (error) {
        throw error;
      }
    });

    const document = await step.run("load-document-for-indexing", async () => {
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from("documents")
        .select("id, tenant_id, filename, mime_type, byte_size, r2_bucket, r2_key")
        .eq("id", event.data.document_id)
        .eq("tenant_id", event.data.tenant_id)
        .maybeSingle<DocumentForIndexing>();

      if (error) {
        throw error;
      }

      if (!data) {
        throw new Error("Documento no encontrado para indexacion.");
      }

      return data;
    });

    if (!isComputeGatewayConfigured()) {
      await step.run("record-compute-gateway-pending", async () => {
        const supabase = createAdminClient();
        const [{ error: eventError }, { error: documentError }] = await Promise.all([
          supabase.from("indexing_events").insert({
            document_id: event.data.document_id,
            event_type: "indexing.compute_gateway.pending",
            metadata: {
              expected_worker: "mineru",
              host: "srv-ia-01"
            },
            message: "Esperando Compute Gateway para ejecutar MinerU",
            progress: 0,
            run_id: event.data.run_id,
            severity: "info",
            stage: "queued",
            tenant_id: event.data.tenant_id
          }),
          supabase
            .from("documents")
            .update({
              status_reason: "Esperando Compute Gateway"
            })
            .eq("id", event.data.document_id)
            .eq("tenant_id", event.data.tenant_id)
        ]);

        if (eventError) {
          throw eventError;
        }

        if (documentError) {
          throw documentError;
        }
      });

      return {
        document_id: event.data.document_id,
        run_id: event.data.run_id,
        status: "gateway_pending"
      };
    }

    await step.run("record-compute-gateway-dispatching", async () => {
      const supabase = createAdminClient();
      const now = new Date().toISOString();
      const [{ error: runError }, { error: documentError }, { error: eventError }] =
        await Promise.all([
          supabase
            .from("indexing_runs")
            .update({
              error_message: null,
              progress: 5,
              stage: "extracting",
              started_at: now,
              status: "running"
            })
            .eq("id", event.data.run_id)
            .eq("tenant_id", event.data.tenant_id),
          supabase
            .from("documents")
            .update({
              status: "parsing",
              status_reason: "Enviando documento al Compute Gateway"
            })
            .eq("id", event.data.document_id)
            .eq("tenant_id", event.data.tenant_id),
          supabase.from("indexing_events").insert({
            document_id: event.data.document_id,
            event_type: "indexing.compute_gateway.dispatching",
            metadata: {
              expected_worker: "mineru",
              host: "srv-ia-01"
            },
            message: "Enviando documento al Compute Gateway",
            progress: 5,
            run_id: event.data.run_id,
            severity: "info",
            stage: "extracting",
            tenant_id: event.data.tenant_id
          })
        ]);

      if (runError) {
        throw runError;
      }

      if (documentError) {
        throw documentError;
      }

      if (eventError) {
        throw eventError;
      }
    });

    const gatewayJob = await (async (): Promise<ComputeGatewayIndexJobResponse> => {
      try {
        return await step.run("create-compute-gateway-job", async () => {
          const supabase = createAdminClient();
          const { data: signedUrl, error: signedUrlError } = await supabase.storage
            .from(document.r2_bucket)
            .createSignedUrl(document.r2_key, getSignedUrlTtlSeconds());

          if (signedUrlError) {
            throw signedUrlError;
          }

          if (!signedUrl?.signedUrl) {
            throw new Error("No se pudo firmar el documento para el Compute Gateway.");
          }

          return createComputeGatewayIndexJob({
            document: {
              byte_size: document.byte_size,
              filename: document.filename,
              mime_type: document.mime_type,
              r2_bucket: document.r2_bucket,
              r2_key: document.r2_key,
              signed_url: signedUrl.signedUrl
            },
            document_id: event.data.document_id,
            run_id: event.data.run_id,
            source: event.data.source,
            tenant_id: event.data.tenant_id
          });
        });
      } catch (dispatchError) {
        await step.run("record-compute-gateway-dispatch-failed", async () => {
          const supabase = createAdminClient();
          const message =
            dispatchError instanceof Error
              ? dispatchError.message
              : "No se pudo crear el job en Compute Gateway.";
          const [{ error: runError }, { error: documentError }, { error: eventError }] =
            await Promise.all([
              supabase
                .from("indexing_runs")
                .update({
                  error_message: message,
                  progress: 5,
                  stage: "extracting",
                  status: "running"
                })
                .eq("id", event.data.run_id)
                .eq("tenant_id", event.data.tenant_id),
              supabase
                .from("documents")
                .update({
                  status: "parsing",
                  status_reason: "Compute Gateway no recibio el job; Inngest puede reintentar"
                })
                .eq("id", event.data.document_id)
                .eq("tenant_id", event.data.tenant_id),
              supabase.from("indexing_events").insert({
                document_id: event.data.document_id,
                event_type: "indexing.compute_gateway.dispatch_failed",
                metadata: {
                  retry_owner: "inngest"
                },
                message,
                progress: 5,
                run_id: event.data.run_id,
                severity: "error",
                stage: "extracting",
                tenant_id: event.data.tenant_id
              })
            ]);

          if (runError) {
            throw runError;
          }

          if (documentError) {
            throw documentError;
          }

          if (eventError) {
            throw eventError;
          }
        });

        throw dispatchError;
      }
    })();

    await step.run("record-compute-gateway-job-created", async () => {
      const supabase = createAdminClient();
      const [{ error: runError }, { error: documentError }, { error: eventError }] =
        await Promise.all([
          supabase
            .from("indexing_runs")
            .update({
              compute_job_id: gatewayJob.job_id,
              error_message: null,
              progress: 8,
              stage: "extracting",
              status: "running"
            })
            .eq("id", event.data.run_id)
            .eq("tenant_id", event.data.tenant_id),
          supabase
            .from("documents")
            .update({
              status: "parsing",
              status_reason: "Compute Gateway ejecutando MinerU"
            })
            .eq("id", event.data.document_id)
            .eq("tenant_id", event.data.tenant_id),
          supabase.from("indexing_events").insert({
            document_id: event.data.document_id,
            event_type: "indexing.compute_gateway.job_created",
            metadata: {
              gateway_status: gatewayJob.status,
              job_id: gatewayJob.job_id
            },
            message: "Compute Gateway recibio el job de MinerU",
            progress: 8,
            run_id: event.data.run_id,
            severity: "info",
            stage: "extracting",
            tenant_id: event.data.tenant_id
          })
        ]);

      if (runError) {
        throw runError;
      }

      if (documentError) {
        throw documentError;
      }

      if (eventError) {
        throw eventError;
      }
    });

    return {
      compute_job_id: gatewayJob.job_id,
      document_id: event.data.document_id,
      run_id: event.data.run_id,
      status: "compute_job_created"
    };
  }
);
