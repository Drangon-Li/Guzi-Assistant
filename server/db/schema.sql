-- Guzi Assistant 托管后端数据模型（#41 账号+计费+收付款 / #56 积分模型）
-- 目标库：Supabase（Postgres）。落 server/billing/credits.ts(#63) 的 CreditState + chpay 参考数据模型。
-- 金额一律存「分」(integer)，对 chpay 平台才换「元」。积分账本与 credits.ts 字段一一对应。
-- RLS：用户只读自己；写入/扣费一律走 service-role 后端（绕 RLS），客户端不直接改余额。
-- 应用前提：owner 给齐管理 PAT / DDL 权限（当前 supabase-eshell MCP 仅数据面，建表需 DDL）。

-- ── 用户档案（Supabase auth.users 之上的应用层）────────────────────────────
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at  timestamptz not null default now()
);

-- ── 积分余额（对应 credits.ts CreditState：grant 当月赠送/到期清，purchased 不过期）──
create table if not exists public.credits (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  grant_balance   integer not null default 0,    -- 当月赠送余额（到期清零）
  grant_reset_at  timestamptz not null,           -- 赠送下次重置时间
  purchased_balance integer not null default 0,   -- 购买余额（长期有效）
  monthly_grant   integer not null default 1000,  -- 会员每月赠送（#56 推荐 1000，按档调）
  updated_at      timestamptz not null default now()
);

-- ── 积分流水（每次扣费/赠送/充值各一行，可追溯=#56「可见」心安项）──────────────
create table if not exists public.credit_ledger (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  delta       integer not null,                   -- 负=扣费、正=赠送/充值
  reason      text not null,                      -- 'chat'|'parse_text'|'parse_vision'|'monitor_trigger'|'grant'|'purchase'
  balance_after integer not null,                 -- 记账后总余额（grant+purchased）
  ref_order   text,                               -- 关联订单（充值时）
  created_at  timestamptz not null default now()
);
create index if not exists credit_ledger_user_idx on public.credit_ledger (user_id, created_at desc);

