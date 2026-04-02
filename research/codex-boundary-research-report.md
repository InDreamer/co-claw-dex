# Claude Code 专属耦合与 Codex 专用最小替换边界研究

> 归档说明：这份文档保留为边界研究输入，仅用于历史追溯与设计背景参考。
>
> 当前实现与阶段决策已收口到 `docs/implementation/hybrid-native-implementation-plan.md`，后续 coding 以该实现文档为准。

## 文档目的

本研究只回答一个问题：

> 当前仓库里，哪些是 Claude Code 专属耦合，哪些已经接近模型无关，哪些地方最适合建立抽象层或适配层，从而以最小边界改造成 Codex 专用。

本研究**不**评估模型能力是否退化，也**不**提供完整迁移路线图、验证体系或回退策略。

---

## 研究范围与方法

### 研究范围
- 源码
- 配置
- 提示词
- 脚本
- 运行链路
- 已有兼容层与草案

### 不在范围内
- Codex 替换后的效果质量评估
- 完整迁移阶段设计
- 回退/治理方案细化
- 行为学层面的能力保真矩阵

### 研究方式
本研究通过并行检索以下 4 个方向完成：
1. 仓库结构、运行入口、主链路
2. Claude / Anthropic / Claude Code 专属耦合
3. model/tool/stream/protocol/permission surface
4. 仓库内已存在的 Codex / OpenAI Responses / 兼容资产

---

# 一、执行摘要

## 1.1 最终结论

**当前仓库已经存在清晰的 provider 替换边界，但内部 canonical runtime contract 仍然是 Claude-native。**

也就是说：
- **模型后端已经可以替换**，并且 OpenAI Responses / Codex 兼容链已经部分跑通。
- **但内部消息结构、stream 事件、tool calling 语义、部分 prompt/request 组装仍以 Claude 形状为中心。**
- 因此，这个仓库现在更接近：
  - 外层仍是 **Claude Code 形状的产品外壳**
  - 内层已经接入了 **Codex/OpenAI Responses provider adapter**

## 1.2 一句话判断

**最小必要替换边界在 `query/deps -> modelBackend -> provider adapter`，而不是 CLI 外壳，也不是 Claude.ai 托管产品能力层。**

## 1.3 最重要的项目判断

### 已证实
1. 主运行链路默认已能走 OpenAI Responses backend，而非只能走 Anthropic。
2. `query()` 到 `callModel` 之前的大部分 agent loop 基本接近模型无关。
3. backend registry / selector 已存在，且已经把 `openai/responses/codex` 归并进统一选择路径。
4. 真正的深层耦合仍在：
   - 内部 message/tool/stream canonical shape
   - `services/api/claude.ts` 的共享入口 + Claude-specific builder 混合职责
   - `CLAUDE.md` / onboarding / branding / Claude-only product flows
   - Claude.ai hosted capability（remote/org MCP/Chrome/RemoteTrigger）

### 高概率推断
1. 若要做 Codex 专用，最小投入应优先中立化 **turn/message/stream contract**，而不是先去掉所有 Claude 命名。
2. 若要双栈过渡，最合理切口是 **协议层和 provider boundary**，不是先切 UI、help text 或 hosted product 功能。
3. 当前仓库里最具复用价值的资产，不是品牌改动，而是现有 `openai*` 适配链。

### 待验证假设
1. voice、remote、Chrome、org-managed MCP 等非主链路是否都已通过同一中间 contract，还需逐条验证。
2. 仓库中未发现常规 `test/spec` 文件来固定这条 boundary；但存在最小 smoke 验证入口：`package.json:22-30` 中的 `smoke` 脚本可作为当前仅有的显式运行校验线索之一。

---

# 二、主运行链路与替换边界

## 2.1 主入口

### 已证实
- CLI 二进制仍是 `claude`：`package.json:4-5`
- Node 入口只是加载构建后的 CLI：`cli.js:1-3`
- 主 CLI/bootstrap 在：`src/main.tsx:1076-1118`
- 交互 happy path 最终进入 REPL：`src/main.tsx:3911-3919`, `src/replLauncher.tsx:12-21`

## 2.2 单条主请求路径

### 已证实
1. CLI 解析参数并启动主应用：`src/main.tsx:1076-1118`
2. setup / trust / resume 后进入 `launchRepl(...)`：`src/main.tsx:3911-3919`
3. REPL 提交用户 turn：`src/screens/REPL.tsx:2794-2803`
4. `query()` 是核心 agent loop 入口：`src/query.ts:219-239`
5. `query()` 获取 `deps = params.deps ?? productionDeps()`：`src/query.ts:263-295`
6. 实际模型调用通过 `deps.callModel(...)`：`src/query.ts:659-707`
7. `productionDeps()` 将 `callModel` 绑定到 `getModelBackend().streamTurn`：`src/query/deps.ts:34-41`
8. backend 选择集中在：`src/services/modelBackend/index.ts:19-33`
9. 默认 backend 为 OpenAI Responses，除非显式指定 `claude`：`src/services/modelBackend/openaiCodexConfig.ts:198-204`
10. OpenAI backend 的 `streamTurn` 通过 `runOpenAIResponses(...)` 实现：`src/services/modelBackend/openaiResponsesBackend.ts:641-645`
11. HTTP 请求最终经 `fetchOpenAIResponse(...)` 走 `/responses`：`src/services/modelBackend/openaiApi.ts:96-128`

