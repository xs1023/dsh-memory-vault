/**
 * 外置记忆库数据库层
 *
 * 使用 Node.js 内置的 SQLite（node:sqlite）读写 dsh 全局记忆库。
 * 数据文件默认放在 ~/.dsh/memory/memory.db，可通过环境变量覆盖：
 *   DSH_MEMORY_DIR - 记忆目录
 *   DSH_MEMORY_DB  - 数据库文件路径
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function resolveDbPath(config = {}) {
  const memoryDir = config.dataDir
    || process.env.DSH_MEMORY_DIR
    || join(homedir(), '.dsh', 'memory');
  const dbPath = process.env.DSH_MEMORY_DB || join(memoryDir, 'memory.db');
  return { memoryDir, dbPath };
}

export function openDb(config = {}) {
  const { memoryDir, dbPath } = resolveDbPath(config);
  mkdirSync(memoryDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '未分类',
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS entry_tags (
      entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (entry_id, tag_id)
    );

    CREATE INDEX IF NOT EXISTS idx_entries_category ON entries(category);
    CREATE INDEX IF NOT EXISTS idx_entries_updated ON entries(updated_at);
  `);

  // 旧数据库升级：给已存在的 entries 表补 session_id 列
  try {
    db.exec('ALTER TABLE entries ADD COLUMN session_id TEXT');
  } catch {
    // 列已存在时忽略
  }

  // 补列完成后才创建依赖 session_id 的索引（旧库升级顺序：建表 → 补列 → 建索引）
  db.exec('CREATE INDEX IF NOT EXISTS idx_entries_session ON entries(session_id)');

  return db;
}

export const now = () => new Date().toISOString();

export function splitTags(tagInput) {
  if (!tagInput) return [];
  const list = Array.isArray(tagInput) ? tagInput : [tagInput];
  return list
    .flatMap((item) => String(item).split(/[,，]/))
    .map((item) => item.trim())
    .filter(Boolean);
}

export function replaceTags(db, entryId, tagInput) {
  const tagNames = splitTags(tagInput);
  db.prepare('DELETE FROM entry_tags WHERE entry_id = ?').run(entryId);
  const insertTag = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
  const findTag = db.prepare('SELECT id FROM tags WHERE name = ?');
  const linkTag = db.prepare('INSERT INTO entry_tags (entry_id, tag_id) VALUES (?, ?)');
  for (const name of tagNames) {
    insertTag.run(name);
    const row = findTag.get(name);
    if (row) linkTag.run(entryId, row.id);
  }
}

export function getTags(db, entryId) {
  return db
    .prepare(
      `SELECT t.name
         FROM tags t
         JOIN entry_tags et ON et.tag_id = t.id
        WHERE et.entry_id = ?
        ORDER BY t.name`
    )
    .all(entryId)
    .map((row) => row.name);
}


export function addEntry(db, { title, content = '', category = '未分类', tags = [], sessionId = null }) {
  const createdAt = now();
  const info = db
    .prepare(
      `INSERT INTO entries (title, content, category, session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(title, content, category || '未分类', sessionId, createdAt, createdAt);
  const entryId = Number(info.lastInsertRowid);
  replaceTags(db, entryId, tags);
  return entryId;
}

/**
 * 找同一 session 下、指定分类中最新的那条记忆。
 *
 * category 默认限定为“对话记录”。分层压缩会往同一个 session_id 写入
 * 中期/长期记忆行，一旦不限定分类，这里的“取最新一条”就会命中那些行，
 * 紧接着的 upsert 会把它们原地改写成对话记录：结果是同一 session 堆出
 * 一串重复的对话记录，而分层记忆行凭空消失。
 * 确实需要“不限分类取最新行”时，显式传 null。
 */
export function findEntryBySessionId(db, sessionId, category = '对话记录') {
  if (!sessionId) return null;
  const entry = category
    ? db
        .prepare('SELECT * FROM entries WHERE session_id = ? AND category = ? ORDER BY id DESC LIMIT 1')
        .get(sessionId, category)
    : db.prepare('SELECT * FROM entries WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId);
  if (!entry) return null;
  return { ...entry, tags: getTags(db, entry.id) };
}

export function upsertConversationEntry(db, { sessionId, title, content, category = '对话记录', tags = [] }) {
  const existing = findEntryBySessionId(db, sessionId, category);
  const timestamp = now();
  if (existing) {
    db.prepare(
      `UPDATE entries
          SET title = ?, content = ?, category = ?, updated_at = ?
        WHERE id = ?`
    ).run(title, content, category, timestamp, existing.id);
    replaceTags(db, existing.id, tags);
    return existing.id;
  }
  return addEntry(db, { title, content, category, tags, sessionId });
}

export function getEntry(db, entryId) {
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);
  if (!entry) return null;
  return { ...entry, tags: getTags(db, entryId) };
}

