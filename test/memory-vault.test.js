/**
 * dsh-memory-vault 回归测试
 *
 * 每个用例都对应一个真实踩过的坑，且在修复前都是红的：
 *
 *   A. 对话记录的 upsert 会劫持同一 session 下更新的“分层记忆”行，
 *      于是同一 session 堆积出多条对话记录，而分层记忆行被改写后消失
 *      （真实库里 13 条对话记录、0 条中期记忆就是这么来的）。
 *
 *   B. 对话记录标题取自未经过滤的消息列表，于是折叠产出的【中期记忆】
 *      或会话开头注入的【预设/用户记忆】会变成标题。
 *
 *   C. 中期/长期阈值没有和“下层消息的产出速率”对齐：一次短期折叠消耗
 *      10 条原始消息才产出 1 条中期消息，而 mediumTermLimit 也是 20，
 *      等于要求约 200 条原始消息 —— 后两级压缩实际不可达。
 *
 * 运行：node --test test/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  openDb,
  addEntry,
  getEntry,
  listEntries,
  findEntryBySessionId,
  upsertConversationEntry,
  workspaceLabel,
} from '../src/db.js';

import {
  apply,
  captureConversation,
  maybeCompressSession,
  normalizeScope,
  resolveTierConfig,
} from '../index.js';

const SESSION = 'session-regression';

// DSH_MEMORY_DB 的优先级高于 config.dataDir，不清掉会把测试数据写进真实记忆库。
const savedMemoryDb = process.env.DSH_MEMORY_DB;
delete process.env.DSH_MEMORY_DB;
test.after(() => {
  if (savedMemoryDb !== undefined) process.env.DSH_MEMORY_DB = savedMemoryDb;
});

/** 每个用例一个全新的临时库，绝不碰 ~/.dsh/memory/memory.db */
function freshDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-vault-test-'));
  const db = openDb({ dataDir: dir });
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

const userMsg = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }] });
const assistantMsg = (id, text) => ({ id, role: 'assistant', content: [{ type: 'text', text }] });
const pluginMsg = (id, tier, text) => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'dsh-memory-vault', memoryTier: tier },
});
/** 宿主（DSH 自身）注入的 user 消息：同样是 role:'user'，靠 source.kind 区分 */
const systemMsg = (id, kind, text) => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind },
});

/** captureConversation 只用到 id 与 deriveMessages() */
const mockSession = (id, messages) => ({ id, deriveMessages: () => messages });

/**
 * 带 surface 的假 session，供 maybeCompressSession 的折叠路径使用。
 * nodes 是实时数组引用，append 的 replace 语义与真实 session 对齐。
 */
function tieredSession(id, items) {
  let nextSeq = 10000;
  const nodes = items.map((item) => item.seq);
  const bySeq = new Map(items.map((item) => [item.seq, item.message]));
  return {
    id,
    surface: { nodes },
    eventAt: (seq) => (bySeq.has(seq) ? { seq, type: 'user/message', data: bySeq.get(seq) } : null),
    deriveEventMessage: (event) => event.data,
    append: (type, message, options) => {
      const seq = nextSeq;
      nextSeq += 1;
      bySeq.set(seq, message);
      const op = options?.surfaceOp;
      if (op?.op === 'replace') {
        const start = nodes.indexOf(op.startSeq);
        const end = nodes.indexOf(op.endSeq);
        nodes.splice(start, end - start + 1, seq);
      } else {
        nodes.push(seq);
      }
      return { seq };
    },
  };
}

// ── A. 对话记录不得劫持分层记忆行 ──────────────────────────────

test('A1. 对话记录的 upsert 不得劫持同一 session 的中期记忆行', (t) => {
  const db = freshDb(t);

  upsertConversationEntry(db, {
    sessionId: SESSION,
    title: '对话记录：第一轮',
    content: '第一轮内容',
    tags: ['自动记录'],
  });

  // 短期折叠发生：插件向同一个 session_id 追加一条“中期记忆”
  addEntry(db, {
    title: '中期记忆：m1',
    content: 'm1 摘要',
    category: '中期记忆',
    tags: ['自动压缩'],
    sessionId: SESSION,
  });

  upsertConversationEntry(db, {
    sessionId: SESSION,
    title: '对话记录：第二轮',
    content: '第二轮内容',
    tags: ['自动记录'],
  });

  const conversations = listEntries(db, { category: '对话记录', sessionId: SESSION });
  const mediums = listEntries(db, { category: '中期记忆', sessionId: SESSION });

  assert.equal(conversations.length, 1, '同一 session 只应有一条对话记录');
  assert.equal(mediums.length, 1, '中期记忆行不应被改写成对话记录');
  assert.equal(getEntry(db, mediums[0].id).content, 'm1 摘要');
  assert.equal(getEntry(db, conversations[0].id).content, '第二轮内容');
});

