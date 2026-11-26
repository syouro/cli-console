#!/usr/bin/env node
'use strict';
// agbridge —— 本机与已加入网络的 tmux agent CLI（claude / codex / agy）互发消息。
// 原理是「程序替你粘贴」：找到收件人窗格，等它空闲，把带信封头的正文括号粘贴进它的
// 输入框再补回车；对方看到的就是一条开头写着「谁发的、几号、要不要回」的用户消息。
// 多机：relay [端口] 开中转，invite 查看加入码，join <host:port> [机器名] 加入，up 上线。
//
//   agbridge list [--json]                 列出 agent 窗格与 Firekeeper 信箱
//   agbridge send <to> ask|note "正文"     to = agent 名、会话名、%N 或 机器/agent
//   agbridge send <to> reply <re-id> "正文"
//   send --json 输出单条投递回执
//   agbridge start <[机器/]会话> <claude|codex|agy> <目录>
//   agbridge stop <[机器/]会话>            关闭由 agbridge start 创建的会话
//   跨机启动与关闭需在目标机运行 agbridge up --allow-manage
//   agbridge log [n] [--me|--for <name>]    最近 n 条投递记录，可按参与者筛选
// 正文也可以 --file <path> 或走 stdin（正文参数为 - ）。
// 默认对方忙就后台排队等空闲再投；--sync 前台等；--now 不等直接敲。

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('node:crypto');
const network = require('./bridge-network.js');
const { readMailboxes, mailboxRows, submitMail } = require('./bridge-mailboxes.js');
const { execFile, spawn } = require('child_process');
const { paneState, tmuxPaste } = require(path.join(__dirname, '..', 'server.js'));

// 状态目录按系统账号的 home（/etc/passwd）定，不看 $HOME：多账号 claude 各自改了 HOME，
// codex 用的是 /root，编号和日志必须共用一份，否则 log 互相看不见、编号也可能撞
const HOME = process.env.AGBRIDGE_DIR || path.join(os.userInfo().homedir, '.agent-bridge');
const SEQ = path.join(HOME, 'seq.json');
const LOG = path.join(HOME, 'log.jsonl');
const AGENT_RE = /(^|\/|\s)(claude|codex|antigravity|agy|gemini|hearth|firekeeper|experience(?:-main)?)(\s|$|\.js|\.mjs)/i;
const START_AGENTS = new Set(['claude', 'codex', 'agy']);
const SESSION_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,49}$/;
const MANAGED_OPTION = '@agbridge-managed';
const NO_TMUX_SERVER = /^no server running on |^error connecting to .* \(No such file or directory\)$/i;
const KINDS = new Set(['ask', 'note', 'reply']);
const MAX_LEN = 10000;         // 与 /api/tmux/send 同款上限
const WAIT_MAX_MS = 30 * 60e3; // 排队最长半小时，超时放弃并记 log
const POLL_MS = 2000;

