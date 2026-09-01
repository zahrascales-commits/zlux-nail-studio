#!/usr/bin/env node
/* Does every payment keep the client's card?
 *
 * Every payment path in this studio had to be fixed one at a time, and the
 * busiest one — online bookings — was still missed for weeks. Nobody noticed
 * because a payment that does not keep the card works perfectly well; it
 * just costs the client a minute at the desk every visit forever.
 *
 * So this looks instead of trusting. Run it after adding anything that takes
 * money:
 *
 *     node scripts/check-cards-saved.js
 *
 * It reads the code rather than calling Stripe, so it is safe to run any
 * time and needs no keys.
 */
const fs = require('fs');
const path = require('path');

const API = path.join(__dirname, '..', 'api');

/* Charging a card that is already saved, or reading one back, has nothing to
   save — flagging those would train everybody to ignore this. */
const NOT_A_NEW_CARD = [
  '_kiosk-charge.js',   // charges a card already on file
  '_save-card.js',      // a SetupIntent: saving is the whole point
  '_member-signup.js',  // a subscription attaches the card by nature
  '_upgrade.js',        // changes an existing subscription
  '_manager.js',        // switching somebody between plans
];

const results = [];

for (const file of fs.readdirSync(API).filter(f => f.endsWith('.js'))) {
  if (NOT_A_NEW_CARD.includes(file)) continue;
  const src = fs.readFileSync(path.join(API, file), 'utf8');
  const lines = src.split(/\r?\n/);

  lines.forEach((line, i) => {
    /* A comment is a line starting with a slash pair. Matching // anywhere
       skipped every https:// URL — which is every real Stripe call — so this
       reported all-clear while looking at almost nothing. */
    const isComment = /^\s*(\/\/|\*)/.test(line);

    /* Creating one, not reading one back. A read appends the id to the path
       — .../payment_intents/' + id — while a create posts to the collection
       itself. Treating the two the same flagged verifyPaymentIntent, which
       has no card to keep because the payment already happened. */
    const readsOne = /payment_intents['"]?\s*\+|payment_intents\//.test(line);

    const makesOne = /payment_intents|paymentIntents\.create/.test(line)
      && !isComment
      && !readsOne;
    if (!makesOne) return;

    /* The parameters may be assembled before the call as easily as after it —
       classes builds its object first and then posts it — so look either
       side. Only checking downwards reported a path as broken that was fine. */
    const block = lines.slice(Math.max(0, i - 22), i + 22).join('\n');
    const saves = /setup_future_usage/.test(block);
    // Anything routed through the shared call inherits it.
    const shared = /stripeApi\(\s*['"]payment_intents['"]/.test(block);

    results.push({
      file, line: i + 1,
      ok: saves || shared,
      how: saves ? 'saves directly' : (shared ? 'inherits from stripeApi' : 'DOES NOT SAVE'),
    });
  });
}

const bad = results.filter(r => !r.ok);

console.log('');
console.log('  Every place a new card can be taken:');
console.log('');
for (const r of results) {
  console.log('    ' + (r.ok ? 'ok  ' : 'MISS') + '  ' + r.file.padEnd(20)
    + ('line ' + r.line).padEnd(11) + r.how);
}
console.log('');

if (bad.length) {
  console.log('  ' + bad.length + ' payment path(s) would leave the client without a card on file.');
  console.log('  Add setup_future_usage, or route it through stripeApi in _pay.js.');
  console.log('');
  process.exit(1);
}

console.log('  All ' + results.length + ' keep the card. Nobody has to hand it over twice.');
console.log('');
