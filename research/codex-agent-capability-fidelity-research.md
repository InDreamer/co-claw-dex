# Claude → Codex Agent 能力保真研究

> 归档说明：这份文档保留为能力风险研究输入，仅用于历史追溯与设计背景参考。
>
> 当前实施边界和阶段计划已收口到 `docs/implementation/hybrid-native-implementation-plan.md`，后续 coding 以该实现文档为准。

> 研究目标：分析当前项目在“换掉 Claude 大脑、接入 Codex 大脑”之后，哪些 agent 能力是真正模型无关的，哪些轻度依赖提示词/协议，哪些高度依赖 Claude 的行为先验；并给出补偿方向。
>
> 研究边界：本报告只覆盖**能力保真研究**，不做完整仓库结构盘点，不展开完整迁移路线图，不直接给出代码改造方案。

---

## 0. 执行摘要

**结论一句话**：迁移后最容易残缺的，不是“工具还能不能调”，而是**围绕工具的行为层能力**——包括 memory、plan approval、多 agent 协作纪律、compact 后连续性、以及复杂提示下的结构化服从性。

**最大隐患**：系统表面功能仍然齐全，但在 Codex 上出现“能运行、但质量/稳定性/服从性/协作效果下降”的弱退化；如果不先做保真验证，最终会把迁移误判为成功。

### 最高风险区

1. **Memory 机制与记忆纪律**
2. **Session memory / notes continuity**
3. **Plan mode / approval 流程**
4. **多 agent 协作协议与任务纪律**
5. **Compaction / summarization / 长上下文连续性**
6. **Instruction precedence（system / CLAUDE.md / hooks / compact 附件之间的优先级）**
7. **Legacy control-message compatibility（plan/shutdown request-response 协议兼容性）**

### 相对低风险区

1. 工具 schema 与工具调用入口
2. 权限审批协议
3. 强制 tool routing
4. agent 生命周期、后台任务、resume、worktree 基础设施
5. task/message 的磁盘持久化与路由

---

## 1. 研究方法与判断标准

本研究把能力拆成三类：

- **A. 模型无关**：主要由 runtime / protocol / state machine 保证，换模型后能力形态应基本不变。
- **B. 轻度依赖提示词/协议**：底座机制仍在，但最终效果依赖模型是否稳定遵守若干操作规则。
- **C. 高度依赖 Claude 行为先验**：并非 API 耦合，但现有能力实质上建立在 Claude 长期表现出的服从性、节奏感、结构稳定性、和对 prompt 细节的敏感响应之上。

本报告所有结论均区分为：

- **已证实**：可直接从代码或 prompt 中找到证据。
- **高概率推断**：基于现有实现方式，可合理预期 Codex 会在该处退化，但需要专项验证。
- **待验证假设**：影响迁移结论，但目前不能仅凭代码静态阅读断言。

---

## 2. 核心结论

### 2.1 当前项目有哪些 agent 能力必须“完整保真”？

必须完整保真的不是所有功能，而是这些**关键工作流能力**：

1. **强制工具与权限协议**：tool choice、parallel tool calls、approval/permission flow
2. **Agent lifecycle 语义**：background、resume、worktree isolation、continuation metadata
3. **Task discipline**：复杂任务主动建 task、推进状态、维护 ownership/blockers
4. **Plan/approval 流程**：何时进 plan mode、何时用 AskUserQuestion、何时必须用 ExitPlanMode
5. **Memory 行为**：remember/forget、index 维护、去重、stale recall 前验证、scope 区分
6. **Session memory / notes continuity**：notes 更新纪律、只编辑指定 notes 文件、compact 前后的会话连续性
7. **多 agent 协作纪律**：使用 SendMessage 回传、任务认领、非重叠分工、正确 shutdown / approval 协议
8. **Compaction 连续性**：压缩时的格式服从、压缩后的上下文质量、长会话后的工作延续
9. **结构化输出稳定性**：schema 输出、标签输出、工具结果与文本结果切换的稳定性
10. **Instruction precedence**：system prompt、CLAUDE.md、hook、compact attachment 混合时的优先级稳定性

### 2.2 哪些能力是真正模型无关的？

真正模型无关的，主要是**runtime 与协议硬机制**：

- tools/function schema 的构造与注入
- forced / auto tool choice
- permission mode / approval 的协议流转
- agent lifecycle（spawn、resume、background、worktree isolation）
- task/message 的持久化、registry、路由、ownership/blockers 的更新逻辑
- team/task list 的磁盘共享与基础设施
- legacy control-message 的底层 request/response 通道

### 2.3 哪些能力虽不是 API 耦合，但高度依赖 Claude 的行为先验？

高度依赖 Claude 行为先验的，主要是**prompt 驱动的行为约束**：

