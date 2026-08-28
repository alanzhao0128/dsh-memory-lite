# dsh-memory-lite — Phase 1 Implementation Spec

> 依据：《Light Memory for DSH 设计方案》v7（2026-08-25）
> 目标 DSH：`@deepseek-ai/dsh-*` @ **0.1.1-rc.2**（与运行中的 GUI 一致）
> 实现方式：独立插件（非 fork），目录 `/Users/alan/code/dsh-test/dsh-memory-lite`（2026-08-26 由 `dsh-memory-light` 改名，见文末《改名记录》）
> 本文档随实现同步维护；Phase 2/3 落地时在此追加对应章节。

## 0. 已与用户锁定的决策

1. **范围**：先做 Phase 1（文件结构 + MemoryStore + 5 工具 + L0 catalog 注入），挂载验证后继续 Phase 2/3。
2. **subagent 策略**：跳过注入 + 工具拒绝 subagent 来源调用（成本减半，语义最干净）。
3. **规格**：以本文件为实现与验收依据。

## 1. 包结构与构建

- npm 名 **`dsh-memory-lite`**（不挂 `@deepseek-ai` scope），bundle 式插件：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`（insert 一行、无配置、默认惰性）。
- ESM（`"type": "module"`）、tsc-only 构建（`tsc -p tsconfig.json` → `lib/`），NodeNext，`engines.node >= 22`。结构照 `dsh-image-plugins`。

```
dsh-memory-lite/
├── package.json / tsconfig.json / cordis.patch.yml / README.md / IMPLEMENTATION.md
├── src/
│   ├── index.ts          # name / inject / Config / apply（Cordis 函数插件，无 default export）
│   ├── config.ts         # Phase 1 Config 类型 + schemastery + 默认值
│   ├── types.ts          # 纯类型（IndexEntry / MemoryCatalogSource 等）
│   ├── peer.ts           # 从 SessionHeader.cwd 派生 peer
│   ├── path.ts           # canonicalize + containment（安全边界）
│   ├── memory-store.ts   # MemoryStore：读/写/搜/软删/索引重建 + 串行写队列
│   ├── catalog.ts        # catalog 渲染 / digest / catalogHistory（照 tool-skill）
│   ├── inject.ts         # agent/pre-step waterfall 注入
│   └── tools/            # read-memory / search-memory / remember / update-memory / forget-memory
└── tests/                # node:test + tsx（`node --import tsx --test tests/*.test.ts`）
```

## 2. 依赖（全部锁定 0.1.1-rc.2，除 schemastery/cordis）

| 包 | 版本 | 角色 |
|---|---|---|
| `@deepseek-ai/dsh-tools` | 0.1.1-rc.2 | 运行时：`defineTool` / `ToolExecution` |
| `@deepseek-ai/schemastery` | ^3.18.1 | 运行时：`Config` 校验 |
| `@deepseek-ai/dsh-atomic-write` | 0.1.1-rc.2 | 运行时：`writeFileAtomic` / `withFileLock` |
| `@deepseek-ai/dsh-home-paths` | 0.1.1-rc.2 | 运行时：`expandHomePath`（`~/.agent-memory`） |
| `@deepseek-ai/cordis` | ^4.0.1 | peer + dev：`Context` 类型 |
| `@deepseek-ai/dsh-agent` | 0.1.1-rc.2 | dev（类型）：`PreStepDecision` / `Agent` / 事件 payload |
| `@deepseek-ai/dsh-session` | 0.1.1-rc.2 | dev（类型）：`SessionHeader` / `UserMessage` |
| `@deepseek-ai/dsh-llm` | 0.1.1-rc.2 | dev（类型）：`MessageSourceMap` 合并 / `createUserMessage` |
| `@deepseek-ai/dsh-tool-skill` | 0.1.1-rc.2 | dev（参考实现，catalog 模式） |
| `@deepseek-ai/cordis-plugin-loader` | ^1.0.2 | dev：Loader boot 冒烟测试 |

`@deepseek-ai/dsh-user-approval`、`@deepseek-ai/cordis-plugin-timer` 在 Phase 3/2 再加，本期不引入。

## 3. Config（Phase 1 子集）

```ts
interface MemoryConfig {
  root: string                       // 默认 '~/.agent-memory'（expandHomePath）
  defaultPeer: string                // 默认 'dsh-web'
  workspacePeers: {
    enabled: boolean                 // 默认 true
    excludeSubagents: boolean        // 默认 true
    cwdFallback: string              // 默认 'default_peer'（值为 defaultPeer 时回退 defaultPeer）
  }
  index: {
    maxTokens: number                // 默认 1200；catalog 条目超限截断（Phase 1 实现条目截断，不硬性保证 token）
    sortBy: 'mtime'                  // 默认 'mtime'
  }
  tools: {
    schemaMinimal: boolean           // 默认 true（本实现天然精简，flag 预留）
    pathRoot: string                 // 默认 = root；containment 根
    pathEscape: 'reject'             // 默认 'reject'
  }
}
```

schemastery：全部字段带默认值，`Config = z.object({...})`。Phase 2 追加 `extraction.*`，Phase 3 追加 `sharing` 与 `tools.forgetRequiresApproval`。

### 3.1 Peer 隔离模型（按 cwd/项目，不按 agent）

Peer 从每个会话自己的 `SessionHeader.cwd` 派生（`peerFromCwd`：sanitized basename + sha1(cwd) 前 8 位，如 `/Users/alan/code/dsh-test` → `dsh-test-72572e8b`）。**隔离维度是工作目录（项目），不是 agent/preset**：

| 场景 | 行为 |
|---|---|
| 同一项目、不同 agent/preset（code / standard / web） | **共享同一 peer** 记忆（都按 cwd 派生） |
| 同一 agent、不同项目（如 dsh-test vs sync） | **各自独立 peer**，互不可见 |
| 会话无 cwd | 回退 `workspacePeers.cwdFallback`（默认 `defaultPeer`） |
| GUI 不选项目 | 全部会话落 GUI 默认项目目录对应的同一 peer（v7 §14.3-5 校准） |

- 插件只读 `header.cwd` 与 `header.origin`（主/子会话），**从不读 agent 身份或 `agentPreset`**（header 里有该字段，未使用）。
- **后果**：在 `/Users/alan/code/sync` 开的新会话落在 peer `sync-d1ace078`（空），看不到 `dsh-test-72572e8b` 的 14 条记忆——空索引按设计不注入目录（§7 applyCatalogDecision）。这是 peer 隔离的正常行为，不是 bug（2026-08-26 实测确认）。
- **跨项目共享**：**已实现（Phase 3，§13.2 偏差 13）**——`sharing` 配置 + `shared/<name>/...` 逻辑映射（只读单向），任一 peer 会话可读其他 peer 记忆；详见 §13.2 偏差 13。
- **按 agent 再分一层**（如需）：可在 `peerFromCwd` 中混入 `agentPreset` 维度，当前未做（通常没必要，会割裂同一项目的记忆）。
- 佐证：设计方案第 262 行「Peer ID 从每个会话自己的 SessionHeader.cwd 派生……同一 Agent 下不同项目的记忆隔离天然成立」；第 320 行「peers/ 每个 Agent/项目一个 Peer」。


## 4. MemoryStore 与路径安全（Phase 1 唯一安全边界）

### 4.1 目录布局（挂载时惰性创建）

```
{root}/
├── peers/{peer}/memories/
│   ├── _index.md                       # L0 索引（源文件，插件生成，人类可编辑）
│   ├── preferences/  entities/  events/  experiences/
│   │   └── {slug}.md                   # L1 全文
│   └── sessions/{session-id}.json      # Phase 2：checkpoint + digest + 审计
└── shared/                             # Phase 3（软链接 + containment carve-out）
```

### 4.2 路径约定（定死）

- **所有工具 path 参数 = 相对 memories root 的相对路径**（如 `preferences/coding.md`），拒绝绝对路径。
- 合法目标：memories root 内任意 `.md`（含四分类子目录），不设类别白名单（人类可能放别的目录）。
- **containment 强制点 = MemoryStore 的 resolve 方法**（执行点，不只靠工具描述）：`path.resolve(memoriesRoot, candidate)` → `realpath`（解析符号链接）→ 断言仍在 `realpath(root)` 内。`..` 逃逸、绝对路径、符号链接逃逸一律 `MemoryPathError`（明确错误信息）。
- `shared/` 及配置化共享目标的 carve-out 属 Phase 3，本期不实现（`shared/` 目录不存在时无放行面）。
- 拒绝越界的 executor 层测试（Phase 1 必写）。

### 4.3 写通道（并发安全）

- 所有写操作经 **MutationQueue**（插件内串行 Promise 队列，单文件锁语义）；`writeFileAtomic`（tmp + rename）落盘；`_index.md` 重建在队列内。
- 主会话工具（remember/update）与后台提取（Phase 2）共用同一队列。

### 4.4 MemoryStore API（Phase 1 面）

```ts
interface MemoryStore {
  readonly root: string                       // 已 canonical 的 root
  memoriesRoot(peer: string): string
  resolve(peer: string, relPath: string): Promise<{ abs: string; rel: string }>  // containment 唯一入口
  readFile(peer: string, relPath: string): Promise<{ content: string }>          // 越界/不存在抛错
  writeFile(peer: string, relPath: string, content: string): Promise<void>       // 队列 + 原子写
  softDelete(peer: string, relPath: string): Promise<void>                       // 移入 root/.trash/{date}/{name}（软删除，不覆盖）
  search(peer: string, query: string, opts?): Promise<SearchMatch[]>             // 行匹配，上限 20 条/行 300 字符
  readIndex(peer: string): Promise<IndexEntry[]>                                // 解析 _index.md（宽容解析，见 §5.2）
  rebuildIndex(peer: string, entries: IndexEntry[]): Promise<void>               // 重排（mtime 倒序、截断）+ 原子写
  listCategoryFiles(peer: string, category: string): Promise<{ rel: string; mtime: number }[]>
}
```

实例在 `apply()` 内创建并闭包传入工具与注入器（不注册为 ctx 服务，避免过早固化接口）。

## 5. Catalog 与注入（照 `dsh-tool-skill` 逐条抄）

### 5.1 typed source（merge-extensible，已核实可行）

```ts
interface MemoryCatalogSource {
  readonly kind: 'memory-catalog'
  readonly form: 'catalog'
  readonly update?: true
  readonly entries: readonly { readonly category: string; readonly path: string; readonly summary: string }[]
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'memory-catalog': MemoryCatalogSource }
}
```

### 5.2 索引文件格式（源文件，插件生成，一行一条）

```markdown
# Memory Index — {peer}

> Last updated: {ISO date} | Total: {n}

## preferences (always relevant)
- preferences/coding.md: prefers functional style, pnpm, tabs, no semicolons

## entities (relevant when mentioned)
- entities/project-foo.md: React 18, TypeScript

## events (relevant for time queries)
## experiences (relevant for similar tasks)
```

- 条目行：`- {relpath}: {summary}`，relpath 相对 memories root（模型可直接回传给 read_memory）。
- **宽容解析**：`readIndex` 逐行匹配 `^- (\S+\.md): (.*)$`；不匹配行忽略（人类编辑容忍），解析结果与渲染出的 catalog 消息保持一致（digest 用条目算，不用原文）。
- 排序：按 `sortBy`（mtime 倒序）重建；单类 > 10 条时生成分类二级 `_index.md`（本期仅在重建时写入类别 `_index.md`，catalog 仍平铺全量，超 `index.maxTokens` 时按类截断并加 `… (truncated)` 注记）。

### 5.3 catalog 消息文本（含 §7.2 工具提示，并入同一条消息）

```markdown
<system-reminder>
This is your long-term memory index for the {peer} project. It lists what you have memorized, one line per memory. The full text of any memory is NOT loaded until you call read_memory — use the exact path from this index.

{按类分节的条目列表}

