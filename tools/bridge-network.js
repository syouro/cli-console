'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');

const HEARTBEAT = 5000;
const LEASE = 4 * HEARTBEAT;
const RPC_TIMEOUT = 10000;
const DELIVERY_TIMEOUT = 31 * 60e3;
const MAX_FRAME = 1024 * 1024;
const KEY = /^[a-f0-9]{64}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const stateDir = process.env.AGBRIDGE_DIR || path.join(os.userInfo().homedir, '.agent-bridge');
const configFile = path.join(stateDir, 'network.json');
const groupFile = path.join(stateDir, 'relay.key');

// Write a complete private file, then publish it only if no other process won the race.
function createOnce(file, value) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomUUID();
  fs.writeFileSync(tmp, value, { flag: 'wx', mode: 0o600 });
  try { fs.linkSync(tmp, file); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  finally { fs.unlinkSync(tmp); }
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function machineId(key) {
  if (typeof key !== 'string' || !KEY.test(key)) throw new Error('无效的机器 KEY');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
}

async function join(address, name, group) {
  if (readConfig()) throw new Error('本机已加入网络，运行 agbridge up 上线');
  if (!NAME.test(name) || /^[0-9a-f]{24}$/.test(name) || !KEY.test(group)) throw new Error('机器名或加入码格式无效');
  const url = new URL('tls://' + address);
  if (!url.hostname || !url.port || +url.port < 1 || !/^tls:\/\/[^/?#@]+$/.test(url.href)) {
    throw new Error('中转地址格式为 host:port');
  }
  const key = crypto.randomBytes(32).toString('hex');
  const config = { host: url.hostname.replace(/^\[|\]$/g, ''), port: +url.port, group, key, name };
  await call(config, 'ping'); // Confirm address and invitation before persisting either.
  createOnce(configFile, JSON.stringify(config) + '\n');
  if (readConfig().key !== key) throw new Error('本机已由另一个进程加入网络');
  return machineId(key);
}

function invite() { return fs.readFileSync(groupFile, 'utf8').trim(); }

// Both endpoints authenticate the group using a random 256-bit TLS pre-shared key.
// The relay has no certificate or fallback plaintext listener.
const tlsOptions = { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ciphers: 'DHE-PSK-AES128-GCM-SHA256' };

function channel(socket, handle) {
  const waiting = new Map();
  let sequence = 0, buffer = '';
  socket.setEncoding('utf8');
  socket.setNoDelay();
  socket.setKeepAlive(true, HEARTBEAT);
  function write(frame) {
    const data = JSON.stringify(frame) + '\n';
    if (socket.destroyed || Buffer.byteLength(data) > MAX_FRAME || socket.writableLength > MAX_FRAME) {
      throw new Error('连接已关闭或数据超过限制');
    }
    socket.write(data);
  }
  function request(method, data, timeout = RPC_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const hint = method === 'send' || method === 'deliver' ? '，投递状态请查收件机 agbridge log' : '';
      const id = ++sequence;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error('请求超时' + hint));
      }, timeout);
      waiting.set(id, { resolve, reject, timer, hint });
      try { write({ id, method, data }); }
      catch (e) { clearTimeout(timer); waiting.delete(id); reject(e); }
    });
  }
  async function frame(msg) {
    if (!Number.isSafeInteger(msg.id)) throw new Error('无效的请求编号');
    if (msg.method !== undefined) {
      let response;
      try { response = { id: msg.id, value: await handle(msg.method, msg.data) }; }
      catch (e) { response = { id: msg.id, error: e.message }; }
      write(response);
    } else {
      const entry = waiting.get(msg.id);
      if (!entry) return;
      waiting.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(String(msg.error)));
      else entry.resolve(msg.value);
    }
  }
  socket.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      if (Buffer.byteLength(buffer.slice(0, end)) > MAX_FRAME) return socket.destroy();
      try { frame(JSON.parse(buffer.slice(0, end))).catch(() => socket.destroy()); }
      catch { return socket.destroy(); }
      buffer = buffer.slice(end + 1);
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME) socket.destroy();
  });
  socket.on('error', () => {}); // Pending calls are rejected on close.
  socket.once('close', () => {
    for (const { reject, timer, hint } of waiting.values()) {
      clearTimeout(timer);
      reject(new Error('连接中断' + hint));
    }
    waiting.clear();
  });
  return request;
}

async function connect(config) {
  const socket = tls.connect({ ...tlsOptions, host: config.host, port: config.port,
    pskCallback: () => ({ identity: 'agbridge-v1', psk: Buffer.from(config.group, 'hex') }),
    checkServerIdentity: () => undefined });
  const timer = setTimeout(() => socket.destroy(new Error('连接中转超时')), RPC_TIMEOUT);
  try { await once(socket, 'secureConnect'); return socket; }
  finally { clearTimeout(timer); }
}

