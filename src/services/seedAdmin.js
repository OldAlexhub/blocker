import { hashPassword, verifyPassword } from '../web/security.js';

export const MIN_PASSWORD_LENGTH = 10;

/**
 * Seed / sync the dashboard login from DASHBOARD_USERNAME + DASHBOARD_PASSWORD
 * on every start. Only a scrypt hash is stored in the database.
 *   - no env password      -> leave the database alone
 *   - no user in database  -> create it
 *   - env differs from DB  -> update it (change .env + restart = new password)
 *   - env matches DB       -> nothing to do
 * Returns 'skipped' | 'created' | 'updated' | 'unchanged' | 'invalid'.
 */
export async function seedAdminUser(store, { username, password }, logger) {
  if (!password) return 'skipped';
  const user = (username || 'admin').trim();
  if (password.length < MIN_PASSWORD_LENGTH) {
    logger?.error(`DASHBOARD_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters; dashboard login not seeded`);
    return 'invalid';
  }
  const existing = await store.getSetting('admin_user');
  if (existing && existing.username === user && verifyPassword(password, existing.hash)) return 'unchanged';

  await store.setSetting('admin_user', { username: user, hash: hashPassword(password) });
  const result = existing ? 'updated' : 'created';
  await store.logActivity({
    action: 'password_changed',
    trigger: 'system',
    result: 'info',
    detail: `Dashboard user "${user}" ${result} from .env`,
  });
  logger?.info({ username: user }, `Dashboard login ${result} from .env`);
  return result;
}
