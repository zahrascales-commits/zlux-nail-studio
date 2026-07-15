// In-app notifications feed — the bell in the Studio Manager (owner)
// and Team Portal (members). Works with no external providers.
const { query, queryOne, execute, ensureTables } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await ensureTables();

    // Resolve caller: owner via password, member via id+pin
    const isOwner = req.headers['x-ceo-password'] === CEO_PASSWORD;
    let member = null;
    if (!isOwner) {
      const id = Number(req.headers['x-team-id'] || req.query.member_id);
      const pin = String(req.headers['x-team-pin'] || req.query.pin || '');
      if (id && pin) member = await queryOne('SELECT id FROM team_members WHERE id=? AND pin=? AND active=1', [id, pin]);
      if (!member) return res.status(401).json({ error: 'Unauthorized' });
    }

    if (req.method === 'GET') {
      const rows = isOwner
        ? await query("SELECT * FROM notifications WHERE recipient='owner' ORDER BY ts DESC LIMIT 50")
        : await query("SELECT * FROM notifications WHERE recipient='member' AND member_id=? ORDER BY ts DESC LIMIT 50", [member.id]);
      const unread = rows.filter(n => Number(n.read) === 0).length;
      return res.json({ notifications: rows, unread });
    }

    if (req.method === 'PUT') {
      // mark all read for this caller
      if (isOwner) await execute("UPDATE notifications SET read=1 WHERE recipient='owner'");
      else await execute("UPDATE notifications SET read=1 WHERE recipient='member' AND member_id=?", [member.id]);
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