- memory 使用与维护方式
- session memory / notes 的严格维护方式
- plan mode 的主动进入与规范退出
- 多 agent 的协作纪律与消息回传习惯
- compaction 的严格格式服从
- 长提示下对 instruction priority 的稳定保持
- “不要重复工作”“不要用文本替代协议工具”“先验证再推荐”这类高阶软规范

### 2.4 换成 Codex 后，最容易出现“功能还在，但效果变差”的环节是什么？

最容易退化的环节是：

1. **memory hygiene**：不写 / 少写 / 写错 / 不去重 / 不验旧记忆
2. **session memory / notes continuity**：notes 提炼质量下降、模板结构维护不稳、会话连续性变差
3. **plan cadence**：不进、晚进、乱收口、不用 ExitPlanMode
4. **multi-agent discipline**：不用 SendMessage、task 同步不稳定、角色边界松动
5. **compaction quality**：标签缺失、额外 prose、工具调用污染、压缩质量下降
6. **instruction priority drift**：长会话后系统规则的稳定性下降

### 2.5 哪些问题可以靠提示词/协议补偿，哪些需要 runtime 层补偿？

**可在 prompt/协议层补偿的**：

- task discipline 的提示强化
- plan heuristic 的重写与简化
- teammate 协作规则的更强约束表达
- compact prompt 的压缩与重写
- structured output 的更明确模板

**必须在 runtime/编排层补偿的**：

- memory 的 remember/forget/index/stale-check
- plan approval 的状态机化
- multi-agent completion discipline 的一致性检查
- compaction 输出验证与 fallback
- 指令优先级冲突下的更明确 runtime 组合策略

### 2.6 哪些能力必须优先做保真验证，否则迁移结论不可信？

必须优先验证：

1. **Compaction E2E**
2. **Memory fidelity**
3. **Plan approval fidelity**
4. **Multi-agent collaboration fidelity**
5. **Instruction precedence fidelity**
6. **Forced tool / strict schema fidelity**

---

## 3. 能力保真矩阵

| 能力 | 分类 | 当前形态 | 迁移后主要风险 | 补偿优先级 |
|---|---|---|---|---|
| 工具调用与强制 tool routing | A | runtime 硬机制 | 低 | 中 |
| 权限审批 / permission mode | A | protocol/state machine | 低 | 中 |
| 后台 agent / resume / worktree | A | runtime 硬机制 | 低 | 低 |
| task list / blockers / ownership | A/B | 底座硬、使用软 | 中 | 中 |
| session memory / notes continuity | B/C | 运行时约束 + prompt 纪律 | 高 | 高 |
| plan mode 进入/退出节奏 | B/C | 大量 prompt 驱动 | 高 | 高 |
| memory 读写 / remember-forget | C | prompt 驱动为主 | 很高 | 很高 |
| teammate 协作纪律 | C | 协议 + prompt 驱动 | 很高 | 很高 |
| structured output / tags / schema | B | schema 部分硬、其余软 | 中 | 中 |
| compaction / summarization | C | 几乎纯行为协议 | 很高 | 很高 |
| instruction precedence 稳定性 | C | 长 prompt 行为依赖 | 很高 | 很高 |

---

## 4. 分能力详细分析

## 4.1 工具调用、权限、tool routing

### 已证实

- OpenAI/Codex backend 明确把 tools 转换为 function schema，并显式设置 `tool_choice`、`parallel_tool_calls = true`、`reasoning.effort`：
  - `src/services/modelBackend/openaiResponsesBackend.ts:247-304`
- permission mode / plan mode 是 runtime schema，而不是仅靠模型自觉：
  - `src/entrypoints/sdk/coreSchemas.ts:338-347`
- approval 请求与响应走专门协议：
  - `src/remote/RemoteSessionManager.ts:189-198`
  - `src/remote/RemoteSessionManager.ts:247-269`

### 结论

这部分主要是**模型无关能力**。只要 OpenAI Responses backend 的 schema 语义与现有 runtime 匹配，Claude → Codex 不太会把能力本身打坏。

### 高概率推断

- 退化更多体现在“何时调工具、是否主动并行、是否遵守最佳实践”，而不是“是否能调工具”。

### 补偿方向

- 优先确保 backend 请求与原有工具语义一致。
- 不需要把主要精力放在“工具是否存在”，而要放在“工具是否被正确使用”。

---

## 4.2 Agent 生命周期、resume、background、worktree

### 已证实

- agent prompt 明确支持 background、resume、worktree isolation：
  - `src/tools/AgentTool/prompt.ts:255-272`
- Agent tool 运行时支持相应生命周期语义：
  - `src/tools/AgentTool/AgentTool.tsx:1338`
  - `src/tools/AgentTool/AgentTool.tsx:1378`

### 结论

这类能力的**基础设施本身模型无关**。Codex 不会直接让它们消失。

### 高概率推断

- 风险主要不在 lifecycle 本身，而在**调度纪律**：是否会正确 resume、是否会错误预测子 agent 结果、是否会 mid-flight 做不该做的事。

