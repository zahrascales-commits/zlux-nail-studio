const { queryOne, queryOne: getSession } = require('./_db');
const store = require('./_store');

async function getSessionFromReq(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  return queryOne('SELECT * FROM sessions WHERE token = ? AND expires_at > datetime("now")', [token]);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Load config with safe defaults if Turso table isn't seeded yet
    let config = { black_card_days_ahead: 20, luxe_days_ahead: 13, signature_days_ahead: 3, public_days_ahead: 0, studio_open_time: '08:00', studio_close_time: '22:00' };
    try {
      const dbConfig = await queryOne('SELECT * FROM schedule_config WHERE id = 1', []);
      if (dbConfig) config = dbConfig;
    } catch (_) {}

    const session = await getSessionFromReq(req);

    let tier = 'PUBLIC';
    let daysAhead = config.public_days_ahead;

    if (session) {
      if (session.role === 'CLIENT') {
        const member = await queryOne('SELECT tier FROM members WHERE member_id = ?', [session.user_id]);
        if (member) {
          tier = member.tier;
          daysAhead = { SIGNATURE: config.signature_days_ahead, LUXE: config.luxe_days_ahead, BLACK_CARD: config.black_card_days_ahead }[tier] ?? config.public_days_ahead;
        }
      } else if (session.role === 'ADMIN') {
        tier = 'ADMIN';
        daysAhead = 90;
      }
    }

    const availableDates = [];
    const now = new Date();
    const openDate = new Date(now);
    openDate.setDate(openDate.getDate() + daysAhead);

    for (let i = 0; i < 60; i++) {
      const d = new Date(openDate);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().slice(0, 10);

      // Check DB availability_blocks (admin-set)
      const dbBlocked = await queryOne('SELECT COUNT(*) as n FROM availability_blocks WHERE block_date = ? AND start_time IS NULL', [dateStr]).catch(() => ({ n: 0 }));
      if (dbBlocked && Number(dbBlocked.n) > 0) continue;

      // Check CEO in-memory calendar blocks
      const ceoBlocked = store.calendarBlocks.some(b => b.date === dateStr && b.slot === 'ALL');
      if (ceoBlocked) continue;

      availableDates.push(dateStr);
    }

    let countdownMs = 0;
    if (tier !== 'PUBLIC' && tier !== 'ADMIN') {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowBookableAt = new Date(tomorrow);
      tomorrowBookableAt.setDate(tomorrowBookableAt.getDate() - daysAhead);
      countdownMs = Math.max(0, tomorrowBookableAt - now);
    }

    const slots = [
      '06:00','07:00','08:00','09:00','10:00','11:00','12:00',
      '13:00','14:00','15:00','16:00','17:00','18:00','19:00','20:00','21:00','22:00'
    ].filter(t => t >= config.studio_open_time && t <= config.studio_close_time);

    return res.status(200).json({
      tier,
      daysAhead,
      availableDates: availableDates.slice(0, 45),
      slots,
      countdownMs,
      windowOpensAt: openDate.toISOString(),
      config: { openTime: config.studio_open_time, closeTime: config.studio_close_time }
    });
  } catch (err) {
    console.error('Booking windows error:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
};
