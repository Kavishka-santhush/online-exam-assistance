const { PrismaClient } = require('@prisma/client');
(async () => {
  const p = new PrismaClient();
  try {
    const r = await p.$queryRawUnsafe("SELECT pg_terminate_backend(pid) AS killed FROM pg_locks WHERE locktype = 'advisory' AND pid <> pg_backend_pid()");
    console.log('premigrate: advisory-lock cleanup rows=', r.length);
  } catch (e) {
    console.log('premigrate: warning', String(e && e.message ? e.message : e).slice(0, 200));
    await p.$disconnect();
    process.exit(0);
  }
  await p.$disconnect();
})();