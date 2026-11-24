// Gift cards somebody buys online for somebody else.
//
// Zahra described the whole thing: you put an amount on a card, pick the
// date you want it to arrive, leave a note, and on that date the person
// gets an email with the card, the note, and a link that unwraps into
// money in their account — which then comes off whatever they book.
//
// Four decisions worth stating, because each of them is the difference
// between a gift card and a liability:
//
//   · A CARD ONLY EXISTS IF THE MONEY ARRIVED. The card is created in the
//     confirm step, after Stripe is asked whether the payment actually
//     succeeded. Nothing here trusts the browser's word that it paid.
//
//   · THE BALANCE IS RE-SUMMED, NEVER DECREMENTED. Every use is a row in
//     gift_spends and the balance is the card minus what still stands
//     against it. That is the lesson from a client credited $255 against
//     $175 of real charges, and a gift card is exactly the kind of thing
//     that gets spent twice on two devices at once.
//
//   · IT CANNOT BE SPENT BEFORE IT IS GIVEN. A card with a delivery date
//     in the future has no balance, even if somebody guesses the code.
//     Otherwise a Christmas present is spendable in November.
//
//   · THE CODE IS NOT A SECRET WORTH MUCH. It is in an email, so it will
//     be forwarded and screenshotted. The balance is therefore tied to
//     the RECIPIENT'S EMAIL, not to whoever holds the code: redeeming
//     puts money in her account, and spending it needs that account.
const { query, queryOne, execute } = require('./_team-db');

const CEO_PASSWORD = process.env.CEO_PASSWORD || 'ZOLA2026';

const money = c => Math.max(0, Math.round(Number(c) || 0));
const dollars = c => '$' + (money(c) / 100).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lower = s => String(s || '').trim().toLowerCase();
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pad = n => String(n).padStart(2, '0');

function studioNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}
const todayLA = () => {
  const d = studioNow();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};

/* What she will accept on a card. A floor because Stripe will not take
   less than fifty cents and a card worth a dollar is not a gift; a
   ceiling because a mistyped amount on a gift card is somebody else's
   money and there is no undo once it has been given. */
const MIN_CENTS = 2500;
const MAX_CENTS = 100000;

/* No I, O, 0 or 1 — this gets read off a phone screen and typed back in. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return 'ZG-' + s.slice(0, 4) + '-' + s.slice(4);
}

let _ready = null;
async function ensure() {
  if (_ready) return _ready;
  _ready = (async () => {
    await execute(`CREATE TABLE IF NOT EXISTS gift_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE,
      amount_cents INTEGER DEFAULT 0,
      buyer_name TEXT DEFAULT '',
      buyer_email TEXT DEFAULT '',
      buyer_phone TEXT DEFAULT '',
      to_name TEXT DEFAULT '',
      to_email TEXT DEFAULT '',
      note TEXT DEFAULT '',
      deliver_on TEXT DEFAULT '',
      delivered_ts INTEGER DEFAULT 0,
      redeemed_ts INTEGER DEFAULT 0,
      payment_intent TEXT DEFAULT '',
      voided_ts INTEGER DEFAULT 0,
      created_ts INTEGER
    )`);
    /* One row per use, so the balance is a sum and never a decrement. */
    await execute(`CREATE TABLE IF NOT EXISTS gift_spends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER DEFAULT 0,
      amount_cents INTEGER DEFAULT 0,
      ref TEXT DEFAULT '',
      note TEXT DEFAULT '',
      voided_ts INTEGER DEFAULT 0,
      ts INTEGER
    )`);
    try { await execute('CREATE INDEX IF NOT EXISTS gift_cards_to ON gift_cards (to_email)'); } catch (_) {}
    try { await execute('CREATE INDEX IF NOT EXISTS gift_cards_deliver ON gift_cards (deliver_on)'); } catch (_) {}
    try { await execute('CREATE INDEX IF NOT EXISTS gift_spends_card ON gift_spends (card_id)'); } catch (_) {}
    /* A spend can only ever be written once per booking per card, which is
       what stops a double tap on the booking page spending it twice. */
    try { await execute('CREATE UNIQUE INDEX IF NOT EXISTS gift_spends_once ON gift_spends (card_id, ref)'); } catch (_) {}
  })().catch(e => { _ready = null; throw e; });
  return _ready;
}

/* ── WHAT A CARD IS WORTH ───────────────────────────────────────────── */