### 补偿方向

- 用更严格的 protocol prompt 限定“不要猜 subagent 结果”“等待通知后再综合”。
- 必要时在 runtime 层强化“结果未返回前不可宣称完成”的约束。

---

## 4.3 Task system / task discipline

### 已证实

- TaskCreate 明确要求复杂任务主动拆解并管理：
  - `src/tools/TaskCreateTool/prompt.ts:16-30`
- TaskUpdate 明确要求任务推进时及时更新状态：
  - `src/tools/TaskUpdateTool/prompt.ts:5-49`
- 任务状态、ownership、blockers 有实际持久化与逻辑控制：
  - `src/utils/tasks.ts:199`
  - `src/utils/tasks.ts:221`
  - `src/utils/tasks.ts:535-680`
- in-process teammates 会自动 claim / mark in_progress：
  - `src/utils/swarm/inProcessRunner.ts:624`
  - `src/utils/swarm/inProcessRunner.ts:645`

### 结论

- **task 系统本身是模型无关的**。
- **task discipline 是轻度依赖模型的**。

### 高概率推断

Codex 迁移后更常见的问题不是 task 无法使用，而是：

- 少建 task
- 状态更新滞后
- 结束后不标完成
- blockers/ownership 维护不一致

### 补偿方向

**Prompt/协议层**：
- 简化 task 使用规则，减少“建议式措辞”。

**Runtime 层**：
- 在复杂任务或 team 模式下，增加 task discipline 监控与提醒。
- completion 前检查 task state 是否匹配。

---

## 4.4 Session memory / notes continuity

### 已证实

- session memory 通过一个受限 subagent 更新 notes 文件，prompt 明确要求“ONLY use Edit tool to update the notes file, then stop”，并禁止修改模板结构：
  - `src/services/SessionMemory/prompts.ts:53-80`
- session memory 更新 prompt 还会要求并行发出所有 Edit，而不调用其他工具：
  - `src/services/SessionMemory/prompts.ts:53-80`
- session memory runtime 只允许该代理编辑 notes 文件，属于 tightly-scoped behavior：
  - `src/services/SessionMemory/sessionMemory.ts:315`
- session memory 还带有截断、超预算压缩与 section 级别提醒逻辑：
  - `src/services/SessionMemory/prompts.ts:8-10`
  - `src/services/SessionMemory/prompts.ts:67-80`
  - `src/services/SessionMemory/prompts.ts:164-196`
  - `src/services/SessionMemory/prompts.ts:226-247`

### 结论

这是一个**介于 prompt 纪律与 runtime 约束之间**的能力：

- notes 文件、路径、调用边界本身是 runtime 可控的；
- 但“是否只改该文件、是否保持模板结构、是否正确提炼会话状态”明显依赖模型服从。

### 高概率推断

Codex 替换后可能出现：

- notes 提炼密度下降
- section 更新不全或过度改写
- 不稳定遵守“只 Edit 然后停止”
- compact / session memory / 主对话三者之间的连续性变差

### 待验证假设

- Codex 是否更容易把 session memory 任务当自由总结，而不是严格 notes maintenance。
- Codex 是否更容易违反 section preservation 规则。

### 补偿方向

**Prompt/协议层**：
- 把 notes 维护规则压缩成更强的结构保持约束。

**Runtime 层**：
- 对 notes 变更做结构校验
- 检查是否只修改允许文件
- 对缺失 section / 模板破坏做自动拒绝或修复

---

## 4.5 Plan mode / approval / AskUserQuestion / ExitPlanMode

### 已证实

- 计划阶段的回合节奏、收尾方式、审批切换，大量写在 prompt / messages 规则中：
  - `src/utils/messages.ts:3286-3292`
  - `src/utils/messages.ts:3331-3378`
- EnterPlanMode 针对不同用户/行为风格已有两套启发式：
  - `src/tools/EnterPlanModeTool/prompt.ts:23-98`
  - `src/tools/EnterPlanModeTool/prompt.ts:108-163`
- ExitPlanMode 是显式审批协议，并向 team lead 发送 `plan_approval_request`：
  - `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:224`
  - `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:264`
  - `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:278`
- AskUserQuestion 明确与 ExitPlanMode 区分职责：
  - `src/tools/AskUserQuestionTool/prompt.ts:32-44`

### 结论

- 审批协议通道本身可保真。
- 但“什么时候进入”“是否按要求退出”“是否误用自然语言替代协议工具”，明显是**行为依赖型能力**。

### 高概率推断

Codex 更可能出现：

- 该进 plan mode 不进
- 进得太晚
- 用文本问“计划可以吗”而不用 `ExitPlanMode`
- 不稳定遵守“plan mode turn ending”规则

### 待验证假设

- Codex 是否比 Claude 更倾向于直接开干而跳过计划阶段。
- Codex 是否更少执行“先问一个精确问题，而不是进入完整 planning loop”的细粒度判断。

