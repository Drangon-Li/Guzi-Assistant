# 贡献指南

## 分支与合并

- `main` 受保护：**不允许直接 push、不允许 force push**，所有改动走 Pull Request。
- 从最新 `main` 切分支（命名如 `feat/xxx`、`fix/xxx`、`test/xxx`、`docs/xxx`）。
- PR 必须 **CI 通过**才能合并；合并方式用 squash。

## 开发

```bash
npm install        # Node ≥ 22.18（原生 strip-types 跑 .ts 测试）
npm run dev        # 开发模式
npm run typecheck  # 类型检查
npm run test:unit  # 纯函数单测（无需 API，CI 必跑）
npm run build      # 构建
```

提 PR 前请本地跑通 `npm run typecheck && npm run test:unit && npm run build`。

## CI

`.github/workflows/ci.yml` 在 PR 与 push 到 `main` 时执行：`typecheck → test:unit → build`。

## 测试约定

- 纯逻辑（`src/shared/`、纯函数）改动应配套 `test/*-smoke.mjs` 回归用例，并纳入 `test:unit`。
- 涉及 Electron 运行时 / UI / dialog 的改动，CI 验不到，需在 PR 里注明并本地 smoke 后再合。

## IPC 通道

新增主进程 IPC 通道时，必须同步登记到 `src/shared/ipc-channels.ts`（单一事实源），否则 preload 白名单会拒绝、且 `test:ipc` 会失败。
