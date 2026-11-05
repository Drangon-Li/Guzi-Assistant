# 谷子助手（Guzi Assistant）

谷子助手是一个本地优先的个人事项捕获助手：从剪贴板、聊天截图、通知、邮件和屏幕里自动拎出待办，判断「哪些事是你的事」，再用确认式交互帮你收进日程。它不会静默替你安排任何事——每一条都要你点头才入库。

目前面向 macOS 桌面发行。任务、来源原文、工作记录、日报和活动历史都保存在本机 SQLite。

**当前版本是本地模式**：不需要账号，解析、屏幕感知、日报摘要和助手对话都使用你在「设置 → 助手 → 模型」里填写的模型 API（OpenAI 兼容或 Anthropic 协议）。原来的云端账号与托管解析服务暂停，后续恢复（见 `src/shared/hosted-service.ts`）。

## 功能

- **剪贴板自动捕获**：复制到「明天下午三点开组会」这类内容时主动提示。密码管理器标记的内容一个字都不读，识别在本机完成，常见短句约 250ms 出卡
- **多来源捕获**：全局快捷键、框选截图、文件拖拽、托盘拖拽、访达右键、飞书机器人
- **归属判断**：模型为每条事项判定是否属于你本人，并沉淀个人归属词典，越用越准
- **日程管理**：标签分类（解析自动预打）与重点标签加权、检查清单、快速推迟、多选批量、右键快捷菜单，以及按紧迫度智能排序的「谷子建议」视图
- **任务提醒**：到点前弹置顶提醒卡，配合桌宠气泡与系统通知，不点不消失
- **屏幕感知**：可选的持续被动感知，从屏幕内容里发现待办与工作记录（默认关闭）
- **工作记录与日报**：把活动归纳成带任务标签和真实起止时间的记录，可一键或定时生成 Markdown 日报
- **个人记忆**：基本画像 + 近期行为画像，注入解析提示词
- **快捷提问**：全局快捷键唤起 Spotlight 式输入条，问答与记日程一个入口；发完即可关闭，处理转后台、结果由桌宠气泡播报
- **桌宠**：常驻桌面的轻量入口，处理中、发现日程、久坐提醒都通过它反馈；点开的气泡对话会一直留着，和主窗口的悬浮助手是同一份记录，随时回来接着说，也可以一键（或 ⌘K）清屏
- **MCP 服务**：可选地把任务、工作记录和日报暴露给你自己的 AI 客户端，仅监听本机
- **插件市场**：额外功能按需启用，默认一个都不装——只想用捕获和日程的话，界面和以前完全一样。当前内置五个：
  - **作息**：按时间块规划一天（上午十一点看论文到十二点吃饭），存成模板每天套用；开了屏幕感知还能对照实际活动看计划完成度
  - **专注**：番茄钟，计时、休息提醒与专注时长统计；装了作息可以直接从时间块开始一轮
  - **打卡**：每日小目标一键打卡，连续天数、累计次数和最近 28 天日历。今天还没打不算断，断了也不清零
  - **成就**：把长期的坚持变成看得见的收藏；每多启用一个插件，成就墙就多一批
  - **记事本**：Markdown 笔记，选中文字浮出工具栏（加粗、高亮、七种颜色），行首打 `/` 插入标题和列表；分类可以套分类，标签另算一套，生成的日报能一键存成一篇接着写

## 下载

前往 [Releases](https://github.com/Drangon-Li/Guzi-Assistant/releases) 下载安装包：

| 平台 | 产物 | 说明 |
| --- | --- | --- |
| macOS Apple Silicon（macOS 12+） | `GuziAssistant-<版本>-arm64.dmg` | 首次安装用；之后在「设置 → 关于」里检查更新，应用内升级 |
| macOS Apple Silicon | `GuziAssistant-<版本>-arm64.zip` | 供应用内更新（Sparkle）使用，更新包带 Ed25519 签名校验 |
| Windows x64 | `GuziAssistant-<版本>-win-x64.exe` / `.zip` | 安装包 / 免安装版 |

v0.13.0–v0.14.0 的 macOS 安装包在已归档的旧仓库 [guzi-assistant-releases](https://github.com/Drangon-Li/guzi-assistant-releases/releases)；从 v0.15.0 起都在本仓库，已安装的旧版本在应用内检查更新即可升级过来。

macOS 安装包是 ad-hoc 签名，没有 Apple Developer ID 签名或公证。首次打开如果遇到 Gatekeeper 提示，请在 Finder 中右键「谷子助手.app」并选择「打开」，再确认提示。

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
npm test             # 纯函数单测（全部跑完再汇总；`npm test history` 可按关键词筛）
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
│   ├── pet/        # 桌宠窗口与状态机
│   └── plugins/    # 插件装配与各插件的主进程实现
├── preload/        # contextBridge 与 IPC 通道白名单
├── renderer/       # React 界面：今日、日程、日报、分析、个人、市场、设置、悬浮助手
│   └── src/plugins/  # 各插件的界面（含各自的设置），按需懒加载
└── shared/         # 主进程与渲染层共用的纯函数和类型（含插件契约与注册表）

server/             # 计费与支付签名逻辑
supabase/functions/ # 托管解析网关与收款 Edge Functions
test/               # 纯函数 smoke 测试
scripts/            # 打包后处理与发布脚本
docs/               # 架构参考、设计文档与实施计划
```

IPC 通道以 `src/shared/ipc-channels.ts` 为单一事实源，主进程注册、preload 白名单和渲染层调用三处必须一致，由 `test/ipc-channels-smoke.mjs` 校验。插件通道（`plugin:<id>:<action>`）随插件启用动态注册，preload 按形状与注册表里的 id 放行，同一个测试也会卡住绕过这条规则的写法。

插件的数据只在本机，且各自独占 `p_<id>_` 前缀的表。停用只是把它从导航里摘掉，数据保留；市场里的「清除数据」才会真正删除。

## 文档

- [架构与实现参考](docs/ARCHITECTURE.md) —— 整体架构、每条链路的实现细节、数据模型、部署
- [设计文档](docs/superpowers/specs/) —— 各功能的设计决策与取舍记录

## 参与贡献

欢迎提 Issue 和 Pull Request，流程与本地验证要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。开发和跑默认测试都不需要任何密钥；解析可以在设置里填你自己的 OpenAI 兼容 API。

安全问题请不要开公开 Issue，按 [SECURITY.md](SECURITY.md) 私密报告。

## 许可证

[Apache License 2.0](LICENSE)。第三方组件与资产的许可见 [NOTICE](NOTICE)。

托管解析与计费服务（`supabase/functions/`、`server/`）是维护者运营的线上服务，目前暂停，代码同样以 Apache-2.0 开源；自建后端时在构建环境里设置 `VITE_GUZI_ASSISTANT_SUPABASE_URL` / `_ANON_KEY` 即可启用账号体系。
