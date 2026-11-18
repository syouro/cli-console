# CLAUDE.md — claude-history-viewer

浏览 `~/.claude/projects/` 下 Claude 对话历史的单文件 Web 服务。带登录鉴权，经反代公网访问。

## 硬约束

- **零依赖**：只用 Node 标准库，**不要引入任何 npm 包**（含 better-sqlite3、express 等）。
  需要"数据库"时用 JSON 文件（见「索引」），不要为此破例。
- **无构建步骤**：`server.js` + `app.js` 直接跑，改完 `pm2 restart` 即可。

## 架构

- `server.js` — 后端全部逻辑 + 内嵌整页 HTML/CSS（`HTML` 常量）。HTTP 手写路由。
- `app.js` — 前端 JS，由 `/app.js` 路由原样吐出；含**手写的轻量 Markdown 渲染器**
  （`md()`/`mdBlocks()`/`mdInline()`/表格），不依赖任何前端库。
  URL 带 `?v=<app.js mtime>`，改前端不用清缓存。
- 数据文件（均 gitignore，自动生成/手工维护，勿入库）：
  - `config.json` — 服务配置（扫描根、排除、端口等）；缺省全走默认值
  - `secret.json` — HMAC 密钥 + 登录密码（chmod 600）
  - `accounts.json` — 只读子账号（手工编辑，见「子账号」）
  - `favorites.json` — 收藏与备注（管理员私有，子账号拿不到）
  - `files/` — 文件区的上传/笔记目录（见「文件区」）
  - `index.json` — 列表/搜索索引（见下）

## 关键约定

- **环境变量始终优先于 config.json**（`PORT`/`HOST`/`COOKIE_PATH`/`SECURE_COOKIE`/
  `VIEWER_PASSWORD`/`CLAUDE_PROJECTS_DIR`/`CODEX_SESSIONS_DIR`/`CONFIG_PATH`/`INDEX_PATH`）。
- **多根扫描**：`roots` 可配多个；同名 项目/会话 在多根并存时**先配置的根优先**。
- **排除**：`exclude` 按项目目录名做 glob（`*` `?`）匹配，命中的项目既不列出、API 也拒绝
  （对 codex 按 cwd 推导出的项目名同样生效）。

## 子账号（accounts.json，只读 + 按项目白名单）

- 用途：给领导等外人看**指定项目**的对话，不暴露其他项目。手工编辑 `accounts.json`：
  ```json
  { "leader": { "password": "xxx", "projects": ["-root-codexDir-HNLGDT*"], "share": true } }
  ```
  `projects` 是**项目目录名**的 glob（与 `exclude` 同款语法；codex/agy 的 cwd 推导名同样适用）；
  `share` 允许该账号生成分享链接。改文件即时生效（mtime 缓存）；**删账号 = 吊销其所有已登录会话**
  （`authOf` 每次都查账号还在不在）。权限做成字段是为了以后好扩档（比如给某账号开 tmux）。
- 登录：登录框多一个用户名（管理员留空走 `secret.json` 密码）；token 里子账号带 `u` 字段，
  管理员 token 不带（老 cookie 兼容）。
- 子账号一律**只读**：列表/会话/搜索/统计/导出全按 `projAllowed()` 过滤；
  删除、收藏、`/api/file`、`/api/files*`、`/api/tmux*` 全部仅管理员（`admin` 判定）。
  新加涉写或跨项目的路由时**务必**加同款判定。

## 文件区（/api/files*，仅管理员）

- 独立「📁 文件」页签：上传 md/图片，md/txt 可在线编辑保存，图片直出预览，
  html/svg 只进 `allow-scripts` 沙箱 iframe（与 `/api/file` 同款，防拿本站 cookie）。
- 与 `/api/file` 的区别：这里**可写**，但只圈在 `files/` 一个目录里——
  文件名过 `safeUpName()`（白名单字符、不许点开头、不含分隔符 → 无法穿越），
  扩展名限 `UP_TEXT`/`UP_IMG`，单文件 10MB。
- `/api/files/raw` 只直出图片（html/svg 当文档打开能跑同源脚本），其余类型仅 `dl=1` 附件下载；
  pdf 等 `UP_BIN` 只存和下载、不预览。
