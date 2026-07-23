// Shared Turso-backed data layer for the Team Member system.
// Self-initializes its tables so it works on a fresh serverless instance
// without a separate migration step. Persists across devices (unlike the
// in-memory store used by the legacy worker portal).
const { query, queryOne, execute } = require('./_db');

let _ready = false;

async function ensureTables() {
  if (_ready) return;
  await execute(`CREATE TABLE IF NOT EXISTS team_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'Nail Artist',
    pin TEXT NOT NULL,
    color TEXT DEFAULT '#C4A882',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS team_appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_member_id INTEGER,
    client_name TEXT,
    client_phone TEXT,
    service TEXT,
    date TEXT,
    time TEXT,
    notes TEXT,
    status TEXT DEFAULT 'scheduled',
    chat_token TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS team_chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    appointment_id INTEGER,
    sender TEXT,
    sender_name TEXT,
    body TEXT,
    ts INTEGER
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    contact TEXT,
    message TEXT,
    source TEXT DEFAULT 'contact',
    status TEXT DEFAULT 'new',
    ts INTEGER
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS site_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient TEXT,          -- 'owner' | 'member'
    member_id INTEGER,
    title TEXT,
    body TEXT,
    read INTEGER DEFAULT 0,
    ts INTEGER
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT,
    phone TEXT,
    likes TEXT DEFAULT '',
    dislikes TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    marketing_opt_in INTEGER DEFAULT 0,
    visits INTEGER DEFAULT 0,
    last_service TEXT DEFAULT '',
    last_visit TEXT DEFAULT '',
    created_ts INTEGER
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS client_profiles (
    email TEXT PRIMARY KEY,
    answers TEXT DEFAULT '{}',
    note TEXT DEFAULT '',
    updated_ts INTEGER
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS site_photos (
    slot TEXT PRIMARY KEY,
    data_url TEXT,
    updated_ts INTEGER
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS client_inspo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    confirmation TEXT,
    client_name TEXT,
    client_email TEXT,
    service TEXT,
    appt_date TEXT,
    data_url TEXT,
    ts INTEGER
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS worker_skills (
    team_member_id INTEGER NOT NULL,
    service_name TEXT NOT NULL,
    PRIMARY KEY (team_member_id, service_name)
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS schedule_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    team_member_ids TEXT NOT NULL,
    note TEXT DEFAULT '',
    created_ts INTEGER
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL DEFAULT 0,
    description TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    created_ts INTEGER
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS class_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id INTEGER NOT NULL,
    class_name TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    buyer_name TEXT DEFAULT '',
    buyer_email TEXT DEFAULT '',
    buyer_phone TEXT DEFAULT '',
    payment_intent_id TEXT,
    ts INTEGER
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS analytics_pageviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    path TEXT NOT NULL,
    referrer TEXT DEFAULT '',
    ts INTEGER NOT NULL
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS analytics_exits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    path TEXT NOT NULL,
    max_scroll_pct INTEGER DEFAULT 0,
    time_on_page_ms INTEGER DEFAULT 0,
    ts INTEGER NOT NULL
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS personal_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER,
    member_name TEXT DEFAULT '',
    date TEXT NOT NULL,
    all_day INTEGER DEFAULT 0,
    start_time TEXT,
    end_time TEXT,
    note TEXT DEFAULT '',
    created_ts INTEGER
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS day_hours (
    date TEXT PRIMARY KEY,
    open_time TEXT,
    close_time TEXT,
    closed INTEGER DEFAULT 0
  )`);
  // Columns added after launch — idempotent, ignored once they exist
  for (const sql of [
    "ALTER TABLE team_members ADD COLUMN phone TEXT DEFAULT ''",
    "ALTER TABLE team_members ADD COLUMN email TEXT DEFAULT ''",
    "ALTER TABLE team_members ADD COLUMN restricted INTEGER DEFAULT 0",
    "ALTER TABLE team_members ADD COLUMN bio TEXT DEFAULT ''",
    "ALTER TABLE team_members ADD COLUMN show_on_site INTEGER DEFAULT 0",
    "ALTER TABLE team_members ADD COLUMN title TEXT DEFAULT ''",
  ]) { try { await execute(sql); } catch (_) {} }
  _ready = true;
}

function token(n = 12) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function uniquePin() {
  for (let i = 0; i < 40; i++) {
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    const clash = await queryOne('SELECT id FROM team_members WHERE pin = ?', [pin]);
    if (!clash) return pin;
  }
  return String(Date.now()).slice(-4);
}

module.exports = { query, queryOne, execute, ensureTables, token, uniquePin };
