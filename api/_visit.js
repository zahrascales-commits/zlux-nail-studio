// One link per appointment: pay the deposit, send your inspiration photos.
//
// When Zahra books somebody herself there was no way for them to pay a
// deposit and no way for them to send a reference picture — both only
// existed inside the public booking flow. So an appointment she took by
// hand arrived with no money down and nothing to work from.
//
// The link is the appointment's own token, which already existed for the
// chat thread. Unguessable, no login, and it works on a phone in the two
// seconds somebody actually has.
const { query, queryOne, execute, ensureTables } = require('./_team-db');

const MAX_DATA_URL = 3000000;

async function ensureColumns() {
  await ensureTables();
  for (const sql of [
    // What was quoted and what has been paid, on the appointment itself.
    'ALTER TABLE team_appointments ADD COLUMN deposit_cents INTEGER DEFAULT 0',
    'ALTER TABLE team_appointments ADD COLUMN deposit_paid INTEGER DEFAULT 0',
    'ALTER TABLE team_appointments ADD COLUMN client_email TEXT DEFAULT \'\'',
    // When the confirmation with these links was last sent, so the backfill
    // can find everybody who never got one and nobody gets it twice.
    'ALTER TABLE team_appointments ADD COLUMN confirm_sent_ts INTEGER DEFAULT 0',
  ]) { try { await execute(sql); } catch (_) {} }
  for (const sql of [
    // Whose feed the picture belongs on.
    'ALTER TABLE client_inspo ADD COLUMN team_member_id INTEGER',
    'ALTER TABLE client_inspo ADD COLUMN artist TEXT DEFAULT \'\'',
    'ALTER TABLE client_inspo ADD COLUMN note TEXT DEFAULT \'\'',
  ]) { try { await execute(sql); } catch (_) {} }
}

async function findByToken(token) {
  if (!token) return null;
  await ensureColumns();
  return queryOne(
    `SELECT a.*, m.name AS artist_name, m.id AS artist_id
       FROM team_appointments a
       LEFT JOIN team_members m ON m.id = a.team_member_id
      WHERE a.chat_token = ?`, [String(token)]).catch(() => null);
}

// Half the service, the same rule the public booking uses. Worked out from
// the menu rather than stored on the row, so a service renamed or repriced
// does not leave an old number sitting on somebody's appointment.
/* Who is this, and does their membership already cover it?
   Without this the deposit was priced for a stranger every time. */
async function memberInfoFor(appt) {
  try {
    const bill = require('./_kiosk-bill');
    const member = await bill.memberFor({
      member_id: appt.member_id || null,
      email: appt.client_email || appt.email || '',
      name: appt.client_name || appt.name || '',
    });
    const tier = bill.memberTierOf(member);
    if (!tier) return { member: null, tier: null };
    return { member, tier };
  } catch (_) { return { member: null, tier: null }; }
}

async function depositFor(appt) {
  // A deposit already taken is a fact, not a calculation.
  if (Number(appt.deposit_cents) > 0) return Number(appt.deposit_cents);

  const { member, tier } = await memberInfoFor(appt);

  /* Essential and Elite promise no deposit in as many words. The retired
     tiers include the service outright, so there is nothing to hold. */
  if (tier) {
    try {
      const perks = require('./_perks');
      const neverDeposits = (perks.tierPerks(tier) || []).some(p => p.kind === 'deposit');
      if (neverDeposits) return 0;
      const free = await require('./_pay').freeServicesLeft(member.member_id, tier);
      if (free > 0) return 0;
    } catch (_) { return 0; }   // unsure about a member means do not ask them for money
  }

  try {
    const calc = require('./_pay').computeDeposit({
      service_name: appt.service, addon_names: [], member_tier: tier || null,
      free_service: false,
    });
    if (calc && calc.deposit_cents) return calc.deposit_cents;
  } catch (_) {}
  return 0;
}

