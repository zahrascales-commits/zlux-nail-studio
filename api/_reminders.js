// ZOLA reminder engine — one endpoint, run frequently by cron. Each run it
// finds every reminder that's newly due and sends it once (tracked in
// reminder_log), across three areas:
//   • Clients: 24h before, 1h before, and an after-visit check-in
//   • Workers: a few minutes before each appointment, a "how did it go"
//     check-in ~2h after, and an overrun alert if they run past their end
//   • Inventory: a daily nudge to update counts + low-stock alerts to owner
// All timings/toggles are owner-configurable (Studio Manager → Settings).
// Delivery uses the shared notifier (SMS + email when connected, always
// in-app), so nothing is lost while Twilio/Resend are still being set up.
const { query, queryOne, execute, ensureTables } = require('./_team-db');
const notify = require('./_notify');

const APPT_HOURS = 2;
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'zolastudioempire@gmail.com';

function fmtTime(t){ const [h,m]=String(t).split(':').map(Number); return (h>12?h-12:(h||12))+':'+String(m).padStart(2,'0')+' '+(h>=12?'PM':'AM'); }
function fmtDate(d){ const [y,mo,day]=String(d).split('-'); return new Date(+y,+mo-1,+day).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}); }
function apptTsOf(date,time){ return new Date(String(date)+'T'+String(time||'00:00')+':00').getTime(); }

async function getSettings(){
  const rows = await query("SELECT key, value FROM site_settings WHERE key LIKE 'notif_%' OR key='owner_phone'").catch(()=>[]);
  const s = {}; for(const r of rows) s[r.key]=r.value;
  const on = (k,def)=> s[k]===undefined ? def : String(s[k])==='1';
  const num = (k,def)=> s[k]===undefined ? def : (Number(s[k])||def);
  return {
    workerPreOn: on('notif_worker_pre_on',true), workerPreMin: num('notif_worker_pre_min',10),
    workerCheckinOn: on('notif_worker_checkin_on',true), workerCheckinMin: num('notif_worker_checkin_min',120),
    workerOverrunOn: on('notif_worker_overrun_on',true),
    client24hOn: on('notif_client_24h_on',true), client1hOn: on('notif_client_1h_on',true), clientPostOn: on('notif_client_post_on',true),
    invDailyOn: on('notif_inv_daily_on',true), invDailyTime: s['notif_inv_daily_time']||'18:00',
    invLowOn: on('notif_inv_lowstock_on',true),
    ownerPhone: s['owner_phone']||'',
  };
}

