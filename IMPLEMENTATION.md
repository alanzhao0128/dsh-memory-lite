# dsh-memory-lite — 实现规格与记录

> 依据：《Light Memory for DSH 设计方案》v7（2026-08-25）
> 目标 DSH：`@deepseek-ai/dsh-*` @ **0.1.1-rc.2**（与运行中的 GUI 一致）
> 实现方式：独立插件（非 fork），目录 `/Users/alan/code/dsh-test/dsh-memory-lite`（2026-08-26 由 `dsh-memory-light` 改名，见 §14）
> 本文档随实现同步维护。

## 目录

- §1 包结构与构建
- §2 依赖
- §3 配置
- §4 MemoryStore 与路径安全
- §5 Catalog 与注入
- §6 工具集
- §7 subagent 策略
- §8 测试策略
- §9 本期不做
- §10 挂载与验收
- §11 Phase 1 实现偏差
- §12 Phase 2 规格：隐式提取
- §13 Phase 2 实现记录
- §14 改名记录
- §15 状态指示器（Phase 5）
- §16 设置面板（方案 A）
- §17 提取模型可配置（Phase 6）
- §18 提取治理（A/B/C，2026-08-28/29）
- §19 后续待办

---

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

## 3. 配置

### 3.1 Phase 1 子集

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
    maxTokens: number                // 默认 1200；catalog 条目超限截断
    sortBy: 'mtime'                  // 默认 'mtime'
  }
  tools: {
    schemaMinimal: boolean           // 默认 true
    pathRoot: string                 // 默认 = root；containment 根
    pathEscape: 'reject'             // 默认 'reject'
  }
}
```

schemastery：全部字段带默认值，`Config = z.object({...})`。Phase 2 追加 `extraction.*`，Phase 3 追加 `sharing` 与 `tools.forgetRequiresApproval`。

### 3.2 Peer 隔离模型（按 cwd/项目，不按 agent）

Peer 从每个会话自己的 `SessionHeader.cwd` 派生（`peerFromCwd`：sanitized basename + sha1(cwd) 前 8 位，如 `/Users/alan/code/dsh-test` → `dsh-test-72572e8b`）。**隔离维度是工作目录（项目），不是 agent/preset**：

| 场景 | 行为 |
|---|---|
| 同一项目、不同 agent/preset | **共享同一 peer** 记忆 |
| 同一 agent、不同项目 | **各自独立 peer**，互不可见 |
| 会话无 cwd | 回退 `workspacePeers.cwdFallback`（默认 `defaultPeer`） |
| GUI 不选项目 | 全部会话落 GUI 默认项目目录对应的同一 peer |

- 插件只读 `header.cwd` 与 `header.origin`，**从不读 agent 身份或 `agentPreset`**。
- **后果**：在新项目开会话落在新 peer（空），看不到旧 peer 记忆——空索引按设计不注入目录（§7 applyCatalogDecision）。这是 peer 隔离的正常行为（2026-08-26 实测确认）。
- **跨项目共享**：**已实现（Phase 3，§13 偏差 13）**——`sharing` 配置 + `shared/<name>/...` 逻辑映射（只读单向），详见 §13。
- **按 agent 再分一层**（如需）：可在 `peerFromCwd` 中混入 `agentPreset` 维度，当前未做。

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

- **所有工具 path 参数 = 相对 memories root 的相对路径**，拒绝绝对路径。
- 合法目标：memories root 内任意 `.md`（含四分类子目录），不设类别白名单。
- **containment 强制点 = MemoryStore 的 resolve 方法**：`path.resolve(memoriesRoot, candidate)` → `realpath`（解析符号链接）→ 断言仍在 `realpath(root)` 内。`..` 逃逸、绝对路径、符号链接逃逸一律 `MemoryPathError`。
- `shared/` 及配置化共享目标的 carve-out 属 Phase 3（§13 偏差 13）。

### 4.3 写通道（并发安全）

- 所有写操作经 **MutationQueue**（插件内串行 Promise 队列）；`writeFileAtomic`（tmp + rename）落盘；`_index.md` 重建在队列内。
- 主会话工具（remember/update）与后台提取（Phase 2）共用同一队列。

### 4.4 MemoryStore API（Phase 1 面）

```ts
interface MemoryStore {
  readonly root: string
  memoriesRoot(peer: string): string
  resolve(peer, relPath): Promise<{ abs, rel }>            // containment 唯一入口
  readFile(peer, relPath): Promise<{ content }>
  writeFile(peer, relPath, content): Promise<void>          // 队列 + 原子写
  softDelete(peer, relPath): Promise<void>                  // 移入 root/.trash/{date}/{name}
  search(peer, query, opts?): Promise<SearchMatch[]>        // 行匹配，上限 20 条/行 300 字符
  readIndex(peer): Promise<IndexEntry[]>                    // 解析 _index.md（宽容解析）
  rebuildIndex(peer, entries): Promise<void>                // 重排（mtime 倒序）+ 原子写
  listCategoryFiles(peer, category): Promise<{ rel, mtime }[]>
}
```

实例在 `apply()` 内创建并闭包传入工具与注入器。

## 5. Catalog 与注入（照 `dsh-tool-skill`）

### 5.1 typed source（merge-extensible）

```ts
interface MemoryCatalogSource {
  readonly kind: 'memory-catalog'
  readonly form: 'catalog'
  readonly update?: true
  readonly entries: readonly { category, path, summary }[]
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'memory-catalog': MemoryCatalogSource }
}
```

### 5.2 索引文件格式

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

- 条目行：`- {relpath}: {summary}`，relpath 相对 memories root。
- **宽容解析**：`readIndex` 逐行匹配 `^- (\S+\.md): (.*)$`；不匹配行忽略，解析结果与渲染出的 catalog 一致（digest 用条目算）。
- 排序：按 mtime 倒序重建；单类 > 10 条时生成分类二级 `_index.md`（catalog 仍平铺全量，超 `index.maxTokens` 时按类截断并加 `… (truncated)`）。

### 5.3 catalog 消息文本

```markdown
<system-reminder>
This is your long-term memory index for the {peer} project. It lists what you have memorized, one line per memory. The full text of any memory is NOT loaded until you call read_memory — use the exact path from this index.

