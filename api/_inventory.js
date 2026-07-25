// Shared inventory: the owner (CEO password) and any active team member
// (team id + PIN) can view and update stock levels. Owner adds/removes items
// and sets low-stock thresholds; anyone can adjust quantities as supplies
// run down, so ordering happens before things run out.
const { query, queryOne, execute, ensureTables } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

async function whoIs(req) {
  if (req.headers['x-ceo-password'] === CEO_PASSWORD) return { role: 'owner', name: 'Zahra' };
  const id = Number(req.headers['x-team-id'] || req.query.member_id);
  const pin = String(req.headers['x-team-pin'] || req.query.pin || '');
  if (id && pin) {
    const m = await queryOne('SELECT id, name FROM team_members WHERE id=? AND pin=? AND active=1', [id, pin]);
    if (m) return { role: 'worker', name: m.name, id: m.id };
  }
  return null;
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CEO-Password, X-Team-Id, X-Team-Pin');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await ensureTables();
    const who = await whoIs(req);
    if (!who) return res.status(401).json({ error: 'Not authorized' });
    const action = req.query.action || (req.body && req.body.action) || '';

    // ── LIST (owner or worker) ──
    if (req.method === 'GET' && (!action || action === 'list')) {
      const items = await query('SELECT * FROM inventory ORDER BY (qty <= low_threshold) DESC, name');
      const low = items.filter(i => Number(i.qty) <= Number(i.low_threshold));
      return res.json({ items, low_count: low.length, role: who.role });
    }

    // ── ADD (owner only) ──
    if (req.method === 'POST' && action === 'add') {
      if (who.role !== 'owner') return res.status(403).json({ error: 'Only the owner can add items' });
      const { name, qty, unit, low_threshold } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Name required' });
      const r = await execute(
        'INSERT INTO inventory (name, qty, unit, low_threshold, updated_by, updated_ts, created_ts) VALUES (?,?,?,?,?,?,?)',
        [name, Math.max(0, Number(qty) || 0), unit || '', Math.max(0, Number(low_threshold) || 2), who.name, Date.now(), Date.now()]);
      return res.json({ ok: true, id: r.lastInsertRowid });
    }

    // ── UPDATE quantity / fields (owner or worker) ──
    if (req.method === 'PUT' && (action === 'update' || action === 'adjust')) {
      const b = req.body || {};
      const id = Number(b.id);
      if (!id) return res.status(400).json({ error: 'id required' });
      const cur = await queryOne('SELECT * FROM inventory WHERE id=?', [id]);
      if (!cur) return res.status(404).json({ error: 'Item not found' });
      let qty = cur.qty;
      if (action === 'adjust') qty = Math.max(0, Number(cur.qty) + Number(b.delta || 0));
      else if (b.qty !== undefined) qty = Math.max(0, Number(b.qty));
      // owner may also rename / retag / rethreshold
      const name = (who.role === 'owner' && b.name !== undefined) ? b.name : cur.name;
      const unit = (who.role === 'owner' && b.unit !== undefined) ? b.unit : cur.unit;
      const low = (who.role === 'owner' && b.low_threshold !== undefined) ? Math.max(0, Number(b.low_threshold)) : cur.low_threshold;
      await execute('UPDATE inventory SET name=?, qty=?, unit=?, low_threshold=?, updated_by=?, updated_ts=? WHERE id=?',
        [name, qty, unit, low, who.name, Date.now(), id]);
      return res.json({ ok: true, qty });
    }

    // ── DELETE (owner only) ──
    if (req.method === 'DELETE') {
      if (who.role !== 'owner') return res.status(403).json({ error: 'Only the owner can remove items' });
      await execute('DELETE FROM inventory WHERE id=?', [Number((req.body || {}).id)]);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