## 2.3 当前最干净的 provider boundary

### 已证实
最干净的结构边界在：
- `src/query/deps.ts:22-41`
- `src/services/modelBackend/index.ts:19-33`
- `src/services/modelBackend/types.ts:3-12`

原因：
- `query()` 只知道 `callModel: ModelBackend['streamTurn']`
- `getModelBackend()` 在边界后决定使用哪种 provider
- 上层 REPL / query / tool orchestration 到这里之前基本不关心 provider 细节

### 高概率推断
这是当前最适合建立“最小替换边界”的天然切口。

## 2.4 一个关键 caveat

### 已证实
虽然 `ModelBackend` 结构上已经是边界，但 live call 语义仍经过 Claude 命名兼容层：
- `src/services/api/claude.ts:814-853`

也就是说：
- provider boundary 在结构上是干净的
- 但共享请求/流语义仍通过 `services/api/claude.ts` 承载

---

# 三、Claude Code 专属耦合地图

以下按模块分层列出：职责、耦合类型、强度、影响范围、证据、判断。

## 3.1 品牌 / 命名 / 产品外壳

### 模块
- `package.json`
- `src/main.tsx`
- `src/commands.ts`

### 职责
包身份、CLI 命令、帮助文案、用户入口

### Claude 耦合类型
品牌与产品语义耦合

### 耦合强度
**强**

### 影响范围
所有用户入口，但对核心 runtime provider 替换本身影响较小

### 已证实
- `package.json:2-5` 仍是 `@anthropic-ai/claude-code` 与 `claude`
- `package.json:11,34-40` 仍保留 Anthropic author / SDK 依赖
- `src/commands.ts:194` 文案写的是 “Generate a report analyzing your Claude Code sessions”
- `src/main.tsx:230-265` CLI help 仍保留 Anthropic 语义分支

### 判断
这是明确的 Claude Code 专属层，但主要属于“产品外壳”，不是最应该最先切的最小边界。

---

## 3.2 `CLAUDE.md` / onboarding / 指令体系

### 模块
- `src/utils/claudemd.ts`
- `src/projectOnboardingState.ts`
- `src/interactiveHelpers.tsx`
- `src/constants/prompts.ts`

### 职责
加载项目/用户/系统级指令，定义用户协作入口与 onboarding

### Claude 耦合类型
产品协作入口、指令文件命名、系统提示词产品语义

### 耦合强度
**强**

### 影响范围
影响 system prompt 来源、用户教育、项目协作方式

### 已证实
- `src/utils/claudemd.ts:4-7,16,45,53-59` 明确以 `/etc/claude-code/CLAUDE.md`、`~/.claude/CLAUDE.md`、项目 `CLAUDE.md` 为中心
- `src/projectOnboardingState.ts:20-21,28,35-36` onboarding 明确要求/引导 Claude 指令文件
- `src/interactiveHelpers.tsx:163-169` 仍以 `CLAUDE.md` 为指导入口
- `src/constants/prompts.ts:157` 非 OpenAI backend 时仍出现 `claude.ai/code` 产品指向
- `src/constants/prompts.ts:286-287` 仍内嵌 Claude Code 产品支持信息

### 判断
这不是简单的 provider SDK 依赖，而是产品语义耦合。若做 Codex 专用，后续必须处理；但不一定需要作为第一刀。

---

## 3.3 主 agent loop / orchestration

### 模块
- `src/replLauncher.tsx`
- `src/screens/REPL.tsx`
- `src/query.ts`
- `src/query/deps.ts`

### 职责
用户输入进入、agent turn 编排、tool loop、模型调用调度

### Claude 耦合类型
整体接近模型无关

### 耦合强度
**低到中**

### 影响范围
整个主交互路径

### 已证实
- `src/replLauncher.tsx:12-21`
- `src/screens/REPL.tsx:2794-2803`
- `src/query.ts:219-239,263-295,659-707`
- `src/query/deps.ts:22-41`

### 判断
这是当前最接近模型无关的主干区。应尽量保留，不应优先重构。

---

## 3.4 backend registry / selector

### 模块
- `src/services/modelBackend/index.ts`
- `src/services/modelBackend/types.ts`

### 职责
选择 provider backend，定义 backend 统一接口

### Claude 耦合类型
结构上接近中立，但 contract 内核仍带 Claude 派生痕迹

### 耦合强度
**中**

### 影响范围
所有 provider 实现

### 已证实
- `src/services/modelBackend/index.ts:4-25` 将 `openai/responses/codex` 归并为 `openaiResponses`
- `src/services/modelBackend/index.ts:26-33` 后端在统一入口选择
- `src/services/modelBackend/types.ts:8-12` 暴露的接口很薄：`id`, `streamTurn`, `getMaxOutputTokens`

### 已证实（关键问题）
- `src/services/modelBackend/types.ts:1-6` 将 `StreamTurnParams` 和 `ModelBackendStream` 直接定义为 `queryModelWithStreaming` 的参数/返回值派生类型

### 判断
这层是最关键的边界点：
- **接口外形已经像 provider-neutral boundary**
- **但接口内核仍受 Claude 实现签名支配**

