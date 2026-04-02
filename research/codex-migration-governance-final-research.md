# 从 Claude Code 专用迁移到 Codex 专用：治理版最终研究文档

> 归档说明：这份文档保留为治理研究输入，仅用于历史追溯与设计背景参考。
>
> 当前实施阶段、固定决策和 coding 顺序已收口到 `docs/implementation/hybrid-native-implementation-plan.md`，后续 coding 以该实现文档为准。

## 文档定位

这不是源码考古报告，也不是行为差异根因分析报告。

这份文档的目标只有一个：把“从 Claude Code 专用迁移到 Codex 专用”转化成一套**可执行、可验证、可回退**的治理方案，并定义“什么时候才算真的迁移完成”。

重点回答：

1. 迁移要先证明什么，后证明什么
2. 哪些能力若不先做基线，后面无法判断是否退化
3. 哪些差异属于 blocker，哪些可接受为 trade-off
4. 哪些阶段必须双栈，哪些阶段可以一刀切
5. 什么叫“真正完成 Codex 专用化”，而不是表面换皮
6. 默认切换之前，最小必须通过的验收门槛是什么
7. 默认切换失败后，退回到哪一层、以什么条件触发

---

## 一、执行摘要

### 结论

**这次迁移可控，但只能按“Codex 成为核心 agent/runtime 的默认 provider”来治理和验收，不能按“Claude 全产品面能力都已无损迁移”来定义成功。**

当前代码库已经具备：

- 统一的 model backend 抽象
- Codex/OpenAI Responses 默认后端选择
- OpenAI/Codex 的工具调用、结构化输出、stream 翻译、reasoning effort 等关键承接能力
- 显式的 Claude fallback 路径

但同时仍存在明显的 Claude 产品面残留：

- Remote Control / bridge 在 OpenAI backend 下被禁用
- Claude in Chrome 仍然强绑定 Claude 品牌、URL、native host 命名
- 启动路径仍有部分 Claude.ai MCP / quota 相关调用
- OpenAI 登录语义与 Anthropic/OAuth 登录语义不同，已不是同一能力路径

因此，这次迁移如果按“runtime provider 默认切换”来推进，风险可控；如果按“全产品面已完成 Codex 专用化”来推进，当前证据不足。

### 最大治理风险

**最大风险不是接不通，而是静默退化后无法证明能力没丢。**

尤其高风险于：

- forced tool routing
- tool_result roundtrip
- strict json_schema 输出
- stream reconstruction fidelity
- approval / permission 语义
- plan / task / team / subagent 协作质量
- cache / session stickiness

### 最该先建立的验证能力

**最先要建立的是“迁移前基线包”，不是继续扩写适配代码。**

该基线包至少包括：

1. 命名任务样本库
2. request/header/event golden snapshots
3. tool/structured-output/replay 专项验证
4. auth/help/model/default 行为快照
5. rollback lever 的验证

---

## 二、判定框架

本研究将所有结论分为三类：

- **已证实**：有明确代码或文档证据支持
- **高概率推断**：有强信号支持，但仍需运行态或更广范围验证
- **待验证假设**：当前无法仅靠已读代码/文档完全下结论

---

## 三、当前状态判断

### 3.1 已证实

#### 3.1.1 当前仓库已有明确的 backend/provider 抽象

证据：

- `src/services/modelBackend/types.ts:2-10` 定义 `ModelBackend` 统一接口
- `src/services/modelBackend/index.ts:18-33` 通过 `getModelBackend()` 在 `claude` 与 `openaiResponses` 间切换
- `src/query/deps.ts:34-40` 将 `modelBackend.streamTurn` 注入 query 主链路

含义：

- 本次迁移不需要重写 agent runtime
- 可以围绕 provider 边界建立治理、验证和回退方案
- 成功与否不应再用“是否能出结果”判断，而应回到“adapter 是否保真承接 runtime 契约”

#### 3.1.2 Codex/OpenAI Responses 实际上已是默认后端

证据：

- `src/services/modelBackend/openaiCodexConfig.ts:197-203`
- `src/services/modelBackend/index.ts:4-15`

`isOpenAIResponsesBackendEnabled()` 将默认 backend 视为 `openaiResponses`，除非显式指定 `claude`。

含义：

- 迁移不是未来时，而是现在进行时
- 当前治理重点不是“要不要切”，而是“如何定义切换完成、如何证明能力没丢、如何在失败时止损”

#### 3.1.3 OpenAI/Codex adapter 已承接关键 transport 语义

证据：

- request 构造与工具映射：`src/services/modelBackend/openaiResponsesBackend.ts:246-303`
- tool choice / parallel tool calls：`src/services/modelBackend/openaiResponsesBackend.ts:268-279`
- strict json schema 输出：`src/services/modelBackend/openaiResponsesBackend.ts:281-289`
- effort 映射：`src/services/modelBackend/openaiResponsesBackend.ts:299-303`
- tool_result replay：`src/services/modelBackend/openaiResponsesBackend.ts:77-100,102-161`
- SSE stream 解析：`src/services/modelBackend/openaiResponsesBackend.ts:429-499`
- stream event 重建：`src/services/modelBackend/openaiResponsesBackend.ts:327-407,520-617`
- 响应回收成内部 assistant/tool_use 语义：`src/services/modelBackend/openaiResponsesBackend.ts:189-243`
- OpenAI 请求头与凭证路径：`src/services/modelBackend/openaiApi.ts:56-127`

含义：

- 从“能力是否存在”的角度，Codex 路径已经承接核心 provider 职责
- 默认切换前不需要再证明“有没有实现”，而需要证明“稳定性与保真度够不够”

#### 3.1.4 CLI 默认认知层已明显向 Codex 倾斜

证据：

- `src/main.tsx:229-264`：bare mode、model、auth 文案按 OpenAI backend 切换
- `src/constants/prompts.ts:107-110,135-162`：docs URL、系统身份描述、平台说明、fast mode 说明按 backend 切换
- `src/cli/handlers/openaiAuth.ts:103-160`：OpenAI/Codex 的 auth login/status/logout 已是单独语义

含义：

- 用户层已经在感知“这是一条 Codex 路径”
- 这会放大任何静默退化，因为用户会把问题归因到“Codex 默认化失败”