{按类分节的条目列表}

You have long-term memory tools (read_memory / search_memory / remember / update_memory / forget_memory). Call remember only when the user explicitly asks to remember something; do not decide on your own. In all other cases prefer read_memory / search_memory to load what this index points to.
</system-reminder>
```

- 首次发布 = `renderCatalogMessage`；索引变更且旧 catalog 在可见面 = `renderCatalogUpdate`。
- digest：条目规范串 → sha256 hex（照 tool-skill）。

### 5.4 pre-step 注入逻辑

```
ctx.on('agent/pre-step', ...):
  decision = await next()
  reject → 原样返回
  subagent 会话 → 原样返回                     # 决策 2
  可见性锚 = ctx.tools.get('read_memory', agent) === readMemoryTool；不可见 → 原样返回
  peer = sessionPeer(agent.session.header, config)
  entries = await store.readIndex(peer)
  digest = digestIndexEntries(entries)
  history = catalogHistory(agent)
  existing = catalogMessage(decision.messages)
  分支（与 tool-skill 完全一致）：
    history.visibleDigest === digest → 移掉多余同源 catalog 或不动
    existing 存在且 digest 相同 → 不动
    !history.published && entries.length === 0 → 不注入（空索引）
    history.published → renderCatalogUpdate 替换/追加
    否则 → renderCatalogMessage 追加
```

- `catalogHistory`：自尾向前扫 `agent.session.events`，找 `source.kind === 'memory-catalog'` 的最后一条，`surface.nodes` 集合判可见性。
- 注入消息 = `createUserMessage({ content: [{type:'text', text}], source: {kind:'memory-catalog', ...} })`。

## 6. 工具集（5 个，schema 精简）

| 工具 | 参数 | 说明 |
|---|---|---|
| `read_memory` | `path` (req) | 读 L1 全文；越界抛错 |
| `search_memory` | `query` (req) | grep 行匹配，`{matches: [{path, line}]}` |
| `remember` | `category` (req, enum), `title` (req), `content` (req) | 创建/追加；slug 化 title |
| `update_memory` | `path` (req), `content` (req) | 旧内容入 History，新内容入 Current |
| `forget_memory` | `path` (req) | 软删到 `root/.trash/` |

- 每个工具 `execute` 首行：subagent 来源拒绝。
- `presentCall`：读类 `kind:'read'` + `locations:[path]`；写类 `kind:'write'`。
- output schema 均 `additionalProperties:false`。

## 7. subagent 策略（决策 2 的实现落点）

- 注入侧：pre-step 顶部按 `origin === 'subagent'` 短路（不注入 catalog）。
- 工具侧：每个工具 execute 顶部拒绝 subagent 来源。

## 8. 测试策略

1. **单元测试**（node:test + tsx，无外部服务）：path/memory-store/catalog/config 四组。
2. **Loader boot 冒烟**（`boot.test.ts`）：挂载本地 cordis.yml，断言工具注册。
3. **挂载验证**（人工，见 §10）：装进运行中的 web profile。
4. Phase 2 的提取触发改为"运行日志统计 + 单元断言"覆盖。

## 9. 本期不做（Phase 2/3 占位）

- 隐式提取 → Phase 2（`sessions/{id}.json` schema 届时定）。
- `forget_memory` 审批、`shared/` 共享 + carve-out、`## Related` 维护 → Phase 3。
- CLI/MCP → Phase 4。

## 10. 挂载与验收

1. `pnpm build && pnpm test` 通过。
2. 装进 `$DSH_HOME/profiles/web`，配置 `cordis.patch.yml` 覆写 root 指向测试目录。
3. 启动/刷新 GUI，验证 remember 落盘 + `_index.md` 重建 + 下一条消息携带 catalog；确认 subagent 会话无注入。
4. 验收清单：5 工具可见、L0 注入一次、写后索引更新、越界路径被拒、subagent 拒绝。

### 10.1 实测结论（2026-08-25，标准模式新会话）

| # | 用例 | 结果 | 证据 |
|---|---|---|---|
| 1 | remember「偏好用 pnpm」 | 通过 | preferences/pnpm.md + _index.md Total:1 |
| 2 | 新会话直接问包管理器偏好 | 通过 | catalog 注入，模型可答 |
| 3 | search_memory | 通过 | 行级命中，路径可回传 |
| 4 | update_memory 改 npm | 发现bug后修复 | normalizeContent 修复（§11-9） |
| 5 | forget_memory | 通过 | 文件移入 .trash/，索引同步 |
| 6 | remember 中文标题 | 发现bug后修复 | slugify 保留 CJK（§11-10） |