---

## 3.5 `services/api/claude.ts` 共享调度层

### 模块
- `src/services/api/claude.ts`

### 职责
主请求构建、streaming dispatch、Claude/OpenAI 分流、历史兼容层

### Claude 耦合类型
深层 runtime / protocol / prompt builder 耦合

### 耦合强度
**很强**

### 影响范围
几乎所有模型调用语义

### 已证实
- `src/services/api/claude.ts:814-853` `queryModelWithStreaming()` 根据 backend 分流到 OpenAI Responses 或 Anthropic
- `src/services/api/claude.ts:1431-1469,1632-1801` 组装 Anthropic 风格 `system/tools/tool_choice/betas/thinking/context_management`
- `src/services/api/claude.ts:1772-1801` 构建 Anthropic 请求参数：`messages`, `system`, `tools`, `tool_choice`, `betas`, `thinking`, `context_management`, `output_config`, `speed`
- `src/services/api/claude.ts:1895-1905` 调用 `anthropic.beta.messages.create({ ...params, stream: true })`
- `src/services/api/claude.ts:1-21` 直接依赖 `@anthropic-ai/sdk` 类型
- `src/services/api/claude.ts:147-154` 也已导入 OpenAI 相关辅助函数，说明这里是混合共享层

### 判断
这是当前最明显的“共享调度层”和“Claude-specific builder”缠绕点。若要建立清晰替换边界，这里必须被拆开或降级为单纯的 Claude provider 实现。

---

## 3.6 OpenAI Responses / Codex 兼容层

### 模块
- `src/services/modelBackend/openaiResponsesBackend.ts`
- `src/services/modelBackend/openaiApi.ts`
- `src/services/modelBackend/openaiCodexConfig.ts`
- `src/services/modelBackend/openaiCodexIdentity.ts`
- `src/services/modelBackend/openaiModelCatalog.ts`
- `src/services/modelBackend/openaiResponsesTypes.ts`

### 职责
把现有 runtime contract 映射到 OpenAI Responses / Codex 形态

### Claude 耦合类型
适配层；自身并不强 Claude-specific，但它的输入/输出 canonical shape 仍受 Claude 形状约束

### 耦合强度
**中**

### 影响范围
Codex/OpenAI 主调用路径

### 已证实
- `src/services/modelBackend/openaiResponsesBackend.ts:246-304` 构建 Responses request
- `src/services/modelBackend/openaiResponsesBackend.ts:268` 将内部工具映射到 OpenAI function tools
- `src/services/modelBackend/openaiResponsesBackend.ts:429-500` 解析 OpenAI SSE
- `src/services/modelBackend/openaiResponsesBackend.ts:519-639` 将 OpenAI 流回译为内部事件
- `src/services/modelBackend/openaiApi.ts:56-95` 构建请求头和认证
- `src/services/modelBackend/openaiApi.ts:67,85` 注入 Codex 风格 headers / turn metadata
- `src/services/modelBackend/openaiCodexConfig.ts:34-39` 指向 `~/.codex/config.toml` 与 `~/.codex/auth.json`
- `src/services/modelBackend/openaiCodexConfig.ts:115-205` 读取 backend/base_url/wire_api/store/cache/reasoning 等配置
- `src/services/modelBackend/openaiCodexConfig.ts:197-204` 默认 backend 为 `openaiResponses`
- `src/services/modelBackend/openaiCodexIdentity.ts:38-79` 生成 Codex identity 与 `x-codex-turn-metadata`
- `src/services/modelBackend/openaiModelCatalog.ts:46-96` 兼容 legacy alias：`best/opus/sonnet/haiku`
- `src/services/modelBackend/openaiResponsesTypes.ts:1-120` 已有 OpenAI Responses payload/event 类型定义

### 判断
这些是本仓库里最有价值的可复用资产，说明迁移不需要从零开始。

---

## 3.7 内部消息结构 / stream 事件 / tool calling canonical shape

### 模块
- `src/services/modelBackend/types.ts`
- `src/services/modelBackend/openaiResponsesBackend.ts`
- `src/remote/remotePermissionBridge.ts`
- `src/remote/sdkMessageAdapter.ts`

### 职责
定义运行时“真正被内部消费的消息/流/tool 语义”

### Claude 耦合类型
协议级、runtime canonical shape 耦合

### 耦合强度
**很强**

### 影响范围
所有 backend 实现、remote adapter、tool orchestration

### 已证实
#### backend contract 仍从 Claude 路径派生
- `src/services/modelBackend/types.ts:1-6`

#### 内部输入 message 仍是 Claude block model
- `src/services/modelBackend/openaiResponsesBackend.ts:78-101` 将 `tool_result` 转成 OpenAI `function_call_output`
- `src/services/modelBackend/openaiResponsesBackend.ts:103-154` 将 Claude-style `tool_use` / message blocks 转成 OpenAI 输入
- `src/services/modelBackend/openaiResponsesBackend.ts:190-241` 再回写为内部 `tool_use`

#### 内部 streaming 事件仍是 Claude-specific
- `src/services/modelBackend/openaiResponsesBackend.ts:327-413` 生成 `message_start`, `content_block_start`, `content_block_delta`, `input_json_delta`, `content_block_stop`, `message_stop`
- `src/services/modelBackend/openaiResponsesBackend.ts:530-604` 在主流翻译循环中输出这些事件

