# 屏幕感知重构：本地小模型精筛 + 按需 VLM 复核

> 设计文档（spec）。面向实施。日期 2026-06-25。
> 取代现有「关键词白名单 + 时间正则」本地检测与其常驻监控管线，改由本地小模型做初步精筛，按需自动升级到云端 VLM。

## 1. 背景与目标

现有屏幕感知用 `shared/local-extract.ts` 的 `detectLocalSchedule()` 做本地判断：**门① 命中关键词白名单 ∧ 门② 命中时间正则，缺一即弃**。实测漏检/错检严重，根因是封闭关键词表 + 脆弱正则做不了开放词表的中文事件抽取（同领域无人用纯规则可靠地做这件事）。

**目标**：用一个本地文本小模型（Qwen2.5-1.5B-Instruct）替换规则判断层，提升召回同时压低误报；保持本地优先、隐私（只传文字）、零静默、可商用；用户可在设置里开关该功能，关闭即释放内存。

**非目标**：不改捕获来源（剪贴板/截图/拖拽/飞书等普通捕获走 `capture.ts` 老路，本次不动）；不引入本地 VLM（保留 OCR + 文本模型，已与用户确认）。

## 2. 决策摘要（已与用户确认）

| 决策 | 选择 |
|---|---|
| 本地判断层 | 删规则，换**本地文本小模型** |
| OCR | **保留**（pixels→text 是去重/记忆检索/「只传文字」隐私/喂模型的共同地基） |
| 触发/常驻 | **保留常驻监控，但降频**：pHash 变化门 + textHash 去重做廉价前置，**模型只在屏幕稳定 + 文本变化后跑一次**，不是每 5s |
| VLM 升级 | 本地模型**自动判断**：低置信/缺信息 → 自动上 VLM 复核（扣积分）；高置信 → 本地直接出结论 |
| 模型分发 | **首次开启按需下载** ~1.3GB 到 userData，SHA 校验 |
| 模型档位 | **Qwen2.5-1.5B-Instruct，Q5_K_M（1.29GB）起步**（小模型对激进量化敏感，不直接 Q4） |
| 开关行为 | 关闭 = 屏幕感知整体停 + `dispose()` 释放内存；手动捕获老路不受影响 |
| `DetectionRecord.hits` | 保留字段，改由模型输出的「命中信号词」填 |

## 3. 新架构

```
截图 → pHash变化门 → OCR(Apple Vision) → textHash去重/冷却 → [本地模型 extract()]
       (保留,廉价前置)   (保留)            (保留)              ┌─ needsVlm=false & conf≥阈值 → 本地出结论(不上云)
                                                              └─ needsVlm=true  | conf<阈值  → 自动 parseToItems(VLM网关,扣分) → 合并
                                                                                  ↓
                                                         写「记忆」检测历史 + (强信号&开关&同App)弹精简卡 → 用户确认入库
```

被换掉的只有原「关键词∧时间正则」判断；其前后的 pHash 门、OCR、textHash 去重、隐私门、检测历史、预览卡、确认入库**全部保留**。

## 4. 删 / 留 清单（基于实际引用核对）

**删除：**
- `src/shared/local-extract.ts` 整文件（`detectLocalSchedule` / `LocalSchedule` / 时间正则）
- `src/shared/keywords.ts` 中 `DEFAULT_SCREEN_KEYWORDS` + `matchKeywords`（关键词门）；**保留 `DEFAULT_MONITORED_APPS`**（App 允许名单仍用）
- `AppSettings.screenSenseKeywords`（types.ts）+ `db.ts` 默认 + `Settings.tsx:411-415` 关键词输入 UI（DB 列保留不删，迁移安全）
- `test/local-extract-smoke.mjs` 整删；`test/screen-smoke.mjs` 删 `matchKeywords`/关键词相关断言

