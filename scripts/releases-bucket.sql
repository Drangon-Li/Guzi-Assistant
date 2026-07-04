-- 应用更新分发桶（一次性）：公共读（版本清单 + dmg），写入走 service role（CLI --linked）
insert into storage.buckets (id, name, public)
values ('releases', 'releases', true)
on conflict (id) do update set public = true;