-- ── chpay 订单（充值积分/会员；out_trade_no 自生成，金额存分）──────────────────
create table if not exists public.orders (
  out_trade_no text primary key,                  -- 自生成内部订单号
  user_id      uuid not null references auth.users (id) on delete cascade,
  amount_cents integer not null,                  -- 支付金额（分）
  kind         text not null,                     -- 'credits'(积分包) | 'membership'(会员)
  credits      integer,                           -- 积分包：到账积分；会员：null
  plan         text,                              -- 会员档位标识（如 'monthly'），积分包：null
  pay_type     text not null,                     -- 'alipay' | 'wxpay'
  status       text not null default 'pending',   -- 'pending' | 'paid' | 'failed'
  trade_no     text,                              -- 平台流水号（回调带回）
  paid_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists orders_user_idx on public.orders (user_id, created_at desc);

-- ── RLS：用户只读自己的行；所有写入走 service-role 后端 ─────────────────────────
alter table public.profiles       enable row level security;
alter table public.credits        enable row level security;
alter table public.credit_ledger  enable row level security;
alter table public.orders         enable row level security;

create policy "own profile read"  on public.profiles      for select using (auth.uid() = id);
create policy "own credits read"  on public.credits       for select using (auth.uid() = user_id);
create policy "own ledger read"   on public.credit_ledger for select using (auth.uid() = user_id);
create policy "own orders read"   on public.orders        for select using (auth.uid() = user_id);
-- 无 insert/update/delete policy → 客户端无法改余额/订单；service-role 绕 RLS 由后端独占写入。

-- ── 注册即初始化：新用户自动建 profile + credits（默认每月 1000 赠送）──────────────
-- 没有它，新用户登录后无 credits 行，parse 网关会返「账户未初始化」。security definer 绕 RLS。
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  insert into public.credits (user_id, grant_balance, grant_reset_at, monthly_grant)
    values (new.id, 1000, now() + interval '30 days', 1000) on conflict do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- ── 原子积分操作（修 #67/#72 review 标的并发竞态：read-modify-write 非原子）──────────
-- Edge Functions 调这些 RPC 而非手动查改写；for update 行锁串行化同一用户的并发请求。

-- 扣费：月度重置 → 余额不足返 ok:false 不扣 → 先扣赠送后购买 → 写流水。cost<=0 不扣(失败/跳过)。
create or replace function public.deduct_credits(p_user uuid, p_cost int, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.credits%rowtype; from_g int; g int; p int;
begin
  select * into c from public.credits where user_id = p_user for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_account'); end if;
  if now() >= c.grant_reset_at then          -- 跨重置点 → 赠送重置为月额，reset 推到 now 之后
    c.grant_balance := c.monthly_grant;
    while c.grant_reset_at <= now() loop c.grant_reset_at := c.grant_reset_at + interval '30 days'; end loop;
  end if;
  if p_cost <= 0 then
    update public.credits set grant_balance=c.grant_balance, grant_reset_at=c.grant_reset_at, updated_at=now() where user_id=p_user;
    return jsonb_build_object('ok', true, 'balance', c.grant_balance + c.purchased_balance);
  end if;
  if c.grant_balance + c.purchased_balance < p_cost then
    update public.credits set grant_balance=c.grant_balance, grant_reset_at=c.grant_reset_at, updated_at=now() where user_id=p_user;
    return jsonb_build_object('ok', false, 'balance', c.grant_balance + c.purchased_balance);
  end if;
  from_g := least(c.grant_balance, p_cost);
  g := c.grant_balance - from_g;
  p := c.purchased_balance - (p_cost - from_g);
  update public.credits set grant_balance=g, purchased_balance=p, grant_reset_at=c.grant_reset_at, updated_at=now() where user_id=p_user;
  insert into public.credit_ledger(user_id, delta, reason, balance_after) values (p_user, -p_cost, p_reason, g+p);
  return jsonb_build_object('ok', true, 'balance', g+p);
end; $$;

-- 充值积分包：加购买余额(不过期) + 写流水。
create or replace function public.add_credits(p_user uuid, p_credits int, p_reason text, p_ref text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare g int; p int;
begin
  update public.credits set purchased_balance = purchased_balance + greatest(0, p_credits), updated_at = now()
    where user_id = p_user returning grant_balance, purchased_balance into g, p;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_account'); end if;
  insert into public.credit_ledger(user_id, delta, reason, balance_after, ref_order) values (p_user, p_credits, p_reason, g+p, p_ref);
  return jsonb_build_object('ok', true, 'balance', g+p);
end; $$;

-- 开通会员：设月赠额 + 立即激活本月赠送 + 写流水。（积分制遗留，订阅制上线后不再有新调用）
create or replace function public.activate_membership(p_user uuid, p_monthly int, p_ref text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare g int; p int;
begin
  update public.credits set monthly_grant = p_monthly, grant_balance = p_monthly,
    grant_reset_at = now() + interval '30 days', updated_at = now()
    where user_id = p_user returning grant_balance, purchased_balance into g, p;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_account'); end if;
  insert into public.credit_ledger(user_id, delta, reason, balance_after, ref_order) values (p_user, p_monthly, 'grant', g+p, p_ref);
  return jsonb_build_object('ok', true, 'balance', g+p);
end; $$;

-- ═══════════════ 订阅制（积分制 → 订阅制改造）═══════════════
-- 付费买时长，有效期内使用；每日公平用量上限防刷（用量单位：文本 1 / 含图 2）。
-- 档位与定价白名单在 src/shared/subscription.ts（Edge Function 直接 import），金额不信任客户端。
-- chpay 无代扣 → 订阅为手动续费时长卡；续费在「当前到期与现在的较大者」上叠加。

create table if not exists public.subscriptions (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  plan        text not null default 'trial',        -- 'trial' | 'monthly' | 'quarterly' | 'yearly'
  expires_at  timestamptz not null,                 -- 订阅到期时间（试用也是一段有效期）
  daily_quota integer not null default 3000,        -- 每日公平用量上限
  updated_at  timestamptz not null default now()
);

create table if not exists public.usage_daily (
  user_id uuid not null references auth.users (id) on delete cascade,
  day     date not null,                            -- UTC 日界（限额是防刷粗闸，不追求本地时区精确）
  units   integer not null default 0,
  primary key (user_id, day)
);

alter table public.subscriptions enable row level security;
alter table public.usage_daily   enable row level security;
create policy "own subscription read" on public.subscriptions for select using (auth.uid() = user_id);
create policy "own usage read"        on public.usage_daily   for select using (auth.uid() = user_id);
-- 无写 policy → 客户端不可改；service-role 后端独占写入。

-- 注册即初始化改造：新用户送试用订阅（替代送积分；credits 行保留兼容遗留读取）。
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  insert into public.credits (user_id, grant_balance, grant_reset_at, monthly_grant)
    values (new.id, 0, now() + interval '30 days', 0) on conflict do nothing;
  insert into public.subscriptions (user_id, plan, expires_at)
    values (new.id, 'trial', now() + interval '7 days') on conflict do nothing;
  return new;
end;
$$;

-- 开通/续费订阅：max(now, 当前到期) + 天数；写 ledger 流水（delta=0，只做可追溯记录）。
create or replace function public.activate_subscription(p_user uuid, p_plan text, p_days int, p_ref text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare new_expiry timestamptz;
begin
  insert into public.subscriptions (user_id, plan, expires_at)
    values (p_user, p_plan, now() + make_interval(days => p_days))
    on conflict (user_id) do update set
      plan = excluded.plan,
      expires_at = greatest(public.subscriptions.expires_at, now()) + make_interval(days => p_days),
      updated_at = now()
    returning expires_at into new_expiry;
  insert into public.credit_ledger(user_id, delta, reason, balance_after, ref_order)
    values (p_user, 0, 'subscription:' || p_plan, 0, p_ref);
  return jsonb_build_object('ok', true, 'expires_at', new_expiry);
end; $$;

-- 记用量（成功后调用；失败不计量，同积分制「心安」原则）。行锁原子累加，返回当日累计。
create or replace function public.consume_quota(p_user uuid, p_units int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare used int;
begin
  if p_units <= 0 then return jsonb_build_object('ok', true); end if;
  insert into public.usage_daily (user_id, day, units) values (p_user, current_date, p_units)
    on conflict (user_id, day) do update set units = public.usage_daily.units + p_units
    returning units into used;
  return jsonb_build_object('ok', true, 'used', used);
end; $$;

-- ═══════════════ 账户资料自助编辑（头像/昵称）═══════════════
-- 头像为客户端裁好的 128px JPEG data URL（约 5-8KB），直接存列，免 Storage 桶。
-- 列级收口：登录用户仅能改自己行的 display_name/avatar，其余列不可写。
alter table public.profiles add column if not exists avatar text;
create policy "own profile update" on public.profiles for update
  using (auth.uid() = id) with check (auth.uid() = id);
revoke update on table public.profiles from authenticated, anon;
grant update (display_name, avatar) on table public.profiles to authenticated;

-- ═══════════════ 用户反馈（设置 → 关于 → 联系我们）═══════════════
-- 应用内直接提交，团队后台可见；RLS：登录用户只能写/看自己的。
create table if not exists public.feedback (
  id         bigint generated always as identity primary key,
  user_id    uuid references auth.users (id) on delete set null,
  content    text not null,
  contact    text,                              -- 选填：微信/邮箱/QQ
  ua         text,                              -- userAgent（含 Electron 版本，排查环境用）
  created_at timestamptz not null default now()
);
alter table public.feedback enable row level security;
create policy "own feedback insert" on public.feedback for insert to authenticated with check (auth.uid() = user_id);
create policy "own feedback read"   on public.feedback for select using (auth.uid() = user_id);

-- ⚠️ 一次性迁移（订阅制上线时手动执行一次）：存量已购积分折算订阅天数（1000 分 ≈ 30 天）。
-- 执行前和用户确认折算率；执行后存量 purchased_balance 清零，流水留痕。
-- insert into public.subscriptions (user_id, plan, expires_at)
--   select user_id, 'monthly', now() + make_interval(days => (purchased_balance * 30 / 1000))
--   from public.credits where purchased_balance > 0
--   on conflict (user_id) do update set
--     expires_at = greatest(public.subscriptions.expires_at, now())
--       + make_interval(days => (select purchased_balance * 30 / 1000 from public.credits c where c.user_id = public.subscriptions.user_id));
-- update public.credits set purchased_balance = 0 where purchased_balance > 0;

-- ── RPC 权限：security definer 函数只给服务端调用（见 migrations/20261105_restrict_rpc_execute.sql）──
-- Supabase 默认把 public 里函数的 EXECUTE 授予 anon / authenticated，经 /rest/v1/rpc 可直接调用；
-- 这些函数绕过 RLS 改余额与会员，客户端绝不能直接调。网关与支付回调都用 service_role。
revoke execute on function public.handle_new_user()                         from public, anon, authenticated;
revoke execute on function public.deduct_credits(uuid, int, text)           from public, anon, authenticated;
revoke execute on function public.add_credits(uuid, int, text, text)        from public, anon, authenticated;
revoke execute on function public.activate_membership(uuid, int, text)      from public, anon, authenticated;
revoke execute on function public.activate_subscription(uuid, text, int, text) from public, anon, authenticated;
revoke execute on function public.consume_quota(uuid, int)                  from public, anon, authenticated;
grant execute on function public.deduct_credits(uuid, int, text)            to service_role;
grant execute on function public.add_credits(uuid, int, text, text)         to service_role;
grant execute on function public.activate_membership(uuid, int, text)       to service_role;
grant execute on function public.activate_subscription(uuid, text, int, text) to service_role;
grant execute on function public.consume_quota(uuid, int)                   to service_role;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