test('A2. 多轮 flush 与折叠交替后，对话记录仍然只有一条', async (t) => {
  const db = freshDb(t);
  const session = mockSession(SESSION, [userMsg('u1', '第一轮对话')]);

  for (let round = 1; round <= 3; round += 1) {
    await captureConversation(session, db);
    addEntry(db, {
      title: `中期记忆：第${round}次折叠`,
      content: `第${round}次折叠摘要`,
      category: '中期记忆',
      tags: ['自动压缩'],
      sessionId: SESSION,
    });
  }
  await captureConversation(session, db);

  const conversations = listEntries(db, { category: '对话记录', sessionId: SESSION });
  const mediums = listEntries(db, { category: '中期记忆', sessionId: SESSION });

  assert.equal(conversations.length, 1, '反复 flush 不应堆积出多条对话记录');
  assert.equal(mediums.length, 3, '每次折叠写下的中期记忆行都应保留');
});

test('A3. 没有对话记录时，默认查询不应返回分层记忆行', (t) => {
  const db = freshDb(t);

  addEntry(db, {
    title: '中期记忆：m1',
    content: 'm1 摘要',
    category: '中期记忆',
    sessionId: SESSION,
  });

  assert.equal(findEntryBySessionId(db, SESSION), null, '不应把中期记忆行当成对话记录');
});

test('A4. findEntryBySessionId 默认只认对话记录，显式传 null 才不限分类', (t) => {
  const db = freshDb(t);

  // 真实顺序就是这样：先 flush 写对话记录，折叠随后追加中期记忆（id 更大、更新）
  upsertConversationEntry(db, { sessionId: SESSION, title: '对话记录：r1', content: 'r1' });
  addEntry(db, {
    title: '中期记忆：m1',
    content: 'm1 摘要',
    category: '中期记忆',
    sessionId: SESSION,
  });

  assert.equal(findEntryBySessionId(db, SESSION).title, '对话记录：r1', '默认只认对话记录');
  assert.equal(findEntryBySessionId(db, SESSION, '中期记忆').title, '中期记忆：m1');
  assert.equal(findEntryBySessionId(db, SESSION, null).title, '中期记忆：m1', 'null 表示不限分类，取最新一行');
});

// ── B. 标题必须取自真实用户消息 ────────────────────────────────

test('B1. 标题不得取自会话开头注入的预设记忆', async (t) => {
  const db = freshDb(t);
  const session = mockSession(SESSION, [
    pluginMsg('p1', 'preset', '【预设/用户记忆】\n- 界面偏好：偏好 DSH 官方原生 Web 界面'),
    userMsg('u1', '帮我把这个插件的重复行修掉'),
    assistantMsg('a1', '好的，我先看代码。'),
  ]);

  await captureConversation(session, db);

  const rows = listEntries(db, { category: '对话记录', sessionId: SESSION });
  assert.equal(rows.length, 1);
  const entry = getEntry(db, rows[0].id);

  assert.ok(
    entry.title.includes('帮我把这个插件的重复行修掉'),
    `标题应取自真实用户消息，实际为：${entry.title}`,
  );
  assert.ok(!entry.title.includes('【预设/用户记忆】'), '标题不应包含注入的预设记忆');
  assert.ok(!entry.content.includes('【预设/用户记忆】'), '正文不应包含注入的预设记忆');
});

test('B2. 标题不得取自折叠产出的中期记忆消息', async (t) => {
  const db = freshDb(t);
  const session = mockSession(SESSION, [
    pluginMsg('m1', 'medium', '【中期记忆】用户把审批策略改成了 never'),
    userMsg('u1', '继续修剩下的两个缺陷'),
  ]);

  await captureConversation(session, db);

  const rows = listEntries(db, { category: '对话记录', sessionId: SESSION });
  const entry = getEntry(db, rows[0].id);

  assert.ok(entry.title.includes('继续修剩下的两个缺陷'), `实际标题：${entry.title}`);
  assert.ok(!entry.title.includes('【中期记忆】'), '标题不应包含折叠产物');
  assert.ok(!entry.content.includes('【中期记忆】用户把审批策略'), '正文不应包含折叠产物');
});

