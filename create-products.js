/**
 * create-products.js — bulk-create one-time (non-recurring) products in Stripe.
 *
 * Each item below becomes a Stripe Product with a single one-time USD Price
 * attached. Run it as many times as you like — but note Stripe does NOT
 * de-duplicate, so running it twice creates two copies of everything.
 *
 * Usage:  node create-products.js            (see README notes at the bottom)
 */

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────
// YOUR PRODUCT LIST — edit this array.
// price is in DOLLARS (e.g. 45 or 45.50); it's converted to cents for Stripe.
// ─────────────────────────────────────────────────────────────
const PRODUCTS = [
  // Drop-in services (full price — the site charges a 50% deposit at booking)
  { name: 'Organic Structured Manicure',            price: 90 },
  { name: 'Short Gel X',                            price: 95 },
  { name: 'Medium Gel X',                           price: 100 },
  { name: 'Long Gel X',                             price: 110 },
  { name: 'Short Acrylic',                          price: 95 },
  { name: 'Medium Acrylic',                         price: 100 },
  { name: 'Long Acrylic',                           price: 110 },
  { name: 'Russian Dry Pedicure',                   price: 95 },
  { name: 'Russian Dry Pedicure — Full Correction', price: 125 },

  // Add-ons
  { name: 'Removal',                                price: 35 },
  { name: 'Russian Manicure',                       price: 30 },
  { name: 'Nail Art',                               price: 25 },
  { name: 'Scrub Treatment',                        price: 20 },
  { name: 'Lotion Massage',                         price: 15 },
];

// ─────────────────────────────────────────────────────────────
// Load STRIPE_SECRET_KEY. Prefers a real environment variable; falls back to
// a local .env file (already git-ignored in this repo) so the key is never
// committed. Tiny inline parser so no extra dependency is needed.
// ─────────────────────────────────────────────────────────────
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // strip surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile();

const SECRET = process.env.STRIPE_SECRET_KEY;
if (!SECRET) {
  console.error('\n✖ STRIPE_SECRET_KEY is not set.');
  console.error('  Set it as an environment variable, or put it in a .env file next to this script:');
  console.error('  STRIPE_SECRET_KEY=sk_test_xxxxx\n');
  process.exit(1);
}

const stripe = require('stripe')(SECRET);
const isLive = SECRET.startsWith('sk_live_');

// dollars -> integer cents, rounded so 45.10 can't land on 4509.999...
const toCents = dollars => Math.round(Number(dollars) * 100);

async function main() {
  const valid = PRODUCTS.filter(p => p && p.name);
  console.log(`\nCreating ${valid.length} product(s) in Stripe ${isLive ? 'LIVE' : 'TEST'} mode…`);
  if (isLive) console.log('⚠  LIVE mode — these will appear in your real product catalog.\n');
  else console.log('');

  let succeeded = 0;
  const failures = [];

  for (const item of PRODUCTS) {
    const name = item && item.name ? String(item.name).trim() : '';
    try {
      if (!name) throw new Error('missing "name"');
      const cents = toCents(item.price);
      if (!Number.isFinite(cents) || cents < 0) throw new Error(`invalid price: ${item.price}`);

      const product = await stripe.products.create({ name });
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: cents,       // one-time price: no `recurring` field
        currency: 'usd',
      });

      succeeded++;
      console.log(`✓ ${name}`);
      console.log(`    product: ${product.id}`);
      console.log(`    price:   ${price.id}  ($${(cents / 100).toFixed(2)})`);
    } catch (err) {
      // One bad item must never stop the rest of the run.
      const label = name || '(unnamed item)';
      failures.push({ name: label, reason: err.message });
      console.error(`✗ ${label} — ${err.message}`);
    }
  }

  console.log('\n────────── Summary ──────────');
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Failed:    ${failures.length}`);
  if (failures.length) {
    console.log('\nFailed items:');
    for (const f of failures) console.log(`  • ${f.name} — ${f.reason}`);
  }
  console.log('');

  // Non-zero exit if anything failed, so CI/scripts can detect it.
  if (failures.length) process.exitCode = 1;
}

main().catch(err => {
  console.error('\n✖ Fatal error:', err.message, '\n');
  process.exit(1);
});
