import { redirect } from "next/navigation";

// The document detail now lives in the glass workspace (3-pane view).
export default async function LegacyDocumentDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/app/workspace/documents/${id}`);
}