module.exports = async (req, res) => {
  const key = req.headers['x-reminder-key'] || req.query.key;
  if (key !== (process.env.REMINDER_KEY || 'ZOLA-REMIND-2026')) return res.status(401).json({ error: 'Unauthorized' });

  await ensureTables();
  // So the dashboard can tell when reminders have quietly stopped running.
  try {
    await execute("INSERT INTO site_settings (key, value) VALUES ('cron_reminders_last', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [String(Date.now())]);
  } catch (_) {}
  const S = await getSettings();
  const now = Date.now();
  let sent = 0;
  const within = (v,a,b)=> v>=a && v<=b;

  async function fresh(rkey){
    try { const r = await execute('INSERT INTO reminder_log (rkey, ts) VALUES (?,?)', [rkey, now]); return true; }
    catch(_) { return false; } // PK clash = already sent
  }
  async function toClient(phone,email,name,sms,subject,html){
    if(phone) await notify.sendSMS(phone, sms).catch(()=>{});
    if(email) await notify.sendEmail(email, subject, html).catch(()=>{});
    sent++;
  }
  async function toWorker(mid,phone,email,title,body){
    if(mid) await notify.notifyInApp('member', mid, title, body).catch(()=>{});
    if(phone) await notify.sendSMS(phone, title+' — '+body).catch(()=>{});
    if(email) await notify.sendEmail(email, title, '<p>'+body+'</p>').catch(()=>{});
    sent++;
  }
  async function toOwner(title,body){
    await notify.notifyInApp('owner', null, title, body).catch(()=>{});
    if(S.ownerPhone) await notify.sendSMS(S.ownerPhone, title+' — '+body).catch(()=>{});
    await notify.sendEmail(OWNER_EMAIL, title, '<p>'+body+'</p>').catch(()=>{});
    sent++;
  }

  /* ── UNPAID DEPOSITS ──
     One confirmation and then silence is how a spot sits held for a week
     and then goes empty. This asks again on every run, escalating, and
     stops the moment it is paid. Never allowed to take the rest of the
     run down with it. */
  let depositChase = null;
  try { depositChase = await require('./_deposit-chase').run(); sent += depositChase.sent || 0; }
  catch (err) { depositChase = { error: String(err.message || err) }; }

  // ── APPOINTMENTS: owner-scheduled (team_appointments, worker-linked) ──
  const today = new Date().toISOString().slice(0,10);

  /* Porterville's clock, not the server's. The cron fires at 08:00 and
     17:00 UTC, which is midnight and 9am here, and a daily nudge sent on
     the server's idea of a day arrives in the middle of her night. */
  const LA = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const pad2 = n => String(n).padStart(2, '0');
  const laDay = LA.getFullYear() + '-' + pad2(LA.getMonth() + 1) + '-' + pad2(LA.getDate());
  const laHour = LA.getHours();
  const laShift = (ymd, n) =>
    new Date(Date.parse(ymd + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const y = new Date(now-2*86400000).toISOString().slice(0,10);
  const t2 = new Date(now+2*86400000).toISOString().slice(0,10);

  let team = [];
  try {
    team = await query(`SELECT a.id, a.team_member_id, a.client_name, a.client_phone, a.service, a.date, a.time, a.status,
      m.name AS worker_name, m.phone AS worker_phone, m.email AS worker_email
      FROM team_appointments a LEFT JOIN team_members m ON m.id=a.team_member_id
      WHERE a.date >= ? AND a.date <= ?`, [y, t2]);
  } catch(_) {}

  for (const a of team) {
    const ts = apptTsOf(a.date, a.time);
    const h = (ts - now)/3600000;
    const first = (a.client_name||'there').split(' ')[0];
    const dstr = fmtDate(a.date), tstr = fmtTime(a.time);

    // Client reminders
    if (S.client24hOn && within(h,20,28) && await fresh('c24:t'+a.id))
      await toClient(a.client_phone,null,first,`ZOLA reminder: your ${a.service} is tomorrow, ${dstr} at ${tstr}. See you then! Reply to reschedule (24h+ notice).`,`Your ZOLA appointment is tomorrow`,`<p>Hi ${first}, reminder — your <strong>${a.service}</strong> is tomorrow, ${dstr} at ${tstr}. ✦ ZOLA</p>`);
    if (S.client1hOn && within(h,0.5,1.5) && await fresh('c1:t'+a.id))
      await toClient(a.client_phone,null,first,`ZOLA: your ${a.service} is in about an hour (${tstr}). We're ready for you! ✦`,`See you in an hour`,`<p>Hi ${first}, your ${a.service} is in about an hour (${tstr}). ✦ ZOLA</p>`);
    if (S.clientPostOn && h <= -APPT_HOURS && h >= -(APPT_HOURS+3) && await fresh('cp:t'+a.id))
      await toClient(a.client_phone,null,first,`Thank you for coming to ZOLA today, ${first}! We'd love to see how your nails turned out — tag us @zola_officials_ ✦`,`Thank you from ZOLA ✦`,`<p>Thank you for visiting ZOLA today, ${first}! Tag us @zola_officials_ — we'd love to see your nails. ✦</p>`);

    // Worker reminders (linked to a specific artist)
    if (a.team_member_id) {
      const preH = S.workerPreMin/60;
      if (S.workerPreOn && within(h, 0, preH+0.09) && await fresh('wpre:t'+a.id))
        await toWorker(a.team_member_id,a.worker_phone,a.worker_email,`Upcoming appointment in ~${S.workerPreMin} min`,`${a.client_name||'Client'} — ${a.service} at ${tstr}.`);
      const sinceStart = -h; // hours since start
      if (S.workerCheckinOn && sinceStart >= (S.workerCheckinMin/60) && sinceStart <= (S.workerCheckinMin/60)+2 && await fresh('wchk:t'+a.id)) {
        await toWorker(a.team_member_id,a.worker_phone,a.worker_email,`How did that client go?`,`It's been about ${Math.round(S.workerCheckinMin/60*10)/10}h since ${a.client_name||'your client'} (${a.service}). Open your portal to add notes.`);
        await execute('INSERT INTO visit_checkins (appt_key, team_member_id, client_name, service, date, time, status, created_ts) VALUES (?,?,?,?,?,?,?,?)',
          ['t'+a.id, a.team_member_id, a.client_name||'', a.service||'', a.date, a.time, 'pending', now]).catch(()=>{});
      }
      const endTs = ts + APPT_HOURS*3600000;
      const scheduledEndH = (endTs - now)/3600000;
      const endStr = fmtTime(new Date(endTs).toTimeString().slice(0,5));
      if (S.workerOverrunOn && String(a.status)!=='completed' && scheduledEndH <= -0.25 && scheduledEndH >= -3 && await fresh('wover:t'+a.id))
        await toWorker(a.team_member_id,a.worker_phone,a.worker_email,`Running over?`,`You were scheduled to finish ${a.client_name||'this client'} by ${endStr}. It's later now — how did it go? Add your notes in the portal.`);
    }
  }

  // ── CLIENT reminders for member/guest bookings (appointments table) ──
  let mem = [];
  try {
    mem = await query(`SELECT a.id, a.appointment_date AS date, a.appointment_time AS time, a.service, a.status,
      m.full_name, m.phone, m.email, a.guest_name, a.guest_email
      FROM appointments a LEFT JOIN members m ON a.member_id=m.member_id
      WHERE a.status='SCHEDULED' AND a.appointment_date >= ? AND a.appointment_date <= ?`, [y, t2]);
  } catch(_) {}
  for (const a of mem) {
    const ts = apptTsOf(a.date, a.time), h=(ts-now)/3600000;
    const first=(a.full_name||a.guest_name||'there').split(' ')[0];
    const email=a.email||a.guest_email, phone=a.phone, tstr=fmtTime(a.time), dstr=fmtDate(a.date);
    if (S.client24hOn && within(h,20,28) && await fresh('c24:m'+a.id))
      await toClient(phone,email,first,`ZOLA reminder: your ${a.service} is tomorrow at ${tstr}. ✦`,`Your ZOLA appointment is tomorrow`,`<p>Hi ${first}, reminder — your <strong>${a.service}</strong> is tomorrow, ${dstr} at ${tstr}. ✦ ZOLA</p>`);
    if (S.client1hOn && within(h,0.5,1.5) && await fresh('c1:m'+a.id))
      await toClient(phone,email,first,`ZOLA: your ${a.service} is in about an hour (${tstr}). ✦`,`See you in an hour`,`<p>Hi ${first}, your ${a.service} is in about an hour (${tstr}). ✦ ZOLA</p>`);
    if (S.clientPostOn && h <= -APPT_HOURS && h >= -(APPT_HOURS+3) && await fresh('cp:m'+a.id))
      await toClient(phone,email,first,`Thank you for coming to ZOLA today! Tag us @zola_officials_ ✦`,`Thank you from ZOLA ✦`,`<p>Thank you for visiting ZOLA today, ${first}! Tag us @zola_officials_ ✦</p>`);
  }

  // ── INVENTORY: daily update nudge + low-stock alerts ──
  const nowHM = new Date().toTimeString().slice(0,5);
  if (S.invDailyOn && nowHM >= S.invDailyTime && await fresh('invdaily:'+today)) {
    const workers = await query('SELECT id, phone, email FROM team_members WHERE active=1').catch(()=>[]);
    for (const w of workers) await toWorker(w.id, w.phone, w.email, 'Daily inventory check ✦', 'Please update the studio inventory counts before you leave — mark anything that ran low today.');
  }
  if (S.invLowOn) {
    const low = await query('SELECT id, name, qty, low_threshold, unit FROM studio_inventory WHERE qty <= low_threshold').catch(()=>[]);
    for (const it of low) {
      if (await fresh('invlow:'+it.id+':'+today))
        await toOwner('Low stock: '+it.name, `${it.name} is down to ${it.qty}${it.unit?' '+it.unit:''} (alert at ${it.low_threshold}). Time to reorder.`);
    }
  }

  // ── STRIPE HOUSEKEEPING ──
  // Abandoned payments cancelled so Stripe's list only shows what matters,
  // and any money that arrived with no booking reported the same day.
  let stripeSweep = null;
  try {
    const hy = require('./_stripe-hygiene');
    const sw = await hy.sweep({ dryRun: false, minAgeMin: 60 });
    stripeSweep = { cancelled: sw.cancelled, failed: (sw.failed || []).length };
    const lost = await hy.orphans(72);
    for (const o of lost) {
      if (await fresh('orphan:' + o.id)) {
        const amt = '$' + (o.received / 100).toFixed(2);
        await toOwner('💳 Payment with no booking: ' + amt,
          (o.client || 'Someone') + ' paid ' + amt + ' (' + o.description.slice(0, 80) + ') but no appointment is linked to it. Check Studio Manager → Deposits and add or fix their booking.');
      }
    }
  } catch (_) {}

  /* ── DOES THE BOOK AGREE WITH STRIPE? ──
     A deposit written onto an appointment is a claim about money; Stripe is
     the money. Once, a payment recorded twice credited a client $255
     against $175 of charges, and the only reason anybody noticed was that
     Zahra read her own Stripe account. Checked here every day instead. */
  let depositAudit = null;
  try {
    const audit = await require('./_stripe-hygiene').depositAudit();
    depositAudit = { checked: audit.checked, over: audit.over.length };
    for (const o of audit.over.slice(0, 5)) {
      if (await fresh('overcredit:' + o.id)) {
        await toOwner('⚠️ A deposit says more was paid than Stripe took',
          (o.client || 'A client') + ' on ' + o.date + ': the appointment is credited $'
          + (o.recorded / 100).toFixed(2) + ' but Stripe shows $' + (o.charged / 100).toFixed(2)
          + '. They would be undercharged $' + ((o.recorded - o.charged) / 100).toFixed(2)
          + ' at the desk. Studio Manager → Deposits.');
      }
    }
  } catch (_) {}

  /* ── ANYBODY WHO STILL HAS NO DIRECTIONS ──
     The arrival email is sent the moment a deposit lands, but a deposit can
     also be settled by a correction or by a card on file at rebooking. This
     catches those, so nobody drives out to a studio behind a house with no
     address and nobody's number. */
  let arrivalMail = null;
  try { arrivalMail = await require('./_arrival-mail').sweep({ limit: 25 }); } catch (_) {}

  /* ── POST THE LINK TODAY ──
     One text each morning to whoever is meant to be posting, carrying the
     link and a caption to paste. Only to people who have not already
     ticked today, so doing it early means no nudge at all. */
  let postNudge = null;
  try {
    const social = require('./_social');
    const cfg = await social.settings();
    const BOOK = 'https://zolanailstudio.com/booking.html';

    /* Seven openers, so a daily habit does not become the same sentence
       every day. Each one is something a client could act on. */
    const CAPTIONS = [
      'New set from today — booking link in bio. Porterville ✨',
      'Still have slots this week. Tap the link and pick your time ✨',
      'This is what a structured manicure looks like 3 weeks in. Link to book ✨',
      'Taking bookings for this week — link in bio, deposit holds your spot ✨',
      'Send this to whoever does your nails — or come to us. Link in bio ✨',
      'Before and after. Book yours at the link ✨',
      'Your nails do not have to grow out ugly. Link in bio ✨',
    ];

    const onlyIds = String(process.env.POSTING_NUDGE_IDS || '4')
      .split(',').map(x => Number(x.trim())).filter(Boolean);

    if (laHour >= 8 && laHour < 20) {
      const streak = await social.postingStreak({ days: 30 });
      for (const p of streak.people) {
        if (onlyIds.indexOf(p.member_id) < 0) continue;
        if (p.posted_today) continue;
        if (!(await fresh('postnudge:' + p.member_id + ':' + laDay))) continue;

        const who = await queryOne('SELECT id, name, phone, email FROM team_members WHERE id=?', [p.member_id])
          .catch(() => null);
        if (!who) continue;

        const caption = CAPTIONS[LA.getDay() % CAPTIONS.length];
        const run = p.streak > 1 ? (' You are ' + p.streak + ' days in a row — keep it.') : '';
        await toWorker(who.id, who.phone, who.email,
          'Post the booking link today ✦',
          'Post one thing today and put this link on it — story, caption or bio. '
          + 'Even on a day off.' + run + '\n\n' + BOOK + '\n\nCaption you can paste:\n'
          + caption + '\n\nThen tick it off in your portal so Zahra can see it.');
        postNudge = (postNudge || 0) + 1;
      }
    }

    /* The end of the Pacific day. A single missed day is life; three in a
       row is a habit coming apart, and that is worth telling her once
       rather than her finding out a month later. */
    if (laHour < 6) {
      const yday = laShift(laDay, -1);
      const streak = await social.postingStreak({ days: 30 });
      for (const p of streak.people) {
        if (onlyIds.indexOf(p.member_id) < 0) continue;
        const missedYesterday = !(p.recent || []).some(r => r.day === yday && r.done);
        if (!missedYesterday) continue;
        const run = (p.recent || []).slice(1, 4).filter(r => !r.done).length;
        if (run >= 3 && await fresh('postmiss:' + p.member_id + ':' + yday)) {
          await toOwner('No posts from ' + (p.name || 'the team') + ' for 3 days',
            (p.name || 'She') + ' has not ticked the daily booking-link post since '
            + (p.last_posted || 'we started counting')
            + '. The text goes out every morning at 9. Worth a word today — '
            + 'Studio Manager → Social media → who posted.');
        }
      }
    }
  } catch (_) {}

  /* ── THE MONTHLY RECAP, ON THE 1st ──
     Last month's money and clients, the change either way, and what to do
     this month. Sent once, keyed on the month, so a second cron run on the
     1st cannot send it twice. */
  let recapMail = null;
  try {
    if (LA.getDate() === 1 && laHour >= 8) {
      const recap = require('./_recap');
      const ym = recap.prevMonth(laDay.slice(0, 7));
      if (await fresh('recapmail:' + ym)) {
        recapMail = await recap.emailRecap({ month: ym, dry: false });
        sent++;
      }
    }
  } catch (_) {}

  // ── ANYTHING BROKEN ──
  // The same list as the dashboard's "Needs attention", but only the things
  // worth a text, and each at most once every three days.
  let alerts = [];
  try { alerts = await require('./_dashboard').notifyOwner(toOwner, fresh); } catch (_) {}

  return res.json({ ok: true, sent, deposit_chase: depositChase, alerts, stripe_sweep: stripeSweep, deposit_audit: depositAudit, arrival_mail: arrivalMail, post_nudge: postNudge, recap_mail: recapMail && { to: recapMail.to, subject: recapMail.subject }, at: new Date().toISOString() });
};