### 补偿方向

**Prompt/协议层**：
- 重写 Codex 版 heuristic，减少分支与例外。
- 把违规示例写得更明确。

**Runtime 层**：
- 把 plan approval 变为真正 state transition，而非依赖文本服从。
- 将 plain-text approval ask 视为不合格路径。

---

## 4.6 Memory 机制与记忆纪律

### 已证实

- memory prompt 直接把记忆系统、分类、保存格式、索引规则教给模型：
  - `src/memdir/memdir.ts:236-315`
  - `src/memdir/teamMemPrompts.ts:60-99`
- `MEMORY.md` 被加载进上下文，并有截断逻辑：
  - `src/memdir/memdir.ts:295-313`
  - `src/memdir/teamMemPrompts.ts:51-54`
- QueryEngine 在自定义 system prompt 场景下会额外注入 memory mechanics，并明确注释“调用方需要 Claude 知道怎么用它”：
  - `src/QueryEngine.ts:310-319`
- memory extraction agent 被假定为主对话的“perfect fork”，并依赖严格的多步保存流程：
  - `src/services/extractMemories/prompts.ts:4-9`
  - `src/services/extractMemories/prompts.ts:35-42`
  - `src/services/extractMemories/prompts.ts:70-81`
  - `src/services/extractMemories/prompts.ts:127-140`
- header wording 与 section placement 会显著影响 recall 行为：
  - `src/memdir/memoryTypes.ts:228-255`

### 结论

memory 是当前系统中**最典型的高风险保真能力**：

- 存储路径、文件系统本身模型无关；
- 但“什么时候读、什么时候写、如何分类、如何避免重复、如何先验证再推荐”高度依赖模型行为。

### 高概率推断

Codex 替换后可能出现：

- remember/forget 执行率下降
- 写入重复项，或漏维护 `MEMORY.md`
- 把过期 memory 当现状
- 在 custom prompt + memory injection 下出现优先级冲突
- 跨 private/team scope 的判断变弱

### 待验证假设

- Codex 是否比 Claude 更容易把“memory 使用说明”当背景知识而非强协议。
- Codex 是否更容易忽视“Before recommending from memory”中的验证要求。

### 补偿方向

**Prompt/协议层**：
- 可改进 wording，但收益有限。

**Runtime 层（必须）**：
- remember / forget 结构化工具
- 自动维护 `MEMORY.md`
- 写入时自动去重/校验 frontmatter
- recall 前存在性检查 guard
- stale-memory recommendation guard

---

## 4.7 多 agent 协作 / SendMessage / teamwork discipline

### 已证实

- teammate addendum 明确规定普通文本对队友不可见，必须用 `SendMessage`：
  - `src/utils/swarm/teammatePromptAddendum.ts:11-18`
- TeamCreate prompt 明确团队工作流、task ownership、idle 语义、消息回传要求：
  - `src/tools/TeamCreateTool/prompt.ts:37-110`
- SendMessage prompt 定义 legacy control messages（shutdown / plan approval）：
  - `src/tools/SendMessageTool/prompt.ts:38-47`
- SendMessage 路由、registry、resume/stopped-agent handling 有硬逻辑：
  - `src/tools/SendMessageTool/SendMessageTool.ts:800-868`
  - `src/state/AppStateStore.ts:161-167`
- task ownership/blockers 的协调有实际逻辑：
  - `src/utils/tasks.ts:535-680`

### 结论

- **协作基础设施是模型无关的**。
- **协作纪律与协作效果是高度模型相关的**。

### 高概率推断

迁移到 Codex 后更容易出现：

- 不用 `SendMessage` 正确回传
- task ownership 更新不一致
- agent 之间重复劳动
- 不稳定遵守“不要预测别的 agent 结果”
- shutdown / approval 的礼仪性协议执行率下降

### 待验证假设

- Codex 是否比 Claude 更容易“越俎代庖”或直接替 teammate 做综合判断。
- Codex 是否更容易把团队 protocol 视作建议而非硬约束。

### 补偿方向

**Prompt/协议层**：
- 明确“文本不可见”“只用 SendMessage 沟通”的 failure consequence。

**Runtime 层（建议强补）**：
- 未 `SendMessage` / 未 `TaskUpdate` 不允许宣称协作完成
- 对 completion、ownership、message 回传做一致性校验
- 对重复劳动或未认领执行的情况增加监测

---

## 4.8 Structured output / output format / schema compliance

### 已证实

- OpenAI backend 已支持 strict JSON Schema 输出：
  - `src/services/modelBackend/openaiResponsesBackend.ts:282-290`
- 系统 prompt 拼装顺序固定：
  - `src/constants/prompts.ts:596-615`
  - `src/context.ts:114-149`
  - `src/context.ts:155-188`

### 结论

- 在 strict schema 场景下，保真性相对更强。
- 但非 schema 场景下的结构稳定性仍依赖模型服从。