async function spentOn(cardIds) {
  const ids = Array.from(new Set((cardIds || []).map(Number).filter(Boolean)));
  if (!ids.length) return {};
  let rows = [];
  try {
    rows = await query(
      'SELECT card_id, amount_cents FROM gift_spends WHERE COALESCE(voided_ts,0) = 0 '
      + 'AND card_id IN (' + ids.map(() => '?').join(',') + ')', ids);
  } catch (_) {}
  const out = {};
  for (const r of rows || []) {
    const k = String(r.card_id);
    out[k] = (out[k] || 0) + money(r.amount_cents);
  }
  return out;
}

function cardShape(c, spent) {
  const amount = money(c.amount_cents);
  const used = money(spent);
  const delivered = !!money(c.delivered_ts);
  const redeemed = !!money(c.redeemed_ts);
  const voided = !!money(c.voided_ts);
  /* Not spendable until it has actually been given AND unwrapped. A
     Christmas present must not be usable in November. */
  const usable = !voided && redeemed && delivered;
  return {
    id: Number(c.id),
    code: c.code || '',
    amount_cents: amount,
    spent_cents: used,
    balance_cents: usable ? Math.max(0, amount - used) : 0,
    to_name: c.to_name || '',
    to_email: c.to_email || '',
    from_name: c.buyer_name || '',
    note: c.note || '',
    deliver_on: c.deliver_on || '',
    delivered: delivered,
    delivered_ts: Number(c.delivered_ts) || 0,
    redeemed: redeemed,
    redeemed_ts: Number(c.redeemed_ts) || 0,
    voided: voided,
    created_ts: Number(c.created_ts) || 0,
    /* Where it is in its life, in words, so neither screen has to work it
       out from four booleans. */
    status: voided ? 'cancelled'
      : !delivered ? 'waiting until ' + (c.deliver_on || 'later')
      : !redeemed ? 'delivered, not opened yet'
      : (amount - used) <= 0 ? 'all used'
      : 'ready to use',
  };
}

/* Everything one person has, and what it adds up to. Keyed on the email
   the card was sent to, because the code travels and the account does
   not. */
async function balanceFor(email) {
  await ensure();
  const e = lower(email);
  if (!e) return { email: '', balance_cents: 0, cards: [] };
  let rows = [];
  try {
    rows = await query('SELECT * FROM gift_cards WHERE lower(to_email) = ? ORDER BY id', [e]);
  } catch (_) {}
  const spent = await spentOn((rows || []).map(r => r.id));
  const cards = (rows || []).map(r => cardShape(r, spent[String(r.id)]));
  return {
    email: e,
    balance_cents: cards.reduce((s, c) => s + c.balance_cents, 0),
    cards,
  };
}

async function byCode(code) {
  await ensure();
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  const row = await queryOne('SELECT * FROM gift_cards WHERE upper(code) = ?', [c]).catch(() => null);
  if (!row) return null;
  const spent = await spentOn([row.id]);
  return cardShape(row, spent[String(row.id)]);
}

/* ── BUYING ONE ─────────────────────────────────────────────────────── */

function checkBuy(b) {
  const amount = money(b.amount_cents);
  if (amount < MIN_CENTS) return { ok: false, why: 'The smallest gift card is ' + dollars(MIN_CENTS) + '.' };
  if (amount > MAX_CENTS) return { ok: false, why: 'The largest is ' + dollars(MAX_CENTS) + '. Buy two if you need more.' };

  const to = lower(b.to_email);
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return { ok: false, why: 'We need their email address — that is where the card goes.' };
  }
  const from = lower(b.buyer_email);
  if (!from || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) {
    return { ok: false, why: 'We need your email too, for the receipt.' };
  }
  /* A date in the past would mean "send it immediately", which is fine,
     but a date two years out is a typo. */
  let on = String(b.deliver_on || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) on = todayLA();
  if (on < todayLA()) on = todayLA();
  const limit = new Date(Date.parse(todayLA() + 'T12:00:00Z') + 400 * 86400000).toISOString().slice(0, 10);
  if (on > limit) return { ok: false, why: 'Pick a date within the next year.' };

  return {
    ok: true,
    amount_cents: amount,
    to_email: to,
    to_name: String(b.to_name || '').trim().slice(0, 80),
    buyer_email: from,
    buyer_name: String(b.buyer_name || '').trim().slice(0, 80),
    buyer_phone: String(b.buyer_phone || '').trim().slice(0, 40),
    note: String(b.note || '').trim().slice(0, 400),
    deliver_on: on,
  };
}