#### remote permission bridge 需要伪造 Claude assistant envelope
- `src/remote/remotePermissionBridge.ts:12-45` 构造带 `role: 'assistant'`, `content: [{ type: 'tool_use', ... }]`, `stop_reason`, `stop_sequence`, `context_management`, Anthropic-style usage 字段的消息

#### SDK 到内部 runtime 的转换，目标也是 Claude-native 形状
- `src/remote/sdkMessageAdapter.ts:21-49`
- `src/remote/sdkMessageAdapter.ts:168-278`

#### tool orchestration 的共享类型仍直接依赖 Anthropic SDK
- `src/services/tools/toolOrchestration.ts:1-24` 直接以 `ToolUseBlock` 作为工具执行输入类型
- `src/services/tools/StreamingToolExecutor.ts:1-24` 同样以 `ToolUseBlock` 作为 streaming tool execution 的核心类型

#### 共享命令 / 权限 / skill prompt 类型仍使用 Anthropic content block 类型
- `src/types/command.ts:1-57` 以 `ContentBlockParam` 作为命令 prompt 的共享返回类型
- `src/types/permissions.ts:9-10` 将 `ContentBlockParam` 引入权限类型层
- `src/skills/bundledSkills.ts:1-40` bundled skill 定义也直接返回 `ContentBlockParam[]`

#### SDK schema 与 MCP client 边界仍保留 Anthropic 类型占位或直接依赖
- `src/entrypoints/sdk/coreSchemas.ts:1240-1247` 仍以内置 placeholder 表示 `APIUserMessage` / `APIAssistantMessage` / `RawMessageStreamEvent`（均来自 `@anthropic-ai/sdk`）
- `src/services/mcp/client.ts:2-6` MCP client 边界直接导入 `Base64ImageSource`, `ContentBlockParam`, `MessageParam`
- `src/cost-tracker.ts:1-30` 成本统计仍直接依赖 Anthropic `BetaUsage` 形状

### 判断
这是当前最深的 Claude 专属边界，不是品牌问题，而是**内部 canonical protocol 问题**。同时，Anthropic SDK 类型已经外溢到 tool orchestration、SDK schema、command/permission/skill 类型层，说明 Claude-shaped contract 不只存在于单一 provider adapter 内。

---

## 3.8 permission / approval 语义

### 模块
- `src/entrypoints/sdk/coreSchemas.ts`
- `src/remote/RemoteSessionManager.ts`
- `src/bridge/types.ts`
- `src/bridge/sessionRunner.ts`

### 职责
tool 使用前审批、allow/deny、updatedInput、hook schema、remote control response

### Claude 耦合类型
大体中立

### 耦合强度
**低**

### 影响范围
SDK / remote / local governance

### 已证实
- `src/entrypoints/sdk/coreSchemas.ts:337-347` permission modes 与模型 provider 无关
- `src/entrypoints/sdk/coreSchemas.ts:387-469` hook payload 使用通用字段 `tool_name`, `tool_input`, `tool_use_id`, `reason`
- `src/remote/RemoteSessionManager.ts:40-48` `allow/deny + updatedInput/message`
- `src/remote/RemoteSessionManager.ts:189-213` `can_use_tool` 请求是通用控制语义
- `src/remote/RemoteSessionManager.ts:263-281` 返回通用 `control_response`
- `src/bridge/types.ts:120-130`, `src/bridge/sessionRunner.ts:33-42` 也是通用控制面
- `src/utils/messages/systemInit.ts:61-87` SDK init 仍发出 `apiKeySource` 与 `claude_code_version` 等带 Claude 历史语义的字段
- `src/entrypoints/agentSdkTypes.ts:1-10,147-158` SDK 公开 surface 与示例仍以 Claude Code / Claude 模型为参照

### 判断
这是少数已经明显接近 provider-neutral 的层，不应过度重构。**但**其外围 SDK 初始化元数据和公开类型文档仍残留 Claude branding / field naming，需要与“控制协议本身是否中立”区分看待。

---

## 3.9 Auth / env / hosted capability 区域

### 模块
- `src/utils/auth.ts`
- `src/services/api/client.ts`
- `src/cli/handlers/openaiAuth.ts`
- `src/services/claudeAiLimits.ts`

### 职责
API key / OAuth / hosted auth / quota / provider client

### Claude 耦合类型
provider + hosted product 混合耦合

### 耦合强度
**很强**

### 影响范围
登录、会话、配额、远程能力

### 已证实
- `src/utils/auth.ts:83-95` 使用 `CLAUDE_CODE_REMOTE`, `CLAUDE_CODE_ENTRYPOINT === 'claude-desktop'`
- `src/utils/auth.ts:100-148` `isAnthropicAuthEnabled()` 依赖 `ANTHROPIC_*` 与 `CLAUDE_CODE_*`
- `src/utils/auth.ts:164-205` token 来源包含 `CLAUDE_CODE_OAUTH_TOKEN`, `claude.ai`
- `src/utils/auth.ts:226-339` API key 获取仍以 Anthropic 为中心
- `src/services/api/client.ts:88-152` 使用 `X-Claude-Code-Session-Id` 等头
- `src/services/api/client.ts:153-219` 还包括 Anthropic Bedrock/Foundry 路径
- `src/services/claudeAiLimits.ts:171-179` 解析 `anthropic-ratelimit-unified-*`
- `src/services/claudeAiLimits.ts:200-218` 使用 `anthropic.beta.messages.create(...)` 探测 quota
- `src/constants/system.ts:71-113` attribution / attestation header 仍围绕 `CLAUDE_CODE_ATTRIBUTION_HEADER`、`cc_version`、`cc_entrypoint` 与 `x-anthropic-billing-header`
- `src/cli/handlers/openaiAuth.ts:27-103` 已存在 OpenAI/Codex auth/status 入口

