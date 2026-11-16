/**
 * Tiny process supervisor (no dependencies). Windows Task Scheduler starts
 * this at boot; it runs src/server.js and restarts it if it crashes.
 * Output goes to logs/app.log (rotated at 10 MB, 5 files kept).
 */
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const KEEP = 5;
const EXIT_ALREADY_RUNNING = 3;
const EXIT_CONFIG = 78;

fs.mkdirSync(LOG_DIR, { recursive: true });

function rotate() {
  try {
    if (fs.statSync(LOG_FILE).size < MAX_LOG_BYTES) return;
  } catch {
    return;
  }
  for (let i = KEEP - 1; i >= 1; i--) {
    const from = `${LOG_FILE}.${i}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${LOG_FILE}.${i + 1}`);
  }
  fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
}

function note(msg) {
  fs.appendFileSync(LOG_FILE, `${JSON.stringify({ level: 30, time: Date.now(), msg: `[supervisor] ${msg}` })}\n`);
}

let child = null;
let stopping = false;
let delay = 2000;

function start() {
  rotate();
  const out = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  const startedAt = Date.now();
  child = fork(path.join(ROOT, 'src', 'server.js'), [], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(out, { end: false });
  note(`started pid ${child.pid}`);

  child.on('exit', (code, signal) => {
    out.end();
    child = null;
    if (stopping) return process.exit(0);
    if (Date.now() - startedAt > 5 * 60_000) delay = 2000; // ran fine for a while: reset backoff
    let wait = delay;
    if (code === EXIT_ALREADY_RUNNING) wait = 60_000;
    if (code === EXIT_CONFIG) wait = 5 * 60_000; // config error: retry slowly
    note(`server exited (code=${code}, signal=${signal}); restarting in ${Math.round(wait / 1000)}s`);
    setTimeout(start, wait);
    delay = Math.min(delay * 2, 60_000);
  });

  // Rotate during long runs too.
  const rotTimer = setInterval(() => {
    try {
      if (fs.statSync(LOG_FILE).size >= MAX_LOG_BYTES && child) child.send('shutdown');
    } catch { /* ignore */ }
  }, 10 * 60_000);
  child.on('exit', () => clearInterval(rotTimer));
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  note(`stopping (${signal})`);
  if (!child) return process.exit(0);
  child.send('shutdown');
  setTimeout(() => {
    child?.kill();
    process.exit(0);
  }, 15_000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => stop(sig));

start();
