#!/usr/bin/env node
'use strict';
// agbridge —— 同机 tmux 里的 agent CLI（claude / codex / agy）互发消息。
// 原理是「程序替你粘贴」：找到收件人窗格，等它空闲，把带信封头的正文括号粘贴进它的
// 输入框再补回车；对方看到的就是一条开头写着「谁发的、几号、要不要回」的用户消息。
// 不走 HTTP、不要鉴权（两边都是本机同一用户），零依赖，复用 server.js 的 paneState()。
//
//   agbridge list                          列出 agent 窗格与空闲状态
//   agbridge send <to> ask|note "正文"     to = claude|codex|agy|会话名|%N
//   agbridge send <to> reply <re-id> "正文"
//   agbridge log [n]                       最近 n 条投递记录
// 正文也可以 --file <path> 或走 stdin（正文参数为 - ）。
// 默认对方忙就后台排队等空闲再投；--sync 前台等；--now 不等直接敲。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { paneState, tmuxPaste } = require(path.join(__dirname, '..', 'server.js'));

// 状态目录按系统账号的 home（/etc/passwd）定，不看 $HOME：多账号 claude 各自改了 HOME，
// codex 用的是 /root，编号和日志必须共用一份，否则 log 互相看不见、编号也可能撞
const HOME = process.env.AGBRIDGE_DIR || path.join(os.userInfo().homedir, '.agent-bridge');
const SEQ = path.join(HOME, 'seq.json');
const LOG = path.join(HOME, 'log.jsonl');
const AGENT_RE = /(^|\/)(claude|codex|antigravity|agy|gemini)(\s|$|\.js)/;
const KINDS = new Set(['ask', 'note', 'reply']);
const MAX_LEN = 10000;         // 与 /api/tmux/send 同款上限
const WAIT_MAX_MS = 30 * 60e3; // 排队最长半小时，超时放弃并记 log
const POLL_MS = 2000;

function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 5000, maxBuffer: 4 << 20 }, (err, out, serr) => {
      if (!err) return resolve(out);
      reject(new Error(String(serr || '').trim() || String(err.message || err)));
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 窗格里跑的是哪家 CLI：看 pane_pid 自身及其子进程的 cmdline（codex 的进程名是 node，
// 靠 pane_current_command 认不出来；exec 启动的 claude 没有子进程，得看自己）
function agentOf(pid) {
  const pids = [pid];
  try {
    const kids = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
    if (kids) pids.push(...kids.split(/\s+/).map(Number));
  } catch { /* 无 /proc children 接口时只看自己 */ }
  for (const p of pids) {
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch { continue; }
    const m = cmd.match(AGENT_RE);
    if (m) return m[2] === 'antigravity' || m[2] === 'gemini' ? 'agy' : m[2];
  }
  return '';
}

async function panes() {
  const fmt = ['#{pane_id}', '#{session_name}', '#{window_index}', '#{pane_index}',
    '#{pane_current_command}', '#{pane_current_path}', '#{pane_pid}'].join('␟');
  const out = await tmux(['list-panes', '-a', '-F', fmt]);
  return out.split('\n').filter(Boolean).map((l) => {
    const [id, session, win, idx, cmd, cwd, pid] = l.split('␟');
    return { id, session, target: `${session}:${win}.${idx}`, cmd, cwd, pid: +pid, agent: agentOf(+pid) };
  });
}

async function stateOf(id) {
  try { return paneState(await tmux(['capture-pane', '-p', '-e', '-t', id])).kind; }
  catch { return 'gone'; }
}

// 窗格在信封里叫什么：agent 名唯一就用 agent 名（codex），同类有多个（两个 claude）用会话名，
// 不然 from=claude to=claude 分不清谁是谁
function nameOf(all, p) {
  if (!p.agent) return p.session;
  return all.filter((q) => q.agent === p.agent).length > 1 ? p.session : p.agent;
}

// 发送者：优先 $TMUX_PANE（agent 在 tmux 里跑 Bash 时会继承），否则 --from 指定
function whoAmI(all, opt) {
  const byId = all.find((p) => p.id === process.env.TMUX_PANE);
  const me = byId ? nameOf(all, byId) : '';
  return { name: opt.from || me || 'human', pane: byId ? byId.id : '' };
}

// 收件人：%N / 会话名 / agent 名；agent 名命中多个（排除自己）就报错让人指定
function resolveTo(all, to, selfPane) {
  const cands = all.filter((p) => p.id !== selfPane && (
    p.id === to || p.session === to || p.target === to || p.agent === to));
  if (cands.length === 1) return cands[0];
  if (!cands.length) throw new Error(`找不到收件人「${to}」，agbridge list 看看有哪些`);
  throw new Error(`「${to}」匹配到多个窗格，请用会话名或 pane id：\n` +
    cands.map((p) => `  ${p.id}  ${p.session}  (${p.agent || p.cmd})  ${p.cwd}`).join('\n'));
}

function nextSeq(from) {
  fs.mkdirSync(HOME, { recursive: true });
  let seq = {};
  try { seq = JSON.parse(fs.readFileSync(SEQ, 'utf8')); } catch { /* 首次 */ }
  seq[from] = (seq[from] | 0) + 1;
  fs.writeFileSync(SEQ, JSON.stringify(seq));
  return `${from}-${seq[from]}`;
}
function logLine(o) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n');
}