- 会话类型结论：工具注册在根上下文 → global 工具层，四个预设均可见；测试/使用选「标准模式」。
- 已知问题（暂不解决）：PTC 模式下模型先尝试原生调用 memory 工具被拒（UNKNOWN_TOOL）再退回 run_code 包装——功能可用但每次多 1 次 LLM 请求。留待 Phase 2 工具呈现适配评估。

## 11. Phase 1 实现偏差记录（2026-08-25）

1. **containment 根 = 当前 peer 的 memories root**（更严格）；tools.pathRoot/pathEscape **本期不暴露**——路径逃逸策略是固定安全不变式。
2. **peer slug 统一小写**：避免 macOS 大小写不敏感文件系统碰撞。
3. **catalogMessage 容忍无 source 消息**：跳过而非抛错。
4. **resolve 的 rel 基于 canonical 根计算**：macOS /tmp → /private/tmp 符号链接祖先。
5. **walkMarkdown 的 rel 始终相对顶层 memories root**，保证 search 结果可直接回传。
6. **renderMemoryFile 节头后不加空行**，与 writeNewMemory 模板一致。
7. **applyCatalogDecision 抽成纯函数**（inject.ts 导出）便于单测。
8. **boot 冒烟测试**：新增 devDep dsh-app-boot；YAML 中 @ 开头 scope 名必须加引号。
9. **update/remember content 归一化**（实测发现）：模型把完整渲染文件当 content 传入 → 新增 normalizeContent。
10. **slugify 保留 CJK**（实测发现）：中文标题不再撞成 memory.md。

## 12. Phase 2 规格：隐式提取（通道 B）

> 起草 2026-08-25，依据设计文档 §八/§九 + 0.1.1-rc.2 已安装源码逐条核验。实现前需用户 review。

### 12.1 范围与已锁决策

1. 范围：后台隐式提取，与 Phase 1 显式通道并存；新增 extraction 配置、触发系统、提取执行器、滚动 digest、checkpoint/审计。
2. **提取模型决策（用户已锁）**：默认复用主会话当前模型（`session.requestHeader().config`）；`extraction.llm.provider/model` 非空时用专用模型覆盖。
3. **提取异步化（源码硬约束）**：`agent/turn-stopping` 是 serial + awaited，回调内不得同步 await 提取 LLM；所有触发入口只「判定 + 排队」，实际提取经 `ctx.jobs` 派发。事件内不 await 提取。
4. **审计不进会话日志（源码硬约束）**：自定义会话事件会让 resume 失败；提取审计与 checkpoint 同文件写入 `peers/{peer}/sessions/{session-id}.json`。
5. 只处理主会话：`session.header.origin !== 'subagent'`。
6. 消息口径（v6 定死）：只统计/读取 `user/message`、`assistant/message`、`tool/result`。
7. 提取素材从 `session.events`（append-only 完整日志）读取，不读 `session.surface`。

### 12.2 新增配置（extraction 命名空间）

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `incremental` | incremental / explicit_only / off |
| `window_turns` | `20` | 新增消息 ≥ 该数触发 |
| `idle_timeout_min` | `30` | 空闲多久触发（每消息重置） |
| `max_messages` | `20` | 单次喂给 LLM 的消息数上限 |
| `message_scope` | 全部三种 | 消息口径（显式声明） |
| `tool_result_max_bytes` | `2048` | tool/result 截断 |
| `include_digest` | `true` | 携带滚动 digest |
| `dedup` | `true` | grep 已有记忆做对比 |
| `llm.provider` / `llm.model` | `null` | 专用提取模型（`null` = 复用会话模型） |
| `turn_stopping_trigger` | `true` | turn 边界兜底入口 |
| `flush_trigger` | `true` | session/flush 最后防线 |
| `min_turn_extract` | `5` | turn 边界最小未提取消息数 |
| `turn_debounce_ms` | `30000` | turn 边界防抖 |
| `audit_log` | `true` | 审计写 sessions/{id}.json |
| `max_concurrent_requests` | `1` | 并发上限（全局单飞） |

### 12.3 触发系统（五路 → 统一判定 → ctx.jobs 派发）

统一入口 `maybeScheduleExtraction(session)`：校验 mode、peer 存在、非 subagent、无在途任务 → 满足则 `ctx.jobs` 派发。

| 路 | 事件 | 判定 | 约束 |
|---|---|---|---|
| ① 消息计数 | `session/event` | 未提取 ≥ `window_turns` | 每会话计数器 |
| ② 空闲 | `ctx.timeout(idle_timeout_min)` | 超时未触发过 | 每次 session/event 重置 |
| ③ turn 边界 | `agent/turn-stopping` | 未提取 ≥ `min_turn_extract` 且过防抖 | **回调内不 await** |
| ④ 最后防线 | `session/flush` | 同 ③ | 频率不可控，不作主依赖 |
| ⑤ 手动 | 内部钩子/测试 | 立即提取 | 无门槛 |

### 12.4 提取执行协议

```
Step 0: 从新窗口提取关键词（启发式，~8 个）
Step 1: grep 命中已有记忆
Step 2: 一次 ctx.llm.stream 调用，输入 = [滚动 digest] + [新窗口消息] + [grep 命中]
        指令：「提取记忆。决策：create/merge/update/skip。」
Step 3: 解析 decision → MutationQueue 内写盘 + 重建 _index
Step 4: 更新滚动 digest（~100 token）+ 推进 checkpoint seq（原子写）
```