### 判断
这里最重要的不是“Anthropic 字样多不多”，而是：
- provider auth/config
- Claude.ai hosted capability auth/session

这两类东西当前是混在一起的，应当分层。

---

## 3.10 Claude.ai remote / MCP / Chrome / RemoteTrigger

### 模块
- `src/constants/product.ts`
- `src/remote/SessionsWebSocket.ts`
- `src/services/mcp/claudeai.ts`
- `src/skills/bundled/claudeInChrome.ts`
- `src/components/ClaudeInChromeOnboarding.tsx`
- `src/tools/RemoteTriggerTool/*`
- `src/commands/chrome/*`
- `src/utils/claudeInChrome/*`

### 职责
Claude.ai hosted workflows、组织级 MCP、Chrome integration、remote trigger

### Claude 耦合类型
产品能力耦合，不是简单 provider API 依赖

### 耦合强度
**极强**

### 影响范围
Remote sessions, org MCP, Chrome automation, hosted integrations

### 已证实
- `src/constants/product.ts:1-5` 硬编码 `https://claude.com/claude-code`, `https://claude.ai`
- `src/constants/product.ts:53-76` remote session URL 形如 `${claude.ai}/code/${session}`
- `src/remote/SessionsWebSocket.ts:75-80` 文档即指向 `wss://api.anthropic.com/v1/sessions/ws/...`
- `src/remote/SessionsWebSocket.ts:108-118` WebSocket 发送 `anthropic-version`
- `src/services/mcp/claudeai.ts:32` 使用 `mcp-servers-2025-12-04`
- `src/services/mcp/claudeai.ts:82-95` 调用 `/v1/mcp_servers` 并发送 `anthropic-beta`, `anthropic-version`
- `src/main.tsx:3976-3985` remote/teleport/remote-control flag 仅在 Anthropic-backed flow 下显示
- `src/main.tsx:1421-1437` 文件下载使用 `CLAUDE_CODE_SESSION_ACCESS_TOKEN`
- `src/main.tsx:774-783` macOS URL handler 绑定 `com.anthropic.claude-code-url-handler`
- `src/tools/RemoteTriggerTool/prompt.ts:3-15` 明确是 remote Claude Code agents
- `src/components/ClaudeInChromeOnboarding.tsx:9-10,59,75,90,106` 直接指向 `claude.ai/chrome` 等
- `src/skills/bundled/claudeInChrome.ts:1-26` 依赖 `@ant/claude-for-chrome-mcp`

### 判断
这些不是“最小 provider 抽象”的一部分；它们是 Claude 产品能力。若做 Codex 专用，不应假设可以自然抽象成 provider-neutral 功能。

---

# 四、哪些地方已经接近模型无关

## 4.1 已证实
以下区域已经接近模型无关或至少接近 provider-neutral：

1. **REPL -> query -> tool orchestration 主链路**
   - `src/screens/REPL.tsx:2794-2803`
   - `src/query.ts:263-295,659-707`

2. **`query/deps.ts` 注入式 backend 使用方式**
   - `src/query/deps.ts:22-41`

3. **backend registry / selection 入口**
   - `src/services/modelBackend/index.ts:19-33`

4. **permission / control / hook 语义**
   - `src/entrypoints/sdk/coreSchemas.ts:337-347,387-469`
   - `src/remote/RemoteSessionManager.ts:40-48,189-213,263-281`

## 4.2 高概率推断
若只保留“最小 Codex 专用 runtime”，这些区域大概率可以保留不动或只做很小改动。

---

# 五、哪些地方只是 API client 依赖，哪些已经深入语义

## 5.1 主要只是 API client / adapter 的

### 已证实
- `src/services/modelBackend/openaiApi.ts`
- `src/services/modelBackend/openaiCodexConfig.ts`
- `src/services/modelBackend/openaiCodexIdentity.ts`
- `src/services/modelBackend/openaiResponsesTypes.ts`
- `src/cli/handlers/openaiAuth.ts`（偏 provider auth/operator surface）

### 判断
这些模块大多是在回答“如何与 OpenAI/Codex 交互”。它们本身不是最深的阻碍。

## 5.2 已深入 runtime / prompt / protocol / product 语义的

### 已证实
- `src/services/modelBackend/types.ts`
- `src/services/api/claude.ts`
- `src/services/modelBackend/openaiResponsesBackend.ts`（因其适配目标仍是 Claude-native canonical shape）
- `src/constants/system.ts:12-17,38-64`
- `src/constants/prompts.ts:109-156`
- `src/utils/claudemd.ts`
- `src/constants/product.ts`
- `src/remote/*`
- `src/services/mcp/claudeai.ts`