**保留（非「规则方法」，新流程仍需要）：**
- `src/shared/phash.ts`（`dhash`/`hamming`/`bgraToGray`/`textHash`）——pHash 变化门 + 文本去重 + 加密缩略图 key
- 隐私门：`app-exclude.ts` / `frontapp.ts` / `DEFAULT_MONITORED_APPS` 允许名单 / 「不扫自己」
- `chat-layout.ts`（聊天归属转写，作为模型输入上下文）
- 检测历史 / 预览卡 / `acceptLocal`·`acceptSuggestion`·`acceptDetection`·`dismissDetection`（适配新数据形状）
- `parser.ts` 的 VLM 网关（作为自动升级目标，不改）

## 5. 模块设计

### 5.1 新模块 `src/main/local-model/`（依赖收敛，node-llama-cpp 全锁此处）

```ts
export type LocalModelState = 'absent' | 'downloading' | 'loading' | 'ready' | 'unloaded' | 'error'

export interface LocalModelStatus {
  state: LocalModelState
  progress?: number   // downloading 时 0..1
  error?: string
}

export interface LocalExtractor {
  getStatus(): LocalModelStatus
  downloadModel(onProgress: (p: number) => void): Promise<void>  // 首次开启按需下载 + SHA 校验
  ensureLoaded(): Promise<void>                                   // lazy load + warmup
  unload(): Promise<void>                                         // await dispose()，释放权重+KV，归还统一内存
  extract(text: string): Promise<LocalExtraction[]>              // grammar 约束输出；无日程返回 []
}
```

- 内部：`getLlama()` 全局单例复用（**不 dispose**）；model/context 用 `await using` 或显式 `await dispose()`。
- 渲染层**不直接碰**（node-llama-cpp 仅主进程），经 IPC。

### 5.2 抽取输出类型（替代 `LocalSchedule`）

`src/shared/types.ts` 新增（纯类型，可被渲染层 import）：

```ts
export interface LocalExtraction {
  title: string
  isoTime: string | null          // YYYY-MM-DDTHH:mm；解不出为 null
  deadline: boolean
  belongsToUser: Belongs           // 'yes'|'no'|'uncertain'，模型初判
  hits: string[]                   // 模型给出的命中信号词（填 DetectionRecord.hits）
  confidence: number               // 0..1
  needsVlm: boolean                // 模型自判：要不要上云复核
  strong: boolean                  // 解析出具体日期 → 决定是否主动弹卡（沿用旧语义）
}
```

`PreviewCard.tsx` 的 `localSuggestion` 形状、`api.ts`、`acceptLocal` 入参同步从 `LocalSchedule` 迁到 `LocalExtraction`（`buildLocalItem` 改吃新结构）。

### 5.3 反幻觉 schema（grammar 强制全字段，必须如此设计）

grammar 会强制填满所有字段（`required` 永远全开，无「可选」概念），故：
- **顶层用数组** `{ type: 'array', items: <抽取对象> }`，无日程时模型合法输出 `[]`，**不加 `minItems`**（否则逼模型硬编）。
- 可空字段用 `oneOf: [{ type: 'null' }, ...]`。
- 字段含义 + 「没有就返回空、不要编造、时间解不出填 null」**必须写在 prompt 正文**（grammar 不向模型注入 schema）。
- `prompt(text, { grammar, maxTokens })` 设 `maxTokens` 上限兜底；`grammar.parse()` 包 try/catch（防个别 grammar 不停机被截断成残缺 JSON，失败按「无日程」处理）。

## 6. 触发与 VLM 升级时序

`watchTick()`（常驻）与 `scanOnce()`（手动）保留所有前置门，到「文本变化」后：

```
const items = await extractor.extract(text)      // 本地模型，[]=无日程直接 return
for (const it of items) {
  if (it.needsVlm || it.confidence < CONF_MIN) {
    const refined = await parseToItems({ text, hint })  // 自动升级 VLM 网关(扣分)
    入库/弹卡 ← pickBest(refined)
  } else {
    入库/弹卡 ← it                                       // 本地出结论，不上云
  }
}
```

