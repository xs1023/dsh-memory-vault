/**
 * dsh-memory-vault — 外置记忆库插件（宿主半侧）
 *
 * 为 dsh 注入一组长期记忆工具：
 *   memory_add / memory_list / memory_search / memory_show
 *   memory_update / memory_delete / memory_archive / memory_restore
 *   memory_categories / memory_stats / memory_rename_category
 *   memory_search_history / memory_list_conversations
 *   memory_list_permanent / memory_promote_permanent
 *   memory_add_preset / memory_list_preset / memory_promote_preset
 * 并自动把每次完整对话保存成一条“对话记录”，
 * 同时按“短期 → 中期 → 长期 → 永久”分层压缩上下文。
 * 全局“预设/用户记忆”会在每个会话开始时自动注入。
 *
 * 数据保存在 ~/.dsh/memory/memory.db，与当前工作区无关。
 */

import {
  openDb,
  addEntry,
  getEntry,
  listEntries,
  updateEntry,
  setArchived,
  deleteEntry,
  listCategories,
  getStats,
  renameCategory,
  upsertConversationEntry,
  formatList,
  formatEntry,
  workspaceLabel,
} from './src/db.js';

import { randomUUID } from 'node:crypto';

/**
 * 本地迷你版 defineTool。
 *
 * dsh 插件在本地开发目录里无法直接解析 @deepseek-ai/dsh-tools，
 * 这里用等价的最小实现构造工具定义：把简写参数表转成标准 JSON Schema。
 */
function defineTool(options) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(options.parameters || {})) {
    const property = { type: spec.type };
    if (spec.description !== undefined) property.description = spec.description;
    if (spec.items !== undefined) property.items = spec.items;
    properties[key] = property;
    if (spec.required === true) required.push(key);
  }
  const parameters = { type: 'object', properties };
  if (required.length > 0) parameters.required = required;

  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: options.output.schema,
      render: options.output.render,
    },
    async execute(args, exec) {
      return options.execute(args, exec);
    },
  };
}

// 从 dsh 消息里提取纯文本（兼容字符串和分块数组两种格式）
function extractMessageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content.trim();
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }
  return '';
}

// 真正由人提交的 user 消息只有这两类 source.kind：客户端提交（user）与问答回复
// （user-question-reply）。DSH 会把宿主注入也放进 user/message 事件里 —— 运行时上下文
// （runtime-context）、AGENTS.md（agent-instructions）、压缩检查点（compact-checkpoint）、
// goal 轮次、团队消息、webhook 等 —— 它们同样 role:'user'，只能靠 kind 区分。
// 所以 user 一侧用白名单：将来 DSH 新增注入类型也漏不进来。
const HUMAN_USER_KINDS = new Set(['user', 'user-question-reply']);

// 一条“真实对话消息”：排除插件自己注入/折叠出来的上下文、宿主注入的系统消息，以及工具调用细节。
// 写对话记录正文、挑标题、判定未压缩的原始消息，三处必须共用这一套判断 ——
// 否则标题会挑到插件消息（折叠产出的【中期记忆】、会话开头注入的预设记忆）、
// 或宿主注入的 runtime-context，或者把已经压缩过的内容当成原始消息再折一遍。
function isRawChatMessage(message) {
  if (!message) return false;
  const kind = message.source?.kind;
  if (kind === 'dsh-memory-vault' || kind === 'tool') return false;
  if (message.role === 'user') {
    // 不带 source 的消息按普通对话放行（部分入口与测试替身没有 source）
    return kind === undefined || HUMAN_USER_KINDS.has(kind);
  }
  return message.role === 'assistant';
}

/**
 * 会话的项目归属（工作区维度）。
 *
 * DSH 把会话创建时校验过的绝对路径放在 SessionHeader.cwd。拿不到时返回 null，
 * 语义是“没有项目归属”：检索侧会退化成不过滤，而不是静默丢掉记忆。
 */
export function sessionWorkspace(session) {
  return session?.header?.cwd ?? null;
}

/** 工具执行上下文里的项目归属 */
function execWorkspace(exec) {
  return sessionWorkspace(exec?.agent?.session);
}

