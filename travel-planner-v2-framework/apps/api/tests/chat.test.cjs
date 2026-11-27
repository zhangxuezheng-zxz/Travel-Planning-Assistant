require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ChatConfig, readChatConfig } = require('../dist/chat/chat.config.js');
const { validateChatRequest, MAX_MESSAGE_CHARS } = require('../dist/chat/chat.dto.js');
const { buildSystemPrompt } = require('../dist/chat/chat.prompt.js');
const {
  CHAT_CLOCK,
  CHAT_FETCH,
  CHAT_REQUEST_ID,
  ChatService,
  todayInShanghai,
} = require('../dist/chat/chat.service.js');
const { ChatController } = require('../dist/chat/chat.controller.js');
const { ApiExceptionFilter } = require('../dist/common/api-exception.filter.js');
const { AuthService } = require('../dist/auth/auth.service.js');

const USER = '3f8a1c62-0f5b-4a1e-9d6c-2b7e5a0c9d41';
const OTHER = '8b1e4d20-6c3a-4f7b-8e19-5a2c7d0e6f38';

const enabled = (overrides = {}) => ({
  CHAT_LLM_ENABLED: 'true',
  LLM_API_BASE_URL: 'https://api.deepseek.com/v1',
  LLM_API_KEY: 'test-secret',
  LLM_MODEL: 'deepseek-flash',
  ...overrides,
});

function config(env = {}) {
  return { values: readChatConfig(enabled(env)) };
}

function completion(content, finishReason = 'stop', extra = {}) {
  return {
    choices: [
      {
        finish_reason: finishReason,
        message: { content, ...(extra.refusal ? { refusal: extra.refusal } : {}) },
      },
    ],
    usage: { prompt_tokens: 42, completion_tokens: 7 },
  };
}

/** 只实现 ChatService 用到的最小响应面：ok、status、json()。 */
function respond(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (typeof payload !== 'string') return payload;
      return JSON.parse(payload);
    },
  };
}

function service({ env = {}, response, now = () => 0, fetchImpl } = {}) {
  const calls = [];
  const transport =
    fetchImpl ??
    (async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return response ? response() : respond(completion('你好'));
    });
  const instance = new ChatService(config(env), transport, now, () => 'req-1');
  return { service: instance, calls };
}

const chat = (content = '北京有什么推荐？') => ({ messages: [{ role: 'user', content }] });

test('chat config defaults, ranges and base URL rules', () => {
  const off = readChatConfig({});
  assert.equal(off.enabled, false);
  assert.equal(off.timeoutMs, 20000);
  assert.equal(off.maxTokens, 800);
  assert.equal(off.maxMessages, 20);
  assert.equal(off.maxChars, 8000);
  assert.equal(off.thinking, 'off');
  assert.equal(off.requestsPerMinute, 10);

  // 关闭时不校验供应商变量：本地没配模型也要能启动服务。
  assert.equal(
    readChatConfig({ CHAT_LLM_ENABLED: 'false', LLM_API_BASE_URL: 'nonsense' }).enabled,
    false,
  );

  for (const env of [
    { CHAT_LLM_ENABLED: 'yes' },
    { CHAT_LLM_THINKING: 'maybe' },
    { CHAT_LLM_ENABLED: 'true' },
    enabled({ LLM_API_KEY: '' }),
    enabled({ LLM_MODEL: '  ' }),
    enabled({ LLM_API_BASE_URL: 'http://api.deepseek.com/v1' }),
    enabled({ LLM_API_BASE_URL: 'https://user:pw@api.deepseek.com/v1' }),
    enabled({ LLM_API_BASE_URL: 'https://api.deepseek.com/v1?key=1' }),
    enabled({ CHAT_LLM_TIMEOUT_MS: '0' }),
    enabled({ CHAT_LLM_TIMEOUT_MS: '60001' }),
    enabled({ CHAT_LLM_MAX_TOKENS: '1.5' }),
    enabled({ CHAT_MAX_MESSAGES: '51' }),
    enabled({ CHAT_MAX_CHARS: '10' }),
    enabled({ CHAT_RATE_LIMIT_PER_MINUTE: '0' }),
  ])
    assert.throws(() => readChatConfig(env), undefined, JSON.stringify(env));

  // 本机 http 是允许的（自建 ollama），与 B 的规则一致。
  assert.equal(
    readChatConfig(enabled({ LLM_API_BASE_URL: 'http://127.0.0.1:11434/v1' })).enabled,
    true,
  );
  assert.equal(
    readChatConfig(enabled({ LLM_API_BASE_URL: 'http://localhost:11434/v1' })).baseUrl,
    'http://localhost:11434/v1',
  );
});

