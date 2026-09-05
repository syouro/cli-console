'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { envelope, resolveTo, parseArgs } = require('../tools/bridge.js');

test('envelope：信封头带编号/发送者/kind，reply 带 re', () => {
  const s = envelope({ id: 'codex-12', from: 'codex', toName: 'claude', kind: 'ask', body: '  a\nb  ' });
  assert.strictEqual(s, '[bridge #codex-12 from=codex to=claude kind=ask]\na\nb\n[/bridge]');
  assert.match(envelope({ id: 'claude-3', from: 'claude', toName: 'codex', kind: 'reply', re: 'codex-12', body: 'x' }),
    /^\[bridge #claude-3 from=claude to=codex kind=reply re=codex-12\]\n/);
});

const panes = [
  { id: '%0', session: 'codex', target: 'codex:0.0', agent: 'codex', cwd: '/a' },
  { id: '%1', session: 'hearth', target: 'hearth:0.0', agent: 'claude', cwd: '/a' },
  { id: '%2', session: 'cc1', target: 'cc1:0.0', agent: 'claude', cwd: '/b' },
];
test('resolveTo：agent 名唯一命中 / 排除自己 / 多个命中报错 / 会话名与 pane id', () => {
  assert.strictEqual(resolveTo(panes, 'codex', '%2').id, '%0');
  assert.strictEqual(resolveTo(panes, 'claude', '%2').id, '%1'); // 排除自己后只剩一个
  assert.throws(() => resolveTo(panes, 'claude', '%0'), /多个窗格/);
  assert.strictEqual(resolveTo(panes, 'hearth', '%0').id, '%1');
  assert.strictEqual(resolveTo(panes, '%2', '%0').id, '%2');
  assert.throws(() => resolveTo(panes, 'nope', ''), /找不到/);
});

test('parseArgs：--file/--from 取值，其余 -- 开关为布尔', () => {
  const o = parseArgs(['send', 'codex', 'ask', '--now', '--from', 'me', 'hi', 'there']);
  assert.deepStrictEqual(o, { _: ['send', 'codex', 'ask', 'hi', 'there'], now: true, from: 'me' });
});

test('nameOf：agent 名唯一用 agent 名，同类多个用会话名', () => {
  const { nameOf } = require('../tools/bridge.js');
  assert.strictEqual(nameOf(panes, panes[0]), 'codex');
  assert.strictEqual(nameOf(panes, panes[1]), 'hearth');
  assert.strictEqual(nameOf(panes, panes[2]), 'cc1');
});
