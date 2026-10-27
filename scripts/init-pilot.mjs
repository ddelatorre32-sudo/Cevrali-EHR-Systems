#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--directory') {
  process.stderr.write('Usage: node scripts/init-pilot.mjs --directory /absolute/new-private-key-directory\n');
  process.exitCode = 1;
} else {
  const directory = resolve(args[1]);
  let created = false;
  try {
    // Require an existing parent and reject links throughout the path. New key
    // directories must never overwrite a prior enrollment or backup key.
    const parent = dirname(directory), root = parse(parent).root;
    let current = root;
    for (const part of parent.slice(root.length).split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    }
    mkdirSync(directory, { mode: 0o700 }); created = true;
    chmodSync(directory, 0o700);
    for (const name of ['authentication.key', 'backup.key']) {
      const fd = openSync(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const key = randomBytes(32);
      try {
        if (!fstatSync(fd).isFile()) throw new Error();
        writeFileSync(fd, `${key.toString('base64')}\n`); fsyncSync(fd);
      } finally { key.fill(0); closeSync(fd); }
    }
    process.stdout.write(`Created private key files:\n${join(directory, 'authentication.key')}\n${join(directory, 'backup.key')}\nStore separate protected copies of both keys; never commit them to Git.\n`);
  } catch {
    if (created) rmSync(directory, { recursive: true, force: true });
    process.stderr.write('Key initialization failed. Choose a new directory beneath an existing writable directory without symbolic links. Existing key directories are never replaced.\n');
    process.exitCode = 1;
  }
}
