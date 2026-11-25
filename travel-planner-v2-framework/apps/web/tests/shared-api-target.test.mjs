import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../dev-api-target.ts', import.meta.url), 'utf8');
const module = { exports: {} };
new Function(
  'module',
  'exports',
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
)(module, module.exports);
const { resolveDevApiTarget, SHARED_TEST_API_ORIGIN } = module.exports;

test('共享测试入口无需 .env，并忽略个人的本机 API 配置', () => {
  assert.equal(resolveDevApiTarget('shared', {}), SHARED_TEST_API_ORIGIN);
  assert.equal(
    resolveDevApiTarget('shared', { PORT: '3002', API_PROXY_TARGET: 'http://127.0.0.1:3002' }),
    SHARED_TEST_API_ORIGIN,
  );
});

test('共享接口仅允许无凭据的 HTTPS origin，本地开发保持原代理配置', () => {
  assert.equal(
    resolveDevApiTarget('shared', { SHARED_API_PROXY_TARGET: 'https://test.example.com' }),
    'https://test.example.com',
  );
  for (const origin of [
    'http://example.com',
    'https://user:secret@example.com',
    'https://example.com/api',
    'https://example.com/',
  ]) {
    assert.throws(() => resolveDevApiTarget('shared', { SHARED_API_PROXY_TARGET: origin }));
  }
  assert.equal(resolveDevApiTarget('development', { PORT: '3002' }), 'http://127.0.0.1:3002');
  assert.equal(
    resolveDevApiTarget('development', { API_PROXY_TARGET: 'http://localhost:4000' }),
    'http://localhost:4000',
  );
});
