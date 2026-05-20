import { documentIndexRequested, inngest } from "@/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";

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

    await step.run("record-compute-gateway-pending", async () => {
      const supabase = createAdminClient();
      const { error } = await supabase.from("indexing_events").insert({
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
      });

      if (error) {
        throw error;
      }
    });

    return {
      document_id: event.data.document_id,
      run_id: event.data.run_id,
      status: "gateway_pending"
    };
  }
);