### 判断
这些地方即便把 SDK 全换掉，也仍会保留 Claude 语义前提。

---

# 六、最小必要抽象边界建议

## 6.1 建议建立的边界

### 边界 A：provider-neutral Turn Contract

#### 已证实的问题
- `src/services/modelBackend/types.ts:1-6` 直接把 backend contract 绑在 Claude 路径签名上

#### 高概率推断
最小必要抽象不应是再加一个外层 facade，而应是**把 canonical turn contract 显式定义出来**。至少需要中立化以下概念：
- turn input
- canonical message
- tool definition
- tool call / tool result
- stream event
- usage / stop reason / reasoning metadata

#### 原因
当前 OpenAI adapter 已证明 provider translation 可行，但它是通过“翻译进/翻译出 Claude-native shape”来工作的。

---

### 边界 B：将 `services/api/claude.ts` 从共享层降级为 Claude provider 实现

#### 已证实的问题
- `src/services/api/claude.ts:814-853` 是共享入口
- `src/services/api/claude.ts:1431-1469,1632-1801,1772-1801,1895-1905` 又携带大量 Anthropic-specific request/stream 语义

#### 高概率推断
应把该文件的职责拆开为：
1. provider-neutral orchestration / request preparation
2. Claude provider implementation
3. OpenAI/Codex provider implementation

#### 原因
如果不拆，这个模块会持续把 Claude 语义泄漏到所有 backend。

---

### 边界 C：provider auth/config 与 hosted-product capability 分层

#### 已证实的问题
- `src/utils/auth.ts:83-148,164-339` 将 Anthropic hosted auth 与 provider auth 混在一起

#### 高概率推断
应拆成：
- 通用 provider auth/config
- Claude.ai hosted auth/session

#### 原因
否则即便主模型已经是 Codex，很多上层逻辑仍会假设 Claude product session 存在。

---

## 6.2 不该过早抽象的边界

### 已证实
下列区域深度绑定 Claude.ai hosted product：
- `src/remote/SessionsWebSocket.ts`
- `src/services/mcp/claudeai.ts`
- `src/skills/bundled/claudeInChrome.ts`
- `src/tools/RemoteTriggerTool/*`

### 高概率推断
这些功能不应先被抽象为“通用 provider 能力层”。
更合理的做法是：
- 先隔离
- 再决定保留、降级、删除或重做

---

# 七、双栈过渡最合理的切入点

## 已证实
已有双栈/兼容雏形存在于：
- `src/services/modelBackend/index.ts:4-25`
- `src/services/modelBackend/openaiCodexConfig.ts:197-204`
- `src/services/api/claude.ts:814-853`
- `src/services/modelBackend/openaiResponsesBackend.ts:641-645`

## 高概率推断
若要双栈过渡，最佳切入顺序不是路线图，而是最小结构切口：

1. **先切 `src/services/modelBackend/types.ts`**
   - 让 backend contract 不再从 Claude function signature 派生

2. **再切 `src/services/api/claude.ts`**
   - 将共享 orchestration 与 Claude request builder 分离

3. **继续复用 `openaiResponsesBackend.ts`**
   - 它已经是现有最成熟的非-Claude provider 实现

4. **再考虑 auth/config 分层**
   - 拆 provider auth 与 hosted-product auth

## 不建议作为 Phase 1 切入口的
### 已证实
- Chrome
- RemoteTrigger
- Claude.ai remote session
- org MCP

### 原因
这些本质上不是最小 provider 替换路径，而是 Claude hosted product features。

---

# 八、已有可复用 Codex / OpenAI / 兼容资产

## 8.1 最高复用价值

### 已证实
#### `src/services/modelBackend/openaiResponsesBackend.ts`
- `:246-304` 构建 request
- `:429-500` 解析 SSE
- `:519-639` 回译 stream
- `:641-645` 提供 `streamTurn`

#### `src/services/modelBackend/openaiApi.ts`
- `:56-95` headers / auth / metadata
- `:96-128` `/responses` fetch

#### `src/services/modelBackend/openaiCodexConfig.ts`
- `:34-39` `~/.codex` 路径
- `:115-205` backend/provider/model/baseUrl/wireApi/store/cache/reasoning 等配置
- `:197-204` 默认 `openaiResponses`

#### `src/services/modelBackend/openaiCodexIdentity.ts`
- `:38-79` Codex identity 与 turn metadata

#### `src/services/modelBackend/index.ts`
- `:4-25` backend aliases
- `:26-33` backend selection

#### `src/services/modelBackend/openaiModelCatalog.ts`
- `:3-96` Codex/OpenAI 模型目录与 legacy alias 兼容

#### `src/services/modelBackend/openaiResponsesTypes.ts`
- `:1-120` Responses payload/event 类型

## 8.2 中高复用价值

### 已证实
- `src/cli/handlers/openaiAuth.ts:27-103`
- `src/main.tsx:231-244` help/auth 文案已部分转向 OpenAI/Codex
- `README.md:2-29,91-103`
- `codex-integration-implementation-plan.md:4-13,205-283`
- `assistant-native-recovery-plan.md:4-13,88-137`
- `scripts/activate-local-cli.sh:11-26`

