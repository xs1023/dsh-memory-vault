# dsh-memory-vault（外置记忆库插件 · 修复分支）

一个为 DeepSeek Harness（DSH）提供长期记忆能力的插件。

> **关于本仓库**
> 本仓库是 [hjj588/dsh-memory-vault](https://github.com/hjj588/dsh-memory-vault) 的**修复分支**，由 [@xs1023](https://github.com/xs1023) 维护，遵循原项目的 MIT 许可。
> 原始功能与数据格式完全兼容——**已有的记忆数据无需迁移**，直接替换即可。
> 原版发布在 npm 上的同名包由另一位维护者维护，与本仓库是两个独立实现。

## 本分支修了什么

原版存在四个缺陷：前两个会实际损坏记忆数据，后两个让长期记忆层形同虚设、或让同一份内容反复堆进会话。本分支已全部修复并补齐回归测试：

| # | 缺陷 | 实际症状 | 修复方式 |
| --- | --- | --- | --- |
| **A** | 对话记录的 upsert 未按分类隔离 | 同一会话的对话记录反复堆积（真实库中单会话最多 7 条重复行）；分层压缩写下的中期/长期行被 upsert 改写成「对话记录」，旧行永久残留 | `src/db.js` 的 `findEntryBySessionId` 补上 `AND category = ?`，默认只认「对话记录」；确实需要跨分类查找时显式传 `null` |
| **B** | 标题取自未过滤的消息流 | 标题被宿主注入的消息夺走——运行时上下文、预设记忆、折叠摘要都可能变成标题（真实案例：标题成了 `Current runtime context. This snapshot s…`） | `index.js` 的 `isRawChatMessage` 在 user 一侧由**黑名单改为真人来源白名单**（`user` / `user-question-reply`），宿主注入消息一律不进正文与标题 |
| **C** | 分层压缩的后两级是死代码 | `mediumTermLimit` 与 `shortTermLimit` 同为 20，按产出速率需约 210 条原始消息才可能触发「中期 → 长期」，真实会话永远到不了，长期记忆层形同虚设 | 按产出速率调小后两级：`mediumTermLimit=4`、`mediumTermCompressCount=3`、`longTermLimit=4`，约 50 条原始消息即可触发 |
| **D** | 预设记忆注入没有幂等判定 | 宿主在会话重新种子化时（重启 dsh、恢复旧会话）会再次触发注入，同一会话历史里堆积多份完全相同的预设记忆（真实会话中单会话累积 3 份） | `index.js` 新增双闸门：进程内 `presetInjectedSessions` 标记 + `sessionHasPresetInjection` 历史探测。同一会话已注入过就不再追加，重启恢复旧会话也不补注入，跨会话互不影响 |

### 回归测试

```bash
npm test
```

共 21 个用例，覆盖四个缺陷与项目维度的正向场景和边界场景（含「宿主注入消息不得误杀真人输入」「跨会话去重不得误伤」「拿不到 cwd 不得丢记忆」三个反向用例）：

```text
✔ A1–A4  upsert 分类隔离、多轮折叠后仍单行、默认查询语义
✔ B1–B5  标题防注入（预设记忆 / 中期记忆 / runtime-context / 各类宿主注入 / 反向不误杀真人输入）
✔ C1–C2  阈值可达性、真实产出长期记忆并清理被折叠的中期行
✔ D1–D4  预设注入幂等（重复触发只注入一次 / 重启恢复旧会话不补注入 / 跨会话互不误伤 / 无预设不注入）
✔ E1–E6  项目维度（默认检索不丢全局也不串项目 / 拿不到 cwd 退化为不过滤 / scope 笔误不放行全库 /
          旧库补列迁移存量行为全局 / 工具层按会话 cwd 入库 / 对话记录随会话落到对应项目）
ℹ tests 21  ℹ pass 21  ℹ fail 0
```

## 项目维度（工作区归属）

本分支新增的一维：条目可以归属到某个项目，默认检索自动收窄到「当前项目 + 全局」。多个 agent、或者一个父 agent 带多个 subagent 干同一个项目时，各自写下的记忆不再和其他项目互相串。

- **归属从哪来**：写入时取会话创建时的绝对工作区路径（`session.header.cwd`），归一成 `C:/work/proj-a` 这种形式存进 `entries.workspace_id`。同一个目录的不同写法（`C:\work\proj-a\` 与 `C:/work/proj-a`）落到同一个键。
- **三态检索**：`scope=current`（默认）＝ 当前项目 + 全局；`scope=global` ＝ 只看全局（预设与历史积累）；`scope=all` ＝ 所有项目。
- **什么是「全局」**：`workspace_id IS NULL`。预设记忆、显式用 `scope=global` 写入的条目、以及升级前的全部存量数据都算全局。
- **拿不到 cwd 时不过滤**：旧会话或宿主没提供 cwd 时退化为全库检索——丢失归属不应该让记忆看不见。
- **参数写错不放行**：无法识别的 `scope` 一律按 `current` 处理，一个笔误不会意外变成全库检索。

### 涉及的工具参数

| 工具 | 新增参数 | 取值 |
| --- | --- | --- |
| `memory_add` | `scope` | `current`（默认，写入当前项目）/ `global`（跨项目通用） |
| `memory_list`、`memory_search`、`memory_search_history`、`memory_list_conversations` | `scope` | `current`（默认）/ `global` / `all` |

`memory_show` 会显示条目的项目归属，列表输出每条也带「项目：xxx」或「项目：全局」。预设类工具（`memory_add_preset`、`memory_promote_preset`）写入的条目始终是全局；`memory_list_permanent` 仍然只按当前会话过滤，不受这一维影响。

### 升级说明

旧库在首次打开时自动补 `workspace_id` 列（幂等 `ALTER TABLE` + 索引），**存量行一律保持 NULL（全局）**，默认检索照样看得见它们——升级不需要手工迁移，也不会让已有记忆失联。这一点有专门用例（E4）守着。

## 安装

### 从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:xs1023/dsh-memory-vault
```

把 `web` 换成你实际使用的 profile（例如 `web-desktop`）。装完重启 dsh 生效。

### 从本地源码安装

```bash
dsh plugin --profile web add /本仓库的绝对路径/dsh-memory-vault
```

重启后可以在「设置 → 插件 → 管理」里看到 `dsh-memory-vault`。

## 功能

- 新增、查看、修改、删除、搜索记忆
- 归档 / 恢复记忆
- 分类管理、标签管理、统计信息
- 自动把每次完整对话保存成一条「对话记录」（只存用户和助手的文本，不存工具细节）
- 专门搜索历史对话
- 分层记忆：短期（最近对话）→ 中期（压缩摘要）→ 长期（再压缩摘要）→ 永久（当前会话重要内容）
- 全局「预设 / 用户记忆」单独保存，每个对话开始时自动带上（同一会话只注入一次，重启或恢复旧会话不会重复注入）
- 永久记忆绑定当前会话，不会被自动丢弃；长期层满后先吸收重要内容再丢弃最旧一条
- 项目维度：条目按会话工作区归属，检索默认收窄到「当前项目 + 全局」，可用 `scope` 显式跨项目
- 各层上限与压缩条数可通过插件配置调整
- 数据保存在 `~/.dsh/memory/memory.db`（单库，跨会话、跨 agent 共享；条目的项目归属记在库内）

## 使用

插件向 dsh 注入以下工具，AI 在对话中会自动调用：

`memory_add`、`memory_list`、`memory_search`、`memory_show`、`memory_update`、`memory_archive`、`memory_restore`、`memory_delete`、`memory_categories`、`memory_stats`、`memory_rename_category`、`memory_search_history`、`memory_list_conversations`、`memory_list_permanent`、`memory_promote_permanent`、`memory_add_preset`、`memory_list_preset`、`memory_promote_preset`

你只需要对 AI 说「记住……」「查一下记忆……」「之前说过什么……」即可。

## 调整分层数字

各层默认值：

- 短期：保留最近 **20** 条原始消息，每次折叠最早的 **10** 条
- 中期：最多 **4** 条摘要，每次折叠 **3** 条
- 长期：最多 **4** 条摘要

这些数字彼此关联，不能随便调：一次短期折叠消耗 10 条原始消息才产出 1 条中期消息，所以**中期限额必须远小于短期限额**，否则「中期 → 长期」永远触发不了——这正是原版缺陷 C 的成因。

想修改时，在 profile 的 `cordis.patch.yml` 里给 memory-vault 行加 `config`：

```yaml
- insert:
    - id: memory-vault
      name: 'dsh-memory-vault'
      config:
        shortTermLimit: 20
        shortTermCompressCount: 10
        mediumTermLimit: 4
        mediumTermCompressCount: 3
        longTermLimit: 4
```

想更保守（少压缩、多保留原文）可以只覆盖中期限额，例如 `{ mediumTermLimit: 8 }`，无需改代码。

## 数据与备份

- 记忆库位置：`~/.dsh/memory/memory.db`（SQLite）
- 本插件不做自动备份；升级或手工清理前建议先复制一份该文件
- 删除条目依赖 `PRAGMA foreign_keys = ON` 级联清理标签关联，请勿用外部工具绕过插件直接改库，否则会留下孤儿关联行

## 本地开发

### 仓库结构

| 路径 | 作用 |
| --- | --- |
| `index.js` | 宿主半侧：注册 18 个 `memory_*` 工具、预设注入、对话记录与分层压缩 |
| `src/db.js` | 数据层：建表与迁移、增删改查、项目维度过滤、输出格式化 |
| `test/memory-vault.test.js` | 回归测试，每个用例对应一个真实踩过的坑 |
| `cordis.patch.yml` | 挂载声明：让 dsh 把本包挂进配置树 |

**零运行时依赖**：只用 Node 内置的 `node:sqlite`，不需要 `pnpm install`。要求 Node ≥ 22.18（`node:sqlite` 的可用版本）。

### 改完怎么验证

```bash
npm test     # 等价于 node --test test/memory-vault.test.js，22 个用例
```

用例全部跑在临时目录里的新库上（`openDb({ dataDir })`），**不会碰** `~/.dsh/memory/memory.db`。想拿真实数据试迁移时也别直接动生产库：`src/db.js` 支持 `DSH_MEMORY_DB`（库文件）与 `DSH_MEMORY_DIR`（目录）覆盖，先复制一份、指着副本跑。插件的 `config.dataDir` 同理。

### 改完怎么生效

宿主半侧的代码在 dsh 启动时加载，所以**改完必须重启 dsh**。生效方式取决于安装方式：

- **link 到源码目录**（开发时推荐）：`dsh plugin --profile web add <本仓库绝对路径>`。改完重启即生效，不需要复制文件。
- **从 GitHub 安装**：dsh 加载的是安装那一刻的副本，改本地源码不会生效——需要重新 `dsh plugin --profile web add github:xs1023/dsh-memory-vault` 再重启。

### 数据库结构变更的约定

按现有模式走：`CREATE TABLE IF NOT EXISTS` 里带上新列，再补一次幂等的 `ALTER TABLE … ADD COLUMN`（旧库升级）与对应的 `CREATE INDEX IF NOT EXISTS`。

**存量行必须保持可解释。** 项目维度就是范例：升级前的行一律留在 `NULL`（全局），默认检索照样看得见它们，绝不会把旧记忆重新归属到某个项目、让使用者以为数据丢了。对应的回归用例是 E4。

## 许可

MIT License。原始版权归 [hjj588](https://github.com/hjj588) 所有，本分支的修改部分版权归 xs1023，完整条款见 [LICENSE](LICENSE)。
