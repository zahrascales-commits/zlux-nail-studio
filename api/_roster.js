// Public team roster for the website's "Meet the Team" sections.
// Only members the owner has flagged show_on_site=1 (and active) appear.
const { query, ensureTables } = require('./_team-db');

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    await ensureTables();

    // One portrait on its own, so the list stays small and the phone keeps
    // the picture. A new photo has a new length, so a new address.
    if (req.query.photo) {
      const [row] = await query('SELECT photo FROM team_members WHERE id=? AND show_on_site=1 AND active=1', [Number(req.query.photo) || 0]);
      const m = row && /^data:(image\/[a-z+.-]+);base64,(.*)$/i.exec(String(row.photo || ''));
      if (!m) return res.status(404).end();
      res.setHeader('Content-Type', m[1]);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.end(Buffer.from(m[2], 'base64'));
    }

    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=30');
    const rows = await query(
      "SELECT id, name, role, title, bio, color, CASE WHEN photo LIKE 'data:%' THEN substr(photo, 1, 16) ELSE photo END AS photo, length(photo) AS photo_len, restricted FROM team_members WHERE show_on_site=1 AND active=1 ORDER BY id"
    );

    // Deliberately does not publish who does which service. Everyone will
    // be cross-trained eventually so the list dates itself, and choosing
    // your artist is a Black Card benefit rather than public information.
    const team = rows.map(r => ({
      name: r.name,
      // "title" is the owner's custom label (e.g. "Lead Artist"); fall back to role
      title: (r.title && String(r.title).trim()) || r.role || 'Nail Artist',
      bio: r.bio || '',
      color: r.color || '#B6A588',
      photo: /^data:image\//i.test(r.photo || '')
        ? '/api/roster?photo=' + r.id + '&v=' + r.photo_len
        : (r.photo || ''),
      initial: (r.name || '?').trim().charAt(0).toUpperCase(),
    }));
    return res.json({ team });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err), team: [] });
  }
};