test('B3. 标题不得取自宿主注入的 runtime-context 消息', async (t) => {
  const db = freshDb(t);
  const session = mockSession(SESSION, [
    systemMsg(
      's1',
      'runtime-context',
      'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
    ),
    assistantMsg('a0', '（上一轮的收尾说明）'),
    userMsg('u1', '重启好了'),
  ]);

  await captureConversation(session, db);

  const rows = listEntries(db, { category: '对话记录', sessionId: SESSION });
  const entry = getEntry(db, rows[0].id);

  assert.ok(entry.title.includes('重启好了'), `标题应取自真人消息，实际为：${entry.title}`);
  assert.ok(!entry.title.includes('Current runtime context'), '标题不应包含宿主注入的运行时上下文');
  assert.ok(!entry.content.includes('Current runtime context'), '正文不应包含宿主注入的运行时上下文');
});

test('B4. 各类宿主注入消息都不得进入标题与正文', async (t) => {
  const kinds = ['agent-instructions', 'compact-checkpoint', 'goal', 'team-message', 'webhook'];
  for (const kind of kinds) {
    const db = freshDb(t);
    const marker = `SYSTEM-INJECT-${kind}`;
    const session = mockSession(SESSION, [systemMsg(`s-${kind}`, kind, marker), userMsg('u1', '真人说的一句话')]);

    await captureConversation(session, db);

    const rows = listEntries(db, { category: '对话记录', sessionId: SESSION });
    const entry = getEntry(db, rows[0].id);

    assert.ok(entry.title.includes('真人说的一句话'), `kind=${kind} 时标题错误：${entry.title}`);
    assert.ok(!entry.content.includes(marker), `kind=${kind} 时正文混入系统注入消息`);
  }
});

test('B5. 问答回复属于真人输入，不得被一并过滤', async (t) => {
  const db = freshDb(t);
  const session = mockSession(SESSION, [
    systemMsg(
      's1',
      'runtime-context',
      'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
    ),
    {
      id: 'q1',
      role: 'user',
      content: [{ type: 'text', text: '备份后清理历史脏数据' }],
      source: { kind: 'user-question-reply', callId: 'call-1', outcome: 'answered' },
    },
    assistantMsg('a1', '好，我先备份。'),
  ]);

  await captureConversation(session, db);

  const rows = listEntries(db, { category: '对话记录', sessionId: SESSION });
  const entry = getEntry(db, rows[0].id);

  assert.ok(entry.title.includes('备份后清理历史脏数据'), `实际标题：${entry.title}`);
  assert.ok(entry.content.includes('备份后清理历史脏数据'), '正文应保留真人的问答回复');
});

// ── C. 分层压缩的阈值必须可达 ──────────────────────────────────

test('C1. 默认阈值必须让“中期 → 长期”在真实会话长度内可达', () => {
  const cfg = resolveTierConfig();

  // 一次短期折叠消耗 shortTermCompressCount 条原始消息，只产出 1 条中期消息。
  // 凑够 mediumTermLimit + 1 条中期消息，大约需要这么多条原始消息。
  const rawMessagesToReachLong = (cfg.mediumTermLimit + 1) * cfg.shortTermCompressCount;

  assert.ok(
    rawMessagesToReachLong <= 60,
    `凑够“中期 → 长期”要约 ${rawMessagesToReachLong} 条原始消息，真实会话里到不了`,
  );
  assert.ok(cfg.mediumTermCompressCount <= cfg.mediumTermLimit, '一次折叠的条数不应超过触发阈值');
  assert.ok(cfg.longTermLimit <= cfg.mediumTermLimit + 1, '长期阈值不应比中期阈值更苛刻');
});

