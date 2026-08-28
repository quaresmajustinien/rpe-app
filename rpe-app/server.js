const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const app = express();
const JWT_SECRET = 'rpe-app-secret-2026';

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

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────

// Inscription athlète (première connexion)
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Champs manquants' });
  const data = db.load();
  if (data.users.find(u => u.email === email)) return res.status(400).json({ error: 'Email déjà utilisé' });
  const hash = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), name, email, password: hash, role: 'athlete', createdAt: new Date().toISOString() };
  data.users.push(user);
  db.save(data);
  const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET);
  res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
});

// Connexion
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const data = db.load();
  const user = data.users.find(u => u.email === email);
  if (!user) return res.status(400).json({ error: 'Utilisateur introuvable' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Mot de passe incorrect' });
  const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET);
  res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
});

// Créer compte admin (setup initial)
app.post('/api/setup-admin', async (req, res) => {
  const { name, email, password, setupKey } = req.body;
  if (setupKey !== 'RPE-ADMIN-SETUP') return res.status(403).json({ error: 'Clé invalide' });
  const data = db.load();
  if (data.users.find(u => u.role === 'admin')) return res.status(400).json({ error: 'Admin déjà créé' });
  const hash = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), name, email, password: hash, role: 'admin', createdAt: new Date().toISOString() };
  data.users.push(user);
  db.save(data);
  const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET);
  res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
});

// ─── USERS ────────────────────────────────────────────────────────────────────

app.get('/api/users', auth, adminOnly, (req, res) => {
  const data = db.load();
  res.json(data.users.filter(u => u.role === 'athlete').map(u => ({ id: u.id, name: u.name, email: u.email })));
});

// ─── SESSIONS ─────────────────────────────────────────────────────────────────

// Créer une séance (admin)
app.post('/api/sessions', auth, adminOnly, (req, res) => {
  const { name, date, time, duration, reminderDelay } = req.body;
  if (!name || !date || !time) return res.status(400).json({ error: 'Champs manquants' });
  const data = db.load();
  const session = {
    id: uuidv4(),
    name,
    date,
    time,
    duration: parseInt(duration) || 60,
    reminderDelay: parseInt(reminderDelay) || 30,
    createdAt: new Date().toISOString(),
    status: 'planned'
  };
  data.sessions.push(session);
  db.save(data);
  res.json(session);
});

// Lister les séances
app.get('/api/sessions', auth, (req, res) => {
  const data = db.load();
  res.json(data.sessions.sort((a, b) => new Date(b.date + 'T' + b.time) - new Date(a.date + 'T' + a.time)));
});

// Mettre à jour le statut d'une séance
app.patch('/api/sessions/:id', auth, adminOnly, (req, res) => {
  const data = db.load();
  const session = data.sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Séance introuvable' });
  Object.assign(session, req.body);
  db.save(data);
  res.json(session);
});

// Envoyer un rappel (simule la notification)
app.post('/api/sessions/:id/remind', auth, adminOnly, (req, res) => {
  const { delay } = req.body; // 0 = immédiat, 30 = dans 30 min
  const data = db.load();
  const session = data.sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Séance introuvable' });

  // Trouver les athlètes n'ayant pas encore répondu
  const responded = data.responses.filter(r => r.sessionId === req.params.id).map(r => r.userId);
  const athletes = data.users.filter(u => u.role === 'athlete' && !responded.includes(u.id));

  // En production: envoyer une vraie push notification ici
  // Pour le prototype, on enregistre juste le rappel
  const reminder = {
    sessionId: req.params.id,
    sessionName: session.name,
    delay,
    sentAt: new Date().toISOString(),
    targetCount: athletes.length,
    targets: athletes.map(a => a.name)
  };

  res.json({ success: true, reminder, message: `Rappel envoyé à ${athletes.length} athlète(s)` });
});

// ─── RESPONSES (RPE) ──────────────────────────────────────────────────────────

// Soumettre un RPE
app.post('/api/responses', auth, (req, res) => {
  const { sessionId, durationMin, rpe, comment } = req.body;
  if (!sessionId || !durationMin || !rpe) return res.status(400).json({ error: 'Champs manquants' });
  const data = db.load();
  const session = data.sessions.find(s => s.id === sessionId);
  if (!session) return res.status(404).json({ error: 'Séance introuvable' });

  // Vérifier si déjà répondu
  const existing = data.responses.find(r => r.sessionId === sessionId && r.userId === req.user.id);
  if (existing) return res.status(400).json({ error: 'Déjà évalué' });

  const durationH = Math.round((durationMin / 60) * 100) / 100; // conversion min → heures, arrondi 2 décimales
  const response = {
    id: uuidv4(),
    sessionId,
    userId: req.user.id,
    userName: req.user.name,
    sessionDate: session.date,
    sessionName: session.name,
    durationMin: parseInt(durationMin),
    durationH,
    rpe: parseInt(rpe),
    charge: parseInt(rpe) * durationH,
    comment: comment || '',
    submittedAt: new Date().toISOString()
  };
  data.responses.push(response);
  db.save(data);
  res.json(response);
});

