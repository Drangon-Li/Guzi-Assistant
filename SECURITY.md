# 安全策略

## 报告漏洞

**请不要在公开 Issue 里报告安全问题。** 请使用 GitHub 的私密漏洞报告：仓库页面 → **Security** → **Report a vulnerability**。报告里请尽量写清：

- 受影响的版本或提交、平台（macOS / Windows）
- 复现步骤或概念验证
- 可能造成的影响

我们会在 7 天内确认收到，修复后在发布说明里致谢（除非你希望匿名）。

## 范围

- 桌面应用（`src/`）：剪贴板、屏幕与活动数据的采集与脱敏、IPC 白名单、本地存储、MCP 服务
- 更新链路：Sparkle 更新源、EdDSA 签名、发布脚本与工作流（`scripts/`、`.github/workflows/`）
- 托管后端：`supabase/functions/` 与 `server/` 里的解析网关、计费与收款逻辑

自建后端或自备模型 Key 的配置问题、第三方服务本身的漏洞不在范围内。

## 维护者须知

- 签名私钥只存在 GitHub Actions Secret 与维护者钥匙串里，加密备份放在仓库之外，见 `signing/RECOVERY.md`。
- 公开前的历史提交里有两份签名私钥的加密备份；它们的密码都是约 256 位熵的随机串，离线破解不可行。若怀疑密码泄露，按 Sparkle 换钥流程处理。
- 托管后端里会改余额、会员的 `security definer` 函数只授予 `service_role`（`server/db/migrations/`），`test/supabase-rpc-privileges-smoke.mjs` 防止回退。