test('C2. 中期记忆累积超过阈值后应产出长期记忆，并清掉被折叠的中期行', async (t) => {
  const db = freshDb(t);
  const cfg = resolveTierConfig();

  const items = [];
  for (let i = 1; i <= cfg.mediumTermLimit + 1; i += 1) {
    items.push({ seq: i, message: pluginMsg(`m${i}`, 'medium', `【中期记忆】第${i}条摘要`) });
    addEntry(db, {
      title: `中期记忆：第${i}条`,
      content: `【中期记忆】第${i}条摘要`,
      category: '中期记忆',
      tags: ['自动压缩'],
      sessionId: SESSION,
    });
  }

  const session = tieredSession(SESSION, items);
  const ctx = {
    llm: {
      stream: async function* stream() {
        yield { type: 'text-delta', text: '这是长期记忆摘要' };
      },
    },
  };
  const agent = {
    session: { requestHeader: () => ({ config: { provider: 'test', model: 'test' } }) },
  };

  await maybeCompressSession(ctx, agent, session, db, cfg);

  const longs = listEntries(db, { category: '长期记忆', sessionId: SESSION });
  assert.equal(longs.length, 1, '超过阈值后应产出长期记忆');
  assert.equal(getEntry(db, longs[0].id).content, '这是长期记忆摘要');

  const mediums = listEntries(db, { category: '中期记忆', sessionId: SESSION });
  assert.equal(
    mediums.length,
    cfg.mediumTermLimit + 1 - cfg.mediumTermCompressCount,
    '被折叠进长期记忆的中期行应从库里删除',
  );
});

// ── D. 预设注入必须幂等 ────────────────────────────────────────
//
// 真实会话日志证明：'agent/created' 会在同一个会话里被反复触发
// （session-6201a158 在 11 分钟内触发了 3 次：22:19:34 / 22:20:52 / 22:30:26），
// 而旧的 agent.inject() 只是往 inbox 追加一条 user 消息，不做任何替换，
// 于是每触发一次就在历史里多留一份【预设/用户记忆】，随重启次数线性增长。
// 会话开头最终叠出 3 份预设、5 次注入记录，就是这么来的。

/**
 * 清理临时目录。
 * 注意：apply() 内部打开的 sqlite 连接不会关闭，Windows 下文件仍被占用，
 * rmSync 会抛 EPERM。临时目录留给系统回收即可，不因此判定用例失败。
 */
function cleanupDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 文件仍被 sqlite 占用，忽略 */
  }
}

/** 造一个能捕获 agent/created 处理器的假 ctx */
function bootPlugin(dir) {
  const handlers = {};
  const ctx = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
    logger: { warn: () => {} },
    tools: { register: () => {} },
    get: () => undefined,
  };
  apply(ctx, { dataDir: dir });
  return handlers;
}

/** inject() 会同时把消息写进 deriveMessages() 的可视列表，与真实行为一致 */
function makeAgent(id, messages, injected) {
  return {
    session: { id, deriveMessages: () => messages },
    inject: (message) => {
      injected.push(message);
      messages.push(message);
    },
  };
}

function seedPresets(dir) {
  const db = openDb({ dataDir: dir });
  addEntry(db, { title: '界面偏好', content: '偏好 DSH 原生 Web 界面', category: '预设' });
  addEntry(db, { title: '回复风格', content: '保持专业严谨', category: '预设' });
  db.close();
}

test('D1. 同一会话重复触发 agent/created，预设只注入一次', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-vault-test-'));
  t.after(() => cleanupDir(dir));
  seedPresets(dir);

  const handlers = bootPlugin(dir);
  const messages = [];
  const injected = [];
  const agent = makeAgent('sess-dup', messages, injected);

  // 复刻真实日志里的 3 次触发
  handlers['agent/created']({ agent });
  handlers['agent/created']({ agent });
  handlers['agent/created']({ agent });

  assert.equal(injected.length, 1, `预设应只注入一次，实际注入 ${injected.length} 次`);
  assert.ok(
    injected[0].content[0].text.startsWith('【预设/用户记忆】'),
    '注入内容应为预设记忆',
  );
});

test('D2. 会话历史里已有预设时不再注入（重启 dsh 后恢复旧会话）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-vault-test-'));
  t.after(() => cleanupDir(dir));
  seedPresets(dir);

  // 新进程：内存标记为空，但历史里已留下上一次注入的那一份
  const handlers = bootPlugin(dir);
  const messages = [pluginMsg('p-old', 'preset', '【预设/用户记忆】\n- 上一轮注入的那一份')];
  const injected = [];
  const agent = makeAgent('sess-hist', messages, injected);

  handlers['agent/created']({ agent });

  assert.equal(injected.length, 0, '历史里已有预设注入时不应再注入一份');
});

