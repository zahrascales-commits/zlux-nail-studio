const { getDb } = require('../server/db/init');

function authAdmin(db, req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  return db.prepare('SELECT * FROM sessions WHERE token = ? AND role = ? AND expires_at > datetime("now")').get(token, 'ADMIN') || null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const db = getDb();
  try {
    const session = authAdmin(db, req);
    if (!session) return res.status(401).json({ error: 'Admin login required.' });

    if (req.method === 'GET') {
      const { date, startDate, endDate, staffId } = req.query;
      let query = `
        SELECT a.*, m.full_name as client_name, m.tier, s.name as staff_name,
               mp.allergies, mp.sensitivities
        FROM appointments a
        LEFT JOIN members m ON a.member_id = m.member_id
        LEFT JOIN staff s ON a.staff_id = s.id
        LEFT JOIN member_preferences mp ON a.member_id = mp.member_id
        WHERE 1=1
      `;
      const params = [];
      if (date) { query += ' AND a.appointment_date = ?'; params.push(date); }
      if (startDate && endDate) { query += ' AND a.appointment_date BETWEEN ? AND ?'; params.push(startDate, endDate); }
      if (staffId) { query += ' AND a.staff_id = ?'; params.push(parseInt(staffId)); }
      query += ' ORDER BY a.appointment_date ASC, a.appointment_time ASC';

      const appointments = db.prepare(query).all(...params);
      const staff = db.prepare('SELECT id, name, email FROM staff WHERE active=1').all();
      const config = db.prepare('SELECT * FROM schedule_config WHERE id=1').get();
      const blocks = db.prepare('SELECT * FROM availability_blocks WHERE block_date >= date("now") ORDER BY block_date ASC').all();

      return res.status(200).json({ appointments, staff, config, blocks });
    }

    if (req.method === 'POST') {
      const { action } = req.body;

      if (action === 'update_config') {
        const { blackCardDays, luxeDays, signatureDays, publicDays, openTime, closeTime } = req.body;
        db.prepare('UPDATE schedule_config SET black_card_days_ahead=?, luxe_days_ahead=?, signature_days_ahead=?, public_days_ahead=?, studio_open_time=?, studio_close_time=?, updated_at=datetime("now") WHERE id=1')
          .run(blackCardDays||20, luxeDays||13, signatureDays||3, publicDays||0, openTime||'06:00', closeTime||'22:00');
        return res.status(200).json({ success: true });
      }

      if (action === 'block') {
        const { blockDate, startTime, endTime, staffId, reason } = req.body;
        db.prepare('INSERT INTO availability_blocks (staff_id, block_date, start_time, end_time, reason) VALUES (?,?,?,?,?)').run(staffId||null, blockDate, startTime||null, endTime||null, reason||null);
        return res.status(201).json({ success: true });
      }

      if (action === 'cancel_appt') {
        const { apptId, reason } = req.body;
        db.prepare(`UPDATE appointments SET status='CANCELLED', cancelled_at=datetime('now'), cancel_reason=? WHERE id=?`).run(reason||null, apptId);
        return res.status(200).json({ success: true });
      }

      if (action === 'reassign') {
        const { apptId, staffId } = req.body;
        db.prepare('UPDATE appointments SET staff_id=? WHERE id=?').run(staffId, apptId);
        return res.status(200).json({ success: true });
      }

      if (action === 'complete') {
        const { apptId } = req.body;
        db.prepare(`UPDATE appointments SET status='COMPLETED', completed_at=datetime('now') WHERE id=?`).run(apptId);
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: 'Unknown action.' });
    }

    if (req.method === 'DELETE') {
      const { blockId } = req.query;
      if (!blockId) return res.status(400).json({ error: 'blockId required.' });
      db.prepare('DELETE FROM availability_blocks WHERE id=?').run(parseInt(blockId));
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } finally {
    db.close();
  }
};