export function listEntries(db, options = {}) {
  const {
    category,
    tag,
    search,
    includeArchived = false,
    archivedOnly = false,
    excludeCategory,
    sessionId,
  } = options;

  const conditions = [];
  const params = [];

  if (category) {
    conditions.push('e.category = ?');
    params.push(category);
  }

  if (excludeCategory) {
    conditions.push('e.category != ?');
    params.push(excludeCategory);
  }

  if (sessionId) {
    conditions.push('e.session_id = ?');
    params.push(sessionId);
  }

  if (tag) {
    conditions.push(
      `e.id IN (
         SELECT et.entry_id
           FROM entry_tags et
           JOIN tags t ON t.id = et.tag_id
          WHERE t.name = ?
       )`
    );
    params.push(tag);
  }

  if (search) {
    conditions.push('(e.title LIKE ? OR e.content LIKE ? OR e.category LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  if (!includeArchived) {
    conditions.push(archivedOnly ? 'e.archived = 1' : 'e.archived = 0');
  }

  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT e.id,
              e.title,
              e.category,
              e.pinned,
              e.archived,
              e.updated_at,
              (SELECT GROUP_CONCAT(t.name, ',')
                 FROM entry_tags et
                 JOIN tags t ON t.id = et.tag_id
                WHERE et.entry_id = e.id) AS tags
         FROM entries e
         ${where}
        ORDER BY e.pinned DESC, e.updated_at DESC`
    )
    .all(...params);
}

export function updateEntry(db, entryId, fields = {}, tags) {
  const allowed = ['title', 'content', 'category', 'sessionId'];
  const updates = {};
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      updates[key === 'sessionId' ? 'session_id' : key] = fields[key];
    }
  }

  if (Object.keys(updates).length) {
    const sets = Object.keys(updates).map((key) => `${key} = ?`).join(', ');
    db.prepare(`UPDATE entries SET ${sets}, updated_at = ? WHERE id = ?`).run(
      ...Object.values(updates),
      now(),
      entryId
    );
  } else {
    db.prepare('UPDATE entries SET updated_at = ? WHERE id = ?').run(now(), entryId);
  }

  if (tags !== undefined) {
    replaceTags(db, entryId, tags);
  }

  return getEntry(db, entryId);
}

export function setArchived(db, entryId, archived) {
  const info = db
    .prepare('UPDATE entries SET archived = ?, updated_at = ? WHERE id = ?')
    .run(archived ? 1 : 0, now(), entryId);
  return info.changes > 0;
}

export function deleteEntry(db, entryId) {
  const info = db.prepare('DELETE FROM entries WHERE id = ?').run(entryId);
  return info.changes > 0;
}

export function listCategories(db) {
  return db
    .prepare(
      `SELECT category, COUNT(*) AS count
         FROM entries
        GROUP BY category
        ORDER BY count DESC, category`
    )
    .all();
}

export function getStats(db) {
  const total = db.prepare('SELECT COUNT(*) AS count FROM entries').get().count;
  const active = db.prepare('SELECT COUNT(*) AS count FROM entries WHERE archived = 0').get().count;
  const archived = db.prepare('SELECT COUNT(*) AS count FROM entries WHERE archived = 1').get().count;
  const tagCount = db.prepare('SELECT COUNT(*) AS count FROM tags').get().count;
  const categoryCount = db.prepare('SELECT COUNT(DISTINCT category) AS count FROM entries').get().count;
  return { total, active, archived, tagCount, categoryCount };
}

export function renameCategory(db, oldName, newName) {
  const info = db
    .prepare('UPDATE entries SET category = ?, updated_at = ? WHERE category = ?')
    .run(newName, now(), oldName);
  return info.changes;
}

export function formatList(rows) {
  if (!rows.length) return '（没有找到记忆条目）';
  const lines = rows.map((row) => {
    const status = row.archived ? ' [已归档]' : '';
    return `【${row.id}】${row.title}${status}｜分类：${row.category}｜标签：${row.tags || '无'}｜更新：${row.updated_at}`;
  });
  return lines.join('\n');
}

export function formatEntry(entry) {
  return [
    `编号（ID）：${entry.id}`,
    `标题：${entry.title}`,
    `分类：${entry.category}`,
    `标签：${entry.tags.length ? entry.tags.join('、') : '（无）'}`,
    `状态：${entry.archived ? '已归档' : '正常'}${entry.pinned ? '，已置顶' : ''}`,
    `创建时间：${entry.created_at}`,
    `更新时间：${entry.updated_at}`,
    '内容：',
    entry.content || '（无内容）',
  ].join('\n');
}