test('D3. 不同会话各自注入一次，去重不得跨会话误伤', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-vault-test-'));
  t.after(() => cleanupDir(dir));
  seedPresets(dir);

  const handlers = bootPlugin(dir);
  const injectedA = [];
  const injectedB = [];
  const agentA = makeAgent('sess-a', [], injectedA);
  const agentB = makeAgent('sess-b', [], injectedB);

  handlers['agent/created']({ agent: agentA });
  handlers['agent/created']({ agent: agentB });
  handlers['agent/created']({ agent: agentA });

  assert.equal(injectedA.length, 1, 'A 会话应恰好注入一次');
  assert.equal(injectedB.length, 1, 'B 会话应恰好注入一次，不应被 A 的去重标记挡住');
});

test('D4. 没有预设时不注入', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-vault-test-'));
  t.after(() => cleanupDir(dir));

  const handlers = bootPlugin(dir);
  const messages = [];
  const injected = [];
  const agent = makeAgent('sess-empty', messages, injected);

  handlers['agent/created']({ agent });

  assert.equal(injected.length, 0, '记忆库里没有预设时不应注入任何内容');
});

// ── E. 项目维度（工作区归属）──────────────────────────────────
//
// 加这一维是为了让「多个 agent / 一个父 agent 带多个 subagent」干同一个项目时，
// 检索自动收窄到本项目，同时不改变原来的全局语义。五条真实风险：
//
//   E1 默认检索漏掉全局条目，或者串到别的项目。
//   E2 会话拿不到 cwd（旧会话、宿主未提供）时若照样过滤，记忆会静默消失。
//   E3 scope 参数写错不得退化成全库检索 —— 一个笔误就让隔离形同虚设。
//   E4 旧库补列迁移不得把存量行重新归属到某个项目。
//   E5 工具层必须真的按会话 cwd 入库，否则这一维只是个摆设。

const PROJ_A = 'C:\\work\\proj-a';
const PROJ_B = '/home/me/proj-b';
/** cwd 归一化后的期望值：统一正斜杠、去掉尾部分隔符 */
const PROJ_A_KEY = 'C:/work/proj-a';

/** 造一个能同时捕获事件处理器与已注册工具的假 ctx */
function bootPluginTools(dir) {
  const handlers = {};
  const tools = new Map();
  const ctx = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
    logger: { warn: () => {} },
    tools: { register: (tool) => tools.set(tool.name, tool) },
    get: () => undefined,
  };
  apply(ctx, { dataDir: dir });
  return { handlers, tools };
}

function seedProjects(db) {
  addEntry(db, { title: '全局：通用约定', content: '所有项目都适用', category: '全局约定' });
  addEntry(db, { title: 'A：接口约定', content: 'A 项目的接口', category: '项目知识', workspaceId: PROJ_A });
  addEntry(db, { title: 'B：部署流程', content: 'B 项目的部署', category: '项目知识', workspaceId: PROJ_B });
}

test('E1. 默认检索 = 当前项目 + 全局，既不丢全局也不串项目', (t) => {
  const db = freshDb(t);
  seedProjects(db);

  const current = listEntries(db, { workspaceId: PROJ_A, workspaceScope: 'current' })
    .map((row) => row.title)
    .sort();
  assert.deepEqual(current, ['A：接口约定', '全局：通用约定'].sort());

  const globalOnly = listEntries(db, { workspaceScope: 'global' }).map((row) => row.title);
  assert.deepEqual(globalOnly, ['全局：通用约定']);

  const all = listEntries(db, { workspaceScope: 'all' }).map((row) => row.title);
  assert.equal(all.length, 3, 'all 应看到全部三个维度的条目');
});

test('E2. 拿不到 cwd 时退化为不过滤，不得静默丢记忆', (t) => {
  const db = freshDb(t);
  seedProjects(db);

  // 旧会话或宿主没给 cwd：workspaceId 为空
  const rows = listEntries(db, { workspaceScope: 'current' });
  assert.equal(rows.length, 3, '没有项目归属时不应过滤掉任何条目');
});

test('E3. 未知 scope 一律按 current 处理，不得退化成全库检索', () => {
  assert.equal(normalizeScope('All'), 'all', '取值应大小写不敏感');
  assert.equal(normalizeScope('  ALL  '), 'all', '首尾空白应被容忍');
  assert.equal(normalizeScope('everything'), 'current', '拼错的取值不得放行全库');
  assert.equal(normalizeScope(undefined), 'current');
  assert.equal(normalizeScope('global'), 'global');
  assert.equal(normalizeScope('all'), 'all');
});