function tmux(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 5000, maxBuffer: 4 << 20, ...options }, (err, out, serr) => {
      if (!err) return resolve(out);
      reject(new Error(String(serr || '').trim() || String(err.message || err), { cause: err }));
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 窗格里跑的是哪家 CLI：看 pane_pid 自身及其子进程的 cmdline（codex 的进程名是 node，
// 靠 pane_current_command 认不出来；exec 启动的 claude 没有子进程，得看自己）
function agentOf(pid, foregroundOnly) {
  const pids = [pid];
  try {
    const kids = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
    if (kids) pids.push(...kids.split(/\s+/).map(Number));
  } catch { /* 无 /proc children 接口时只看自己 */ }
  for (const p of pids) {
    let cmd, identity;
    try {
      const argv = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0');
      cmd = argv.join(' ').trim();
      if (foregroundOnly) {
        const stat = fs.readFileSync(`/proc/${p}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (fields[2] !== fields[5] || +fields[5] <= 0) continue; // pgrp must own the tty
        identity = p + '-' + fields[19]; // pid + kernel start time survives pane/shell reuse
        const executable = path.basename(argv[0]);
        cmd = /^(node|nodejs|bun|bash|sh)$/.test(executable) ? argv[1] || '' : argv[0];
      }
    } catch { continue; }
    const m = cmd.match(AGENT_RE);
    if (m) {
      const name = m[2].toLowerCase();
      let agent = name;
      if (name === 'antigravity' || name === 'gemini') agent = 'agy';
      if (name === 'firekeeper' || name.startsWith('experience')) agent = 'hearth';
      return { agent, identity };
    }
  }
  return { agent: '' };
}

async function panes(foregroundOnly = false) {
  const fmt = ['#{pane_id}', '#{session_name}', '#{window_index}', '#{pane_index}',
    '#{pane_current_command}', '#{pane_pid}', '#{pane_current_path}'].join('␟');
  let out;
  try { out = await tmux(['list-panes', '-a', '-F', fmt]); }
  catch (e) {
    if (e.cause?.code === 'ENOENT' || NO_TMUX_SERVER.test(e.message)) return [];
    throw e;
  }
  return out.split('\n').filter(Boolean).map((l) => {
    const [id, session, win, idx, cmd, pid, ...cwd] = l.split('␟');
    return { id, session, target: `${session}:${win}.${idx}`, cmd, cwd: cwd.join('␟'), pid: +pid,
      ...agentOf(+pid, foregroundOnly) };
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
function whoAmI(all, opt, mailboxSender = false) {
  const byId = !mailboxSender && all.find((p) => p.id === process.env.TMUX_PANE);
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

function resolveMailbox(mailboxes, all, to) {
  const mailbox = mailboxes.find(p => p.name === to);
  if (mailbox && all.some(p => p.session === to)) {
    throw new Error(`「${to}」同时匹配 Firekeeper 信箱和 tmux 会话，请用 pane id 或给信箱改名`);
  }
  return mailbox;
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
async function deliver(m, opt, t0 = Date.now()) {
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
  if (m.remotePane) {
    const current = (await panes(true)).find(p => p.id === m.to);
    if (current?.identity !== m.remotePane) {
      logLine({ ...m, status: 'gone' });
      throw new Error('收件 agent 已退出或被替换');
    }
  }
  await tmuxPaste(m.to, envelope(m));
  await sleep(200);
  await tmux(['send-keys', '-t', m.to, 'Enter']);
  logLine({ ...m, status: 'sent', waitedMs: Date.now() - t0 });
}

function parseArgs(argv) {
  const opt = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' || a === '--from' || a === '--for') opt[a.slice(2)] = argv[++i];
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

async function agentRows(foregroundOnly = false) {
  const all = await panes(foregroundOnly);
  return Promise.all(all.filter(p => p.agent).map(async p => ({
    id: p.id, session: p.session, agent: p.agent, state: await stateOf(p.id), cwd: p.cwd
  })));
}

async function discoverMembers(foregroundOnly = false) {
  const [agents, mailboxes] = await Promise.all([agentRows(foregroundOnly), mailboxRows(readMailboxes(HOME))]);
  return { agents, mailboxes };
}

async function cmdList(opt) {
  const machines = [], members = [];
  function add(node, prefix, machineId) {
    for (const p of node.agents) members.push({ type: 'tmux', address: prefix + p.id, name: p.session,
      agent: p.agent, state: p.state, cwd: p.cwd, machineId });
    for (const p of node.mailboxes ?? []) members.push({ type: 'mailbox', address: prefix + p.name, name: p.name,
      agent: 'firekeeper', state: p.state, machineId });
  }
  let error, haveLocal = false;
  try {
    const config = network.readConfig();
    const id = config ? network.machineId(config.key) : null;
    add(await discoverMembers(), '', id);
    haveLocal = true;
    if (config) {
      const nodes = await network.call(config, 'list').catch(e => { throw new Error('中转不可达：' + e.message); });
      for (const node of nodes) {
        const local = node.id === id;
        const host = nodes.filter(n => n.name === node.name).length > 1 ? node.id : node.name;
        machines.push({ id: node.id, name: node.name, local });
        if (!local) add(node, host + '/', node.id);
      }
      if (!machines.some(n => n.local)) console.error('本机尚未上线，运行 agbridge up');
    }
  } catch (e) {
    if (!opt.json && !haveLocal) throw e;
    error = e.message;
    process.exitCode = 1;
  }
  if (opt.json) { console.log(JSON.stringify({ machines, members, error })); return; }
  for (const node of machines) console.log(`${node.name}  ${node.id}  在线${node.local ? '（本机）' : ''}`);
  if (error) console.error(error);
  if (!members.length) { console.log('没有找到 agent 窗格'); return; }
  const rows = members.map(p => p.type === 'tmux'
    ? [p.address, p.name, p.agent, p.state, p.cwd, p.address === process.env.TMUX_PANE ? '← 我' : '']
    : [p.address, '', p.agent, p.state === 'online' ? '在线' : '离线', '', '']);
  const w = rows.reduce((a, r) => r.map((c, i) => Math.max(a[i] || 0, String(c).length)), []);
  for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd());
}

async function startSession(session, agent, directory, remote) {
  if (!START_AGENTS.has(agent)) throw new Error('只支持启动 claude、codex 或 agy');
  if (typeof directory !== 'string' || !directory || /[\x00-\x1f\x7f]/.test(directory)) {
    throw new Error('请指定有效的工作目录');
  }
  const homeRelative = directory === '~' || directory.startsWith('~/');
  if (remote && !homeRelative && !path.isAbsolute(directory)) {
    throw new Error('跨机启动请指定目标机的绝对路径或 ~/目录');
  }
  const cwd = path.resolve(homeRelative ? path.join(os.homedir(), directory.slice(1)) : directory);
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
  } catch { throw new Error('目录不存在或不可访问：' + cwd); }

  // PATH 的相对项按 agbridge 自己的目录解析，目标目录无法改变 tmux 或 agent 的查找结果。
  const binDirs = (process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter).map(dir => path.resolve(dir));
  const installed = binDirs.some(dir => {
    const bin = path.join(dir, agent);
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return fs.statSync(bin).isFile();
    } catch { return false; }
  });
  if (!installed) throw new Error('目标机的 PATH 中找不到 ' + agent);

  // tmux 继承客户端 cwd。工作目录经 execFile 传入，避免被 tmux -c 当成格式串展开。
  const env = { ...process.env, PATH: binDirs.join(path.delimiter) };
  const pane = (await tmux(['new-session', '-d', '-s', session, '-P', '-F', '#{pane_id}',
    '--', '/bin/sh', '-c', 'exec ' + agent,
    ';', 'set-option', '-t', `=${session}:`, MANAGED_OPTION, '1'], { cwd, env })).trim();

  // send 在收件机即时查窗格，等到前台进程出现即可投递，无需等目录心跳。
  const deadline = Date.now() + 3000;
  do {
    const current = (await panes(true)).find(p => p.id === pane && p.session === session);
    if (!current) throw new Error(`${agent} 启动后已退出：${session}`);
    if (current.agent === agent) return { pane, ready: true };
    await sleep(100);
  } while (Date.now() < deadline);
  return { pane, ready: false };
}

async function stopSession(session) {
  // 在一条 tmux 命令中检查标记并关闭，完整会话名后加 : 指向其活动窗格。
  const managed = `#{&&:#{==:#{session_name},${session}},#{==:#{${MANAGED_OPTION}},1}}`;
  const result = await tmux(['if-shell', '-F', '-t', `=${session}:`, managed,
    `kill-session -t =${session}`, 'display-message -p missing']).catch(e => {
    if (!NO_TMUX_SERVER.test(e.message)) throw e;
    return 'missing';
  });
  if (result.trim() === 'missing') throw new Error('找不到由 agbridge 启动的会话：' + session);
  return true;
}

async function manageSession(method, { session, agent, cwd }, remote = false) {
  if (typeof session !== 'string' || !SESSION_NAME.test(session)) {
    throw new Error('会话名限 1–50 位字母、数字、下划线或连字符，首位不能是连字符');
  }
  return method === 'start' ? startSession(session, agent, cwd, remote) : stopSession(session);
}

async function cmdSession(opt) {
  const [method, target, agent, cwd] = opt._;
  const start = method === 'start';
  if (opt._.length !== (start ? 4 : 2)) {
    throw new Error(start ? '用法：agbridge start <[机器/]会话> <claude|codex|agy> <目录>' :
      '用法：agbridge stop <[机器/]会话>');
  }
  const parts = target.split('/');
  const session = parts.pop();
  const [host] = parts;
  if (parts.length > 1 || host === '' || !session) throw new Error('会话地址格式为 会话名 或 机器/会话名');
  const data = { session, agent, cwd };
  let result;
  if (host) {
    const config = network.readConfig();
    if (!config) throw new Error('请先运行 agbridge join 加入网络');
    result = await network.call(config, method, { ...data, key: config.key, host });
  } else {
    result = await manageSession(method, data);
  }
  if (start) {
    const address = host ? host + '/' + result.pane : result.pane;
    console.log(`${result.ready ? '已启动' : '会话已创建，等待 agent 启动'} ${target} (${address})`);
  } else console.log('已关闭 ' + target);
}

async function cmdSend(opt) {
  const [, to = null, kind, ...rest] = opt._;
  let id = null;
  const print = (status, human) => console.log(opt.json ? JSON.stringify({ status, id, to }) : human);
  try {
    if (!to || !KINDS.has(kind)) throw new Error('用法：agbridge send <to> ask|note "正文" | send <to> reply <re-id> "正文"');
    let re = '';
    if (kind === 'reply') {
      re = rest.shift() || '';
      if (!/^[\w.-]+-\d+$/.test(re)) throw new Error('reply 要带被回复的消息编号，如 codex-12');
    }
    const body = readBody(opt, rest).trim();
    if (!body) throw new Error('正文为空');
    if (body.length > MAX_LEN) throw new Error(`正文超过 ${MAX_LEN} 字`);
    const mailboxes = readMailboxes(HOME);
    const mailboxSender = mailboxes.some(p => p.name === opt.from);
    const config = to.includes('/') ? network.readConfig() : null;
    const all = !config || (process.env.TMUX_PANE && !mailboxSender) ? await panes() : [];
    const me = whoAmI(all, opt, mailboxSender);
    const from = opt.from || me.pane || me.name;
    if (config) {
      const [host, target, ...extra] = to.split('/');
      if (!host || !target || extra.length) throw new Error('跨机地址格式为 机器/agent');
      id = 'net-' + crypto.randomBytes(8).readBigUInt64BE().toString();
      const message = { id, from, kind, re, body };
      const { status } = await network.call(config, 'send', { key: config.key, host, target, message,
        sync: !!opt.sync, now: !!opt.now });
      logLine({ ...message, from: me.name, toName: to, status });
      print(status, `${status === 'sent' ? '已送达' : '已排队'} #${id} → ${to}`);
      return;
    }
    const mailbox = resolveMailbox(mailboxes, all, to);
    if (mailbox) {
      id = 'mail-' + BigInt('0x' + crypto.randomBytes(12).toString('hex'));
      const { status } = await deliverMailbox(mailbox, { id, from, kind, re, body });
      print(status, `已送达 #${id} → ${to}`);
      return;
    }
    const dst = resolveTo(all, to, me.pane);
    id = nextSeq(me.name);
    const m = { id, from: me.name, to: dst.id, toName: nameOf(all, dst), toSession: dst.session, kind, re, body };
    const { status } = await dispatch(m, opt);
    print(status, `${status === 'sent' ? '已送达' : '已排队，空闲后自动送达'} #${id} → ${dst.session} (${dst.id})`);
  } catch (e) {
    if (!opt.json) throw e;
    console.log(JSON.stringify({ status: 'error', id, to, error: e.message }));
    process.exitCode = 1;
  }
}

async function deliverMailbox(mailbox, { id, from, kind, re, body }) {
  const mail = { id, from, to: mailbox.name, kind, body };
  if (re) mail.replyTo = re;
  const entry = { ...mail, toName: mailbox.name, re };
  let receipt;
  try { receipt = await submitMail(mailbox.socket, mail); }
  catch (e) { logLine({ ...entry, status: 'error', error: e.message }); throw e; }
  logLine({ ...entry, status: 'sent', receipt });
  return { status: 'sent' };
}

async function dispatch(m, opt) {
  const st = await stateOf(m.to);
  if (st === 'idle' || st === 'gone' || opt.now || opt.sync) {
    await deliver(m, opt);
    return { status: 'sent' };
  }
  const child = spawn(process.execPath, [__filename, '--deliver', JSON.stringify(m)],
    { detached: true, stdio: 'ignore' });
  await require('node:events').once(child, 'spawn');
  child.unref();
  logLine({ ...m, status: 'queued', lastState: st });
  return { status: 'queued' };
}

// Keep each remote envelope and its Enter together, including when several callers
// find the same pane idle simultaneously. The node owns its in-memory queue.
const remoteTails = new Map();
async function dispatchRemote(m, opt) {
  const start = Date.now();
  const previous = remoteTails.get(m.to);
  const state = previous ? Promise.resolve('queued') : stateOf(m.to);
  const background = state.then(st => !opt.sync && (Boolean(previous) || (!opt.now && st !== 'idle' && st !== 'gone')));
  const done = (async () => {
    if (await background) logLine({ ...m, status: 'queued', lastState: await state });
    if (previous) await previous;
    await deliver(m, opt, start);
  })();
  const tail = done.catch(e => {
    console.error(`#${m.id} 投递失败：${e.message}`);
  }).finally(() => { if (remoteTails.get(m.to) === tail) remoteTails.delete(m.to); });
  remoteTails.set(m.to, tail);
  if (await background) return { status: 'queued' };
  await done;
  return { status: 'sent' };
}

async function receiveRemote({ sender, target, message, now, sync }, selfId) {
  const { id, from, kind, re, body } = message;
  if (!/^[a-f0-9]{24}$/.test(sender) || !/^net-\d+$/.test(id) || typeof from !== 'string'
      || !/^[^\s/[\]\x00-\x1f\x7f]{1,128}$/u.test(from) || !KINDS.has(kind)
      || (kind === 'reply' ? !/^[\w.-]+-\d+$/.test(re) : re !== '')
      || typeof body !== 'string' || !body.trim() || body.length > MAX_LEN
      || /[\x00-\x08\x0b-\x1f\x7f]/.test(body.replace(/\r\n/g, '\n'))) {
    throw new Error('无效的跨机消息');
  }
  const all = await panes(true);
  const messageData = { id, from: sender + '/' + from, kind, re, body: body.replace(/\r\n/g, '\n') };
  const mailbox = resolveMailbox(readMailboxes(HOME), all, target);
  if (mailbox) return deliverMailbox(mailbox, messageData);
  const agents = all.filter(p => p.agent);
  const dst = resolveTo(agents, target, sender === selfId ? from : '');
  return dispatchRemote({ ...messageData, to: dst.id, toSession: dst.session, toName: nameOf(agents, dst),
    remotePane: dst.identity }, { now, sync });
}

async function cmdLog(opt) {
  let lines = [];
  try { lines = fs.readFileSync(LOG, 'utf8').trim().split('\n'); } catch { /* 无记录 */ }
  let filter = opt.for || '';
  if (opt.me) {
    const all = opt.from || !process.env.TMUX_PANE ? [] : await panes();
    filter = whoAmI(all, opt).name;
  }
  const n = +opt._[1] || 20;
  const filtered = [];
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      if (filter) {
        if (o.from !== filter && o.toName !== filter && o.toSession !== filter && o.to !== filter) continue;
      }
      filtered.push(o);
    } catch { if (!filter) filtered.push(l); }
  }
  for (const o of filtered.slice(-n)) {
    if (typeof o === 'string') { console.log(o); continue; }
    const first = String(o.body || '').split('\n')[0].slice(0, 60);
    console.log(`${o.ts}  ${o.status.padEnd(6)}  #${o.id}  ${o.from}→${o.toName}  ${o.kind}${o.re ? ' re=' + o.re : ''}  ${first}`);
  }
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.deliver) { await deliver(JSON.parse(opt._[0]), {}); return; } // 后台排队子进程入口
  const cmd = opt._[0];
  if (cmd === 'relay') return network.relay(Number(opt._[1] ?? 7432));
  if (cmd === 'invite') { console.log(network.invite()); return; }
  if (cmd === 'join') {
    const [, address, name = os.hostname()] = opt._;
    if (!address) throw new Error('用法：agbridge join <中转地址:端口> [机器名]');
    if (process.stdin.isTTY) process.stderr.write('输入中转机 agbridge invite 给出的加入码：');
    const input = require('node:readline').createInterface({ input: process.stdin, terminal: false });
    let group = '';
    try { for await (const line of input) { group = line.trim(); break; } } finally { input.close(); }
    console.log('本机 ID：' + (await network.join(address, name, group)) + '。运行 agbridge up 上线。');
    return;
  }
  if (cmd === 'up') {
    const config = network.readConfig();
    if (!config) throw new Error('请先运行 agbridge join <中转地址:端口> [机器名]');
    const manage = opt['allow-manage'] ? (method, data) => manageSession(method, data, true) : undefined;
    return network.runNode(config, () => discoverMembers(true), receiveRemote, manage);
  }
  if (cmd === 'list' || cmd === 'ls') return cmdList(opt);
  if (cmd === 'send') return cmdSend(opt);
  if (cmd === 'start' || cmd === 'stop') return cmdSession(opt);
  if (cmd === 'log') return cmdLog(opt);
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 18).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exitCode = cmd ? 1 : 0;
}

if (require.main === module) main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
module.exports = { envelope, resolveTo, parseArgs, nameOf };
