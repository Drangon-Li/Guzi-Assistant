# 可检索记忆验证（mem0 式，EShell 自有栈 · 中文）

借鉴 mem0 的 ADDITIVE_EXTRACTION 设计（Apache-2.0），在 EShell 自己的 TS 栈里实现**原子、自包含、含时间锚点的中文记忆** + embedding 去重 + 语义检索（纯 TS 余弦，免 sqlite-vec native 依赖，跨平台/Windows 友好）。算法在 `src/shared/memory-extract.ts`。

为什么不用 mem0/oss 依赖：试跑（`tmp/mem0-trial`）证明 mem0 管线确实更好（原子记忆 + 语义检索 + 自动去噪护凭据），但 (1) 默认输出英文（中文产品需中文）(2) 向量库 in-memory 不持久。故按调研建议「把 mem0 的 prompts/pipeline 搬进 TS」，补足中文 + 本地持久。

## 跑

```bash
node eval/memory-retrieval/run.mjs   # 自包含；直连 relay 的 LLM + embeddings，不注册账号
```

## 维度（全部应 ✓）

| 维度 | 含义 |
|---|---|
| atomicMemories | 形成足够多的原子记忆 |
| chinese | 记忆为中文（修掉 mem0 英文输出） |
| credentialSafe | 验证码/密码不入记忆 |
| noiseFiltered | 菜单/广告/闲聊不成记忆 |
| retrieval | 语义检索 top-1 命中（5 个 query） |
| todos | 隐含待办被抽出 |

## 基线结果（2026-06-15，LLM deepseek-v4-flash + embed text-embedding-3-small）

**6/6 维度通过**，检索 5/5。14 条捕获 → 10 条原子中文记忆（带日期 + 待办），噪声/凭据全过滤，每个 query 命中正确记忆（score 0.44~0.58）。

## 接入状态

算法已验证。落地待办：①`embed` Edge Function（代理 relay 嵌入 + 计费，客户端无 key）②main 记忆层改用本模块（抽取→嵌入→去重→存 memories 表 + embedding）③记忆页语义检索。已替换批式 memory-consolidate（已删除）。
