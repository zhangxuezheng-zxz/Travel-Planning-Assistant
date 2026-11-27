require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ChatConfig, readChatConfig } = require('../dist/chat/chat.config.js');
const { ChatService } = require('../dist/chat/chat.service.js');
const {
  DEFAULT_ACCURACY_POLICY,
  findOutsidePlaces,
  inspectReply,
} = require('../dist/chat/chat-accuracy.js');

const USER = '3f8a1c62-0f5b-4a1e-9d6c-2b7e5a0c9d41';
const BEIJING = ['故宫博物院', '天坛公园', '颐和园', '北海公园'];

const codes = (report) => report.findings.map((item) => item.code);

function policy(overrides = {}) {
  return { ...DEFAULT_ACCURACY_POLICY, ...overrides };
}

test('票价：只有同时出现价格词和金额才算编造', () => {
  const cases = [
    ['故宫门票 60 元，很适合慢慢逛。', true],
    ['门票大约 60 元。', true],
    ['成人票 40 元，学生票 20 元。', true],
    ['一张票 60 元。', true],
    ['按你 3000 元的预算来安排。', false],
    ['这座公园免费开放。', false],
    ['价格建议出发前查官方渠道。', false],
    ['人均 200 元的餐厅可以看看。', false],
  ];
  for (const [reply, expected] of cases) {
    const report = inspectReply(reply, BEIJING, policy());
    assert.equal(
      codes(report).includes('FABRICATED_PRICE'),
      expected,
      `${reply} => ${JSON.stringify(report.findings)}`,
    );
  }
});

test('开放时间：只有同时出现开关门词和时刻才算编造', () => {
  const cases = [
    ['故宫 8:30 开门，17:00 闭馆。', true],
    ['早上 8 点开门，建议早点到。', true],
    ['开放时间 9:00 到 17:00。', true],
    ['建议 9:00 出发避开人流。', false],
    ['下午 3 点去比较凉快。', false],
    ['可以安排半天时间。', false],
    ['注意周一会闭馆，别空跑。', false],
  ];
  for (const [reply, expected] of cases) {
    const report = inspectReply(reply, BEIJING, policy());
    assert.equal(
      codes(report).includes('FABRICATED_HOURS'),
      expected,
      `${reply} => ${JSON.stringify(report.findings)}`,
    );
  }
});

test('地点：目录内的名字不算越界，简称也能容忍', () => {
  for (const reply of [
    '推荐故宫博物院和天坛公园。',
    '推荐故宫，还有颐和园。',
    '北海公园适合散步。',
  ]) {
    const findings = findOutsidePlaces(reply, BEIJING, policy());
    assert.deepEqual(findings, [], `${reply} => ${JSON.stringify(findings)}`);
  }
});

test('地点：别的城市的热门景点会被标出来', () => {
  const findings = findOutsidePlaces('推荐上海外滩，也可以去西湖。', BEIJING, policy());
  const names = findings.map((item) => item.place);
  assert.ok(names.includes('上海外滩'), JSON.stringify(names));
  assert.ok(names.includes('西湖'), JSON.stringify(names));
  assert.ok(findings.every((item) => item.severity === 'warn'));
  assert.ok(findings.every((item) => item.code === 'PLACE_OUTSIDE_CATALOG'));
});

test('地点：最长命中优先，不会同时报「外滩」和「上海外滩」', () => {
  const findings = findOutsidePlaces('推荐上海外滩。', BEIJING, policy());
  assert.deepEqual(
    findings.map((item) => item.place),
    ['上海外滩'],
  );
});

test('地点：没有目录时不检测，否则所有地名都会被判越界', () => {
  assert.deepEqual(findOutsidePlaces('推荐上海外滩。', [], policy()), []);
  assert.deepEqual(
    findOutsidePlaces('推荐上海外滩。', BEIJING, policy({ unknownPlace: 'off' })),
    [],
  );
});

test('地点：unknownPlace=block 时变成阻断级', () => {
  const report = inspectReply('推荐上海外滩。', BEIJING, policy({ unknownPlace: 'block' }));
  assert.equal(report.blocking, true);
  assert.equal(report.findings[0].severity, 'block');
  assert.equal(inspectReply('推荐上海外滩。', BEIJING, policy()).blocking, false);
});

test('地点：后缀抽取默认关闭，打开后会多抓出未登记的景点', () => {
  const reply = '推荐云水古镇。';
  assert.deepEqual(findOutsidePlaces(reply, BEIJING, policy()), []);
  const withSuffix = findOutsidePlaces(reply, BEIJING, policy({ suffixExtraction: true }));
  assert.ok(
    withSuffix.some((item) => item.place.includes('古镇')),
    JSON.stringify(withSuffix),
  );
});

