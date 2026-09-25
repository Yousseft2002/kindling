-- Kindling community: shared evenings, reactions, reports, local guides.
--
-- Paste this whole file into Supabase > SQL Editor > New query > Run. It is
-- safe to run again: every object is created "if not exists" or replaced.
--
-- The site talks to these tables straight from the browser with the public
-- anon key, so row-level security is the only thing standing between a
-- visitor and the data. Every table has it on, and every rule is written
-- down here rather than clicked together in the dashboard.

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 2 and 32),
  home_city    text check (home_city is null or char_length(home_city) <= 80),
  created_at   timestamptz not null default now()
);

-- One "Maria" per site, whatever the capitals - otherwise anyone can pose as
-- a local guide by copying their name.
create unique index if not exists profiles_name_unique
  on public.profiles (lower(btrim(display_name)));

alter table public.profiles enable row level security;

drop policy if exists "profiles are public" on public.profiles;
create policy "profiles are public" on public.profiles
  for select using (true);

drop policy if exists "you create your own profile" on public.profiles;
create policy "you create your own profile" on public.profiles
  for insert to authenticated with check (id = auth.uid());

drop policy if exists "you edit your own profile" on public.profiles;
create policy "you edit your own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- Evenings
-- ---------------------------------------------------------------------------

-- What a stop in a shared evening looks like. Checked in the database, not
-- only in the form, because the form is not the only thing that can post.
create or replace function public.valid_stops(stops jsonb)
returns boolean language sql immutable as $$
  select jsonb_typeof(stops) = 'array'
     and jsonb_array_length(stops) between 2 and 6
     and not exists (
       select 1 from jsonb_array_elements(stops) s
       where jsonb_typeof(s) <> 'object'
          or jsonb_typeof(s -> 'name') <> 'string'
          or char_length(btrim(s ->> 'name')) not between 1 and 80
          or coalesce(s ->> 'kind', '') not in
             ('drinks', 'coffee', 'food', 'music', 'show', 'activity',
              'aquarium', 'viewpoint', 'shopping')
          or char_length(coalesce(s ->> 'note', '')) > 280
          or (s ? 'lat' and jsonb_typeof(s -> 'lat') not in ('number', 'null'))
          or (s ? 'lon' and jsonb_typeof(s -> 'lon') not in ('number', 'null'))
     )
$$;

create table if not exists public.itineraries (
  id           uuid primary key default gen_random_uuid(),
  author_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title        text not null check (char_length(btrim(title)) between 4 and 80),
  city         text not null check (char_length(btrim(city)) between 1 and 80),
  region       text not null default '' check (char_length(region) <= 120),
  city_key     text generated always as (lower(btrim(city)) || '|' || lower(btrim(region))) stored,
  lat          double precision not null check (lat between -90 and 90),
  lon          double precision not null check (lon between -180 and 180),
  stage        text check (stage is null or stage in
                 ('first_date', 'getting_to_know', 'dating', 'long_term', 'special_occasion')),
  budget       numeric check (budget is null or budget between 0 and 100000),
  currency     text check (currency is null or currency ~ '^[A-Z]{3,4}$'),
  stops        jsonb not null check (public.valid_stops(stops)),
  tips         text not null default '' check (char_length(tips) <= 600),
  love_count   integer not null default 0,
  report_count integer not null default 0,
  hidden       boolean not null default false,
  created_at   timestamptz not null default now()
);

create index if not exists itineraries_place on public.itineraries (lat, lon) where not hidden;
create index if not exists itineraries_author on public.itineraries (author_id, created_at desc);

alter table public.itineraries enable row level security;

-- Hidden posts vanish for everyone but their author, who can still delete one.
drop policy if exists "visible evenings are public" on public.itineraries;
create policy "visible evenings are public" on public.itineraries
  for select using (not hidden or author_id = auth.uid());

drop policy if exists "you post as yourself" on public.itineraries;
create policy "you post as yourself" on public.itineraries
  for insert to authenticated with check (author_id = auth.uid());

drop policy if exists "you delete your own" on public.itineraries;
create policy "you delete your own" on public.itineraries
  for delete to authenticated using (author_id = auth.uid());

-- No update policy on purpose: to change an evening, delete it and post it
-- again. That keeps the counters below out of anyone's reach.

