import cron from 'node-cron';
import { config, serverConfigProblems } from './config.js';
import { logger } from './logger.js';
import { createPool, waitForDatabase, InstanceLock } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { PgStore } from './db/store.js';
import { Protection } from './core/protection.js';
import { createRouterAdapter } from './router/index.js';
import { Reconciler } from './services/reconciler.js';
import { seedAdminUser } from './services/seedAdmin.js';
import { createApp } from './web/app.js';

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

  const store = new PgStore(pool);
  await seedAdminUser(store, { username: config.dashboardUsername, password: config.dashboardPassword }, logger);
  if (!(await store.getSetting('admin_user'))) {
    logger.warn('No dashboard login exists. Set DASHBOARD_USERNAME and DASHBOARD_PASSWORD and restart.');
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
    active: false, // becomes active only once this process holds the instance lock
  });

  // Start the web server first so health checks pass even while in standby.
  const app = createApp({ config, pool, store, reconciler, protection, logger });
  const server = app.listen(config.port, config.host, () => {
    logger.info(`Dashboard on http://${config.host}:${config.port} (dry_run=${config.dryRun}, scheduler=${config.schedulerEnabled})`);
  });

  let task = null;
  async function startScheduling() {
    reconciler.active = true;
    if (config.dryRun && (await store.getSetting('control_armed')) === true) {
      logger.warn('DRY_RUN=true: router control is treated as disarmed even though it was armed earlier');
    }
    await store.logActivity({
      action: 'app_started',
      trigger: 'system',
      result: 'info',
      detail: `dry_run=${config.dryRun}, scheduler=${config.schedulerEnabled}, armed=${await reconciler.isArmed()}, tz=${config.timezone}`,
    });
    logger.info('Scheduling engine active');
    // Reconcile immediately: recovers state after app / Windows / router restarts and deploys.
    reconciler.tick({ forcePoll: true, trigger: 'startup' });
    // The level-based reconciler runs every minute; schedule-driven BLOCKS are
    // suppressed inside the reconciler when SCHEDULER_ENABLED=false.
    task = cron.schedule('* * * * *', () => reconciler.tick({ trigger: 'schedule' }), {
      timezone: config.timezone,
      name: 'reconcile',
      noOverlap: true,
    });
  }

  // Only one process may schedule. During a deploy the previous version still holds
  // the lock: wait in standby (dashboard up, no router commands) until it stops.
  const lock = new InstanceLock(config.databaseUrl, logger);
  if (await lock.tryAcquire()) {
    await startScheduling();
  } else {
    const holder = await lock.holder();
    logger.warn(
      { holder },
      'Another instance holds the scheduler lock (normal during a deploy while the previous version is still running). ' +
        'Starting in STANDBY: the dashboard is available, scheduling starts as soon as the other instance stops.',
    );
    lock.waitUntilAcquired().then((acquired) => {
      if (acquired) {
        logger.info('Previous instance stopped; taking over scheduling');
        startScheduling().catch((err) => logger.error({ err: err.message }, 'Failed to start scheduling'));
      }
    });
  }

  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    task?.stop();
    server.close();
    await reconciler.idle().catch(() => {});
    if (reconciler.active) {
      await store.logActivity({ action: 'app_stopped', trigger: 'system', result: 'info', detail: `signal=${signal}` }).catch(() => {});
    }
    await lock.release();
    await pool.end().catch(() => {});
    process.exit(0);
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => shutdown(sig));
  process.on('message', (m) => m === 'shutdown' && shutdown('supervisor'));
  // Started by the supervisor: exit with it so an orphan never keeps holding the lock.
  if (process.send) process.on('disconnect', () => shutdown('supervisor exited'));
}

process.on('unhandledRejection', (err) => logger.error({ err: err?.message ?? String(err) }, 'Unhandled rejection'));

main().catch((err) => {
  logger.fatal({ err: err.message }, 'Startup failed');
  process.exit(1);
});
