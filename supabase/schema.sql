-- 찬양대 연습노트 : Supabase 스키마
-- Supabase 대시보드 → SQL Editor 에 통째로 붙여 넣고 Run 하세요. 여러 번 실행해도 안전합니다.

-- 1) 테이블 ---------------------------------------------------------------

create table if not exists public.settings (
  id          int primary key default 1 check (id = 1),   -- 한 줄만 사용
  choir_name  text not null default '우리 찬양대',
  notice      text not null default '',
  updated_at  timestamptz not null default now()
);

create table if not exists public.songs (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  composer    text not null default '',
  publisher   text not null default '',
  collection  text not null default '',
  page        text not null default '',
  level       text not null default '중' check (level in ('하','중하','중','중상','상')),
  memo        text not null default '',
  -- {"key","meter","tempo","voicing","measures","notes"}
  analysis    jsonb not null default '{}'::jsonb,
  -- {"all":{"audio","youtube","source"},"S":{...},"A":{...},"T":{...},"B":{...}}
  parts       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.services (
  id          uuid primary key default gen_random_uuid(),
  date        date not null,
  slot        text not null default '낮예배',
  song_id     uuid not null references public.songs(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index if not exists services_date_idx on public.services(date);

-- 편집 권한을 줄 계정의 이메일 목록
create table if not exists public.editors (
  email       text primary key,
  created_at  timestamptz not null default now()
);

-- 2) 편집자 확인 함수 ------------------------------------------------------

create or replace function public.is_editor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.editors
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
grant execute on function public.is_editor() to anon, authenticated;

-- 3) 테이블 접근 권한 ---------------------------------------------------------
-- 2026년 5월 30일 이후 만든 Supabase 프로젝트는 새 테이블에 권한이 자동으로 주어지지 않습니다.
-- 아래 GRANT가 없으면 앱에서 "permission denied for table" 오류가 납니다.
-- 실제로 누가 쓸 수 있는지는 4)의 행 단위 보안 규칙이 결정합니다 (편집자만 쓰기).
grant usage on schema public to anon, authenticated;
grant select on public.settings, public.songs, public.services to anon;
grant select, insert, update, delete on public.settings, public.songs, public.services to authenticated;
-- editors 표는 일부러 권한을 주지 않습니다 (대시보드에서만 관리).

-- 4) 행 단위 보안: 누구나 읽기, 편집자만 쓰기 ----------------------------------

alter table public.settings enable row level security;
alter table public.songs    enable row level security;
alter table public.services enable row level security;
alter table public.editors  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['settings','songs','services'] loop
    execute format('drop policy if exists "%1$s_read" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_insert" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_update" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_delete" on public.%1$s', t);
    execute format('create policy "%1$s_read"   on public.%1$s for select to anon, authenticated using (true)', t);
    execute format('create policy "%1$s_insert" on public.%1$s for insert to authenticated with check (public.is_editor())', t);
    execute format('create policy "%1$s_update" on public.%1$s for update to authenticated using (public.is_editor()) with check (public.is_editor())', t);
    execute format('create policy "%1$s_delete" on public.%1$s for delete to authenticated using (public.is_editor())', t);
  end loop;
end $$;

-- editors 표는 앱에서 읽거나 쓰지 않습니다 (대시보드에서만 관리). 정책이 없으므로 앱에서는 접근 불가.

-- 5) 기본 설정 한 줄 ---------------------------------------------------------

insert into public.settings (id, choir_name, notice)
values (1, '할렐루야 찬양대', '')
on conflict (id) do nothing;
