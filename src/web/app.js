import path from 'node:path';
import express from 'express';
import session from 'express-session';
import { ROOT } from '../config.js';
import { PgSessionStore } from '../db/sessionStore.js';
import {
  csrfProtect,
  csrfToken,
  requireAuth,
  securityHeaders,
  verifyPassword,
  loginAllowed,
  recordLoginFailure,
  clearLoginFailures,
} from './security.js';
import { apiRouter } from './api.js';

export function createApp({ config, pool, store, reconciler, protection, logger }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'src', 'views'));

  app.use(securityHeaders);
  app.use('/static', express.static(path.join(ROOT, 'src', 'public'), { maxAge: 0 }));
  app.use('/vendor/bootstrap', express.static(path.join(ROOT, 'node_modules', 'bootstrap', 'dist'), { maxAge: '7d' }));
  app.use(express.json({ limit: '50kb' }));
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));

  app.get('/healthz', (_req, res) =>
    res.json({ ok: true, role: reconciler.active ? 'active' : 'standby', lastTickAt: reconciler.status.lastTickAt }),
  );

  app.use(
    session({
      name: 'nis.sid',
      secret: config.sessionSecret,
      store: new PgSessionStore(pool, logger),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: { httpOnly: true, sameSite: 'strict', secure: false, maxAge: 12 * 3600_000 },
    }),
  );
  app.use(csrfProtect);

  // ---------- auth ----------
  app.get('/login', async (req, res) => {
    if (req.session.user) return res.redirect('/');
    const admin = await store.getSetting('admin_user');
    res.render('login', { csrf: csrfToken(req), error: null, setupNeeded: !admin });
  });

  app.post('/login', async (req, res) => {
    const ip = req.ip;
    const admin = await store.getSetting('admin_user');
    const render = (status, error) => res.status(status).render('login', { csrf: csrfToken(req), error, setupNeeded: !admin });
    if (!admin) return render(400, 'No dashboard user exists yet. Set DASHBOARD_PASSWORD in .env and restart.');
    if (!loginAllowed(ip)) return render(429, 'Too many failed attempts. Wait 15 minutes.');
    const username = String(req.body.username ?? '');
    const password = String(req.body.password ?? '');
    if (username !== admin.username || !verifyPassword(password, admin.hash)) {
      recordLoginFailure(ip);
      logger.warn({ ip }, 'Failed dashboard login');
      await store.logActivity({ action: 'login_failed', trigger: 'system', result: 'failed', detail: `Failed login from ${ip}` }).catch(() => {});
      return render(401, 'Invalid username or password.');
    }
    clearLoginFailures(ip);
    req.session.regenerate((err) => {
      if (err) return render(500, 'Session error');
      req.session.user = admin.username;
      csrfToken(req);
      req.session.save(() => res.redirect('/'));
    });
  });

  app.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
  });

  // ---------- dashboard ----------
  app.get('/', requireAuth, (req, res) => {
    res.render('dashboard', { csrf: csrfToken(req), user: req.session.user });
  });

  app.use('/api', requireAuth, apiRouter({ config, store, reconciler, protection, logger }));

  app.use((_req, res) => res.status(404).send('Not found'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    logger.error({ err: err.message, path: req.path }, 'Request failed');
    const status = err.status ?? 500;
    const message = status < 500 ? err.message : 'Internal error - see server log';
    if (req.originalUrl.startsWith('/api/')) res.status(status).json({ error: message });
    else res.status(status).send(message);
  });

  return app;
}
