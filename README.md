# EShell（纸壳助手）

个人事项捕获助手 —— 从聊天、通知、邮件、截图和屏幕里自动提取待办，判断「哪些事是你的事」，用确认式交互帮你把它们收进日程。基于 Electron + React 的 macOS 桌面应用。

## 功能特性

- **多来源捕获**
  - 剪切板：复制内容后按全局快捷键（默认 `Alt+C`）一键提交
  - 框选截图：对聊天/通知截图，识别图中文字提取事项
  - 文件拖拽：把 PDF / docx / 图片 / txt 拖到窗口或菜单栏图标
  - 访达右键「发送到 纸壳助手」快速操作
  - 飞书机器人：把通知/截图转发给机器人，自动进入待确认列表
  - **屏幕感知建议（隐私功能，默认关闭）**：手动「扫描当前屏幕」→ 本地 OCR → 命中关键词 → 给出一条最可能的待办，右下角点 同意 / 拒绝 / 修改。截图本地识别、用完即弃、不外发
- **AI 解析**：判断事项是否属于本人（归属判断）、解析时间/地点/注意事项、对已有任务做语义查重
- **助手对话**：聊天式确认候选、用自然语言修改事项、回答「今天有什么安排」「我现在该干什么」
- **日程管理**：七种任务状态、时间轴与日程视图、忽略与恢复

## 技术栈

Electron · React 19 · TypeScript · better-sqlite3 · Tailwind CSS v4 · electron-vite

- 解析调用 OpenAI 风格的 `/v1/responses` 接口（可配置 Base URL / Key / 模型）
- 本地 OCR 使用 macOS Apple Vision（`VNRecognizeTextRequest`），通过内嵌的 Swift CLI 在首次使用时用 `swiftc` 编译缓存，完全离线
- 飞书接入使用 `@larksuiteoapi/node-sdk` 长连接，无需公网服务器

## 环境要求

- macOS（截图、访达快速操作、本地 OCR 依赖 macOS）
- Node.js ≥ 22.6
- 屏幕感知建议需授予「屏幕录制」权限；首次本地 OCR 编译需 Xcode 命令行工具（`xcode-select --install`）

## 快速开始

```bash
npm install
cp .env.example .env      # 填入解析 API 配置
npm run dev
```

`.env` 配置项（也可在应用「设置」页填写）：

```
ESHELL_API_BASE=https://your-api-base
ESHELL_API_KEY=sk-xxx
ESHELL_MODEL=gpt-5.5
# 飞书自建应用凭证（可选）
ESHELL_FEISHU_APP_ID=
ESHELL_FEISHU_APP_SECRET=
```

## 隐私

- 所有数据仅保存在本机：`<userData>/eshell.db`（SQLite），不会自动上传
- 提交解析时，仅所选内容会发送给你配置的解析 API
- 屏幕感知建议：截图在本机做 OCR，识别后立即删除，只把文字送解析，截图不落盘、不外发
- 设置页可一键清除全部数据

## 常用脚本

```bash
npm run dev          # 开发模式
npm run build        # 构建
npm run typecheck    # 类型检查（main + renderer）
npm run test:parser  # 解析归属判断冒烟测试（需 .env 配好 API）
npm run test:screen  # 关键词匹配 / 选最优纯函数单测
```

## 目录结构

```
src/
  main/        Electron 主进程：捕获、解析、OCR、DB、IPC、飞书、屏幕感知
  preload/     contextBridge 桥接
  renderer/    React 界面（助手、时间轴、日程、设置）
  shared/      主进程与渲染层共享的类型与解析逻辑
docs/          设计与实现文档
```
