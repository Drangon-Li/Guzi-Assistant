-- Eshell 托管后端数据模型（#41 账号+计费+收付款 / #56 积分模型）
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