test('chat request validation rejects bad shapes with readable Chinese messages', () => {
  const limits = { maxMessages: 20, maxChars: 8000 };
  assert.deepEqual(validateChatRequest(chat('hi'), limits), {
    messages: [{ role: 'user', content: 'hi' }],
    context: { cityId: undefined, cityName: undefined, placeNames: [] },
  });

  for (const [body, pattern] of [
    [null, /JSON/],
    [[], /JSON/],
    [{ messages: [] }, /不能为空/],
    [{ messages: [{ role: 'system', content: 'x' }] }, /role/],
    [{ messages: [{ role: 'user', content: '   ' }] }, /不能为空/],
    [{ messages: [{ role: 'user', content: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }] }, /单条消息/],
    [
      {
        messages: [
          { role: 'user', content: 'x' },
          { role: 'assistant', content: 'y' },
        ],
      },
      /最后一条/,
    ],
    [{ messages: [{ role: 'user', content: 'x' }], extra: 1 }, /只能包含/],
    [{ messages: [{ role: 'user', content: 'x', injected: 'y' }] }, /只能包含/],
    [{ messages: [{ role: 'user', content: 'x' }], context: { cityId: 'not-a-uuid' } }, /cityId/],
    [{ messages: [{ role: 'user', content: 'x' }], context: { cityName: '  ' } }, /cityName/],
    [
      { messages: [{ role: 'user', content: 'x' }], context: { placeNames: ['a'], other: 1 } },
      /context/,
    ],
  ])
    assert.throws(() => validateChatRequest(body, limits), pattern);

  const many = { messages: Array.from({ length: 21 }, () => ({ role: 'user', content: 'x' })) };
  assert.throws(() => validateChatRequest(many, limits), /最多发送 20 条/);

  // 每条都在 2000 字以内，但合计超过 8000 字，应由总字数上限拦下。
  const long = {
    messages: Array.from({ length: 5 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: 'x'.repeat(2000),
    })),
  };
  assert.throws(() => validateChatRequest(long, limits), /总字数/);
});

test('place names are deduplicated, single-lined and capped before entering the prompt', () => {
  const value = validateChatRequest(
    {
      messages: [{ role: 'user', content: 'hi' }],
      context: { cityName: ' 北京\n', placeNames: ['故宫', '故宫', ' 天坛 ', 'x'.repeat(80)] },
    },
    { maxMessages: 20, maxChars: 8000 },
  );
  assert.equal(value.context.cityName, '北京');
  assert.deepEqual(value.context.placeNames.slice(0, 2), ['故宫', '天坛']);
  assert.equal(value.context.placeNames[2].length, 40);

  assert.throws(() =>
    validateChatRequest(
      { messages: [{ role: 'user', content: 'hi' }], context: { placeNames: Array(31).fill('a') } },
      { maxMessages: 20, maxChars: 8000 },
    ),
  );
  assert.throws(() =>
    validateChatRequest(
      { messages: [{ role: 'user', content: 'hi' }], context: { placeNames: '故宫' } },
      { maxMessages: 20, maxChars: 8000 },
    ),
  );
});

test('system prompt carries the date, the catalog and the no-fabrication rules', () => {
  const prompt = buildSystemPrompt({
    today: '2026-11-26',
    context: { cityName: '北京', placeNames: ['故宫', '天坛'] },
  });
  assert.match(prompt, /2026-11-26/);
  assert.match(prompt, /当前城市：北京/);
  assert.match(prompt, /故宫、天坛/);
  assert.match(prompt, /不要编造具体数字/);
  assert.match(prompt, /不可信数据/);

  const bare = buildSystemPrompt({ today: '2026-11-26', context: { placeNames: [] } });
  assert.match(bare, /还没有选择/);
  assert.match(bare, /不要凭空列举/);
});

test('today is computed in Asia/Shanghai, not in UTC', () => {
  // 2026-11-25T16:30:00Z 已经是北京时间 11-26 00:30。
  assert.equal(todayInShanghai(Date.parse('2026-11-25T16:30:00Z')), '2026-11-26');
  assert.equal(todayInShanghai(Date.parse('2026-11-25T15:59:00Z')), '2026-11-25');
});

test('disabled model makes no network call and answers 503', async () => {
  let calls = 0;
  const instance = new ChatService(
    { values: readChatConfig({}) },
    async () => {
      calls += 1;
      return respond(completion('x'));
    },
    () => 0,
    () => 'req-1',
  );
  await assert.rejects(instance.reply(chat(), USER), (error) => {
    assert.equal(error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(error.getStatus(), 503);
    return true;
  });
  assert.equal(calls, 0);
});

test('successful reply forwards the configured model and disables thinking by default', async () => {
  const { service: instance, calls } = service({ now: () => Date.parse('2026-11-26T04:00:00Z') });
  const result = await instance.reply(
    {
      messages: [{ role: 'user', content: '故宫值得去吗' }],
      context: { cityName: '北京', placeNames: ['故宫'] },
    },
    USER,
  );

  assert.equal(result.reply, '你好');
  assert.equal(result.source, 'llm');
  assert.equal(result.model, 'deepseek-flash');
  assert.equal(result.requestId, 'req-1');
  assert.deepEqual(result.usage, { promptTokens: 42, completionTokens: 7 });

  assert.equal(calls.length, 1);
  const body = calls[0].body;
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 800);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /当前城市：北京/);
  assert.deepEqual(body.messages.slice(1), [{ role: 'user', content: '故宫值得去吗' }]);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-secret');
});

