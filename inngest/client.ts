import { eventType, Inngest, staticSchema } from "inngest";

import { getInngestRuntimeConfig } from "@/lib/platform/server";

export type DocumentIndexRequestedEvent = {
  actor_id: string;
  document_id: string;
  run_id: string;
  source: string;
  tenant_id: string;
};

export const documentIndexRequested = eventType("document/index.requested", {
  schema: staticSchema<DocumentIndexRequestedEvent>()
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