## 8.3 低到中复用价值

### 已证实
Chrome 相关能力虽然可通过 active provider 路径复用部分调用链，但其核心仍是 Claude 产品语义：
- `src/skills/bundled/claudeInChrome.ts:18-35`
- `src/utils/claudeInChrome/setup.ts:102-187`
- `src/utils/claudeInChrome/mcpServer.ts:84-103,162-203`
- `src/commands/chrome/index.ts:4-11`

### 判断
这部分对“Codex 专用 provider 迁移”不是第一优先级资产。

---

# 九、协议层分类结论

## 9.1 system prompt assembly

### 已证实
- Claude-specific 主请求组装在：`src/services/api/claude.ts:1431-1469,1632-1801`
- OpenAI backend 会把共享 `systemPrompt` 转成 Responses `instructions`：`src/services/modelBackend/openaiResponsesBackend.ts:247-304`
- CLI/system identity 前缀仍保留 Claude 与 OpenAI 两套并行文案：`src/constants/system.ts:12-17,38-64`

### 判断
**混合态**：
- 上层 request builder 仍强 Claude-shaped
- CLI/system identity 本身也仍是双轨并存，而非彻底中立
- 边界后已有 OpenAI adapter

---

## 9.2 tool calling

### 已证实
- `src/services/modelBackend/openaiResponsesBackend.ts:48-76` 内部 tools -> OpenAI functions
- `src/services/modelBackend/openaiResponsesBackend.ts:78-101` `tool_result` -> `function_call_output`
- `src/services/modelBackend/openaiResponsesBackend.ts:118-149` `tool_use` -> OpenAI `function_call`
- `src/services/modelBackend/openaiResponsesBackend.ts:218-241` 再转回内部 `tool_use`

### 判断
**已适配，但 canonical 内部表示仍是 Claude block model。**

---

## 9.3 streaming

### 已证实
- 原生 OpenAI SSE 解析：`src/services/modelBackend/openaiResponsesBackend.ts:429-500`
- 回译成内部 Claude-style 事件：`src/services/modelBackend/openaiResponsesBackend.ts:327-413,530-604`

### 判断
**传输层已适配，内部 stream schema 仍是 Claude-specific。**

---

## 9.4 response schema

### 已证实
- OpenAI response types 已存在：`src/services/modelBackend/openaiResponsesTypes.ts:1-120`
- 共享 backend interface 仍从 Claude streaming types 派生：`src/services/modelBackend/types.ts:1-6`
- SDK schema 中仍保留对 Anthropic 消息/流类型的占位：`src/entrypoints/sdk/coreSchemas.ts:1240-1247`

### 判断
**混合态**：provider-specific schemas 已有，但 shared abstraction 尚未中立，SDK schema 也仍受 Anthropic 历史类型影响。

---

## 9.5 message structure

### 已证实
- internal messages 仍假定 Anthropic-style assistant payload：`src/remote/remotePermissionBridge.ts:12-45`
- remote SDK messages 也要被适配到同一内部形状：`src/remote/sdkMessageAdapter.ts:31-49,168-278`

### 判断
**Claude-specific。**

---

## 9.6 approval / permission semantics

### 已证实
- `src/entrypoints/sdk/coreSchemas.ts:337-347,425-469`
- `src/remote/RemoteSessionManager.ts:37-49,189-213,247-281`

### 判断
**基本模型无关。**

---

# 十、对 6 个核心问题的直接回答

## 10.1 当前仓库里，哪些模块是真正的 Claude Code 专属？

### 已证实
- `package.json`
- `src/utils/claudemd.ts`
- `src/projectOnboardingState.ts`
- `src/constants/product.ts`
- `src/remote/SessionsWebSocket.ts`
- `src/services/mcp/claudeai.ts`
- `src/skills/bundled/claudeInChrome.ts`
- `src/components/ClaudeInChromeOnboarding.tsx`
- `src/tools/RemoteTriggerTool/*`
- `src/utils/auth.ts` 中的 Claude.ai / Anthropic hosted 分支
- `src/services/api/client.ts` 的 Claude session/client 部分

## 10.2 哪些模块已经接近模型无关？

### 已证实
- `src/query.ts`
- `src/query/deps.ts`
- `src/screens/REPL.tsx` 到 `callModel` 前的大部分逻辑
- `src/services/modelBackend/index.ts`
- permission/control/hook 相关 schema 与 manager

## 10.3 哪些地方只是 API client 依赖，哪些地方已经深入到 runtime / prompt / protocol / product 语义？

### 已证实
#### 偏 API client / adapter
- `openaiApi`
- `openaiCodexConfig`
- `openaiCodexIdentity`
- `openaiResponsesTypes`
- `openaiAuth`

#### 深入 runtime / prompt / protocol / product 语义
- `modelBackend/types`
- `services/api/claude.ts`
- `openaiResponsesBackend`
- `constants/system`
- `constants/prompts`
- `utils/claudemd`
- `constants/product`
- `remote/*`
- `services/mcp/claudeai.ts`

## 10.4 最小必要抽象边界应该建在哪里？

### 已证实
结构入口在：
- `src/query/deps.ts`
- `src/services/modelBackend/index.ts`