/**
 * 把工具传入的 scope 归一成 listEntries 认识的三种取值。
 * 未知取值一律退回 current（默认只搜当前项目 + 全局），避免拼错参数就变成全库检索。
 */
export function normalizeScope(value) {
  const scope = String(value ?? '').trim().toLowerCase();
  if (scope === 'global') return 'global';
  if (scope === 'all') return 'all';
  return 'current';
}

// 把一次会话整理成一条“对话记录”并写进记忆库
export async function captureConversation(session, db) {
  if (!session || typeof session.deriveMessages !== 'function') return;
  const derived = session.deriveMessages();
  if (!Array.isArray(derived) || derived.length === 0) return;

  const lines = [];
  for (const message of derived) {
    // 与下面的挑标题共用同一套判断，保证“正文里有的消息”和“标题取自的消息”一致
    if (!isRawChatMessage(message)) continue;

    const text = extractMessageText(message);
    if (!text) continue;
    const label = message.role === 'user' ? '用户' : '助手';
    lines.push(`${label}：${text}`);
  }

  if (lines.length === 0) return;

  // 标题也要过同一层过滤：否则会话开头注入的【预设/用户记忆】、或折叠产出的
  // 【中期记忆】，会因为排在真实用户消息前面而被挑成标题。
  const firstUser = derived.find(
    (message) => isRawChatMessage(message) && message.role === 'user' && extractMessageText(message),
  );
  const firstText = firstUser ? extractMessageText(firstUser) : '';
  const title = firstText
    ? `对话记录：${firstText.slice(0, 40)}${firstText.length > 40 ? '…' : ''}`
    : `对话记录：${new Date().toLocaleString('zh-CN')}`;

  upsertConversationEntry(db, {
    sessionId: String(session.id),
    title,
    content: lines.join('\n\n'),
    category: '对话记录',
    tags: ['自动记录'],
    workspaceId: sessionWorkspace(session),
  });
}

// ── 分层记忆辅助函数 ──────────────────────────────────────────────

// 按 seq 取该表面节点承载的消息。Session 没有 events 数组，只能走 eventAt()。
function eventMessageAt(session, seq) {
  const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : null;
  if (!event) return null;
  return typeof session.deriveEventMessage === 'function'
    ? session.deriveEventMessage(event)
    : null;
}

function surfaceMessageSeqs(session) {
  const nodes = session?.surface?.nodes || [];
  const result = [];
  for (const seq of nodes) {
    const message = eventMessageAt(session, seq);
    if (message) result.push({ seq, message });
  }
  return result;
}

function isTierMessage(message, tier) {
  return Boolean(
    message?.source?.kind === 'dsh-memory-vault'
    && message.source.memoryTier === tier
  );
}

function extractMessagesText(items) {
  return items
    .map((item) => `${item.message.role === 'user' ? '用户' : '助手'}：${extractMessageText(item.message)}`)
    .filter(Boolean)
    .join('\n\n');
}

function pluginMessage(content, tier) {
  // A session message must be a complete UserMessage: `id` is required, and
  // `source.kind` has to be a kind this producer declares itself — the harness
  // has no generic 'plugin' kind, so a bare {role, content} object is dropped.
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: content }],
    source: { kind: 'dsh-memory-vault', memoryTier: tier },
  });
}

// 判断一个会话的可见历史里是否已经注入过预设。
// 这是跨进程的幂等依据：dsh 重启后内存标记会丢，但会话历史不会。
// 预设注入带 source.kind='dsh-memory-vault' + memoryTier='preset'，据此精确识别
// （不能用文本前缀匹配 —— 对话正文里讨论这个问题时也会出现同样的字样）。
function sessionHasPresetInjection(session) {
  try {
    if (typeof session?.deriveMessages !== 'function') return false;
    const derived = session.deriveMessages();
    if (!Array.isArray(derived)) return false;
    return derived.some(
      (message) => message?.source?.kind === 'dsh-memory-vault'
        && message.source.memoryTier === 'preset',
    );
  } catch {
    return false;
  }
}

