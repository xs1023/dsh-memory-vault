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
} from '../src/db.js';

import {
  captureConversation,
  maybeCompressSession,
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