// Séances non évaluées pour un athlète
app.get('/api/my-pending', auth, (req, res) => {
  const data = db.load();
  const responded = data.responses.filter(r => r.userId === req.user.id).map(r => r.sessionId);
  const pending = data.sessions.filter(s => !responded.includes(s.id));
});

// Résultats d'une séance (admin)
app.get('/api/sessions/:id/results', auth, adminOnly, (req, res) => {
  const data = db.load();
  const responses = data.responses.filter(r => r.sessionId === req.params.id);
  const athletes = data.users.filter(u => u.role === 'athlete');
  const pending = athletes.filter(a => !responses.find(r => r.userId === a.id));
  const avgRpe = responses.length ? (responses.reduce((s, r) => s + r.rpe, 0) / responses.length).toFixed(1) : null;
  const avgCharge = responses.length ? (responses.reduce((s, r) => s + r.charge, 0) / responses.length).toFixed(1) : null;
  res.json({ responses, pending, avgRpe, avgCharge });
});

// ─── EXCEL MAPPING ────────────────────────────────────────────────────────────

// Sauvegarder le mapping de cellules
app.post('/api/excel-mapping', auth, adminOnly, (req, res) => {
  const { mapping } = req.body;
  // mapping = { durationCol: "C", rpeCol: "D", commentCol: "E", dateCol: "A", startRow: 2 }
  const data = db.load();
  data.excelMapping = mapping;
  db.save(data);
  res.json({ success: true, mapping });
});

app.get('/api/excel-mapping', auth, adminOnly, (req, res) => {
  const data = db.load();
  res.json(data.excelMapping || {});
});

// ─── EXPORT EXCEL ─────────────────────────────────────────────────────────────

app.get('/api/export', auth, adminOnly, (req, res) => {
  const data = db.load();
  const mapping = data.excelMapping;

  if (!mapping || !mapping.durationCol) {
    return res.status(400).json({ error: 'Mapping Excel non configuré' });
  }

  const { durationCol, rpeCol, commentCol, dateCol, startRow } = mapping;
  const rowStart = parseInt(startRow) || 2;

  // Grouper les réponses par athlète
  const byAthlete = {};
  data.responses.forEach(r => {
    if (!byAthlete[r.userName]) byAthlete[r.userName] = [];
    byAthlete[r.userName].push(r);
  });

  const workbook = XLSX.utils.book_new();

  // Un onglet par athlète
  Object.entries(byAthlete).forEach(([athleteName, responses]) => {
    // Trier par date croissante
    responses.sort((a, b) => new Date(a.sessionDate) - new Date(b.sessionDate));

    // Créer une feuille vide et placer les données dans les bonnes colonnes
    const ws = {};
    const wsInfo = { '!ref': '' };

    // En-tête dans la ligne 1 (startRow - 1)
    const headerRow = rowStart - 1;
    if (headerRow >= 1) {
      if (dateCol) ws[`${dateCol}${headerRow}`] = { v: 'Date', t: 's' };
      ws[`${durationCol}${headerRow}`] = { v: 'Durée (h)', t: 's' };
      ws[`${rpeCol}${headerRow}`] = { v: 'RPE', t: 's' };
      if (commentCol) ws[`${commentCol}${headerRow}`] = { v: 'Commentaire', t: 's' };
    }

    // Données ligne par ligne selon la date
    responses.forEach((r, i) => {
      const row = rowStart + i;
      if (dateCol) ws[`${dateCol}${row}`] = { v: r.sessionDate, t: 's' };
      ws[`${durationCol}${row}`] = { v: r.durationH, t: 'n' };
      ws[`${rpeCol}${row}`] = { v: r.rpe, t: 'n' };
      if (commentCol) ws[`${commentCol}${row}`] = { v: r.comment || '', t: 's' };
    });

    // Calculer la plage
    const lastRow = rowStart + responses.length - 1;
    const cols = [dateCol, durationCol, rpeCol, commentCol].filter(Boolean);
    const minCol = cols.reduce((m, c) => c < m ? c : m, cols[0]);
    const maxCol = cols.reduce((m, c) => c > m ? c : m, cols[0]);
    ws['!ref'] = `${minCol}1:${maxCol}${lastRow}`;

    XLSX.utils.book_append_sheet(workbook, ws, athleteName.substring(0, 31));
  });

  const buf = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=RPE_Export.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = 3000;
app.listen(PORT, () => console.log(`RPE App démarrée sur http://localhost:${PORT}`));
