# 贡献指南

谷子助手以 [Apache License 2.0](LICENSE) 开源。提交 Pull Request 即表示你同意按同一许可证贡献你的改动（Apache-2.0 第 5 条）。

## 分支与合并

- 外部贡献者请 fork 后从最新 `main` 切分支提 PR；维护者可直接在本仓库切分支。命名如 `feat/xxx`、`fix/xxx`、`test/xxx`、`docs/xxx`。
- `main` 受保护：**不允许直接 push、不允许 force push**，所有改动走 Pull Request。
- PR 必须 **CI 通过**才能合并；合并方式用 squash。
- 一个 PR 只做一件事；改动较大时先开 Issue 讨论方向。

## 开发

```bash
npm install        # Node ≥ 22.18（原生 strip-types 跑 .ts 测试）
npm run dev        # 开发模式
npm run typecheck  # 类型检查
npm test           # 纯函数单测（无需 API，CI 必跑）
npm run build      # 构建
```

提 PR 前请本地跑通 `npm run typecheck && npm test && npm run build`。

开发和默认测试不需要任何密钥。解析可以在设置里填你自己的 OpenAI 兼容 API；需要真实模型的用例：

```bash
npm run test:scenarios                                   # 日常场景端到端，离线回放（不联网）
npm run test:scenarios -- --run --config ~/my-model.json # 同一批场景打你自己的模型（config chmod 600）
```

**不要把任何 Key、Token、密码或个人数据提交进仓库**，包括测试夹具和截图。测试数据请用合成内容（如 `example.test` 域名、虚构人名）。

## CI

`.github/workflows/ci.yml` 在 PR 与 push 到 `main` 时执行：`typecheck → test:unit → build`，并在 macOS 回归与 Windows x64 打包上各跑一遍。来自 fork 的 PR 拿不到仓库 Secret，发布和签名只在维护者手动触发的工作流里进行。

## 测试约定

- 纯逻辑（`src/shared/`、纯函数）改动应配套 `test/*-smoke.mjs` 回归用例，并纳入 `test:unit`。
- 涉及 Electron 运行时 / UI / dialog 的改动，CI 验不到，需在 PR 里注明并本地 smoke 后再合。

## IPC 通道

新增主进程 IPC 通道时，必须同步登记到 `src/shared/ipc-channels.ts`（单一事实源），否则 preload 白名单会拒绝、且 `test:ipc` 会失败。

## 托管后端

`supabase/functions/` 与 `server/` 是维护者运营的解析网关与计费服务。会改余额、会员的 `security definer` 函数只能授予 `service_role`，新增这类函数时同步更新 `server/db/migrations/` 和 `test/supabase-rpc-privileges-smoke.mjs`。

## 发布（维护者）

macOS 正式版通过 `.github/workflows/macos-release.yml` 发布到本仓库的 Releases：

1. 在 PR 里提升 `package.json` 版本，合并后在 `main` 的合并提交上打 `vX.Y.Z` 标签并推送——自动构建隔离的测试草稿。
2. 测试草稿通过后，手动触发工作流：`tag=vX.Y.Z`、`publish=true`、`confirmation=publish-vX.Y.Z`。
3. **迁移版本（源码仓库公开后的第一个正式版）额外勾选 `bridge_legacy`**，让 v0.13.0–v0.14.0 的旧安装通过旧仓库 `guzi-assistant-releases` 的更新源升级到本仓库的版本；确认旧版本能检查到更新后，归档旧仓库并删除 `RELEASE_REPO_TOKEN`。