### 高概率推断

Codex 上可能更常见的问题：

- 多余 prose
- 标签结构不稳定
- 文本与 tool use 切换节奏不同

### 补偿方向

- 能 schema 的地方尽量 schema。
- 非 schema 场景加解析校验与后处理修复。

---

## 4.9 Compaction / summarization / 长上下文连续性

### 已证实

- compact prompt 明确要求：
  - `TEXT ONLY`
  - 不得调用工具
  - 输出 `<analysis>` 与 `<summary>`
  - `src/services/compact/prompt.ts:19-25`
  - `src/services/compact/prompt.ts:31-44`
- compaction 后系统会剥离 `<analysis>`，保留整理后的 summary 进入后续上下文：
  - `src/services/compact/prompt.ts:12-18`
  - `src/services/compact/compact.ts:528-582`
  - `src/services/compact/compact.ts:593-639`
- session memory compact 还会进行截断：
  - `src/services/compact/sessionMemoryCompact.ts:459-474`
- OpenAI backend 不走 provider 的原生 thread continuation，而是重建 translated history + cache key：
  - `src/services/modelBackend/openaiResponsesBackend.ts:253-267`

### 结论

这是迁移后**最需要优先保真验证**的能力之一。

它不是“是否支持 summarize”，而是：

- 模型能否在关键压缩点严格 obey 协议
- 压缩后的 summary 是否足够准确、可延续
- 多次 compaction 后 instruction priority 是否稳定

### 高概率推断

Codex 上更容易出现：

- compact 输出不带标签或带额外结构噪音
- compact 时误用工具
- 压缩质量下降，导致后续任务连续性变差
- repeated compact 后越来越像“还记得主题，但丢了操作协议”

### 待验证假设

- Codex 在 repeated compaction 后是否比 Claude 更早失去 plan/memory/task 纪律。
- Codex 是否对 compact 后 reinjected instructions 响应更弱。

### 补偿方向

**Prompt/协议层**：
- 重写 compact prompt，缩短、硬化、减少噪音。

**Runtime 层（必须）**：
- compact 输出结构验证
- invalid compact fallback / repair
- 检测 tool-call contamination
- continuity check（压缩后继续任务的正确性检查）

---

## 5. 哪些能力是真正模型无关的，哪些依赖提示词/协议，哪些高度依赖 Claude 先验

## 5.1 A. 模型无关

这些能力主要由 runtime / protocol / state 管：

- tools/function schema 注入：`src/services/modelBackend/openaiResponsesBackend.ts:247-304`
- forced/auto tool choice：`src/services/modelBackend/openaiResponsesBackend.ts:269-279`
- permission mode / approval：`src/entrypoints/sdk/coreSchemas.ts:338-347`, `src/remote/RemoteSessionManager.ts:189-269`
- background agent / worktree / resume：`src/tools/AgentTool/prompt.ts:255-272`, `src/tools/AgentTool/AgentTool.tsx:1338`, `src/tools/AgentTool/AgentTool.tsx:1378`
- disk-backed task/message routing：`src/utils/tasks.ts:199-221`, `src/utils/tasks.ts:535-680`, `src/tools/SendMessageTool/SendMessageTool.ts:800-868`

**判断**：这部分迁移后应优先保证语义等价，而不是担心模型风格差异。

## 5.2 B. 轻度依赖提示词/协议

这些能力的底座仍然可靠，但效果依赖模型遵守协议：

- task proactive usage：`src/tools/TaskCreateTool/prompt.ts:16-30`
- TaskUpdate 节奏：`src/tools/TaskUpdateTool/prompt.ts:5-49`
- session memory / notes 更新纪律：`src/services/SessionMemory/prompts.ts:53-80`, `src/services/SessionMemory/sessionMemory.ts:315`
- AskUserQuestion vs ExitPlanMode 的职责分工：`src/tools/AskUserQuestionTool/prompt.ts:32-44`, `src/tools/ExitPlanModeTool/prompt.ts:14-28`
- 非 schema 场景下的输出结构稳定性：`src/services/modelBackend/openaiResponsesBackend.ts:282-290`

**判断**：这部分可以通过 Codex 定制 prompt 与少量 runtime 约束提升保真。

## 5.3 C. 高度依赖 Claude 行为先验

这些能力虽然不依赖 Anthropic API，但当前实现方式强依赖 Claude 的行为习惯：