test('校验报告：同类规则命中同一片段只记一次，不同类各自记录', () => {
  const report = inspectReply('故宫门票 60 元，8:30 开门。', BEIJING, policy());
  const pairs = report.findings.map((item) => `${item.code}|${item.excerpt}`);
  assert.equal(new Set(pairs).size, pairs.length);
  assert.equal(report.blocking, true);
  assert.ok(codes(report).includes('FABRICATED_PRICE'));
  assert.ok(codes(report).includes('FABRICATED_HOURS'));
});

function completion(content) {
  return {
    choices: [{ finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function respond(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function service(mode, replies) {
  const calls = [];
  const transport = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const next = replies[Math.min(calls.length - 1, replies.length - 1)];
    return respond(completion(next));
  };
  const env = {
    CHAT_LLM_ENABLED: 'true',
    LLM_API_BASE_URL: 'https://api.deepseek.com/v1',
    LLM_API_KEY: 'test-secret',
    LLM_MODEL: 'deepseek-flash',
    CHAT_ACCURACY_MODE: mode,
  };
  const instance = new ChatService(
    { values: readChatConfig(env) },
    transport,
    () => 0,
    () => 'req-1',
  );
  return { service: instance, calls };
}

const ask = () => ({
  messages: [{ role: 'user', content: '北京有什么推荐？' }],
  context: { cityName: '北京市', placeNames: BEIJING },
});

test('enforce：第一次编造票价，重试一次拿到干净回答', async () => {
  const { service: instance, calls } = service('enforce', [
    '故宫门票 60 元，8:30 开门。',
    '推荐故宫博物院和天坛公园，票价和开放时间建议出发前确认。',
  ]);
  const result = await instance.reply(ask(), USER);
  assert.equal(calls.length, 2);
  assert.equal(result.reply.includes('60 元'), false);
  assert.equal(result.notices, undefined);

  // 重试请求里带上了上一轮回答和纠正指令。
  const retry = calls[1].messages;
  assert.equal(retry[retry.length - 2].role, 'assistant');
  assert.match(retry[retry.length - 1].content, /上一条回答不符合要求/);
  assert.match(retry[retry.length - 1].content, /不要给出票价/);
});

test('enforce：重试后仍不合格就拒绝，不把编造内容返回给用户', async () => {
  const { service: instance, calls } = service('enforce', ['故宫门票 60 元。']);
  await assert.rejects(instance.reply(ask(), USER), (error) => {
    assert.equal(error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(error.getStatus(), 503);
    assert.match(error.message, /准确性校验/);
    return true;
  });
  assert.equal(calls.length, 2);
});

test('enforce：重试次数可配为 0，只调一次就拒绝', async () => {
  const calls = [];
  const instance = new ChatService(
    {
      values: readChatConfig({
        CHAT_LLM_ENABLED: 'true',
        LLM_API_BASE_URL: 'https://api.deepseek.com/v1',
        LLM_API_KEY: 'k',
        LLM_MODEL: 'm',
        CHAT_ACCURACY_MODE: 'enforce',
        CHAT_ACCURACY_MAX_RETRIES: '0',
      }),
    },
    async (url, init) => {
      calls.push(JSON.parse(init.body));
      return respond(completion('故宫门票 60 元。'));
    },
    () => 0,
    () => 'req-1',
  );
  await assert.rejects(instance.reply(ask(), USER), /准确性校验/);
  assert.equal(calls.length, 1);
});

test('warn：不重试，把提示挂在响应里交给前端标注', async () => {
  const { service: instance, calls } = service('warn', ['推荐上海外滩，门票 60 元。']);
  const result = await instance.reply(ask(), USER);
  assert.equal(calls.length, 1);
  assert.ok(result.notices?.length, JSON.stringify(result));
  const noticeCodes = result.notices.map((item) => item.code);
  assert.ok(noticeCodes.includes('PLACE_OUTSIDE_CATALOG'), JSON.stringify(noticeCodes));
  // 票价是阻断级，warn 模式不重试也不返回提示，只记录日志。
  assert.equal(noticeCodes.includes('FABRICATED_PRICE'), false);
});

test('off：不校验、不加提示，行为与接入校验前一致', async () => {
  const { service: instance, calls } = service('off', ['故宫门票 60 元。']);
  const result = await instance.reply(ask(), USER);
  assert.equal(calls.length, 1);
  assert.equal(result.notices, undefined);
  assert.match(result.reply, /60 元/);
});

test('准确性配置：非法值直接启动失败', () => {
  assert.equal(readChatConfig({}).accuracyMode, 'off');
  assert.equal(readChatConfig({}).accuracyMaxRetries, 1);
  for (const env of [{ CHAT_ACCURACY_MODE: 'block' }, { CHAT_ACCURACY_MAX_RETRIES: '3' }])
    assert.throws(() => readChatConfig(env));
});

test('ChatConfig 注入形态与控制器使用的一致', () => {
  const config = new ChatConfig({ values: undefined });
  assert.equal(typeof config.values.enabled, 'boolean');
});
