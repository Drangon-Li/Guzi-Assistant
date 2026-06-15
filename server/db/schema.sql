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

-- 开通会员：设月赠额 + 立即激活本月赠送 + 写流水。
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