### 12.5 提取 LLM 调用规格

- `options`：`{ provider, model, messages, system, maxTokens（如 1024）, signal }`。
- 不调用 `markAgentLoopRequest`；`purpose` 省略（封闭 union）。
- 限流：全局 `max_concurrent_requests: 1` 信号量 + 失败退避。
- 结果解析：LLM 输出结构化 JSON；解析失败 → 记审计、不写盘、推进 checkpoint 防死循环。

### 12.6 消息口径与窗口裁剪

- 窗口 = `(checkpoint.seq, 当前 seq]` 内三种 SurfaceEventType 事件。
- `session.events` 是不可变快照。
- tool/result 内容按 `tool_result_max_bytes` 截断。
- 超过 `max_messages` 时取窗口尾部（最近优先）。
- 滚动 digest：每轮由 LLM 返回会话摘要（或本地截断 + ~100 token 文本）。

### 12.7 checkpoint 与审计文件

```json
{
  "version": 1,
  "checkpoint": { "seq": 128 },
  "digest": "会话滚动摘要",
  "audit": [{ "at": "...", "windowSeq": [109,128], "grepHits": [...], "route": {...}, "maxTokens": 1024, "decision": "update", "path": "...", "seq": 129 }]
}
```

- checkpoint 推进 = 提取输入的最后 seq。
- 全部经 MutationQueue + writeFileAtomic。

### 12.8 会话生命周期与并发安全

- `session/disposed`：abort 在途 extraction job。
- HMR 重载：effect 内监听与 job 随 fiber unwind；MutationQueue 状态幂等。
- 跨重启：从 checkpoint seq 补差距，不丢不重。
- 与 Phase 1 工具并发：同一 MutationQueue。

### 12.9 测试策略

- 纯函数：触发判定、窗口裁剪、checkpoint 推进、审计渲染、digest 截断、decision 解析。
- 集成（Loader boot）：mock `llm/stream` → 断言一次提取后文件/索引/checkpoint/审计一致。
- 真实回归：GUI 会话观察触发次数。

---

## 13. Phase 2 实现记录（2026-08-25）

### 13.1 新增模块（总测试 41 → 85）

| 模块 | 职责 |
|---|---|
| `src/extract/window.ts` | 消息口径、窗口裁剪、字节级截断、事件渲染 |
| `src/extract/triggers.ts` | 触发判定纯函数 |
| `src/extract/decision.ts` | LLM JSON 解析（容忍 code fence 与散文） |
| `src/extract/digest.ts` | 滚动 digest |
| `src/extract/checkpoint.ts` | checkpoint+审计文档 |
| `src/extract/prompt.ts` | 提取指令模板 |
| `src/extract/index.ts` | 触发监听 + 执行器 `extractOnce` |

- `MemoryStore` 新增：`sessionCheckpointPath`、`readSessionCheckpoint`、`writeSessionCheckpoint`。
- `config.ts` 新增 `extraction` 命名空间（18 键）。
- 插件入口 `apply()` 接线 `applyExtraction`。

### 13.2 实现偏差（对 §12 规格的调整）

1. **fire-and-forget 替代 ctx.jobs**：`JobKindMap` 是封闭 union（仅 bash/subagent），自定义 kind 编译不过。用自身 AbortController + `session/disposed` 取消。
2. **`extractOnce` 导出为测试缝**：结构性 `ExtractionSessionLike`。
3. **模型路由**：`extraction.llm` 优先；否则 `requestHeader()?.config`；皆缺 → 记 no-route 审计并推进 checkpoint。
4. **失败处理**：均记审计并**推进 checkpoint**（防无限重试）。
5. **LLM 流收集**：用 `BlockAssembler` 而非手工拼 chunk。
6. **create 不覆盖已存在记忆**（实测发现）：fileExists 时降级为 merge（appendCurrent）。
7. **appendCurrent 去重**（实测发现）：append 前按行去重，全重复则零写入。
8. **parse-error 健壮性（Phase 2.1）**：live 实测 13 次中 7 次 parse-error。三层修复：(a) STRICT OUTPUT RULES 提示词硬化；(b) 解析器容错（全角归一化 + 括号不平衡重建）；(c) 有界 repair 重试（新增 `extraction.parseRetry`，默认 true）。
9. **提取窗口排除系统注入消息（Phase 2.2）**：`selectWindow` 对 `user/message` 用 source 白名单（仅 `source.kind === 'user'`），注入类一律排除；量化：窗口 tokens 降 55%。
10. **运行指标记录（Phase 2.2）**：真实 usage（`BlockAssembler.usage`）+ peer 级 `extraction.log`（JSONL，封顶 5000 行）。
11. **maxConcurrentRequests 未接线**（代码审查发现）：实际并发闸门只有「每会话 `state.inFlight`」——不同会话可同时触发。留待评估。
12. **关闭 turn/flush 触发（方案 C）**：观测显示真实输出 800~1400 tokens，turn 触发把频率推到 ~4 倍而多数 skip 是浪费。用户决策：**关闭 turn/flush**，保留窗口 + 空闲兜底。实现代码保留，仅配置开关禁用。
13. **跨 Peer 共享（Phase 3）**：只读单向 `shared/<name>/...` 逻辑映射；search 覆盖共享挂载；L0 注入新增共享提示节（不预载共享索引）。
14. **被抛弃短会话的记忆永不提取（已知限制）**：pending 与 idle 定时器都是内存态。**用户确认暂不改**。
15. **L0 目录瘦身 + maxTokens 接线**：`summaryOf` 上限 200→100 字符；注入层 `capCatalogEntries` 按预算保留最新条目。
16. **提取失败静默跳过（llm-error 不重试、checkpoint 照推；记录暂不改）**：失败直接推进 checkpoint 并清零 pending——该窗口候选记忆永久跳过，无主动通知。**用户判断更值得处理，但先记录、暂不改**。
17. **create 检查-再写竞态**（同 peer 并发提取同路径可覆盖；记录暂不改）：`fileExists` 与 `writeNewMemory` 分离。触发条件苛刻，当前概率低。
18. **方案 C 后提取完全停摆（timer 未 inject；定位并修复）**：`resetIdle` 调用 `ctx.timeout` 但插件 inject **从未声明 'timer'** → 每个 surface 事件抛错被吞 → 提取彻底停摆。修复：inject 加 'timer' + boot 测试补挂 timer + 回归测试。**生效需重启 dsh**。

