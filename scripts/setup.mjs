import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const envPath = path.resolve('.env');
try {
  await writeFile(envPath, `# Local development. Keep private; do not commit.\nCRAWLSPACE_REGISTRATION_SECRET=${randomBytes(32).toString('hex')}\n`, {encoding:'utf8',flag:'wx',mode:0o600});
  console.log(`Created ${envPath}. Use its CRAWLSPACE_REGISTRATION_SECRET value in the Create account form. The secret is not printed or sent to the browser.`);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log(`${envPath} already exists and was preserved. Set CRAWLSPACE_REGISTRATION_SECRET to enable registration.`);
}