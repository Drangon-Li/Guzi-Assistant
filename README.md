# 谷子助手（Guzi Assistant）

谷子助手是一个本地优先的个人事项捕获助手：从剪贴板、聊天截图、通知、邮件和屏幕里自动拎出待办，判断「哪些事是你的事」，再用确认式交互帮你收进日程。它不会静默替你安排任何事——每一条都要你点头才入库。

目前面向 macOS 桌面发行。任务、来源原文、工作记录、日报和活动历史默认保存在本机 SQLite；解析既可以用内置的托管服务，也可以在设置里填自己的 OpenAI 兼容 API。

## 功能

- **剪贴板自动捕获**：复制到「明天下午三点开组会」这类内容时主动提示。密码管理器标记的内容一个字都不读，识别在本机完成，常见短句约 250ms 出卡
- **多来源捕获**：全局快捷键、框选截图、文件拖拽、托盘拖拽、访达右键、飞书机器人
- **归属判断**：模型为每条事项判定是否属于你本人，并沉淀个人归属词典，越用越准
- **任务提醒**：到点前弹置顶提醒卡，配合桌宠气泡与系统通知，不点不消失
- **屏幕感知**：可选的持续被动感知，从屏幕内容里发现待办与工作记录（默认关闭）
- **工作记录与日报**：把活动归纳成带任务标签和真实起止时间的记录，可一键或定时生成 Markdown 日报
- **个人记忆**：基本画像 + 近期行为画像，注入解析提示词
- **桌宠**：常驻桌面的轻量入口，处理中、发现日程、久坐提醒都通过它反馈
- **MCP 服务**：可选地把任务、工作记录和日报暴露给你自己的 AI 客户端，仅监听本机

## 下载

前往 [Releases](https://github.com/Chinese-Dragon-Li/Guzi-Assistant/releases) 下载安装包：

| 平台 | 产物 | 当前状态 |
| --- | --- | --- |
| macOS Apple Silicon | `.dmg` | GitHub 发布版（未签名） |
| macOS Apple Silicon | `.zip` | GitHub 发布版（未签名） |

安装包未使用 Apple Developer ID 签名或公证。首次打开如果遇到 Gatekeeper 提示，请在 Finder 中右键「谷子助手.app」并选择「打开」，再确认提示。

部分功能需要额外的系统权限：屏幕感知需要「屏幕录制」，活动历史需要「辅助功能」和「输入监控」，剪贴板自动捕获需要 macOS 15.4 及以上。

## 隐私

- 本地数据只存在本机 `<userData>/eshell.db`，不自动上传
- 剪贴板捕获前三道门都不读正文：只在系统判定内容像日程时才第一次读取，密码管理器打了标记的内容直接跳过
- 屏幕原图用完即弃，默认只上传脱敏后的 OCR 文字；API key、私钥、证件号、银行卡号在离开设备前替换为占位符
- 活动历史不保存键盘正文、选中文本或完整 URL，默认只保留最近 48 小时
- 设置页可按时间范围导出全部数据，也可一键清除

完整说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的「隐私」一节。

## 本地开发

```sh
npm install
npm run dev
```

常用命令：

```sh
npm run typecheck    # 主进程与渲染层两套 tsconfig
npm run test:unit    # 纯函数单测
npm run build        # 构建主进程、preload 和渲染层
npm run pack:dir     # 生成未签名的 arm64 .app 目录
npm run pack:mac     # 生成 arm64 DMG + ZIP
```

环境要求：macOS · Node ≥ 22.18 · 首次本地 OCR 与原生 helper 编译需要 Xcode 命令行工具（`xcode-select --install`）。

可选的 `.env` 配置（自建后端或直连模型时才需要）见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的「本地开发」一节。

## 项目结构

```text
src/
├── main/           # Electron 主进程：捕获、解析、屏幕感知、剪贴板、提醒、桌宠
│   ├── history/    # 活动历史的采集、存储、摘要与查询
│   └── pet/        # 桌宠窗口与状态机
├── preload/        # contextBridge 与 IPC 通道白名单
├── renderer/       # React 界面：日程、日报、记忆、历史、设置、悬浮助手
└── shared/         # 主进程与渲染层共用的纯函数和类型

server/             # 计费与支付签名逻辑
supabase/functions/ # 托管解析网关与收款 Edge Functions
test/               # 纯函数 smoke 测试
scripts/            # 打包后处理与发布脚本
docs/               # 架构参考、设计文档与实施计划
```

IPC 通道以 `src/shared/ipc-channels.ts` 为单一事实源，主进程注册、preload 白名单和渲染层调用三处必须一致，由 `test/ipc-channels-smoke.mjs` 校验。

## 文档

- [架构与实现参考](docs/ARCHITECTURE.md) —— 整体架构、每条链路的实现细节、数据模型、部署
- [设计文档](docs/superpowers/specs/) —— 各功能的设计决策与取舍记录