async function buyIntent(body) {
  await ensure();
  const v = checkBuy(body || {});
  if (!v.ok) return v;

  const sk = await require('./_pay').getStripeSecret();
  if (!sk) return { ok: false, why: 'Card payments are not switched on right now.' };

  const r = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + sk, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      amount: String(v.amount_cents),
      currency: 'usd',
      'automatic_payment_methods[enabled]': 'true',
      description: 'ZOLA gift card — ' + dollars(v.amount_cents),
      'metadata[kind]': 'gift_card',
      'metadata[to_email]': v.to_email,
      'metadata[deliver_on]': v.deliver_on,
      ...(v.buyer_email ? { receipt_email: v.buyer_email } : {}),
    }).toString(),
  });
  const pi = await r.json();
  if (!r.ok) return { ok: false, why: (pi.error && pi.error.message) || 'Stripe would not take that.' };
  return {
    ok: true,
    client_secret: pi.client_secret,
    payment_intent_id: pi.id,
    amount_cents: v.amount_cents,
  };
}

/* The card exists only once Stripe says the money arrived. Idempotent on
   the payment: a browser that retries the confirm gets the same card
   rather than a second one. */
async function confirmBuy(body) {
  await ensure();
  const v = checkBuy(body || {});
  if (!v.ok) return v;

  const piId = String((body || {}).payment_intent_id || '').trim();
  if (!piId) return { ok: false, why: 'No payment to confirm.' };

  const existing = await queryOne('SELECT * FROM gift_cards WHERE payment_intent = ?', [piId])
    .catch(() => null);
  if (existing) {
    const spent = await spentOn([existing.id]);
    return { ok: true, already: true, card: cardShape(existing, spent[String(existing.id)]) };
  }

  let paid = null;
  try { paid = await require('./_pay').verifyPaymentIntent(piId); } catch (_) {}
  if (!paid || !paid.paid) {
    return { ok: false, why: 'That payment has not gone through, so no card was made.' };
  }
  /* The amount charged, not the amount asked for. If they differ, the
     card is worth what was actually paid. */
  const amount = money(paid.amount) || v.amount_cents;

  let code = newCode();
  for (let i = 0; i < 5; i++) {
    const clash = await queryOne('SELECT id FROM gift_cards WHERE code = ?', [code]).catch(() => null);
    if (!clash) break;
    code = newCode();
  }

  await execute(
    `INSERT INTO gift_cards (code, amount_cents, buyer_name, buyer_email, buyer_phone,
       to_name, to_email, note, deliver_on, delivered_ts, redeemed_ts, payment_intent, voided_ts, created_ts)
     VALUES (?,?,?,?,?,?,?,?,?,0,0,?,0,?)`,
    [code, amount, v.buyer_name, v.buyer_email, v.buyer_phone,
     v.to_name, v.to_email, v.note, v.deliver_on, piId, Date.now()]);

  const row = await queryOne('SELECT * FROM gift_cards WHERE code = ?', [code]);
  const card = cardShape(row, 0);

  /* If it is for today, it goes now rather than waiting for the cron —
     somebody buying a card at the till for the person standing next to
     them should not wait until nine tomorrow morning. */
  let delivered = null;
  if (card.deliver_on <= todayLA()) {
    delivered = await deliver(card.id);
  }

  /* And the buyer gets told, either way, because "did it send?" is the
     first thing anybody wonders. */
  try { await receiptToBuyer(row, delivered && delivered.sent); } catch (_) {}

  return { ok: true, card: (await byCode(code)) || card, delivered: !!(delivered && delivered.sent) };
}

/* ── GIVING IT ──────────────────────────────────────────────────────── */

/* Her mark, used in the subject lines. It was \u{1F380} — the bow emoji —
   which she said looked fake, so it is the same \u2726 the rest of her
   email already uses. */
const MARK = '\u2726';

/* The satin, as solid colours. Seven stops across the width of the
   ribbon: the light one in the middle is the sheen. */
const SATIN = ['#6E5F47', '#8C7A5E', '#B6A588', '#E4D9C2', '#B6A588', '#8C7A5E', '#6B5C45'];
const CARD_H = 210;

