import { inngest, treeGraphNodeEvent } from "@/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";

export const recordTreeGraphEvent = inngest.createFunction(
  {
    id: "record-tree-graph-event",
    name: "Record Tree Graph Event",
    triggers: [treeGraphNodeEvent]
  },
  async ({ event }) => {
    const data = event.data;
    const supabase = createAdminClient();
    const { error } = await supabase.from("indexing_events").insert({
      document_id: data.document_id,
      event_type: `indexing.tree.${data.node}.${data.status}`,
      metadata: {
        ...(data.metadata ?? {}),
        job_id: data.job_id,
        node: data.node,
        status: data.status
      },
      message: data.message,
      progress: data.progress,
      run_id: data.run_id,
      severity: data.status === "failed" ? "error" : "info",
      stage: data.stage,
      tenant_id: data.tenant_id
    });

    if (error) {
      throw error;
    }

    return {
      document_id: data.document_id,
      node: data.node,
      run_id: data.run_id,
      status: data.status
    };
  }
);