async function call(config, method, data) {
  const socket = await connect(config);
  try {
    const request = channel(socket, () => { throw new Error('不支持的请求'); });
    return await request(method, data, data?.sync ? DELIVERY_TIMEOUT + RPC_TIMEOUT : RPC_TIMEOUT * 2);
  } finally { socket.destroy(); }
}

function makeRelay(group) {
  const nodes = new Map();
  // OpenSSL's automatic DHE group on a certificate-free PSK server can be only 1024 bits.
  const dhparam = fs.readFileSync(path.join(__dirname, 'bridge-ffdhe3072.pem'));
  const server = tls.createServer({ ...tlsOptions, dhparam, handshakeTimeout: RPC_TIMEOUT,
    pskCallback: (_socket, identity) => identity === 'agbridge-v1' ? Buffer.from(group, 'hex') : null
  }, socket => {
    let node, pending = 0;
    socket.setTimeout(LEASE, () => { if (!pending) socket.destroy(); });
    const request = channel(socket, async (method, data) => {
      if (method === 'ping') return true;
      if (method === 'register') {
        const id = machineId(data.key);
        if (typeof data.name !== 'string' || !NAME.test(data.name) || /^[0-9a-f]{24}$/.test(data.name)) throw new Error('无效的机器名');
        if (node || nodes.has(id)) throw new Error('本机 KEY 已在线，请检查重复运行的 agbridge up');
        node = { id, name: data.name, agents: [], request, seen: Date.now(), socket };
        nodes.set(id, node);
        return id;
      }
      if (method === 'heartbeat' && node) {
        if (!Array.isArray(data.agents)) throw new Error('无效的 agent 清单');
        node.agents = data.agents.map(({ id, session, agent, state, cwd }) => {
          if (!/^%\d+$/.test(id) || ![session, agent, state, cwd].every(field =>
            typeof field === 'string' && !/[\x00-\x1f\x7f]/.test(field))) throw new Error('无效的窗格记录');
          return { id, session, agent, state, cwd };
        });
        node.seen = Date.now();
        return true;
      }
      if (method === 'list') {
        return [...nodes.values()].map(({ id, name, agents }) => ({ id, name, agents }));
      }
      if (method === 'send' || method === 'start' || method === 'stop') {
        const source = nodes.get(machineId(data.key));
        if (!source) throw new Error('请先在发送机运行 agbridge up');
        let dest = nodes.get(data.host);
        if (!dest) {
          const matches = [...nodes.values()].filter(n => n.name === data.host);
          if (matches.length > 1) throw new Error('同名机器有多台，请用清单里的机器 ID');
          dest = matches[0];
        }
        if (!dest) throw new Error((method === 'send' ? '收件机' : '目标机') + '未上线：' + data.host);
        pending++;
        try {
          if (method !== 'send') {
            return await dest.request(method, { session: data.session, agent: data.agent, cwd: data.cwd });
          }
          return await dest.request('deliver', { message: data.message, sender: source.id,
            target: data.target, now: data.now === true, sync: data.sync === true },
          data.sync ? DELIVERY_TIMEOUT : RPC_TIMEOUT);
        } finally { pending--; }
      }
      throw new Error('不支持的网络请求');
    });
    socket.once('close', () => { if (node) nodes.delete(node.id); });
  });
  const sweep = setInterval(() => {
    for (const node of nodes.values()) if (Date.now() - node.seen >= LEASE) node.socket.destroy();
  }, HEARTBEAT);
  sweep.unref();
  server.once('close', () => clearInterval(sweep));
  return server;
}

async function relay(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口应在 1–65535 之间');
  createOnce(groupFile, crypto.randomBytes(32).toString('hex') + '\n');
  const group = invite();
  if (!KEY.test(group)) throw new Error('中转加入码文件损坏');
  const server = makeRelay(group);
  server.listen(port, process.env.AGBRIDGE_BIND || undefined);
  await once(server, 'listening');
  console.log('中转已启动，TCP 端口 ' + port + '。用 agbridge invite 查看加入码。');
}

async function runNode(config, discover, receive, manage) {
  const id = machineId(config.key);
  for (;;) {
    let socket, closed;
    try {
      socket = await connect(config);
      closed = new AbortController();
      socket.once('close', () => closed.abort());
      const request = channel(socket, (method, data) => {
        if (method === 'deliver') return receive(data, id);
        if (method === 'start' || method === 'stop') {
          if (!manage) throw new Error('目标机未开启远程会话管理，请运行 agbridge up --allow-manage');
          return manage(method, data);
        }
        throw new Error('不支持的请求');
      });
      await request('register', { name: config.name, key: config.key });
      console.log('已连接中转：' + config.name + ' (' + id + ')');
      while (!socket.destroyed) {
        const agents = await discover();
        await request('heartbeat', { agents });
        await sleep(HEARTBEAT, undefined, { signal: closed.signal });
      }
    } catch (e) { if (e.name !== 'AbortError') console.error(e.message); }
    finally { socket?.destroy(); }
    await sleep(2000);
  }
}

module.exports = { readConfig, machineId, join, invite, relay, runNode, call, makeRelay };
