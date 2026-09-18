import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { userInfo } from 'node:os'

// Development-only bootstrap for an installed PostgreSQL distribution, not a production installer.
const bin=resolve(process.env.PG_BIN ?? '.local/pgsql/bin'),base=resolve('.local'),data=resolve(base,'pgdata'),socket=resolve(base,'socket')
const port='55432',command=process.argv[2] ?? 'status'
function run(name,args,input) {
  const result=spawnSync(resolve(bin,name),args,{input,encoding:'utf8'})
  if(result.status!==0) throw new Error(`${name} failed; inspect .local/postgres.log and local installation`)
  return result.stdout
}
function start() {
  const status=spawnSync(resolve(bin,'pg_ctl'),['-D',data,'status'],{stdio:'ignore'})
  if(status.status!==0) run('pg_ctl',['-D',data,'-l',resolve(base,'postgres.log'),'-o',`-p ${port} -h 127.0.0.1 -k ${socket}`,'-w','start'])
}
try {
  mkdirSync(socket,{recursive:true,mode:0o700})
  if(command==='init') {
    if(existsSync(data)||existsSync('.env')||existsSync('.env.test')) throw new Error('Existing database or env files detected; use start instead. No files were overwritten.')
    run('initdb',['-D',data,'--encoding=UTF8','--locale=C','--auth-local=peer','--auth-host=scram-sha-256'])
    start()
    const appPassword=randomBytes(32).toString('hex'),testPassword=randomBytes(32).toString('hex'),rateSecret=randomBytes(32).toString('hex')
    const sql=`CREATE ROLE chatpop_app LOGIN PASSWORD '${appPassword}';
CREATE ROLE chatpop_test LOGIN PASSWORD '${testPassword}';
CREATE DATABASE chatpop OWNER chatpop_app;
CREATE DATABASE chatpop_test OWNER chatpop_test;
REVOKE CONNECT ON DATABASE chatpop FROM PUBLIC;
REVOKE CONNECT ON DATABASE chatpop_test FROM PUBLIC;
GRANT CONNECT ON DATABASE chatpop TO chatpop_app;
GRANT CONNECT ON DATABASE chatpop_test TO chatpop_test;`
    run('psql',['-h',socket,'-p',port,'-U',userInfo().username,'-d','postgres','-v','ON_ERROR_STOP=1'],sql)
    const common=`HOST=127.0.0.1\nPORT=3000\nDATABASE_SSL=false\nRATE_LIMIT_SECRET=${rateSecret}\nACCESS_TOKEN_SECONDS=900\nSESSION_DAYS=30\nCORS_ORIGINS=capacitor://localhost,http://localhost:5173\nSTORAGE_DRIVER=disabled\nSTORAGE_LOCAL_ROOT=.local/private-media\n`
    writeFileSync('.env',`NODE_ENV=development\nDATABASE_URL=postgresql://chatpop_app:${appPassword}@127.0.0.1:${port}/chatpop\n${common}`,{mode:0o600,flag:'wx'})
    writeFileSync('.env.test',`NODE_ENV=test\nDATABASE_URL=postgresql://chatpop_test:${testPassword}@127.0.0.1:${port}/chatpop_test\nALLOW_TEST_DATABASE_RESET=chatpop_test\n${common}`,{mode:0o600,flag:'wx'})
    console.log('Persistent PostgreSQL initialized; isolated databases and private env files created.')
  } else if(command==='start') { start(); console.log('PostgreSQL started') }
  else if(command==='stop') { run('pg_ctl',['-D',data,'-m','fast','-w','stop']); console.log('PostgreSQL stopped') }
  else if(command==='status') console.log(run('pg_ctl',['-D',data,'status']))
  else throw new Error('Use init, start, stop, or status')
} catch(error) { console.error(error.message); process.exitCode=1 }
