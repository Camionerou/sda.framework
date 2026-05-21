alter function public.create_document_upload(text, text, bigint, text, jsonb, text)
  security definer;

alter function public.mark_document_uploaded(uuid, bigint, text)
  security definer;

alter function public.mark_document_upload_failed(uuid, text)
  security definer;

drop policy if exists documents_insert_tenant on public.documents;
drop policy if exists documents_update_tenant on public.documents;

revoke all privileges on public.documents from authenticated;
grant select on public.documents to authenticated;
