import { buildApp } from './app.js'
import { readConfig } from './config.js'
try {
  const config=readConfig(),app=await buildApp(config)
  await app.listen({host:config.HOST,port:config.PORT})
  for(const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>{ void app.close().catch(()=>{process.exitCode=1}) })
} catch { console.error('Backend startup failed. Check environment and PostgreSQL availability.'); process.exitCode=1 }
