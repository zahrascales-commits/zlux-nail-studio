const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb } = require('./db/init');
const bookingsRouter = require('./routes/bookings');

initDb();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/api', bookingsRouter);

app.use(express.static(path.join(__dirname, '..')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`ZLUX Nail Studio server running at http://localhost:${PORT}`);
});