### 13.3 集成测试（tests/extract-boot.test.ts）

- REAL Loader boot + mock `llm/stream` → 断言记忆文件、索引、checkpoint。
- 同 boot + 非法 LLM 输出 → 断言 parse-error 审计 + checkpoint 推进 + 无写入。

### 13.4 实测记录（挂 live profile，2026-08-25）

**配置**：windowTurns: 3（快速触发便于观测），其余默认；会话模型 huoshan/deepseek-v4-flash，`maxTokens: 1024`。

| 会话 | 运行数 | 结果明细 |
|---|---|---|
| f680b432 | 14 | 4 llm-error + 3 success + 7 parse-error |
| b6d29cde | 3 | 3 success |
| 其他 | 4 | 全 llm-error |

合计 21 次运行：8 llm-error（inject 修复前，0 成本）+ 13 真实调用（6 success：4 create + 2 skip；**7 parse-error ≈ 54%**）。

**关键结论**：
1. 触发行为正常：windowTurns=3 + turn 边界下约每 1–2 分钟触发一次，窗口 seq 连续推进。
2. LLM 成本可忽略：13 次调用 ≈ 0.03–0.05 元。
3. **parse-error 是最大质量问题** → Phase 2.1。
4. 审计完整可复现。
5. 实测发现两个 bug（create 覆盖、重复子弹）→ 偏差 6/7。
6. **inject 缺失 bug**：8 次 llm-error 根因 = inject 缺 'llm'。
7. 写盘验证通过。
8. **成本收益判断** → 2026-08-25 用户决定 `extraction.mode: 'off'` 关闭隐式提取。

**遗留**：parse-error 54% 根治（已完成，偏差 8）；windowTurns 默认合理性（已复测，§13.5）；PTC 工具呈现适配（未动）。

### 13.5 Phase 2.1 复测记录（2026-08-25）

**配置**：`mode: incremental` + `windowTurns: 20`。

> 插曲：首次重启前 mode 实际仍为 'off'（只取消了 windowTurns 注释）。教训：改配置后应核对 mode 本体。

| 会话 | 运行 | 结果 |
|---|---|---|
| a80a8834 | 3 | 3 skip |
| 1c6f6cf9 | 1 | 1 create |

合计 4 次真实调用：**4/4 解析成功，parse-error 率 54% → 0%**。

**结论**：提示词硬化单独起效；隐式通道真实产出；去重正常；触发行为符合预期（turn 边界主导）；`maxMessages=20` 截断生效。当前配置保持启用。

### 13.6 Phase 2.2 记录：提取窗口排除系统注入消息

**发现**：首次提取窗口把系统注入的 user 消息当对话喂给 LLM（a80a8834 run1 5 条中 3 条是注入块，占 ~99% tokens）。

**根因**：提取窗口按 surface 类型全量选取，不区分来源。

**修复**（偏差 9）：`selectWindow` 对 `user/message` 用 source 白名单。

**量化**：窗口 tokens 合计 9,535 → 4,296（**-55%**）。

**遗留**：`state.pending` 计数含注入消息，首窗口触发略早；影响极小，暂不改。

### 13.7 运行指标与日志（Phase 2.2）

**真实 usage 采集**：`BlockAssembler.usage`；缺失时回退 bytes/3 估算。

**记录位置（三层）**：
1. 会话审计（sessions/{id}.json）：llmCalls/inputTokens/outputTokens/durationMs。
2. **peer 级汇总日志**（extraction.log，JSONL，封顶 5000 行）。
3. dsh 日志：`ctx.logger.info` 一行。

**审计开关**：`auditLog: false` 跳过审计与 summary log，checkpoint 仍推进。

**查看示例**：`jq` 按 outcome/session/token 聚合。

---

## 14. 改名记录（2026-08-26）：dsh-memory-light → dsh-memory-lite

**原因**：项目名拼写有误（本意 memory-lite），经完整影响面审计后确认安全，于 2026-08-26 执行。

**改动清单**：目录、package.json/lock、cordis.patch.yml、src 引用、tests、README、web profile package.json + patch、node_modules 重建。

**审计确认的零影响项**：记忆数据（peer 由 cwd 派生，与插件名无关）、checkpoint/audit/log、注入 source kind、harness/CLI、session_projcache.json。

**生效要求**：下次重启时 profile 需已同步，否则依赖解析失败导致插件不加载。

---

## 15. 状态指示器（Phase 5，2026-08-26；位置 2026-08-26 从侧边栏 footer 移至会话标题栏）

