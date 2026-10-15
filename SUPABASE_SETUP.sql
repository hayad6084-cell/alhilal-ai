-- الهلال AI: persistent server-side storage for accounts, coins, projects, payments, and redeem codes.
-- Run this once in Supabase Dashboard > SQL Editor.
-- Keep SUPABASE_SECRET_KEY only in Vercel Environment Variables; never put it in index.html or GitHub.

create table if not exists public.app_documents (
  collection_path text not null,
  document_id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (collection_path, document_id)
);

alter table public.app_documents enable row level security;

-- No browser/public policies are intentionally created. The server-only secret key bypasses RLS.
revoke all on table public.app_documents from anon, authenticated;
grant all on table public.app_documents to service_role;

create index if not exists app_documents_collection_path_idx
  on public.app_documents (collection_path);
create index if not exists app_documents_updated_at_idx
  on public.app_documents (updated_at desc);