/* The card itself, drawn in the email. Table-based and inline-styled
   because an email client will strip a stylesheet, an SVG and anything
   clever — and a gift card that arrives as a broken image is worse than
   one that arrives as plain text. Which is also why the ribbon is made
   of table cells rather than a gradient: Outlook renders neither
   gradients nor pseudo elements, and would have shown a flat grey box
   where the ribbon should be. */
function cardArt(amount, toName, code) {
  /* The ribbon: one cell per stop, each a solid colour, each the full
     height of the card. */
  const ribbon = '<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
      + 'width="100%" height="' + CARD_H + '" style="border-collapse:collapse">'
    + '<tr>'
      + SATIN.map(c => '<td height="' + CARD_H + '" bgcolor="' + c + '" '
          + 'style="background-color:' + c + ';width:14.2%;font-size:0;line-height:0">&nbsp;</td>').join('')
    + '</tr></table>';

  return ''
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
      + 'style="max-width:384px;margin:0 auto;border-collapse:collapse">'
    + '<tr><td bgcolor="#121110" style="background-color:#121110;padding:0;'
      + 'border:1px solid #8C7A5E">'

      + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        + 'style="border-collapse:collapse">'
      + '<tr>'

        /* The lettering, in its own column. Left-aligned: a real gift
           card is read like a bank card, not like a greetings card. */
        + '<td width="62%" height="' + CARD_H + '" valign="top" '
          + 'style="padding:22px 0 20px 22px">'
          + '<div style="font-family:Georgia,\'Times New Roman\',serif;font-size:19px;'
            + 'letter-spacing:7px;color:#F4EFE6;line-height:1">ZOLA</div>'
          + '<div style="font-family:Helvetica,Arial,sans-serif;font-size:8px;letter-spacing:2.5px;'
            + 'text-transform:uppercase;color:#C8B795;margin-top:7px">Nail Studio &middot; Porterville</div>'

          + '<div style="height:' + (CARD_H - 132) + 'px;font-size:0;line-height:0">&nbsp;</div>'

          + '<div style="font-family:Helvetica,Arial,sans-serif;font-size:8px;letter-spacing:2.5px;'
            + 'text-transform:uppercase;color:#C8B795">Gift card</div>'
          + '<div style="font-family:Georgia,\'Times New Roman\',serif;font-size:38px;line-height:1.05;'
            + 'color:#F4EFE6;margin-top:3px">' + dollars(amount) + '</div>'
          + (toName
              ? '<div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;'
                + 'color:#CFC7BA;margin-top:5px">for ' + esc(toName) + '</div>'
              : '')
          + (code
              ? '<div style="font-family:Helvetica,Arial,sans-serif;font-size:10px;'
                + 'letter-spacing:2px;color:#C8B795;margin-top:8px">' + esc(code) + '</div>'
              : '')
        + '</td>'

        + '<td width="22%" height="' + CARD_H + '" valign="top" style="padding:0">'
          + ribbon
        + '</td>'

        + '<td width="16%" height="' + CARD_H + '" style="font-size:0;line-height:0">&nbsp;</td>'

      + '</tr></table>'
    + '</td></tr></table>';
}

const SHELL = inner => `<div style="font-family:Helvetica,Arial,sans-serif;background:#faf7f4;padding:26px 14px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #eee5d8">
    <div style="padding:30px 24px">${inner}</div>
    <div style="padding:0 24px 26px;text-align:center">
      <div style="font-size:11px;line-height:1.7;color:#A89C86">
        ZOLA Nail Studio &middot; Porterville, California<br>
        Questions? Just reply to this email.
      </div>
    </div>
  </div>
</div>`;

const CTA = (href, label) =>
  '<a href="' + href + '" style="display:block;background:#B6A588;color:#0D0D0D;text-decoration:none;'
  + 'text-align:center;font-size:13px;letter-spacing:3px;text-transform:uppercase;'
  + 'padding:16px 18px;margin:24px 0 0">' + label + '</a>';

const SITE = 'https://zolanailstudio.com';