You have long-term memory tools (read_memory / search_memory / remember / update_memory / forget_memory). Call remember only when the user explicitly asks to remember something; do not decide on your own. In all other cases prefer read_memory / search_memory to load what this index points to.
</system-reminder>
```

- 首次发布 = `renderCatalogMessage`；索引变更且旧 catalog 在可见面 = `renderCatalogUpdate`（"replaces every earlier memory catalog in this session"）。
- digest：条目规范串（每行 `JSON.stringify([category, path, summary])`）→ sha256 hex（照 tool-skill）。

### 5.4 pre-step 注入逻辑（照 tool-skill index.ts:213-251 逐分支）

```
ctx.on('agent/pre-step', ...):
  decision = await next()
  reject → 原样返回
  subagent 会话（agent.session.header.origin === 'subagent'）→ 原样返回   # 决策 2
  可见性锚 = ctx.tools.get('read_memory', agent) === readMemoryTool；不可见 → 原样返回
  peer = sessionPeer(agent.session.header, config)
  entries = await store.readIndex(peer)
  digest = digestIndexEntries(entries)
  history = catalogHistory(agent)                    # 扫 session.events 找最近可见的 memory-catalog
  existing = catalogMessage(decision.messages)
  分支（与 tool-skill 完全一致）：
    history.visibleDigest === digest → 移掉进入批次里多余的同源 catalog（若有）或不动
    existing 存在且其 digest === digest → 不动
    !history.published && entries.length === 0 → 不注入（空索引）
    history.published → renderCatalogUpdate 替换/追加
    否则 → renderCatalogMessage 追加
```

- `catalogHistory`：自尾向前扫 `agent.session.events`，找 `user/message` 且 `source.kind === 'memory-catalog'` 的最后一条，`agent.session.surface.nodes` 集合判可见性（与 tool-skill 一致）。
- 注入消息 = `createUserMessage({ content: [{type:'text', text}], source: {kind:'memory-catalog', form:'catalog', entries} })`，随进入批次落日志（满足 Model-visible ⟺ logged）。

## 6. 工具集（5 个，schema 精简）

| 工具 | 参数 | 说明 |
|---|---|---|
| `read_memory` | `path` (req) | 读 L1 全文；越界抛错；output `{path, content}` |
| `search_memory` | `query` (req) | grep 行匹配，`{matches: [{path, line}]}` |
| `remember` | `category` (req, enum 四类), `title` (req), `content` (req) | 创建/追加；slug 化 title；写文件 + 重建索引 |
| `update_memory` | `path` (req), `content` (req) | 旧内容入 `## History`，新内容入 `## Current`；重建索引 |
| `forget_memory` | `path` (req) | 软删到 `root/.trash/`；审批接线属 Phase 3（本期直接软删） |

- 每个工具 `execute` 首行：subagent 来源拒绝（`exec.agent?.session.header.origin === 'subagent'` → throw）。
- `presentCall`：read_memory/search_memory `kind:'read'` + `locations:[path]`；remember/update/forget `kind:'write'`。UI 渲染意图 Phase 1 统一 `generic`。
- output schema 均 `additionalProperties:false`，结果带 render 纯函数。

## 7. subagent 策略（决策 2 的实现落点）

- 注入侧：pre-step 顶部按 `origin === 'subagent'` 短路（不注入 catalog，不增加成本）。
- 工具侧：每个工具 execute 顶部拒绝 subagent 来源。两处都做（注入短路是成本优化，工具拒绝是语义/安全边界）。

## 8. 测试策略（独立插件的适配）

1. **单元测试**（node:test + tsx，无外部服务）：
   - `path.test.ts`：containment —— 绝对路径、`..` 逃逸、符号链接逃逸均拒绝；正常相对路径通过（executor 层拒绝测试，非仅描述）。
   - `memory-store.test.ts`：原子写、串行队列（并发写不交错）、软删、索引重建、宽容解析。
   - `catalog.test.ts`：digest 稳定、空索引跳过、update/replace 分支、subagent 短路、消息文本 golden。
   - `config.test.ts`：默认值、非法值报错。
2. **Loader boot 冒烟**（`boot.test.ts`）：用 `@deepseek-ai/cordis-plugin-loader` 挂载本地 `cordis.yml`（insert 本插件行），断言 `ctx.tools` 注册 5 个工具。这是 out-of-repo 插件能做到的最接近 REAL-composition 的验证。
3. **挂载验证**（人工，见 §10）：装进运行中的 web profile，真实会话里验证注入与工具。
4. 仓库内 keyless snapshot 设施不适用于独立插件；Phase 2 的提取触发次数改为"运行日志统计 + 单元断言防抖/门槛逻辑"覆盖。

## 9. 本期不做（Phase 2/3 占位）

- 隐式提取（checkpoint / `ctx.llm.stream` / 多重触发 / 滚动 digest / 审计）→ Phase 2，`sessions/{id}.json` schema 届时定。
- `forget_memory` 审批、`shared/` 共享 + carve-out、`## Related` 维护 → Phase 3。
- CLI/MCP → Phase 4。

## 10. 挂载与验收

1. `pnpm build && pnpm test` 通过。
2. 把插件装进 `$DSH_HOME/profiles/web`（`dsh plugin --profile web add ...` 或手工 pnpm），配置 `cordis.patch.yml` 覆写 root 指向测试目录。
3. 启动/刷新 GUI，发一条"记住 X"指令验证 `remember` 落盘 + `_index.md` 重建 + 下一条消息携带 catalog；人工确认 subagent 会话无注入。
4. 验收清单：5 工具可见、L0 注入一次、写后索引更新、越界路径被拒、subagent 拒绝。

---

### 10.1 实测结论（2026-08-25，标准模式新会话，dsh-test 工作区 → peer dsh-test-72572e8b）

| # | 用例 | 结果 | 证据 |
|---|---|---|---|
| 1 | remember「记住：偏好用 pnpm」 | 通过 | preferences/pnpm.md（Current/History/Related 三段式）+ _index.md Total:1 |
| 2 | 新会话直接问包管理器偏好 | 通过 | 会话日志 source.kind: memory-catalog 注入，模型可答 |
| 3 | search_memory | 通过 | 行级命中，路径可直接回传 |
| 4 | update_memory 改 npm | 发现bug后修复 | content 传整文件 bug → normalizeContent 修复（见 §11-9）；落盘已人工修复 |
| 5 | forget_memory | 通过 | 文件移入 .trash/2026-08-25/（软删除），索引 Total:0，注入同步为空 |
| 6 | remember 中文标题「喜欢吃苹果」 | 发现bug后修复 | 旧 slugify 剥除非 ASCII → 撞成 memory.md → 改为保留 CJK（见 §11-10），已改名 preferences/喜欢吃苹果.md |

- 会话类型结论：工具注册在根上下文 → global 工具层，四个预设（标准/PTC/极简/创造）的 agent 视图均可见（dsh-tools view() 无条件继承 global 层、无 preset 调用 restrict()）；但测试/使用选「标准模式」——极简固定 persona 无引导、PTC 工具走 run_code SDK。
- 备注：两批修复均已重启验证生效（2026-08-25 10:29 重启后实测：中文标题正确生成 preferences/喜欢跑步.md，update 内容归一化正常）；此前中间态写入均已人工校正落盘。
- 已知问题（暂不解决，记录待评估）：PTC 模式下模型先尝试原生调用 memory 工具，被 PTC 工具呈现拒绝（ToolNotFoundError: UNKNOWN_TOOL）后再退回 run_code 包装调用——功能可用、落盘正确，但每次多消耗 1 次 LLM 请求。留待 Phase 2 工具呈现适配时一并评估（届时也可考虑 PTC 下让 memory 工具经 Code Mode SDK 直接可见）。

---

## 11. 实现偏差记录（Phase 1 落地时，2026-08-25）

以下为写代码时对 §4-§8 的定死项作出的调整，均已体现在源码与测试中：

1. **containment 根 = 当前 peer 的 memories root**（比 §4.2 的整 root 更严格）：resolve(peer, rel) 约束在 peers/{peer}/memories 内，跨 peer 路径一律拒绝。tools.pathRoot/tools.pathEscape 配置项**本期不暴露**——路径逃逸策略是固定安全不变式，不可配置；shared/ carve-out 随 Phase 3 引入（届时 containment 根需按 sharing 配置放行）。
2. **peer slug 统一小写**：peerFromCwd 对 basename 先 lowercase（macOS 默认大小写不敏感文件系统，避免 My-App vs my-app 碰撞）。
3. **catalogMessage 容忍无 source 的消息**：未盖 source 的消息（手工 createUserMessage）不是本插件的 catalog，跳过而非抛错（对齐 tool-skill 的宽容姿势）。
4. **resolve 的 rel 基于 canonical 根计算**：macOS /tmp → /private/tmp 等符号链接祖先会让 relative(memories, abs) 算出逃逸路径；先 realpathSafe(memories) 再算 rel。
5. **walkMarkdown 的 rel 始终相对顶层 memories root**（不是被遍历目录），保证 search 结果可直接回传给 read/update/forget。
6. **renderMemoryFile 节头后不加空行**（## Current 直接接正文），与 writeNewMemory 模板一致；round-trip 测试锁定。
7. **applyCatalogDecision 抽成纯函数**（inject.ts 导出）便于单测；入口先 guard decision.kind === 'reject'。
8. **boot 冒烟测试**：新增 devDep @deepseek-ai/dsh-app-boot，用 boot() + mountRootInclude 从真实 cordis.yml 挂载 dsh-system-prompt/dsh-tools/dsh-agent + 本插件（构建产物 lib/index.js）；YAML 中 @ 开头的 scope 名必须加引号（@ 是 YAML 保留指示符）。测试需先 npm run build。
9. **update/remember 的 content 归一化**（实测发现，2026-08-25）：新会话实测 update_memory 时，模型把「完整渲染文件」（H1 + ## Current/History/Related 整段）当作新 content 传入，导致 Current 段嵌套了整个旧文件。新增 `normalizeContent`：若 content 形如完整文件（首行 `# ` 且含 `## ` 段），解析并提取 Current 段正文作为新 content（无 Current 段则退化用全文）；纯文本原样通过。在 update_memory / remember 工具边界统一应用（索引摘要同样用归一化后的值）。配套测试 `normalizeContent unwraps a full-file payload into its Current body`。
10. **slugify 保留 CJK**（实测发现，2026-08-25）：中文标题（如「喜欢吃苹果」）被旧正则全部剥掉 → slug 为空 → 兜底 memory.md，任何中文标题都会互相覆盖。改为保留 Unicode 字母数字（p{L}p{N} 类，u 标志）：中文标题生成有意义文件名（preferences/喜欢吃苹果.md），emoji-only 标题仍退化 memory。配套测试 slugify keeps CJK titles so Chinese memories do not collide。

## 12. Phase 2 规格：隐式提取（通道 B）

> 起草 2026-08-25，依据设计文档 §八/§九 + 0.1.1-rc.2 已安装源码逐条核验（见 §12.1）。实现前需用户 review 并锁定决策。

### 12.1 范围与已锁决策