#### 3.1.5 Claude 产品面残留仍然明显存在

##### A. bridge / remote / assistant 仍是 Claude 侧能力

证据：

- `src/bridge/bridgeEnabled.ts:28-39,53-60,76-95`
- `src/main.tsx:3976-3985,4470-4489`

OpenAI backend 下 Remote Control 不可用，相关 surface 也被隐藏/关闭。

##### B. Claude in Chrome 仍强绑定 Claude 产品面

证据：

- `src/commands/chrome/chrome.tsx:12-15,197-205,234-251`
- `src/commands/chrome/index.ts:5-10`
- `src/utils/claudeInChrome/setup.ts:33-39,103-118,217-230`
- `src/skills/bundled/claudeInChrome.ts:18-35`
- `src/hooks/useChromeExtensionNotification.tsx:20-37`

表现包括：

- 仍使用 Claude in Chrome 命名
- 仍跳转 `https://claude.ai/chrome` / `https://clau.de/...`
- native host identifier 仍为 `com.anthropic.claude_code_browser_extension`

##### C. 启动路径仍有 Claude 产品依赖

证据：

- `src/main.tsx:1901-1910`
- `src/main.tsx:2461-2467`

含义：

- “Codex 默认化”与“Claude 产品面彻底剥离”不是同一件事
- 如果把这两件事混为一个里程碑，验收口径会失真

#### 3.1.6 OpenAI 登录语义与 Anthropic 登录语义已明显分叉

证据：

- `src/commands/login/login.tsx:21-24,107-127`
- `src/commands/logout/logout.tsx:73-86`
- `src/cli/handlers/openaiAuth.ts:103-160`

OpenAI 路径的 login 更接近“凭证检查/提示”，而不是 Anthropic/OAuth 会话初始化链。

含义：

- 默认切换成功不等于“认证体系完全等价”
- 登录/退出语义必须被纳入 operator UX baseline

### 3.2 高概率推断

1. 当前仓库已处在**晚期双栈**而非迁移前期。
2. runtime/provider 迁移的主风险已经从“接线失败”转向“行为保真不足”。
3. 代码中分散的 `isOpenAIResponsesBackendEnabled()` 条件分支说明：
   - 默认值已经先行
   - 能力治理和边界收敛还没完全跟上

### 3.3 待验证假设

1. 是否已有足够完整的自动化测试来覆盖 Codex adapter 关键路径。
2. Claude in Chrome 是否属于这次默认切换必须保真的承诺范围。
3. `requires_openai_auth=true` 打开后附带的 repo metadata/header 行为是否需要额外治理审批。

---

## 四、迁移必须先证明什么，后证明什么

### 4.1 结论

迁移证明顺序应为：

1. **先证明边界成立**
2. **再证明关键能力未退化**
3. **最后才证明默认切换可接受**

### 4.2 已证实

当前已有足够证据说明“边界存在”，但尚不足以说明“所有关键能力都已保真”。

证据：

- 边界：`src/services/modelBackend/types.ts:2-10`，`src/services/modelBackend/index.ts:18-33`
- transport 承接：`src/services/modelBackend/openaiResponsesBackend.ts:246-303,519-645`
- 但共享流仍有 provider 分支：`src/services/api/claude.ts:547-576,763-784,832-841`

### 4.3 推荐证明顺序

#### 第一层：adapter / provider 边界证明
需要证明：

- backend 选择逻辑清晰且可控
- request / response / stream 翻译保真
- auth/header/session metadata 行为明确
- fallback 路径仍可操作

#### 第二层：能力保真证明
需要证明：

- tool choice 没丢
- tool_result replay 没丢
- structured output 没丢
- effort 语义没漂移
- approval / plan / team / subagent 没丢

#### 第三层：默认切换证明
需要证明：

- 核心任务样本通过
- 静默退化高风险区可被监控
- rollback lever 可用
- 未迁完的 Claude 产品面已被明确 carve-out，而非隐性忽略

---

## 五、如果不先做基线，后面无法判断有没有退化的能力

### 5.1 已证实必须冻结的基线项

#### 5.1.1 配置 / 默认值基线

冻结项：

- backend 默认值
- credentials source order
- response storage 默认值
- base URL normalization
- model 解析
- reasoning/context window 默认值

证据：

- `src/services/modelBackend/openaiCodexConfig.ts:115-193,197-204,255-260`
- `src/cli/handlers/openaiAuth.ts:86-100,103-160`

为什么必须冻结：

- 这些属于迁移正在改变的操作面
- 一旦默认切换后再回看，很难判断是 provider 行为变了，还是默认值漂了

#### 5.1.2 模型 / alias / effort 基线

冻结项：

- alias → resolved model
- model → default effort
- xhigh clamp 行为
- context window

证据：

- `src/utils/effort.ts:27-76,164-185`
- `src/components/ModelPicker.tsx:270-330`
- `src/utils/model/model.ts:473-479`

为什么必须冻结：

- effort/alias 退化通常不会表现为硬错误
- 更常见表现是“回答风格变了”“质量深度变了”

#### 5.1.3 工具调用 / 结构化输出基线

冻结项：

- tool_choice
- parallel_tool_calls
- strict json_schema
- tool_result replay
- stream reconstruction
- 最终 assistant message 重建

证据：

- `src/services/modelBackend/openaiResponsesBackend.ts:246-303,327-407,519-637`

为什么必须冻结：

- 这是 provider swap 最易发生静默退化的区域
- 表面“能回答”不等于“agent 能完成任务”

#### 5.1.4 身份 / 会话 metadata 基线

冻结项：

- official-client headers on/off
- `session_id`
- `x-client-request-id`
- `x-codex-turn-metadata`

证据：

- `src/services/modelBackend/openaiApi.ts:63-90`
- `src/services/modelBackend/openaiCodexIdentity.ts:37-49,78-126,156-173`

为什么必须冻结：

- 这些行为对用户不可见
- 但会影响 session continuity、cache、traceability 以及潜在治理约束

#### 5.1.5 协作质量基线

冻结项：

- task / team / subagent / plan / approval 基本协作语义
- ownership、message routing、mode transition、lineage

证据锚点：

- `codex-integration-implementation-plan.md:20-24,59-80,259-283,607-659`

为什么必须冻结：