- 上传是原始字节体 + 查询串文件名（零依赖不解析 multipart）；重名回 409，`force=1` 覆盖，
  `auto=1` 自动加 `-2/-3` 后缀改名（对话框贴图用），响应带盘上绝对 `path`。
- **对话输入框贴文件**：`#cin` 粘贴/拖放/📎 选择的文件走 `composerUpload()` 传进文件区，
  把绝对路径插进输入框——发给 tmux 里的 CLI 后 agent 直接 Read 该路径。
  剪贴板贴图统一叫 image.png，前端换成 `贴-<时间戳>.<ext>`。

## codex 数据源（Claude / Codex 两页独立）

- **数据源适配器 `SOURCES`**：claude / codex 的差异（scan / locate / stamp / parse /
  listable / remove / key）全部收敛在这张表里，`refreshIndex` / `loadSession` /
  `deleteSession` 主流程与源无关；**再接别的 agent CLI = 加一个对象**，主流程不动。
  同理前端工具渲染是注册表 `TOOL_VIEWS`（对象 input）+ `STR_TOOL_VIEWS`（字符串 input），
  加新工具的展示 = 调一次 `reg()`。
- 所有涉及会话的 API 都带 `src` 参数（`claude` 默认 / `codex`）；前端 `SRC` 全局 + 页签切换，
  列表 / 搜索 / 统计 / 收藏互不混。分享 token 里 codex 会话带 `sr` 字段，跨源冒充会被拒。
- `codexRoots`（默认 `~/.codex/sessions`，目录存在即启用，`"codex": false` 可强关）：
  `YYYY/MM/DD/rollout-<时间>-<uuid>.jsonl`，**id 里带日期，可直接推出文件路径**（`codexFile()`）。
- `parseCodexSession()` 的坑：
  - 正文只取 `response_item`（`event_msg` 的 user_message/agent_message 与之**重复**，
    只用其中的 `token_count.last_token_usage` 记用量；`input_tokens` 含缓存读，要拆开）；
  - 思考在 `reasoning.summary[]`（`content` 是加密的）；模型名来自 `turn_context`；
  - `custom_tool_call` 的 `input` 是**字符串**（apply_patch 补丁 / exec 脚本），前端 `toolView`
    对字符串 input 单独处理；
  - 环境包裹（`<environment_context>`、`# AGENTS.md instructions` 等）标 `isMeta` 隐藏，
    见 `CODEX_META_RE`；续接注入的 `The following is the Codex agent history` 整段标
    `compact` 折叠；`thread_source === 'subagent'`（guardian 审批评估等）整个会话不进索引。
- 索引键：claude 仍是 `project/<id>`（老 index.json 有效），codex 用 `codex:<id>`；
  codex 无项目目录，项目名由 cwd 编码（`codexProject()`，与前端 `encCwd` 同款）。
- 会话标题优先取 `~/.codex/session_index.jsonl` 的 thread_name，缺省用首条用户消息。

## agy 数据源（Antigravity CLI，第三个页签）

- 根目录 `agyRoots`（默认 `~/.gemini/antigravity-cli`，目录存在即启用，`"agy": false` 强关，
  env `AGY_DIR` 覆盖）；索引键 `agy:<uuid>`。
- **主存储读不动**：`conversations/<uuid>.db` 是 SQLite、步骤是 protobuf blob（老会话 `.pb`），
  零依赖下不去碰；解析走 `brain/<uuid>/.system_generated/logs/transcript_full.jsonl`
  （CLI 同步导出的 JSONL，退回 `transcript.jsonl`）。已知局限：**没有 token 用量**（usage 恒零）、
  被压缩过的超长会话可能缺开头（有 CHECKPOINT 条目）、个别会话没有 transcript。
- `parseAgySession()` 的坑：
  - USER_INPUT 的正文包在 `<USER_REQUEST>` 里，其余（ADDITIONAL_METADATA /
    USER_SETTINGS_CHANGE…）是环境注入，没包裹的按 isMeta 隐藏；模型名只能从
    `Model Selection` 设置变更句里挖（名字带点如 `Gemini 3.5`，截断要认「句号+空白」）；
  - PLANNER_RESPONSE 带 `thinking` / `content` / `tool_calls[]`（args 大驼峰：AbsolutePath、
    CommandLine…，前端按名字 reg 了 view_file / run_command / replace_file_content 等）；
  - 其余类型（VIEW_FILE / RUN_COMMAND / CODE_ACTION…）是工具执行步骤，content 即结果，
    开头两行 `Created At:/Completed At:` 剥掉；错误看 `error` / `exit_code`。