1. 范围：后台隐式提取（通道 B），与 Phase 1 显式通道（5 工具）并存；新增 extraction 配置、触发系统、提取执行器、滚动 digest、checkpoint/审计。Phase 1 的 5 工具与 L0 注入不变。
2. **提取模型决策（用户已锁）**：默认复用主会话当前模型——从 `session.requestHeader().config`（`LlmCallConfig: { provider, model, ... }`）解析；`extraction.llm.provider/model` 非空时用专用模型覆盖（配置文件可改）。
3. **提取异步化（源码硬约束）**：`agent/turn-stopping` 是 `dispatch.serial` + awaited（dsh-agent-loop），回调内不得同步 await 提取 LLM；所有触发入口只做「判定 + 排队」，实际提取经 `ctx.jobs` 派发（dsh-base 根已挂载 dsh-jobs-local，`ctx.jobs` 可用）。事件内不 await 提取。
4. **审计不进会话日志（源码硬约束）**：`Session.append(type, data, opts)` 的 opts 只读 `sourceEventSeqs`/`surfaceOp`，无 `ignorable` 设置入口；`assertEventsSupported` 对未知非 ignorable 事件类型拒绝解释整条日志 → out-of-repo 插件自定义会话事件会让 resume 失败。提取审计与 checkpoint 同文件写入 `peers/{peer}/sessions/{session-id}.json`（插件自身存储，原子写队列内）。
5. 只处理主会话：`session.header.origin !== 'subagent'`（含 `delegationDepth` 过滤，防子代理重复提取）。
6. 消息口径（v6 定死，源码确认）：只统计/读取 `SURFACE_EVENT_TYPES` = `user/message`、`assistant/message`、`tool/result`；其余（turn/start、chunk、request/header、log-only）一律不计。
7. 提取素材从 `session.events`（append-only 完整日志）读取，**不读 `session.surface`**（compaction 只移 surface 不移 log，seq 连续）。

### 12.2 新增配置（extraction 命名空间，照设计文档 §九）

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `incremental` | `incremental` / `explicit_only`（关提取、留工具）/ `off` |
| `window_turns` | `20` | 新增消息 ≥ 该数触发一次提取（会话内累计计数） |
| `idle_timeout_min` | `30` | 空闲多久触发剩余提取（`ctx.timeout`，每消息重置） |
| `max_messages` | `20` | 每次提取最多喂给提取 LLM 的消息数 |
| `message_scope` | `[user, assistant, tool_result]` | 消息口径（固定为三种 SurfaceEventType，配置仅作显式声明） |
| `tool_result_max_bytes` | `2048` | tool/result 喂 LLM 前单条内容截断 |
| `include_digest` | `true` | 携带滚动 digest |
| `dedup` | `true` | grep 已有记忆做对比（防重复/矛盾） |
| `llm.provider` / `llm.model` | `null` | `null` = 复用会话当前模型（`session.requestHeader().config`）；非空 = 专用提取模型 |
| `turn_stopping_trigger` | `true` | agent/turn-stopping 兜底入口 |
| `flush_trigger` | `true` | session/flush 最后防线入口 |
| `min_turn_extract` | `5` | turn 边界入口的最小未提取消息数门槛 |
| `turn_debounce_ms` | `30000` | turn 边界提取防抖（同会话窗口内不重复提取） |
| `audit_log` | `true` | 审计写 sessions/{id}.json |
| `max_concurrent_requests` | `1` | 提取 LLM 并发上限（全局单飞） |

### 12.3 触发系统（五路 → 统一判定 → ctx.jobs 派发）

统一入口 `maybeScheduleExtraction(session)`：校验 `mode`、peer 存在、非 subagent、无在途任务 → 满足则 `ctx.jobs` 派发 `extraction` 任务（owner = 本插件作用域）。

| 路 | 事件 | 判定 | 约束 |
|---|---|---|---|
| ① 消息计数 | `session/event`（仅计三种 SurfaceEventType） | 未提取消息数 ≥ `window_turns` | 每会话计数器，随 checkpoint 推进清零 |
| ② 空闲 | `ctx.timeout(idle_timeout_min)` | 超时未触发过 | 每次 session/event 重置定时器 |
| ③ turn 边界 | `agent/turn-stopping`（serial） | 未提取数 ≥ `min_turn_extract` 且过 `turn_debounce_ms` | **回调内不 await**，只排队 |
| ④ 最后防线 | `session/flush`（parallel） | 同 ③ 门槛与防抖 | flush 由持久化 checkpoint policy 驱动，频率不可控（源码证实），不作主依赖 |
| ⑤ 手动 | 内部钩子/测试 | 立即提取 | 无门槛 |

### 12.4 提取执行协议（job 内，照设计文档 §八 增量提取协议）

```
Step 0: 从新窗口提取关键词（启发式：高信息名词/动词，~8 个）
Step 1: grep 命中已有记忆（search，rel 路径 + 行）
Step 2: 一次 ctx.llm.stream 调用，输入 = [滚动 digest] + [新窗口消息（含 tool_result_max_bytes 截断）] + [grep 命中记忆]
        指令：「提取记忆。决策：create/merge/update/skip。修正时旧内容移入 ## History。」
Step 3: 解析 decision → MutationQueue 内 writeNewMemory / merge(appendCurrent) / updateCurrent + 更新 ## Related + 重建 _index
Step 4: 更新滚动 digest（~100 token 会话摘要）+ 推进 checkpoint seq（原子写，与审计同文件）
```

### 12.5 提取 LLM 调用规格

- `options`：`{ provider, model, messages, system（抽取指令）, maxTokens（如 1024）, signal }`；
  - provider/model：`config.extraction.llm` 非空用它；否则 `session.requestHeader()?.config`（缺失则跳过本轮并记审计）。
  - 不调用 `markAgentLoopRequest`（保持非 agent-loop 语义：不进 token-meter/重试/telemetry 的主请求路径）。
  - `purpose` 省略（封闭 union 只有 compaction/session-title，无法新增值，源码确认）。
- 限流：全局 `max_concurrent_requests: 1` 信号量 + 失败退避（指数 + 抖动）；并发受同一 API key 配额约束。
- 结果解析：要求 LLM 输出结构化 JSON（decision + 目标 path + content 等），解析失败 → 记审计失败、不写盘、推进 checkpoint 防死循环。

### 12.6 消息口径与窗口裁剪

- 窗口 = `(checkpoint.seq, session.events 当前 seq]` 内三种 SurfaceEventType 事件。
- `session.events` 是**不可变快照**，读时取最新快照（getter 缓存到下次 append）。
- tool/result 的 message 内容：解析出文本后按 `tool_result_max_bytes` 截断（二进制/超大输出截断为摘要标记）。
- 超过 `max_messages` 时**取窗口尾部**（最近消息优先，丢弃最老）。
- 滚动 digest：每轮提取后由 LLM 在输出中返回会话摘要（或插件本地截断上次摘要 + 本轮窗口的 ~100 token 文本）。

### 12.7 checkpoint 与审计文件（peers/{peer}/sessions/{session-id}.json）

```json
{
  "version": 1,
  "checkpoint": { "seq": 128 },
  "digest": "会话滚动摘要（~100 token）",
  "audit": [
    {
      "at": "2026-08-25T03:00:00.000Z",
      "windowSeq": [109, 128],
      "grepHits": ["preferences/tools.md: use pnpm"],
      "route": { "provider": "huoshan", "model": "deepseek-v4-flash" },
      "maxTokens": 1024,
      "decision": "update",
      "path": "preferences/tools.md",
      "seq": 129
    }
  ]
}
```

- checkpoint 推进 = 提取输入的最后 seq；审计可复现：窗口内容可从日志按 seq 重建。
- 全部经 MutationQueue + writeFileAtomic（tmp+rename），与 Phase 1 工具同一队列。

### 12.8 会话生命周期与并发安全

- `session/disposed`：abort 在途 extraction job（`ctx.jobs` 取消）；dsh-session 有该事件（session-title 先例同款）。
- HMR 重载：effect 内注册的监听与 job 随 fiber unwind；MutationQueue 状态需幂等（checkpoint 已落盘，重启后从 checkpoint 补差）。
- 跨重启：DSH resume 后日志完整 → 提取器从 checkpoint seq 补差距，不丢不重。
- 与 Phase 1 工具并发：全部写操作走同一 MutationQueue。

### 12.9 测试策略

- 纯函数：触发判定（门槛/防抖/计数）、窗口裁剪（尾部截断、tool_result_max_bytes）、checkpoint 推进、审计渲染、digest 截断、decision 解析（含失败）。
- 集成（Loader boot）：注册触发监听 + mock `llm/stream`（keyless snapshot 风格）→ 断言一次提取后文件/索引/checkpoint/审计一致。
- 真实回归：GUI 会话观察触发次数（对照 v7-6 的 flush 实测项）。

---

## 13. Phase 2 实现记录（2026-08-25）

### 13.1 新增模块（均含纯函数测试；总测试 41 → 85）

| 模块 | 职责 |
|---|---|
| `src/extract/window.ts` | 消息口径（三种 SurfaceEventType）、窗口裁剪（seq 边界 + 尾部截断）、tool_result_max_bytes 字节级截断（UTF-8 边界不劈字符）、事件渲染 |
| `src/extract/triggers.ts` | 触发判定纯函数：窗口计数、turn 门槛+防抖、idle |
| `src/extract/decision.ts` | LLM JSON 输出解析（create/merge/update/skip，容忍 code fence 与散文，平衡括号提取） |
| `src/extract/digest.ts` | 滚动 digest（~100 token，bytes/3 估算，渐进收缩） |
| `src/extract/checkpoint.ts` | checkpoint+审计文档（version/checkpoint.seq/digest/audit，最多 50 条审计，宽容解析） |
| `src/extract/prompt.ts` | 提取指令模板（system + user 三节：digest/窗口/grep 命中） |
| `src/extract/index.ts` | 触发监听（session/event、agent/turn-stopping、session/flush、session/disposed）+ 空闲定时器 + fire-and-forget 执行器 `extractOnce`（导出，结构性 ExtractionSessionLike 便于测试） |

- `MemoryStore` 新增：`sessionCheckpointPath`（sessionId 约束防路径逃逸）、`readSessionCheckpoint`、`writeSessionCheckpoint`（队列内原子写）。
- `config.ts` 新增 `extraction` 命名空间（18 键，默认值照 12.2/设计文档 第九章）。
- 插件入口 `apply()` 接线 `applyExtraction`。

### 13.2 实现偏差（对 12 规格的调整）

1. **fire-and-forget 替代 ctx.jobs**：`JobKindMap` 是封闭 union（仅 `bash`/`subagent`，dsh-jobs 源码确认），自定义 kind 编译不过；v7-1 明示 fire-and-forget 亦可。实现用自身 AbortController + `session/disposed` 取消，事件内不 await（serial turn-stopping 约束不变）。
2. **`extractOnce` 导出为测试缝**：参数用结构性 `ExtractionSessionLike`（`header/events/requestHeader()`），真实 Session 结构兼容；集成测试用 stub session + mock `llm/stream`（`ctx.on('llm/stream', ...)` 注册，参照 dsh-session-checkpoint-policy 的瀑布注册方式），无需起真实 agent。
3. **模型路由**：`config.extraction.llm` 优先；否则 `session.requestHeader()?.config`（会话当前模型，含 provider/model）；两者皆缺 → 记 `no-route` 审计并推进 checkpoint，不阻塞。
4. **失败处理**：LLM/解析/应用失败均记审计（note）并**推进 checkpoint**（防无限重试；设计文档 第八章 明示）；审计可复现（窗口 seq + 日志）。
5. **LLM 流收集**：用 `BlockAssembler`（dsh-llm 官方装配器，session-title-llm 同款）而非手工拼 chunk；finish 为 aborted/error 时抛错。


6. **create 不覆盖已存在记忆（实测发现，2026-08-25）**：隐式 create 之前无条件 writeNewMemory，若目标文件已存在（先显式记住、后隐式提取到同一条）会整文件覆盖、丢失显式内容。现改为：fileExists 时降级为 merge（appendCurrent），否则才新建。applyDecision 已导出供测试。
7. **appendCurrent 去重（实测发现，2026-08-25）**：显式 remember 与隐式提取先后记到同一事实时会产生完全相同的重复子弹。现 append 前按行去重（已在 Current 的行跳过，全重复则零写入）。

