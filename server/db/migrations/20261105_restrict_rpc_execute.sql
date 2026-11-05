-- 收回 security definer 函数的公开执行权限（开源前的安全修复，对已部署的库执行一次）。
--
-- Supabase 默认把 public schema 里新建函数的 EXECUTE 授予 anon / authenticated，
-- PostgREST 会把它们暴露成 /rest/v1/rpc/<name>。这些函数以所有者身份运行、绕过 RLS，
-- 能直接改余额与会员——客户端那把可公开的 publishable key 就足以调用。
-- 它们只该由服务端（parse 网关、支付回调，均用 service_role）调用。
--
-- 幂等：可重复执行。执行后用 anon / authenticated 调 /rpc/add_credits 应返回 permission denied。

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

-- 以后在 public 里新建的函数默认不再对客户端角色开放；确需给客户端调用的再单独 grant。
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
