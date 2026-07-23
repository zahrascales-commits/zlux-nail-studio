// Public team roster for the website's "Meet the Team" sections.
// Only members the owner has flagged show_on_site=1 (and active) appear.
const { query, ensureTables } = require('./_team-db');

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=30');
  try {
    await ensureTables();
    const rows = await query(
      "SELECT name, role, title, bio, color FROM team_members WHERE show_on_site=1 AND active=1 ORDER BY id"
    );
    const team = rows.map(r => ({
      name: r.name,
      // "title" is the owner's custom label (e.g. "Lead Artist"); fall back to role
      title: (r.title && String(r.title).trim()) || r.role || 'Nail Artist',
      bio: r.bio || '',
      color: r.color || '#B6A588',
      initial: (r.name || '?').trim().charAt(0).toUpperCase(),
    }));
    return res.json({ team });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err), team: [] });
  }
};
