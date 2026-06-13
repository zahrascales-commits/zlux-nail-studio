const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'zlux.db');

function getDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function initDb() {
  const db = getDb();

  db.exec(`
    -- ─────────────────────────────────────
    -- MEMBERS
    -- ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS members (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name             TEXT    NOT NULL,
      email                 TEXT    UNIQUE NOT NULL,
      phone                 TEXT,
      date_of_birth         TEXT,
      heard_about           TEXT,
      tier                  TEXT    NOT NULL DEFAULT 'SIGNATURE',
      member_id             TEXT    UNIQUE NOT NULL,
      password_hash         TEXT    NOT NULL,
      qr_secret             TEXT    NOT NULL,
      stripe_customer_id    TEXT,
      stripe_subscription_id TEXT,
      referral_code         TEXT    UNIQUE,
      referred_by_code      TEXT,
      no_show_count         INTEGER DEFAULT 0,
      flagged               INTEGER DEFAULT 0,
      flag_reason           TEXT,
      waitlisted            INTEGER DEFAULT 0,
      created_at            TEXT    DEFAULT (datetime('now')),
      membership_started_at TEXT,
      next_billing_at       TEXT,
      services_used_month   INTEGER DEFAULT 0,
      services_reset_month  TEXT
    );

    -- ─────────────────────────────────────
    -- STAFF
    -- ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS staff (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      email        TEXT    UNIQUE NOT NULL,
      password_hash TEXT   NOT NULL,
      role         TEXT    NOT NULL DEFAULT 'ARTIST',
      active       INTEGER DEFAULT 1,
      created_at   TEXT    DEFAULT (datetime('now'))
    );

    -- ─────────────────────────────────────
    -- ADMIN (single record for Zahra)
    -- ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS admin (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    UNIQUE NOT NULL,
      password_hash TEXT    NOT NULL,
      last_login    TEXT
    );

    -- ─────────────────────────────────────
    -- APPOINTMENTS
    -- ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS appointments (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id        TEXT,
      guest_name       TEXT,
      guest_email      TEXT,
      staff_id         INTEGER REFERENCES staff(id),
      service          TEXT    NOT NULL,
      addons           TEXT    DEFAULT '[]',
      appointment_date TEXT    NOT NULL,
      appointment_time TEXT    NOT NULL,
      status           TEXT    DEFAULT 'SCHEDULED',
      notes            TEXT,
      total_cents      INTEGER DEFAULT 0,
      deposit_cents    INTEGER DEFAULT 0,
      deposit_paid     INTEGER DEFAULT 0,
      stripe_pi_id     TEXT,
      created_at       TEXT    DEFAULT (datetime('now')),
      cancelled_at     TEXT,
      cancel_reason    TEXT,
      completed_at     TEXT,
      review_sent      INTEGER DEFAULT 0
    );

    -- ─────────────────────────────────────
    -- NAIL HISTORY
    -- ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS nail_history (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id      TEXT    NOT NULL,
      appointment_id INTEGER REFERENCES appointments(id),
      service        TEXT,
      shape          TEXT,
      length         TEXT,
      color          TEXT,
      nail_art       TEXT,
      products_used  TEXT    DEFAULT '[]',
      allergies      TEXT,
      sensitivities  TEXT,
      notes          TEXT,
      created_at     TEXT    DEFAULT (datetime('now'))
    );

    -- ─────────────────────────────────────
    -- MEMBER PREFERENCES (allergies, shape, etc.)
    -- ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS member_preferences (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id     TEXT    UNIQUE NOT NULL,
      preferred_artist_id INTEGER REFERENCES staff(id),
      preferred_shape TEXT,
      preferred_length TEXT,
      allergies     TEXT,
      sensitivities TEXT,
      notes         TEXT,
      updated_at    TEXT    DEFAULT (datetime('now'))
    );

    -- ─────────────────────────────────────
    -- MONTHLY SERVICE USAGE
    -- ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS service_usage (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id           TEXT    NOT NULL,
      month_year          TEXT    NOT NULL,
      services_used       INTEGER DEFAULT 0,
      russian_mani_used   INTEGER DEFAULT 0,
      scrub_used          INTEGER DEFAULT 0,
      birthday_used       INTEGER DEFAULT 0,
      UNIQUE(member_id, month_year)
    );

    -- ─────────────────────────────────────
    -- INVENTORY
    -- ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS inventory (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      product_name        TEXT    NOT NULL,
      category            TEXT,
      quantity            INTEGER DEFAULT 0,
      low_stock_threshold INTEGER DEFAULT 5,
      unit                TEXT    DEFAULT 'units',
      notes               TEXT,
      last_updated        TEXT    DEFAULT (datetime('now'))
    );

    -- ─────────────────────────────────────
    -- MESSAGES
    -- ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      from_role  TEXT NOT NULL,
      from_id    TEXT NOT NULL,
      to_role    TEXT NOT NULL,
      to_id      TEXT NOT NULL,
      subject    TEXT,
      body       TEXT NOT NULL,
      read       INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ─────────────────────────────────────
    -- ANNOUNCEMENTS
    -- ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS announcements (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tier_target  TEXT    DEFAULT 'ALL',
      subject      TEXT,
      body         TEXT    NOT NULL,
      sent_at      TEXT    DEFAULT (datetime('now'))
    );

    -- ─────────────────────────────────────
    -- WAITLIST
    -- ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS waitlist (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      email      TEXT    NOT NULL,
      phone      TEXT,
      tier       TEXT    DEFAULT 'BLACK_CARD',
      invited    INTEGER DEFAULT 0,
      invited_at TEXT,
      created_at TEXT    DEFAULT (datetime('now'))
    );

    -- ─────────────────────────────────────
    -- REFERRALS
    -- ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS referrals (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_member_id  TEXT    NOT NULL,
      referee_email       TEXT,
      referee_member_id   TEXT,
      status              TEXT    DEFAULT 'PENDING',
      credit_type         TEXT,
      created_at          TEXT    DEFAULT (datetime('now'))
    );

    -- ─────────────────────────────────────
    -- NO SHOWS
    -- ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS no_shows (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id      TEXT    NOT NULL,
      appointment_id INTEGER REFERENCES appointments(id),
      date           TEXT    NOT NULL,
      fee_charged    INTEGER DEFAULT 0,
      waived         INTEGER DEFAULT 0,
      waive_reason   TEXT,
      created_at     TEXT    DEFAULT (datetime('now'))
    );

    -- ─────────────────────────────────────
    -- SCHEDULE CONFIG
    -- ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS schedule_config (
      id                    INTEGER PRIMARY KEY,
      black_card_days_ahead INTEGER DEFAULT 20,
      luxe_days_ahead       INTEGER DEFAULT 13,
      signature_days_ahead  INTEGER DEFAULT 3,
      public_days_ahead     INTEGER DEFAULT 0,
      studio_open_time      TEXT    DEFAULT '06:00',
      studio_close_time     TEXT    DEFAULT '22:00',
      updated_at            TEXT    DEFAULT (datetime('now'))
    );

    -- ─────────────────────────────────────
    -- AVAILABILITY BLOCKS
    -- ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS availability_blocks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id    INTEGER,
      block_date  TEXT    NOT NULL,
      start_time  TEXT,
      end_time    TEXT,
      reason      TEXT,
      created_at  TEXT    DEFAULT (datetime('now'))
    );

    -- ─────────────────────────────────────
    -- SECURITY LOG
    -- ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS security_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      event      TEXT    NOT NULL,
      ip         TEXT,
      user_agent TEXT,
      details    TEXT,
      created_at TEXT    DEFAULT (datetime('now'))
    );

    -- ─────────────────────────────────────
    -- SESSION TOKENS
    -- ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT    PRIMARY KEY,
      role       TEXT    NOT NULL,
      user_id    TEXT    NOT NULL,
      expires_at TEXT    NOT NULL,
      created_at TEXT    DEFAULT (datetime('now'))
    );
  `);

  // Seed schedule config if empty
  const configCount = db.prepare('SELECT COUNT(*) as n FROM schedule_config').get();
  if (configCount.n === 0) {
    db.prepare(`INSERT INTO schedule_config (id, black_card_days_ahead, luxe_days_ahead, signature_days_ahead, public_days_ahead, studio_open_time, studio_close_time) VALUES (1, 20, 13, 3, 0, '06:00', '22:00')`).run();
  }

  // Seed admin (Zahra) — password should be changed immediately on first login
  const adminCount = db.prepare('SELECT COUNT(*) as n FROM admin').get();
  if (adminCount.n === 0) {
    // Default password: ZluxAdmin2026! — MUST be changed
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('ZluxAdmin2026!', 10);
    db.prepare('INSERT INTO admin (email, password_hash) VALUES (?, ?)').run('zahrascales@gmail.com', hash);
  }

  // Seed staff (Emma and Lily) — passwords should be changed on first login
  const staffCount = db.prepare('SELECT COUNT(*) as n FROM staff').get();
  if (staffCount.n === 0) {
    const bcrypt = require('bcryptjs');
    const emmaHash = bcrypt.hashSync('Emma2026!', 10);
    const lilyHash = bcrypt.hashSync('Lily2026!', 10);
    db.prepare('INSERT INTO staff (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run('Emma Magana', 'emma@zluxnails.com', emmaHash, 'ARTIST');
    db.prepare('INSERT INTO staff (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run('Lily Byers', 'lily@zluxnails.com', lilyHash, 'ARTIST');
  }

  db.close();
}

module.exports = { getDb, initDb, DB_PATH };
