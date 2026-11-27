import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

const external = createRequire(import.meta.url);
const cache = new Map();
function load(path) {
  if (cache.has(path)) return cache.get(path).exports;
  const m = { exports: {} };
  cache.set(path, m);
  const compiled = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', compiled)(
    (specifier) =>
      specifier.startsWith('.')
        ? load(resolve(dirname(path), specifier + '.ts'))
        : external(specifier),
    m,
    m.exports,
  );
  return m.exports;
}

const { sendChatMessage, isModelUnavailable, isRateLimited } = load(
  fileURLToPath(new URL('../src/features/home/chat-client.ts', import.meta.url)),
);
const { fallbackReply, FALLBACK_NOTE } = load(
  fileURLToPath(new URL('../src/features/home/chat-fallback.ts', import.meta.url)),
);
const { ApiError } = load(fileURLToPath(new URL('../src/lib/api-client.ts', import.meta.url)));

function recordingClient(respond) {
  const calls = [];
  return {
    calls,
    client: {
      async request(path, init) {
        calls.push({ path, init });
        return respond(path, init);
      },
    },
  };
}

const REPLY = {
  reply: '  故宫和天坛都合适。  ',
  source: 'llm',
  requestId: 'req-1',
  model: 'deepseek-flash',
  usage: { promptTokens: 10, completionTokens: 5 },
};

test('对话请求按契约 POST 到 /chat/messages，并带上城市上下文', async () => {
  const { calls, client } = recordingClient(() => ({ ...REPLY }));
  const result = await sendChatMessage(
    client,
    [
      { role: 'user', content: '  北京有什么推荐？  ' },
      { role: 'assistant', content: '想去哪类景点？' },
      { role: 'user', content: '带爸妈' },
    ],
    { context: { cityId: 'city-1', cityName: ' 北京 ', placeNames: ['故宫', ' ', '天坛'] } },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/chat/messages');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].init.body, {
    messages: [
      { role: 'user', content: '北京有什么推荐？' },
      { role: 'assistant', content: '想去哪类景点？' },
      { role: 'user', content: '带爸妈' },
    ],
    context: { cityId: 'city-1', cityName: '北京', placeNames: ['故宫', '天坛'] },
  });
  // 返回值去掉首尾空白，其余字段原样透传。
  assert.equal(result.reply, '故宫和天坛都合适。');
  assert.equal(result.model, 'deepseek-flash');
});

test('没有城市上下文时不发 context 字段，避免服务端校验多一个空对象', async () => {
  const { calls, client } = recordingClient(() => ({ ...REPLY }));
  await sendChatMessage(client, [{ role: 'user', content: '你好' }]);
  assert.deepEqual(calls[0].init.body, { messages: [{ role: 'user', content: '你好' }] });
});

test('空白消息被丢弃，全空时不发请求', async () => {
  const { calls, client } = recordingClient(() => ({ ...REPLY }));
  await sendChatMessage(client, [
    { role: 'user', content: '   ' },
    { role: 'assistant', content: '' },
    { role: 'user', content: '在吗' },
  ]);
  assert.deepEqual(calls[0].init.body.messages, [{ role: 'user', content: '在吗' }]);

  const { calls: empty, client: emptyClient } = recordingClient(() => ({ ...REPLY }));
  await assert.rejects(
    () => sendChatMessage(emptyClient, [{ role: 'user', content: '   ' }]),
    (error) => error instanceof ApiError && error.code === 'VALIDATION_ERROR',
  );
  assert.equal(empty.length, 0);
});

test('模型返回空回答时报 INVALID_RESPONSE，而不是把空气泡塞进界面', async () => {
  const { client } = recordingClient(() => ({ ...REPLY, reply: '   ' }));
  await assert.rejects(
    () => sendChatMessage(client, [{ role: 'user', content: '你好' }]),
    (error) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
  );
});

test('错误分类决定界面是降级还是提示等待', () => {
  assert.equal(isModelUnavailable(new ApiError(503, 'DEPENDENCY_UNAVAILABLE', '暂时不可用')), true);
  assert.equal(isModelUnavailable(new ApiError(500, 'INTERNAL_ERROR', '服务暂不可用')), false);
  assert.equal(isModelUnavailable(new Error('boom')), false);
  assert.equal(isRateLimited(new ApiError(429, 'RATE_LIMITED', '太快了')), true);
  assert.equal(isRateLimited(new ApiError(400, 'VALIDATION_ERROR', '格式不对')), false);
});

test('本地兜底只念目录，不冒充模型回答', () => {
  const places = [{ name: '故宫' }, { name: '天坛' }];
  const listed = fallbackReply('有什么景点推荐？', '北京', places);
  assert.match(listed, /北京 目录里的 2 个景点/);
  assert.match(listed, /故宫/);

  assert.match(fallbackReply('有什么景点推荐？', null, places), /定位当前位置/);
  assert.match(fallbackReply('有什么景点推荐？', '北京', []), /还没有录入景点/);
  assert.match(fallbackReply('天气怎么样', '北京', places), /行程/);
  assert.match(FALLBACK_NOTE, /暂不可用/);
});
