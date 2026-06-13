const { getDb } = require('../server/db/init');

function authAdmin(db, req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  return db.prepare('SELECT * FROM sessions WHERE token = ? AND role = ? AND expires_at > datetime("now")').get(token, 'ADMIN') || null;
}

const TIER_PRICE = { SIGNATURE: 99, LUXE: 199, BLACK_CARD: 299 };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const db = getDb();
  try {
    const session = authAdmin(db, req);
    if (!session) return res.status(401).json({ error: 'Admin login required.' });

    // Member counts by tier
    const tierCounts = db.prepare('SELECT tier, COUNT(*) as count FROM members GROUP BY tier').all();
    const tierMap = {};
    let mrr = 0;
    tierCounts.forEach(r => {
      tierMap[r.tier] = r.count;
      mrr += (TIER_PRICE[r.tier] || 0) * r.count;
    });

    const totalMembers = db.prepare('SELECT COUNT(*) as n FROM members').get().n;
    const flaggedMembers = db.prepare('SELECT COUNT(*) as n FROM members WHERE flagged=1').get().n;
    const waitlistCount = db.prepare('SELECT COUNT(*) as n FROM waitlist WHERE invited=0').get().n;

    // This month appointments
    const thisMonth = new Date().toISOString().slice(0, 7);
    const apptThisMonth = db.prepare(`SELECT COUNT(*) as n FROM appointments WHERE appointment_date LIKE ? AND status != 'CANCELLED'`).get(thisMonth + '%').n;
    const noShowsThisMonth = db.prepare(`SELECT COUNT(*) as n FROM no_shows WHERE date LIKE ?`).get(thisMonth + '%').n;

    // Recent 10 sign-ups
    const recentMembers = db.prepare('SELECT member_id, full_name, tier, created_at FROM members ORDER BY created_at DESC LIMIT 10').all();

    // Next 7 days appointments by day
    const upcoming = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      const ds = d.toISOString().slice(0, 10);
      const n = db.prepare(`SELECT COUNT(*) as n FROM appointments WHERE appointment_date = ? AND status = 'SCHEDULED'`).get(ds).n;
      upcoming.push({ date: ds, count: n });
    }

    // Security log — failed logins last 24h
    const failedLogins = db.prepare(`SELECT COUNT(*) as n FROM security_log WHERE event LIKE 'FAILED%' AND created_at > datetime('now', '-1 day')`).get().n;

    // Inventory low-stock alerts
    const lowStock = db.prepare('SELECT * FROM inventory WHERE quantity <= low_stock_threshold ORDER BY quantity ASC').all();

    // Referrals
    const referralsCompleted = db.prepare(`SELECT COUNT(*) as n FROM referrals WHERE status='COMPLETED'`).get().n;

    return res.status(200).json({
      mrr,
      totalMembers,
      tierMap,
      flaggedMembers,
      waitlistCount,
      apptThisMonth,
      noShowsThisMonth,
      recentMembers,
      upcoming,
      failedLogins,
      lowStock,
      referralsCompleted,
    });
  } finally {
    db.close();
  }
};