8. **parse-error 健壮性（Phase 2.1，2026-08-25）**：live 实测 13 次真实调用中 7 次 parse-error（6 次纯散文无 `{` + 1 次括号不平衡）。三层修复：(a) 提示词硬化——新增 STRICT OUTPUT RULES（整个回复必须恰好一个 JSON 对象、禁散文/围栏/尾随句点、半角括号与引号），schema 行给出 category 枚举；(b) 解析器容错——全角 `｛｝＂` 归一化 + 括号不平衡时按 `"key": "value"` 对重建 JSON（截断在闭括号前的内容可救回）；(c) 有界 repair 重试——首次解析失败时用失败回答（非重发窗口）再做一次 LLM 调用转 JSON，仍失败则照旧记 parse-error 并推进 checkpoint（防无限循环）。新增配置 `extraction.parseRetry: boolean`（默认 true，可关）。审计对挽回的运行记 `note: parse-error-recovered`。

9. **提取窗口排除系统注入消息（Phase 2.2，2026-08-25）**：live 复测发现首次提取窗口把系统注入的 user 消息当普通对话喂给 LLM（run1 五条消息中三条是 runtime-context / skill-catalog / memory-catalog，占 5,236 窗口 tokens 的 ~99%），既浪费 token 又把系统提示当记忆候选。修复：`selectWindow` 对 `user/message` 采用 source 白名单——仅保留 `source.kind === 'user'`（真实用户输入），其余注入 kind（plugin/skill-catalog/memory-catalog/agent-instructions/goal，经 3 个会话实测确认）一律排除；assistant/message 与 tool/result 无 source.kind、全部保留。白名单对未知的新注入种类自动免疫。量化：a80a8834 run1 窗口 5,236 → 10 tokens，4 次运行窗口合计 9,535 → 4,296 tokens（降 55%）。注意：`state.pending` 触发计数仍统计全部 surface 事件（含注入），仅窗口内容过滤，避免改动触发语义。

10. **运行指标记录（Phase 2.2，2026-08-25）**：为观测阶段加真实 usage 记录。(a) `collectStream` 现返回 `{text, usage}`（`BlockAssembler.usage` 提供 provider 真实 `inputTokens/outputTokens/cacheRead/cacheWrite`）；(b) 每次运行累积 `llmCalls`（1，或 repair 触发时 2）与 token 数，usage 缺失时回退 bytes/3 估算（`digestApproxTokens`）；(c) 审计条目新增 `llmCalls/inputTokens/outputTokens/cacheReadTokens?/cacheWriteTokens?/durationMs`；(d) 新增 peer 级滚动日志 `peers/{peer}/sessions/extraction.log`（JSONL，一行一次运行：at/session/win/llmCalls/tokens/ms/outcome/decision/path/note/route，封顶 5000 行）；(e) 每次运行 `ctx.logger.info` 一行摘要。`auditLog: false` 时跳过审计条目与 summary log，但 checkpoint seq 仍推进（功能必需）。单测 41 → 76 全绿（boot 测试 mock 发真实 usage chunk 并断言审计+日志字段）。

11. **maxConcurrentRequests 未接线（代码审查发现，2026-08-25）**：`extraction.maxConcurrentRequests`（默认 1）只在 config.ts 定义/解析，提取调度从未读取——实际并发闸门只有「每会话 `state.inFlight`」。即**不同会话之间可同时触发提取、并发调用 LLM**（实测 f680b432 与 a80a8834 曾几乎同时运行）。单会话场景无影响；多会话活跃时如需全局压到 1，需在调度层加全局闸门（如模块级 in-flight 计数 + 队列）。留待观测期评估是否接线。

12. **关闭 turn/flush 触发（方案 C，2026-08-25）**：观测数据推翻早期「成本可忽略」结论——真实 usage 显示每次提取**输出 800~1400 tokens**（非早期估算 25~55；create 决策带内容 + repair 失败调用的散文输出都计入），6 次运行共 ~24k tokens。turn/flush 触发器（minTurnExtract=5 + 30s 防抖）把调用频率推到纯窗口触发的 ~4 倍，而正常聊天大部分运行是 skip（a80a8834 曾 3/3 skip）→ **skip 的 LLM 调用是纯浪费**。用户决策：**关闭轮次边界与 flush 触发**（方案 C），保留窗口触发（windowTurns=20）与空闲触发（30min idle）作兜底——用户对记忆及时性要求不高，「没聊到 20 条也有 30min 兜底」。实现方式：**实现代码全部保留**，仅用配置开关禁用——`extraction.turnStoppingTrigger: false` + `extraction.flushTrigger: false`（默认 true）。顺带修复 `turnStoppingTrigger` 此前**未接线**的缺陷：turn-stopping 监听器补上 `if (!ext.turnStoppingTrigger) return`（flush 监听器本就检查 `ext.flushTrigger`）。重新启用 = 配置改回 true（或删掉两行回默认），无需改代码。相关触发函数（shouldExtractTurn 等）与监听器保留待评估。

13. **跨 Peer 共享（Phase 3，2026-08-26）**：实现「方案 B 逻辑映射」的只读单向共享——任一 peer 的会话可读另一 peer 的记忆。配置 `sharing.enabled: true` + `sharing.mounts`（name/peer/subpath/readonly）。机制：(a) `MemoryStore.resolve` 对 `shared/<name>/...` 路径按挂载声明重定向到目标 peer 的 memories 根（仍经 `containWithin` 硬边界，`..` 逃逸/未知 mount/自访问均拒绝），`readonly: true` 时写路径（writeNewMemory/appendCurrent/updateCurrent/softDelete 经 `resolve(..., {write:true})`）抛 `MemoryPathError`；(b) `search_memory` 扩展覆盖共享挂载（返回 `shared/<name>/...` 前缀路径），本地+共享合并搜索；(c) L0 目录注入新增 `## shared` 提示节（~30 token，只声明挂载与访问方式、**不预载共享索引**），并对「空索引不注入」规则做窄例外——共享开启时即使本地索引为空也注入共享提示（否则共享区完全不可达）；(d) 共享不进 catalog 条目（source.entries 只含本地），digest 仍按本地计算，来源隔离保持（设计 §2.8）。配置校验：mount name 必须单段、peer 必须纯目录名、subpath 不得 `..` 逃逸。单测 41 → 82 全绿。profile 已配 `shared/dsh-test/ → dsh-test-72572e8b`。

14. **被抛弃短会话的记忆永不提取（已知限制，2026-08-26）**：提取只由「20 条窗口 / 30min 空闲 / turn+flush（已关）」触发，而 `pending` 计数与 idle 定时器都是**内存态**。任何「<20 条 + <30min + 之后不再激活」的会话——dsh 进程退出 / GUI 关闭会话（`session/disposed` 会主动 `idleDispose?.()` 取消定时器并删状态）/ 永不重新打开——其记忆永久留在会话日志中；checkpoint 补差距的前提是会话重新激活，对永不激活的会话无效。**用户确认暂不改**（重要内容走显式 remember）。候选修补（按成本排序）：A 保持现状；B 关闭时补提（disposed 且 pending>=5 立即提取，覆盖 GUI 关会话，每次 +1 次 LLM 调用）；C 积压时缩短 idle 定时（pending>0 时 5min）；D 激活时补提（重开会话且 checkpoint 落后立即提取，不覆盖永不打开）；E 全局清扫（全覆盖但复杂/开销大/会卷入旧 harness 大会话）。

15. **L0 目录瘦身 + maxTokens 接线（2026-08-26）**：实测新会话注入目录 ~1,634 tokens，超设计上限 1,200 且 `index.maxTokens` **从未接线**（catalog 渲染全量注入，死配置），且会随记忆增长无限膨胀。修复（方案 C）：(a) `summaryOf` 默认摘要上限 200 → 100 字符（未来条目 ~35 tokens/条，此前 ~70）；(b) 注入层接线 `capCatalogEntries(entries, index.maxTokens)`——按预算保留最新条目、丢弃最旧（**仅注入层**，`_index.md` 文件与 search_memory 不受影响，符合设计「mtime 倒序 + 条目上限即可」的有界 L0 窗口，旧记忆退出版可见层但可搜索）；(c) 一次性重建现有 dsh-test 索引（parseMemoryFile 取 Current 正文 + 100 字符摘要），14 条全量可见，目录 ~1,634 → ~1,047 tokens。单测 82 → 84 全绿（capCatalogEntries 2 例 + summaryOf 默认 100 断言）。

16. **提取失败静默跳过（llm-error 不重试、checkpoint 照推；2026-08-26 记录，暂不改）**：任何一次提取 LLM 调用失败（`llm-error`，成因不限于并发——网络抖动 / 429 限流 / key 过期 / 额度用尽 / provider 抽风）都会记一条审计 + extraction.log 后**直接推进 checkpoint 并清零 pending、不重试**（源码确认：`extractOnce` 的 catch → `recordRun(rc, 'llm-error: ...')` → return；`recordRun` 无条件把 `checkpoint.seq` 推到 `windowEnd`）。后果：该窗口（最多 `maxMessages`=20 条消息）的候选记忆**永久跳过**——不是延迟，是放弃；且**无任何主动通知**，只有查 `peers/{peer}/sessions/extraction.log` 或会话审计才看得到。注意 parse-error 有 repair 重试（偏差 8），但 llm-error **没有**。内容本身不丢（仍在会话日志，重开可见），丢的只是"未进入长期记忆"；单次失败影响 ~20 条，但网络差/key 过期等持续期间会静默累积空洞。**用户判断 llm-error 概率高于同路径 create 竞态（偏差 17），更值得处理；但先记录、暂不改**。候选修补：A 失败不推进 checkpoint（下次触发自然重覆盖；需加保护：窗口超 `maxMessages`×2 仍失败时照推，防窗口无限涨）；B 失败重试一次（仿 parse repair，隔几秒再调一次，仍失败照旧）；C 保持现状（尽力而为，重要内容走显式 remember）。

17. **create 检查-再写竞态（同 peer 并发提取同路径可覆盖；2026-08-26 记录，暂不改）**：`applyDecision` 的 create 分支是**检查与写入分离**的——`store.fileExists(path)`（裸 stat，不在队列）与 `store.writeNewMemory`（队列内、**无条件整文件覆盖**）是两个独立队列操作。同 peer 两个会话几乎同时触发提取、且 LLM 都选了同一目标路径时：A、B 都先看到"文件不存在"→ B 先写、A 后写把 B 刚建的文件**整体覆盖** → B 提取的内容静默丢失，索引仍指向幸存文件、无任何报错。偏差 6（fileExists→merge 降级）+ 偏差 7（行去重）只覆盖了"后写者看到文件已存在"的串行情形，覆盖不了这个并发窗口。触发条件苛刻（同 cwd ≥2 并发会话 + 同时触发 + 路径撞车），当前窗口(20)+空闲(30min)触发下概率很低；若重开 turn/flush 触发（频率 ×4）概率上升。候选修补：A 把"存在则 merge/不存在则建"合并进**同一个队列任务**（原子 create，~10 行，修正确性问题）；B 接线 `extraction.maxConcurrentRequests` 全局闸门（~30 行，成本平滑 + 限流保护，偏差 11 同源）；C 保持现状。**用户暂不改**。