function envelope(m) {
  const head = [`#${m.id}`, `from=${m.from}`, `to=${m.toName}`, `kind=${m.kind}`];
  if (m.re) head.push(`re=${m.re}`);
  return `[bridge ${head.join(' ')}]\n${m.body.trim()}\n[/bridge]`;
}

// 真正敲进去：等空闲 → 正文括号粘贴（tmuxPaste，不用 send-keys -l 逐字打）→ 停一拍 → Enter。
// 逐字打的话 codex 靠按键间隔猜粘贴，几百字的正文它嚼完之前补的 Enter 全被当成换行吞掉，
// 消息就一直挂在输入框里不发；括号粘贴有明确结束标记，紧跟的 Enter 才是一次干净的回车
async function deliver(m, opt) {
  const t0 = Date.now();
  let st = await stateOf(m.to);
  while (!opt.now && st !== 'idle' && st !== 'gone') {
    if (Date.now() - t0 > WAIT_MAX_MS) {
      logLine({ ...m, status: 'timeout', lastState: st });
      throw new Error(`等了半小时对方一直「${st}」，放弃：#${m.id}`);
    }
    await sleep(POLL_MS);
    st = await stateOf(m.to);
  }
  if (st === 'gone') { logLine({ ...m, status: 'gone' }); throw new Error(`窗格 ${m.to} 已不存在`); }
  await tmuxPaste(m.to, envelope(m));
  await sleep(200);
  await tmux(['send-keys', '-t', m.to, 'Enter']);
  logLine({ ...m, status: 'sent', waitedMs: Date.now() - t0 });
}

function parseArgs(argv) {
  const opt = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' || a === '--from') opt[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) opt[a.slice(2)] = true;
    else opt._.push(a);
  }
  return opt;
}

function readBody(opt, rest) {
  if (opt.file) return fs.readFileSync(opt.file, 'utf8');
  const joined = rest.join(' ');
  if (joined === '-' || (!joined && !process.stdin.isTTY)) return fs.readFileSync(0, 'utf8');
  return joined;
}

async function cmdList() {
  const all = (await panes()).filter((p) => p.agent);
  if (!all.length) { console.log('没有找到 agent 窗格'); return; }
  const rows = [];
  for (const p of all) rows.push([p.id, p.session, p.agent, await stateOf(p.id), p.cwd,
    p.id === process.env.TMUX_PANE ? '← 我' : '']);
  const w = rows.reduce((a, r) => r.map((c, i) => Math.max(a[i] || 0, String(c).length)), []);
  for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd());
}

async function cmdSend(opt) {
  const [, to, kind, ...rest] = opt._;
  if (!to || !KINDS.has(kind)) throw new Error('用法：agbridge send <to> ask|note "正文" | send <to> reply <re-id> "正文"');
  let re = '';
  if (kind === 'reply') {
    re = rest.shift() || '';
    if (!/^[\w.-]+-\d+$/.test(re)) throw new Error('reply 要带被回复的消息编号，如 codex-12');
  }
  const body = readBody(opt, rest).trim();
  if (!body) throw new Error('正文为空');
  if (body.length > MAX_LEN) throw new Error(`正文超过 ${MAX_LEN} 字`);
  const all = await panes();
  const me = whoAmI(all, opt);
  const dst = resolveTo(all, to, me.pane);
  const m = { id: nextSeq(me.name), from: me.name, to: dst.id, toName: nameOf(all, dst),
    toSession: dst.session, kind, re, body };
  const st = await stateOf(dst.id);
  if (st === 'idle' || opt.now || opt.sync) {
    await deliver(m, opt);
    console.log(`已送达 #${m.id} → ${dst.session} (${dst.id})`);
    return;
  }
  // 对方在忙：丢给一个脱离终端的子进程等它空闲再投，自己立刻返回，别卡住调用方的 Bash
  const child = spawn(process.execPath, [__filename, '--deliver', JSON.stringify(m)],
    { detached: true, stdio: 'ignore' });
  child.unref();
  logLine({ ...m, status: 'queued', lastState: st });
  console.log(`对方正「${st}」，已排队 #${m.id} → ${dst.session} (${dst.id})，空闲后自动送达`);
}

function cmdLog(n) {
  let lines = [];
  try { lines = fs.readFileSync(LOG, 'utf8').trim().split('\n'); } catch { /* 无记录 */ }
  for (const l of lines.slice(-(n || 20))) {
    try {
      const o = JSON.parse(l);
      const first = String(o.body || '').split('\n')[0].slice(0, 60);
      console.log(`${o.ts}  ${o.status.padEnd(6)}  #${o.id}  ${o.from}→${o.toName}  ${o.kind}${o.re ? ' re=' + o.re : ''}  ${first}`);
    } catch { console.log(l); }
  }
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.deliver) { await deliver(JSON.parse(opt._[0]), {}); return; } // 后台排队子进程入口
  const cmd = opt._[0];
  if (cmd === 'list' || cmd === 'ls') return cmdList();
  if (cmd === 'send') return cmdSend(opt);
  if (cmd === 'log') return cmdLog(+opt._[1] || 20);
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exitCode = cmd ? 1 : 0;
}

if (require.main === module) main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
module.exports = { envelope, resolveTo, parseArgs, nameOf };