function giftEmail(c) {
  const first = String(c.to_name || '').trim().split(/\s+/)[0];
  const from = String(c.buyer_name || '').trim();
  const link = SITE + '/gift.html?code=' + encodeURIComponent(c.code);

  const body =
    '<p style="font-size:17px;line-height:1.7;color:#3a3027;margin:0 0 20px;text-align:center">'
      + (first ? 'Hi ' + esc(first) + ' — s' : 'S') + 'omebody has treated you.</p>'

    + cardArt(money(c.amount_cents), c.to_name, c.code)

    + '<p style="font-size:16px;line-height:1.75;color:#3a3027;margin:24px 0 0">'
      + (from ? '<b>' + esc(from) + '</b> has' : 'Someone has')
      + ' sent you a ' + dollars(c.amount_cents) + ' gift card for ZOLA'
      + (c.note ? ', and left you a note' : '') + '.</p>'

    + (c.note
        ? '<div style="background:#faf7f4;border-left:3px solid #B6A588;padding:16px 20px;margin:16px 0 0">'
          + '<div style="font-size:16px;line-height:1.75;color:#3a3027;font-style:italic">'
            + '&ldquo;' + esc(c.note) + '&rdquo;</div>'
          + (from ? '<div style="font-size:13px;color:#8C7A5E;margin-top:8px">— ' + esc(from) + '</div>' : '')
        + '</div>'
        : '')

    /* Urgency, in Zahra's own framing: there are new things in right now,
       so now is a good time. True, checkable and hers.
       What it deliberately does NOT say is that anything is running out.
       Invented scarcity is banned everywhere else on this site, and in a
       gift somebody else paid for it would be the worst place to start —
       I cannot show from her data that the diary fills in December, so
       the email does not claim it. */
    + '<p style="font-size:16px;line-height:1.75;color:#3a3027;margin:22px 0 0">'
      + 'And the timing is lovely. We have new colours in, the organic gels, and some really '
      + 'pretty designs on at the moment — so this is a good week to come and use it.</p>'

    + CTA(link, 'Open your gift card')

    + '<p style="font-size:13px;line-height:1.7;color:#8C7A5E;margin:18px 0 0;text-align:center">'
      + 'Your code is <b>' + esc(c.code) + '</b>. It never expires, and whatever you do not use '
      + 'stays on your account for next time.</p>';

  return {
    subject: (from ? from + ' sent you' : 'You have been sent') + ' a '
      + dollars(c.amount_cents) + ' ZOLA gift card ' + MARK,
    html: SHELL(body),
  };
}

function buyerReceiptEmail(c, sentNow) {
  const first = String(c.buyer_name || '').trim().split(/\s+/)[0] || 'there';
  const when = sentNow
    ? 'It has gone to <b>' + esc(c.to_email) + '</b> already.'
    : 'It is scheduled for <b>' + esc(prettyDate(c.deliver_on)) + '</b> and will arrive at '
      + '<b>' + esc(c.to_email) + '</b> that morning.';
  const body =
    '<p style="font-size:16px;line-height:1.75;color:#3a3027;margin:0 0 18px">Hi ' + esc(first) + ',</p>'
    + '<p style="font-size:16px;line-height:1.75;color:#3a3027;margin:0 0 20px">'
      + 'Thank you — your ' + dollars(c.amount_cents) + ' gift card'
      + (c.to_name ? ' for ' + esc(c.to_name) : '') + ' is paid for. ' + when + '</p>'
    + cardArt(money(c.amount_cents), c.to_name, c.code)
    + (c.note
        ? '<p style="font-size:14px;line-height:1.7;color:#8C7A5E;margin:20px 0 0">'
          + 'Your note: &ldquo;' + esc(c.note) + '&rdquo;</p>'
        : '')
    + '<p style="font-size:13px;line-height:1.7;color:#8C7A5E;margin:18px 0 0">'
      + 'The code is ' + esc(c.code) + ', in case you would rather hand it over yourself.</p>';
  return {
    subject: 'Your ' + dollars(c.amount_cents) + ' ZOLA gift card is paid for ' + MARK,
    html: SHELL(body),
  };
}

function prettyDate(ymd) {
  try {
    const b = String(ymd).split('-');
    return new Date(+b[0], +b[1] - 1, +b[2]).toLocaleDateString('en-US',
      { weekday: 'long', month: 'long', day: 'numeric' });
  } catch (_) { return String(ymd || ''); }
}

async function receiptToBuyer(row, sentNow) {
  if (!row || !row.buyer_email) return { sent: false };
  const built = buyerReceiptEmail(row, !!sentNow);
  return require('./_notify').sendEmail(row.buyer_email, built.subject, built.html,
    { kind: 'gift_card_receipt' });
}

