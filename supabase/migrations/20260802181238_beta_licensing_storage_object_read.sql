-- Permit known-object retrieval through publishable clients while excluding
-- list operations from the SELECT policy. The bucket remains public for CDN
-- object URLs, but listing is not an application capability.
drop policy if exists "compazio_releases_public_object_read" on storage.objects;

create policy "compazio_releases_public_object_read"
on storage.objects
for select
to anon, authenticated
using (
  bucket_id = 'compazio-releases'
  and storage.allow_any_operation(array['object.get_authenticated_info', 'object.get_authenticated'])
);
