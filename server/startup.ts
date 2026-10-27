import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Protected modes always use a separate data set. Inspect before migrations so
 * switching a demo environment to pilot cannot adopt known shared accounts. */
export function assertProtectedDataPaths(databasePath: string, accountsPath: string) {
  const reject = () => {
    throw Object.assign(new Error('Protected startup requires a separate pilot data directory without demo accounts or practices.'), { code: 'CEVRALI_DEMO_DATA' });
  };
  const inspect = (path: string, table: string, query: string) => {
    if (!existsSync(path)) return;
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) && db.prepare(query).get()) reject();
    } finally { db.close(); }
  };
  // The protected root database is only a schema anchor. Actual staff and
  // patient records belong to isolated practice databases, never this file.
  inspect(databasePath, 'users', 'SELECT id FROM users LIMIT 1');
  inspect(databasePath, 'patients', 'SELECT id FROM patients LIMIT 1');
  inspect(join(accountsPath, 'accounts.sqlite'), 'practices', "SELECT id FROM practices WHERE id='demo-practice' OR json_extract(document,'$.is_demo')=1 LIMIT 1");
}
