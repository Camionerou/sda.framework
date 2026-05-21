import { eventType, Inngest, staticSchema } from "inngest";

import { SYSTEM_COMPONENT_VERSIONS } from "@/lib/system-versions";

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

export const inngest = new Inngest({
  appVersion:
    process.env.INNGEST_APP_VERSION ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GITHUB_SHA ??
    SYSTEM_COMPONENT_VERSIONS.app,
  id: "sda-framework",
  isDev: process.env.INNGEST_DEV === "1" || (
    process.env.NODE_ENV !== "production" && !process.env.INNGEST_SIGNING_KEY
  )
});

export function canDispatchInngestEvents() {
  return process.env.INNGEST_DEV === "1" || Boolean(process.env.INNGEST_EVENT_KEY);
}
