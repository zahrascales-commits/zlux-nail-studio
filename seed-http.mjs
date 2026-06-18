// Seeds Turso via HTTP API — no native modules needed
import bcrypt from './node_modules/bcryptjs/dist/bcrypt.js';

const DB_URL = process.env.TURSO_DATABASE_URL.replace('libsql://', 'https://');
const TOKEN  = process.env.TURSO_AUTH_TOKEN;

async function pipeline(requests) {
  const r = await fetch(`${DB_URL}/v2/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const errs = data.results?.filter(x => x.type === 'error');
  if (errs?.length) errs.forEach(e => console.error('SQL error:', JSON.stringify(e)));
  return data;
}

async function exec(sql, args = []) {
  return pipeline([{ type: 'execute', stmt: { sql, args: args.map(v => v === null ? { type: 'null' } : { type: typeof v === 'number' ? 'integer' : 'text', value: String(v) }) } }]);
}

async function count(table) {
  const d = await exec(`SELECT COUNT(*) as n FROM ${table}`);
  const val = d.results?.[0]?.response?.result?.rows?.[0]?.[0];
  return Number(val?.value ?? val ?? 0);
}

async function run() {
  console.log('Creating tables...');

  await pipeline([
    { type: 'execute', stmt: { sql: `CREATE TABLE IF NOT EXISTS members (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, phone TEXT, date_of_birth TEXT, heard_about TEXT, tier TEXT NOT NULL DEFAULT 'SIGNATURE', member_id TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, qr_secret TEXT NOT NULL, stripe_customer_id TEXT, stripe_subscription_id TEXT, referral_code TEXT UNIQUE, referred_by_code TEXT, no_show_count INTEGER DEFAULT 0, flagged INTEGER DEFAULT 0, flag_reason TEXT, waitlisted INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), membership_started_at TEXT, next_billing_at TEXT, services_used_month INTEGER DEFAULT 0, services_reset_month TEXT)` } },
    { type: 'execute', stmt: { sql: `CREATE TABLE IF NOT EXISTS staff (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'ARTIST', active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))` } },
    { type: 'execute', stmt: { sql: `CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, last_login TEXT)` } },
    { type: 'execute', stmt: { sql: `CREATE TABLE IF NOT EXISTS appointments (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT, guest_name TEXT, guest_email TEXT, staff_id INTEGER REFERENCES staff(id), service TEXT NOT NULL, addons TEXT DEFAULT '[]', appointment_date TEXT NOT NULL, appointment_time TEXT NOT NULL, status TEXT DEFAULT 'SCHEDULED', notes TEXT, total_cents INTEGER DEFAULT 0, deposit_cents INTEGER DEFAULT 0, deposit_paid INTEGER DEFAULT 0, stripe_pi_id TEXT, created_at TEXT DEFAULT (datetime('now')), cancelled_at TEXT, cancel_reason TEXT, completed_at TEXT, review_sent INTEGER DEFAULT 0)` } },
    { type: 'execute', stmt: { sql: `CREATE TABLE IF NOT EXISTS nail_history (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL, appointment_id INTEGER REFERENCES appointments(id), service TEXT, shape TEXT, length TEXT, color TEXT, nail_art TEXT, products_used TEXT DEFAULT '[]', allergies TEXT, sensitivities TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')))` } },
    { type: 'execute', stmt: { sql: `CREATE TABLE IF NOT EXISTS member_preferences (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT UNIQUE NOT NULL, preferred_artist_id INTEGER REFERENCES staff(id), preferred_shape TEXT, preferred_length TEXT, allergies TEXT, sensitivities TEXT, notes TEXT, updated_at TEXT DEFAULT (datetime('now')))` } },
    { type: 'execute', stmt: { sql: `CREATE TABLE IF NOT EXISTS service_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL, month_year TEXT NOT NULL, services_used INTEGER DEFAULT 0, russian_mani_used INTEGER DEFAULT 0, scrub_used INTEGER DEFAULT 0, birthday_used INTEGER DEFAULT 0, UNIQUE(member_id, month_year))` } },
    { type: 'execute', stmt: { sql: `CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, product_name TEXT NOT NULL, category TEXT, quantity INTEGER DEFAULT 0, low_stock_threshold INTEGER DEFAULT 5, unit TEXT DEFAULT 'units', notes TEXT, last_updated TEXT DEFAULT (datetime('now')))` } },
    { type: 'execute', stmt: { sql: `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_role TEXT NOT NULL, from_id TEXT NOT NULL, to_role TEXT NOT NULL, to_id TEXT NOT NULL, subject TEXT, body TEXT NOT NULL, read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))` } },
    { type: 'execute', stmt: { sql: `CREATE TABLE IF NOT EXISTS announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, tier_target TEXT DEFAULT 'ALL', subject TEXT, body TEXT NOT NULL, sent_at TEXT DEFAULT (datetime('now')))` } },
    { type: 'execute', stmt: { sql: `CREATE TABLE IF NOT EXISTS waitlist (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT, tier TEXT DEFAULT 'BLACK_CARD', invited INTEGER DEFAULT 0, invited_at TEXT, created_at TEXT DEFAULT (datetime('now')))` } },
    { type: 'execute', stmt: { sql: `CREATE TABLE IF NOT EXISTS referrals (id INTEGER PRIMARY KEY AUTOINCREMENT, referrer_member_id TEXT NOT NULL, referee_email TEXT, referee_member_id TEXT, status TEXT DEFAULT 'PENDING', credit_type TEXT, created_at TEXT DEFAULT (datetime('now')))` } },
    { type: 'execute', stmt: { sql: `CREATE TABLE IF NOT EXISTS no_shows (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL, appointment_id INTEGER REFERENCES appointments(id), date TEXT NOT NULL, fee_charged INTEGER DEFAULT 0, waived INTEGER DEFAULT 0, waive_reason TEXT, created_at TEXT DEFAULT (datetime('now')))` } },
    { type: 'execute', stmt: { sql: `CREATE TABLE IF NOT EXISTS schedule_config (id INTEGER PRIMARY KEY, black_card_days_ahead INTEGER DEFAULT 20, luxe_days_ahead INTEGER DEFAULT 13, signature_days_ahead INTEGER DEFAULT 3, public_days_ahead INTEGER DEFAULT 0, studio_open_time TEXT DEFAULT '06:00', studio_close_time TEXT DEFAULT '22:00', updated_at TEXT DEFAULT (datetime('now')))` } },
    { type: 'execute', stmt: { sql: `CREATE TABLE IF NOT EXISTS availability_blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id INTEGER, block_date TEXT NOT NULL, start_time TEXT, end_time TEXT, reason TEXT, created_at TEXT DEFAULT (datetime('now')))` } },
    { type: 'execute', stmt: { sql: `CREATE TABLE IF NOT EXISTS security_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, ip TEXT, user_agent TEXT, details TEXT, created_at TEXT DEFAULT (datetime('now')))` } },
    { type: 'execute', stmt: { sql: `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, role TEXT NOT NULL, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))` } },
  ]);
  console.log('✓ 17 tables created.');

  const configN = await count('schedule_config');
  if (configN === 0) {
    await exec(`INSERT INTO schedule_config (id,black_card_days_ahead,luxe_days_ahead,signature_days_ahead,public_days_ahead,studio_open_time,studio_close_time) VALUES (1,20,13,3,0,'06:00','22:00')`);
    console.log('✓ Schedule config seeded.');
  }

  const adminN = await count('admin');
  if (adminN === 0) {
    const adminHash = bcrypt.hashSync('ZluxAdmin2026!', 10);
    await exec(`INSERT INTO admin (email, password_hash) VALUES (?, ?)`, ['zahrascales@gmail.com', adminHash]);
    console.log('✓ Admin seeded: zahrascales@gmail.com / ZluxAdmin2026!');
  } else { console.log('  Admin already exists — skipped.'); }

  const staffN = await count('staff');
  if (staffN === 0) {
    const emmaHash = bcrypt.hashSync('Emma2026!', 10);
    const lilyHash = bcrypt.hashSync('Lily2026!', 10);
    await exec(`INSERT INTO staff (name, email, password_hash, role) VALUES (?, ?, ?, ?)`, ['Emma Magana', 'emma@zluxnails.com', emmaHash, 'ARTIST']);
    await exec(`INSERT INTO staff (name, email, password_hash, role) VALUES (?, ?, ?, ?)`, ['Lily Byers', 'lily@zluxnails.com', lilyHash, 'ARTIST']);
    console.log('✓ Staff seeded: Emma (Emma2026!) and Lily (Lily2026!)');
  } else { console.log('  Staff already exist — skipped.'); }

  console.log('\n✓ Database is ready. CHANGE ALL PASSWORDS on first login.');
  process.exit(0);
}

run().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