- 弹卡条件不变：`strong && screenSensePopup && 仍在同 App`。
- 升级仅传 **OCR 文字**（保持「只传文字不传图」）。
- `CONF_MIN` 阈值进设置或常量，初值 0.6（需自测调）。

## 7. 设置与生命周期

`AppSettings` 改动：
- **新增** `screenSenseLocalModel: boolean`（本功能总开关，默认 `false`，opt-in，因要下模型）。
- **移除** `screenSenseKeywords`（停用，DB 列保留）。
- 复用现有 `screenSenseEnabled` / `screenSenseContinuous` / `screenSenseIntervalSec` / `screenSensePopup` 等。

**开关主从关系（消歧）**：规则删除后，**模型是唯一检测引擎**，故 `screenSenseLocalModel` 是检测能力的有效闸门——关闭 = 无任何屏幕检测 + 卸载模型省内存（用户那个「省内存开关」就是它）。`screenSenseEnabled` / `screenSenseContinuous` 仍在其下层控制快捷键注册与「连续 vs 手动」；三者关系：检测发生 ⟺ `screenSenseLocalModel ∧ screenSenseEnabled`，连续监控 ⟺ 再 `∧ screenSenseContinuous`。`screenSenseLocalModel=false` 时，无论其余开关如何，屏幕感知不产出检测（只剩手动捕获老路）。

生命周期（`applyScreenSenseSettings()` 扩展）：
- `screenSenseLocalModel=true` 且模型未就绪 → 触发 `downloadModel()`（带进度事件）。
- 开启 → `ensureLoaded()`（lazy load + warmup）。
- **关闭 → `stopWatch()` + `await unload()`**（释放内存，本需求核心）。
- **idle-unload**：监控空闲 N 分钟（如 10min）无 extract 调用 → 自动 `unload()`；下次用再 lazy load。计时器自建（node-llama-cpp 无内建）。

## 8. IPC / 类型改动（三处一致）

`shared/ipc-channels.ts` + preload 白名单 + 渲染层三处同步登记，补 `test/ipc-channels-smoke.mjs`：

- 新增 invoke：`localmodel:status`、`localmodel:download`（手动触发/重试下载）。
- 新增 event：`eshell:localmodel-progress`（下载/加载进度 → 设置页进度条）。
- `LocalSchedule` → `LocalExtraction`：连带改 `api.ts`、`PreviewCard.tsx`、`suggestion:accept-local` 入参。

## 9. 部署与小模型优化配置（一手核实）

| 维度 | 配置 | 证据级别 |
|---|---|---|
| 运行位置 | 仅主进程；渲染层经 IPC | node-llama-cpp 官方确证 |
| 量化 | Q5_K_M(1.29GB) 起步，不稳升 Q6_K(1.46GB)；不用 Q4/Q8 | 体积官方确证 + 档位社区共识 + **需自测** |
| context | 显式 512–1024（别用 auto，省 KV cache） | 官方确证 |
| gpuLayers | `"auto"`（Apple Silicon 自动全量 Metal offload） | 官方确证 |
| mmap | 默认 true；加载后跑一次 **warmup** 推理消化首次延迟；模型常驻不每次重载 | 官方确证 + warmup 需自测 |
| flash attention | **先不开**（experimental，小负载收益有限） | 官方确证默认关 |
| 卸载 | 单例 `getLlama()` 不 dispose；关功能/idle → `await model.dispose()`（级联释放权重+KV，归还统一内存）；**必须 await，别等 GC**；`getVramState()` 验证 | 官方/源码确证 + idle 计时器需自测 |
| 结构化输出 | `createGrammarForJsonSchema` + 顶层数组(空=`[]`,无 minItems) + nullable 用 oneOf + prompt 写「无则空、勿编造」+ maxTokens + parse try/catch | 官方确证 |
| 打包 | 官方 `electron-typescript-react` 模板；抄其 **asarUnpack** 三条 glob（`node-llama-cpp/bins`、`llama/localBuilds`、`@node-llama-cpp/*`）；只挑 `${os}-${arch}` 二进制避免塞全平台 | 源码确证 |
| 公证 | 原生二进制必须 unpack 后才能被 codesign，否则 Apple 公证**整体失败**；entitlements 加 `allow-jit`、`allow-unsigned-executable-memory`；electron-builder `mac.notarize/hardenedRuntime` | electron-builder 官方确证 |
| 下载 | `createModelDownloader` → `app.getPath('userData')/models`，parallel 4，断点续传(ipull)，**自己补 SHA**（官方仅校验文件大小） | 源码确证 |