- workspace（→ 项目名，编码同 codexProject）与起止时间来自根下 `history.jsonl`
  （每条用户输入 {display, timestamp, workspace, conversationId}，`agyMeta()` 按 mtime 缓存）。
- 删除 = 整个 `brain/<uuid>` 目录 + `conversations/<uuid>.db|.pb` 一起删。

## tmux 桥接（网页控制台）

- 默认关闭；config.json `"tmux": true` 或 `TMUX_UI=1` 开启（不叫 TMUX：tmux 会注入同名变量）。
- 思路是「翻译层」而非裸终端：`capture-pane` 抓屏 → `paneState()` 解析出交互状态
  （`menu` 编号选项菜单 / `busy` 干活中 / `idle` 空闲 / `unknown`）→ 前端渲染成原生控件
  （选项按钮、聊天输入框）→ UI 操作经 `send-keys` 翻译成按键注回 CLI。裸终端画面是兜底视图。
- 路由：`GET /api/tmux`（窗格列表）、`GET /api/tmux/sys`（服务器状态：/proc 读内存/负载/磁盘 +
  每窗格进程树 RSS，估算「还能再开几个 agent」——单价取现有 agent 窗格 RSS 中位数，
  没有样本按 500MB；终端页顶部状态条 10s 轮询展示）、`GET /api/tmux/pane?t=%N[&lite=1]`（抓屏+状态）、
  `POST /api/tmux/send`（注入；文本走 `tmuxPaste()` 括号粘贴，具名键过 `TMUX_KEYS` 白名单）、
  `POST /api/tmux/new`（新建会话：会话名过白名单、cwd 必须是已存在目录；启动命令会
  包一层 `; exec $SHELL`，命令退出后落回 shell 而不是会话消失）、`POST /api/tmux/kill`（关窗格）、
  `POST /api/tmux/resize`（`resize-window -x/-y` 调窗口宽高；手机开裸终端时前端自动
  按屏幕宽高适配，桌面不自动动、有「适配屏幕」按钮手动触发；本地终端想恢复自适应用
  `resize-window -A`）。
- 会话视图底部 `#composer` 控制条：要先把会话**绑定**到窗格。`tmuxPanes()` 经 `bindPanes()` 给每个
  窗格标 `sid`/`ssrc`（它正在跑的会话）：claude 读各扫描根旁的 `~/.claude/sessions/<pid>.json`
  （CLI 自己登记的 pid ↔ sessionId ↔ cwd，多账号各 HOME 一份），按 pid 爬 `/proc` ppid 链落到
  哪个 pane_pid 就是哪个窗格，`procStart` 与 `/proc/<pid>/stat` 的 starttime 对不上视为 pid 复用；
  codex / agy 没登记文件，翻窗格进程树打开的 fd 里带不带会话 uuid（`rollout-*-<uuid>.jsonl`、
  `brain/<uuid>/`），认不出就空着。前端 `pickPane()`：先认 `sid` 相同的窗格，否则退回 cwd / 项目名
  匹配且**跳过已绑到别的会话的窗格**，仍有多个候选时给下拉改选（记 localStorage `chv-pane:<src>:<id>`）
  并标「按目录猜的」；「关 tmux」的确认框也写明是否已确认。只按 cwd 猜的老逻辑在同目录开多个
  agent 时会串台（发错 / 关错窗格）。
- `/api/tmux/send` 的文本：≤3 个字符且无换行（菜单编号、y/n）用 `send-keys -l` 当按键打入，
  成段正文才走 `tmuxPaste()` 括号粘贴——粘贴进去的 "1" 会被 claude 当成往输入框贴文本，编号菜单不认，
  网页上点选项就没反应。
