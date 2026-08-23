// Public team roster for the website's "Meet the Team" sections.
// Only members the owner has flagged show_on_site=1 (and active) appear.
const { query, ensureTables } = require('./_team-db');

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=30');
  try {
    await ensureTables();
    const rows = await query(
      "SELECT id, name, role, title, bio, color, photo, restricted FROM team_members WHERE show_on_site=1 AND active=1 ORDER BY id"
    );

    // What each artist actually does. A card with no bio written yet still
    // has something true to say, and "who should I book for acrylics" is the
    // question this section exists to answer.
    const skills = {};
    try {
      for (const s of await query('SELECT team_member_id, service_name FROM worker_skills')) {
        (skills[s.team_member_id] = skills[s.team_member_id] || []).push(s.service_name);
      }
    } catch (_) {}

    // Lengths are not specialities — "Short Gel X, Medium Gel X, Long Gel X"
    // reads as padding where "Gel X" reads as a skill.
    const baseName = (s) => String(s)
      .replace(/^(Extra Long|X-Long|XL|Short|Medium|Long)\s+/i, '')
      .replace(/\s+Set$/i, '')
      .trim();

    const team = rows.map(r => ({
      does: Number(r.restricted)
        ? [...new Set((skills[r.id] || []).map(baseName))].slice(0, 4)
        : [],
      name: r.name,
      // "title" is the owner's custom label (e.g. "Lead Artist"); fall back to role
      title: (r.title && String(r.title).trim()) || r.role || 'Nail Artist',
      bio: r.bio || '',
      color: r.color || '#B6A588',
      photo: r.photo || '',
      initial: (r.name || '?').trim().charAt(0).toUpperCase(),
    }));
    return res.json({ team });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err), team: [] });
  }
};
