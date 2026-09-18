if (process.env.NODE_ENV && process.env.NODE_ENV !== 'development') {
  console.error('The LAN development launcher requires NODE_ENV=development.')
  process.exitCode = 1
} else {
  process.env.NODE_ENV = 'development'
  process.env.HOST = '0.0.0.0'
  await import('../src/server.ts')
}