/* Sending one. Marked delivered BEFORE the mail goes, so a mailer that
   succeeds and then times out cannot cause the same gift to arrive twice
   — a duplicate gift card email is confusing in a way a missing one is
   not, and she can always resend. */
async function deliver(cardId) {
  await ensure();
  const row = await queryOne('SELECT * FROM gift_cards WHERE id = ?', [Number(cardId) || 0]);
  if (!row) return { sent: false, why: 'No card with that id.' };
  if (money(row.voided_ts)) return { sent: false, why: 'That card was cancelled.' };
  if (money(row.delivered_ts)) return { sent: false, already: true, why: 'Already delivered.' };

  await execute('UPDATE gift_cards SET delivered_ts = ? WHERE id = ?', [Date.now(), row.id]);
  const built = giftEmail(row);
  let sent = { sent: false };
  try {
    sent = await require('./_notify').sendEmail(row.to_email, built.subject, built.html,
      { kind: 'gift_card' });
  } catch (_) {}
  try {
    await require('./_notify').notifyInApp('owner', null,
      MARK + ' Gift card delivered — ' + dollars(row.amount_cents),
      (row.buyer_name || 'Someone') + ' → ' + (row.to_name || row.to_email));
  } catch (_) {}
  return { sent: true, to: row.to_email, subject: built.subject, mail: sent };
}

/* Everything due today or overdue. Run by the reminder cron. */
async function deliverDue({ limit } = {}) {
  await ensure();
  let rows = [];
  try {
    rows = await query(
      "SELECT id FROM gift_cards WHERE COALESCE(delivered_ts,0) = 0 AND COALESCE(voided_ts,0) = 0 "
      + 'AND deliver_on <= ? ORDER BY deliver_on LIMIT ?',
      [todayLA(), Math.min(50, Math.max(1, Number(limit) || 25))]);
  } catch (_) {}
  const out = [];
  for (const r of rows || []) out.push(await deliver(r.id));
  return { sent: out.filter(x => x.sent).length, tried: out.length };
}

/* ── UNWRAPPING IT ──────────────────────────────────────────────────── */

/* Opening the card is what puts the money in her account. Separate from
   delivery on purpose: Zahra wanted the unwrapping to be a moment, and a
   card that credits itself the instant the email is sent has no moment
   left to have. */
async function redeem(code) {
  await ensure();
  const card = await byCode(code);
  if (!card) return { ok: false, why: 'We cannot find that card.' };
  if (card.voided) return { ok: false, why: 'That card was cancelled. Please get in touch.' };
  if (!card.delivered) {
    return { ok: false, why: 'This one is not due until ' + prettyDate(card.deliver_on) + '.' };
  }
  if (card.redeemed) {
    return { ok: true, already: true, card, balance: await balanceFor(card.to_email) };
  }
  await execute('UPDATE gift_cards SET redeemed_ts = ? WHERE id = ?', [Date.now(), card.id]);
  const after = await byCode(code);
  try {
    await require('./_notify').notifyInApp('owner', null,
      MARK + ' Gift card opened — ' + dollars(card.amount_cents),
      (card.to_name || card.to_email) + ' has ' + dollars(card.amount_cents) + ' to spend.');
  } catch (_) {}
  return { ok: true, card: after, balance: await balanceFor(card.to_email) };
}

/* ── SPENDING IT ────────────────────────────────────────────────────────
   Called by the booking page, server-side, in the same request that works
   out what to charge. Written as a row per card so the balance is always
   a sum; keyed on the booking reference so a double-submitted booking
   cannot spend the same credit twice. */
async function spend({ email, amount_cents, ref, note }) {
  await ensure();
  const want = money(amount_cents);
  const r = String(ref || '').trim().slice(0, 60);
  if (!want || !r) return { spent_cents: 0, used: [] };

  const bal = await balanceFor(email);
  if (!bal.balance_cents) return { spent_cents: 0, used: [] };

  /* Oldest card first, so somebody holding two uses the one they were
     given longest ago. */
  const usable = bal.cards.filter(c => c.balance_cents > 0)
    .sort((a, b) => a.created_ts - b.created_ts);

  let left = Math.min(want, bal.balance_cents);
  const used = [];
  for (const c of usable) {
    if (left <= 0) break;
    const take = Math.min(left, c.balance_cents);
    try {
      await execute(
        'INSERT INTO gift_spends (card_id, amount_cents, ref, note, voided_ts, ts) VALUES (?,?,?,?,0,?)',
        [c.id, take, r, String(note || '').slice(0, 160), Date.now()]);
      used.push({ code: c.code, amount_cents: take });
      left -= take;
    } catch (_) {
      /* The unique index already holds a spend for this card and this
         booking, which means this is a retry. Not an error. */
    }
  }
  const after = await balanceFor(email);
  return {
    spent_cents: used.reduce((s, u) => s + u.amount_cents, 0),
    used,
    balance_cents: after.balance_cents,
  };
}

