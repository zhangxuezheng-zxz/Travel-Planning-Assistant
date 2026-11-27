const { createHash } = require('node:crypto');
const { readFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

const root = resolve(__dirname, '../../..');
const output = resolve(root, 'apps/api/.data');
const archive = resolve(output, 'server-release.tar.gz');
const entries = [
  'package.json',
  'package-lock.json',
  'apps/api/package.json',
  'apps/api/dist',
  'apps/api/migrations',
  'apps/api/scripts',
  'apps/web/package.json',
  'apps/web/dist',
  'packages/shared',
  'docs/examples/demo-scenario.json',
  'deploy',
];
for (const entry of entries) {
  if (!existsSync(resolve(root, entry)))
    throw new Error('Build the server and web app before packaging: ' + entry);
}
mkdirSync(output, { recursive: true });
execFileSync('tar', ['-czf', archive, ...entries], { cwd: root });
const contents = execFileSync('tar', ['-tzf', archive], { cwd: root, encoding: 'utf8' });
if (
  contents
    .split(/\r?\n/)
    .some(
      (name) =>
        /(^|\/)(\.env(?:\.|$)|\.data\/|node_modules\/)/.test(name) ||
        name.split('/').includes('..'),
    )
) {
  throw new Error('Deployment archive contains a private or invalid path');
}
const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(resolve(output, 'server-release.sha256'), sha256 + '  server-release.tar.gz\n');
console.log('Packaged built server/web, migrations and catalog; credentials excluded.');
console.log('Archive SHA256: ' + sha256);
