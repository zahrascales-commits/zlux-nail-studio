// The email somebody gets the moment they buy a Black Friday deal.
//
// Zahra's ask: congratulate them, say how much they saved, and say we
// cannot wait to have them in — professional and celebratory.
//
// Three things it does that a generic "thanks for your order" does not,
// and each of them is here for a reason rather than for warmth:
//
//   · IT NAMES THE SAVING AGAINST SOMETHING. "$430.01 less than paying
//     every 4 weeks for a year" rather than "you saved 30%". A percentage
//     with no stated baseline is the thing her copy rules ban everywhere
//     else on this site, and an email is where somebody re-reads it.
//
//   · IT SAYS WHEN THE PRICE CHANGES, IN THE EMAIL. The introductory
//     price on a recurring membership runs about two months. The
//     sentence people say they were never told is the one about the
//     second payment, and an email is the only version of this they can
//     go back and find. Putting it only on the checkout screen is how a
//     good deal turns into a chargeback.
//
//   · IT ASKS FOR THE BOOKING. A membership that is paid for and never
//     booked is a cancellation in eight weeks' time. So the one action
//     in it is booking the first visit.
//
// Nothing here invents a figure. Every number is passed in by the code
// that actually took the money.
const money = c => {
  const v = Math.max(0, Math.round(Number(c) || 0)) / 100;
  return '$' + (v % 1 === 0
    ? v.toLocaleString('en-US')
    : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
};
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const BOOK = 'https://zolanailstudio.com/booking.html';

const SHELL = inner => `<div style="font-family:Helvetica,Arial,sans-serif;background:#faf7f4;padding:26px 14px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #eee5d8">
    <div style="background:#0D0D0D;padding:30px 24px;text-align:center">
      <div style="font-family:Georgia,serif;font-size:22px;letter-spacing:7px;color:#F5EEE8">ZOLA</div>
      <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#B6A588;margin-top:7px">Black Friday</div>
    </div>
    <div style="padding:30px 24px">${inner}</div>
    <div style="padding:0 24px 26px;text-align:center">
      <div style="font-size:11px;line-height:1.7;color:#A89C86">
        ZOLA Nail Studio &middot; Porterville, California<br>
        Questions? Just reply to this email.
      </div>
    </div>
  </div>
</div>`;

const BIGSAVE = (amount, against) =>
  '<div style="background:#0D0D0D;padding:26px 22px;text-align:center;margin:0 0 22px">'
  + '<div style="font-size:10px;letter-spacing:4px;text-transform:uppercase;color:#B6A588">You saved</div>'
  + '<div style="font-family:Georgia,serif;font-size:40px;line-height:1.1;color:#F5EEE8;margin:8px 0 6px">'
    + amount + '</div>'
  + '<div style="font-size:13px;line-height:1.65;color:rgba(245,238,232,0.82)">' + against + '</div>'
  + '</div>';

const LINE = (l, r, bold) =>
  '<div style="display:flex;justify-content:space-between;gap:12px;font-size:14px;color:#3a3027;'
  + 'padding:7px 0' + (bold ? ';font-weight:bold;border-top:1px solid #eee5d8;margin-top:4px' : '')
  + '"><span>' + l + '</span><span style="white-space:nowrap">' + r + '</span></div>';

const CTA = (href, label) =>
  '<a href="' + href + '" style="display:block;background:#B6A588;color:#0D0D0D;text-decoration:none;'
  + 'text-align:center;font-size:13px;letter-spacing:3px;text-transform:uppercase;'
  + 'padding:16px 18px;margin:22px 0 0">' + label + '</a>';

/* ── A MEMBERSHIP BOUGHT ON SALE ────────────────────────────────────── */

/* bf is exactly what _member-signup returned: mode, now_cents, was_cents,
   then_cents, weeks, lasts, saved_cents, saved_vs_monthly_cents. */
function membershipHtml({ name, tier, bf, memberId }) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const yearly = bf.mode === 'annual';

  const amount = yearly
    ? (Number(bf.saved_vs_monthly_cents) || Number(bf.saved_cents) || 0)
    : Number(bf.saved_cents) || 0;

  const against = yearly
    ? money(bf.now_cents) + ' for the year, instead of ' + money(bf.vs_monthly_cents || bf.was_cents)
      + ' paying every ' + bf.weeks + ' weeks'
    : money(bf.now_cents) + ' a visit instead of ' + money(bf.was_cents)
      + ', for ' + (bf.lasts || 'your first 2 months');

  const body =
    '<p style="font-size:16px;line-height:1.75;color:#3a3027;margin:0 0 6px">Hi ' + esc(first) + ',</p>'
    + '<p style="font-size:16px;line-height:1.75;color:#3a3027;margin:0 0 22px">'
      + 'You got it. Your <b>' + esc(tier) + '</b> membership is live, and you bought it at the best '
      + 'price we have ever put on it.</p>'

    + BIGSAVE(money(amount), against)

    + '<div style="background:#faf7f4;border:1px solid #eee5d8;padding:16px 20px;margin:0 0 20px">'
      + LINE('Membership', esc(tier))
      + LINE('Your rhythm', 'a visit every ' + bf.weeks + ' weeks')
      + LINE(yearly ? 'Paid today, for the year' : 'Paid today', money(bf.now_cents))
      + (yearly
          ? LINE('Renews', money(bf.then_cents) + ' in a year')
          : LINE('After ' + (bf.lasts || 'your first 2 months'),
                 money(bf.then_cents) + ' every ' + bf.weeks + ' weeks'))
      + (memberId ? LINE('Member ID', esc(memberId), true) : '')
    + '</div>'

    /* Said in the email, not only on the screen she has already closed.
       This is the sentence that decides whether a Black Friday member is
       still a member in March. */
    + '<p style="font-size:14px;line-height:1.75;color:#8C7A5E;margin:0 0 4px">'
      + (yearly
          ? 'Your year is paid in full. There is nothing to pay at any appointment between now and '
            + 'then, and nothing renews until a year from today.'
          : '<b>So there are no surprises:</b> the ' + money(bf.now_cents) + ' price holds for '
            + (bf.lasts || 'your first 2 months') + '. After that it is '
            + money(bf.then_cents) + ' every ' + bf.weeks
            + ' weeks — still your membership price, still nothing to pay at the appointment. '
            + 'You can cancel from your account after three months.')
    + '</p>'

    + '<p style="font-size:16px;line-height:1.75;color:#3a3027;margin:22px 0 0">'
      + 'Now the only thing left is the fun part. Pick your first slot and we will see you soon '
      + '— we cannot wait to get your nails done.</p>'

    + CTA(BOOK, 'Book your first visit');

  return {
    /* "You saved $36.51" on a recurring membership would read as a total
       when it is per visit, which overstates nothing but misleads — and
       the real figure is more persuasive said properly, because it
       repeats. The yearly one genuinely is a single saving. */
    subject: yearly
      ? 'You saved ' + money(amount) + ' ✦ your ' + tier + ' membership is live'
      : money(amount) + ' off every visit ✦ your ' + tier + ' membership is live',
    html: SHELL(body),
  };
}

