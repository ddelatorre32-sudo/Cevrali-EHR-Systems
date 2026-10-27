#!/bin/sh
set -eu

# Keep every practice database and SQLite WAL file on the mounted data disk.
# Custom locations are supported only within this image's data mount.
DATABASE_PATH="${DATABASE_PATH:-/var/lib/cevrali/cevrali.sqlite}"
ACCOUNTS_PATH="${ACCOUNTS_PATH:-/var/lib/cevrali/accounts}"
export DATABASE_PATH ACCOUNTS_PATH

if [ "${CEVRALI_MODE:-demo}" != "demo" ]; then
  umask 077
fi

node --input-type=module -e '
import { resolve, sep } from "node:path";
const root = resolve("/var/lib/cevrali") + sep;
for (const name of ["DATABASE_PATH", "ACCOUNTS_PATH"]) {
  if (!resolve(process.env[name]).startsWith(root)) {
    console.error(`${name} must point inside the /var/lib/cevrali data mount.`);
    process.exit(1);
  }
}
'

mkdir -p /var/lib/cevrali "$(dirname "$DATABASE_PATH")" "$ACCOUNTS_PATH"

if [ "$(id -u)" = "0" ]; then
  # Hosted disks can be root-owned on their first mount. Node itself never needs
  # root access; existing records are retained while correcting disk ownership.
  chown -R node:node /var/lib/cevrali
  exec gosu node:node "$@"
fi

if [ ! -w /var/lib/cevrali ] || [ ! -w "$ACCOUNTS_PATH" ]; then
  echo "The Cevrali data mount must be writable by the container user." >&2
  exit 1
fi
exec "$@"