- 这是本项目明确要求“迁移时必须保留”的核心能力面
- 一旦不冻结，只能靠感受判断是否退化

#### 5.1.6 Operator UX / 默认行为基线

冻结项：

- auth status / login / logout 语义
- help / model / bare mode 文案
- Chrome 启用/禁用/自动启用行为

证据：

- `src/main.tsx:229-264`
- `src/cli/handlers/openaiAuth.ts:103-160`
- `src/utils/claudeInChrome/setup.ts:38-75,79-95,102-188`

### 5.2 无法事后重建的基线

这些如果现在不冻结，默认切换后基本无法可靠回溯：

1. 关键样本当前成功率
2. malformed tool / schema 输出当前病理率
3. 当前默认行为与用户感知文案
4. 当前 wire-level header / metadata 行为
5. 当前协作路径中的 discipline 指标

---

## 六、验证体系

### 6.1 总体结论

最安全的验证体系必须是四层：

1. **adapter invariants in CI**
2. **scenario-based comparisons**
3. **human workflow acceptance**
4. **production observation signals**

这是一个 adapter-compatibility 问题，不只是 backend 切换问题。

---

### 6.2 第一层：Automated adapter checks（CI）

#### 已证实应纳入 CI 的验证内容

1. **request-shape golden**
   - plain turn
   - assistant tool_use + user tool_result continuation
   - forced tool choice
   - structured output
   - max_output_tokens override
   - prompt cache retention
   - store flag
   - reasoning effort mapping

2. **header golden**
   - official-client headers on/off
   - `session_id` / `x-client-request-id`
   - `x-codex-turn-metadata` presence & shape

3. **stream fixture replay**
   - feed captured SSE
   - assert message_start / content_block_* / tool_use / message_stop 顺序
   - assert final assistant message reconstruction

4. **capability gating matrix**
   - OpenAI backend 与 Claude backend 下 command / skill visibility 差异

#### 通过标准

- request/header/event snapshots 必须精确匹配
- 不能丢 forced tool_choice
- 不能丢 parallel_tool_calls
- 不能丢 prompt_cache_key
- 不能错误发送 effort
- 不能缺失 block_stop / message_stop
- command / skill visibility 必须与预期一致

#### 证据基础

- `src/services/modelBackend/openaiResponsesBackend.ts:246-303,327-407,519-637`
- `src/services/modelBackend/openaiApi.ts:63-90`

---

### 6.3 第二层：Scenario-based comparisons

#### 核心场景

1. **forced-tool scenario**
   - 成功必须通过 tool，而不是合理 prose

2. **tool-result roundtrip**
   - assistant 发 tool_use
   - 用户给 tool_result
   - 下一轮正确消费 `function_call_output`

3. **structured-output scenario**
   - strict json_schema 输出仍有效

4. **effort scenario**
   - low/high/xhigh 下 outgoing reasoning.effort 正确

5. **Chrome/browser scenario**
   - browser task / lightning loop 的简单工作流仍可完成

6. **availability scenario**
   - intentionally hidden / removed commands 与 accidental regressions 能区分

#### 通过标准

比对的是**行为结果**，而不是逐字输出：

- 用没用对工具
- schema 是否有效
- stop reason 是否合理
- content block 类型是否符合预期
- 任务是否真实完成

#### 高风险点

- 模型用自然语言绕过 tool
- 用户看起来“回答正常”，但 agent 能力实际上已经降级

---

### 6.4 第三层：Manual workflow acceptance

#### 必须人工评审的流程

1. 多步编码 + 工具调用
2. `/effort` 与 model switching
3. `/chrome` 与一次真实浏览任务
4. auth / status / login
5. intentionally removed Claude-only surfaces 是否被清晰告知

#### 通过标准

- 操作者无需脑补或补救动作即可完成工作流
- 没有“看起来能用，实际靠 reviewer 自己补齐”的情况

#### 为什么必须人工

这些风险大多是语义和体验问题，不是单纯结构问题。

---

### 6.5 第四层：Production observation signals

#### 可观测信号建议

1. forced-tool fulfillment rate
2. tool_use vs text-only ratio
3. empty-output / incomplete-response incidence
4. cache-read token rate shift
5. Chrome bridge task success rate
6. command-not-found / missing-skill complaint rate

#### 证据基础

- telemetry allowlist：`src/services/analytics/datadog.ts:18-52`
- sideQuery telemetry：`src/utils/sideQuery.ts:389`
- Chrome bridge events：`src/utils/claudeInChrome/mcpServer.ts:204`

#### 通过标准

- 与 pre-switch baseline 或 pilot baseline 保持在 agreed band 内
- 若持续掉出区间，则不能算默认切换成功

---

## 七、静默退化高风险区

### 7.1 已证实

#### 7.1.1 forced tool routing

风险：

- UI 看起来没报错
- 模型可能直接用 prose 回答
- capability 实际已丢

证据：

- `src/services/modelBackend/openaiResponsesBackend.ts:270-279`

#### 7.1.2 tool-result pairing

风险：

- 表面 chat 正常
- function_call_output wiring 实际断裂

证据：

- `src/services/modelBackend/openaiResponsesBackend.ts:77-100,102-161`

#### 7.1.3 stream reconstruction fidelity

风险：

- content block 顺序、index、block_stop/message_stop 错位
- 用户只会感知“偶发奇怪”而不是明确错误

证据：

- `src/services/modelBackend/openaiResponsesBackend.ts:354-407,520-617`

#### 7.1.4 effort / reasoning semantics

风险：

- 输出仍然能到达
- 但质量深度与期望不一致

证据：

- `src/utils/effort.ts:164-185`
- `src/services/modelBackend/openaiResponsesBackend.ts:299-303`

#### 7.1.5 cache / session stickiness

风险：

- 功能似乎正常
- 成本、延迟、复用命中率悄悄变坏

证据：

- `src/services/modelBackend/openaiResponsesBackend.ts:263-265`
- `src/services/modelBackend/openaiCodexIdentity.ts:161-173`

#### 7.1.6 Chrome/browser task quality

风险：

- 表面还暴露 `/chrome`
- 实际 browser inference loop 已换 provider，质量可能漂移

证据：

- `src/utils/claudeInChrome/mcpServer.ts:151`
- `src/skills/bundled/claudeInChrome.ts:18-35`

