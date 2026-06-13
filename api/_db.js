const { createClient } = require('@libsql/client');

let _client;
function getClient() {
  if (!_client) {
    _client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return _client;
}

function toPlain(columns, row) {
  const obj = {};
  columns.forEach((col, i) => { obj[col] = row[i]; });
  return obj;
}

async function query(sql, args = []) {
  const r = await getClient().execute({ sql, args });
  return r.rows.map(row => toPlain(r.columns, row));
}

async function queryOne(sql, args = []) {
  const r = await getClient().execute({ sql, args });
  return r.rows[0] ? toPlain(r.columns, r.rows[0]) : null;
}

async function execute(sql, args = []) {
  const r = await getClient().execute({ sql, args });
  return {
    lastInsertRowid: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : null,
    rowsAffected: r.rowsAffected,
  };
}

module.exports = { query, queryOne, execute };