- memory mechanics 与 recall discipline：`src/QueryEngine.ts:310-319`, `src/memdir/memdir.ts:236-315`, `src/memdir/memoryTypes.ts:228-255`
- teamwork discipline 与 SendMessage etiquette：`src/utils/swarm/teammatePromptAddendum.ts:11-18`, `src/tools/TeamCreateTool/prompt.ts:37-110`
- plan/shutdown control message compatibility：`src/tools/SendMessageTool/prompt.ts:38-47`, `src/tools/SendMessageTool/SendMessageTool.ts:46`
- session memory notes maintenance：`src/services/SessionMemory/prompts.ts:53-80`, `src/services/SessionMemory/sessionMemory.ts:315`
- compaction obedience：`src/services/compact/prompt.ts:19-25`, `src/services/compact/prompt.ts:31-44`
- long-context continuity via compacted summaries：`src/services/compact/compact.ts:528-639`
- “不要重复工作”“不要猜 agent 结果”“只做 Edit 然后停止”这类高阶约束：`src/services/SessionMemory/prompts.ts:53-80`, `src/tools/AgentTool/prompt.ts:257-268`

**判断**：这些是本次迁移的核心风险带。

---

## 6. 隐性行为差异清单

## 6.1 已证实的隐性依赖

### 6.1.1 Memory 行为对 wording / section placement 极敏感
- 证据：`src/memdir/memoryTypes.ts:228-255`
- 含义：prompt 的“位置”和“标题形式”会直接影响 recall-side 行为。
- 风险：Claude 上调优过的 wording，不一定在 Codex 上保真。

### 6.1.2 Memory mechanics 需要显式注入，不是自然推断
- 证据：`src/QueryEngine.ts:310-319`
- 含义：系统知道这个能力不是“模型自己自然会做”，而是要教会它。
- 风险：Codex 可能对这块 instruction 的权重与 Claude 不同。

### 6.1.3 Team 协作规则很多只是 prompt 规范
- 证据：`src/utils/swarm/teammatePromptAddendum.ts:11-18`, `src/tools/TeamCreateTool/prompt.ts:37-110`
- 含义：队友协作质量依赖模型把这些规范当协议来执行。
- 风险：Codex 若把它们当作建议，团队表现会明显劣化。

### 6.1.4 Compact 几乎完全是行为协议
- 证据：`src/services/compact/prompt.ts:19-25`
- 含义：不是 API 能力，而是模型在单次关键摘要时的服从性。
- 风险：只要 compact 质量下降，长会话整体质量会系统性下降。

## 6.2 高概率推断的行为差异

1. Codex 更可能少做 task hygiene，而不是彻底不支持 task。
2. Codex 更可能用自然语言替代 protocol tool。
3. Codex 在 system / CLAUDE.md / hooks / compact attachments 混合时，指令权重排序可能不同。
4. Codex 在 repeated compact 后，可能更早出现“主题还在，纪律丢了”的现象。

## 6.3 待验证假设

1. Codex 是否更容易重复 teammate 的工作。
2. Codex 是否更少执行“先验证 memory claim 再推荐”。
3. Codex 是否在 custom system prompt + memory mechanics 注入时更容易冲突。
4. Codex 是否在长会话中更快忽略 plan mode / shutdown / approval 约束。

---

## 7. 补偿方向

## 7.1 适合在 prompt / 协议层解决的问题

### 7.1.1 重写 Codex 定制版 plan heuristic
目标：减少 Claude 时代针对行为风格调出来的冗长启发式，把规则改成更短、更硬、更少例外的版本。

### 7.1.2 重写 teammate 协作协议文案
目标：强调“普通文本不可见”“必须 SendMessage”“必须对 task 负责”的 failure consequence。

### 7.1.3 重写 task discipline 提示
目标：让复杂任务下的 task create/update 更像 protocol，而不是风格建议。

### 7.1.4 压缩 compact prompt
目标：降低 prompt 噪音，减少模型把 compact 任务理解成“自由总结”的概率。

### 7.1.5 提升 structured output 提示稳定性
目标：减少非 schema 场景下的漂移。

## 7.2 必须在 runtime / 编排层解决的问题

### 7.2.1 Memory 必须工具化/状态机化
建议的 runtime 补偿方向：
- remember / forget 结构化接口
- 自动维护 `MEMORY.md`
- frontmatter 与索引一致性校验
- stale recall 前 existence/grep guard
- private/team scope 约束校验

### 7.2.2 Plan approval 必须状态机化
建议的 runtime 补偿方向：
- plan mode 进入/退出成为显式状态
- plain-text approval ask 不计为有效完成
- plan mode turn ending 不满足协议时给出 runtime 反馈

### 7.2.3 Multi-agent discipline 必须做一致性校验
建议的 runtime 补偿方向：
- completion 前校验是否已 `SendMessage` / `TaskUpdate`
- ownership / blockers / task state 与 agent 报告一致
- 检测同一文件区间的重复劳动与角色越界

### 7.2.4 Compaction 必须做输出验证与 fallback
建议的 runtime 补偿方向：
- 标签/结构校验
- tool-call contamination 检测
- compact repair / fallback 路径
- compact 后 continuity probe

### 7.2.5 Instruction precedence 需要更明确的 runtime 组合策略
目标：减少不同类型指令叠加时，依赖模型自行分层理解的风险。