#### 7.1.7 intentional removals 被误判为 healthy migration

风险：

- missing features 可能被错当 regression
- regression 也可能被错当 intentional removal

证据：

- `src/skills/bundled/index.ts:61-74`
- `src/bridge/bridgeEnabled.ts:28-39,76-95`
- `src/commands.ts:418`

---

## 八、哪些差异是 blocker，哪些是可接受 trade-off

### 8.1 Blocker

以下差异应直接视为 blocker，而不是“已知问题”：

1. 核心 agent 链路不稳定
2. single-tool / multi-tool / tool replay 关键样本失败
3. strict structured output 样本失败
4. approval / plan / team / subagent 语义回归
5. 默认切换需要先删除 Claude path 才能成立
6. 回退 lever 不可用
7. 承诺范围包含 assistant / bridge / remote / teleport，但 OpenAI 默认下这些仍不可用

证据基础：

- `src/services/modelBackend/openaiResponsesBackend.ts:594-627`
- `codex-integration-implementation-plan.md:259-283,318-370,434-468,529-532`
- `assistant-native-recovery-plan.md:141-259`

### 8.2 可接受 trade-off

以下可以接受，但必须显式声明：

1. Claude-only 产品 surfaces 仍不可用或不在默认路径中
2. `/chrome` 被视为 Claude-coupled carve-out 或暂不纳入迁移完成口径
3. Claude.ai MCP / quota conveniences 暂时不纳入 Codex 默认路径
4. Claude fallback lever 在一段时间内继续保留

### 8.3 高概率推断

**最危险的不是 trade-off 本身，而是“没说清这是 trade-off”。**

换句话说：

- 明确 carve-out 是治理选择
- 隐性缺失是治理失败

---

## 九、哪些阶段必须双栈，哪些阶段可以一刀切

### 9.1 结论

- **Phase 0-4 必须保留双栈或至少保留 Claude rollback lever**
- **只有 Phase 5 才适合真正一刀切**

### 9.2 分阶段判断

#### Phase 0：基线盘点
- 必须双栈
- 因为基线本身就是对比两条路径

#### Phase 1：边界抽象
- 必须双栈
- 抽象一旦出错，需要立刻回到原路径验证偏差来源

#### Phase 2：双栈适配
- 顾名思义，必须双栈

#### Phase 3：能力对齐
- 核心能力必须双栈
- 低风险 copy/branding 面可先单切

#### Phase 4：默认切换
- 应保留短期 rollback valve
- 默认可以切，但不能立即删 Claude fallback

#### Phase 5：清理遗留
- 可以一刀切
- 但这应建立在“默认路径已稳定 + rollback 不再依赖代码内双栈”前提上

---

## 十、什么叫“真正完成 Codex 专用化”

### 10.1 结论

以下四点必须同时成立，才叫真正完成，而不是表面换皮：

1. **Codex 成为核心 runtime 的唯一默认 provider**
2. **关键 agent 契约能力经验证未丢**
3. **Claude 产品面不再反向控制核心 runtime 可用性**
4. **保留项与移除项被明确治理，而不是靠隐式行为存在**

### 10.2 反例

以下都不算完成：

- 只是默认 model/backend 切过去
- 只是 help/prompt/branding 改成 Codex
- 只是 Anthropic 登录不再主导默认路径
- 只是“多数简单任务能跑”

### 10.3 已证实当前还没满足的点

1. Claude 产品面仍有明显残留：
   - `src/bridge/bridgeEnabled.ts:28-95`
   - `src/commands/chrome/chrome.tsx:12-15,197-205,234-251`
   - `src/utils/claudeInChrome/setup.ts:33-39,217-230`

2. 共享流仍残留 provider 分支：
   - `src/services/api/claude.ts:547-576,763-784,832-841`

因此当前最多只能说：

**“Codex 已接近成为默认 runtime provider，但产品面剥离与能力处置尚未完成。”**

---

## 十一、默认切换前最小必须通过的验收门槛

### 11.1 硬门槛

以下证据必须全部成立：

1. **P0 critical baseline 全通过**
   - main session
   - single-tool
   - multi-tool
   - tool-result replay
   - plan mode
   - subagent
   - task/team
   - approval

   依据：`codex-integration-implementation-plan.md:259-283`

2. **OpenAI adapter 无用户可见流式失败**
   - `response.failed`
   - `response.incomplete`
   - no completed payload
   - no assistant output

   证据：`src/services/modelBackend/openaiResponsesBackend.ts:594-627`

3. **forced tool / structured output / effort / cache-session 专项验证通过**

4. **backend rollback lever 明确且可用**
   - `src/services/modelBackend/openaiCodexConfig.ts:198-203`

5. **不需要删除 Claude path 才能让默认切换成立**
   - 否则违反 disable-before-delete 原则
   - 依据：`codex-integration-implementation-plan.md:434-468,529-532`

### 11.2 软门槛

这些不是“功能 correctness”层面的 blocker，但应尽量成立：

1. auth/help/model/bare mode 文案统一且可理解
2. Claude-only 产品 surfaces 已被清晰标注为 carve-out
3. production observation dashboard 已就绪
4. rollout 沟通中明确写出“本次默认切换的承诺范围”

---

## 十二、如果默认切换失败，退回到哪一层、以什么条件触发

### 12.1 结论

**默认切换失败时，应退回到 Phase 2/3 的双栈状态，而不是做临时补丁。**

### 12.2 已证实存在的回退落点

- `src/services/modelBackend/openaiCodexConfig.ts:198-203`
- `src/services/modelBackend/index.ts:18-33`

当前 backend 选择已经具备显式退回 Claude 的 lever。

### 12.3 回退触发条件

以下任一成立，应触发回退：

1. P0 critical baseline 关键样本失败
2. OpenAI adapter 出现用户可见流式失败
3. plan / team / subagent / approval 出现语义性回归
4. structured output 或 tool replay 出现 blocker 级下降
5. rollout 误覆盖到 assistant / bridge / remote / teleport 等未完成能力面
6. metadata/header 治理风险未获批准却进入默认路径

### 12.4 不应使用的伪回退方式

以下不应视为有效回退：

- 临时加更多 if 分支掩盖行为差异
- 删除 Claude path 再通过补丁修 OpenAI path
- 把未保真能力默默下线但继续宣称“已切完”