18. **方案 C 后提取完全停摆（timer 未 inject；2026-08-26 定位并修复）**：8-26 一整天零提取——extraction.log 停更、无任何新 checkpoint，连活跃的 dsh-test 会话（f680b432，1828 条 surface 事件）都没触发；用户顺带发现 sync peer 从无记忆。**根因**：`resetIdle` 调用 `ctx.timeout`（内部 `ctx.get("timer")`），但插件 `inject = ['tools','agents','llm']` **从未声明 'timer'** → Cordis 抛 `cannot get property "timer" without inject` → `session/event` 监听器在每个 surface 事件上抛错（被 dsh-session 的 `invokeContainedSessionObservers` 捕获、仅写 warn 日志，无任何提取痕迹）→ `maybeSchedule` 永不执行。**为什么 8-25 正常**：当时 turn/flush 触发开着，这两条路径**不经 `resetIdle`**、直接 maybeSchedule，提取照跑；8-25 晚方案 C 关闭 turn/flush 后，只剩 window + idle 两条路、**都走 `resetIdle`** → 全部抛错 → 提取彻底停摆。**同类历史**：与 §13.4 结论 6 的 `cannot get property "llm" without inject` 同一类 bug（注入清单不完整）——当时补了 llm 漏了 timer；且现有测试全部直接调 `extractOnce`、从未走监听器路径，故漏网。**修复**：(a) `src/index.ts` inject 增加 `'timer'`（插件现要求宿主提供 timer 服务，缺则启动 fail-fast）；(b) `tests/boot.test.ts` 的 cordis.yml 补挂 `@deepseek-ai/cordis-plugin-timer`；(c) 新增回归测试 `session/event window trigger fires extraction through the plugin listener (timer inject)`——boot 后经 `ctx.emit('session/event', ...)` 发 20 条 surface 事件，断言监听器路径完整触发提取并写 checkpoint（seq=19、audit=skip）。测试 84 → 85 全绿。**生效需重启 dsh 加载新 lib**（web profile 的 timer 由 dsh CLI profile-boot 自动挂载，`if (ctx.get("timer") === void 0) await ctx.loader.create(...)`，已确认可用）。**附带确认**：sync peer 从未提取的双层原因——(1) 8-17~8-23 旧会话都在插件挂载（8-25）之前，pending 为内存态不回溯；(2) 8-26 起提取整体停摆（本偏差），f6f88db0（273 surface）等活跃会话也触发不了。修复后 sync 旧会话仍不会补提（同偏差 14），只有新会话会正常提取。

### 13.3 集成测试（tests/extract-boot.test.ts）

- REAL Loader boot（dsh-llm + timer + 插件）+ mock `llm/stream` 返回 create 决策 → 断言记忆文件、索引、checkpoint（seq=窗口末、审计含 route/decision）。
- 同 boot + 非法 LLM 输出 → 断言 parse-error 审计 + checkpoint 推进 + 无记忆写入。

### 13.4 实测记录（挂 live profile，2026-08-25）

**挂载与测试配置**：web profile 经 cordis.patch.yml 挂载；测试期配 `extraction.mode: incremental` + `windowTurns: 3`（快速触发便于观测），其余默认；会话模型 huoshan/deepseek-v4-flash，`maxTokens: 1024`。

**运行统计**（ground truth：各会话 `peers/{peer}/sessions/{id}.json` 审计，字段 `at/windowSeq/grepHits/route/maxTokens/decision/seq/path`）：

| 会话 | 运行数 | 结果明细 |
|---|---|---|
| f680b432（旧 harness 大会话，seq≈49 万） | 14 | 4 llm-error + 3 success（2 create + 1 skip）+ 7 parse-error |
| b6d29cde（新 GUI 会话） | 3 | 3 success（skip + 2 create） |
| 169a2480 / fae559d2 / 1c6f6cf9 | 4 | 全 llm-error |

合计 21 次运行：**8 次 llm-error（inject 修复前，0 LLM 成本）+ 13 次真实 LLM 调用**（6 success：4 create + 2 skip；**7 parse-error ≈ 54%**，其中 6 次 `no JSON object` + 1 次 `unbalanced JSON object`）。

**关键结论**

1. **触发行为正常**：windowTurns=3 + turn 边界（30s 防抖）+ minTurnExtract=5 下，活跃会话约每 1–2 分钟触发一次；窗口 seq 连续推进（checkpoint.seq == 窗口末），无重复窗口、无回退。
2. **LLM 成本可忽略**：13 次调用 ≈ 3 万+ 输入 token + ~1k 输出 token，按 flash 价 ≈ 0.03–0.05 元；无逐次 usage 落盘（提取不经会话日志，balance-monitor 只跟踪官方通道），故只能按窗口重建估算。
3. **parse-error 是最大质量问题**：全部 7 次发生在 f680b432（窗口含大段代码 fence / 长 tool 结果的窗口上 LLM 输出非纯 JSON）。约一半输入 token 白费。→ 列为 **Phase 2.1**（提示词强 JSON 约束 + 非 JSON 输出二次解析/重试上限）。
4. **审计完整可复现**：每条含窗口范围、grep 命中、路由、maxTokens、决策、推进后 seq；grepHits 在约半数运行非空，create 落盘前确实比对了现有记忆。
5. **实测发现两个真实 bug**（→ §13.2 偏差 6/7）：create 覆盖已存在记忆、appendCurrent 产生重复子弹；均已修复并补测试，总测试 41 → 68 全绿。
6. **inject 缺失 bug**：挂载初期 8 次运行全为 `llm-error: cannot get property "llm" without inject`（0 成本）；修复 = 插件 inject 增加 'llm'。
7. **写盘验证通过**：隐式通道共写入 4 条记忆（entities/alan-从事量化研究、preferences/称呼用户为-alan、events/fixed-duplicate-extraction-bug、events/implicit-extraction-cost-audit），文件/索引/checkpoint 均正确；与显式 remember 撞车的重复问题由偏差 6/7 解决。
8. **成本收益判断**：绝对成本可忽略，但『每 1–2 分钟一次后台 LLM 调用 + 一半解析失败』在用户感知上偏浪费 → **2026-08-25 用户决定 extraction.mode: 'off' 关闭隐式提取**；配置文件中已注释全部 extraction 参数并附默认值，随时可重新启用。Phase 1 显式通道与 L0 注入不受影响。

**遗留（Phase 2.1）**

- ~~parse-error 54% 的根治~~ → **已完成（2026-08-25，见 §13.2 偏差 8）**：提示词硬化 + 全角/断括号容错 + 有界 repair 重试（`extraction.parseRetry`，默认开）；修复后单测 41 → 73 全绿。重新启用 `mode: incremental` 后应复测真实 parse-error 率（期望 ≪ 54%）。
- ~~windowTurns 默认 20 的合理性~~ → **复测完成（2026-08-25，见 §13.5）**：默认 20 下触发频率正常（turn 边界主导，无快速实测时的每 1–2 分钟狂触发）。
- PTC 工具呈现适配（§10.1 已知问题，未动）。


### 13.5 Phase 2.1 复测记录（2026-08-25）

**复测配置**：`extraction.mode: incremental` + `windowTurns: 20`（默认），其余默认；会话模型 huoshan/deepseek-v4-flash。

> 操作插曲：首次重启前 profile 里 `mode` 实际仍为 `'off'`（只取消了 windowTurns 注释），发 20 条无任何触发；改为 `'incremental'` 并重启后才生效。教训：改配置后应核对 `mode` 本体，而非只看子参数。

**运行统计**（ground truth：`peers/{peer}/sessions/{id}.json` 审计）：

| 会话 | 运行 | 结果 | 解析 |
|---|---|---|---|
| a80a8834（新测试 GUI 会话，20+ 条） | 3 | 3 skip | 3/3 首次成功 |
| 1c6f6cf9（旧 harness 会话） | 1 | 1 create（events/dsh-desktop-v0.1.1-released） | 1/1 首次成功 |

合计 4 次真实 LLM 调用：**4/4 解析成功，parse-error 率 54% → 0%**。

**关键结论**

1. **提示词硬化单独起效**：4 次全部首次解析成功，审计无任何 `parse-error-recovered` 标记——STRICT OUTPUT RULES 直接压住了散文输出；有界 repair 重试未触发，保留为安全网。
2. **隐式通道真实产出**：`events/dsh-desktop-v0.1.1-released---no-open-flag-added.md`（2026-08-25: released dsh-desktop v0.1.1 (GitHub repo alanzhao)），文件骨架（标题/Current/History/Related）与 `_index.md`（Total: 5）均正确。
3. **去重正常**：测试会话 3 次运行 grep 命中 2/7/5 条；此前已记过的事实（fixed-duplicate-extraction-bug、cost-audit）全部 skip，无重复落盘。
4. **触发行为符合预期**：运行间隔 ~35s = turn 边界触发（minTurnExtract=5 + 30s 防抖），非 windowTurns 窗口触发；checkpoint seq 7 → 38 → 806 → 1362 连续推进，无回退。
5. **`maxMessages=20` 截断生效**：窗口 seq 跨度可达 600+ 事件，但实际仅喂 20 条 surface 消息给 LLM，成本可控。

**结论**：Phase 2.1 修复后提取「解析零失败 + 去重不重复 + 触发频率受默认参数约束」，当前配置（`mode: incremental` + `windowTurns: 20`）保持启用。

### 13.6 Phase 2.2 记录（2026-08-25）：提取窗口排除系统注入消息

**发现**（复测 token 审计时）：首次提取窗口把系统注入的 user 消息当普通对话喂给 LLM。a80a8834 run1（win[7..38]）5 条消息中 3 条是注入块——seq=8 `Current runtime context`（source.kind=plugin）、seq=9 技能目录（skill-catalog）、seq=10 memory catalog（memory-catalog）——合计 ~5,226 tokens，占该窗口 5,236 tokens 的 ~99%。这些既不是对话内容、也不可能成为记忆候选，纯属 token 浪费（该次测试 12,388 输入 tokens 中 ~40% 花在注入块上）。

**根因**：提取窗口按 surface 类型（user/message、assistant/message、tool/result）全量选取，不区分消息来源；而 DSH 把大量系统提示以 user/message 形式注入会话日志（经 3 个会话实测，注入 kind 含 plugin/skill-catalog/memory-catalog/agent-instructions/goal）。

**修复**（见 §13.2 偏差 9）：`selectWindow` 对 `user/message` 用 source 白名单——仅保留 `source.kind === 'user'`，注入类全部排除；assistant/message 与 tool/result 无 source.kind，全部保留。白名单对未知新注入种类自动免疫（无需维护黑名单）。`state.pending` 触发计数不改（仍统计全部 surface 事件），仅窗口内容过滤，避免改动触发语义。

**量化**（窗口文本 bytes/3 估算）：

| 运行 | 过滤前 msgs/tokens | 过滤后 msgs/tokens |
|---|---|---|
| a80a8834 run1 | 5 / 5,236 | 2 / 10 |
| a80a8834 run2 | 19 / 1,093 | 19 / 1,093（无注入） |
| a80a8834 run3 | 20 / 337 | 20 / 337（无注入） |
| 1c6f6cf9 create | 20 / 2,869 | 20 / 2,856 |
| **合计** | **9,535** | **4,296（-55%）** |

单测 41 → 75 全绿（新增注入排除、isConversationEvent 两个用例；boot 测试 stub 补真实 `source.kind: user`）；§13.7 指标日志再 +1 → 76。

**遗留**：`state.pending` 计数含注入消息，理论上首窗口触发会略早于纯对话计数；实际影响极小（每会话仅 3-4 条注入），暂不改。

### 13.7 运行指标与日志（Phase 2.2，2026-08-25）

**动机**：观测阶段需要可排查的量化数据——每次提取真实 LLM 调用次数、token 消耗、成功率、耗时；此前只能靠窗口重建估算。

**真实 usage 采集**

- `collectStream` 现返回 `{text, usage}`，`BlockAssembler.usage` 提供 provider 真实 `inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens`。
- usage 缺失（如流错误）时回退 bytes/3 估算（`digestApproxTokens`），保证每次运行都有可辩护的数值。
- 每次运行累积 `llmCalls`（1；repair 触发时 2；no-route 为 0）。

**记录位置（三层）**

1. **会话审计**（`peers/{peer}/sessions/{id}.json`）：每条运行新增 `llmCalls / inputTokens / outputTokens / cacheReadTokens? / cacheWriteTokens? / durationMs`。
2. **peer 级汇总日志**（`peers/{peer}/sessions/extraction.log`）：JSONL，一行一次运行：

