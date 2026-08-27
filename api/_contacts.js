// Who we cannot reach, and how to fix that.
//
// Two halves of one problem. The first is a list for Zahra: every client in
// the book with no email, no phone, or neither — ranked by how much they are
// worth, because chasing the woman who comes twelve times a year matters
// more than chasing the one who came once in 2024.
//
// The second is the asking. A list she has to work through by hand is a
// list that stays undone, so the site collects the missing detail itself:
// when a member opens their account, and when anybody checks in at the
// studio. Those are the two moments the person is already there.
const { query, queryOne, execute, ensureTables } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

const norm = e => String(e || '').trim().toLowerCase();
const digits = p => String(p || '').replace(/\D/g, '');
const validEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(norm(e));
// Ten digits, or eleven starting with a 1. Anything shorter is a typo, not
// a number, and storing it means a failed send later with no explanation.
const validPhone = p => { const d = digits(p); return d.length === 10 || (d.length === 11 && d[0] === '1'); };

function daysSince(ds) {
  const d = new Date(String(ds || '').slice(0, 10) + 'T12:00:00');
  if (isNaN(d)) return null;
  return Math.round((Date.now() - d.getTime()) / 86400000);
}

// Everybody in the book, with what is missing from each.
async function gaps() {
  let clients = [];
  try {
    clients = await query(
      `SELECT id, name, email, phone, total_appointments, visits, deposits_cents,
              last_appointment, last_visit, most_common_service, marketing_opt_in
         FROM clients`);
  } catch (_) {}

  // Members always have an email — they signed up with one — so anything
  // matching a member is reachable even when the client row looks empty.
  let members = [];
  try {
    const main = require('./_db');
    members = await main.query('SELECT full_name AS name, email, phone, tier FROM members');
  } catch (_) {}
  const byName = {}, byEmail = {};
  for (const m of members) {
    if (m.name) byName[String(m.name).trim().toLowerCase()] = m;
    if (m.email) byEmail[norm(m.email)] = m;
  }

  const out = [];
  for (const c of clients) {
    const m = byName[String(c.name || '').trim().toLowerCase()] || byEmail[norm(c.email)] || null;
    const email = validEmail(c.email) ? c.email : (m && validEmail(m.email) ? m.email : '');
    const phone = validPhone(c.phone) ? c.phone : (m && validPhone(m.phone) ? m.phone : '');
    if (email && phone) continue;

    const visits = Math.max(Number(c.total_appointments) || 0, Number(c.visits) || 0);
    const last = String(c.last_appointment || c.last_visit || '').slice(0, 10);
    out.push({
      id: Number(c.id),
      name: c.name || '(no name)',
      email, phone,
      missing: !email && !phone ? 'both' : (!email ? 'email' : 'phone'),
      is_member: !!m,
      tier: m ? m.tier : '',
      visits,
      spent_cents: Number(c.deposits_cents) || 0,
      last_visit: last,
      days_since: daysSince(last),
      usual_service: c.most_common_service || '',
    });
  }

  // Worth chasing first: the people who come most, then most recently.
  out.sort((a, b) => (b.visits - a.visits) || String(b.last_visit).localeCompare(String(a.last_visit)));
  return out;
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action || (req.body && req.body.action) || '';

  try {
    await ensureTables();

    // ── PUBLIC: does this person still owe us a way of reaching them? ──
    //
    // Asked by the client portal and by the check-in screen. Answers only
    // what is missing — never what is already on file — so this can be
    // called with a name at a kiosk without handing anybody's details back.
    if (req.method === 'GET' && action === 'check') {
      const name = String(req.query.name || '').trim();
      const memberId = String(req.query.member_id || '').trim();
      let c = null, m = null;

      if (memberId) {
        try {
          const main = require('./_db');
          m = await main.queryOne(
            'SELECT member_id, full_name, email, phone FROM members WHERE member_id=?', [memberId]);
        } catch (_) {}
      }
      const lookFor = (m && m.full_name) || name;
      if (lookFor) {
        c = await queryOne('SELECT id, name, email, phone FROM clients WHERE lower(name)=lower(?)', [lookFor])
          .catch(() => null);
      }
      if (!c && !m) return res.json({ known: false, need_email: false, need_phone: false });

      const email = (m && validEmail(m.email)) ? m.email : (c && validEmail(c.email) ? c.email : '');
      const phone = (m && validPhone(m.phone)) ? m.phone : (c && validPhone(c.phone) ? c.phone : '');
      return res.json({
        known: true,
        first_name: String((m && m.full_name) || (c && c.name) || '').trim().split(/\s+/)[0] || '',
        client_id: c ? Number(c.id) : 0,
        need_email: !email,
        need_phone: !phone,
      });
    }

    // ── PUBLIC: they just told us ──
    //
    // Writes to whichever records match. Deliberately additive: it fills a
    // blank, and never overwrites a detail already on file — somebody
    // mistyping at a kiosk must not be able to wipe a good number.
    if (req.method === 'POST' && action === 'save') {
      const name = String((req.body || {}).name || '').trim();
      const memberId = String((req.body || {}).member_id || '').trim();
      const clientId = Number((req.body || {}).client_id) || 0;
      const email = norm((req.body || {}).email);
      const phone = String((req.body || {}).phone || '').trim();
      const optIn = (req.body || {}).marketing_opt_in ? 1 : 0;

      if (email && !validEmail(email)) return res.status(400).json({ error: "That email doesn't look right." });
      if (phone && !validPhone(phone)) return res.status(400).json({ error: "That number doesn't look like a US mobile." });
      if (!email && !phone) return res.status(400).json({ error: 'Nothing to save.' });

      let saved = false;

      if (memberId) {
        try {
          const main = require('./_db');
          if (email) await main.execute(
            "UPDATE members SET email=? WHERE member_id=? AND (email IS NULL OR email='')", [email, memberId]);
          if (phone) await main.execute(
            "UPDATE members SET phone=? WHERE member_id=? AND (phone IS NULL OR phone='')", [phone, memberId]);
          saved = true;
        } catch (_) {}
      }

      try {
        let target = clientId;
        if (!target && name) {
          const row = await queryOne('SELECT id FROM clients WHERE lower(name)=lower(?)', [name]);
          target = row ? Number(row.id) : 0;
        }
        if (target) {
          if (email) await execute(
            "UPDATE clients SET email=? WHERE id=? AND (email IS NULL OR email='')", [email, target]);
          if (phone) await execute(
            "UPDATE clients SET phone=? WHERE id=? AND (phone IS NULL OR phone='')", [phone, target]);
          if (optIn) await execute('UPDATE clients SET marketing_opt_in=1 WHERE id=?', [target]);
          saved = true;
        } else if (name && email) {
          // Somebody the book has never seen. Better a new row than a lost
          // address.
          await execute(
            'INSERT INTO clients (name, email, phone, marketing_opt_in, created_ts) VALUES (?,?,?,?,?)',
            [name, email, phone || '', optIn, Date.now()]);
          saved = true;
        }
      } catch (_) {}

      // Somebody who just handed over an address has un-said any earlier
      // "leave me alone", but only if they ticked the box as well.
      if (saved && email && optIn) {
        try { await execute('DELETE FROM email_optout WHERE email=?', [email]); } catch (_) {}
      }

      if (!saved) return res.status(400).json({ error: 'Could not match that to anyone.' });
      return res.json({ ok: true });
    }

    // ── OWNER ──
    if (req.headers['x-ceo-password'] !== CEO_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (req.method === 'GET' && (action === 'gaps' || !action)) {
      const list = await gaps();
      let total = 0;
      try { const r = await queryOne('SELECT COUNT(*) AS n FROM clients'); total = Number(r.n) || 0; } catch (_) {}
      return res.json({
        clients: list,
        total_clients: total,
        counts: {
          missing_email: list.filter(c => !c.email).length,
          missing_phone: list.filter(c => !c.phone).length,
          missing_both: list.filter(c => c.missing === 'both').length,
          reachable: Math.max(0, total - list.filter(c => !c.email).length),
        },
      });
    }

    // Filling one in by hand, from the list. The owner is allowed to
    // overwrite — she is looking at the person's card while she types.
    if (req.method === 'POST' && action === 'set') {
      const { id, email, phone } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Which client?' });
      if (email && !validEmail(email)) return res.status(400).json({ error: "That email doesn't look right." });
      if (phone && !validPhone(phone)) return res.status(400).json({ error: "That number doesn't look right." });
      if (email !== undefined) await execute('UPDATE clients SET email=? WHERE id=?', [norm(email), Number(id)]);
      if (phone !== undefined) await execute('UPDATE clients SET phone=? WHERE id=?', [String(phone).trim(), Number(id)]);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};

module.exports.gaps = gaps;