/* ── PRESS-ONS BOUGHT ON SALE ───────────────────────────────────────── */

function pressonHtml({ name, items, saved_cents, total_cents, was_cents }) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const rows = (items || []).map(i =>
    LINE(esc(i.name) + (i.qty > 1 ? ' × ' + i.qty : ''), money(i.cents))).join('');

  const body =
    '<p style="font-size:16px;line-height:1.75;color:#3a3027;margin:0 0 6px">Hi ' + esc(first) + ',</p>'
    + '<p style="font-size:16px;line-height:1.75;color:#3a3027;margin:0 0 22px">'
      + 'Your press-ons are on their way to being made. You caught them on Black Friday, which '
      + 'means you paid less than anyone will after Monday.</p>'

    + BIGSAVE(money(saved_cents), money(total_cents) + ' instead of ' + money(was_cents))

    + '<div style="background:#faf7f4;border:1px solid #eee5d8;padding:16px 20px;margin:0 0 20px">'
      + rows
      + LINE('Black Friday', '−' + money(saved_cents))
      + LINE('Paid', money(total_cents), true)
    + '</div>'

    + '<p style="font-size:16px;line-height:1.75;color:#3a3027;margin:0 0 0">'
      + 'We will be in touch the moment they are ready. If you want them put on properly rather '
      + 'than at your kitchen table, book in and we will apply them for you.</p>'

    + CTA(BOOK, 'Book an application');

  return {
    subject: 'You saved ' + money(saved_cents) + ' ✦ your ZOLA press-ons are coming',
    html: SHELL(body),
  };
}

/* ── SENDING ────────────────────────────────────────────────────────────
   dry defaults to TRUE. Nothing in this file sends an email to a real
   client unless the caller explicitly says so, which is what lets the
   wording be previewed without anybody being mailed by accident. */
async function sendMembership(opts) {
  const built = membershipHtml(opts);
  const to = String(opts.email || '').trim();
  if (!to || !/@/.test(to)) return { sent: false, why: 'no email', ...built };
  if (opts.dry !== false) return { sent: false, dry: true, to, ...built };
  const sent = await require('./_notify').sendEmail(to, built.subject, built.html,
    { kind: 'black_friday_membership' });
  return { sent: !!(sent && sent.sent !== false), to, ...built };
}

async function sendPressons(opts) {
  const built = pressonHtml(opts);
  const to = String(opts.email || '').trim();
  if (!to || !/@/.test(to)) return { sent: false, why: 'no email', ...built };
  if (opts.dry !== false) return { sent: false, dry: true, to, ...built };
  const sent = await require('./_notify').sendEmail(to, built.subject, built.html,
    { kind: 'black_friday_pressons' });
  return { sent: !!(sent && sent.sent !== false), to, ...built };
}

module.exports = { membershipHtml, pressonHtml, sendMembership, sendPressons, money };
