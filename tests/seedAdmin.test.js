import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedAdminUser } from '../src/services/seedAdmin.js';
import { verifyPassword } from '../src/web/security.js';
import { MemoryStore } from './support/memoryStore.js';

test('seeds the dashboard login from env, hashed', async () => {
  const store = new MemoryStore();
  assert.equal(await seedAdminUser(store, { username: 'admin', password: 'first-password' }), 'created');
  const saved = store.settings.get('admin_user');
  assert.equal(saved.username, 'admin');
  assert.ok(!JSON.stringify(saved).includes('first-password'), 'plaintext never stored');
  assert.ok(verifyPassword('first-password', saved.hash));
});

test('restart with same env is a no-op; changed env updates the password', async () => {
  const store = new MemoryStore();
  await seedAdminUser(store, { username: 'admin', password: 'first-password' });
  const hash1 = store.settings.get('admin_user').hash;
  assert.equal(await seedAdminUser(store, { username: 'admin', password: 'first-password' }), 'unchanged');
  assert.equal(store.settings.get('admin_user').hash, hash1);
  assert.equal(await seedAdminUser(store, { username: 'admin', password: 'second-password' }), 'updated');
  assert.ok(verifyPassword('second-password', store.settings.get('admin_user').hash));
  assert.ok(!verifyPassword('first-password', store.settings.get('admin_user').hash));
  assert.equal(await seedAdminUser(store, { username: 'mohamed', password: 'second-password' }), 'updated');
  assert.equal(store.settings.get('admin_user').username, 'mohamed');
});

test('no env password leaves the database alone; short password rejected', async () => {
  const store = new MemoryStore();
  assert.equal(await seedAdminUser(store, { username: 'admin', password: '' }), 'skipped');
  assert.equal(await seedAdminUser(store, { username: 'admin', password: 'short' }), 'invalid');
  assert.equal(store.settings.has('admin_user'), false);
});