const pretty = ds => {
  const d = new Date(String(ds || '').slice(0, 10) + 'T12:00:00');
  return isNaN(d) ? String(ds || '') : d.toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric' });
};
const time12 = t => {
  const p = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  if (!p) return String(t || '');
  let h = Number(p[1]); const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return h + ':' + p[2] + ap;
};

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action || (req.body && req.body.action) || '';
  const token = String(req.query.t || (req.body && req.body.t) || '').trim();

  try {
    await ensureColumns();
    const appt = await findByToken(token);
    if (!appt) return res.status(404).json({ error: 'We could not find that appointment. Check the link, or message the studio.' });

    const deposit = await depositFor(appt);
    const paid = !!Number(appt.deposit_paid);

    // ── What this appointment is ──
    if (req.method === 'GET') {
      let inspoCount = 0;
      try {
        const r = await queryOne('SELECT COUNT(*) AS n FROM client_inspo WHERE confirmation=?', [token]);
        inspoCount = Number((r || {}).n) || 0;
      } catch (_) {}
      return res.json({
        client: appt.client_name || '',
        service: appt.service || 'your appointment',
        date: appt.date, time: appt.time,
        date_pretty: pretty(appt.date), time_pretty: time12(appt.time),
        artist: appt.artist_name || '',
        deposit_cents: deposit,
        deposit_paid: paid,
        inspo_count: inspoCount,
        cancelled: /cancel/i.test(String(appt.status || '')),
      });
    }

    // ── Pay the deposit ──
    if (req.method === 'POST' && action === 'pay_intent') {
      if (paid) return res.status(400).json({ error: 'This deposit is already paid — nothing more to do.' });
      if (deposit < 50) return res.status(400).json({ error: 'There is no deposit on this appointment.' });
      const pay = require('./_pay');
      const sk = await pay.getStripeSecret();
      if (!sk) return res.status(400).json({ error: 'Card payments are not set up yet — message the studio.' });
      const r = await fetch('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + sk, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          amount: String(deposit), currency: 'usd', 'automatic_payment_methods[enabled]': 'true',
          description: ('ZOLA deposit — ' + (appt.client_name || 'client') + ' · ' + (appt.service || '')).slice(0, 300),
          'metadata[appt_token]': token,
        }).toString(),
      });
      const pi = await r.json();
      if (!r.ok) return res.status(400).json({ error: (pi.error && pi.error.message) || 'Stripe error' });
      return res.json({ client_secret: pi.client_secret, payment_intent_id: pi.id, amount_cents: deposit });
    }

    // ── Confirm it cleared ──
    if (req.method === 'POST' && action === 'paid') {
      const v = await require('./_pay').verifyPaymentIntent((req.body || {}).payment_intent_id);
      if (!v.paid) return res.status(402).json({ error: 'That payment did not go through — you have not been charged.' });
      await execute('UPDATE team_appointments SET deposit_paid=1, deposit_cents=? WHERE chat_token=?',
        [deposit, token]);
      try {
        await require('./_notify').notifyInApp('owner', null,
          '💳 ' + (appt.client_name || 'A client') + ' paid their deposit',
          '$' + (deposit / 100).toFixed(2) + ' · ' + (appt.service || '') + ' on ' + pretty(appt.date));
      } catch (_) {}
      return res.json({ ok: true });
    }

    // ── Send an inspiration photo ──
    //
    // Tagged with the artist who is actually doing the nails, so it lands on
    // her feed rather than in a pile everybody has to search.
    if (req.method === 'POST' && action === 'inspo') {
      const dataUrl = String((req.body || {}).data_url || '');
      if (!dataUrl.startsWith('data:image/')) return res.status(400).json({ error: 'That did not arrive as a picture — try again.' });
      if (dataUrl.length > MAX_DATA_URL) {
        return res.status(413).json({ error: 'That picture is enormous — try one more time and it will be shrunk automatically.' });
      }
      await execute(
        `INSERT INTO client_inspo
           (confirmation, client_name, client_email, service, appt_date, data_url, team_member_id, artist, note, ts)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [token, appt.client_name || '', appt.client_email || '', appt.service || '',
         appt.date || '', dataUrl, appt.team_member_id || null, appt.artist_name || '',
         String((req.body || {}).note || '').slice(0, 300), Date.now()]);

      // Tell whoever is doing them, and Zahra.
      try {
        const notify = require('./_notify');
        if (appt.team_member_id) {
          await notify.notifyInApp('team', appt.team_member_id,
            '📸 ' + (appt.client_name || 'A client') + ' sent an inspiration photo',
            (appt.service || '') + ' on ' + pretty(appt.date));
        }
        await notify.notifyInApp('owner', null,
          '📸 Inspiration from ' + (appt.client_name || 'a client'),
          (appt.artist_name ? 'For ' + appt.artist_name + ' · ' : '') + pretty(appt.date));
      } catch (_) {}

      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};

module.exports.ensureColumns = ensureColumns;
module.exports.findByToken = findByToken;
module.exports.depositFor = depositFor;
module.exports.pretty = pretty;
module.exports.time12 = time12;
module.exports.memberInfoFor = memberInfoFor;