function summarizeWithLlm(ctx, agent, text, mode) {
  const latest = agent?.session?.requestHeader?.()?.config;
  const agentTarget = agent?.options?.provider && agent?.options?.model
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined;
  const target = latest || agentTarget;
  if (!target?.provider || !target?.model) {
    throw new Error('没有可用的模型配置，无法压缩记忆');
  }

  const instructions = {
    medium: '请把下面的对话内容压缩成一条中期记忆摘要，保留关键事实、用户偏好、决定和教训，使用简洁中文。',
    long: '请把下面多条中期记忆摘要进一步压缩成一条长期记忆摘要，保留最重要、最持久的信息，使用简洁中文。',
    absorb: '以下是即将丢弃的一条长期记忆摘要。请从中提取仍然重要、值得永久保存的事实/偏好/决定/教训。如果没有重要内容，只回复“无”。',
  };

  const options = {
    provider: target.provider,
    model: target.model,
    messages: [pluginMessage(`${instructions[mode] || instructions.medium}\n\n${text}`, 'compress')],
    maxTokens: 1200,
    // sessionId 会被 session-checkpoint-policy 解读为“先 flush 这个会话”。
    // 本函数只在 session/flush 监听器里被调用，所以这个 id 是那条自续循环的
    // 入口；保留它（请求仍入日志、仍计入用量）的前提是监听器有重入护栏。
    sessionId: agent?.session?.id,
    purpose: 'memory-compression',
  };

  return (async () => {
    let output = '';
    for await (const chunk of ctx.llm.stream(options)) {
      if (chunk.type === 'text-delta') output += chunk.text;
    }
    const result = output.trim();
    if (!result) throw new Error('模型没有返回摘要内容');
    return result;
  })();
}

function replaceSurfaceRange(session, selected, replacementMessage) {
  const nodes = session?.surface?.nodes || [];
  const startSeq = selected[0].seq;
  const startIdx = nodes.indexOf(startSeq);
  const initialEndIdx = nodes.indexOf(selected[selected.length - 1].seq);
  if (startIdx === -1 || initialEndIdx === -1 || startIdx > initialEndIdx) {
    throw new Error('找不到可替换的对话范围');
  }

  // tool/result 在 surface 里是独立节点，而它对应的调用写在 assistant 消息体内的
  // tool-call 块里。DeepSeek 适配器按「遇到 assistant 消息就重置 pending」核对配对，
  // 范围起点是消息节点（不会是 tool/result），所以起点安全；但终点若停在某个
  // assistant 消息上，紧随其后的 tool 结果就会悬空 → 请求被判 INVALID_REQUEST
  // （"tool result has no matching call"），此后该会话每一个请求都会失败。
  // 因此终点必须把属于本次折叠的 tool 结果一并吞进来。
  let endIdx = initialEndIdx;
  while (endIdx + 1 < nodes.length && eventMessageAt(session, nodes[endIdx + 1])?.role === 'tool') {
    endIdx += 1;
  }

  const endSeq = nodes[endIdx];
  const shadowedSeqs = nodes.slice(startIdx, endIdx + 1);
  session.append('user/message', replacementMessage, {
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: shadowedSeqs,
  });
}

function deleteDbEntriesByText(db, sessionId, category, texts) {
  // listEntries() is a summary query and does not select `content`, so the
  // comparison has to run against the full entry — matching row.content here
  // always compared against undefined and never deleted anything.
  const rows = listEntries(db, { category, sessionId });
  for (const row of rows) {
    const full = getEntry(db, row.id);
    if (full && texts.includes(full.content)) {
      deleteEntry(db, row.id);
    }
  }
}