### 高概率推断
真正要建的是 `provider-neutral turn/message/stream contract`，位置在：
- `src/services/modelBackend/types.ts`
- 与 `src/services/api/claude.ts` 的边界处

## 10.5 如果要双栈过渡，最合理的切入点是什么？

### 高概率推断
- 第一个切口：`src/services/modelBackend/types.ts`
- 第二个切口：`src/services/api/claude.ts`
- 第一条可复用实现：`src/services/modelBackend/openaiResponsesBackend.ts`
- 不应从 Chrome / remote / org MCP 开始

## 10.6 仓库里是否已经存在 Codex 迁移资产可直接利用？

### 已证实
存在，而且已经相当多：
- `src/services/modelBackend/openai*` 全套
- `src/cli/handlers/openaiAuth.ts`
- README 中的迁移架构说明
- `codex-integration-implementation-plan.md`
- `assistant-native-recovery-plan.md`

---

# 十一、给另外两个队长的移交事项

## 11.1 给“能力保真队长”

### 最该重点关注的边界

#### 1) canonical stream event 仍是 Claude-shaped
- `src/services/modelBackend/openaiResponsesBackend.ts:327-413,530-604`
- 风险：上层是否硬依赖 `message_start/content_block_delta/message_stop`

#### 2) canonical message/tool block 仍是 Claude block model
- `src/services/modelBackend/openaiResponsesBackend.ts:78-101,103-154,190-241`
- 风险：tool call / result / stop reason / reasoning 的无损映射问题

#### 3) shared backend contract 仍从 Claude path 派生
- `src/services/modelBackend/types.ts:1-6`
- 风险：表面双栈，实则所有 provider 都在扮演 Claude

#### 4) 不要把 Claude.ai hosted product 功能与模型能力混为一谈
- `src/remote/SessionsWebSocket.ts:75-118`
- `src/services/mcp/claudeai.ts:82-95`

---

## 11.2 给“迁移治理队长”

### 最适合作为 Phase 1 切入口的模块和原因

#### 1) `src/services/modelBackend/types.ts`
原因：决定 canonical contract 是否继续被 Claude path 主导

#### 2) `src/services/api/claude.ts`
原因：共享入口与 Claude request builder 的缠绕点

#### 3) `src/services/modelBackend/openaiResponsesBackend.ts`
原因：现有最成熟的非-Claude provider 实现

#### 4) `src/utils/auth.ts` + `src/cli/handlers/openaiAuth.ts`
原因：provider auth 与 Claude hosted auth 应尽早分层

### 不建议作为 Phase 1 切入点的模块
- `src/remote/SessionsWebSocket.ts`
- `src/services/mcp/claudeai.ts`
- `src/skills/bundled/claudeInChrome.ts`
- `src/tools/RemoteTriggerTool/*`

原因：这些更像 Claude 产品能力，而非最小 provider 替换边界。

---

# 十二、最终判断

### 已证实
1. 当前仓库**不是从零开始做 Codex 替换**，而是已经存在一套能跑主链路的 OpenAI Responses / Codex 兼容资产。
2. 当前仓库**也远未完成真正的“去 Claude 化”**，因为内部 canonical runtime shape 仍以 Claude 协议为中心。
3. Anthropic SDK 类型和 Claude 历史字段命名已经渗透到 orchestration、SDK schema、system init metadata、command/permission/skill 共享类型层，不只存在于 `services/api/claude.ts` 一处。
4. 因此，仓库当前状态可以概括为：
   - **产品外壳仍是 Claude Code**
   - **runtime 主干接近模型无关**
   - **provider 已开始切到 Codex/OpenAI Responses**
   - **内部消息/stream/tool canonical shape 仍是 Claude-native**

## 高概率推断
如果目标是“Codex 专用的最小替换边界”，最合理的工程判断是：
- **保留主 agent loop 与 backend registry**
- **中立化 `modelBackend/types.ts` 对应的 turn/message/stream contract**
- **把 `services/api/claude.ts` 从共享层拆成 provider-specific 实现**
- **把 Claude.ai hosted capability 当作独立产品能力处理，而不是强行纳入通用 provider abstraction**

## 待验证假设
在真正开始改造前，仍建议逐条验证：
- 非主链路（voice/remote/Chrome/MCP）是否依赖相同 canonical contract
- 是否存在当前未显式暴露的 smoke scripts 或 runtime checks 用于锁定 Claude-specific stream/message 语义

---

## 附：快速索引（最关键文件）

### 最值得看的替换边界文件
- `src/query/deps.ts`
- `src/services/modelBackend/types.ts`
- `src/services/modelBackend/index.ts`
- `src/services/api/claude.ts`
- `src/services/modelBackend/openaiResponsesBackend.ts`

### 最强 Claude 专属耦合文件
- `src/utils/claudemd.ts`
- `src/constants/product.ts`
- `src/remote/SessionsWebSocket.ts`
- `src/services/mcp/claudeai.ts`
- `src/utils/auth.ts`

### 最强 Codex/OpenAI 可复用资产
- `src/services/modelBackend/openaiResponsesBackend.ts`
- `src/services/modelBackend/openaiApi.ts`
- `src/services/modelBackend/openaiCodexConfig.ts`
- `src/services/modelBackend/openaiCodexIdentity.ts`
- `src/services/modelBackend/openaiModelCatalog.ts`
