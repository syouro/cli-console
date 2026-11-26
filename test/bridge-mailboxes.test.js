'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
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
const review = 'firekeeper-review';
const author = 'firekeeper-author';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agb-mail-'));
  const cleanup = [() => fs.rmSync(dir, { recursive: true, force: true })];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); });
  function endpoint(name = 'local') {
    const stateDir = path.join(dir, name);
    const bin = path.join(stateDir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const env = { ...process.env, PATH: bin, AGBRIDGE_DIR: stateDir, TMUX: '', TMUX_PANE: '' };
    function run(...args) { return exec(process.execPath, [cli, ...args], { env, timeout: 15000 }); }
    function configure(entries) {
      fs.writeFileSync(path.join(stateDir, 'firekeeper.json'), JSON.stringify(entries));
    }
    async function listen(name, respond) {
      const socketPath = path.join(stateDir, name + '.sock');
      const requests = [];
      const server = net.createServer(socket => {
        socket.setEncoding('utf8');
        socket.on('error', () => socket.destroy());
        let buffer = '';
        socket.on('data', chunk => {
          buffer += chunk;
          const end = buffer.indexOf('\n');
          if (end < 0) return;
          const request = JSON.parse(buffer.slice(0, end));
          requests.push(request);
          const { id, to } = request.mail;
          const result = respond ? respond(request.mail) : { ok: true, status: 'queued', id, to };
          socket.end(JSON.stringify(result) + '\n');
        });
      });
      server.listen(socketPath);
      await once(server, 'listening');
      fs.chmodSync(socketPath, 0o600);
      async function close() { if (server.listening) await new Promise(resolve => server.close(resolve)); }
      cleanup.push(close);
      return { socketPath, requests, close };
    }
    async function join(query) {
      const joining = run('join', `${query.host}:${query.port}`, name);
      joining.child.stdin.end(query.group + '\n');
      await joining;
      const config = JSON.parse(fs.readFileSync(path.join(stateDir, 'network.json'), 'utf8'));
      const worker = spawn(process.execPath, [cli, 'up'], { env, stdio: 'ignore' });
      const done = once(worker, 'exit');
      cleanup.push(async () => { worker.kill(); await done; });
      return machineId(config.key);
    }
    function log() {
      return fs.readFileSync(path.join(stateDir, 'log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    }
    return { stateDir, bin, env, run, configure, listen, join, log };
  }
  return { endpoint, cleanup };
}

async function until(check) {
  const deadline = Date.now() + 12000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('等待信箱心跳超时');
    await sleep(100);
  }
}

async function expectSendError(command, message) {
  let result;
  await assert.rejects(command, e => {
    assert.equal(e.code, 1);
    assert.equal(e.stderr, '');
    result = JSON.parse(e.stdout);
    assert.equal(result.status, 'error');
    if (typeof message === 'string') assert.equal(result.error, message);
    else assert.match(result.error, message);
    return true;
  });
  return result;
}

test('Firekeeper 信箱可在没有 tmux 的机器登记，清单同时显示在线和离线', async t => {
  const local = fixture(t).endpoint();
  const control = await local.listen(review);
  local.configure({ [review]: control.socketPath, [author]: path.join(local.stateDir, 'absent.sock') });
  const { stdout } = await local.run('list');
  assert.match(stdout, /firekeeper-review\s+firekeeper\s+在线/);
  assert.match(stdout, /firekeeper-author\s+firekeeper\s+离线/);
  const list = JSON.parse((await local.run('list', '--json')).stdout);
  assert.deepEqual(list, { machines: [], members: [
    { type: 'mailbox', address: review, name: review, agent: 'firekeeper', state: 'online', machineId: null },
    { type: 'mailbox', address: author, name: author, agent: 'firekeeper', state: 'offline', machineId: null }
  ] });
  assert.deepEqual(control.requests, []);
  local.configure({ [review]: 'relative.sock' });
  await assert.rejects(local.run('list', '--json'), e => {
    assert.equal(e.code, 1);
    assert.match(JSON.parse(e.stdout).error, /控制口须使用绝对路径/);
    return true;
  });
});

test('Firekeeper 信箱本机投递使用结构化信件，接纳和重复回执记 sent，拒收原样报告', async t => {
  const local = fixture(t).endpoint();
  const rejection = '会话队列已满，本信未接收';
  const control = await local.listen(review, mail => mail.body === '拒收'
    ? { ok: false, error: rejection }
    : { ok: true, status: mail.kind === 'reply' ? 'duplicate' : 'queued', id: mail.id, to: review });
  local.configure({ [review]: control.socketPath, [author]: path.join(local.stateDir, 'absent.sock') });
  const send = local.run('send', review, 'ask', '-', '--from', author, '--json');
  send.child.stdin.end('第一行\n第二行');
  const sent = JSON.parse((await send).stdout);
  assert.deepEqual(sent, { status: 'sent', id: sent.id, to: review });
  assert.match(sent.id, /^mail-\d+$/);
  assert.deepEqual(control.requests[0], { command: 'mail.receive', mail: {
    id: sent.id, from: author, to: review, kind: 'ask', body: '第一行\n第二行'
  } });
  assert.match((await local.run('send', review, 'reply', 'codex-12', '收到')).stdout, /^已送达 #mail-\d+/);
  assert.equal(control.requests[1].mail.replyTo, 'codex-12');
  const failed = await expectSendError(local.run('send', review, 'note', '拒收', '--json'), rejection);
  assert.equal(failed.id, control.requests[2].mail.id);
  assert.equal(control.requests.length, 3);
  assert.deepEqual(local.log().map(({ status, receipt, error }) => [status, receipt ?? error]),
    [['sent', 'queued'], ['sent', 'duplicate'], ['error', rejection]]);
  await expectSendError(local.run('send', author, 'note', '离线', '--json'), /信箱离线/);
  const invalid = await expectSendError(local.run('send', '--json'), /用法/);
  assert.deepEqual({ id: invalid.id, to: invalid.to }, { id: null, to: null });
});

test('Firekeeper 信箱通过中转上线、双向回信、原样传回拒收且离线后仍列出', async t => {
  const f = fixture(t);
  const group = crypto.randomBytes(32).toString('hex');
  const relay = makeRelay(group);
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  f.cleanup.push(() => new Promise(resolve => relay.close(resolve)));
  const query = { host: '127.0.0.1', port: relay.address().port, group };
  const desk = f.endpoint('desk');
  const lab = f.endpoint('lab');
  const a = await desk.listen(author);
  const rejection = '宿主当前不能接收信件';
  const b = await lab.listen(review, mail => mail.body === '拒收'
    ? { ok: false, error: rejection }
    : { ok: true, status: 'queued', id: mail.id, to: review });
  desk.configure({ [author]: a.socketPath });
  lab.configure({ [review]: b.socketPath });
  const deskId = await desk.join(query);
  const labId = await lab.join(query);
  await until(async () => (await call(query, 'list')).filter(node => node.mailboxes.length).length === 2);
  const inventory = await call(query, 'list');
  assert.deepEqual(inventory.find(n => n.id === labId).mailboxes, [{ name: review, state: 'online' }]);
  const list = JSON.parse((await desk.run('list', '--json')).stdout);
  assert.deepEqual(list.members.find(m => m.machineId === labId), { type: 'mailbox', address: `lab/${review}`,
    name: review, agent: 'firekeeper', state: 'online', machineId: labId });

  const ask = JSON.parse((await desk.run('send', `lab/${review}`, 'ask', '跨机信件', '--from', author, '--json')).stdout);
  assert.equal(ask.status, 'sent');
  assert.deepEqual(b.requests[0], { command: 'mail.receive', mail: { id: ask.id, from: `${deskId}/${author}`,
    to: review, kind: 'ask', body: '跨机信件' } });
  const reply = (await lab.run('send', b.requests[0].mail.from, 'reply', ask.id, '回复', '--from', review)).stdout;
  assert.match(reply, /^已送达 #net-\d+/);
  assert.equal(a.requests[0].mail.from, `${labId}/${review}`);
  assert.equal(a.requests[0].mail.replyTo, ask.id);
  await expectSendError(desk.run('send', `lab/${review}`, 'note', '拒收', '--json'), rejection);
  assert.equal(b.requests.length, 2);

  await b.close();
  await until(async () => (await call(query, 'list')).find(n => n.id === labId)?.mailboxes[0]?.state === 'offline');
  assert.match((await desk.run('list')).stdout, /lab\/firekeeper-review\s+firekeeper\s+离线/);
  await expectSendError(desk.run('send', `${labId}/${review}`, 'note', '离线', '--json'), /信箱离线/);
});

test('Firekeeper 信箱与 tmux 会话重名时，在线和离线均报歧义', {
  skip: process.platform !== 'linux' || spawnSync('tmux', ['-V']).status !== 0
}, async t => {
  const f = fixture(t);
  const local = f.endpoint();
  const tmux = (await exec('sh', ['-c', 'command -v tmux'])).stdout.trim();
  const socket = path.join(local.stateDir, 'test-tmux.sock');
  fs.writeFileSync(path.join(local.bin, 'tmux'), '#!/bin/sh\nexec "${TEST_TMUX:?}" -S "${TEST_SOCKET:?}" "$@"\n', { mode: 0o700 });
  Object.assign(local.env, { TEST_TMUX: tmux, TEST_SOCKET: socket, TMUX_PANE: '%0' });
  await exec(tmux, ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', review, '/bin/sleep', '30']);
  f.cleanup.push(() => exec(tmux, ['-S', socket, 'kill-server']));
  const control = await local.listen(review);
  local.configure({ [review]: control.socketPath });
  const ambiguous = /同时匹配 Firekeeper 信箱和 tmux 会话/;
  await expectSendError(local.run('send', review, 'note', '在线重名', '--json'), ambiguous);
  assert.deepEqual(control.requests, []);
  await exec(tmux, ['-S', socket, 'rename-session', '-t', '=' + review, 'manual']);
  await local.run('send', review, 'ask', '来自 tmux');
  assert.equal(control.requests[0].mail.from, '%0');
  await exec(tmux, ['-S', socket, 'rename-session', '-t', '=manual', review]);
  await control.close();
  await expectSendError(local.run('send', review, 'note', '离线重名', '--json'), ambiguous);
  assert.equal((await exec(tmux, ['-S', socket, 'list-sessions', '-F', '#{session_name}'])).stdout.trim(), review);
});
