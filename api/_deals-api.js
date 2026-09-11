// The deal days, for the pages that show them.
//
// The menu at /api/services already carries them as bookable services. This
// adds the parts only the front of the site needs: what each day is called,
// what it includes, the hands-or-toes choice, and the one line about where
// to go for a removal.
const deals = require('./_deals');

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
  res.json({ deals: deals.all(), instead_note: deals.INSTEAD_NOTE });
};