```json
{"at":"...","session":"...","win":[7,38],"llmCalls":1,"inputTokens":1234,"outputTokens":42,"cacheReadTokens":0,"cacheWriteTokens":0,"durationMs":812,"outcome":"create","decision":"create","path":"...","note":null,"route":{"provider":"huoshan","model":"deepseek-v4-flash"}}
```

   - `outcome` = 成功决策 kind / `parse-error` / `parse-error-recovered` / `llm-error` / `apply-error` / `no-route`。
   - **封顶 5000 行**（`MAX_LOG_LINES`）：超限从最旧行裁剪，永远保留最近 5000 次运行；旧运行由各自会话审计（每会话 50 条）兜底。
   - **2026-08-25 用户决策**：保持 5000 封顶，不改为按天轮转（需 ~125h 活跃对话才触顶；若需全量保留可调大或轮转）。
   - 每次追加为读改写 O(n)（5000 行约 1MB），当前触发频率下可接受。
3. **dsh 日志**：每次运行 `ctx.logger.info` 一行（`extraction create calls=1 in=1234 out=42 ms=812 win[7..38]`）。

**审计开关**：`extraction.auditLog: false`（默认 true）跳过审计条目与 summary log，但 checkpoint seq 仍推进（功能必需，防重复提取）。

**查看示例**：

```bash
# 成功率分布
jq -r '.outcome' ~/.agent-memory/peers/dsh-test-72572e8b/sessions/extraction.log | sort | uniq -c
# 总 token 消耗
jq -s '[.[] | .inputTokens + .outputTokens] | add' ~/.agent-memory/peers/dsh-test-72572e8b/sessions/extraction.log
# 单个会话的运行
jq 'select(.session | contains("a80a8834"))' ~/.agent-memory/peers/dsh-test-72572e8b/sessions/extraction.log
```

**测试**：单测 41 → 76 全绿（boot 测试 mock 发真实 usage chunk 并断言审计字段 + extraction.log 内容；新增 `appendExtractionLog` 单测）。
---

## 14. 改名记录（2026-08-26）：dsh-memory-light → dsh-memory-lite

**原因**：项目名拼写有误，本意应为 **memory-lite**（轻量记忆），原实现误拼为 memory-light。经完整影响面审计后确认**安全**，于 2026-08-26 执行改名。

**改动清单**（全部同步完成）：

