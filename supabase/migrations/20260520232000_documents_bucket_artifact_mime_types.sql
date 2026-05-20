update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/json',
  'image/jpeg',
  'image/png',
  'application/octet-stream',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword'
]
where id = 'documents';
