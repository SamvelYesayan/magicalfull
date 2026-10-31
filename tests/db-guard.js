// Safety guard: the test suite wipes tables, so it may ONLY run against a dedicated database whose name ends in "_test"
// and that is different from the application's normal database.
export function databaseNameOf(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('TEST_DATABASE_URL is not a valid URL'); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('TEST_DATABASE_URL must be a postgresql:// URL');
  const name = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!name) throw new Error('TEST_DATABASE_URL must include a database name');
  return name;
}

export function assertSafeTestDatabase(testUrl, env = process.env) {
  if (!testUrl) throw new Error('Refusing to run: TEST_DATABASE_URL is not set. Create an empty database such as magical_web_test and set TEST_DATABASE_URL (see README).');
  const name = databaseNameOf(testUrl);
  if (!/^[A-Za-z0-9_]+_test$/.test(name)) throw new Error(`Refusing to run: test database "${name}" must have a name ending in "_test" (e.g. magical_web_test).`);
  const normal = [env.DATABASE_URL ? databaseNameOf(env.DATABASE_URL) : null, env.PGDATABASE || null].filter(Boolean);
  if (normal.includes(name)) throw new Error(`Refusing to run: test database "${name}" is the same as the application database.`);
  if (env.DATABASE_URL && env.DATABASE_URL === testUrl) throw new Error('Refusing to run: TEST_DATABASE_URL equals DATABASE_URL.');
  return name;
}