---

## 十三、分阶段路线图

## Phase 0：基线盘点

### 进入条件
无，立即开始。

### 主要目标
冻结“迁移前基线包”。

### 主要产出

1. 命名任务样本库
2. request/header/event golden
3. auth/help/model/default snapshots
4. blocker / trade-off 判定表
5. rollback lever 验证结果

### 完成标准

- 所有关键能力都有 baseline
- 所有高风险静默退化区有对应观测项
- 两条 backend 可被同一框架比较

### 主要风险

- 迁移先于测量
- 成功标准靠感觉而不是证据

### 回退条件

- 不进入下一阶段，直到 baseline 可用

### 双栈要求
必须双栈。

---

## Phase 1：边界抽象

### 进入条件
Phase 0 基线已冻结。

### 主要目标
把 provider 差异收敛到清晰边界，减少共享流中散落的 backend 判断。

### 已证实当前重点问题

- `src/services/api/claude.ts:547-576,763-784,832-841` 仍持有 provider-specific 分支

### 完成标准

- backend 选择边界清晰
- execution/auth/capability checks 都有窄接口
- 不再新增共享层直接 backend 分支

### 主要风险

- 伪抽象
- provider-specific assumption 继续泄漏

### 回退条件

- 边界抽象导致行为漂移
- 与 Phase 0 baseline 对不上

### 双栈要求
必须双栈。

---

## Phase 2：双栈适配

### 进入条件
边界已清晰。

### 主要目标
让所有用户可见面在双栈下进入“可比较、可验证、可回退”状态。

### 完成标准

- Claude/Codex 对照矩阵可运行
- auth/model/prompt/help/visibility 可比较
- 关键能力 failure 可归因到明确层级

### 主要风险

- 文案已切 Codex，能力仍混杂
- intentionally hidden 与 accidental regression 混淆

### 回退条件

- 双栈结果不可比较
- 回退过程本身不可操作

### 双栈要求
必须双栈。

---

## Phase 3：能力对齐

### 进入条件
双栈样本稳定。

### 主要目标
对每个能力作出明确 disposition：

- parity
- replacement
- intentional drop

### 优先能力

1. tool routing
2. tool replay
3. structured output
4. approval / plan / team / subagent
5. auth/status UX
6. Chrome/browser 是否 carve-out
7. assistant/bridge/remote 是否继续维持独立 track

### 完成标准

- blocker 清零或豁免
- 每个关键能力有明确 disposition
- 没有“假装支持”的残留表面

### 主要风险

- 把换文案误当迁完
- 把未完成 carve-out 误当回归

### 回退条件

- must-have 能力无 disposition
- 关键语义性能力无法保真

### 双栈要求
核心能力必须双栈；低风险 copy 面可先单切。

---

## Phase 4：默认切换

### 进入条件
默认切换门槛全部通过。

### 主要目标
让 Codex 成为默认 provider，同时保留短期 rollback valve。

### 完成标准

- Codex 成为唯一默认体验
- Claude 只保留为显式 fallback
- 生产观察信号稳定
- carve-out 范围被明确写清

### 主要风险

- 长尾静默退化
- 用户以为“全产品面已迁完”

### 回退条件

- 任一 blocker 级 regression
- support signal 或 telemetry 持续异常

### 双栈要求
建议保留短期 rollback valve。

---

## Phase 5：清理遗留

### 进入条件
默认路径稳定，Claude fallback 长期未用且不再是治理必需。

### 主要目标
删除 dead branches、误导性 affordances、过时 carve-out。

### 完成标准

- 代码内不再依赖双栈作为主要 rollback 机制
- Claude-specific dead code 与 misleading UX 被清理
- 剩余例外项被显式定义为独立能力，而非历史残留

### 主要风险

- 过早失去 rollback landing

### 回退条件

- 只允许 release-level rollback，不再靠代码内即时开关

### 双栈要求
不需要。

---

## 十四、给另外两个队长的移交事项

## 14.1 给“源码边界队长”

你必须确保以下边界都具备：

- **可观测**：能看出当前请求、能力、开关落在哪一层
- **可切换**：能显式切换 provider / fallback
- **可回退**：出问题时能回到上一个稳定层，而不是只能热修

### 必查边界

1. backend 选择边界
   - `src/services/modelBackend/index.ts:18-33`

2. provider request/response 翻译边界
   - `src/services/modelBackend/openaiResponsesBackend.ts:246-303,519-645`

3. auth/status/login/logout 边界
   - `src/cli/handlers/openaiAuth.ts:103-160`
   - `src/commands/login/login.tsx:21-24,107-127`

4. runtime 与 Claude 产品面边界
   - `src/bridge/bridgeEnabled.ts:28-95`
   - `src/commands/chrome/chrome.tsx:12-15`
   - `src/utils/claudeInChrome/setup.ts:33-39,217-230`

5. rollback lever 边界
   - `src/services/modelBackend/openaiCodexConfig.ts:198-203`

### 交付要求

不要只回答“耦合在哪里”；要回答：

- 这个边界是否可观测
- 是否有单点切换开关
- 回退时退回哪一层
- 哪些边界不能在默认切换前删除

---

## 14.2 给“能力保真队长”

你必须优先把以下能力定义成**可量化、可判定、可对照**的 fidelity metrics：

1. forced tool routing
2. tool_result roundtrip
3. strict json_schema output
4. stream reconstruction fidelity
5. effort：显示值 vs 实际发送值
6. approval / plan / team / subagent 语义
7. Chrome/browser workflow 是否属于承诺范围

### 交付要求

不要停留在“感觉差不多”。必须给出：

- 成功判据
- 自动化可判部分
- 必须人工评审部分
- 哪些失败属于 blocker
- 哪些差异可视为 trade-off

---

## 十五、最终回答七个核心问题

### 1. 迁移要先证明什么，后证明什么？

先证明：

- provider 边界存在且可控
- adapter 保真承接 request/response/tool/stream 语义

再证明：

- 关键能力样本未退化
- 高风险静默退化区被覆盖

最后证明：

- 默认切换可接受
- rollback 可操作
- carve-out 范围清晰

### 2. 哪些能力如果不先做基线，后面就无法判断有没有退化？

