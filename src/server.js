import cron from 'node-cron';
import { config, serverConfigProblems } from './config.js';
import { logger } from './logger.js';
import { createPool, waitForDatabase, acquireInstanceLock } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { PgStore } from './db/store.js';
import { Protection } from './core/protection.js';
import { createRouterAdapter } from './router/index.js';
import { Reconciler } from './services/reconciler.js';
import { seedAdminUser } from './services/seedAdmin.js';
import { createApp } from './web/app.js';

export const EXIT_ALREADY_RUNNING = 3;
export const EXIT_CONFIG = 78;

async function main() {
  const problems = serverConfigProblems();
  if (problems.length) {
    for (const p of problems) logger.fatal(p);
    process.exit(EXIT_CONFIG);
  }

  const pool = createPool(config.databaseUrl, logger);
  await waitForDatabase(pool, logger);
  await migrate(pool, logger);

  const { client: lock, holder } = await acquireInstanceLock(config.databaseUrl, logger);
  if (!lock) {
    logger.error(
      { holder },
      holder
        ? `Another instance is already running (connected from ${holder.client ?? 'this machine'} since ${holder.since}, DB pid ${holder.pid}). ` +
            'Stop it first: scripts\\stop.ps1 on the server. Exiting.'
        : 'Another instance of Nexus Internet Scheduler is already running. Exiting.',
    );
    await pool.end();
    process.exit(EXIT_ALREADY_RUNNING);
  }

  const store = new PgStore(pool);
  await seedAdminUser(store, { username: config.dashboardUsername, password: config.dashboardPassword }, logger);
  if (!(await store.getSetting('admin_user'))) {
    logger.warn('No dashboard login exists. Set DASHBOARD_USERNAME and DASHBOARD_PASSWORD in .env and restart.');
  }
  const protection = await Protection.detect({ routerHost: config.routerHost, extraMacs: config.protectedMacs, logger });
  const router = createRouterAdapter(config, protection, logger);
  const reconciler = new Reconciler({
    store,
    router,
    protection,
    logger,
    timezone: config.timezone,
    dryRun: config.dryRun,
    schedulerEnabled: config.schedulerEnabled,
    pollMinutes: config.routerPollMinutes,
  });

  if (config.dryRun && (await store.getSetting('control_armed')) === true) {
    logger.warn('DRY_RUN=true: router control is treated as disarmed even though it was armed earlier');
  }

  await store.logActivity({
    action: 'app_started',
    trigger: 'system',
    result: 'info',
    detail: `dry_run=${config.dryRun}, scheduler=${config.schedulerEnabled}, armed=${await reconciler.isArmed()}, tz=${config.timezone}`,
  });

  const app = createApp({ config, pool, store, reconciler, protection, logger });
  const server = app.listen(config.port, config.host, () => {
    logger.info(`Dashboard on http://${config.host}:${config.port} (dry_run=${config.dryRun}, scheduler=${config.schedulerEnabled})`);
  });

  // Reconcile immediately after start: recovers state after app / Windows / router restarts.
  reconciler.tick({ forcePoll: true, trigger: 'startup' });

  // The level-based reconciler runs every minute (always, so restores and override expiry work);
  // schedule-driven BLOCKS are suppressed inside the reconciler when SCHEDULER_ENABLED=false.
  const task = cron.schedule('* * * * *', () => reconciler.tick({ trigger: 'schedule' }), {
    timezone: config.timezone,
    name: 'reconcile',
    noOverlap: true,
  });

  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    task.stop();
    server.close();
    await reconciler.idle().catch(() => {});
    await store.logActivity({ action: 'app_stopped', trigger: 'system', result: 'info', detail: `signal=${signal}` }).catch(() => {});
    await pool.end().catch(() => {});
    await lock.end().catch(() => {});
    process.exit(0);
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => shutdown(sig));
  process.on('message', (m) => m === 'shutdown' && shutdown('supervisor'));
  // Started by the supervisor: if it dies (e.g. the boot task is stopped), Windows does
  // not kill us. Exit too, so an orphan never keeps holding the instance lock.
  if (process.send) process.on('disconnect', () => shutdown('supervisor exited'));
}

process.on('unhandledRejection', (err) => logger.error({ err: err?.message ?? String(err) }, 'Unhandled rejection'));

main().catch((err) => {
  logger.fatal({ err: err.message }, 'Startup failed');
  process.exit(1);
});
