const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { runner } = require('node-pg-migrate');
require('dotenv').config({ path: resolve(__dirname, '../../../.env') });

async function main() {
  const url = process.env.AUTH_TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Set AUTH_TEST_DATABASE_URL to a dedicated database ending in _test');
  await runner({
    databaseUrl: url,
    dir: resolve(__dirname, '../migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const result = spawnSync(
    process.execPath,
    ['--test', 'tests/integration/auth-profile.test.cjs'],
    {
      cwd: resolve(__dirname, '..'),
      env: process.env,
      stdio: 'inherit',
    },
  );
  process.exitCode = result.status ?? 1;
}
main().catch(() => {
  console.error(
    'Auth integration test failed. Check the dedicated test database and migration configuration.',
  );
  process.exitCode = 1;
});
