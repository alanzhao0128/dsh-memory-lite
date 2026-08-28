// dsh-memory-lite — browser half.
//
// Two surfaces:
//  1. A compact session-header indicator (conversation.session.header.utilities)
//     beside the built-in "Session log" capsule: label + 3-state dot
//     (green ok / red error / gray disabled), polling /memory-status every
//     10s; a failed poll renders red (plugin unreachable).
//  2. A settings page (settings.section) editing the dsh-memory-lite
//     namespace through ctx.settingsScope: staged drafts + Save/Discard,
//     like the official plugin cards.
//
// Hand-written classic-script bundle: the module table answers require() for
// react / react/jsx-runtime only; everything else is inlined. No build step,
// no CSS files — inline styles with design-system variables.

window.__ModuleLoader__.load({
  id: 'dsh-memory-lite',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const { jsx, jsxs } = require('react/jsx-runtime');
    const { useCallback, useEffect, useState } = require('react');

    const POLL_MS = 10000;
    const LABEL = 'memory-lite';
    const NS = 'dsh-memory-lite';

    const dotColor = {
      ok: 'var(--dsw-alias-state-success-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      disabled: 'var(--dsw-alias-label-tertiary)',
    };

    const fmtTime = (at) => {
      if (!at) return '';
      const d = new Date(at);
      const p = (n) => String(n).padStart(2, '0');
      return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    };

    const tooltipOf = (down, snap) => {
      if (down) return 'memory-lite: 插件不可达（red）';
      if (!snap) return LABEL;
      if (snap.status === 'disabled') return 'memory-lite: 提取未启用（mode: ' + snap.mode + '）';
      if (snap.status === 'error') {
        const last = snap.last || {};
        return 'memory-lite: 异常（' + (last.note || last.outcome || '未知错误') + '）@ ' + fmtTime(last.at);
      }
      if (snap.last) return 'memory-lite: 正常 · 上次 ' + (snap.last.outcome || '') + ' @ ' + fmtTime(snap.last.at);
      return 'memory-lite: 正常（尚无运行）';
    };

    // ---- header status dot (order reads the settings namespace) ----

    function StatusDot({ connection }) {
      const [snap, setSnap] = useState(null);
      const [down, setDown] = useState(false);

      const tick = useCallback(async () => {
        try {
          const result = await connection.rpc.call('/memory-status', 'snapshot', {});
          if (result && result.ok && result.value) {
            setSnap(result.value);
            setDown(false);
          } else {
            setDown(true);
          }
        } catch {
          setDown(true);
        }
      }, [connection]);

      useEffect(() => {
        tick();
        const timer = window.setInterval(tick, POLL_MS);
        const onVisible = () => {
          if (document.visibilityState === 'visible') tick();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
          window.clearInterval(timer);
          document.removeEventListener('visibilitychange', onVisible);
        };
      }, [tick]);

      const status = down ? 'error' : snap ? snap.status : 'ok';
      const color = dotColor[status] || dotColor.ok;
      const title = tooltipOf(down, snap);

      const dot = jsx('span', {
        style: { width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 },
      });

      // The header utilities row is horizontal; match the 32px capsule chrome
      // of the built-in "Session log" button so the pair reads as one cluster.
      return jsx('div', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6,
          height: 32, padding: '0 12px', boxSizing: 'border-box',
          borderRadius: 18, border: '1px solid var(--dsw-alias-border-l2)',
          background: 'transparent', cursor: 'default', flexShrink: 0,
          whiteSpace: 'nowrap',
        },
        title,
        children: [jsx('span', {
          style: { fontSize: 12, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' },
          children: LABEL,
        }), dot],
      });
    }

    // ---- settings page (方案 A §16) ----

    // Every config field editable in the settings panel. Fields with
    // live=false are restart-applies (root/sharing): the host keeps the store
    // snapshot until the next boot, so the UI labels them and persists anyway.
    const GROUPS = [
      { id: 'extraction', label: '记忆提取' },
      { id: 'index', label: '目录注入（index）' },
      { id: 'ui', label: '界面（ui）' },
      { id: 'general', label: '存储与共享' },
    ];

    // sub groups the extraction fields into related clusters so the panel
    // reads as features rather than a flat dump; undefined sub = rendered
    // directly under the group heading.
    const FIELDS = [
      { path: ['extraction', 'mode'], type: 'select', group: 'extraction', label: '提取模式', options: [['incremental', 'incremental（增量）'], ['explicit_only', 'explicit_only（仅显式）'], ['off', 'off（关闭）']], hint: 'incremental = 隐式提取开启；explicit_only/off 时指示器置灰' },
      // ---- 触发方式 ----
      { path: ['extraction', 'windowTurns'], type: 'number', group: 'extraction', sub: '触发方式', label: '窗口触发（消息数）', hint: '新增 surface 消息数 ≥ 此值触发一次提取；0 = 每条消息立即触发（非禁用）' },
      { path: ['extraction', 'idleTimeoutMin'], type: 'number', group: 'extraction', sub: '触发方式', label: '空闲兜底（分钟）', hint: '空闲 N 分钟后提取剩余窗口；0 = 空闲立即提取（非禁用）' },
      { path: ['extraction', 'turnStoppingTrigger'], type: 'toggle', group: 'extraction', sub: '触发方式', label: '回合边界触发', hint: 'agent/turn-stopping 时触发提取（成本较高）；依赖下面的最小消息数' },
      { path: ['extraction', 'flushTrigger'], type: 'toggle', group: 'extraction', sub: '触发方式', label: '会话落盘触发', hint: 'session/flush 时触发提取' },
      { path: ['extraction', 'minTurnExtract'], type: 'number', group: 'extraction', sub: '触发方式', label: '回合边界最小消息数', hint: '回合/落盘触发的未提取消息下限；0 = 无条件触发' },
      { path: ['extraction', 'turnDebounceMs'], type: 'number', group: 'extraction', sub: '触发方式', label: '回合防抖（毫秒）', hint: '回合边界提取的防抖窗口；0 = 无防抖，每次都触发' },
      // ---- 提取内容 ----
      { path: ['extraction', 'maxMessages'], type: 'number', group: 'extraction', sub: '提取内容', label: '单次消息上限', hint: '单次提取喂给 LLM 的最大消息数；0 = 窗口为空，不提取（等效禁用）' },
      { path: ['extraction', 'toolResultMaxBytes'], type: 'number', group: 'extraction', sub: '提取内容', label: '工具结果截断（字节）', hint: '每条 tool_result 喂给 LLM 前的截断；0 = 工具内容全部丢弃' },
      { path: ['extraction', 'includeDigest'], type: 'toggle', group: 'extraction', sub: '提取内容', label: '携带会话摘要', hint: '提取时携带滚动会话 digest' },
      { path: ['extraction', 'dedup'], type: 'toggle', group: 'extraction', sub: '提取内容', label: '去重检索', hint: '提取前 grep 已有记忆做去重/矛盾判断' },
      // ---- 提取模型 ----
      { path: ['extraction', 'llm', 'route'], type: 'dynamic-select', dynamic: 'route', group: 'extraction', sub: '提取模型', label: '提取模型', hint: '提取运行的模型；跟随全局默认 = 用 agent-default-model 当前值（活）' },
      { path: ['extraction', 'llm', 'reasoningEffort'], type: 'dynamic-select', dynamic: 'effort', group: 'extraction', sub: '提取模型', label: '推理强度', hint: '跟随全局默认 = 用默认模型的推理强度；选项按所选模型的配置读取' },
      // ---- 可靠性 ----
      { path: ['extraction', 'parseRetry'], type: 'toggle', group: 'extraction', sub: '可靠性', label: '解析失败重试', hint: 'JSON 解析失败时一次廉价 repair 调用' },
      { path: ['extraction', 'auditLog'], type: 'toggle', group: 'extraction', sub: '可靠性', label: '审计日志', hint: '写 peers/{peer}/sessions/{id}.json' },
      { path: ['extraction', 'maxConcurrentRequests'], type: 'number', group: 'extraction', sub: '可靠性', label: '并发提取上限', hint: '预留字段，当前未接线（改动不生效）' },
      { path: ['index', 'maxTokens'], type: 'number', group: 'index', label: '目录 token 上限', hint: 'L0 目录近似 token 上限，超出截断；最小 50，低于会被拒绝' },
      { path: ['ui', 'headerOrder'], type: 'number', group: 'ui', label: '指示器位置', hint: '会话标题栏 utilities 槽顺序（越小越靠左）；保存后刷新页面生效（槽注册期快照）' },
      { path: ['root'], type: 'text', group: 'general', label: '记忆根目录', hint: '重启生效；MemoryStore 构造时固定' },
      { path: ['defaultPeer'], type: 'text', group: 'general', label: '默认 peer', hint: '无 cwd 时的 peer 名（live）' },
      { path: ['sharing', 'enabled'], type: 'toggle', group: 'general', label: '跨 peer 共享', hint: '总开关，重启生效；具体共享哪些 peer 由 sharing.mounts 决定（见下方列表）' },
    ];

    const pathKey = (path) => path.join('.');

    // Schema/resolve defaults mirrored from src/config.ts. The settings service
    // resolves the namespace with schemastery (which fills nothing for absent
    // keys), so the panel shows these when the stored document has no value —
    // the same defaults the host's resolveConfig applies.
    const DEFAULTS = {
      'root': '~/.agent-memory',
      'defaultPeer': 'dsh-web',
      'workspacePeers.enabled': true,
      'workspacePeers.excludeSubagents': true,
      'workspacePeers.cwdFallback': 'default_peer',
      'index.maxTokens': 1200,
      'tools.schemaMinimal': true,
      'extraction.mode': 'incremental',
      'extraction.windowTurns': 20,
      'extraction.idleTimeoutMin': 30,
      'extraction.maxMessages': 20,
      'extraction.toolResultMaxBytes': 2048,
      'extraction.includeDigest': true,
      'extraction.dedup': true,
      'extraction.turnStoppingTrigger': true,
      'extraction.flushTrigger': true,
      'extraction.minTurnExtract': 5,
      'extraction.turnDebounceMs': 30000,
      'extraction.auditLog': true,
      'extraction.maxConcurrentRequests': 1,
      'extraction.parseRetry': true,
      'extraction.llm.route': '',
      'extraction.llm.reasoningEffort': '',
      'sharing.enabled': false,
      'ui.headerOrder': -1,
    };

    // Read a nested value by path (undefined when absent).
    const readPath = (obj, path) => {
      let cur = obj;
      for (const part of path) {
        if (cur === null || typeof cur !== 'object') return undefined;
        cur = cur[part];
      }
      return cur;
    };

    const rowStyle = { marginBottom: 12, maxWidth: 420 };
    const labelStyle = { display: 'block', fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', marginBottom: 4 };
    const hintStyle = { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)', marginTop: 3 };
    const inputStyle = {
      width: '100%', boxSizing: 'border-box', height: 28, padding: '0 8px',
      borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent', color: 'var(--dsw-alias-label-primary)',
      fontSize: 13, lineHeight: '20px', outline: 'none',
    };

    // ---- 提取模型下拉数据源 (§17) ----
    // Pulls the registered provider/model catalog (api.llm.models) and the live
    // global default selection (agent-default-model settings scope) once per
    // mount. Builds the two dynamic dropdown option sets:
    //  - routeOptions: [['', '跟随全局默认（当前：<provider> / <model>）'], ...all '<provider> / <model>']
    //  - effortOptionsFor(route): efforts of the selected model, prefixed with the
    //    '跟随全局默认' empty option (the model's defaultEffort when absent).
    function useModelOptions(connection, agentDefaultScope) {
      const [catalog, setCatalog] = useState(null); // { groups: [{id,name,models:[{id,name,reasoning}]}] }
      const [failed, setFailed] = useState(false);
      const [, force] = useState(0);

      useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const res = await connection.api.llm.models({});
            if (!alive) return;
            if (res && res.result && res.result.ok) {
              setCatalog(res.result.value);
              setFailed(false);
              if (!res.result.value || !res.result.value.groups || res.result.value.groups.length === 0) {
                console.warn('[memory-lite] llm.models returned empty groups', res.result.value);
              }
            } else {
              console.warn('[memory-lite] llm.models non-ok:', res && res.result ? res.result : res);
              setFailed(true);
            }
          } catch (err) {
            if (alive) {
              console.error('[memory-lite] llm.models failed:', err);
              setFailed(true);
            }
          }
        };
        void load();
        return () => { alive = false; };
      }, [connection]);

      useEffect(() => {
        if (!agentDefaultScope) return undefined;
        return agentDefaultScope.subscribe(() => { force((n) => n + 1); });
      }, [agentDefaultScope]);

      const defSnap = agentDefaultScope ? agentDefaultScope.getSnapshot() : null;
      const defValue = defSnap && defSnap.status === 'ready' ? defSnap.value : undefined;
      const defProvider = defValue ? defValue.provider : undefined;
      const defModel = defValue ? defValue.model : undefined;
      const defRoute = (defProvider && defModel) ? defProvider + '/' + defModel : '';

      const routeOptions = [];
      if (defRoute !== '') {
        routeOptions.push(['', '跟随全局默认（当前：' + defRoute + '）']);
      } else {
        routeOptions.push(['', '跟随全局默认']);
      }
      if (catalog && !failed) {
        for (const group of catalog.groups || []) {
          for (const model of group.models || []) {
            routeOptions.push([group.id + '/' + model.id, group.id + ' / ' + model.id]);
          }
        }
      }

      // For one selected route, find its model's reasoning efforts.
      const effortOptionsFor = (route) => {
        const opts = [['', '跟随全局默认']];
        if (!catalog || failed || !route || route === '') return opts;
        const slash = route.indexOf('/');
        if (slash <= 0) return opts;
        const gid = route.slice(0, slash);
        const mid = route.slice(slash + 1);
        const group = (catalog.groups || []).find((g) => g.id === gid);
        const model = group && (group.models || []).find((m) => m.id === mid);
        const reasoning = model && model.reasoning;
        if (reasoning && reasoning.efforts && reasoning.efforts.length > 0) {
          for (const eff of reasoning.efforts) {
            opts.push([eff.id, eff.name + (eff.description ? '（' + eff.description + '）' : '')]);
          }
        }
        return opts;
      };

      return { routeOptions, effortOptionsFor, failed };
    }

    function FieldRow({ spec, value, draft, onChange, modelOptions }) {
      const key = pathKey(spec.path);
      const staged = draft[key];
      const shown = staged !== undefined ? staged : value;

      let control;
      if (spec.type === 'toggle') {
        control = jsx('input', {
          type: 'checkbox',
          checked: shown === true,
          onChange: (e) => { onChange(key, e.target.checked); },
          style: { width: 16, height: 16, accentColor: 'var(--dsw-alias-state-business-primary)' },
        });
      } else if (spec.type === 'select') {
        control = jsx('select', {
          value: String(shown ?? ''),
          onChange: (e) => { onChange(key, e.target.value); },
          style: inputStyle,
          children: (spec.options || []).map(([optValue, optLabel]) =>
            jsx('option', { value: optValue, children: optLabel, key: optValue })),
        });
      } else if (spec.type === 'dynamic-select') {
        // Route dropdown: 跟随全局默认 + all registered provider/model pairs.
        // Effort dropdown: options for the currently-selected route (draft or
        // stored), falling back to the global default's effort when route unset.
        let options;
        if (spec.dynamic === 'route') {
          options = modelOptions ? modelOptions.routeOptions : [];
        } else {
          const routeKey = 'extraction.llm.route';
          const routeVal = draft[routeKey] !== undefined ? draft[routeKey] : value;
          options = modelOptions && modelOptions.effortOptionsFor ? modelOptions.effortOptionsFor(routeVal) : [];
        }
        control = jsx('select', {
          value: String(shown ?? ''),
          onChange: (e) => { onChange(key, e.target.value); },
          style: inputStyle,
          children: (options || []).map(([optValue, optLabel]) =>
            jsx('option', { value: optValue, children: optLabel, key: optValue })),
        });
      } else {
        control = jsx('input', {
          type: 'text',
          value: shown === undefined || shown === null ? '' : String(shown),
          inputMode: spec.type === 'number' ? 'numeric' : undefined,
          placeholder: spec.type === 'number' ? '0' : '',
          onChange: (e) => { onChange(key, e.target.value); },
          style: inputStyle,
        });
      }

      return jsx('div', { style: rowStyle, children: [
        jsx('label', { style: labelStyle, children: spec.label }),
        control,
        jsx('div', { style: hintStyle, children: spec.hint || '' }),
      ]});
    }

    function SettingsPage({ scope, connection, agentDefaultScope }) {
      const [draft, setDraft] = useState({});
      const [saving, setSaving] = useState(false);
      const [saved, setSaved] = useState(false);
      const [failed, setFailed] = useState(false);
      const [, force] = useState(0);

      const modelOptions = useModelOptions(connection, agentDefaultScope);

      useEffect(() => {
        if (!scope) return undefined;
        return scope.subscribe(() => { force((n) => n + 1); });
      }, [scope]);

      const snapshot = scope ? scope.getSnapshot() : null;
      const value = snapshot && snapshot.status === 'ready' ? snapshot.value : undefined;
      const writable = snapshot ? snapshot.writable : false;

      const setField = (key, val) => {
        setDraft((d) => ({ ...d, [key]: val }));
        setSaved(false);
        setFailed(false);
      };

      const fieldValue = (spec) => {
        const key = pathKey(spec.path);
        if (draft[key] !== undefined) return draft[key];
        const stored = readPath(value, spec.path);
        return stored !== undefined ? stored : DEFAULTS[key];
      };

      const save = async () => {
        if (!scope || Object.keys(draft).length === 0) return;
        setSaving(true);
        setFailed(false);
        try {
          const ops = Object.entries(draft).map(([key, val]) => {
            const path = key.split('.');
            const spec = FIELDS.find((f) => pathKey(f.path) === key);
            if (spec && spec.type === 'number') {
              if (val === '' || val === null || val === undefined) {
                return { op: 'unset', path };
              }
              const n = Number(val);
              if (!Number.isFinite(n)) return null;
              return { op: 'set', path, value: n };
            }
            if (spec && (spec.type === 'text' || spec.type === 'dynamic-select') && (val === '' || val === null || val === undefined)) {
              return { op: 'unset', path };
            }
            return { op: 'set', path, value: val };
          }).filter(Boolean);
          if (ops.length === 0) { setSaving(false); return; }
          const revision = scope.getSnapshot().revision;
          const response = await connection.api.settings.mutate({
            ns: NS,
            ops,
            ...(revision === undefined ? {} : { expectedRevision: revision }),
          });
          if (!response.result.ok) {
            setFailed(true);
          } else {
            setDraft({});
            setSaved(true);
          }
        } catch {
          setFailed(true);
        } finally {
          setSaving(false);
        }
      };

      const discard = () => {
        setDraft({});
        setSaved(false);
        setFailed(false);
      };

      // Render one group; fields cluster under optional `sub` sub-headings.
      const renderGroup = (group) => {
        const fields = FIELDS.filter((f) => f.group === group.id);
        if (fields.length === 0) return null;
        const subHeading = (title) => jsx('div', {
          style: { fontSize: 12, fontWeight: 600, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', margin: '14px 0 6px' },
          children: title,
        });
        const children = [];
        let lastSub;
        for (const spec of fields) {
          if (spec.sub !== lastSub) {
            if (spec.sub !== undefined) children.push(subHeading(spec.sub));
            lastSub = spec.sub;
          }
          children.push(jsx(FieldRow, {
            key: pathKey(spec.path),
            spec,
            value: fieldValue(spec),
            draft,
            onChange: setField,
            modelOptions,
          }));
        }
        return jsx('div', { key: group.id, style: { marginBottom: 20 }, children: [
          jsx('div', { style: { fontSize: 13, fontWeight: 600, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', margin: '0 0 10px' }, children: group.label }),
          ...children,
        ]});
      };

      const groups = GROUPS.map(renderGroup);

      const dirty = Object.keys(draft).length > 0;

      const footer = jsx('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }, children: [
        jsx('button', {
          type: 'button',
          onClick: () => { void save(); },
          disabled: !dirty || saving || !writable,
          style: {
            height: 30, padding: '0 16px', borderRadius: 8, cursor: dirty && !saving && writable ? 'pointer' : 'default',
            border: '1px solid var(--dsw-alias-state-business-primary)',
            background: 'var(--dsw-alias-state-business-primary)',
            color: 'var(--dsw-alias-label-primary-inverted)',
            fontSize: 13, fontWeight: 500,
          },
          children: saving ? '保存中…' : '保存',
        }),
        jsx('button', {
          type: 'button',
          onClick: discard,
          disabled: !dirty || saving || !writable,
          style: {
            height: 30, padding: '0 16px', borderRadius: 8, cursor: dirty && !saving && writable ? 'pointer' : 'default',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'transparent',
            color: 'var(--dsw-alias-label-primary)',
            fontSize: 13,
          },
          children: '放弃修改',
        }),
        saved ? jsx('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' }, children: '已保存（部分参数重启后生效）' }) : null,
        failed ? jsx('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }, children: '保存失败' }) : null,
      ]});

      if (!writable) {
        return jsx('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' }, children: '设置文档不可写（只读环境）。' });
      }

      // Read-only view of the sharing mounts: which peer is shared and how.
      // The mounts array itself is edited in ~/.dsh/settings.yaml for now.
      const mounts = (value && value.sharing && value.sharing.mounts) || [];
      const mountsBlock = jsx('div', { style: { marginBottom: 20 }, children: [
        jsx('div', { style: { fontSize: 13, fontWeight: 600, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', margin: '0 0 10px' }, children: '共享挂载（sharing.mounts，只读）' }),
        mounts.length === 0
          ? jsx('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }, children: '未配置共享挂载。' })
          : jsx('div', { children: mounts.map((mount, i) => jsx('div', {
            key: i,
            style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', marginBottom: 4, fontFamily: 'var(--ds-font-family-code)' },
            children: 'shared/' + mount.name + '/ → peer ' + mount.peer + (mount.subpath ? '/' + mount.subpath : '') + (mount.readonly ? '（只读）' : '（可写）'),
          })) }),
        jsx('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)', marginTop: 4 }, children: '挂载列表需在 ~/.dsh/settings.yaml 的 dsh-memory-lite.sharing.mounts 中编辑。' }),
      ]});

      return jsx('div', { children: [
        ...groups.filter(Boolean),
        mountsBlock,
        footer,
      ]});
    }

    const inject = ['connection', 'slots', 'settingsScope'];

    function apply(ctx, config) {
      const connection = ctx.get('connection');
      const scope = ctx.get('settingsScope').bind({ namespace: NS });

      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
        {
          name: 'conversation.session.header.utilities',
          id: 'memory-lite-status',
          order: -1,
          inject: () => ({ connection, scope }),
        },
        StatusDot,
      ));

      const agentDefaultScope = ctx.get('settingsScope').bind({ namespace: 'agent-default-model' });
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: 'memory-lite',
          order: 100,
          label: () => 'memory-lite',
          inject: () => ({ connection, scope, agentDefaultScope }),
        },
        SettingsPage,
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