## 7.3 可能无法完全补平的能力差异

以下差异即便加 runtime，也很难 100% 抹平：

1. **高阶节奏感**：何时该拆、该问、该停、该同步。
2. **长提示下的隐性服从稳定性**：不同模型天生不同。
3. **多 agent 的自然协作默契**：基础设施可等价，协同风格难完全等价。
4. **复杂软规范的自发执行率**：例如“不要重复劳动”“不要 delegate understanding”。

---

## 8. 必须优先建立的保真测试

## 8.1 Compact E2E
验证目标：
- 不调用工具
- 合法输出 `<analysis>` / `<summary>`
- summary 被正确保留、analysis 被剥离
- compact 后继续任务不漂移

关键证据：
- `src/services/compact/prompt.ts:19-25`
- `src/services/compact/prompt.ts:31-44`
- `src/services/compact/compact.ts:528-639`

## 8.2 Memory fidelity
验证目标：
- remember / forget
- frontmatter 合法
- `MEMORY.md` 自动维护或正确维护
- 去重
- stale recall 前验证
- private/team scope 正确

关键证据：
- `src/memdir/memdir.ts:236-315`
- `src/memdir/teamMemPrompts.ts:60-99`
- `src/memdir/memoryTypes.ts:228-255`
- `src/QueryEngine.ts:310-319`

## 8.3 Session memory / notes continuity fidelity
验证目标：
- 只修改允许的 notes 文件
- 保持 section/header/template 结构不被破坏
- notes 提炼密度与关键状态保真
- compact / session memory / 主对话三者连续性稳定

关键证据：
- `src/services/SessionMemory/prompts.ts:53-80`
- `src/services/SessionMemory/prompts.ts:164-247`
- `src/services/SessionMemory/sessionMemory.ts:315`

## 8.4 Plan approval fidelity
验证目标：
- 该进时会进 plan mode
- 澄清用 AskUserQuestion，不滥用
- 审批用 ExitPlanMode，而不是文本
- plan mode 收尾遵守协议

关键证据：
- `src/tools/EnterPlanModeTool/prompt.ts:23-98`
- `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:224-278`
- `src/utils/messages.ts:3286-3378`

## 8.5 Multi-agent collaboration fidelity
验证目标：
- teammate 正确使用 SendMessage
- task ownership / blockers 一致
- team lead 正确综合回传
- teammate 不重复劳动
- shutdown / approval 协议正确

关键证据：
- `src/utils/swarm/teammatePromptAddendum.ts:11-18`
- `src/tools/SendMessageTool/prompt.ts:38-47`
- `src/tools/SendMessageTool/SendMessageTool.ts:800-868`
- `src/utils/tasks.ts:535-680`

## 8.6 Instruction precedence fidelity
验证目标：
- system prompt vs CLAUDE.md vs hook vs compact attachment 之间的优先级一致性
- repeated compact 后仍能维持核心协议

关键证据：
- `src/constants/prompts.ts:596-615`
- `src/context.ts:114-149`
- `src/context.ts:155-188`
- `src/services/compact/compact.ts:593-639`

## 8.7 Tool-routing / strict schema fidelity
验证目标：
- forced tool choice
- parallel tool calls
- strict JSON schema 输出
- 文本输出与 tool use 切换稳定

关键证据：
- `src/services/modelBackend/openaiResponsesBackend.ts:269-304`

---

## 9. 给另外两个队长的移交事项

## 9.1 给“源码边界队长”

建议重点沿这些边界反推代码耦合与设计风险：

1. **Memory 注入与加载边界**
   - `src/QueryEngine.ts:310-319`
   - `src/memdir/memdir.ts:236-315`
   - `src/memdir/teamMemPrompts.ts:60-99`

2. **Session memory / notes continuity 边界**
   - `src/services/SessionMemory/prompts.ts:53-80`
   - `src/services/SessionMemory/prompts.ts:164-247`
   - `src/services/SessionMemory/sessionMemory.ts:315`

3. **Plan/approval 边界**
   - `src/tools/EnterPlanModeTool/prompt.ts:23-98`
   - `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:224-278`
   - `src/utils/messages.ts:3286-3378`

4. **Swarm / teammate protocol 边界**
   - `src/utils/swarm/teammatePromptAddendum.ts:11-18`
   - `src/tools/SendMessageTool/prompt.ts:38-47`
   - `src/tools/SendMessageTool/SendMessageTool.ts:800-868`
   - `src/utils/tasks.ts:535-680`

5. **Compaction continuity 边界**
   - `src/services/compact/prompt.ts:19-44`
   - `src/services/compact/compact.ts:528-639`
   - `src/services/compact/sessionMemoryCompact.ts:459-474`

6. **Backend 语义映射边界**
   - `src/services/modelBackend/openaiResponsesBackend.ts:247-304`

## 9.2 给“迁移治理队长”

必须优先建立这些保真测试，否则迁移结论不可信：

