// What {{first_name}} and the rest actually resolve to.
//
// Every place that sends an automatic email was building this by hand, and
// they had all drifted: one forgot {{amount}}, one passed a raw 2026-09-28
// where a client should read "Monday, September 28", one forgot {{tier}}.
// A merge tag that silently resolves to nothing is worse than a broken one,
// because it goes out looking fine.
//
// So it is built once, here, from the appointment itself. A field is either
// filled from that person's own booking or it is not filled at all — there
// is no sample data anywhere near a real send.
const { queryOne } = require('./_team-db');

const SITE = process.env.PUBLIC_BASE_URL || 'https://zolanailstudio.com';
const STUDIO = 'ZOLA Nail Studio';

/* The studio's own address, as she has it saved. Falls back to the town
   rather than to nothing, because {{studio}} appearing as a blank in a
   sign-off is the kind of thing nobody notices until a client does. */
async function studioName() {
  try {
    const row = await queryOne("SELECT value FROM site_settings WHERE key='studio_address'");
    const addr = String((row && row.value) || '').trim();
    return addr ? STUDIO + ' · ' + addr : STUDIO + ' · Porterville, California';
  } catch (_) {
    return STUDIO + ' · Porterville, California';
  }
}

const firstOf = s => String(s || '').trim().split(/\s+/)[0] || '';
const dollars = c => '$' + (Number(c || 0) / 100).toFixed(2).replace(/\.00$/, '');

/* Every field, for one person's appointment.
 *
 * `appt` is a team_appointments row. Everything else is looked up from it
 * rather than passed in, so a caller cannot forget a field or hand over the
 * wrong one.
 */
async function forAppointment(appt, extra = {}) {
  const visit = require('./_visit');
  try { await visit.ensureColumns(); } catch (_) {}

  // Who they are.
  let email = String(appt.client_email || '').trim();
  if (!email) {
    try { email = (await require('./_confirm-mail').resolveEmail(appt)) || ''; } catch (_) {}
  }

  // Who is doing them. Named on the row, or looked up from the id.
  let artist = String(appt.artist_name || '').trim();
  if (!artist && appt.team_member_id) {
    try {
      const m = await queryOne('SELECT name FROM team_members WHERE id=?', [appt.team_member_id]);
      artist = (m && m.name) || '';
    } catch (_) {}
  }

  // Their membership, if they have one.
  let tierLabel = '';
  let tierKey = '';
  try {
    const info = await visit.memberInfoFor(appt);
    tierKey = String((info && info.tier) || '');
    if (tierKey) {
      try {
        const p = require('./_plans').byKey(tierKey);
        tierLabel = (p && p.name) || tierKey.replace('_', ' ');
      } catch (_) { tierLabel = tierKey.replace('_', ' '); }
    }
  } catch (_) {}

  /* What they owe up front. The deposit is half, worked out by the same
     code the booking page and the till use — not recalculated here, where
     it could drift away from the number they are actually charged. */
  let depositCents = Number(appt.deposit_cents) || 0;
  if (!depositCents) {
    try { depositCents = await visit.depositFor(appt); } catch (_) { depositCents = 0; }
  }

  /* Their own page: deposit and inspiration photo. The token is the whole
     point of the link — without one there is no page to send them to, so
     the field is left empty rather than pointing at a page that will not
     know who they are. */
  const token = String(appt.chat_token || '').trim();
  const link = token ? SITE + '/visit.html?t=' + encodeURIComponent(token) : '';

  return Object.assign({
    email,
    first_name: firstOf(appt.client_name),
    name: String(appt.client_name || '').trim(),
    service: String(appt.service || '').trim(),
    date: visit.pretty(appt.date),
    time: visit.time12(appt.time),
    artist,
    tier: tierLabel,
    tier_key: tierKey,
    amount: depositCents ? dollars(depositCents) : '',
    link,
    studio: await studioName(),
  }, extra);
}

/* The same set for somebody who has no appointment — a new member, say.
   The appointment-shaped fields are left empty rather than invented. */
async function forMember({ name, email, tier, tierLabel, amountCents } = {}) {
  return {
    email: String(email || '').trim(),
    first_name: firstOf(name),
    name: String(name || '').trim(),
    service: '',
    date: '',
    time: '',
    artist: '',
    tier: tierLabel || String(tier || '').replace('_', ' '),
    tier_key: String(tier || ''),
    amount: amountCents ? dollars(amountCents) : '',
    link: '',
    studio: await studioName(),
  };
}

/* Whether this set of fields is safe to send with these words.
 *
 * An email that greets somebody by an empty name, or offers them a deposit
 * link that goes nowhere, should not go out at all. Held back and reported
 * rather than sent broken — a client can forgive a late email and cannot
 * unread "Hi ," or a dead link where their deposit should have been.
 */
function missingFor(bodyText, subjectText, data) {
  const used = new Set();
  const text = String(subjectText || '') + ' ' + String(bodyText || '');
  const re = /\{\{([a-z_]+)\}\}/gi;
  let hit;
  while ((hit = re.exec(text))) used.add(hit[1].toLowerCase());

  const missing = [];
  for (const key of used) {
    // tier is legitimately empty for somebody who is not a member.
    if (key === 'tier') continue;
    if (!String((data && data[key]) || '').trim()) missing.push(key);
  }
  return missing;
}

module.exports = { forAppointment, forMember, missingFor, studioName, dollars, firstOf };
