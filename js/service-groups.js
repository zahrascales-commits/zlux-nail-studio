// One entry per actual service, not per size.
//
// The menu stores every length as its own priced service — Short Gel X,
// Medium Gel X, Long Gel X — because that is what gets booked and charged.
// But nobody shopping wants to read the same set three times, and Zahra
// should be uploading one Gel X photo, not three. So the public side groups
// them back into the service they really are and keeps the lengths as a
// second step.
//
// Shared by the homepage and by Studio Manager's photo slots on purpose: if
// they grouped differently, she would upload a photo into a slot the website
// never reads.
(function () {
  // Longest first, so "Extra Long Gel X" is not read as "Long ...".
  var SIZES = ['Extra Long', 'X-Long', 'XL', 'Short', 'Medium', 'Long'];
  var SIZE_ORDER = { 'Short': 1, 'Medium': 2, 'Long': 3, 'X-Long': 4, 'XL': 4, 'Extra Long': 4 };

  // Roughly the order she reads the menu in. Anything unrecognised keeps its
  // own order after these, so a new service still appears without a code
  // change — it just lands at the end until it is worth naming here.
  var ORDER = [
    'regular gel manicure',
    'organic structured manicure',
    'organic structure manicure',
    'gel x',
    'acrylic',
    'russian dry manicure',
    'russian dry manicure — full correction',
    'russian dry pedicure',
    'russian dry pedicure — full correction',
  ];

  function slug(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  // Pulls a leading length off a service name: "Short Gel X" → Short + "Gel X".
  function splitSize(name) {
    var n = String(name || '').trim();
    for (var i = 0; i < SIZES.length; i++) {
      var re = new RegExp('^' + SIZES[i].replace('-', '\\-') + '\\s+', 'i');
      if (re.test(n)) return { size: SIZES[i], base: n.replace(re, '').trim() };
    }
    return { size: '', base: n };
  }

  // "Acrylic Set" is just "Acrylic" on a card.
  function pretty(base) {
    return String(base || '').replace(/\s+Set$/i, '').trim();
  }

  function rank(name) {
    var n = String(name || '').toLowerCase();
    for (var i = 0; i < ORDER.length; i++) if (n === ORDER[i]) return i;
    for (var j = 0; j < ORDER.length; j++) if (n.indexOf(ORDER[j]) === 0) return j;
    return ORDER.length + 1;
  }

  function cents(s) {
    var v = s.price_cents != null ? s.price_cents : (s.base_price_cents != null ? s.base_price_cents : 0);
    return Number(v) || 0;
  }

  function money(c) {
    return '$' + (Number(c) / 100).toFixed(Number(c) % 100 === 0 ? 0 : 2);
  }

  // Test rows and anything switched off have no business on a public menu.
  function isPublic(s) {
    var n = String(s.name || s.service_name || '');
    if (!n) return false;
    if (/^\s*test\b/i.test(n)) return false;
    if (s.active === 0 || s.active === false) return false;
    return true;
  }

  function group(services, opts) {
    opts = opts || {};
    var list = (services || []).filter(opts.includeHidden ? function () { return true; } : isPublic);
    var byBase = {};
    var seq = 0;

    list.forEach(function (s) {
      var name = s.name || s.service_name || '';
      var parts = splitSize(name);
      var label = pretty(parts.base);
      var key = slug(label);
      if (!byBase[key]) {
        byBase[key] = { key: key, name: label, base: parts.base, variants: [], seq: seq++ };
      }
      byBase[key].variants.push({
        name: name,                    // the exact bookable service name
        size: parts.size,
        price_cents: cents(s),
      });
    });

    return Object.keys(byBase).map(function (k) {
      var g = byBase[k];
      g.variants.sort(function (a, b) {
        var d = (SIZE_ORDER[a.size] || 9) - (SIZE_ORDER[b.size] || 9);
        return d || a.price_cents - b.price_cents;
      });
      g.from_cents = g.variants.reduce(function (lo, v) {
        return lo === null || v.price_cents < lo ? v.price_cents : lo;
      }, null) || 0;
      // A single length is not a choice — tapping it should just book.
      g.sized = g.variants.length > 1 && g.variants.some(function (v) { return v.size; });
      g.price_label = g.sized ? 'from ' + money(g.from_cents) : money(g.from_cents);
      return g;
    }).sort(function (a, b) {
      var d = rank(a.name) - rank(b.name);
      return d || a.seq - b.seq;
    });
  }

  window.ZolaServices = { group: group, slug: slug, money: money, splitSize: splitSize, pretty: pretty };
})();
