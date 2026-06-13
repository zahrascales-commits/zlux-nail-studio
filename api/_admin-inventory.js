const { queryOne, query, execute } = require('./_db');

async function authAdmin(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  return queryOne('SELECT * FROM sessions WHERE token = ? AND role = ? AND expires_at > datetime("now")', [token, 'ADMIN']);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const session = await authAdmin(req);
    if (!session) return res.status(401).json({ error: 'Admin login required.' });

    if (req.method === 'GET') {
      const items = await query('SELECT * FROM inventory ORDER BY category ASC, product_name ASC', []);
      const lowStock = items.filter(i => i.quantity <= i.low_stock_threshold);
      return res.status(200).json({ items, lowStock });
    }

    if (req.method === 'POST') {
      const { productName, category, quantity, lowStockThreshold, unit, notes } = req.body;
      if (!productName) return res.status(400).json({ error: 'Product name required.' });
      const r = await execute('INSERT INTO inventory (product_name, category, quantity, low_stock_threshold, unit, notes) VALUES (?,?,?,?,?,?)',
        [productName, category||null, quantity||0, lowStockThreshold||5, unit||'units', notes||null]);
      return res.status(201).json({ id: r.lastInsertRowid });
    }

    if (req.method === 'PUT') {
      const { id, quantity, productName, category, lowStockThreshold, unit, notes } = req.body;
      if (!id) return res.status(400).json({ error: 'id required.' });
      await execute(`UPDATE inventory SET product_name=COALESCE(?,product_name), category=COALESCE(?,category), quantity=COALESCE(?,quantity), low_stock_threshold=COALESCE(?,low_stock_threshold), unit=COALESCE(?,unit), notes=COALESCE(?,notes), last_updated=datetime('now') WHERE id=?`,
        [productName||null, category||null, quantity!=null?quantity:null, lowStockThreshold||null, unit||null, notes||null, id]);
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required.' });
      await execute('DELETE FROM inventory WHERE id=?', [parseInt(id)]);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Admin inventory error:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
};