| 位置 | 改动 |
|---|---|
| 目录 | `/Users/alan/code/dsh-test/dsh-memory-light` → `dsh-memory-lite` |
| 项目 package.json | `name`: `dsh-memory-light` → `dsh-memory-lite` |
| 项目 package-lock.json | 同步（两个 name 字段） |
| 项目 cordis.patch.yml | 行 `id: memory-light` → `memory-lite`、`name` → `dsh-memory-lite` |
| src/index.ts | `export const name` → `'dsh-memory-lite'` |
| src/extract/index.ts | 提取 LLM 请求的 `plugin: 'dsh-memory-lite'` 标记 |
| src/peer.ts 等 27 个文件 | `@module` 注释、错误前缀等文字引用 |
| tests/*.ts | boot 行的 `id: memory-lite`、app 名 |
| README.md | 标题、安装/依赖/配置示例 |
| web profile package.json | dependency `"dsh-memory-lite": "link:.../dsh-memory-lite"` + bundles 列表 |
| web profile cordis.patch.yml | `id: memory-lite` / `name: dsh-memory-lite`（**与项目内 patch 的 id 同步改，保证 override 匹配**） |
| web profile node_modules | pnpm install 重建符号链接 + 锁文件 |

**审计确认的零影响项**：
- 记忆数据 `~/.agent-memory/peers/*`：peer 由会话 cwd 派生（sha1），与插件名无关 → 无需迁移
- checkpoint / audit / extraction.log：只存 session id 与 outcome，不含插件名
- 注入消息 source kind（`memory-catalog`）与会话历史：固定值，不受影响
- harness / dsh CLI / 其他 profile 插件：均不引用本插件名
- `~/.dsh/storages/session_projcache.json` 中的旧名仅为历史会话目标文本（数据内容，非配置）

**生效要求**：运行中的 dsh 服务器不受影响（代码已加载在内存）；**下次重启时** profile 需已同步（本次已完成），否则依赖解析失败会导致插件不加载。重启后插件以 `dsh-memory-lite` 名称加载，功能与数据不变。

**说明**：本文档 §11-§13 的历史记录（偏差、实测、复测）均发生于旧名时期，其中的 `dsh-memory-light` 字样按历史原样保留，不再逐一改写。


---

## 15. 状态指示器（Phase 5，2026-08-26；位置 2026-08-26 从侧边栏 footer 移至会话标题栏）

> 设计确认后实现（见对话记录）：三色（绿/红/灰）、无琥珀、无数据归绿、"红到下次成功"、一行 UI（左 memory-lite 文字 + 右圆点）、位置可配。
>
> **位置决策（B 方案）**：初版放 `sidebar.footer.action`（与余额卡水平并排），用户截图后判定"太丑"且该槽是水平 flex（`.footerActions { display: flex }`），无法做到上下堆叠；改壳不可行（用户运行 npm 发布版 dsh）。最终移到 `conversation.session.header.utilities`（会话标题栏最右端、内置 "Session log" 下载胶囊左侧，两个 32px 小胶囊并排，视觉密度低不显挤）。配置键随之从 `ui.sidebarOrder` 更名 `ui.headerOrder`。

### 15.1 结构（最小化设计）

```
后端（新增 ~40 行）：
  src/status.ts        createStatusTracker() → { reportRun, reportError, snapshot }
                       单个 "last" 事件对象（无状态机、无文件读取）
  src/extract/index.ts recordRun 末尾 +1 行 reportRun；runExtraction catch +1 行 reportError
  src/index.ts         inject 增 'connection'；rpc.handle('/memory-status', authority: 'loopback')
客户端（lib/client.js，手写 classic-script ~130 行，零构建）：
  ModuleLoader.load → apply(ctx, config) 读 config.ui.headerOrder → slots.register({ order })
  注册槽：conversation.session.header.utilities（会话标题栏右端，与内置 "Session log" 下载胶囊同排）
  StatusDot：10s 轮询 rpc.call('/memory-status','snapshot') + visibilitychange 刷新
             轮询失败 = 插件不可达 → 红
             三色圆点 + title tooltip（最近运行/错误详情）；32px 圆角胶囊样式对齐 Session log 按钮
package.json：dsh.client（inject runtime/connection/locale, platform web）+ exports["./client"]
```

### 15.2 状态语义（用户锁定）

| 色 | 条件 |
|---|---|
| 🟢 绿 | mode incremental 且最近事件 ok（create/merge/update/skip/parse-error-recovered）；**无数据=绿** |
| 🔴 红 | 最近事件失败（llm-error/未恢复 parse-error/apply-error/no-route/意外异常）**或** 轮询失败（通道不可达=插件挂载失败/崩溃） |
| ⚪ 灰 | mode off / explicit_only（提取未启用） |

- **回绿唯一途径**：下一次提取运行成功（无时间魔法，用户确认）。
- **意外异常上报**：runExtraction 的 catch（此前 timer 缺失那类静默失败）现在同时写 logger + tracker → 指示灯变红，静默失败可视化。

### 15.3 配置

- `ui.headerOrder: number`（默认 -1。`conversation.session.header.utilities` 槽为 list 型且**水平排列**（`.headerUtilities { display: flex }`），故 order 控制**左右**位置——-1 在 "Session log" 下载胶囊（order=0）左侧，1 在右侧。客户端 apply 直接读行配置（已验证 client runner 把行 config 传给浏览器半区 apply），**无需 RPC 传配置**。
- 校验：整数，非整数 fail loud。

### 15.4 测试

- 后端单测 7 例（无数据=绿、成功=绿、失败=红、下次成功回绿、parse-error-recovered=ok、reportError=红、off/explicit_only=灰）。
- config 单测 1 例（默认 -1 / 显式值 / 非法值）。
- boot 集成 1 例：fake-connection fixture（tests/fixtures/fake-connection.ts，测试双）提供最小 connection 服务（rpc.handle 记录 handler），挂载插件后直接调用 /memory-status handler 断言 snapshot。
- 测试 85 → 94 全绿。
- **注意**：插件 inject 新增 'connection' 后，boot 测试须挂 fake-connection（真实 profile 由 dsh-api-gateway/dsh-client-connection 提供）。另补 devDep @deepseek-ai/cordis-plugin-timer（此前靠传递解析，npm install 重解析后暴露，已显式声明）。

### 15.5 验证与生效

- 构建/测试通过；lib/client.js 语法检查通过。
- 生效：重启 dsh 后浏览器半区随 dsh.client 清单加载；profile 已加 `ui.headerOrder` 注释示例。
- **人工验收（2026-08-27，用户重启后确认）**：✅ 会话标题栏最右端、"Session log" 胶囊左侧出现 memory-lite 小胶囊，用户确认"看样子正常"。三色验证（红/灰）与 `ui.headerOrder` 左右位置调整留待后续需要时复测。


---

## 16. 设置面板方案（方案 A，2026-08-27 规划）

> 目标：不再手改 cordis.patch.yml 调参。通过 harness 官方设置通道提供可视化设置面板；配置落盘 harness settings 文档（~/.dsh/settings.yaml）；包内 cordis.patch.yml 成为默认层；用户 profile 的 cordis.patch.yml 移除 memory-lite 全部内容。
>
> 本节是**动手前规划**（含调研结论与工作量评估），实施记录后续补写。

### 16.1 调研结论（2026-08-27 实查）

参考项目做法：

| 项目 | 设置面板入口 | 配置存储 | 生效方式 |
|---|---|---|---|
| dsh-harbor | `settings.section` 槽（设置面板导航加页） | 只读清单，不编辑 | — |
| dsh-better-sidebar | `settings.section` 槽（Side card 设置页） | **harness 官方 settings 服务 namespace**（`dsh-better-sidebar`），落盘 `~/.dsh/settings.yaml` | **即时生效**（`applies: 'live'` + `scope.watch`） |
| harness 官方（ui-settings-plugins） | `settings.plugin.item` 槽（Plugins → Configurable 标签页卡片） | settings 服务 namespace | 即时生效 |

**环境实证**（用户机器 ~/.dsh/settings.yaml 已存在且在用）：

```yaml
ui-theme: { preference: dark }
locale: { preference: zh }
llm-pi-ai: { providers: {...} }
dsh-better-sidebar:
  tabsEnabled: { git: true }
  defaultWidthPercent: 20
  openByDefault: true
agent-presets: { default: code }
```

→ better-sidebar 的设置面板改动已实时写入该文件；memory-lite 将占用 `dsh-memory-lite:` 段，互不干扰。

**挂载通道实证**：harbor/better-sidebar 的挂载声明在**各自 npm 包内的 cordis.patch.yml**（`dsh.bundle.patch` 层），经 `package.json` 的 `dsh.profile.bundles` 在启动时合并——所以用户 profile 的 cordis.patch.yml 里没有它们的行。memory-lite **包内已有 cordis.patch.yml**（`- insert: - id: memory-lite / name: dsh-memory-lite`）且已在 bundles 里，因此 profile 侧挂载行可以删除。

### 16.2 目标形态

- 设置入口：**设置面板新增 "memory-lite" 页面**（`settings.section` 槽，order 置于 General/Plugins 之后），自绘表单（不依赖官方卡片控件——memory-lite 客户端是手写 classic script，跨包值导入受 client bundle purity gate 限制，且引入 tsdown 构建属于更大的改造）。
- 配置存储：`~/.dsh/settings.yaml` 的 `dsh-memory-lite:` section（settings 服务 namespace）。
- 生效分层：
  - `live` 参数（extraction.* 运行参数、index.maxTokens、defaultPeer、workspacePeers.*、ui.headerOrder）：保存即生效。
  - `restart` 参数（root、sharing.*）：保存写盘 + UI 标注"重启后生效"（settings 服务原生 `applies: 'restart'`）。
- 挂载：删除 profile 的 memory-lite 挂载行 + 配置块；包内 cordis.patch.yml 保留（无 config，纯挂载）。

### 16.3 配置分层模型

```
生效值 = settings.yaml user 层 > 包内 patch base 层 > schema 默认值
```

- **包内 cordis.patch.yml**：纯挂载行（现状已是），不写 config —— 默认值全部由 schema 兜底；如需部署级默认可将来在 patch config 里补。
- **settings.yaml `dsh-memory-lite:` 段**：用户通过设置面板修改的值（迁移自现有 profile 配置）。
- 迁移动作：现有 profile yml 里的 `root / defaultPeer / extraction / sharing / ui` 值先写入 settings.yaml 的 `dsh-memory-lite:` 段，再删 profile 挂载行（一次性重启生效）。

### 16.4 字段分组与控件

**live 生效（保存即用）**

| 字段 | 控件 | 说明 |
|---|---|---|
| extraction.mode | 下拉（incremental/explicit_only/off） | |
| extraction.windowTurns | 数字 | 触发窗口 |
| extraction.idleTimeoutMin | 数字 | 空闲兜底 |
| extraction.maxMessages | 数字 | 单次上限 |
| extraction.toolResultMaxBytes | 数字 | |
| extraction.minTurnExtract | 数字 | |
| extraction.turnDebounceMs | 数字 | |
| extraction.maxConcurrentRequests | 数字 | |
| extraction.includeDigest / dedup / turnStoppingTrigger / flushTrigger / parseRetry / auditLog | 开关 | |
| index.maxTokens | 数字 | |
| ui.headerOrder | 数字 | |
| defaultPeer / workspacePeers.enabled / workspacePeers.cwdFallback | 文本/开关 | |

**restart 生效（保存后重启）**

| 字段 | 控件 | 说明 |
|---|---|---|
| root | 文本 | MemoryStore 构造快照，需重建 store 才 live |
| sharing.enabled | 开关 | 同上 |
| sharing.mounts | 数组（增删行） | 同上 |

### 16.5 动态配置源改造（宿主侧）

现状：`apply()` 里 `resolveConfig(config)` 一次，`MemoryStore` 构造快照 root/sharing，`applyExtraction` 里 `const ext = config.extraction` 快照。

改造：
1. `installSettingsSection(ctx, settingsNamespace('dsh-memory-lite'), Config, entry, hooks)` 接入（官方 helper，entry=当前行配置作 base 层）。
2. hooks.onChange：重新解析动态配置；对 live 参数热更新：
   - extraction 参数 → applyExtraction 内部从"快照 ext"改为"每次读取动态源"（事件回调里读 `source()`；timer 重建）。
   - index.maxTokens / defaultPeer / workspacePeers → 已按需读取处（inject.ts / peer.ts）改为读动态源。
   - root / sharing → 不 live：`applies: 'restart'`，scope.watch 仅更新 UI 状态。
3. apply() 里 `config` 从"固定对象"改为"getter"：`deps.config = () => currentResolved`，所有消费点改函数调用。

### 16.6 客户端设置页（lib/client.js）

- 新增注册：`ctx.slots.inject('settings.section', ...)` 注册 id `memory-lite`、order 靠后（如 100）、label "memory-lite"。
- 页面组件：手写 React（jsx 调用，沿用现有 StatusDot 风格），表单元素用原生 `<input>`/`<select>`/`<button>`。
- 读写：`ctx.settingsScope.bind({ namespace: 'dsh-memory-lite' })` → `getSnapshot()` 渲染当前值、`set()/unset()` 保存。
- `ui.headerOrder` 状态灯改为从 settingsScope 读取（不再只读行配置）。
- 控件清单见 16.4。

### 16.7 实施步骤（顺序）

1. 宿主侧接入 settings：devDep 加 `@deepseek-ai/dsh-settings`；apply() 接入 installSettingsSection + 动态配置源（先不改消费点，仅接入口）。
2. 动态消费点改造：extract/index.ts（快照→getter）、inject.ts、peer.ts。
3. 测试：fake settings 服务（测试双）+ 动态配置生效断言（live 参数改后行为变化）。
4. 客户端设置页：client.js 注册 settings.section + 表单 + settingsScope 读写。
5. 测试：client.test.ts 断言 settings.section 注册；设置页渲染回归。
6. 配置迁移：现有 profile 值写入 ~/.dsh/settings.yaml 的 dsh-memory-lite 段；删 profile 挂载行；更新 profile 注释。
7. 文档：README 配置章节改写（settings 面板优先、yml 仅挂载）；IMPLEMENTATION.md 补实施记录。
8. 验收：重启后设置面板出现 memory-lite 页；改 live 参数即时生效（指示灯/日志佐证）；改 root/sharing 显示"重启生效"且重启后生效。

### 16.8 工作量与风险

- 工作量：宿主侧接入 ~0.5 天；动态配置源改造 ~0.5-1 天；客户端设置页 ~1 天；迁移+测试+文档 ~1 天。合计 **~3 天**。
- 风险：
  - 动态配置源改造面广（extract/index.ts 多处解构），回归风险——用现有 96 测试 + 新增动态断言兜底。
  - 手写 client.js 表单可维护性差——若后续复杂度上升，再评估引入 tsdown 构建（better-sidebar 模式）。
  - settings.yaml 为整个 profile 共享文档，误写风险低（revision 防护），但迁移时注意不要覆盖其他插件段（只动 dsh-memory-lite 键）。
  - `applies: 'restart'` 的 UI 提示需自绘（官方卡片控件不依赖时无现成提示组件）。

### 16.9 实施记录（2026-08-27）

按 §16.7 顺序完成，总计 99 测试全绿（96 → 99）。

**1. 宿主侧 settings 接入（§16.7 步骤 1-2）**

- `package.json` dependencies 加 `@deepseek-ai/dsh-settings@0.1.1-rc.2`；`dsh.client.inject` 加 `@deepseek-ai/dsh-client-ui-settings`（提供浏览器 settingsScope 服务）。
- `src/index.ts` apply：`let live: ResolvedConfig` 可变引用 + `installSettingsSection(ctx, settingsNamespace('dsh-memory-lite'), Config, config, { setSource, onChange })`；onChange 里 `live = { ...resolveConfig(source()), root: live.root, sharing: live.sharing }`（root/sharing 钉在 store 快照，restart 语义）。
- `MemoryDeps.config` 从 `ResolvedConfig` 改为 `() => ResolvedConfig` getter；消费点全部改读 `deps.config()`：5 个 tools、inject.ts（applyMemoryCatalogInjection 签名改 `(ctx, deps, readTool)`）、extract/index.ts（applyExtraction / runExtraction / extractOnce 签名改传 deps，`const ext = config.extraction` 快照改为回调内 `ext().` 动态读；extractOnce 每次运行开始时读一次 config 快照）。
- 行配置（cordis.patch.yml）不再携带 config：base 层为空 `{}`，schema 默认值兜底；settings 文档为 user 覆盖层。

**2. 测试（§16.7 步骤 3、5）**

- 新 `tests/fixtures/fake-settings.ts`：内存版 SettingsProvider（子类实现 load/persist，公开 seed/publishNow/sections）。
- 新 `tests/settings-boot.test.ts` 2 例：
  - settings.update 改 extraction.mode → /memory-status 立即反映（live 生效）；root 编辑不影响 live（restart 钉住）；写入持久化。
  - 行配置为空 + seed 预置 explicit_only → boot 后初始 mode 即 explicit_only（settings 是配置源）。
- `tests/client.test.ts` 更新：inject 断言加 settingsScope；断言两个注册（header utilities + settings.section）；settingsScope.bind 被调用。
- `tests/extract-boot.test.ts`：extractOnce 调用改 deps 形态。

**3. 配置迁移（§16.7 步骤 6）**

- `~/.dsh/settings.yaml` 追加 `dsh-memory-lite:` 段（root/defaultPeer/extraction 非默认/sharing 全量）。
- profile `cordis.patch.yml` memory-lite 行：删除整个 config 块与旧注释，仅保留挂载行 + 指向设置面板的注释。
- **坑**：用 python yaml.safe_dump 重写 settings.yaml 把 `reasoningEfforts: { off:, ... }` 的 `off` 键破坏成 `false`（YAML 1.1 布尔解析）——已恢复原文件（保留 flow 格式）并改用纯文本追加；修复后 js-yaml（与 dsh 相同）验证 `off` 键完好。**教训：settings.yaml 是共享文档，绝不用破坏性 dump 重写，只做 leaf 级/追加修改。**

**4. 客户端设置页（§16.7 步骤 4）**

- `lib/client.js` 重写（135 → ~430 行）：新增 SettingsPage 注册 `settings.section`（id memory-lite, order 100），分组表单（提取/索引/界面/常规），字段表驱动（select/number/text/toggle 四类控件），draft 暂存 + Save（`connection.api.settings.mutate` 嵌套 path + expectedRevision）/Discard。
- `ui.headerOrder` 语义：槽注册期快照（order 在 apply 时固定），改后需刷新页面生效——设置页 hint 已标注。
- StatusDot 保留（轮询 /memory-status）；不再从 scope 读 order（注册期已固定）。

**5. 已知限制**

- `sharing.mounts`（数组）未纳入设置页字段表（FIELDS 无 mounts 项），仍靠 settings.yaml 手改；root/sharing.enabled 可编辑但标"重启生效"。
- 手写 client.js 表单可维护性：当前可接受，复杂度再升时评估 tsdown（§16.8 风险项）。

**6. 验收**

- build + 99 测试全绿；client.js `node --check` 通过。
- 待用户重启 dsh：设置面板出现 memory-lite 页；改 extraction 参数即时生效（指示灯/提取日志佐证）；root/sharing 显示"重启生效"。

### 16.10 UI 修订（2026-08-27，用户验收反馈）

用户重启后确认设置面板可见，提出两点：

1. **数字参数 = 0 的含义不明**：查代码后确认大部分字段 0 ≠ 禁用（windowTurns=0 每条消息立即触发；idleTimeoutMin=0 空闲立即提取；minTurnExtract=0 无条件触发；turnDebounceMs=0 无防抖；toolResultMaxBytes=0 工具内容全丢；maxMessages=0 窗口为空等效禁用；maxConcurrentRequests 为预留未接线字段改动无效；index.maxTokens 校验要求 ≥50）。已在设置页各字段 hint 逐条标注"0 = …"。
2. **跨 peer 共享设置的是哪个 peer 不明确**：sharing.enabled 只是总开关，具体共享哪个 peer 由 sharing.mounts 数组决定；mounts 未纳入设置页表单（已知限制）。已在设置页新增"共享挂载（sharing.mounts，只读）"块，展示当前生效的每个挂载（shared/<name>/ → peer <peer>（只读/可写）），并注明需在 settings.yaml 编辑。

- 当前生效配置：mounts = [{name: dsh-test, peer: dsh-test-72572e8b}]，即把 dsh-test-72572e8b peer 的记忆经 shared/dsh-test/ 暴露给其他 peer 只读访问。
- 测试 98 全绿（16 文件）；client.js 语法通过。

### 16.11 UI 分组重组（2026-08-27，用户反馈"功能相关设置应放一起"）

- 设置面板从"4 粗分组平铺"改为"组内子分组聚类"：
  - 记忆提取组内分：**触发方式**（窗口触发/空闲兜底/回合边界触发/会话落盘触发/回合边界最小消息数/回合防抖）、**提取内容**（单次消息上限/工具结果截断/携带摘要/去重检索）、**可靠性**（解析重试/审计日志/并发上限[预留]）。
  - 组标签改名：提取（extraction）→ 记忆提取；常规（重启生效）→ 存储与共享。
- 渲染逻辑：FIELDS 加 `sub` 字段，组内按 sub 聚类插入小节标题（12px 次级标题）。
- 测试 98 全绿；client.js 语法通过。

### 16.12 设置面板默认值显示（2026-08-27，用户要求"参数需要有默认值"）

- 问题：settings 服务用 schemastery 解析 namespace，未提供键不填默认（value 里只有显式值）；默认值在宿主 resolveConfig 补齐，客户端拿不到 → 面板空白。
- 方案：client.js 新增 DEFAULTS 表（镜像 src/config.ts 全部默认值），渲染时 `readPath(value, path) ?? DEFAULTS[key]`。已用宿主 resolveConfig({}) 实测核对一致（root 显示 ~/.agent-memory 原始值，更友好）。
- 语义：未覆盖字段显示默认值；保存时 draft 为空 → 不写（保持默认）；清空输入 → unset → 回默认。用户显式设置的值（如 settings.yaml 里 turnStoppingTrigger: false）仍显示实际值。
- 测试 98 全绿。


## 17. 隐式提取 LLM 模型可配置（Phase 6，2026-08-27 规划）

### 17.1 需求（用户原话归纳）

隐式提取（后台提取运行）的 LLM 调用，默认复用当前会话的渠道/模型。用户希望可配置，但**不做 baseURL/apiKey**——只做「选择 dsh 已注册的模型」+「推理强度」：

1. **模型下拉**：渠道与模型合并成一个下拉（`<provider> / <model>` 形式，如 `DeepSeek / deepseek-v4-flash`），用户只选一次。
2. **推理强度下拉**：选项不写死，**按所选模型的配置（adapter 声明的 reasoning.efforts）读取**；默认项 = 该模型的 default（不传 reasoningEffort，让 adapter 用 default）。
3. **默认语义**（用户明确）：**配置为空 → 用全局默认模型（agent-default-model，活值）；配置了 → 固定用配置的，不随 agent-default-model 变化。**推理强度同理。
4. 放弃"跟随当前会话模型"（用户拍板：用全局默认而非会话模型）。

### 17.2 调研结论（2026-08-27 实查 harness 源码）

- **`GenerateOptions`（dsh-llm）没有 baseURL/apiKey 字段**——自定义端点需自建 HTTP 客户端（方案 A），但用户明确不做，排除。
- **已注册模型目录**：`api.llm.models` RPC（`dsh-host-apiproxy`）返回 `{ groups: [{ id, name, models: [{ id, name, description?, reasoning? }] }] }`——provider 分组 + 每模型携带 **reasoning 元数据**（efforts + defaultEffort），一次请求拿全，纯本地内存查询。
- **全局默认模型**：`agent-default-model` settings 段（`ctx.agentDefaultModel.currentSelection()` 返回 provider/model/reasoningEffort）。用户观察：会话内切模型会**写回**该段 → 全局默认 = 最近一次切换的会话模型，是活值。
- **客户端侧**：`dsh-client-ui-settings-models` 已消费 `api.llm.*`；官方已有 `llm.providers` / `llm.models` RPC，无需自建。
- **推理强度**：模型级元数据（非 provider 级），`reasoning.efforts`（id/name/description）+ `defaultEffort`。deepseek 官方取值 `low|high|max`，但**下拉选项一律来自 adapter 声明**，不硬编码。

### 17.3 配置形态

在现有 `extraction.llm`（已有 `provider`/`model`）上扩展，**语义改为"已注册 route"**（不再有自定义端点）：

```yaml
extraction:
  llm:
    route: ""            # "provider/model"，如 "deepseek-official/deepseek-v4-flash"；空 = 用全局默认模型
    reasoningEffort: ""  # 空 = 跟随全局默认的推理强度；否则存具体 effort id（如 "low"）
```

- `route` 取代原 `provider`/`model`（旧字段保留兼容读法，但面板只写 route）。
- 两者皆空 → `resolveRoute()` 读 `ctx.agentDefaultModel.currentSelection()`。
- 配置了 route → 固定用 route 的 provider/model；推理强度配置了 → 覆盖，否则用全局默认的（若配置模型不支持该 effort → 报错并回退）。

### 17.4 生效时机

- **live**：提取运行开始时读 `deps.config()`（现有机制），下一次触发即生效。
- agent-default-model 是活值，未配置时每次运行都读当前值（非启动快照）。

### 17.5 设置面板 UI

记忆提取组新增子分组 **「提取模型」**（放在 提取内容 与 可靠性 之间）：

1. **模型下拉**（`extraction.llm.route`）：
   - 选项 = 「跟随全局默认（当前：<provider> / <model>）」 + `api.llm.models` 拼出的全部 `<provider> / <model>` 项。
   - 选中"跟随全局默认" → 清空 route。
2. **推理强度下拉**（`extraction.llm.reasoningEffort`）：
   - 选中模型后，选项 = 该模型的 `reasoning.efforts`（label 用 name，可选带 description），首项「跟随全局默认」。
   - 无 reasoning 元数据的模型 → 仅「跟随全局默认」并禁用。
   - 数据来自 `api.llm.models` 返回里每个模型的 `reasoning`（无需额外 RPC）。

### 17.6 实现改动清单

| 文件 | 改动 |
|---|---|
| `src/config.ts` | `ExtractionLlmConfig` 增加 `route?: string`、`reasoningEffort?: string`；`resolveConfig` 解析 route（校验格式 `provider/model`）、默认空；兼容读旧 `provider`/`model` |
| `src/extract/index.ts` | `resolveRoute()` 改为：route 配置优先 → 否则 `ctx.agentDefaultModel.currentSelection()`（缺服务时回退现有 header 逻辑）；`callExtraction` 传 `reasoningEffort`（配置的或全局默认的，经 `validateConfig` 校验） |
| `src/tool-utils.ts` | `MemoryDeps` 增加 `defaultModel?: () => {provider, model, reasoningEffort?}`（宿主注入） |
| `lib/client.js` | 新子分组「提取模型」+ 两个下拉；拉取 `api.llm.models` + `api.agentDefaultModel.currentSelection()`（注入 `connection`）；DEFAULTS 表加 `extraction.llm.route`/`extraction.llm.reasoningEffort`（空串） |
| `tests/` | `extract-decision`/`extract-boot` 增加 resolveRoute 用例（未配置→全局默认、配置→固定、推理强度传递）；config.test 加 route 校验；client.test 断言新字段 |
| `IMPLEMENTATION.md` | §17 实施记录（实现后追加） |

### 17.7 风险与已知限制

- **推理强度是模型级的**：不同模型 efforts 不同，下拉选项随选中模型联动；若配置了 route 但该模型无 reasoning，则只显示「跟随全局默认」。
- **`api.llm.models` 数据是静态 catalog**（adapter 声明），非会话实时——下拉选项不会随会话切换变化，但默认项「跟随全局默认」会。
- 客户端调用 `api.llm.models` / `api.agentDefaultModel` 的注入路径实现时确认（`connection.api.*` 或注入 store），不影响方案。
- 旧配置迁移：settings.yaml 当前未配 `extraction.llm`，无迁移需求；若用户已有 `llm.provider/model`（旧版）则兼容读取。

### 17.8 验收标准

1. 面板出现「提取模型」子分组，模型下拉含「跟随全局默认（当前：…）」+ 全部已注册 `<provider> / <model>`。
2. 推理强度下拉选项 = 选中模型的 efforts（首项跟随全局默认）；无 efforts 的模型禁用。
3. 未配置 → 提取日志 route 显示 agent-default-model 当前值；改全局默认后，下一次提取用新值。
4. 配置 route → 提取日志 route 固定为配置值；改 agent-default-model 不影响。
5. 推理强度配置 → 请求带该 effort；空 → 不带（adapter 用 default）。
6. 测试全绿。

### 17.9 实施记录（2026-08-27）

**实现内容**：隐式提取模型选择（route + reasoningEffort），配置为空 → 全局默认模型（agent-default-model），配置了 → 固定。

**宿主侧改动**：

- `src/config.ts`：`ExtractionLlmConfig` 增加 `route?: string`（"provider/model"）、`reasoningEffort?: string`；保留旧 `provider`/`model` 兼容读法（§17 前配置）。`resolveConfig` 校验 route 格式（必须恰好一个 `/`，两端非空，不含反斜杠），非法抛错；route/reasoningEffort 默认空串。
- `src/tool-utils.ts`：`MemoryDeps` 增加可选 `defaultModel?: () => {provider, model, reasoningEffort?}`（getter，每次运行读活值）。
- `src/index.ts`：`apply()` 里从 `ctx.get('agentDefaultModel')` 取 `currentSelection()` 注入 deps.defaultModel（服务缺失/异常 → 返回空对象，回退会话 header）。
- `src/extract/index.ts`：`resolveRoute()` 重写为三级优先级：
  1. `extraction.llm.route` 显式配置（固定，忽略全局默认；effort 用配置的）
  2. `deps.defaultModel()` 全局默认（活值；effort 用配置的，空则用全局默认的）
  3. 回退会话 `requestHeader().config`（旧行为）
  `Route` 增加 `reasoningEffort?`（`ReasoningEffortId` brand），`callExtraction` 透传给 `ctx.llm.stream`（`GenerateOptions.reasoningEffort`）。

**客户端侧改动**（`lib/client.js`）：

- FIELDS 新增 2 项（sub=「提取模型」，type=`dynamic-select`）：
  - `extraction.llm.route`（模型下拉）：选项 = 「跟随全局默认（当前：<provider> / <model>）」+ `api.llm.models` 返回的全部 `<provider> / <model>`
  - `extraction.llm.reasoningEffort`（推理强度下拉）：选项 = 「跟随全局默认」+ 选中模型的 `reasoning.efforts`（联动）
- 新增 `useModelOptions(connection, agentDefaultScope)` hook：拉 `connection.api.llm.models({})` 拿 catalog；`settingsScope.bind({namespace:'agent-default-model'})` 读全局默认模型（活值，订阅刷新）。
- 保存逻辑：dynamic-select 空串 → `unset`（回跟随全局默认）。
- DEFAULTS 表加 `extraction.llm.route`/`extraction.llm.reasoningEffort`（空串）。

**测试**（98 → 103）：

- `config.test.ts`：route 默认空、合法解析、旧 provider/model 兼容、非法 route 抛错（无斜杠/多斜杠/空段/反斜杠）。
- `extract-boot.test.ts`：3 个集成用例——未配置 → 用 deps.defaultModel（audit route 含 reasoningEffort）；配置 route → 固定（忽略全局默认，effort 用配置的）；无 route 无 defaultModel → 回退会话 header。
- `client.test.ts`：apply 同时 bind `dsh-memory-lite` 和 `agent-default-model` 两个 namespace。

**验收**：tsc build + client.js `node --check` + 103/103 全绿。

**注意**：客户端 `useModelOptions` 只在设置页打开时拉取（`api.llm.models` + agent-default scope），每次打开重新拉（本地内存查询，无网络开销）。推理强度下拉随选中模型联动；无 reasoning 元数据的模型只显示「跟随全局默认」。

### 17.10 修复记录（2026-08-27，用户验收反馈：下拉只有"跟随全局默认"）

用户重启后打开设置面板，提取模型下拉只有「跟随全局默认」，看不到任何模型。排查后两个根因：

1. **dynamic 标记缺失**：FIELDS 里 route/reasoningEffort 两个 dynamic-select 项没写 `dynamic: 'route'` / `dynamic: 'effort'`，FieldRow 把两个都当成 effort 处理（`effortOptionsFor` 对未选 route 返回只有「跟随全局默认」）。修复：补上 dynamic 标记。
2. **模型 id 本身含斜杠**：用户的 pi-ai 渠道（commandcode）模型 id 是 `deepseek/deepseek-v4-flash`（带 `/`），route 拼成 `commandcode/deepseek/deepseek-v4-flash`（三段）。config 的 route 校验原来要求恰好一个 `/`，会拒绝保存。修复：放宽为「provider = 第一个斜杠前，model = 剩余全部」，`resolveRoute` 本就按第一个斜杠拆分，天然兼容。

附带：llm.models 拉取失败时 console.error 诊断日志（排查用）。测试 103 → 104（新增：config 接受 a/b/c 三段 route；extract 拆分斜杠模型 id）。