test('E4. 旧库补列迁移：存量行必须是全局，默认检索仍然看得见', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-vault-legacy-'));
  t.after(() => cleanupDir(dir));

  // 造一个「改动前」的库：没有 workspace_id 列
  const raw = new DatabaseSync(join(dir, 'memory.db'));
  raw.exec(`CREATE TABLE entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '未分类',
    pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  const stamp = new Date().toISOString();
  raw
    .prepare('INSERT INTO entries (title, content, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('迁移前的记忆', '旧内容', '未分类', stamp, stamp);
  raw.close();

  const db = openDb({ dataDir: dir });
  t.after(() => db.close());

  const columns = db.prepare('PRAGMA table_info(entries)').all().map((row) => row.name);
  assert.ok(columns.includes('workspace_id'), '打开旧库时应补出 workspace_id 列');

  const entry = getEntry(db, 1);
  assert.equal(entry.workspace_id, null, '存量行不得被重新归属到某个项目');

  const visible = listEntries(db, { workspaceId: PROJ_A, workspaceScope: 'current' });
  assert.deepEqual(visible.map((row) => row.title), ['迁移前的记忆']);
});

test('E5. 工具层按会话 cwd 写项目、按 scope 写全局，默认检索不串项目', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-vault-tools-'));
  t.after(() => cleanupDir(dir));

  const { tools } = bootPluginTools(dir);
  const exec = { agent: { session: { header: { cwd: PROJ_A } } } };

  const added = await tools.get('memory_add').execute({ title: 'A 的记忆', content: 'x' }, exec);
  assert.match(added, /归属项目/, '写入回执应说明落到了哪个项目');

  await tools.get('memory_add').execute({ title: '全局的记忆', content: 'y', scope: 'global' }, exec);

  const db = openDb({ dataDir: dir });
  t.after(() => db.close());

  const byTitle = new Map(
    listEntries(db, { workspaceScope: 'all' }).map((row) => [row.title, row.workspace_id]),
  );
  assert.equal(byTitle.get('A 的记忆'), PROJ_A_KEY, 'cwd 应归一成正斜杠后再入库');
  assert.equal(byTitle.get('全局的记忆'), null);

  addEntry(db, { title: 'B 的记忆', content: 'z', workspaceId: PROJ_B });
  const found = await tools.get('memory_search').execute({ query: '的记忆' }, exec);
  assert.match(found, /A 的记忆/);
  assert.match(found, /全局的记忆/);
  assert.ok(!found.includes('B 的记忆'), '默认检索不得串到别的项目');

  const all = await tools.get('memory_search').execute({ query: '的记忆', scope: 'all' }, exec);
  assert.match(all, /B 的记忆/, 'scope=all 才应看到别的项目');
});

test('E6. 对话记录随会话落到对应项目', async (t) => {
  const db = freshDb(t);
  const session = {
    id: 'sess-proj',
    header: { cwd: PROJ_A },
    deriveMessages: () => [userMsg('u1', 'A 项目的一句话'), assistantMsg('a1', '好的')],
  };

  await captureConversation(session, db);

  const mine = listEntries(db, { category: '对话记录', workspaceId: PROJ_A, workspaceScope: 'current' });
  assert.equal(mine.length, 1);
  assert.equal(getEntry(db, mine[0].id).workspace_id, PROJ_A_KEY);

  const other = listEntries(db, { category: '对话记录', workspaceId: PROJ_B, workspaceScope: 'current' });
  assert.equal(other.length, 0, '别的项目不应看到这条对话记录');
});

test('E7. 展示用的项目名取归一化后的末段，不得把整条路径铺出来', () => {
  assert.equal(workspaceLabel(PROJ_A), 'proj-a', 'Windows 反斜杠路径也要取到末段');
  assert.equal(workspaceLabel(PROJ_A_KEY), 'proj-a');
  assert.equal(workspaceLabel('C:\\work\\proj-a\\'), 'proj-a', '尾部分隔符应先归一化掉');
  assert.equal(workspaceLabel(PROJ_B), 'proj-b');
  assert.equal(workspaceLabel(null), null, '全局条目没有项目名');
});
