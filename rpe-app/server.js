const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const JWT_SECRET = 'rpe-app-secret-2026';

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway.internal') 
    ? false 
    : { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'athlete',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      duration INTEGER DEFAULT 60,
      reminder_delay INTEGER DEFAULT 30,
      status TEXT DEFAULT 'planned',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS responses (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      session_date TEXT,
      session_name TEXT,
      duration_min INTEGER,
      duration_h NUMERIC,
      rpe INTEGER,
      charge NUMERIC,
      comment TEXT DEFAULT '',
      submitted_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS excel_mapping (
      id INTEGER PRIMARY KEY DEFAULT 1,
      date_col TEXT,
      duration_col TEXT,
      rpe_col TEXT,
      comment_col TEXT,
      start_row INTEGER DEFAULT 2
    );
    INSERT INTO excel_mapping (id) VALUES (1) ON CONFLICT DO NOTHING;
  `);
  console.log('Base de données initialisée');
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Accès réservé à l\'admin' });
  next();
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Champs manquants' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const id = uuidv4();
    await pool.query(
      'INSERT INTO users (id, name, email, password, role) VALUES ($1,$2,$3,$4,$5)',
      [id, name, email, hash, 'athlete']
    );
    const token = jwt.sign({ id, name, role: 'athlete' }, JWT_SECRET);
    res.json({ token, user: { id, name, role: 'athlete' } });
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Email déjà utilisé' });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (!result.rows.length) return res.status(400).json({ error: 'Utilisateur introuvable' });
    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ error: 'Mot de passe incorrect' });
    const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET);
    res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
  } catch(e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/setup-admin', async (req, res) => {
  const { name, email, password, setupKey } = req.body;
  if (setupKey !== 'RPE-ADMIN-SETUP') return res.status(403).json({ error: 'Clé invalide' });
  try {
    const existing = await pool.query("SELECT id FROM users WHERE role='admin'");
    if (existing.rows.length) return res.status(400).json({ error: 'Admin déjà créé' });
    const hash = await bcrypt.hash(password, 10);
    const id = uuidv4();
    await pool.query(
      'INSERT INTO users (id, name, email, password, role) VALUES ($1,$2,$3,$4,$5)',
      [id, name, email, hash, 'admin']
    );
    const token = jwt.sign({ id, name, role: 'admin' }, JWT_SECRET);
    res.json({ token, user: { id, name, role: 'admin' } });
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Email déjà utilisé' });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── USERS ────────────────────────────────────────────────────────────────────

app.get('/api/users', auth, adminOnly, async (req, res) => {
  const result = await pool.query("SELECT id, name, email FROM users WHERE role='athlete'");
  res.json(result.rows);
});

// ─── SESSIONS ─────────────────────────────────────────────────────────────────

app.post('/api/sessions', auth, adminOnly, async (req, res) => {
  const { name, date, time, duration, reminderDelay } = req.body;
  if (!name || !date || !time) return res.status(400).json({ error: 'Champs manquants' });
  const id = uuidv4();
  await pool.query(
    'INSERT INTO sessions (id, name, date, time, duration, reminder_delay) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, name, date, time, parseInt(duration)||60, parseInt(reminderDelay)||30]
  );
  const result = await pool.query('SELECT * FROM sessions WHERE id=$1', [id]);
  res.json(result.rows[0]);
});

app.get('/api/sessions', auth, async (req, res) => {
  const result = await pool.query('SELECT * FROM sessions ORDER BY date DESC, time DESC');
  res.json(result.rows.map(s => ({
    id: s.id, name: s.name, date: s.date, time: s.time,
    duration: s.duration, reminderDelay: s.reminder_delay, status: s.status
  })));
});

app.patch('/api/sessions/:id', auth, adminOnly, async (req, res) => {
  const { status } = req.body;
  await pool.query('UPDATE sessions SET status=$1 WHERE id=$2', [status, req.params.id]);
  res.json({ success: true });
});

app.post('/api/sessions/:id/remind', auth, adminOnly, async (req, res) => {
  const { delay } = req.body;
  const session = await pool.query('SELECT * FROM sessions WHERE id=$1', [req.params.id]);
  if (!session.rows.length) return res.status(404).json({ error: 'Séance introuvable' });
  const responded = await pool.query('SELECT user_id FROM responses WHERE session_id=$1', [req.params.id]);
  const respondedIds = responded.rows.map(r => r.user_id);
  const athletes = await pool.query("SELECT id, name FROM users WHERE role='athlete'");
  const pending = athletes.rows.filter(a => !respondedIds.includes(a.id));
  res.json({ success: true, reminder: { delay, targetCount: pending.length, targets: pending.map(a => a.name) }, message: `Rappel envoyé à ${pending.length} athlète(s)` });
});

// ─── RESPONSES ────────────────────────────────────────────────────────────────

app.post('/api/responses', auth, async (req, res) => {
  const { sessionId, durationMin, rpe, comment } = req.body;
  if (!sessionId || !durationMin || !rpe) return res.status(400).json({ error: 'Champs manquants' });
  const session = await pool.query('SELECT * FROM sessions WHERE id=$1', [sessionId]);
  if (!session.rows.length) return res.status(404).json({ error: 'Séance introuvable' });
  const existing = await pool.query('SELECT id FROM responses WHERE session_id=$1 AND user_id=$2', [sessionId, req.user.id]);
  if (existing.rows.length) return res.status(400).json({ error: 'Déjà évalué' });
  const durationH = Math.round((durationMin / 60) * 100) / 100;
  const charge = parseInt(rpe) * durationH;
  const id = uuidv4();
  const s = session.rows[0];
  await pool.query(
    'INSERT INTO responses (id, session_id, user_id, user_name, session_date, session_name, duration_min, duration_h, rpe, charge, comment) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [id, sessionId, req.user.id, req.user.name, s.date, s.name, parseInt(durationMin), durationH, parseInt(rpe), charge, comment||'']
  );
  res.json({ id, durationH, charge });
});

app.get('/api/my-pending', auth, async (req, res) => {
  const responded = await pool.query('SELECT session_id FROM responses WHERE user_id=$1', [req.user.id]);
  const respondedIds = responded.rows.map(r => r.session_id);
  let query = 'SELECT * FROM sessions';
  const params = [];
  if (respondedIds.length) {
    query += ' WHERE id != ALL($1)';
    params.push(respondedIds);
  }
  query += ' ORDER BY date DESC, time DESC';
  const result = await pool.query(query, params);
  res.json(result.rows.map(s => ({
    id: s.id, name: s.name, date: s.date, time: s.time,
    duration: s.duration, reminderDelay: s.reminder_delay, status: s.status
  })));
});

app.get('/api/sessions/:id/results', auth, adminOnly, async (req, res) => {
  const responses = await pool.query('SELECT * FROM responses WHERE session_id=$1 ORDER BY submitted_at DESC', [req.params.id]);
  const athletes = await pool.query("SELECT id, name FROM users WHERE role='athlete'");
  const respondedIds = responses.rows.map(r => r.user_id);
  const pending = athletes.rows.filter(a => !respondedIds.includes(a.id));
  const avgRpe = responses.rows.length ? (responses.rows.reduce((s,r) => s + r.rpe, 0) / responses.rows.length).toFixed(1) : null;
  const avgCharge = responses.rows.length ? (responses.rows.reduce((s,r) => s + parseFloat(r.charge), 0) / responses.rows.length).toFixed(1) : null;
  res.json({ responses: responses.rows, pending, avgRpe, avgCharge });
});

// ─── EXCEL MAPPING ────────────────────────────────────────────────────────────

app.post('/api/excel-mapping', auth, adminOnly, async (req, res) => {
  const { mapping } = req.body;
  await pool.query(
    'UPDATE excel_mapping SET date_col=$1, duration_col=$2, rpe_col=$3, comment_col=$4, start_row=$5 WHERE id=1',
    [mapping.dateCol||null, mapping.durationCol||'B', mapping.rpeCol||'C', mapping.commentCol||null, mapping.startRow||2]
  );
  res.json({ success: true });
});

app.get('/api/excel-mapping', auth, adminOnly, async (req, res) => {
  const result = await pool.query('SELECT * FROM excel_mapping WHERE id=1');
  const m = result.rows[0] || {};
  res.json({ dateCol: m.date_col, durationCol: m.duration_col, rpeCol: m.rpe_col, commentCol: m.comment_col, startRow: m.start_row });
});

// ─── EXPORT EXCEL ─────────────────────────────────────────────────────────────

app.get('/api/export', auth, adminOnly, async (req, res) => {
  const mappingRes = await pool.query('SELECT * FROM excel_mapping WHERE id=1');
  const m = mappingRes.rows[0];
  if (!m || !m.duration_col) return res.status(400).json({ error: 'Mapping Excel non configuré' });
  const { date_col, duration_col, rpe_col, comment_col, start_row } = m;
  const rowStart = parseInt(start_row) || 2;
  const responsesRes = await pool.query('SELECT * FROM responses ORDER BY user_name, session_date ASC');
  const byAthlete = {};
  responsesRes.rows.forEach(r => {
    if (!byAthlete[r.user_name]) byAthlete[r.user_name] = [];
    byAthlete[r.user_name].push(r);
  });
  const workbook = XLSX.utils.book_new();
  Object.entries(byAthlete).forEach(([athleteName, responses]) => {
    const ws = {};
    const headerRow = rowStart - 1;
    if (headerRow >= 1) {
      if (date_col) ws[`${date_col}${headerRow}`] = { v: 'Date', t: 's' };
      ws[`${duration_col}${headerRow}`] = { v: 'Durée (h)', t: 's' };
      ws[`${rpe_col}${headerRow}`] = { v: 'RPE', t: 's' };
      if (comment_col) ws[`${comment_col}${headerRow}`] = { v: 'Commentaire', t: 's' };
    }
    responses.forEach((r, i) => {
      const row = rowStart + i;
      if (date_col) ws[`${date_col}${row}`] = { v: r.session_date, t: 's' };
      ws[`${duration_col}${row}`] = { v: parseFloat(r.duration_h), t: 'n' };
      ws[`${rpe_col}${row}`] = { v: r.rpe, t: 'n' };
      if (comment_col) ws[`${comment_col}${row}`] = { v: r.comment||'', t: 's' };
    });
    const lastRow = rowStart + responses.length - 1;
    const cols = [date_col, duration_col, rpe_col, comment_col].filter(Boolean);
    const minCol = cols.reduce((a,b) => a<b?a:b);
    const maxCol = cols.reduce((a,b) => a>b?a:b);
    ws['!ref'] = `${minCol}1:${maxCol}${lastRow}`;
    XLSX.utils.book_append_sheet(workbook, ws, athleteName.substring(0,31));
  });
  const buf = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=RPE_Export.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`RPE App démarrée sur port ${PORT}`);
  await initDB();
});