/* Giving it back — a cancelled booking must not keep the credit. */
async function unspend(ref) {
  await ensure();
  const r = String(ref || '').trim();
  if (!r) return { restored_cents: 0 };
  let rows = [];
  try {
    rows = await query('SELECT id, amount_cents FROM gift_spends WHERE ref = ? AND COALESCE(voided_ts,0) = 0', [r]);
  } catch (_) {}
  for (const x of rows || []) {
    try { await execute('UPDATE gift_spends SET voided_ts = ? WHERE id = ?', [Date.now(), x.id]); } catch (_) {}
  }
  return { restored_cents: (rows || []).reduce((s, x) => s + money(x.amount_cents), 0) };
}

/* Credit taken for a payment that never happened. Held against the
   payment intent, so Stripe is the one asked whether it went through —
   never a flag of our own that somebody has to remember to set. */
async function releaseAbandoned({ olderThanMs, limit } = {}) {
  await ensure();
  const cutoff = Date.now() - (Number(olderThanMs) || 24 * 3600 * 1000);
  let rows = [];
  try {
    rows = await query(
      "SELECT id, ref, amount_cents FROM gift_spends WHERE COALESCE(voided_ts,0) = 0 "
      + "AND ref LIKE 'intent:%' AND ts <= ? ORDER BY id LIMIT ?",
      [cutoff, Math.min(50, Math.max(1, Number(limit) || 25))]);
  } catch (_) {}

  let released = 0, cents = 0, kept = 0;
  for (const r of rows || []) {
    const pi = String(r.ref).slice('intent:'.length);
    let paid = false;
    try {
      const v = await require('./_pay').verifyPaymentIntent(pi);
      paid = !!(v && v.paid);
    } catch (_) {
      /* If Stripe cannot be asked, nothing is released. Giving credit
         back on a payment that DID go through would be giving the same
         money away twice, and waiting a day longer costs nobody
         anything. */
      kept++;
      continue;
    }
    if (paid) { kept++; continue; }
    try {
      await execute('UPDATE gift_spends SET voided_ts = ? WHERE id = ?', [Date.now(), r.id]);
      released++; cents += money(r.amount_cents);
    } catch (_) {}
  }
  return { released, released_cents: cents, kept, checked: (rows || []).length };
}

/* ── HER SIDE ───────────────────────────────────────────────────────── */

async function listAll({ limit } = {}) {
  await ensure();
  let rows = [];
  try {
    rows = await query('SELECT * FROM gift_cards ORDER BY id DESC LIMIT ?',
      [Math.min(500, Math.max(1, Number(limit) || 200))]);
  } catch (_) {}
  const spent = await spentOn((rows || []).map(r => r.id));
  const cards = (rows || []).map(r => Object.assign(cardShape(r, spent[String(r.id)]), {
    to_email: r.to_email || '', from_email: r.buyer_email || '',
  }));
  const live = cards.filter(c => !c.voided);
  return {
    cards,
    sold_count: live.length,
    sold_cents: live.reduce((s, c) => s + c.amount_cents, 0),
    /* The number that matters on her books: money taken for nails not yet
       done. It is a liability until it is used, and it should be visible
       as one rather than counted as profit. */
    outstanding_cents: live.reduce((s, c) => s + c.balance_cents, 0),
    used_cents: live.reduce((s, c) => s + c.spent_cents, 0),
    waiting_count: live.filter(c => !c.delivered).length,
    unopened_count: live.filter(c => c.delivered && !c.redeemed).length,
  };
}

async function voidCard(id, why) {
  await ensure();
  await execute('UPDATE gift_cards SET voided_ts = ? WHERE id = ?', [Date.now(), Number(id) || 0]);
  return { ok: true, why: String(why || '') };
}

