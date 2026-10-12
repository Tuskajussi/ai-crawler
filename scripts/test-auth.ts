import type { Page } from 'playwright';
import type { createApp } from '../server/index';

export const testRegistrationSecret = 'ui-test-registration-secret-long-enough';
export const testPassword = 'Smoke-test-password-123!';

/** Seed a private workspace. The browser still signs in through the actual form. */
export async function createTestAccount(runtime: Awaited<ReturnType<typeof createApp>>, username: string) {
  const session = await runtime.auth.register(username, testPassword, runtime.config.registrationSecret);
  const workspace = await runtime.workspaces.get(session.user.id);
  return { user: session.user, workspace, username, password: testPassword };
}

export async function signInPage(page: Page, account: { username: string; password: string }) {
  await page.getByRole('heading', { name: 'Welcome to your workspace.', exact: true }).waitFor();
  await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByText('Local runner ready', { exact: true }).waitFor();
}
