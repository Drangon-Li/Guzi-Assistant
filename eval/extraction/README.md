# 抽取算法验证（extraction eval）

把真实风格的中文样本（群通知 / 邮件 / 聊天 / 自我提醒 / 广告噪声）跑过**线上 parse 网关 + 真实模型**，按金标打分，量化「算法是否好用」。

## 跑

```bash
node eval/extraction/run.mjs
```

自包含：用 esbuild 临时打包 `src/shared/parsing.ts`（真实算法代码）后运行；会注册一个一次性 Supabase 账号并消耗少量积分。跑完清理：

```sql
delete from auth.users where email like 'eshell-val-%';
```

结果写入 `last-results.json`。

## 维度

| 维度 | 含义 |
|---|---|
| detection | 该产出待办的样本产出了 ≥1 项；该静默的（广告/闲聊/分给别人的）产出 0 项 |
| belongs | 首要事项归属判断（yes/no/uncertain）符合金标 |
| notAutoAdd | 群发/委婉/模糊场景**不**高置信直接 add（应 confirm） |
| time | 相对/绝对时间解析正确（明天/周五/6月20日 → YYYY-MM-DD） |
| location | 地点（楼宇/房间号）提取正确 |
| credential | 验证码/密码**不得**进 title/notes/evidence |
| multi | 一条通知里多事项拆成独立任务 |

## 基线结果（2026-06-15，模型 deepseek-v4-flash）

| 版本 | 整体 | detection | belongs | time | notAutoAdd | location | credential |
|---|---|---|---|---|---|---|---|
| 改前 | 81% | 94% | 57% | 100% | 100% | 100% | 100% |
| 改后 | **94%** | 100% | **86%** | 100% | 100% | 100% | 100% |

改动：`BELONGING_RULES` 补「第一人称自述/自己写给自己的待办 → belongs=yes/owner」与「群发但属本人学业/工作必办 → 倾向 yes」两条规则。改后自我提醒（"记得明天交报销单"）、本人开题报告/课程截止均正确归属，无回归。

> belongs 唯一未满分项 `vague-notice`（"具体另行通知" 的模糊通知）属边界样本，模型偶发产 0/1 项，非确定性，非缺陷。