1. compact E2E
2. memory fidelity
3. session memory / notes continuity fidelity
4. plan approval fidelity
5. multi-agent collaboration fidelity
6. instruction precedence fidelity
7. forced tool / strict schema fidelity

治理重点不是先问“上线怎么灰度”，而是先问：

- **这些高风险能力在 Codex 上是否仍然可信？**
- **如果不可信，是 prompt 可补，还是 runtime 必须补？**

---

## 10. 最终结论（按证据等级）

## 10.1 已证实

1. 当前系统中大量关键 agent 能力不是 API 耦合，而是**prompt/protocol 行为约束**。
2. 工具、权限、消息路由、task 存储、agent lifecycle 的底层机制大体模型无关。
3. memory、plan mode、multi-agent 协作、compaction 明显依赖模型是否稳定遵守操作协议。
4. 现有实现中已有多处注释直接表明：某些能力需要“教模型怎么用”，而非由 runtime 自动保证。
5. 至少 memory/recall 这类行为已被验证为**对 wording / section placement 高敏感**。

## 10.2 高概率推断

1. Codex 迁移后，最先退化的不会是“工具调用能不能工作”，而是**高阶行为纪律**。
2. 最危险的表现不是硬故障，而是**软退化**：效果变差但不易立刻察觉。
3. 如果只做 API 对接与基础 smoke test，迁移会被显著高估。
4. memory、plan、compact、multi-agent 必须被视为高风险保真能力，而不是普通 prompt 调优项。

## 10.3 待验证假设

1. Codex 是否在 repeated compact 后更快失去操作协议。
2. Codex 是否更容易把协作协议视为建议而不是硬要求。
3. Codex 是否在长上下文下更容易弱化 CLAUDE.md / hook / compact attachment 的优先级。
4. Codex 是否比 Claude 更少执行“先验证再推荐”的 memory recall 纪律。

---

## 11. 建议的迁移判断原则

在这个项目里，“Claude → Codex 迁移是否成功”不应只看：

- 能否响应
- 能否调用工具
- 能否跑通简单任务

而必须看：

- **高风险行为协议是否仍然可信**
- **长会话和多 agent 场景下是否仍能稳定执行**
- **是否还能维持 memory / plan / compact / collaboration 的系统性质量**

如果这些能力没有先做保真验证，那么任何“已完成 Codex 迁移”的结论都不可靠。

---

## 12. 附：本报告重点引用证据清单

- `src/services/modelBackend/openaiResponsesBackend.ts:247-304`
- `src/entrypoints/sdk/coreSchemas.ts:338-347`
- `src/remote/RemoteSessionManager.ts:189-269`
- `src/tools/AgentTool/prompt.ts:255-272`
- `src/tools/AgentTool/AgentTool.tsx:1338`
- `src/tools/AgentTool/AgentTool.tsx:1378`
- `src/tools/TaskCreateTool/prompt.ts:16-30`
- `src/tools/TaskUpdateTool/prompt.ts:5-49`
- `src/utils/tasks.ts:199-221`
- `src/utils/tasks.ts:535-680`
- `src/tools/EnterPlanModeTool/prompt.ts:23-98`
- `src/tools/EnterPlanModeTool/prompt.ts:108-163`
- `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:224-278`
- `src/tools/AskUserQuestionTool/prompt.ts:32-44`
- `src/services/SessionMemory/prompts.ts:53-80`
- `src/services/SessionMemory/prompts.ts:164-247`
- `src/services/SessionMemory/sessionMemory.ts:315`
- `src/memdir/memdir.ts:236-315`
- `src/memdir/teamMemPrompts.ts:60-99`
- `src/memdir/memoryTypes.ts:228-255`
- `src/QueryEngine.ts:310-319`
- `src/services/extractMemories/prompts.ts:4-9`
- `src/services/extractMemories/prompts.ts:35-42`
- `src/services/extractMemories/prompts.ts:70-81`
- `src/services/extractMemories/prompts.ts:127-140`
- `src/utils/swarm/teammatePromptAddendum.ts:11-18`
- `src/tools/TeamCreateTool/prompt.ts:37-110`
- `src/tools/SendMessageTool/prompt.ts:38-47`
- `src/tools/SendMessageTool/SendMessageTool.ts:800-868`
- `src/services/compact/prompt.ts:19-25`
- `src/services/compact/prompt.ts:31-44`
- `src/services/compact/compact.ts:528-639`
- `src/services/compact/sessionMemoryCompact.ts:459-474`
- `src/constants/prompts.ts:596-615`
- `src/context.ts:114-149`
- `src/context.ts:155-188`

---

## 13. 最终一句话结论

**这次迁移真正要保真的，不是“Codex 能不能像 Claude 一样调工具”，而是“Codex 能不能像 Claude 一样，稳定地遵守这套围绕工具、记忆、计划、协作与压缩而构建的行为协议”。**
