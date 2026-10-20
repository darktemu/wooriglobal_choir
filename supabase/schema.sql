-- 찬양대 연습노트 : Supabase 스키마 (여러 성가대 · 로그인 필수 · 자동 승인)
--
-- Supabase 대시보드 → SQL Editor 에 통째로 붙여 넣고 Run 하세요.
-- 처음 설치할 때도, 예전 버전(성가대 1개)을 쓰던 프로젝트에서도 그대로 실행하면 됩니다.
-- 여러 번 실행해도 안전합니다.
--
-- 역할
--   admin  : 성가대를 만든 사람. 선곡·곡·공지 편집 + 대원 역할 변경·내보내기
--   editor : 선곡·곡·공지 편집
--   member : 보기 (가입하면 자동으로 member)

-- 1) 테이블 ---------------------------------------------------------------

create table if not exists public.choirs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  notice      text not null default '',
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null default '',
  part          text not null default 'all' check (part in ('all','S','A','T','B')),
  choir_id      uuid references public.choirs(id) on delete set null,   -- 지금 보고 있는 성가대
  updated_at    timestamptz not null default now()
);

create table if not exists public.memberships (
  choir_id   uuid not null references public.choirs(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       text not null default 'member' check (role in ('admin','editor','member')),
  joined_at  timestamptz not null default now(),
  primary key (choir_id, user_id)
);
create index if not exists memberships_user_idx on public.memberships(user_id);

create table if not exists public.songs (
  id          uuid primary key default gen_random_uuid(),
  choir_id    uuid references public.choirs(id) on delete cascade,
  title       text not null,
  composer    text not null default '',
  publisher   text not null default '',
  collection  text not null default '',
  page        text not null default '',
  level       text not null default '중' check (level in ('하','중하','중','중상','상')),
  memo        text not null default '',
  analysis    jsonb not null default '{}'::jsonb,
  parts       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.services (
  id          uuid primary key default gen_random_uuid(),
  choir_id    uuid references public.choirs(id) on delete cascade,
  date        date not null,
  slot        text not null default '낮예배',
  song_id     uuid not null references public.songs(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- 예전 버전 테이블에 성가대 칸 추가
alter table public.songs    add column if not exists choir_id uuid references public.choirs(id) on delete cascade;
alter table public.services add column if not exists choir_id uuid references public.choirs(id) on delete cascade;

-- 2) 가입하면 프로필 자동 생성 ------------------------------------------------

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, part)
  values (
    new.id,
    coalesce(nullif(btrim(new.raw_user_meta_data->>'display_name'), ''), split_part(new.email, '@', 1)),
    case when new.raw_user_meta_data->>'part' in ('all','S','A','T','B') then new.raw_user_meta_data->>'part' else 'all' end
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 이미 가입한 계정의 프로필 만들기
insert into public.profiles (id, display_name)
select u.id, coalesce(nullif(btrim(u.raw_user_meta_data->>'display_name'), ''), split_part(u.email, '@', 1))
from auth.users u
on conflict (id) do nothing;

-- 3) 예전 버전 데이터 이전 (성가대 1개 → 첫 번째 성가대) -----------------------

do $$
declare
  v_choir  uuid;
  v_name   text;
  v_notice text;
begin
  if exists (select 1 from public.songs where choir_id is null)
     or exists (select 1 from public.services where choir_id is null) then

    if to_regclass('public.settings') is not null then
      execute 'select choir_name, notice from public.settings where id = 1' into v_name, v_notice;
    end if;

    insert into public.choirs (name, notice)
    values (coalesce(nullif(btrim(v_name), ''), '우리 찬양대'), coalesce(v_notice, ''))
    returning id into v_choir;

    update public.songs    set choir_id = v_choir where choir_id is null;
    update public.services set choir_id = v_choir where choir_id is null;

    -- 예전 편집자 → 이 성가대의 관리자
    if to_regclass('public.editors') is not null then
      execute $q$
        insert into public.memberships (choir_id, user_id, role)
        select $1, u.id, 'admin'
        from auth.users u join public.editors e on lower(e.email) = lower(u.email)
        on conflict (choir_id, user_id) do update set role = 'admin'
      $q$ using v_choir;
      update public.choirs set created_by = (
        select m.user_id from public.memberships m where m.choir_id = v_choir order by m.joined_at limit 1)
      where id = v_choir;
    end if;

    update public.profiles p set choir_id = v_choir
    where p.choir_id is null
      and exists (select 1 from public.memberships m where m.user_id = p.id and m.choir_id = v_choir);
  end if;
end $$;

alter table public.songs    alter column choir_id set not null;
alter table public.services alter column choir_id set not null;
create index if not exists songs_choir_idx         on public.songs(choir_id);
create index if not exists services_choir_date_idx on public.services(choir_id, date);

-- 4) 권한 확인 함수 ----------------------------------------------------------

create or replace function public.my_role(c uuid)
returns text language sql stable security definer set search_path = public as $$
  select role from public.memberships where choir_id = c and user_id = auth.uid();
$$;

create or replace function public.is_member(c uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships where choir_id = c and user_id = auth.uid());
$$;

create or replace function public.can_edit(c uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role(c) in ('admin','editor'), false);
$$;

create or replace function public.shares_choir(other uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships a
    join public.memberships b on a.choir_id = b.choir_id
    where a.user_id = auth.uid() and b.user_id = other
  );
$$;

-- 5) 앱에서 부르는 기능 -------------------------------------------------------