- 解析的坑（都有测试兜着，样本全部来自真实抓屏；覆盖 claude / codex / agy 三家 CLI）：
  - tmux 会把 `-F` 输出里的控制字符转成八进制字面量，分隔符用可打印的 `␟`；
    选项块下方常有提示行/状态栏，不能要求菜单贴底；输入提示符可能是 `>`/`❯`/`›`。
  - **状态解析只喂可见屏幕**（`capture-pane` 不带 `-S`）：带滚回历史会把翻上去的旧菜单
    误认成还挂着。裸终端展示才抓滚回。
  - 编号菜单：光标 `[>❯›]`（claude `❯` / codex `›` / agy 裸 `>`），序号 1 起连续且
    **恰一行带光标**才算（防正文有序列表、markdown 引用块）；编号行之间允许夹描述行/
    续行/分隔线，归上方选项当 `desc`；codex 同行右列描述按 2+ 空格切。
    下方有 `Press enter to confirm/continue` 的（codex 按数字只移光标）带 `enter` 标记，
    前端点按钮补回车；claude / agy 按数字直接生效，不能补。
  - 无编号菜单（agy 信任框/模型选择器等）：锚「↑/↓」提示行（须贴近屏底），向上收选项，
    空行/滑杆装饰/深缩进说明可跳过；带 `nav` 标记，前端换算成 ↑/↓ 步数+回车
    （send 具名键上限 24 就是为这个留的）。
  - agy 干活时输入框仍挂在屏上，靠盲文点阵转轮（`⣯ Generating…`）认 busy，
    不然会被 `>` 提示符骗成 idle。

## 安全（改动时务必保持）

- 前端所有拼进 innerHTML 的动态文本都过 `esc()`/`hi()` 转义；新增渲染同样处理。
- 后端 `project`/`id` 一律过 `NAME_RE`（`^[A-Za-z0-9._-]+$`）白名单，防路径穿越。
- 密码与 token 用 `crypto.timingSafeEqual` 常数时间比较；登录限速 + 指数退避 + 固定延时。
- 分享 token 带会话作用域（`sp`/`si`），`authOf` 拒绝它冒充登录会话。
- 子账号（见「子账号」）：所有读接口按项目白名单过滤，所有写接口与
  `/api/file`、`/api/tmux*`、`/api/files*` 仅管理员；新路由照此办理。
- tmux 桥接 = 远程命令执行：所有 `/api/tmux*` 路由仅管理员（不接受分享 token、子账号也拒）、
  受 `TMUX_UI` 开关控制；pane 目标过 `PANE_RE`（`^%\d+$`），具名键过白名单，文本长度设上限。
- `/api/file`（工具块「预览」按钮的后端）：仅管理员（不接受分享 token）、只收绝对/`~`路径、
  扩展名过 `FILE_EXTS` 白名单、限 5MB。前端 html/svg 只进 `sandbox="allow-scripts"` 的 iframe
  （不给 same-origin，拿不到本站 cookie/API）；md 走内置渲染器（输出已转义）。

## 缓存与索引（按需加载 + 惰性释放）

- `cache`：全量会话（含消息体）LRU，上限 `CACHE_MAX`；只在**打开会话 / 搜索命中候选**时填充。
- `INDEX`（→ `index.json`，version 2）：**摘要**索引（无消息体），常驻内存，列表 / 统计只碰它。
- `BLOBS`（→ `index.blobs.json`）：搜索用的**正文/思考 blob**（大）。**惰性读盘、闲置 `BLOB_TTL_MS` 后释放内存**。
  - 平时只看历史 **不载入 blob**；只有搜索才 `ensureBlobs()` 读盘，之后 `releaseBlobs()` 定时释放。
  - `blobFor()` 自愈：blob 缺失或 stamp 与摘要不符，就解析该会话重建。
  - 失效键 `cacheStamp(mtime，含子代理文件)`；`refreshIndex()` 增量刷新摘要（**不碰 blob**，除非已载入）。
  - 搜索：先用 blob 粗筛（全词命中才算候选），**只有候选才 `loadSession` 全量解析**算精确命中数与片段。
  - 落盘走 3s 防抖 + 退出 flush；改了 `parseSession` / `summary` 结构后删掉这两个文件重建。

## 删除会话

- `deleteSession()`：`fs.unlinkSync` 删 `.jsonl` + `fs.rmSync` 删 `<id>/subagents` 目录，并清 cache/INDEX/BLOBS/FAVS。
- **不可恢复**。`POST /api/delete` 仅管理员可用（`if (!authed)` 之后），**不接受分享 token**；前端二次 `confirm`。

