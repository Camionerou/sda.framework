import { serve } from "inngest/next";

import { inngest } from "@/inngest/client";
import { processDocumentIndex } from "@/inngest/functions/process-document-index";

export const runtime = "nodejs";
export const maxDuration = 60;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [processDocumentIndex],
  streaming: true
});
