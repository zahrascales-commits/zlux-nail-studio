const DB_URL = (process.env.TURSO_DATABASE_URL || '').replace('libsql://', 'https://');
const TOKEN  = process.env.TURSO_AUTH_TOKEN;

function argVal(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number' && Number.isInteger(v)) return { type: 'integer', value: String(v) };
  if (typeof v === 'number') return { type: 'float', value: String(v) };
  return { type: 'text', value: String(v) };
}

async function pipeline(requests) {
  const r = await fetch(`${DB_URL}/v2/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Turso ${r.status}: ${text}`);
  }
  const data = await r.json();
  const errs = data.results?.filter(x => x.type === 'error');
  if (errs?.length) throw new Error(errs[0].error?.message || 'SQL error');
  return data;
}

async function query(sql, args = []) {
  const data = await pipeline([{ type: 'execute', stmt: { sql, args: args.map(argVal) } }]);
  const result = data.results[0].response.result;
  const cols = result.cols.map(c => c.name);
  return result.rows.map(row => {
    const obj = {};
    cols.forEach((col, i) => {
      const cell = row[i];
      obj[col] = cell.type === 'null' ? null : cell.value;
    });
    return obj;
  });
}

async function queryOne(sql, args = []) {
  const rows = await query(sql, args);
  return rows[0] || null;
}

async function execute(sql, args = []) {
  const data = await pipeline([{ type: 'execute', stmt: { sql, args: args.map(argVal) } }]);
  const result = data.results[0].response.result;
  return {
    lastInsertRowid: result.last_insert_rowid != null ? Number(result.last_insert_rowid) : null,
    rowsAffected: result.affected_row_count ?? 0,
  };
}

module.exports = { query, queryOne, execute };
