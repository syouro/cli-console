'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { promisify } = require('node:util');
const { setTimeout: sleep } = require('node:timers/promises');
const { call, machineId, makeRelay } = require('../tools/bridge-network');
const cli = path.join(__dirname, '../tools/bridge.js');
const exec = promisify(execFile);

async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('等待测试节点状态更新超时');
    await sleep(100);
  }
}

test('独立 tmux 节点通过中转上线、双向投递、离线并以同一 ID 重连', {
  skip: process.platform !== 'linux' || spawnSync('tmux', ['-V']).status !== 0
}, async t => {
  const dir = fs.mkdtempSync(path.resolve(os.tmpdir(), 'bridge-net-'));
  const cleanup = [];
  t.after(async () => { for (const fn of cleanup.reverse()) await fn(); });
  cleanup.push(() => fs.rmSync(dir, { force: true, recursive: true }));
  const tmux = (await exec('sh', ['-c', 'command -v tmux'])).stdout.trim();
  assert.ok(path.isAbsolute(tmux));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  // Covers agbridge and server.js helpers. PATH contains only this wrapper so
  // even deleting the wrapper cannot redirect a later command to system tmux.
  fs.writeFileSync(path.join(bin, 'tmux'),
    '#!/bin/sh\nexec "${TEST_TMUX:?}" -S "${TEST_SOCKET:?}" "$@"\n', { mode: 0o700 });
  const group = crypto.randomBytes(32).toString('hex');
  const server = makeRelay(group);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const query = { host: '127.0.0.1', port, group };
  await assert.rejects(call({ ...query, group: '0'.repeat(64) }, 'list'));

  async function node(name, fallbackSocket) {
    const home = path.join(dir, name);
    fs.mkdirSync(home);
    const socketDir = path.join(home, 'sockets');
    const socket = path.join(socketDir, 'tmux.sock');
    const env = { ...process.env, PATH: bin, TEST_TMUX: tmux, TEST_SOCKET: socket,
      AGBRIDGE_DIR: home, TMUX_PANE: '', TMUX_TMPDIR: dir, TMUX: fallbackSocket ? fallbackSocket + ',0,0' : '' };
    const app = path.join(home, 'codex.js');
    const inbox = path.join(home, 'inbox');
    fs.writeFileSync(app, `process.stdin.setRawMode(true);
      function draw() {
        if (!require('node:fs').existsSync(__filename)) process.exit(0);
        process.stdout.write('\\x1b[2J\\x1b[H' + (require('node:fs').existsSync(${JSON.stringify(path.join(home, 'busy'))}) ? '⣯ Generating…' : '› '));
      }
      draw();
      setInterval(draw, 100);
      process.stdin.on('data', data => require('node:fs').appendFileSync(${JSON.stringify(inbox)}, data));
    `);
    async function openPane() {
      fs.mkdirSync(socketDir);
      await exec(tmux, ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', name, process.execPath, app], { env });
    }
    // The fixture exits its own process and tmux closes the last session.
    const closePane = () => fs.rmSync(app, { force: true });
    cleanup.push(closePane);
    const joined = exec(process.execPath, [cli, 'join', '127.0.0.1:' + port, name], { env });
    joined.child.stdin.end(group + '\n');
    await joined;
    const config = JSON.parse(fs.readFileSync(path.join(home, 'network.json')));
    let worker;
    function up() {
      worker = spawn(process.execPath, [cli, 'up'], { env, stdio: 'ignore' });
    }
    async function down() {
      if (worker && worker.exitCode === null && !worker.signalCode) {
        const done = once(worker, 'exit');
        worker.kill();
        await done;
      }
    }
    up();
    cleanup.push(down);
    return { id: machineId(config.key), inbox, up, down, home, socket, socketDir, openPane, closePane,
      signal: sig => worker.kill(sig),
      run: async (...args) => (await exec(process.execPath, [cli, ...args],
        { env: { ...env, TMUX_PANE: '%0' } })).stdout };
  }

  const a = await node('desk');
  const nodes = () => call(query, 'list');
  await until(async () => (await nodes()).some(n => n.id === a.id && !n.agents.length));
  assert.match(await a.run('list'), /没有找到 agent 窗格/);
  assert.equal(fs.existsSync(a.socket), false);
  await a.openPane();
  const b = await node('lab', a.socket);
  await b.openPane();
  await until(async () => (await nodes()).filter(n => n.agents.some(p => p.state === 'idle')).length === 2);
  assert.match(await a.run('list'), /lab\/%0\s+lab\s+codex\s+idle/);
  const body = '第一行\nsecond line with "quotes"';
  const ack = await a.run('send', 'lab/codex', 'ask', body);
  const messageId = ack.match(/已送达 #(net-\d+)/)[1];
  const text = fs.readFileSync(b.inbox, 'utf8');
  assert.ok(text.includes(body.replaceAll('\n', '\r')));
  assert.ok(text.includes('from=' + a.id + '/%0'));
  await b.run('send', a.id + '/%0', 'reply', messageId, '收到');
  assert.ok(fs.readFileSync(a.inbox, 'utf8').includes('kind=reply re=' + messageId));
  await assert.rejects(a.run('send', 'lab/codex', 'note', '\x1b[201~'));
  fs.writeFileSync(path.join(b.home, 'busy'), '');
  await until(async () => (await nodes()).find(n => n.id === b.id)?.agents[0]?.state === 'busy');
  assert.match(await a.run('send', 'lab/%0', 'note', 'queued-one'), /已排队/);
  assert.match(await a.run('send', 'lab/%0', 'note', 'queued-two'), /已排队/);
  assert.ok(!fs.readFileSync(b.inbox, 'utf8').includes('queued-one'));
  fs.unlinkSync(path.join(b.home, 'busy'));
  await until(() => fs.readFileSync(b.inbox, 'utf8').includes('queued-two'));
  assert.match(fs.readFileSync(b.inbox, 'utf8'), /queued-one[\s\S]*\[\/bridge\]\r\[bridge [\s\S]*queued-two/);
  // A stopped process keeps its TCP connection open but no longer sends heartbeats.
  b.signal('SIGSTOP');
  try { await until(async () => !(await nodes()).some(n => n.id === b.id), 30000); }
  finally { b.signal('SIGCONT'); }
  await until(async () => (await nodes()).some(n => n.id === b.id && n.agents.length));
  await b.down();
  await until(async () => !(await nodes()).some(n => n.id === b.id));
  await assert.rejects(a.run('send', 'lab/codex', 'note', 'offline'), /未上线/);
  b.up();
  await until(async () => (await nodes()).some(n => n.id === b.id && n.agents.length));

  fs.writeFileSync(path.join(b.home, 'busy'), '');
  await until(async () => (await nodes()).find(n => n.id === b.id)?.agents[0]?.state === 'busy');
  const queued = (await a.run('send', 'lab/%0', 'note', 'pane-closing')).match(/已排队 #(net-\d+)/)[1];
  b.closePane();
  await until(async () => new RegExp('gone +#' + queued + ' ').test(await b.run('log')));
  await until(async () => (await nodes()).some(n => n.id === b.id && !n.agents.length));
  fs.rmSync(b.socketDir, { recursive: true });
  await assert.rejects(a.run('send', 'lab/%0', 'note', 'gone'), /找不到收件人/);
  const listing = await b.run('list');
  assert.doesNotMatch(listing, /^%\d+\s/m); // No local panes, despite TMUX pointing to desk.
  assert.match(listing, /desk\/%0\s+desk\s+codex/);
  assert.equal(fs.existsSync(b.socketDir), false);
});
