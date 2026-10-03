-- Erinnerungen als Mitteilung (Web Push), v63.
-- push_config: genau eine Zeile. vapid_jwk (privater Schluessel) erzeugt die Edge
-- Function punkto-push beim ersten Aufruf selbst; cron_key schuetzt die Aktion "tick".
create table if not exists punkto.push_config (
  id int primary key check (id = 1),
  vapid_jwk jsonb,
  vapid_pub text,
  cron_key text not null default encode(extensions.gen_random_bytes(32), 'hex'),
  created_at timestamptz not null default now()
);
insert into punkto.push_config (id) values (1) on conflict (id) do nothing;

create table if not exists punkto.push_subs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references punkto.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  tz text not null default 'Europe/Berlin',
  at_min int not null default 1140 check (at_min between 0 and 1380),   -- Ortszeit in Minuten (19:00)
  diary_on boolean not null default true,
  weigh_on boolean not null default true,
  last_run date,              -- Kalendertag (Ortszeit) der letzten Bewertung
  last_weigh_sent date,
  last_test_at timestamptz,
  fails int not null default 0,
  last_status int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_subs_endpoint_key unique (endpoint)
);
create index if not exists push_subs_user_idx on punkto.push_subs (user_id);

-- Kein Zugriff ueber die oeffentliche API: RLS an, keine Policies, Rechte entzogen.
alter table punkto.push_config enable row level security;
alter table punkto.push_subs enable row level security;
revoke all on punkto.push_config, punkto.push_subs from anon, authenticated;
grant all on punkto.push_config, punkto.push_subs to service_role;

-- Zeitplan: alle 15 Minuten die Edge Function anstossen (Schluessel kommt aus der Tabelle).
select cron.unschedule('punkto-push-tick') where exists (select 1 from cron.job where jobname = 'punkto-push-tick');
select cron.schedule('punkto-push-tick', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://xeuexovdipdiiuzjpzkj.supabase.co/functions/v1/punkto-push',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-key', (select cron_key from punkto.push_config where id = 1)),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 30000)
$$);