> 设计确认后实现。三色（绿/红/灰）、无琥珀、无数据归绿、"红到下次成功"、一行 UI（左文字 + 右圆点）、位置可配。

**位置决策（B 方案）**：初版放 `sidebar.footer.action`，用户判定"太丑"且该槽是水平 flex 无法堆叠；最终移到 `conversation.session.header.utilities`（会话标题栏最右端，与 "Session log" 下载胶囊并排）。配置键 `ui.sidebarOrder` → `ui.headerOrder`。

### 15.1 结构

```
后端（~40 行）：
  src/status.ts        createStatusTracker() → { reportRun, reportError, snapshot }
  src/extract/index.ts recordRun 末尾 +1 行 reportRun；catch +1 行 reportError
  src/index.ts         inject 增 'connection'；rpc.handle('/memory-status', authority: 'loopback')
客户端（lib/client.js，手写 classic-script ~130 行）：
  slots.register({ order }) → conversation.session.header.utilities
  StatusDot：10s 轮询 rpc.call('/memory-status','snapshot')；轮询失败 = 红
package.json：dsh.client + exports["./client"]
```

### 15.2 状态语义（用户锁定）

| 色 | 条件 |
|---|---|
| 🟢 绿 | mode incremental 且最近事件 ok；无数据=绿 |
| 🔴 红 | 最近事件失败 或 轮询失败（通道不可达） |
| ⚪ 灰 | mode off / explicit_only |

- 回绿唯一途径：下一次提取成功。
- 意外异常上报：catch 同时写 logger + tracker → 静默失败可视化。

### 15.3 配置

- `ui.headerOrder: number`（默认 -1）：-1 在 "Session log" 左侧，1 在右侧。
- 校验：整数，非整数 fail loud。

### 15.4 测试

- 后端单测 7 例；config 1 例；boot 集成 1 例（fake-connection fixture）。
- 测试 85 → 94 全绿。

### 15.5 验证

- 构建/测试通过；重启 dsh 后生效。
- **人工验收（2026-08-27）**：✅ 会话标题栏最右端出现 memory-lite 胶囊，用户确认"看样子正常"。

---

## 16. 设置面板方案（方案 A，2026-08-27）

> 目标：不再手改 cordis.patch.yml 调参。通过 harness 官方设置通道提供可视化设置面板；配置落盘 `~/.dsh/settings.yaml`。

### 16.1 调研结论（2026-08-27 实查）

| 项目 | 设置面板入口 | 配置存储 | 生效方式 |
|---|---|---|---|
| dsh-harbor | `settings.section` 槽 | 只读清单 | — |
| dsh-better-sidebar | `settings.section` 槽 | harness settings namespace | 即时生效 |
| harness 官方 | `settings.plugin.item` 槽 | settings 服务 | 即时生效 |

**环境实证**：`~/.dsh/settings.yaml` 已存在（ui-theme/locale/llm-pi-ai/dsh-better-sidebar 段）；memory-lite 将占用 `dsh-memory-lite:` 段，互不干扰。

### 16.2 目标形态

- 入口：设置面板新增 "memory-lite" 页（`settings.section` 槽）。
- 存储：`dsh-memory-lite:` section。
- 分层：live 参数保存即生效；restart 参数（root/sharing）写盘 + UI 标注"重启后生效"。
- 挂载：删除 profile 挂载行 + 配置块；包内 patch 保留（纯挂载）。

### 16.3 配置分层模型

```
生效值 = settings.yaml user 层 > 包内 patch base 层 > schema 默认值
```

### 16.4 字段分组与控件

- **live**：extraction.mode/windowTurns/idleTimeoutMin/maxMessages/toolResultMaxBytes/minTurnExtract/turnDebounceMs/maxConcurrentRequests + 开关组 + index.maxTokens + ui.headerOrder + defaultPeer/workspacePeers。
- **restart**：root、sharing.enabled、sharing.mounts。

### 16.5 动态配置源改造（宿主侧）

1. `installSettingsSection` 接入。
2. `onChange` 重新解析动态配置；live 参数热更新。
3. `config` 从固定对象改为 getter：`deps.config = () => currentResolved`。

### 16.6 客户端设置页

- `ctx.slots.inject('settings.section', ...)` 注册。
- 手写 React + 原生表单控件。
- `settingsScope.bind` → `getSnapshot()` / `set()/unset()`。

### 16.7 实施步骤

1. 宿主侧接入 settings。
2. 动态消费点改造。
3. 测试（fake settings 服务）。
4. 客户端设置页。
5. 测试。
6. 配置迁移。
7. 文档。
8. 验收。

### 16.8 工作量与风险

- 合计 ~3 天。风险：动态源改造回归（96 测试兜底）、手写表单可维护性、settings.yaml 共享文档误写风险。

### 16.9 实施记录（2026-08-27）

按 §16.7 顺序完成，99 测试全绿。

1. 宿主侧：dependencies 加 dsh-settings；`live` 可变引用 + `installSettingsSection`；`MemoryDeps.config` 改 getter；消费点全部改读 `deps.config()`。
2. 测试：fake-settings fixture + settings-boot.test.ts 2 例 + client.test 更新。
3. 配置迁移：settings.yaml 追加 `dsh-memory-lite:` 段；profile patch 删 config 块。**坑**：python yaml.safe_dump 把 `off` 键破坏成 `false`（YAML 1.1）——已恢复原文件，改用纯文本追加。**教训：settings.yaml 是共享文档，绝不用破坏性 dump 重写，只做 leaf 级/追加修改。**
4. 客户端设置页：lib/client.js 重写（135 → ~430 行），分组表单 + draft + Save/Discard。
5. 已知限制：sharing.mounts 数组未纳入表单（手改 yaml）；手写表单可维护性。
6. 验收：build + 99 测试全绿；待用户重启。

