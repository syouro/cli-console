'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const MAILBOX_NAME = /^firekeeper-[\w.-]{1,69}$/;
const PROBE_TIMEOUT = 1000;
const MAIL_TIMEOUT = 5000;
const MAX_RESPONSE = 65536;

function readMailboxes(stateDir) {
  let config;
  try { config = JSON.parse(fs.readFileSync(path.join(stateDir, 'firekeeper.json'), 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error('无法读取 firekeeper.json：' + e.message);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('firekeeper.json 必须是端点名到控制口路径的 JSON 对象');
  }
  return Object.entries(config).map(([name, socket]) => {
    if (!MAILBOX_NAME.test(name)) throw new Error('无效的 Firekeeper 端点名：' + name);
    if (typeof socket !== 'string' || !path.isAbsolute(socket) || /[\x00-\x1f\x7f]/.test(socket)) {
      throw new Error('Firekeeper 控制口须使用绝对路径：' + name);
    }
    return { name, socket };
  });
}

function exchange(socketPath, request, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let connected = false;
    let response = '';
    const timer = setTimeout(() => fail(connected ? '信箱回执超时，投递结果未知' : '连接信箱超时'), timeout);
    function fail(message) {
      reject(new Error(message));
      socket.destroy();
    }
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      connected = true;
      if (request) socket.write(JSON.stringify(request) + '\n');
      else { resolve(); socket.destroy(); }
    });
    socket.on('data', chunk => {
      response += chunk;
      if (response.length > MAX_RESPONSE) return fail('信箱回执超过长度限制');
      const end = response.indexOf('\n');
      if (end < 0) return;
      try { resolve(JSON.parse(response.slice(0, end))); }
      catch { return fail('信箱回执格式无效'); }
      socket.destroy();
    });
    socket.on('error', () => fail(connected ? '信箱连接中断，投递结果未知' : '信箱离线或控制口无法连接'));
    socket.once('close', () => {
      clearTimeout(timer);
      reject(new Error('信箱控制口已关闭，投递结果未知'));
    });
  });
}

function mailboxRows(mailboxes) {
  return Promise.all(mailboxes.map(({ name, socket }) => exchange(socket, null, PROBE_TIMEOUT).then(
    () => ({ name, state: 'online' }),
    () => ({ name, state: 'offline' })
  )));
}

async function submitMail(socket, mail) {
  const receipt = await exchange(socket, { command: 'mail.receive', mail }, MAIL_TIMEOUT);
  if (receipt?.ok === false && typeof receipt.error === 'string') throw new Error(receipt.error);
  if (receipt?.ok !== true || !['queued', 'duplicate'].includes(receipt.status)
      || receipt.id !== mail.id || receipt.to !== mail.to) {
    throw new Error('信箱回执无效，投递结果未知');
  }
  return receipt.status;
}

module.exports = { MAILBOX_NAME, readMailboxes, mailboxRows, submitMail };
