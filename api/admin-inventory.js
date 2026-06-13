const { getDb } = require('../server/db/init');

function authAdmin(db, req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  return db.prepare('SELECT * FROM sessions WHERE token = ? AND role = ? AND expires_at > datetime("now")').get(token, 'ADMIN') || null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const db = getDb();
  try {
    const session = authAdmin(db, req);
    if (!session) return res.status(401).json({ error: 'Admin login required.' });

    if (req.method === 'GET') {
      const items = db.prepare('SELECT * FROM inventory ORDER BY category ASC, product_name ASC').all();
      const lowStock = items.filter(i => i.quantity <= i.low_stock_threshold);
      return res.status(200).json({ items, lowStock });
    }

    if (req.method === 'POST') {
      const { productName, category, quantity, lowStockThreshold, unit, notes } = req.body;
      if (!productName) return res.status(400).json({ error: 'Product name required.' });
      const r = db.prepare('INSERT INTO inventory (product_name, category, quantity, low_stock_threshold, unit, notes) VALUES (?,?,?,?,?,?)').run(productName, category||null, quantity||0, lowStockThreshold||5, unit||'units', notes||null);
      return res.status(201).json({ id: r.lastInsertRowid });
    }

    if (req.method === 'PUT') {
      const { id, quantity, productName, category, lowStockThreshold, unit, notes } = req.body;
      if (!id) return res.status(400).json({ error: 'id required.' });
      db.prepare(`UPDATE inventory SET product_name=COALESCE(?,product_name), category=COALESCE(?,category), quantity=COALESCE(?,quantity), low_stock_threshold=COALESCE(?,low_stock_threshold), unit=COALESCE(?,unit), notes=COALESCE(?,notes), last_updated=datetime('now') WHERE id=?`)
        .run(productName||null, category||null, quantity!=null?quantity:null, lowStockThreshold||null, unit||null, notes||null, id);
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required.' });
      db.prepare('DELETE FROM inventory WHERE id=?').run(parseInt(id));
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } finally {
    db.close();
  }
};
