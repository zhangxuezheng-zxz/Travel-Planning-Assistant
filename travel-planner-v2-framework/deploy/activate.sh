#!/usr/bin/env bash
set -euo pipefail
base=/home/ubuntu/travel-auth-profile
release_name="${1:?Supply a release name}"
expected_sha="${2:?Supply the checked release SHA256}"
[[ "$release_name" =~ ^[A-Za-z0-9._-]+$ ]] || exit 1
[[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]] || exit 1
release="$base/releases/$release_name"
web_release="/var/www/travel-auth-profile/releases/$release_name"
cd "$base"
printf '%s  server-release.tar.gz\n' "$expected_sha" | sha256sum -c -
test -f "$base/shared/.env"
mkdir -p "$release" "$base/shared/media"
test "$(realpath "$release")" = "$release"
python3 - "$base/server-release.tar.gz" <<'PY'
import pathlib,sys,tarfile
with tarfile.open(sys.argv[1]) as archive:
    for entry in archive:
        name=pathlib.PurePosixPath(entry.name)
        assert not name.is_absolute() and ".." not in name.parts
        assert not entry.issym() and not entry.islnk()
        assert ".env" not in name.parts and ".data" not in name.parts and "node_modules" not in name.parts
PY
tar -xzf "$base/server-release.tar.gz" -C "$release"
ln -sfn "$base/shared/.env" "$release/.env"
cd "$release"
export PATH=/opt/travel-auth-node/bin:/usr/local/bin:/usr/bin:/bin
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
node <<'JS'
const {spawnSync}=require('node:child_process');
const env=require('dotenv').config({path:'.env'}).parsed;
const db=new URL(env.DATABASE_URL);
if(db.hostname!=='127.0.0.1'||db.pathname!=='/travel_auth_profile'||db.username!=='travel_auth_app')throw new Error('Unexpected deployment database');
const literal=value=>"'"+value.replaceAll("'","''")+"'";
function sql(text){
 const result=spawnSync('sudo',['-n','-u','postgres','psql','-X','-v','ON_ERROR_STOP=1','-At','-d','postgres'],{input:text,encoding:'utf8',cwd:'/tmp'});
 if(result.status!==0)throw new Error('Database provisioning failed');
 return result.stdout.trim();
}
if(sql("SELECT 1 FROM pg_roles WHERE rolname='travel_auth_app'")!=='1'){
 sql("CREATE ROLE travel_auth_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD "+literal(decodeURIComponent(db.password)));
}
if(sql("SELECT 1 FROM pg_database WHERE datname='travel_auth_profile'")!=='1'){
 sql('CREATE DATABASE travel_auth_profile OWNER travel_auth_app');
}
console.log('Dedicated database and application role are ready.');
JS
npm run db:migrate
node <<'JS'
const {Client}=require('pg');
require('dotenv').config({path:'.env'});
(async()=>{
 const client=new Client({connectionString:process.env.DATABASE_URL});
 await client.connect();
 try{
  const count=Number((await client.query('SELECT count(*) AS n FROM places')).rows[0].n);
  if(count===0){
   await require('./apps/api/scripts/seed-b.cjs').seedB(client);
   await require('./apps/api/scripts/seed-beijing.cjs').seedBeijing(client);
  }
  const counts=await client.query('SELECT (SELECT count(*) FROM users)::int AS users,(SELECT count(*) FROM places)::int AS places');
  console.log('Deployment database counts:',counts.rows[0]);
 }finally{await client.end();}
})().catch(()=>{console.error('Catalog initialization failed');process.exitCode=1});
JS
node apps/api/scripts/check-email.cjs
sudo -n install -d -m 0755 "$web_release"
sudo -n cp -R apps/web/dist/. "$web_release/"
sudo -n chmod -R u=rwX,go=rX "$web_release"
sudo -n ln -sfn "$web_release" /var/www/travel-auth-profile/current
ln -sfn "$release" "$base/current"
sudo -n install -m 0644 deploy/travel-auth-profile.service /etc/systemd/system/travel-auth-profile.service
sudo -n systemctl daemon-reload
sudo -n systemctl enable travel-auth-profile.service
sudo -n systemctl restart travel-auth-profile.service
for attempt in $(seq 1 20); do
    if curl --fail --silent http://127.0.0.1:3000/api/ready; then
        printf '\nAPI readiness verified.\n'
        exit 0
    fi
    sleep 1
done
exit 1
