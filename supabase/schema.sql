create extension if not exists pgcrypto;

create table if not exists public.qi_attempts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  buyer_name text not null,
  buyer_email text not null,
  answers jsonb not null,
  score integer not null,
  total integer not null default 25,
  pagbank_order_id text unique,
  payment_status text not null default 'PENDING',
  paid_at timestamptz
);

create index if not exists qi_attempts_order_id_idx on public.qi_attempts(pagbank_order_id);

alter table public.qi_attempts enable row level security;
-- A chave service_role fica somente no servidor. Nenhuma politica publica e necessaria.