-- The counters and the hidden flag belong to the database. Whatever a post
-- arrives with, it starts at zero, visible, now, and yours - and nobody posts
-- more than five evenings a day.
create or replace function public.itineraries_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.author_id    := auth.uid();
  new.love_count   := 0;
  new.report_count := 0;
  new.hidden       := false;
  new.created_at   := now();
  if (select count(*) from public.itineraries
      where author_id = new.author_id and created_at > now() - interval '1 day') >= 5 then
    raise exception 'You can share five evenings a day. Try again tomorrow.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists itineraries_before_insert on public.itineraries;
create trigger itineraries_before_insert before insert on public.itineraries
  for each row execute function public.itineraries_before_insert();

-- ---------------------------------------------------------------------------
-- Reactions: one "love" per person per evening, never your own
-- ---------------------------------------------------------------------------

create table if not exists public.reactions (
  itinerary_id uuid not null references public.itineraries (id) on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (itinerary_id, user_id)
);

alter table public.reactions enable row level security;

-- Who loved what is nobody's business: the counts are on the evenings, and
-- the page only ever needs to know which ones you loved yourself.
drop policy if exists "reactions are public" on public.reactions;
drop policy if exists "you see your own reactions" on public.reactions;
create policy "you see your own reactions" on public.reactions
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "you react as yourself, not to yourself" on public.reactions;
create policy "you react as yourself, not to yourself" on public.reactions
  for insert to authenticated with check (
    user_id = auth.uid()
    and not exists (select 1 from public.itineraries i
                    where i.id = itinerary_id and i.author_id = auth.uid())
  );

drop policy if exists "you take back your own" on public.reactions;
create policy "you take back your own" on public.reactions
  for delete to authenticated using (user_id = auth.uid());

create or replace function public.reactions_count()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.itineraries set love_count = love_count + 1 where id = new.itinerary_id;
  else
    update public.itineraries set love_count = greatest(0, love_count - 1) where id = old.itinerary_id;
  end if;
  return null;
end $$;

drop trigger if exists reactions_count on public.reactions;
create trigger reactions_count after insert or delete on public.reactions
  for each row execute function public.reactions_count();

-- ---------------------------------------------------------------------------
-- Reports: three and a post is hidden until you look at it
-- ---------------------------------------------------------------------------

create table if not exists public.reports (
  itinerary_id uuid not null references public.itineraries (id) on delete cascade,
  reporter_id  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  reason       text not null default '' check (char_length(reason) <= 280),
  created_at   timestamptz not null default now(),
  primary key (itinerary_id, reporter_id)
);

alter table public.reports enable row level security;

-- Reports can be made but not read from the site. You read them in the
-- dashboard (Table editor > reports), which is not subject to these rules.
drop policy if exists "you report as yourself" on public.reports;
create policy "you report as yourself" on public.reports
  for insert to authenticated with check (reporter_id = auth.uid());

create or replace function public.reports_hide()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.itineraries i
     set report_count = r.n, hidden = i.hidden or r.n >= 3
    from (select count(*)::int as n from public.reports where itinerary_id = new.itinerary_id) r
   where i.id = new.itinerary_id;
  return null;
end $$;

drop trigger if exists reports_hide on public.reports;
create trigger reports_hide after insert on public.reports
  for each row execute function public.reports_hide();

-- ---------------------------------------------------------------------------
-- Local guides: at least 3 evenings in a city and 10 loves across them
-- ---------------------------------------------------------------------------

create or replace view public.guide_scores with (security_invoker = on) as
select i.author_id,
       i.city_key,
       min(i.city)                  as city,
       min(i.region)                as region,
       avg(i.lat)                   as lat,
       avg(i.lon)                   as lon,
       count(*)::int                as posts,
       sum(i.love_count)::int       as loves,
       (count(*) >= 3 and sum(i.love_count) >= 10) as is_guide
  from public.itineraries i
 where not i.hidden
 group by i.author_id, i.city_key;

create or replace view public.city_leaders with (security_invoker = on) as
select g.*, p.display_name
  from public.guide_scores g
  join public.profiles p on p.id = g.author_id;

-- What the Community tab and the planner read: visible evenings with their
-- author's name and whether they are a guide in that city.
create or replace view public.feed with (security_invoker = on) as
select i.id, i.title, i.city, i.region, i.city_key, i.lat, i.lon, i.stage,
       i.budget, i.currency, i.stops, i.tips, i.love_count, i.created_at,
       i.author_id, p.display_name as author_name,
       coalesce(g.is_guide, false) as author_is_guide
  from public.itineraries i
  join public.profiles p on p.id = i.author_id
  left join public.guide_scores g on g.author_id = i.author_id and g.city_key = i.city_key
 where not i.hidden;

grant select on public.guide_scores, public.city_leaders, public.feed to anon, authenticated;
