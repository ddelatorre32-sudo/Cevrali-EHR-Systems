#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const options = {};
let valid = args.length === 4;
for (let i = 0; i < args.length; i += 2) {
  const name = args[i];
  if (!['--profile-file', '--password-file'].includes(name) || options[name] || !args[i + 1]) { valid = false; break; }
  options[name] = args[i + 1];
}
if (!valid || !options['--profile-file'] || !options['--password-file']) {
  process.stderr.write('Usage: node scripts/bootstrap-practice.mjs --profile-file /private/practice.json --password-file /private/initial-password\n');
  process.exitCode = 1;
} else if (!existsSync(resolve('dist-server/bootstrap.js'))) {
  process.stderr.write('Build the server with npm run build before provisioning a pilot practice.\n');
  process.exitCode = 1;
} else {
  try {
    const { loadRuntimeConfig } = await import(pathToFileURL(resolve('dist-server/runtime-config.js')).href);
    const { bootstrapPilotPractice } = await import(pathToFileURL(resolve('dist-server/bootstrap.js')).href);
    const result = bootstrapPilotPractice(loadRuntimeConfig(), { profileFile: resolve(options['--profile-file']), passwordFile: resolve(options['--password-file']) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\nPractice provisioned without a session. The owner must enroll an authenticator at first sign-in. Synthetic patients only.\n`);
  } catch {
    // Never copy arbitrary JSON, identity values, passwords, or filesystem paths
    // from lower-level errors into logs.
    process.stderr.write('Pilot provisioning failed. Check pilot readiness, private input permissions and format, duplicate membership, and service locks. No sign-in session was created.\n');
    process.exitCode = 1;
  }
}