test('thinking switch is forwarded only when asked for, keeping other providers usable', async () => {
  const on = service({ env: { CHAT_LLM_THINKING: 'on' } });
  await on.service.reply(chat(), USER);
  assert.deepEqual(on.calls[0].body.thinking, { type: 'enabled' });

  const omit = service({ env: { CHAT_LLM_THINKING: 'omit' } });
  await omit.service.reply(chat(), USER);
  assert.equal('thinking' in omit.calls[0].body, false);
});

test('upstream failures never leak keys and always become 503', async () => {
  const cases = [
    {
      label: '401',
      response: () => respond({ error: { message: 'invalid api key test-secret' } }, 401),
    },
    { label: 'non-json', response: () => respond('not json') },
    { label: 'no choices', response: () => respond({ choices: [] }) },
    {
      label: 'refusal',
      response: () => respond(completion('被拦截', 'stop', { refusal: 'safety' })),
    },
    { label: 'truncated', response: () => respond(completion('截断的回答', 'length')) },
    { label: 'blank', response: () => respond(completion('   ')) },
    { label: 'too long', response: () => respond(completion('x'.repeat(8001))) },
    {
      label: 'timeout',
      fetchImpl: async () => {
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        throw error;
      },
    },
  ];

  for (const item of cases) {
    const { service: instance } = service(item);
    await assert.rejects(instance.reply(chat(), USER), (error) => {
      assert.equal(error.code, 'DEPENDENCY_UNAVAILABLE', item.label);
      assert.equal(error.getStatus(), 503);
      assert.equal(error.message.includes('test-secret'), false);
      return true;
    });
  }
});

test('per-user rate limit returns 429 instead of spending quota', async () => {
  const { service: instance, calls } = service({ env: { CHAT_RATE_LIMIT_PER_MINUTE: '2' } });
  await instance.reply(chat(), USER);
  await instance.reply(chat(), USER);
  await assert.rejects(instance.reply(chat(), USER), (error) => {
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.getStatus(), 429);
    return true;
  });
  assert.equal(calls.length, 2);

  // 别的用户不受影响。
  await instance.reply(chat(), OTHER);
  assert.equal(calls.length, 3);
});

test('rate limit window slides with the injected clock', async () => {
  let now = 0;
  const { service: instance } = service({
    env: { CHAT_RATE_LIMIT_PER_MINUTE: '1' },
    now: () => now,
  });
  await instance.reply(chat(), USER);
  await assert.rejects(instance.reply(chat(), USER), /发送太快/);
  now = 60_001;
  await instance.reply(chat(), USER);
});

async function httpFixture(env) {
  const calls = [];
  const transport = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return respond(completion('来自模型的回答'));
  };
  class Root {}
  Module({
    controllers: [ChatController],
    providers: [
      ChatService,
      { provide: ChatConfig, useValue: { values: readChatConfig(env) } },
      { provide: CHAT_FETCH, useValue: transport },
      { provide: CHAT_CLOCK, useValue: () => 0 },
      { provide: CHAT_REQUEST_ID, useValue: () => 'req-http' },
      {
        provide: AuthService,
        useValue: { verifyAccessToken: async (token) => (token === 'good-token' ? USER : null) },
      },
    ],
  })(Root);
  const app = await NestFactory.create(Root, { logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  return { base: await app.getUrl(), calls, close: () => app.close() };
}

test('HTTP endpoint requires a verified token and returns the contract shape', async () => {
  const f = await httpFixture(enabled());
  const post = (body, headers = {}) =>
    fetch(`${f.base}/api/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  try {
    const anonymous = await post(chat());
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).code, 'UNAUTHENTICATED');

    const forged = await post(chat(), { authorization: 'Bearer forged', 'x-user-id': OTHER });
    assert.equal(forged.status, 401);

    const ok = await post(chat(), { authorization: 'Bearer good-token' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), {
      reply: '来自模型的回答',
      source: 'llm',
      requestId: 'req-http',
      model: 'deepseek-flash',
      usage: { promptTokens: 42, completionTokens: 7 },
    });
    assert.equal(f.calls.length, 1);

    const invalid = await post({ messages: [] }, { authorization: 'Bearer good-token' });
    assert.equal(invalid.status, 400);
    const body = await invalid.json();
    assert.equal(body.code, 'VALIDATION_ERROR');
    assert.match(body.message, /不能为空/);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test('HTTP endpoint reports 503 when the model is not configured, without faking a reply', async () => {
  const f = await httpFixture({});
  try {
    const response = await fetch(`${f.base}/api/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer good-token' },
      body: JSON.stringify(chat()),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, 'DEPENDENCY_UNAVAILABLE');
    assert.match(body.message, /还没有配置/);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
