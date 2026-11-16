/**
 * OPTIONAL: change the dashboard login interactively.  Usage:  npm run set-password [username]
 * Normally the login is seeded from DASHBOARD_USERNAME / DASHBOARD_PASSWORD in .env
 * on every start. If DASHBOARD_PASSWORD is set, the next restart replaces whatever
 * this script stores.
 * Stores only a scrypt hash in application_settings.
 */
import readline from 'node:readline';
import { config } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { PgStore } from '../src/db/store.js';
import { hashPassword } from '../src/web/security.js';

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
        else if (s.includes('\n') || s.includes('\r')) rl.output.write('\n');
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

const username = (process.argv[2] || (await ask('Dashboard username [admin]: ')) || 'admin').trim();
const pw1 = await ask('New password (min 10 chars): ', true);
const pw2 = await ask('Repeat password: ', true);
if (pw1 !== pw2) {
  console.error('Passwords do not match.');
  process.exit(1);
}
if (pw1.length < 10) {
  console.error('Password must be at least 10 characters.');
  process.exit(1);
}

const pool = createPool(config.databaseUrl);
try {
  await migrate(pool);
  const store = new PgStore(pool);
  await store.setSetting('admin_user', { username, hash: hashPassword(pw1) });
  await store.logActivity({ action: 'password_changed', trigger: 'system', result: 'info', detail: `Dashboard user "${username}" set` });
  console.log(`Dashboard user "${username}" saved.`);
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
