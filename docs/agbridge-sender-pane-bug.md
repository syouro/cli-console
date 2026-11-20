# agbridge 跨机消息的发件窗格写错，回信送不回去

发现日期：2026-11-20  
状态：已定位到代码，根因在发件机上待确认，未修

## 现象

- node5 的 `~/.agent-bridge/log.jsonl` 里，chat-linux 发来的所有跨机消息，发件人都是
  `83017aa83ec80c4834a73e03/%0`。从 06:33 到 08:09 一共 8 条，有进度通知、评审回复，
  也有关于 AGENTS.md 的商议，不管是哪个 codex 发的都一样。
- 同一时间在 node5 上跑 `agbridge list`，chat-linux 的两个 codex 分别是：
  ```
  chat-linux/%1  fireKeeperCodex  codex  idle  /root/codexDir/firekeeper
  chat-linux/%3  stepCodex        codex  idle  /root/codexDir/step-platform
  ```
  `%0` 不在 agent 列表里。
- 照信封里的地址回复会失败：
  ```
  $ agbridge send 83017aa83ec80c4834a73e03/%0 reply net-10292272581499750376 --file ...
  找不到收件人「%0」，agbridge list 看看有哪些
  ```
  改成 `chat-linux/%3` 手动重发，就能送达。

影响：跨机消息本身能送达，只是回信地址错了。收件方按规范回复（直接用信封里的 `from`）
一定失败，只能人工找出正确的窗格。

## 代码里的原因（tools/bridge.js）

1. 发件人取自 `whoAmI()`，它只看 `$TMUX_PANE`：
   ```js
   const byId = all.find((p) => p.id === process.env.TMUX_PANE);
   ```
   跨机发送时写成 `from: opt.from || me.pane || me.name`，也就是直接用 `$TMUX_PANE`
   对应的窗格号。
2. 收件机在 `receiveRemote()` 里调用 `resolveTo()`，只在 `p.agent` 非空的窗格里找收件人。
   `%0` 不是 agent 窗格，所以找不到。

所以只要发件进程里的 `$TMUX_PANE` 不是它自己所在的窗格，回信地址就是错的。发件时没有
任何校验，问题要到对方回复时才暴露。

## 根因（待在 chat-linux 上确认）

两个 codex（`%1` 和 `%3`）报的都是 `%0`，说明它们执行 `agbridge` 时，环境里的
`TMUX_PANE` 都是 `%0`。可能的原因：

- codex 在沙箱外执行命令（agbridge 需要这样才能连上 tmux socket）时，经过的进程用的
  不是 codex 自己窗格的环境；
- 或者两个 codex 是从 `%0` 里的某个进程启动的，带着它的环境。

需要在 chat-linux 上由 codex 实际跑一下才能确定：
```bash
echo "$TMUX_PANE"
tmux list-panes -a -F '#{pane_id} #{session_name} #{pane_pid} #{pane_current_command}'
ps -o pid,ppid,comm -p $$ ; # 再顺着 ppid 往上看到 tmux 窗格的 shell
```

## 修复方案：按本机进程树找发件窗格，不再只信 `$TMUX_PANE`

窗格号只在本机有意义，`$TMUX_PANE` 只是继承来的环境变量，可能过时，也可能被别的进程
带进来。更可靠的做法是在发件机上按 PID 认窗格：

1. 从 `process.pid` 开始，顺着 `/proc/<pid>/stat` 的 ppid 一路往上走到 1，得到祖先 PID 集合。
2. 在 `panes()` 的结果里找 `pane_pid` 落在这个集合里的窗格，它就是真正的发件窗格。
   tmux 窗格的 `pane_pid` 是窗格里的 shell 或 agent 进程，agent 调起的 bash 和 agbridge
   都是它的子孙进程。
3. `$TMUX_PANE` 只用来交叉核对：两者一致就直接用；不一致时以进程树为准，并在 stderr
   提示一句。
4. 进程树里找不到窗格时（比如不在 tmux 里运行），退回 `--from`，或者报错让用户指定，
   不要写一个对方回不来的地址。
5. 发件前再校验一次：解析出的窗格必须是 agent 窗格（`agentOf()` 认得出来），否则给出提示。

本机发送（`resolveTo(all, to, me.pane)` 用来排除自己）也走同一个 `whoAmI()`，改完后
本机和跨机都会受益。

注意：codex 默认沙箱里可能读不到别的进程的 `/proc`，但 agbridge 本来就要在沙箱外运行
（否则连不上 tmux socket），所以这个限制不会多出新的要求。

测试建议：在 `test/bridge.test.js` 里构造一个 `TMUX_PANE` 指向别的窗格的场景，断言
`whoAmI()` 返回进程树对应的窗格。