主要来源：node-llama-cpp.withcat.ai（guide/electron、grammar、objects-lifecycle、downloading-models、Metal、API）、官方 electron 模板 electron-builder.ts、llama.cpp quantize README / discussions#2094、HF Qwen2.5-1.5B-Instruct-GGUF、electron.build/docs/notarization。

## 10. 测试

- 删 `test/local-extract-smoke.mjs`；改 `test/screen-smoke.mjs`（去关键词部分）。
- 补 `test/ipc-channels-smoke.mjs` 新通道。
- 新增 `local-model` 契约测试：用**桩**（不加载真模型，CI 无 GPU）验证 `extract()` 输出 schema 合法、空输入返回 `[]`、JSON 解析容错。真模型质量靠人工自测脚本（非 CI）。
- `npm run typecheck` 两个 tsconfig 必过。

## 11. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 1.5B 中文抽取质量未知 | **上线前用真实中文日程样本自测**；VLM 自动升级是安全网；Q5_K_M 起步可升档；阈值 `CONF_MIN` 可调 |
| 原生二进制签名/公证破坏构建 | 用官方模板配置，**早期就跑一次完整公证**；功能 opt-in 默认关，构建失败不影响主功能 |
| 首次下载失败/离线 | 功能优雅停用，状态置 `error`，手动捕获老路不受影响；可重试 |
| 低配 Mac 内存/延迟 | idle-unload + 关功能释放 + context 512；默认关，用户自选开 |
| grammar 不停机/幻觉日程 | 数组空 schema + prompt 约束 + maxTokens + parse try/catch |
| 改动面横跨 main/shared/renderer/test | node-llama-cpp 收敛进单模块；分阶段实施（见计划） |

**回滚**：本工作在独立分支 `feat/screen-sense-local-model`；规则代码删除后仍在 git 历史可恢复。`screenSenseLocalModel` 默认关 = 出问题时用户/默认即处于安全态。

## 12. 未决 / 需自测清单（不阻塞实施，落地时验证）

1. Qwen2.5-1.5B 各量化档在中文日程抽取上的实际质量差（Q5_K_M 是否够，需真样本）。
2. `CONF_MIN` 升级阈值初值（0.6 待调）。
3. dispose 后 macOS 进程 RSS 是否完全回落 / Metal buffer 残留（活动监视器实测）。
4. grammar 强制下「无日程返回 []」命中率 + 是否触发 won't-stop 截断。
5. warmup 与 flash attention 在目标机型的实测收益。
6. SHA 校验需自行实现（官方仅文件大小）。
7. idle-unload 阈值（暂定 10min）。

## 13. 实施顺序建议（详见后续 plan）

1. 接入 node-llama-cpp + 打包/签名/下载基建（先跑通「下载→加载→warmup→dispose」最小闭环 + 公证）。
2. `local-model` 模块 + grammar schema + extract()（桩测 + 真模型自测）。
3. screenwatch 接线：删规则、接 extract、自动升级 VLM。
4. 设置页开关 + 下载进度 UI + 生命周期（含 idle-unload）。
5. 类型/IPC/预览卡迁移 + 测试清理。
6. 删 local-extract.ts / 关键词门 / 相关测试。
