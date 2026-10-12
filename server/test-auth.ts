import type { createApp } from './index';

export const fixtureRegistrationSecret = 'fixture-registration-secret-with-at-least-32-characters';
export const fixturePassword = 'a long isolated backend fixture password';

/** Internal test seeding only. HTTP requests still authenticate with a real session and CSRF. */
export async function authenticatedFixture(runtime: Awaited<ReturnType<typeof createApp>>, username = 'fixture-user') {
  const session = await runtime.auth.register(username, fixturePassword, runtime.config.registrationSecret);
  const workspace = await runtime.workspaces.get(session.user.id);
  const authHeaders = { Cookie: `crawlspace_session=${session.token}`, 'X-CSRF-Token': session.csrfToken };
  return { ...runtime, ...workspace, session, authHeaders };
}