### 16.10 UI 修订（2026-08-27，用户验收反馈）

1. **数字参数 = 0 的含义不明**：查代码确认各字段 0 的语义（大部分 0 ≠ 禁用）；已在设置页 hint 逐条标注。
2. **跨 peer 共享设置的是哪个 peer 不明确**：新增"共享挂载（只读）"块展示当前挂载。

测试 98 全绿。

### 16.11 UI 分组重组（2026-08-27，用户反馈"功能相关设置应放一起"）

- 改为组内子分组聚类：触发方式 / 提取内容 / 可靠性；组标签改名（提取→记忆提取，常规→存储与共享）。
- FIELDS 加 `sub` 字段。

### 16.12 设置面板默认值显示（2026-08-27，用户要求"参数需要有默认值"）

- client.js 新增 DEFAULTS 表（镜像 config.ts）；渲染时 `readPath ?? DEFAULTS[key]`。
- 语义：未覆盖显示默认值；保存时 draft 空 → 不写；清空 → unset → 回默认。

### 16.13 共享挂载勾选式 UI（2026-08-29，commit fc81ad1）

**背景**：此前 sharing.mounts 只能手改 settings.yaml（§16.9 已知限制）。用户提出：把每个工作区列出来打钩即可。

**语义澄清**（用户确认）：sharing.mounts 是**全局配置**，与当前会话在哪个工作区无关——每条挂载 = 「该 peer 的记忆对所有工作区会话只读公开」。列表平铺全部 peer，无"当前"概念；代码里 `mount.peer === peer` 跳过自访问只是读取时的防御，配置时不需要排除任何 peer。

**实现**：
- 后端：`MemoryStore.listPeers()`（扫描 `peers/` 目录，容忍缺失）+ 新 RPC `/memory-peers`（loopback 权威，返回 `{ peers, mounts }`，只列目录名不读内容）。
- 前端：设置面板「存储与共享」组的只读块 → 每 peer 一个 checkbox；挂载时拉 `/memory-peers`，当前 mounts 默认勾选；勾选变化 → 保存时组装 `sharing.mounts`（`{name, peer, subpath:'', readonly:true}`）走现有 settings mutate（revision 保护）；保存/放弃后状态重置；RPC 失败降级显示错误。
- 测试：新增 /memory-peers boot 测试（预置 2 个 peer 断言列表 + 空 mounts），107 → 107 全绿（新增 1 例）。

**生效**：后端重启 dsh；前端刷新浏览器。

---

## 17. 隐式提取 LLM 模型可配置（Phase 6，2026-08-27 规划）

### 17.1 需求

用户希望隐式提取的 LLM 调用可配置，**不做 baseURL/apiKey**——只做「选择已注册模型」+「推理强度」：

1. 模型下拉（`<provider> / <model>` 合并）。
2. 推理强度下拉按所选模型的 adapter 声明读取；默认项 = 该模型 default。
3. **默认语义**：配置为空 → 用全局默认模型（agent-default-model，活值）；配置了 → 固定用配置的。
4. 放弃"跟随当前会话模型"（用户拍板）。

### 17.2 调研结论（2026-08-27 实查）

- `GenerateOptions` 没有 baseURL/apiKey 字段——自定义端点需自建 HTTP（用户明确不做，排除）。
- `api.llm.models` RPC 返回 provider 分组 + 每模型 reasoning 元数据。
- `agent-default-model` settings 段：`ctx.agentDefaultModel.currentSelection()`（活值，会话切模型会写回）。
- 推理强度是模型级元数据，下拉选项一律来自 adapter 声明。

### 17.3 配置形态

```yaml
extraction:
  llm:
    route: ""            # "provider/model"；空 = 用全局默认模型
    reasoningEffort: ""  # 空 = 跟随全局默认；否则存 effort id
```

- `route` 取代旧 `provider`/`model`（兼容读法保留）。

### 17.4 生效时机

- **live**：提取运行开始时读 `deps.config()`。
- agent-default-model 是活值，每次运行都读当前值。

### 17.5 设置面板 UI

- 「提取模型」子分组（提取内容 与 可靠性 之间）：
  1. 模型下拉：跟随全局默认（当前：…） + 全部 `<provider> / <model>`。
  2. 推理强度下拉：选中模型的 efforts（首项跟随全局默认）；无元数据 → 禁用。

### 17.6 实现改动清单

| 文件 | 改动 |
|---|---|
| `src/config.ts` | route/reasoningEffort + 校验 + 兼容旧字段 |
| `src/extract/index.ts` | `resolveRoute()` 三级优先级 + 传 reasoningEffort |
| `src/tool-utils.ts` | `MemoryDeps.defaultModel?` |
| `lib/client.js` | 提取模型子分组 + 两个下拉 + DEFAULTS |
| `tests/` | resolveRoute 用例 + config 校验 + client 断言 |

### 17.7 风险与已知限制

- 推理强度是模型级的：选项随选中模型联动。
- `api.llm.models` 是静态 catalog（非会话实时）。
- 客户端注入路径实现时确认。