## Android 壳子（`android/`）

- 极简 WebView 壳，**独立子项目**：纯 Android SDK + Java，不引第三方库；
  零依赖约束只管 `server.js`/`app.js`，与壳子互不影响。
- 本机没有 Android SDK，**构建只在 GitHub Actions 上做**（`.github/workflows/android.yml`）：
  打 `v*` tag 自动出 APK 挂 Release，或手动 Run workflow 取 artifact。
- 服务器地址存 SharedPreferences，首次启动进 `SetupActivity` 填写；
  长按返回键 / 桌面长按图标快捷方式可再改。壳内拦截 `app://settings`、`app://reload`。
- WebChromeClient 实现了 `onShowFileChooser`（多选走 clipData）：不实现的话网页里所有
  `<input type=file>`（文件页上传、对话框 📎）点了都没反应。
- 签名：secrets 配了 `KEYSTORE_BASE64` 等四项就用固定签名，否则退回 debug 签名。

## 运行 / 调试

```bash
# 生产（pm2 常驻）
COOKIE_PATH=/history/ SECURE_COOKIE=1 pm2 start server.js --name claude-history
pm2 restart claude-history      # 改代码后

# 本地 http 调试（cookie 去掉 Secure、放开 Path）
SECURE_COOKIE=0 COOKIE_PATH=/ PORT=48999 node server.js
```

## 测试

```bash
node --test        # test/ 下的 node:test 用例（纯函数 + parseSession + 索引）
```

`server.js` 被 require 时不启动服务器（`require.main === module` 守卫），可直接测其导出函数。

## 术语（继承 codexDir 全局约定）

- "笔记" / "记录一下" = 创建或更新文件，不是更新 agent 记忆。有歧义先问。

## agent 互通脚本（`tools/bridge.js`，命令名 `agbridge`）

- 让同机 tmux 里的 claude / codex / agy 互发消息：找收件人窗格 → 等 `paneState()` 判 idle →
  `tmuxPaste()` 括号粘贴进带信封头的正文（`[bridge #id from= to= kind= re=]…[/bridge]`）→ 停一拍补 Enter。
  **不能用 `send-keys -l` 逐字打**：codex 靠按键间隔猜粘贴，几百字的正文它嚼完之前补的 Enter
  （哪怕隔两三秒的第二个）全被当成粘贴里的换行吞掉，消息一直挂在输入框里不发；
  `load-buffer` + `paste-buffer -p` 有明确的粘贴结束标记，三家 CLI 都开了 bracketed paste。
  就是网页控制条那条通道换了个调用方；不走 HTTP、不要鉴权（本机同用户），
  `require('../server.js')` 复用 `paneState`。命令名不能叫 `bridge`：与 iproute2 的 `/usr/sbin/bridge` 撞名。
- 对方忙就 `spawn` 一个 detached 子进程（`--deliver <json>`）轮询到空闲再投，调用方立即返回；
  `--now` 跳过空闲判断、`--sync` 前台等。等半小时没空闲放弃并记 log。
- 信封里的身份：agent 名唯一就用 agent 名，同类多个（两个 claude）用 tmux 会话名（`nameOf`）。
- 状态文件在 `/root/.agent-bridge/`（按 `os.userInfo().homedir` 定，不看 $HOME：多账号 claude 改了 HOME、codex 用 /root，必须共用一份；`seq.json` 按发送者自增编号、`log.jsonl` 投递记录）。
- 防互回靠 `kind`：只有 `ask` 要回，`note`/`reply` 不回。两边 agent 的 CLAUDE.md / AGENTS.md
  要贴 `tools/bridge-protocol.md` 那段说明，否则会把 `[bridge]` 段当用户指令。
- 认 CLI 靠 `/proc/<pane_pid>/…/cmdline`（codex 的 `pane_current_command` 是 node；
  exec 启动的 claude 没子进程，得看 pane_pid 自己）。

- 多机互通由 `tools/bridge-network.js` 实现。`agbridge relay` 维护在线节点，`agbridge up` 通过 TLS 注册并上报心跳和前台 agent。跨机地址用 `机器/agent`，回复时照抄 `from`。收件节点按窗格串行投递，并在粘贴前复查 agent 进程身份。配置步骤见 README 的「多机互通」。