- tool calling
- tool replay
- structured output
- effort 语义
- approval / plan / team / subagent
- auth/help/model/default behavior
- wire-level session/header metadata

### 3. 哪些差异应该被视为 blocker，哪些可以接受为 trade-off？

**Blocker：**

- 核心任务链路失败
- tool/structured output/replay 退化
- 行为纪律语义漂移
- rollback 不可用
- 承诺范围与实际能力不一致

**Trade-off：**

- 已明确 carve-out 的 Claude-only 产品面能力
- 暂不纳入默认切换成功定义的 Chrome / assistant / bridge 类能力

### 4. 哪些阶段必须双栈，哪些阶段可以一刀切？

- Phase 0-4：必须保留双栈或至少保留 Claude fallback lever
- Phase 5：可以一刀切

### 5. 什么叫“真正完成 Codex 专用化”，而不是表面换皮？

- Codex 是核心 runtime 唯一默认 provider
- 关键 agent 契约能力经验证未丢
- Claude 产品面不再反向控制 runtime
- 保留项与移除项都有明确治理，不靠隐式残留

### 6. 默认切换之前，最小必须通过的验收门槛是什么？

- P0 critical baseline 全通过
- adapter invariants 全通过
- silent-regression 专项通过
- rollback lever 可用
- 不需要删除 Claude path 才能切默认

### 7. 如果默认切换失败，应该退回到哪一层、以什么条件触发回退？

- **退回到 Phase 2/3 的双栈状态**
- 触发条件：任一 blocker 级 regression 或治理风险越线

---

## 十六、最终建议

### 单一最佳建议

**把这次迁移的成功定义写死为：Codex 默认化的是核心 runtime，不是 Claude 全产品面无损平移。**

这样才可能做到三件事同时成立：

1. 可执行
2. 可验证
3. 可回退

### 具体执行建议

下一步最值得做的不是继续改代码，而是把本报告收敛成一份**执行版门槛清单**：

- Phase 0-4 checklist
- 每条 checklist 的证据要求
- blocker / trade-off 判定栏
- rollback trigger 栏

在没有这份 checklist 之前，任何“默认切换已完成”的结论都不稳。

---

## 十七、v2 补充：能力处置矩阵

本节用于把“什么必须完成、什么可以 carve-out、什么必须双栈、什么可以延后”从叙述性结论收敛成可执行矩阵。

### 17.1 已证实

| 能力面 | 当前状态 | 目标状态 | 默认切换前必须完成 | 是否 blocker | 是否必须双栈 | 若未完成如何表述 |
|---|---|---|---|---|---|---|
| Core runtime provider | OpenAI/Codex 已是默认 backend，`src/services/modelBackend/openaiCodexConfig.ts:197-203` | Codex 成为唯一默认 provider | 是 | 是 | 是，直到 Phase 4 稳定 | 不可宣称切换完成 |
| Query / stream / tool adapter | OpenAI adapter 已存在，`src/services/modelBackend/openaiResponsesBackend.ts:246-303,519-645` | adapter 保真且稳定 | 是 | 是 | 是 | 不可宣称能力保真 |
| Auth status/login/logout | OpenAI 路径已分叉，`src/cli/handlers/openaiAuth.ts:103-160` | 用户能理解 Codex 路径认证语义 | 是 | 中 | 是，到 operator UX 基线稳定 | 明确“认证语义已切换，不等价于 Anthropic OAuth” |
| Model / effort | 已支持 Codex 模型与 effort，`src/utils/effort.ts:164-185` | alias/default/effort 稳定 | 是 | 是 | 是 | 不可宣称默认体验稳定 |
| Structured output | 已支持 strict json_schema，`src/services/modelBackend/openaiResponsesBackend.ts:281-289` | schema 成功率达门槛 | 是 | 是 | 是 | 仅能宣称实验性 |
| Tool calling / replay | 已支持 tool_choice / replay，`src/services/modelBackend/openaiResponsesBackend.ts:268-279,77-161` | forced tool 与 roundtrip 稳定 | 是 | 是 | 是 | 不可宣称 agent 能力保真 |
| Plan / task / team / subagent | 规划文档要求保留，`codex-integration-implementation-plan.md:20-24,259-283` | 协作语义通过专项验收 | 是 | 是 | 是 | 不可宣称核心 agent 迁移完成 |
| Assistant / bridge / remote / teleport | OpenAI backend 下隐藏/禁用，`src/bridge/bridgeEnabled.ts:28-95`, `src/main.tsx:3976-3985,4470-4489` | 维持独立 track，非本次默认切换完成项 | 否 | 仅当被纳入承诺范围时是 blocker | 是，但作为 Claude-stack carve-out | 明确“不在本次默认切换成功定义内” |
| Chrome/browser automation | 仍为 Claude-coupled 表面，`src/commands/chrome/chrome.tsx:12-15`, `src/utils/claudeInChrome/setup.ts:33-39` | 要么 carve-out，要么替代/下线 | 否，但必须明确处置 | 若被承诺则是 blocker | 建议保留 carve-out | 明确“仍为 Claude-coupled beta”或“暂不纳入” |
| Claude.ai MCP / quota startup side effects | 仍在默认启动路径调用，`src/main.tsx:1901-1910,2461-2467` | 隔离、条件化或明确接受 | 否 | 中 | 不一定 | 明确“非核心 runtime 成功标准” |
| Metadata / official-client headers | 条件启用，`src/services/modelBackend/openaiApi.ts:63-90` | 经治理审批后再启用 | 否，但必须审查 | 合规视角可为 blocker | 不需要双栈，但需要 gate | 标注“依赖治理审批待确认” |

### 17.2 高概率推断

1. 上表中最容易被误判的能力面是 Chrome 和 assistant/bridge/remote。
2. 这些能力面不是不能存在，而是不能被模糊地混入“Codex 默认切换已完成”的口径。

### 17.3 待验证假设

1. Chrome 是否保留为长期 carve-out，还是应在默认切换前下线。
2. startup 中 Claude.ai MCP/quota 路径是否需要在默认切换前清理到可忽略水平。

---

## 十八、v2 补充：最小任务样本库（Minimum Corpus）

本节定义默认切换前最小必须冻结的命名样本库。没有这份最小集，就无法形成统一的 baseline 和 gate review。