async function resend(id) {
  await ensure();
  const row = await queryOne('SELECT * FROM gift_cards WHERE id = ?', [Number(id) || 0]);
  if (!row) return { ok: false, why: 'No card with that id.' };
  if (money(row.voided_ts)) return { ok: false, why: 'That card was cancelled.' };
  const built = giftEmail(row);
  let sent = { sent: false };
  try {
    sent = await require('./_notify').sendEmail(row.to_email, built.subject, built.html,
      { kind: 'gift_card' });
  } catch (_) {}
  if (!money(row.delivered_ts)) {
    await execute('UPDATE gift_cards SET delivered_ts = ? WHERE id = ?', [Date.now(), row.id]);
  }
  return { ok: true, to: row.to_email, mail: sent };
}

/* ── THE DOOR ───────────────────────────────────────────────────────── */

const ownerOk = req => req.headers['x-ceo-password'] === CEO_PASSWORD;

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';
  const body = req.body || {};

  try {
    /* ── public ── */
    if (req.method === 'GET' && action === 'limits') {
      return res.json({ min_cents: MIN_CENTS, max_cents: MAX_CENTS, today: todayLA() });
    }
    if (req.method === 'POST' && action === 'buy_intent') {
      const out = await buyIntent(body);
      return res.status(out.ok ? 200 : 400).json(out);
    }
    if (req.method === 'POST' && action === 'confirm') {
      const out = await confirmBuy(body);
      return res.status(out.ok ? 200 : 400).json(out);
    }
    /* The card as the recipient sees it. The buyer's email address is not
       in cardShape, so this cannot be used to harvest who bought what. */
    if (req.method === 'GET' && action === 'card') {
      const c = await byCode(req.query.code);
      if (!c) return res.status(404).json({ ok: false, why: 'We cannot find that card.' });
      return res.json({ ok: true, card: c });
    }
    if (req.method === 'POST' && action === 'redeem') {
      const out = await redeem(body.code);
      return res.status(out.ok ? 200 : 400).json(out);
    }
    if (req.method === 'GET' && action === 'balance') {
      const b = await balanceFor(req.query.email);
      return res.json({ ok: true, balance_cents: b.balance_cents, cards: b.cards.length });
    }

    /* ── hers ── */
    if (!ownerOk(req)) return res.status(401).json({ error: 'Unauthorized' });

    if (req.method === 'GET' && (action === 'list' || !action)) {
      return res.json(await listAll({ limit: req.query.limit }));
    }
    if (req.method === 'POST' && action === 'resend') {
      const out = await resend(body.id);
      return res.status(out.ok ? 200 : 400).json(out);
    }
    if (req.method === 'POST' && action === 'void') {
      return res.json(await voidCard(body.id, body.why));
    }
    if (req.method === 'POST' && action === 'deliver_due') {
      return res.json(await deliverDue({ limit: body.limit }));
    }
    if (req.method === 'POST' && action === 'release_abandoned') {
      return res.json(await releaseAbandoned({ limit: body.limit }));
    }
    /* The wording, without sending anything. */
    if (req.method === 'GET' && action === 'preview') {
      const amount = money(req.query.amount_cents) || 7500;
      return res.json(giftEmail({
        code: 'ZG-EXAM-PLE1', amount_cents: amount,
        to_name: String(req.query.to_name || 'Your Sister'),
        buyer_name: String(req.query.from_name || 'Zahra'),
        note: String(req.query.note || 'Merry Christmas! Go and get your nails done. Love you.'),
        deliver_on: todayLA(),
      }));
    }
    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};

module.exports.balanceFor = balanceFor;
module.exports.byCode = byCode;
module.exports.buyIntent = buyIntent;
module.exports.confirmBuy = confirmBuy;
module.exports.redeem = redeem;
module.exports.spend = spend;
module.exports.unspend = unspend;
module.exports.deliver = deliver;
module.exports.deliverDue = deliverDue;
module.exports.releaseAbandoned = releaseAbandoned;
module.exports.listAll = listAll;
module.exports.voidCard = voidCard;
module.exports.resend = resend;
module.exports.giftEmail = giftEmail;
module.exports.buyerReceiptEmail = buyerReceiptEmail;
module.exports.cardArt = cardArt;
module.exports.checkBuy = checkBuy;
module.exports.newCode = newCode;
module.exports.MIN_CENTS = MIN_CENTS;
module.exports.MAX_CENTS = MAX_CENTS;