export async function maybeCompressSession(ctx, agent, session, db, tierConfig) {
  if (!agent || !session) return;

  // 本会话的项目归属：分层记忆与对话记录同属一个工作区
  const workspaceId = sessionWorkspace(session);

  // 短期 → 中期
  const allItems = surfaceMessageSeqs(session);
  const rawItems = allItems.filter((item) => isRawChatMessage(item.message));
  if (rawItems.length > tierConfig.shortTermLimit) {
    const selected = rawItems.slice(0, tierConfig.shortTermCompressCount);
    const text = extractMessagesText(selected);
    const summary = await summarizeWithLlm(ctx, agent, text, 'medium');
    const replacement = pluginMessage(`【中期记忆】${summary}`, 'medium');
    replaceSurfaceRange(session, selected, replacement);
    addEntry(db, {
      title: `中期记忆：${summary.slice(0, 30)}${summary.length > 30 ? '…' : ''}`,
      content: summary,
      category: '中期记忆',
      tags: ['自动压缩'],
      sessionId: String(session.id),
      workspaceId,
    });
  }

  // 中期 → 长期
  const afterShort = surfaceMessageSeqs(session);
  const mediumItems = afterShort.filter((item) => isTierMessage(item.message, 'medium'));
  if (mediumItems.length > tierConfig.mediumTermLimit) {
    const selected = mediumItems.slice(0, tierConfig.mediumTermCompressCount);
    const text = extractMessagesText(selected);
    const summary = await summarizeWithLlm(ctx, agent, text, 'long');
    const replacement = pluginMessage(`【长期记忆】${summary}`, 'long');
    replaceSurfaceRange(session, selected, replacement);
    addEntry(db, {
      title: `长期记忆：${summary.slice(0, 30)}${summary.length > 30 ? '…' : ''}`,
      content: summary,
      category: '长期记忆',
      tags: ['自动压缩'],
      sessionId: String(session.id),
      workspaceId,
    });
    deleteDbEntriesByText(
      db,
      String(session.id),
      '中期记忆',
      selected.map((item) => extractMessageText(item.message)),
    );
  }

  // 长期 → 丢弃前吸收
  const afterMedium = surfaceMessageSeqs(session);
  const longItems = afterMedium.filter((item) => isTierMessage(item.message, 'long'));
  if (longItems.length > tierConfig.longTermLimit) {
    const oldest = longItems[0];
    const oldText = extractMessageText(oldest.message);
    const absorbResult = await summarizeWithLlm(ctx, agent, oldText, 'absorb');
    if (absorbResult && absorbResult !== '无' && !absorbResult.includes('无')) {
      addEntry(db, {
        title: `永久记忆：${absorbResult.slice(0, 30)}${absorbResult.length > 30 ? '…' : ''}`,
        content: absorbResult,
        category: '永久记忆',
        tags: ['自动吸收'],
        sessionId: String(session.id),
        workspaceId,
      });
    }
    replaceSurfaceRange(session, [oldest], pluginMessage('【已归档的长期记忆】', 'discarded'));
    deleteDbEntriesByText(
      db,
      String(session.id),
      '长期记忆',
      [oldText],
    );
  }
}




export const name = 'memory-vault';
export const inject = ['sessions', 'tools', 'llm'];

// 分层压缩的默认阈值。这些数字必须和“下层消息的产出速率”对齐：
// 一次短期折叠要消耗 shortTermCompressCount 条原始消息，才产出 1 条中期消息，
// 所以 mediumTermLimit 不能和 shortTermLimit 同量级 —— 两个都取 20 时，凑够
// 一次“中期 → 长期”要约 (20 + 1) × 10 = 210 条原始消息，真实会话永远到不了，
// 后两级压缩形同死代码。这里按产出速率把后两级调成小数值：
//   5 条中期 ≈ 5 次短期折叠 ≈ 50 条原始消息 → 触发“中期 → 长期”
//   5 条长期 → 被吸收成永久记忆
export function resolveTierConfig(config = {}) {
  return {
    shortTermLimit: Number(config.shortTermLimit) || 20,
    shortTermCompressCount: Number(config.shortTermCompressCount) || 10,
    mediumTermLimit: Number(config.mediumTermLimit) || 4,
    mediumTermCompressCount: Number(config.mediumTermCompressCount) || 3,
    longTermLimit: Number(config.longTermLimit) || 4,
  };
}