### 18.1 已证实

以下样本库与规划文档要求直接对齐：`codex-integration-implementation-plan.md:259-283,607-659`

| 样本 ID | 场景 | 目标能力 | 自动化/人工 | 通过标准 | 失败级别 |
|---|---|---|---|---|---|
| C01 | 单轮纯文本回答 | 基础 provider 连通性 | 自动化 | 正常返回 assistant 消息，无 stream 异常 | 低 |
| C02 | 强制单工具调用 | forced tool routing | 自动化 | 必须调用指定工具，不接受 prose 替代 | 高 |
| C03 | 多工具串联 | tool orchestration | 自动化 | 顺序正确、结果推进成功 | 高 |
| C04 | 并行工具调用 | parallel_tool_calls | 自动化 | 并行调用行为符合预期 | 高 |
| C05 | tool_result 回灌 | function_call_output replay | 自动化 | assistant tool_use → user tool_result → 下一轮继续推进 | 高 |
| C06 | strict json_schema | structured output fidelity | 自动化 | schema 100% 可验证 | 高 |
| C07 | approval-required bash/edit | approval/permission 语义 | 人工+半自动 | 权限请求节奏正确、无绕过 | 高 |
| C08 | plan mode 工作流 | plan discipline | 人工 | 进入、审批、退出语义一致 | 高 |
| C09 | task/team/subagent 工作流 | 协作语义 | 人工 | owner、message routing、task 生命周期正确 | 高 |
| C10 | auth/status/login/logout | operator UX | 自动化+人工 | 提示、状态、退出语义可理解且一致 | 中 |
| C11 | model/effort 切换 | effort/model semantics | 自动化+人工 | 显示与实际发送一致 | 高 |
| C12 | incomplete/failed response | 错误恢复/止损 | 自动化 | 异常类型可见且按预期升级 | 高 |
| C13 | Chrome/browser 基础任务 | browser workflow disposition | 人工 | 若在承诺范围内则必须完成；否则必须明确 carve-out | 中/高 |
| C14 | startup with OpenAI default | 默认路径副作用 | 自动化+人工 | 不出现不可接受的 Claude 产品噪音 | 中 |

### 18.2 高概率推断

1. 这 14 个样本足以作为最小 gate 集，不需要一开始做 exhaustive corpus。
2. Phase 0 的重点不是多，而是稳定、命名、可重复。

### 18.3 待验证假设

1. 是否需要单独再加一个“长上下文 + compact”样本。
2. 是否需要单独再加一个“非交互 headless/json 模式”样本。

---

## 十九、v2 补充：定量门槛与判定口径

本节补足默认切换前需要统一的定量化 gate 口径。这里先定义指标和判定方法，不强行编造阈值数字；具体数字应由实施阶段结合 baseline 数据填写。

### 19.1 已证实

| 指标 | 定义 | 采样范围 | 判定方式 | 触发级别 |
|---|---|---|---|---|
| Corpus pass rate | 最小样本库一次执行通过比例 | C01-C14 | 按样本通过/失败统计 | Phase gate |
| First-pass success rate | 无人工干预首次通过比例 | C02-C14 | 首次执行成功数 / 总数 | Default-switch gate |
| Tool fulfillment rate | 需要工具的样本中，正确产生工具调用的比例 | C02-C05, C07, C09, C13 | 必须发生正确工具调用 | Blocker gate |
| Tool replay success rate | tool_result 回灌后继续推进成功比例 | C05 | 完整 roundtrip 成功 | Blocker gate |
| Structured output validity | strict schema 样本通过率 | C06 | JSON schema 校验通过 | Blocker gate |
| Effort correctness rate | 展示 effort 与实际发出的 reasoning.effort 一致比例 | C11 | UI/状态与 request 交叉验证 | High-risk gate |
| Approval fidelity rate | approval-required 样本中，权限行为正确比例 | C07 | 人工 rubric 打分为 pass/fail | Blocker gate |
| Collaboration fidelity rate | plan/team/subagent 样本通过比例 | C08-C09 | 人工 rubric + transcript review | Blocker gate |
| Stream integrity rate | stream fixture replay 通过率 | adapter fixtures | 事件顺序和 block stop 完整 | CI gate |
| Startup noise rate | OpenAI default 下出现 Claude 产品噪音的会话比例 | C14 + pilot cohort | 日志/人工 observation | Rollout gate |
| Operational anomaly rate | incomplete/failed/no assistant output 的会话比例 | pilot/full rollout | telemetry + sampled transcripts | Stop-loss gate |

### 19.2 高概率推断

1. 默认切换 gate 最终会由三类阈值共同决定：
   - correctness 阈值
   - behavior/fidelity 阈值
   - operational anomaly 阈值
2. 最不该只看单一通过率；应至少同时看：
   - corpus pass rate
   - tool fulfillment rate
   - structured output validity
   - collaboration fidelity rate

### 19.3 待验证假设

1. 各指标的阈值数字应由 Phase 0 baseline 实测后再填写。
2. 是否需要按 interactive / non-interactive 分开统计。

---

## 二十、v2 补充：灰度 rollout 策略

文档前文定义了阶段，但这里补充“最低风险迁移”所必须的 rollout population 设计。

### 20.1 已证实

当前代码库已经有足够清晰的 backend lever，因此 rollout 可以围绕“谁默认落到 Codex”来设计，而不必一次性全量切换：

- `src/services/modelBackend/openaiCodexConfig.ts:197-203`
- `src/services/modelBackend/index.ts:18-33`

### 20.2 推荐 rollout 分群

| Rollout 阶段 | 目标人群/流量 | 条件 | 退出条件 | 扩大条件 |
|---|---|---|---|---|
| R0 | 研发本地/验证环境 | baseline 与 golden 已可运行 | 关键样本失败 | adapter invariants 与最小 corpus 稳定 |
| R1 | 内部 dogfood / 指定操作者 | R0 稳定 | 任一 blocker 回归 | tool/schema/approval/协作样本稳定 |
| R2 | 新会话或受控 cohort 默认 Codex | R1 稳定且回退机制演练通过 | operational anomaly 超出阈值 | pilot cohort 指标稳定 |
| R3 | 扩大到大多数默认流量 | R2 稳定，carve-out 口径明确 | support signal / telemetry 异常 | 连续观察期通过 |
| R4 | 全量默认 | R3 稳定，fallback 仅保留短期阀门 | Blocker 级 regression | 观察期结束，进入 Phase 5 |

