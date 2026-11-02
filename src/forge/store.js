// Key-value storage over Forge KVS (@forge/kvs, scope storage:app).
// Keys follow /^[a-zA-Z0-9:._\s-#]+$/ and stay under 500 characters.

import { kvs, WhereConditions } from '@forge/kvs';

export const forgeStore = {
  get: (key) => kvs.get(key),
  set: (key, value) => kvs.set(key, value),
  delete: (key) => kvs.delete(key),
  /** All entries whose key starts with prefix, in key order, up to max. */
  async list(prefix, max = 500) {
    const out = [];
    let cursor;
    do {
      let q = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(20);
      if (cursor) q = q.cursor(cursor);
      const page = await q.getMany();
      out.push(...page.results);
      cursor = page.nextCursor;
    } while (cursor && out.length < max);
    return out.slice(0, max);
  },
};
