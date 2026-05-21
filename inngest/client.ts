import { eventType, Inngest, staticSchema } from "inngest";

import { getInngestRuntimeConfig } from "@/lib/platform/server";

export type DocumentIndexRequestedEvent = {
  actor_id: string;
  document_id: string;
  run_id: string;
  source: string;
  tenant_id: string;
};

export type TreeGraphNodeEvent = {
  document_id: string;
  job_id: string;
  message: string;
  metadata?: Record<string, unknown>;
  node: string;
  progress: number;
  run_id: string;
  stage: string;
  status: string;
  tenant_id: string;
};

export const documentIndexRequested = eventType("document/index.requested", {
  schema: staticSchema<DocumentIndexRequestedEvent>()
});

export const treeGraphNodeEvent = eventType("indexing/tree.node", {
  schema: staticSchema<TreeGraphNodeEvent>()
});

const inngestConfig = getInngestRuntimeConfig();

export const inngest = new Inngest({
  appVersion: inngestConfig.appVersion,
  id: inngestConfig.id,
  isDev: inngestConfig.isDev
});

export function canDispatchInngestEvents() {
  return inngestConfig.canDispatchEvents;
}
