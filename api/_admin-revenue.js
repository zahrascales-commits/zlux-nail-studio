const { queryOne, query } = require('./_db');

async function authAdmin(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  return queryOne('SELECT * FROM sessions WHERE token = ? AND role = ? AND expires_at > CURRENT_TIMESTAMP', [token, 'ADMIN']);
}

const TIER_PRICE = { SIGNATURE: 99, LUXE: 199, BLACK_CARD: 299 };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const session = await authAdmin(req);
    if (!session) return res.status(401).json({ error: 'Admin login required.' });

    const tierCounts = await query('SELECT tier, COUNT(*) as count FROM members GROUP BY tier', []);
    const tierMap = {};
    let mrr = 0;
    tierCounts.forEach(r => {
      tierMap[r.tier] = r.count;
      mrr += (TIER_PRICE[r.tier] || 0) * r.count;
    });

    const totalMembersRow   = await queryOne('SELECT COUNT(*) as n FROM members', []);
    const flaggedMembersRow  = await queryOne('SELECT COUNT(*) as n FROM members WHERE flagged=1', []);
    const waitlistCountRow   = await queryOne('SELECT COUNT(*) as n FROM waitlist WHERE invited=0', []);

    const thisMonth = new Date().toISOString().slice(0, 7);
    const apptThisMonthRow  = await queryOne(`SELECT COUNT(*) as n FROM appointments WHERE appointment_date LIKE ? AND status != 'CANCELLED'`, [thisMonth + '%']);
    const noShowsMonthRow   = await queryOne('SELECT COUNT(*) as n FROM no_shows WHERE date LIKE ?', [thisMonth + '%']);

    const recentMembers = await query('SELECT member_id, full_name, tier, created_at FROM members ORDER BY created_at DESC LIMIT 10', []);

    const upcoming = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      const ds = d.toISOString().slice(0, 10);
      const row = await queryOne(`SELECT COUNT(*) as n FROM appointments WHERE appointment_date = ? AND status = 'SCHEDULED'`, [ds]);
      upcoming.push({ date: ds, count: row ? row.n : 0 });
    }

    const failedLoginsRow    = await queryOne(`SELECT COUNT(*) as n FROM security_log WHERE event LIKE 'FAILED%' AND created_at > datetime('now', '-1 day')`, []);
    const lowStock           = await query('SELECT * FROM inventory WHERE quantity <= low_stock_threshold ORDER BY quantity ASC', []);
    const referralsCompletedRow = await queryOne(`SELECT COUNT(*) as n FROM referrals WHERE status='COMPLETED'`, []);

    return res.status(200).json({
      mrr,
      totalMembers:       totalMembersRow.n,
      tierMap,
      flaggedMembers:     flaggedMembersRow.n,
      waitlistCount:      waitlistCountRow.n,
      apptThisMonth:      apptThisMonthRow.n,
      noShowsThisMonth:   noShowsMonthRow.n,
      recentMembers,
      upcoming,
      failedLogins:       failedLoginsRow.n,
      lowStock,
      referralsCompleted: referralsCompletedRow.n,
    });
  } catch (err) {
    console.error('Admin revenue error:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
};