-- 성가대 목록 (가입 전에도 이름과 인원만 보임)
create or replace function public.list_choirs()
returns table (id uuid, name text, member_count bigint, is_member boolean, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, count(m.user_id), coalesce(bool_or(m.user_id = auth.uid()), false), c.created_at
  from public.choirs c
  left join public.memberships m on m.choir_id = c.id
  where auth.uid() is not null
  group by c.id
  order by c.name, c.created_at;
$$;

-- 성가대 만들기: 만든 사람이 관리자
create or replace function public.create_choir(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 60 then raise exception 'invalid_name'; end if;
  insert into public.profiles (id) values (auth.uid()) on conflict (id) do nothing;
  insert into public.choirs (name, created_by) values (btrim(p_name), auth.uid()) returning id into v_id;
  insert into public.memberships (choir_id, user_id, role) values (v_id, auth.uid(), 'admin');
  update public.profiles set choir_id = v_id, updated_at = now() where id = auth.uid();
  return v_id;
end $$;

-- 성가대 가입·이동: 자동 승인
create or replace function public.join_choir(p_choir uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not exists (select 1 from public.choirs where id = p_choir) then raise exception 'choir_not_found'; end if;
  insert into public.profiles (id) values (auth.uid()) on conflict (id) do nothing;
  insert into public.memberships (choir_id, user_id, role) values (p_choir, auth.uid(), 'member')
    on conflict (choir_id, user_id) do nothing;
  update public.profiles set choir_id = p_choir, updated_at = now() where id = auth.uid();
end $$;

-- 성가대 탈퇴 (다른 대원이 남아 있는데 마지막 관리자면 막음)
create or replace function public.leave_choir(p_choir uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if public.my_role(p_choir) = 'admin'
     and not exists (select 1 from public.memberships where choir_id = p_choir and role = 'admin' and user_id <> auth.uid())
     and exists (select 1 from public.memberships where choir_id = p_choir and user_id <> auth.uid()) then
    raise exception 'last_admin';
  end if;
  delete from public.memberships where choir_id = p_choir and user_id = auth.uid();
  update public.profiles set choir_id = null, updated_at = now() where id = auth.uid() and choir_id = p_choir;
end $$;

-- 대원 역할 바꾸기 (관리자만, 자기 자신은 제외)
create or replace function public.set_member_role(p_choir uuid, p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.my_role(p_choir) is distinct from 'admin' then raise exception 'not_admin'; end if;
  if p_user = auth.uid() then raise exception 'cannot_change_self'; end if;
  if p_role not in ('admin','editor','member') then raise exception 'invalid_role'; end if;
  update public.memberships set role = p_role where choir_id = p_choir and user_id = p_user;
end $$;

-- 대원 내보내기 (관리자만, 자기 자신은 제외)
create or replace function public.remove_member(p_choir uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.my_role(p_choir) is distinct from 'admin' then raise exception 'not_admin'; end if;
  if p_user = auth.uid() then raise exception 'cannot_change_self'; end if;
  delete from public.memberships where choir_id = p_choir and user_id = p_user;
  update public.profiles set choir_id = null, updated_at = now() where id = p_user and choir_id = p_choir;
end $$;

-- 6) 테이블 접근 권한 (로그인한 사용자만) ----------------------------------------
-- 2026년 5월 30일 이후 만든 Supabase 프로젝트는 GRANT가 자동으로 주어지지 않습니다.

grant usage on schema public to authenticated;
revoke all on public.choirs, public.profiles, public.memberships, public.songs, public.services from anon;
grant select on public.choirs to authenticated;
grant update (name, notice, updated_at) on public.choirs to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select on public.memberships to authenticated;
grant select, insert, update, delete on public.songs, public.services to authenticated;

revoke execute on function
  public.my_role(uuid), public.is_member(uuid), public.can_edit(uuid), public.shares_choir(uuid),
  public.list_choirs(), public.create_choir(text), public.join_choir(uuid), public.leave_choir(uuid),
  public.set_member_role(uuid, uuid, text), public.remove_member(uuid, uuid)
  from public, anon;
grant execute on function
  public.my_role(uuid), public.is_member(uuid), public.can_edit(uuid), public.shares_choir(uuid),
  public.list_choirs(), public.create_choir(text), public.join_choir(uuid), public.leave_choir(uuid),
  public.set_member_role(uuid, uuid, text), public.remove_member(uuid, uuid)
  to authenticated;

-- 7) 행 단위 보안 -------------------------------------------------------------

alter table public.choirs      enable row level security;
alter table public.profiles    enable row level security;
alter table public.memberships enable row level security;
alter table public.songs       enable row level security;
alter table public.services    enable row level security;

drop policy if exists "choirs_read"   on public.choirs;
drop policy if exists "choirs_update" on public.choirs;
create policy "choirs_read"   on public.choirs for select to authenticated using (public.is_member(id));
create policy "choirs_update" on public.choirs for update to authenticated using (public.can_edit(id)) with check (public.can_edit(id));

drop policy if exists "profiles_read"   on public.profiles;
drop policy if exists "profiles_insert" on public.profiles;
drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_read"   on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_choir(id));
create policy "profiles_insert" on public.profiles for insert to authenticated
  with check (id = auth.uid());
create policy "profiles_update" on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and (choir_id is null or public.is_member(choir_id)));

drop policy if exists "memberships_read" on public.memberships;
create policy "memberships_read" on public.memberships for select to authenticated using (public.is_member(choir_id));

do $$
declare t text;
begin
  foreach t in array array['songs','services'] loop
    execute format('drop policy if exists "%1$s_read" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_insert" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_update" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_delete" on public.%1$s', t);
    execute format('create policy "%1$s_read"   on public.%1$s for select to authenticated using (public.is_member(choir_id))', t);
    execute format('create policy "%1$s_update" on public.%1$s for update to authenticated using (public.can_edit(choir_id)) with check (public.can_edit(choir_id))', t);
    execute format('create policy "%1$s_delete" on public.%1$s for delete to authenticated using (public.can_edit(choir_id))', t);
  end loop;
end $$;
create policy "songs_insert" on public.songs for insert to authenticated
  with check (public.can_edit(choir_id));
create policy "services_insert" on public.services for insert to authenticated
  with check (public.can_edit(choir_id)
              and exists (select 1 from public.songs s where s.id = song_id and s.choir_id = services.choir_id));

-- 8) 예전 버전 정리 ----------------------------------------------------------
-- settings·editors 표는 더 이상 쓰지 않습니다. 데이터는 남겨 두고 앱에서만 막습니다.

do $$
begin
  if to_regclass('public.settings') is not null then
    execute 'drop policy if exists "settings_read" on public.settings';
    execute 'drop policy if exists "settings_insert" on public.settings';
    execute 'drop policy if exists "settings_update" on public.settings';
    execute 'drop policy if exists "settings_delete" on public.settings';
    execute 'revoke all on public.settings from anon, authenticated';
  end if;
  if to_regclass('public.editors') is not null then
    execute 'revoke all on public.editors from anon, authenticated';
  end if;
end $$;
drop function if exists public.is_editor();
