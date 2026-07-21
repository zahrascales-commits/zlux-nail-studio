// Public, unauthenticated: tells the booking page which upcoming date ranges
// have limited team coverage, and which services are still bookable during
// them (e.g. only one artist in, and she can't do every service yet).
const { query, ensureTables } = require('./_team-db');

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const action = req.query.action || 'windows';

  try {
    await ensureTables();

    if (action === 'windows') {
      const today = new Date().toISOString().slice(0, 10);
      const overrides = await query('SELECT * FROM schedule_overrides WHERE end_date >= ? ORDER BY start_date', [today]);
      if (!overrides.length) return res.json({ windows: [] });

      const members = await query('SELECT id, restricted FROM team_members');
      const restrictedById = {};
      for (const m of members) restrictedById[m.id] = !!Number(m.restricted);

      const skillRows = await query('SELECT team_member_id, service_name FROM worker_skills');
      const skillsById = {};
      for (const row of skillRows) {
        (skillsById[row.team_member_id] = skillsById[row.team_member_id] || []).push(row.service_name);
      }

      const windows = overrides.map(o => {
        const ids = JSON.parse(o.team_member_ids || '[]');
        let allServices = false;
        const allowed = new Set();
        for (const id of ids) {
          if (!restrictedById[id]) { allServices = true; break; }
          for (const s of (skillsById[id] || [])) allowed.add(s);
        }
        return {
          start_date: o.start_date,
          end_date: o.end_date,
          note: o.note || '',
          all_services: allServices,
          allowed_services: allServices ? [] : Array.from(allowed),
        };
      });

      return res.json({ windows });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