### 20.3 高概率推断

1. 最安全的 rollout 单位不是“所有用户”，而是“新会话 + 指定 cohort”。
2. 最该先排除出首批默认的人群/场景：
   - 强依赖 assistant/bridge/remote 的用户
   - 强依赖 `/chrome` 的用户
   - 对 structured output/tool fidelity 极度敏感的自动化场景（除非已通过专项 gate）

### 20.4 待验证假设

1. 当前是否存在方便做 cohort split 的 rollout 机制。
2. pilot cohort 是否能单独采集足够稳定的 operational data。

---

## 二十一、v2 补充：故障类型分层回退矩阵

前文定义了总回退原则，这里把它细化到可执行层。

### 21.1 已证实

回退总 lever 已存在：

- `src/services/modelBackend/openaiCodexConfig.ts:198-203`
- `src/services/modelBackend/index.ts:18-33`

### 21.2 回退矩阵

| 故障类型 | 示例信号 | 影响范围 | 立即动作 | 回退落点 | 是否全量回退 |
|---|---|---|---|---|---|
| Adapter/stream 故障 | `response.failed` / `response.incomplete` / no completed payload | 核心 runtime | 停止扩大 rollout | 回退到 Claude default lever | 通常是 |
| Tool replay/structured-output 故障 | tool_result 不推进 / schema invalid | 核心 agent 契约 | 冻结默认切换，回到双栈比对 | 回退到 Phase 2/3 | 通常是 |
| Approval/plan/team 语义故障 | 权限异常、plan discipline 漂移、协作断裂 | 高风险语义 | 视为 blocker，停止 rollout | 回退到 Phase 2/3 | 是 |
| Operator UX 故障 | auth/help/model 文案混乱 | 用户认知 | 暂停扩大 rollout，先修文案/交互 | 不一定切回 Claude | 不一定 |
| Chrome/browser carve-out 故障 | `/chrome` 行为异常 | carve-out surface | 若不在承诺范围，则隐藏/声明；若在承诺范围则视为 blocker | carve-out 或回退整体验收口径 | 取决于承诺范围 |
| Assistant/bridge/remote 故障 | 用户要求的 Claude-only surface 不可用 | 非本次默认切换核心，除非承诺覆盖 | 若被误纳入承诺，停止 rollout 沟通；否则保持 carve-out | 维持独立 Claude-stack | 通常不是整体验收回退 |
| Startup Claude side-effect 噪音 | quota/MCP 启动警告 | 默认体验 | 暂停扩大 rollout，先隔离 side effect | 不一定切回 Claude | 不一定 |
| Metadata governance 风险 | `x-codex-turn-metadata` 触发审查 | 合规/治理 | 立即关掉官方 header 路径或停止相关 rollout | 保持 Codex 默认但禁该路径，或回退 cohort | 不一定 |

### 21.3 高概率推断

1. 不是所有故障都需要立刻全量回退到 Claude；但所有 **核心 agent 契约故障** 都应该阻断默认切换。
2. 最需要避免的是把“carve-out 问题”错误升级成“全局 provider 失败”，或反过来把核心契约故障降级成 carve-out。

### 21.4 待验证假设

1. 当前 telemetry 是否足够支持按故障类型快速分流。
2. rollout 操作面是否允许“停止扩大但不立刻全量回退”。

---

## 二十二、v2 补充：依赖上游事实待确认清单

本节专门列出不能被误当成“默认已接受”的事项。

### 22.1 待确认事项

1. **Chrome/browser automation 是否属于本次默认切换的承诺范围**
   - 若是：它从 carve-out 升级为 blocker
   - 若否：必须在验收与对外口径中明确排除

2. **assistant / bridge / remote / teleport 是否明确不纳入本次成功定义**
   - 当前代码证据显示它们在 OpenAI backend 下被隐藏/禁用：
     - `src/bridge/bridgeEnabled.ts:28-95`
     - `src/main.tsx:3976-3985,4470-4489`

3. **`requires_openai_auth` 下的 official-client headers 与 `x-codex-turn-metadata` 是否已通过治理审批**
   - 相关证据：
     - `src/services/modelBackend/openaiApi.ts:63-90`
     - `src/services/modelBackend/openaiCodexIdentity.ts:132-174`

4. **OpenAI default 下 startup 中 Claude.ai MCP/quota 路径是否可接受**
   - 相关证据：`src/main.tsx:1901-1910,2461-2467`

5. **是否已有足够稳定的自动化 harness 支撑 Phase 0-2 gate review**

### 22.2 使用方式

以上事项在未确认前：

- 不能视为“默认可接受”
- 不能被写入“已完成”结论
- 只能作为“待确认前提”挂在阶段门槛或 rollout 条件里

---

## 二十三、v2 补充：审计友好的三栏视图

为了让 gate review 更直接，本节给出最终的审计化收口格式。

### 23.1 已证实

1. Codex/OpenAI 已是默认 backend。
2. backend fallback lever 存在。
3. OpenAI adapter 已承接核心 transport/tool/schema/stream 能力。
4. Claude 产品面残留仍明显存在。
5. assistant/bridge/remote 与 Chrome 不能自然地算作已迁移完成。

### 23.2 高概率推断

1. 当前最合适的成功定义是“核心 runtime 默认切换成功”。
2. 最低风险的 rollout 应采用 cohort 灰度，而不是一次性全量。
3. 只要核心 agent 契约未被量化，默认切换就仍不可宣布完成。

### 23.3 待验证假设

1. Chrome 是否在承诺范围内。
2. official-client metadata/header 是否通过治理审批。
3. startup 中 Claude side effects 是否足够轻微，可不阻塞默认切换。
4. 自动化 harness 是否足够支撑快速回退判断。

---

## 附录 B：建议的下一份执行文档

如果要把本研究直接转成执行材料，下一份文档建议命名为：

`codex-migration-default-switch-checklist.md`

建议结构：

1. Phase 0-4 checklist
2. Minimum corpus 执行表
3. 指标阈值填写表
4. 能力处置矩阵
5. 回退矩阵
6. 待确认事项签字栏
