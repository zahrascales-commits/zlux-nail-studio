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

  // ── APPOINTMENTS: owner-scheduled (team_appointments, worker-linked) ──
  const today = new Date().toISOString().slice(0,10);
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

  return res.json({ ok: true, sent, at: new Date().toISOString() });
};
