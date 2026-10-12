import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuthError, AuthStore } from './auth';

const SECRET = 'a-long-test-registration-secret-with-entropy';
const PASSWORD = 'correct horse battery staple';
const CHANGED_PASSWORD = 'a different long account password';

async function temporaryStore(run: (filePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-auth-'));
  try {
    await run(path.join(directory, 'private', 'auth.json'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function rejectsStatus(status: number): (error: unknown) => boolean {
  return error => error instanceof AuthError && error.status === status;
}

// These use the production scrypt parameters, including the password-work limit.
// Deliberately keep tests sequential so the memory budget reflects a single server.
test('registration requires the configured secret and validates account credentials', async () => {
  await temporaryStore(async filePath => {
    const disabled = await AuthStore.open(filePath);
    assert.equal(disabled.registrationEnabled, false);
    assert.equal(disabled.firstUserId, undefined);
    await assert.rejects(disabled.register('tester', PASSWORD, undefined), rejectsStatus(403));
    await assert.rejects(disabled.register('tester', PASSWORD, SECRET), rejectsStatus(403));
    await assert.rejects(AuthStore.open(filePath, { registrationSecret: 'too-short' }), /REGISTRATION_SECRET/);
    const store = await AuthStore.open(filePath, { registrationSecret: SECRET });
    assert.equal(store.registrationEnabled, true);
    await assert.rejects(store.register('tester', PASSWORD, undefined), rejectsStatus(403));
    await assert.rejects(store.register('tester', PASSWORD, 'incorrect-secret'), rejectsStatus(403));
    await assert.rejects(store.register('ab', PASSWORD, SECRET), rejectsStatus(400));
    await assert.rejects(store.register('contains space', PASSWORD, SECRET), rejectsStatus(400));
    await assert.rejects(store.register('Åccount', PASSWORD, SECRET), rejectsStatus(400));
    await assert.rejects(store.register('tester', 'short', SECRET), rejectsStatus(400));
    await assert.rejects(store.register('tester', 'x'.repeat(257), SECRET), rejectsStatus(400));
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).users.length, 0);
  });
});

test('concurrent registration is unique, persists only password hashes, and sessions survive restart', async () => {
  await temporaryStore(async filePath => {
    let now = 1_800_000_000_000;
    const store = await AuthStore.open(filePath, { registrationSecret: SECRET, sessionTtlMs: 5_000, now: () => now });
    const registrations = await Promise.allSettled([
      store.register('Tester', PASSWORD, SECRET), store.register('TESTER', PASSWORD, SECRET),
    ]);
    const successes = registrations.filter(result => result.status === 'fulfilled');
    const failures = registrations.filter(result => result.status === 'rejected');
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.equal((failures[0] as PromiseRejectedResult).reason.status, 409);
    const created = (successes[0] as PromiseFulfilledResult<Awaited<ReturnType<AuthStore['register']>>>).value;
    assert.equal(created.user.username, 'tester');
    assert.equal(store.firstUserId, created.user.id);
    assert.deepEqual(Object.keys(created.user).sort(), ['createdAt', 'id', 'username']);
    const contents = await readFile(filePath, 'utf8');
    assert.equal(contents.includes(PASSWORD), false);
    assert.equal(contents.includes(SECRET), false);
    assert.equal(contents.includes(created.token), false);
    const persisted = JSON.parse(contents);
    assert.equal(persisted.users.length, 1);
    assert.equal(persisted.users[0].password.algorithm, 'scrypt');
    assert.equal(persisted.users[0].password.N, 131_072);
    assert.equal(persisted.users[0].password.r, 8);
    assert.equal(persisted.users[0].password.p, 1);
    assert.match(persisted.users[0].password.salt, /^[a-f0-9]{64}$/);
    assert.match(persisted.users[0].password.key, /^[a-f0-9]{128}$/);
    assert.equal(persisted.sessions[0].tokenHash, createHash('sha256').update(created.token).digest('hex'));
    const restarted = await AuthStore.open(filePath, { sessionTtlMs: 5_000, now: () => now });
    assert.deepEqual(await restarted.getSession(created.token), { user: created.user, csrfToken: created.csrfToken, expiresAt: created.expiresAt });
    assert.equal(restarted.registrationEnabled, false);
    assert.equal(restarted.firstUserId, created.user.id);
    for (const invalid of [undefined, null, {}, 123, '', '%malformed', 'a'.repeat(1_000)]) {
      assert.equal(await restarted.getSession(invalid), null);
      await restarted.logout(invalid);
    }
    assert.equal(await restarted.getSession(randomBytes(32).toString('base64url')), null);
    now = created.expiresAt;
    assert.equal(await restarted.getSession(created.token), null);
    const expiredRestart = await AuthStore.open(filePath, { now: () => now });
    assert.equal(await expiredRestart.getSession(created.token), null);
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).sessions.length, 0);
    if (process.platform !== 'win32') {
      assert.equal((await stat(filePath)).mode & 0o777, 0o600);
      assert.equal((await stat(path.dirname(filePath))).mode & 0o777, 0o700);
    }
  });
});

test('login rejects unknown and wrong credentials identically; password changes revoke every session', async () => {
  await temporaryStore(async filePath => {
    const store = await AuthStore.open(filePath, { registrationSecret: SECRET });
    const created = await store.register('tester', PASSWORD, SECRET);
    let wrongMessage = '';
    await assert.rejects(store.login('tester', 'wrong long account password'), error => {
      assert.ok(error instanceof AuthError);
      assert.equal(error.status, 401);
      wrongMessage = error.message;
      return true;
    });
    await assert.rejects(store.login('missing', PASSWORD), error => {
      assert.ok(error instanceof AuthError);
      assert.equal(error.status, 401);
      assert.equal(error.message, wrongMessage);
      return true;
    });
    const signedIn = await store.login('TESTER', PASSWORD);
    assert.notEqual(signedIn.token, created.token);
    assert.notEqual(signedIn.csrfToken, created.csrfToken);
    assert.equal((await store.getSession(signedIn.token))?.user.id, created.user.id);
    await store.logout(created.token);
    assert.equal(await store.getSession(created.token), null);
    assert.ok(await store.getSession(signedIn.token));
    await assert.rejects(store.changePassword(created.user.id, 'wrong password supplied', CHANGED_PASSWORD), rejectsStatus(401));
    await store.changePassword(created.user.id, PASSWORD, CHANGED_PASSWORD);
    assert.equal(await store.getSession(signedIn.token), null);
    await assert.rejects(store.login('tester', PASSWORD), rejectsStatus(401));
    const changedSession = await store.login('tester', CHANGED_PASSWORD);
    assert.equal(changedSession.user.id, created.user.id);
    const contents = await readFile(filePath, 'utf8');
    assert.equal(contents.includes(CHANGED_PASSWORD), false);
    assert.equal(contents.includes(changedSession.token), false);
    const restarted = await AuthStore.open(filePath);
    assert.equal(await restarted.getSession(signedIn.token), null);
    assert.equal((await restarted.getSession(changedSession.token))?.user.id, created.user.id);
  });
});

test('a new login keeps at most ten sessions and evicts the oldest session only', async () => {
  await temporaryStore(async filePath => {
    const now = 1_800_000_000_000;
    const store = await AuthStore.open(filePath, { registrationSecret: SECRET, now: () => now });
    const created = await store.register('tester', PASSWORD, SECRET);
    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    const fixtureTokens = Array.from({ length: 10 }, () => randomBytes(32).toString('base64url'));
    persisted.sessions = fixtureTokens.map((token, index) => ({
      tokenHash: createHash('sha256').update(token).digest('hex'), userId: created.user.id,
      csrfToken: randomBytes(32).toString('hex'), createdAt: now - 1_000 + index, expiresAt: now + 60_000,
    }));
    await writeFile(filePath, JSON.stringify(persisted));
    const restarted = await AuthStore.open(filePath, { now: () => now });
    const signedIn = await restarted.login('tester', PASSWORD);
    assert.equal(await restarted.getSession(fixtureTokens[0]), null);
    for (const token of fixtureTokens.slice(1)) assert.ok(await restarted.getSession(token));
    assert.ok(await restarted.getSession(signedIn.token));
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).sessions.length, 10);
  });
});

test('invalid persisted authentication data fails closed instead of recreating accounts', async () => {
  await temporaryStore(async filePath => {
    await AuthStore.open(filePath);
    await writeFile(filePath, JSON.stringify({ version: 99, users: [], sessions: [] }));
    await assert.rejects(AuthStore.open(filePath), /unsupported or invalid format/);
    await writeFile(filePath, 'incomplete json');
    await assert.rejects(AuthStore.open(filePath), SyntaxError);
  });
});