### 17.8 验收标准

1. 面板出现「提取模型」子分组，模型下拉含跟随全局默认 + 全部已注册模型。
2. 推理强度下拉 = 选中模型的 efforts。
3. 未配置 → 提取日志 route 显示 agent-default-model 当前值。
4. 配置 route → 固定。
5. 推理强度配置 → 请求带该 effort；空 → 不带。
6. 测试全绿。

### 17.9 实施记录（2026-08-27）

**实现**：route + reasoningEffort，配置为空 → 全局默认，配置了 → 固定。

- 宿主侧：config.ts 校验（第一个斜杠前 = provider，剩余 = model）；tool-utils defaultModel；index.ts 注入；extract resolveRoute 三级。
- 客户端：FIELDS 2 项 dynamic-select + useModelOptions hook + 保存空串 → unset。
- 测试 98 → 103。

### 17.10 修复记录（2026-08-27，用户验收反馈：下拉只有"跟随全局默认"）

两个根因：
1. **dynamic 标记缺失**：FIELDS 没写 `dynamic: 'route'`/`dynamic: 'effort'`，FieldRow 把两个都当 effort。修复：补标记。
2. **模型 id 含斜杠**：route 拼成三段（commandcode/deepseek/deepseek-v4-flash）。修复：放宽校验为「首段 = provider，剩余 = model」。

测试 103 → 104。

### 17.11 提取空回复根因与修复（2026-08-28）

**现象**：`reasoningEffort: high` 后 parse-error-recovered 率飙到 ~85%。

**诊断**（failed-answers.log）：12 条失败全部空文本（textLen=0）；对照成功/失败 token 数（成功 output 502–631，失败 1173–1531）。

**根因**：`EXTRACTION_MAX_TOKENS = 1024` + high 推理 → 模型把预算全花在 thinking 上，正文出不来 → 空回复 → 走 repair。

**修复**：1024 → 4096（commit 768ce42）。

**验证**：重启后 5 次提取全部 llmCalls=1 直接成功，failed-answers 零新增。

**附带发现**：旧代码下还有 6 条非空失败是缺字段（create decision requires category/title/content）；4096 后未再出现。

**诊断设施**：`MemoryStore.appendFailedAnswer`（failed-answers.log，封顶滚动）。

---

## 18. 提取治理（A/B/C，2026-08-28/29）

> 背景：提取质量治理——记忆碎片化（commandcode 需求被记成 10 个文件、同一 bug 记 4 个文件）+ 事件类膨胀（46 个）+ 过程性流水账。

### 18.1 方案 A：收紧提取判定（2026-08-28，commit b01cfce）

**改动**：`src/extract/prompt.ts` 的 `extractionSystem()` 加 **NOT WORTH REMEMBERING 清单（5 条）** + PRIORITY 规则：

1. 调试/实现过程（路径、行号、报错、fix 步骤）→ 可复用才记 experiences，一次性 skip。
2. 进行中/临时状态（"正在实现 X"、"方案待定"）→ 定论后才记。
3. 纯 changelog 事件（"发布了 v0.5.2"）→ 影响未来工作才记。
4. 过程性讨论 → 产出可复用结论才记。
5. 已覆盖信息（grep 已命中且无新事实）→ skip。

PRIORITY：拿不准时 skip 优先于 create。只记几周后仍有用的事实/决策。

**验证**：tsc + 104/104 全绿 + build + 推送。

### 18.2 方案 B：全库索引促 merge（2026-08-28，commit 1239616）

**动机**：碎片化根因是模型每次提取"盲写"——看不到全库，每次生成新标题就新建文件。

**改动**：
1. `src/extract/index.ts`：`extractOnce` 读 `store.readIndex(peer)`（复用现有 `_index.md`，零新增维护）。
2. `src/extract/prompt.ts`：`buildExtractionUser` 新增 `indexEntries` 参数，渲染 `## 记忆库现有文件（全库索引）` 段。
3. 系统指令加 **EXISTING MEMORY RULES**：已有文件覆盖同主题 → merge 不 create；create 仅当索引无覆盖；merge 只加新事实；矛盾用 update。

**成本**：每次提取 +~1200 tokens 输入（几乎可忽略）。

**验证**：tsc + 105/105 全绿 + 推送。

### 18.3 双重 .md 后缀修复（2026-08-29，commit 614a406）

**现象**：模型 create 时 title 带 `.md` 后缀 → `foo.md.md`。

**修复**：`applyDecision` create 分支 `title.replace(/\.md$/i, '')` + 存量改名（officecli 文件 + 索引同步）。

**验证**：106/106 全绿 + 推送。

### 18.4 方案 C：存量清理（2026-08-29）

**盘点**：88 个文件 → 6 组重复合并（10 个吸收）+ 15 个流水账归档 → **75 个**。

- 合并：bullet 去重追加进保留文件。
- 归档：移入 `~/.agent-memory/.trash/2026-08-29/`（可恢复）。
- 重建 `_index.md`（Total: 75，mtime 排序）。

---

## 19. 后续待办

- **重启 dsh** 加载新 lib（方案 A/B/C + 双重后缀修复生效）。
- 观察新提取质量：extraction.log 中 `skip` 占比应上升、`merge` 占比应上升、`create` 下降。
- 偏差 16（llm-error 静默跳过）与偏差 17（create 竞态）——用户已记录"更值得处理"，待评估。
- PTC 工具呈现适配（§10.1 已知问题）。