export function apply(ctx, config = {}) {
  const db = openDb(config);
  // Agents captured from 'agent/created', keyed by session id. That event is
  // the one path already proven to fire, so it is the primary source; the
  // registry lookup below is only a fallback for sessions created earlier.
  const agentsBySession = new Map();

  const tierConfig = resolveTierConfig(config);

  const logError = (action, error) => {
    ctx.logger.warn(`[memory-vault] ${action} failed: ${String(error?.message || error)}`);
  };

  // 分层压缩的重入护栏。压缩要调 ctx.llm.stream()，而
  // session-checkpoint-policy 会给每个带 sessionId 的 llm/stream 先垫一次
  // ctx.sessions.flush(session) —— 也就是在本监听器内部再触发一次
  // session/flush。递归发生在第一次折叠完成之前，rawItems 永远超限，于是
  // flush → stream → flush 自续不停：每层同步跑一遍 deriveMessages() 和
  // upsertConversationEntry()，把事件循环占死，web 端表现为连得上、没响应。
  const compressing = new Set();

  // 已经注入过预设的会话 id。'agent/created' 会在同一个会话里反复触发，
  // 这个内存标记是第一道闸门（挡住同进程内的重复触发，含消息尚未 splice 的窗口期）。
  const presetInjectedSessions = new Set();

  // 自动把整段对话保存为一条“对话记录”，并执行分层压缩
  ctx.on('session/flush', async (session) => {
    const key = String(session?.id ?? '');
    if (compressing.has(key)) return;
    compressing.add(key);
    try {
      await captureConversation(session, db);
      const agent = agentsBySession.get(key)
        ?? ctx.get?.('agents')?.get?.(session.id);
      if (agent) {
        await maybeCompressSession(ctx, agent, session, db, tierConfig);
      }
    } catch (error) {
      logError('sessionCompress', error);
    } finally {
      compressing.delete(key);
    }
  });

  // 会话开始时注入全局“预设/用户记忆”
  // DSH emits 'agent/created' once an entered agent is ready for per-agent
  // initialization. 'agent/session-start' does not exist, so this listener
  // never ran and the presets were never injected.
  ctx.on('agent/created', ({ agent }) => {
    try {
      const sessionId = agent?.session?.id ?? agent?.sessionId;
      const key = sessionId === undefined || sessionId === null ? null : String(sessionId);
      if (key) agentsBySession.set(key, agent);

      // 预设注入必须幂等。'agent/created' 会在同一个会话里反复触发，而 agent.inject()
      // 只是往 inbox 追加一条 user 消息 —— 旧的不会被替换，于是每次触发都在历史里
      // 多留一份【预设/用户记忆】，随重启次数线性增长（实测同一会话 11 分钟内 3 次）。
      // 两道闸门配合：
      //   1) 内存标记 —— 挡住同进程内的重复触发，含消息尚未 splice 的窗口期；
      //   2) 历史扫描 —— 挡住重启 dsh 后恢复旧会话的情况（此时内存标记已清空）。
      if (key && presetInjectedSessions.has(key)) return;
      if (sessionHasPresetInjection(agent?.session)) {
        if (key) presetInjectedSessions.add(key);
        return;
      }

      const presetRows = listEntries(db, { category: '预设' });
      if (!presetRows.length) return;
      // Same trap: rows are summaries without `content`, so each preset is
      // re-read through getEntry() before it is rendered into the message.
      const text = presetRows
        .map((row) => getEntry(db, row.id))
        .filter(Boolean)
        .map((entry) => `- ${entry.title}\n  ${entry.content}`)
        .join('\n\n');
      agent.inject(pluginMessage(`【预设/用户记忆】\n${text}`, 'preset'));
      if (key) presetInjectedSessions.add(key);
    } catch (error) {
      logError('injectPreset', error);
    }
  });



  ctx.tools.register(defineTool({
    name: 'memory_add',
    description: '向 dsh 外置记忆库新增一条长期记忆。当用户明确说“记住/记一下/存到记忆库”时使用。默认归属当前项目（按会话工作区），scope="global" 时写入全局（跨项目通用）。',
    parameters: {
      title: { type: 'string', required: true, description: '记忆条目标题，简短概括这条记忆。' },
      content: { type: 'string', description: '记忆详细内容。' },
      category: { type: 'string', description: '分类名，默认“未分类”。' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签列表，用于以后筛选。' },
      scope: { type: 'string', description: '归属范围：current（默认，当前项目）或 global（跨项目通用）。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      try {
        const title = String(args.title || '').trim();
        if (!title) return '新增失败：标题不能为空。';
        const wantGlobal = String(args.scope || '').trim().toLowerCase() === 'global';
        const workspaceId = wantGlobal ? null : execWorkspace(exec);
        const id = addEntry(db, {
          title,
          content: String(args.content || ''),
          category: String(args.category || '未分类').trim() || '未分类',
          tags: args.tags,
          workspaceId,
        });
        const where = workspaceId ? `，归属项目：${workspaceLabel(workspaceId)}` : '，归属：全局';
        return `已记住，编号（ID）：${id}${where}`;
      } catch (error) {
        logError('memory_add', error);
        return `新增记忆失败：${error?.message || error}`;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_list',
    description: '列出 dsh 外置记忆库中的记忆条目。默认只列当前项目 + 全局，不包含自动保存的“对话记录”，可按分类、标签筛选。',
    parameters: {
      category: { type: 'string', description: '只列出该分类下的记忆。' },
      tag: { type: 'string', description: '只列出带该标签的记忆。' },
      includeArchived: { type: 'boolean', description: '是否包含已归档条目，默认 false。' },
      includeConversations: { type: 'boolean', description: '是否同时列出“对话记录”，默认 false。' },
      scope: { type: 'string', description: '检索范围：current（默认，当前项目 + 全局）、global（只看全局）、all（所有项目）。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      try {
        const rows = listEntries(db, {
          category: args.category,
          tag: args.tag,
          includeArchived: Boolean(args.includeArchived),
          excludeCategory: args.includeConversations ? undefined : '对话记录',
          workspaceId: execWorkspace(exec),
          workspaceScope: normalizeScope(args.scope),
        });
        return formatList(rows);
      } catch (error) {
        logError('memory_list', error);
        return `列出记忆失败：${error?.message || error}`;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: '在 dsh 外置记忆库中按关键词搜索记忆。当用户要求“回忆/查一下记忆/上次我让你记什么”时使用。默认只搜当前项目 + 全局。',
    parameters: {
      query: { type: 'string', required: true, description: '要搜索的关键词。' },
      includeArchived: { type: 'boolean', description: '是否搜索已归档条目，默认 false。' },
      scope: { type: 'string', description: '检索范围：current（默认，当前项目 + 全局）、global（只看全局）、all（所有项目）。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      try {
        const query = String(args.query || '').trim();
        if (!query) return '搜索失败：关键词不能为空。';
        const rows = listEntries(db, {
          search: query,
          includeArchived: Boolean(args.includeArchived),
          workspaceId: execWorkspace(exec),
          workspaceScope: normalizeScope(args.scope),
        });
        return formatList(rows);
      } catch (error) {
        logError('memory_search', error);
        return `搜索记忆失败：${error?.message || error}`;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_show',
    description: '查看 dsh 外置记忆库中某一条记忆的完整内容。',
    parameters: {
      id: { type: 'integer', required: true, description: '记忆条目编号（ID）。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        const entry = getEntry(db, Number(args.id));
        if (!entry) return '没有找到这个编号的记忆条目。';
        return formatEntry(entry);
      } catch (error) {
        logError('memory_show', error);
        return `查看记忆失败：${error?.message || error}`;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_update',
    description: '修改 dsh 外置记忆库中某一条记忆。只修改传入的字段，不传的字段保持不变。',
    parameters: {
      id: { type: 'integer', required: true, description: '记忆条目编号（ID）。' },
      title: { type: 'string', description: '新标题。' },
      content: { type: 'string', description: '新内容。' },
      category: { type: 'string', description: '新分类。' },
      tags: { type: 'array', items: { type: 'string' }, description: '新标签列表；传入后会替换旧标签。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        const id = Number(args.id);
        const old = getEntry(db, id);
        if (!old) return '没有找到这个编号的记忆条目。';
        const updated = updateEntry(db, id, {
          title: args.title === undefined ? undefined : String(args.title).trim() || old.title,
          content: args.content === undefined ? undefined : String(args.content),
          category: args.category === undefined ? undefined : String(args.category).trim() || '未分类',
        }, args.tags);
        return `已更新记忆条目，编号（ID）：${updated.id}`;
      } catch (error) {
        logError('memory_update', error);
        return `修改记忆失败：${error?.message || error}`;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_archive',
    description: '归档 dsh 外置记忆库中的某一条记忆。归档后默认列表不再显示，但数据仍在。',
    parameters: {
      id: { type: 'integer', required: true, description: '记忆条目编号（ID）。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        const id = Number(args.id);
        return setArchived(db, id, true)
          ? `已归档记忆条目，编号（ID）：${id}`
          : '没有找到这个编号的记忆条目。';
      } catch (error) {
        logError('memory_archive', error);
        return `归档记忆失败：${error?.message || error}`;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_restore',
    description: '恢复 dsh 外置记忆库中一条已归档记忆。',
    parameters: {
      id: { type: 'integer', required: true, description: '记忆条目编号（ID）。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        const id = Number(args.id);
        return setArchived(db, id, false)
          ? `已恢复记忆条目，编号（ID）：${id}`
          : '没有找到这个编号的记忆条目。';
      } catch (error) {
        logError('memory_restore', error);
        return `恢复记忆失败：${error?.message || error}`;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_delete',
    description: '永久删除 dsh 外置记忆库中的某一条记忆。必须传 confirm=true 才会真正删除。',
    parameters: {
      id: { type: 'integer', required: true, description: '记忆条目编号（ID）。' },
      confirm: { type: 'boolean', required: true, description: '确认删除，必须为 true。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        if (args.confirm !== true) return '删除已取消：需要 confirm=true 才会永久删除。';
        const id = Number(args.id);
        return deleteEntry(db, id)
          ? `已删除记忆条目，编号（ID）：${id}`
          : '没有找到这个编号的记忆条目。';
      } catch (error) {
        logError('memory_delete', error);
        return `删除记忆失败：${error?.message || error}`;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_categories',
    description: '列出 dsh 外置记忆库中目前有哪些分类，以及每个分类的条目数量。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      try {
        const rows = listCategories(db);
        if (!rows.length) return '（记忆库还没有分类）';
        return rows.map((row) => `${row.category}｜${row.count} 条`).join('\n');
      } catch (error) {
        logError('memory_categories', error);
        return `读取分类失败：${error?.message || error}`;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_stats',
    description: '查看 dsh 外置记忆库的统计信息：总条目、正常条目、已归档条目、分类数量、标签数量。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      try {
        const stats = getStats(db);
        return [
          `总条目：${stats.total}`,
          `正常条目：${stats.active}`,
          `已归档条目：${stats.archived}`,
          `分类数量：${stats.categoryCount}`,
          `标签数量：${stats.tagCount}`,
        ].join('\n');
      } catch (error) {
        logError('memory_stats', error);
        return `读取统计失败：${error?.message || error}`;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_rename_category',
    description: '重命名 dsh 外置记忆库中的一个分类，该分类下的所有记忆会一起移动到新分类。',
    parameters: {
      oldName: { type: 'string', required: true, description: '旧分类名。' },
      newName: { type: 'string', required: true, description: '新分类名。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        const oldName = String(args.oldName || '').trim();
        const newName = String(args.newName || '').trim();
        if (!oldName || !newName) return '重命名失败：旧分类名和新分类名都不能为空。';
        if (oldName === newName) return '旧分类和新分类相同，没有需要改的。';
        const count = renameCategory(db, oldName, newName);
        return `已把分类“${oldName}”重命名为“${newName}”，共影响 ${count} 条记忆。`;
      } catch (error) {
        logError('memory_rename_category', error);
        return `重命名分类失败：${error?.message || error}`;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_search_history',
    description: '在自动保存的“对话记录”里搜索历史对话。当用户问“之前说过什么/上次聊了什么/查一下历史”时使用。默认只搜当前项目 + 全局。',
    parameters: {
      query: { type: 'string', required: true, description: '要搜索的关键词。' },
      includeArchived: { type: 'boolean', description: '是否搜索已归档记录，默认 false。' },
      scope: { type: 'string', description: '检索范围：current（默认，当前项目 + 全局）、global（只看全局）、all（所有项目）。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      try {
        const query = String(args.query || '').trim();
        if (!query) return '搜索失败：关键词不能为空。';
        const rows = listEntries(db, {
          category: '对话记录',
          search: query,
          includeArchived: Boolean(args.includeArchived),
          workspaceId: execWorkspace(exec),
          workspaceScope: normalizeScope(args.scope),
        });
        return formatList(rows);
      } catch (error) {
        logError('memory_search_history', error);
        return `搜索历史对话失败：${error?.message || error}`;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_list_conversations',
    description: '列出自动保存的“对话记录”条目，方便查看有哪些历史对话。默认只列当前项目 + 全局。',
    parameters: {
      includeArchived: { type: 'boolean', description: '是否包含已归档记录，默认 false。' },
      scope: { type: 'string', description: '检索范围：current（默认，当前项目 + 全局）、global（只看全局）、all（所有项目）。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      try {
        const rows = listEntries(db, {
          category: '对话记录',
          includeArchived: Boolean(args.includeArchived),
          workspaceId: execWorkspace(exec),
          workspaceScope: normalizeScope(args.scope),
        });
        return formatList(rows);
      } catch (error) {
        logError('memory_list_conversations', error);
        return `列出历史对话失败：${error?.message || error}`;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_list_permanent',
    description: '列出当前会话的永久记忆。永久记忆绑定在对话里，不会被自动压缩或丢弃。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(_args, exec) {
      try {
        const sessionId = exec?.agent?.session?.id;
        if (!sessionId) return '当前没有绑定会话，无法列出永久记忆。';
        const rows = listEntries(db, { category: '永久记忆', sessionId: String(sessionId) });
        return formatList(rows);
      } catch (error) {
        logError('memory_list_permanent', error);
        return `列出永久记忆失败：${error?.message || error}`;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_promote_permanent',
    description: '把某一条已有记忆升级为当前会话的永久记忆。永久记忆不会被自动压缩或丢弃。',
    parameters: {
      id: { type: 'integer', required: true, description: '要升级的记忆条目编号（ID）。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      try {
        const id = Number(args.id);
        const old = getEntry(db, id);
        if (!old) return '没有找到这个编号的记忆条目。';
        const sessionId = exec?.agent?.session?.id ? String(exec.agent.session.id) : (old.session_id || null);
        const updated = updateEntry(db, id, { category: '永久记忆', sessionId });
        return `已升级为当前会话的永久记忆，编号（ID）：${updated.id}`;
      } catch (error) {
        logError('memory_promote_permanent', error);
        return `升级永久记忆失败：${error?.message || error}`;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_add_preset',
    description: '新增一条全局“预设/用户记忆”。预设会在每个对话开始时自动带上，适合保存用户的长期身份、通用偏好和固定规则。',
    parameters: {
      title: { type: 'string', required: true, description: '预设标题。' },
      content: { type: 'string', description: '预设内容。' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签列表。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        const title = String(args.title || '').trim();
        if (!title) return '新增失败：标题不能为空。';
        const id = addEntry(db, {
          title,
          content: String(args.content || ''),
          category: '预设',
          tags: args.tags,
        });
        return `已新增预设/用户记忆，编号（ID）：${id}`;
      } catch (error) {
        logError('memory_add_preset', error);
        return `新增预设失败：${error?.message || error}`;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_list_preset',
    description: '列出所有全局“预设/用户记忆”。预设会在每个对话开始时自动带上。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      try {
        const rows = listEntries(db, { category: '预设' });
        return formatList(rows);
      } catch (error) {
        logError('memory_list_preset', error);
        return `列出预设失败：${error?.message || error}`;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_promote_preset',
    description: '把某一条已有记忆升级为全局“预设/用户记忆”。升级后每个对话都会自动带上。',
    parameters: {
      id: { type: 'integer', required: true, description: '要升级的记忆条目编号（ID）。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        const id = Number(args.id);
        const old = getEntry(db, id);
        if (!old) return '没有找到这个编号的记忆条目。';
        const updated = updateEntry(db, id, { category: '预设', sessionId: null, workspaceId: null });
        return `已升级为全局预设/用户记忆，编号（ID）：${updated.id}`;
      } catch (error) {
        logError('memory_promote_preset', error);
        return `升级预设失败：${error?.message || error}`;
      }
    },
  }));


}
