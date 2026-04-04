require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'pillpal-secret-2024';

const app = express();
const PORT = process.env.PORT || 3000;

// ── SQLite setup ──
const db = new DatabaseSync(path.join(__dirname, 'scans.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS scans (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    medicine_name  TEXT,
    manufacturer   TEXT,
    dosage         TEXT,
    usage          TEXT,
    conditions     TEXT,
    condition_flags TEXT,
    scanned_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Safe column migrations for existing databases
try { db.exec(`ALTER TABLE scans ADD COLUMN generic_alternatives TEXT DEFAULT '[]'`); } catch (_) {}
try { db.exec(`ALTER TABLE scans ADD COLUMN food_interactions TEXT DEFAULT '[]'`); } catch (_) {}
try { db.exec(`ALTER TABLE scans ADD COLUMN profile_id INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE scans ADD COLUMN expiry_date TEXT DEFAULT ''`); } catch (_) {}
try { db.exec(`ALTER TABLE scans ADD COLUMN user_id INTEGER`); } catch (_) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    plan          TEXT DEFAULT 'free',
    scans_used    INTEGER DEFAULT 0,
    scans_limit   INTEGER DEFAULT 5,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
try { db.exec(`ALTER TABLE reminders ADD COLUMN user_id INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE profiles ADD COLUMN user_id INTEGER`); } catch (_) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT,
    relation   TEXT,
    conditions TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const insertScan           = db.prepare(`INSERT INTO scans (medicine_name, manufacturer, dosage, usage, conditions, condition_flags, generic_alternatives, food_interactions, profile_id, expiry_date, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const selectAllScans       = db.prepare(`SELECT * FROM scans ORDER BY scanned_at DESC LIMIT 20`);
const selectScansWithExpiry = db.prepare(`SELECT * FROM scans WHERE expiry_date IS NOT NULL AND expiry_date != '' ORDER BY scanned_at DESC`);
const selectScansByProfile = db.prepare(`SELECT * FROM scans WHERE profile_id = ? ORDER BY scanned_at DESC LIMIT 20`);
const selectNullScans      = db.prepare(`SELECT * FROM scans WHERE profile_id IS NULL ORDER BY scanned_at DESC LIMIT 20`);
const deleteScan           = db.prepare(`DELETE FROM scans WHERE id = ?`);

const selectProfiles     = db.prepare(`SELECT * FROM profiles ORDER BY created_at ASC`);
const insertProfile      = db.prepare(`INSERT INTO profiles (name, relation, conditions) VALUES (?, ?, ?)`);
const deleteProfile      = db.prepare(`DELETE FROM profiles WHERE id = ?`);
const deleteProfileScans = db.prepare(`DELETE FROM scans WHERE profile_id = ?`);

db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    client_name   TEXT,
    email         TEXT,
    api_key       TEXT UNIQUE,
    plan          TEXT DEFAULT 'starter',
    monthly_limit INTEGER DEFAULT 500,
    usage_count   INTEGER DEFAULT 0,
    active        INTEGER DEFAULT 1,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id     INTEGER,
    medicine_name  TEXT,
    dosage         TEXT,
    frequency      TEXT,
    times          TEXT,
    notes          TEXT,
    active         INTEGER DEFAULT 1,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS api_usage_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key       TEXT,
    endpoint      TEXT,
    medicine_name TEXT,
    timestamp     DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const insertReminder           = db.prepare(`INSERT INTO reminders (profile_id, medicine_name, dosage, frequency, times, notes) VALUES (?, ?, ?, ?, ?, ?)`);
const selectRemindersByProfile = db.prepare(`SELECT * FROM reminders WHERE profile_id = ? AND active = 1 ORDER BY created_at DESC`);
const selectRemindersNull      = db.prepare(`SELECT * FROM reminders WHERE profile_id IS NULL AND active = 1 ORDER BY created_at DESC`);
const selectAllReminders       = db.prepare(`SELECT * FROM reminders WHERE active = 1 ORDER BY created_at DESC`);
const deactivateReminder       = db.prepare(`UPDATE reminders SET active = 0 WHERE id = ?`);

const findUserByEmail      = db.prepare(`SELECT * FROM users WHERE email = ?`);
const findUserById         = db.prepare(`SELECT * FROM users WHERE id = ?`);
const insertUser           = db.prepare(`INSERT INTO users (name, email, password_hash, plan, scans_used, scans_limit) VALUES (?, ?, ?, ?, ?, ?)`);
const incrementUserScans   = db.prepare(`UPDATE users SET scans_used = scans_used + 1 WHERE id = ?`);

const findApiKey       = db.prepare(`SELECT * FROM api_keys WHERE api_key = ? AND active = 1`);
const incrementUsage   = db.prepare(`UPDATE api_keys SET usage_count = usage_count + 1 WHERE api_key = ?`);
const logUsage         = db.prepare(`INSERT INTO api_usage_log (api_key, endpoint, medicine_name) VALUES (?, ?, ?)`);
const selectAllKeys    = db.prepare(`SELECT * FROM api_keys ORDER BY created_at DESC`);
const insertApiKey     = db.prepare(`INSERT INTO api_keys (client_name, email, api_key, plan, monthly_limit) VALUES (?, ?, ?, ?, ?)`);
const deactivateKey    = db.prepare(`UPDATE api_keys SET active = 0 WHERE id = ?`);
const selectUsageLog   = db.prepare(`SELECT * FROM api_usage_log ORDER BY timestamp DESC LIMIT 100`);

// ── Multer ──
const upload = multer({ storage: multer.memoryStorage() });

// ── Condition keyword map ──
const CONDITION_KEYWORDS = {
  high_bp:  { label: 'High Blood Pressure', keywords: ['blood pressure', 'hypertension', 'hypertensive', 'pressure'] },
  low_bp:   { label: 'Low Blood Pressure',  keywords: ['hypotension', 'low blood pressure', 'dizziness', 'fainting'] },
  diabetes: { label: 'Diabetes',            keywords: ['blood sugar', 'glucose', 'insulin', 'diabetic', 'diabetes', 'glycemic'] },
  thyroid:  { label: 'Thyroid',             keywords: ['thyroid', 'thyroxine', 'hypothyroid', 'hyperthyroid', 'TSH'] },
  kidney:   { label: 'Kidney',              keywords: ['renal', 'kidney', 'creatinine', 'nephro', 'dialysis'] },
};

function checkConditionFlags(openfdaData, conditions) {
  const searchText = `${openfdaData.warnings} ${openfdaData.adverse_reactions}`.toLowerCase();
  return conditions.map((condition) => {
    const meta = CONDITION_KEYWORDS[condition];
    if (!meta) return { condition, label: condition, flagged: false, reason: 'Unknown condition' };
    const matched = meta.keywords.find((kw) => searchText.includes(kw.toLowerCase()));
    return {
      condition,
      label: meta.label,
      flagged: !!matched,
      reason: matched ? `Found keyword: ${matched}` : 'No relevant keywords found',
    };
  });
}

app.use(express.json());

// ── Middleware ──
function authenticateAPIKey(req, res, next) {
  const key = req.headers['x-api-key'];
  // No key = request from the browser frontend; allow through freely
  if (!key) return next();

  // Key present = B2B API call; validate it
  const client = findApiKey.get(key);
  if (!client) {
    return res.status(403).json({ error: 'Invalid or inactive API key' });
  }
  if (client.usage_count >= client.monthly_limit) {
    return res.status(429).json({ error: 'Monthly limit exceeded', limit: client.monthly_limit, used: client.usage_count });
  }
  req.apiClient = client;
  incrementUsage.run(key);
  logUsage.run(key, req.path, '');
  next();
}

function requireAdminSecret(req, res, next) {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── User JWT middleware (optional auth — allows guests through) ──
function authenticateUser(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
  } catch (_) {
    req.user = null;
  }
  next();
}

// ── Routes ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ── Auth routes ──
function makeToken(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name, plan: user.plan }, JWT_SECRET, { expiresIn: '30d' });
}
function safeUser(user) {
  const { password_hash, ...rest } = user;
  return rest;
}

app.post('/api/auth/signup', (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email, and password are required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (findUserByEmail.get(email)) return res.status(409).json({ error: 'Email already registered' });
    const hash = bcrypt.hashSync(password, 10);
    const result = insertUser.run(name, email, hash, 'free', 0, 5);
    const user = findUserById.get(Number(result.lastInsertRowid));
    return res.status(201).json({ token: makeToken(user), user: safeUser(user) });
  } catch (err) {
    console.error('Signup error:', err.message);
    return res.status(500).json({ error: 'Signup failed', details: err.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
    const user = findUserByEmail.get(email);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    return res.json({ token: makeToken(user), user: safeUser(user) });
  } catch (err) {
    console.error('Login error:', err.message);
    return res.status(500).json({ error: 'Login failed', details: err.message });
  }
});

app.get('/api/auth/me', authenticateUser, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const user = findUserById.get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  return res.json(safeUser(user));
});

app.post('/api/analyze', authenticateAPIKey, authenticateUser, upload.single('medicine'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }


    const base64Image = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;

    const claudeResponse = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: 'You are Pill Pal, a medicine identification assistant. When given a medicine image, extract: medicine name, manufacturer, dosage, usage/purpose, and expiry date. Return ONLY a JSON object with fields: name, manufacturer, dosage, usage, confidence, expiry_date (format MM/YYYY or text exactly as printed on pack, empty string if not visible). No markdown, no explanation.',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType,
                  data: base64Image,
                },
              },
              {
                type: 'text',
                text: 'Identify this medicine.',
              },
            ],
          },
        ],
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
      }
    );

    let rawText = claudeResponse.data.content[0].text;
    rawText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const medicineData = JSON.parse(rawText);

    // Update usage log with resolved medicine name
    if (req.apiClient) {
      db.prepare(`UPDATE api_usage_log SET medicine_name = ? WHERE api_key = ? AND id = (SELECT MAX(id) FROM api_usage_log WHERE api_key = ?)`
      ).run(medicineData.name || '', req.apiClient.api_key, req.apiClient.api_key);
    }

    let warnings = '';
    let adverse_reactions = '';
    let contraindications = '';
    let drug_interactions = '';
    let data_source = 'ai';

    try {
      const fdaUrl = `https://api.fda.gov/drug/label.json?search=openfda.brand_name:"${encodeURIComponent(medicineData.name)}"&limit=1`;
      const fdaResponse = await axios.get(fdaUrl);

      if (fdaResponse.data.results && fdaResponse.data.results.length > 0) {
        const label = fdaResponse.data.results[0];
        warnings          = (label.warnings          && label.warnings[0])          || '';
        adverse_reactions = (label.adverse_reactions && label.adverse_reactions[0]) || '';
        contraindications = (label.contraindications && label.contraindications[0]) || '';
        drug_interactions = (label.drug_interactions && label.drug_interactions[0]) || '';
        if (warnings || adverse_reactions || contraindications || drug_interactions) {
          data_source = 'fda';
        }
      }
    } catch (fdaError) {
      // OpenFDA returned no results or errored — continue with empty strings
    }

    // ── Indian medicine fallback: if FDA had no data, ask Claude as pharmacist ──
    if (data_source !== 'fda') {
      try {
        const indiaPrompt = `You are a pharmacist with expertise in Indian and global medicines. For the medicine: ${medicineData.name} with dosage: ${medicineData.dosage || 'unknown'}, provide safety information a patient should know. Return ONLY a JSON object with exactly these 4 fields as plain text strings: warnings, adverse_reactions, contraindications, drug_interactions. No markdown, no explanation.`;

        const indiaResponse = await axios.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            messages: [{ role: 'user', content: indiaPrompt }],
          },
          {
            headers: {
              'x-api-key': process.env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
          }
        );

        let indiaRaw = indiaResponse.data.content[0].text;
        indiaRaw = indiaRaw.replace(/```json/gi, '').replace(/```/g, '').trim();
        const indiaData = JSON.parse(indiaRaw);
        warnings          = indiaData.warnings          || '';
        adverse_reactions = indiaData.adverse_reactions || '';
        contraindications = indiaData.contraindications || '';
        drug_interactions = indiaData.drug_interactions || '';
      } catch (indiaErr) {
        console.error('India fallback Claude call failed:', indiaErr.message);
      }
    }

    // ── Second Claude call: generics + food interactions ──
    let generic_alternatives = [];
    let food_interactions = [];
    try {
      const pharmPrompt = `You are a pharmacy assistant. Given this medicine: ${medicineData.name} with active ingredient/dosage: ${medicineData.dosage || 'unknown'}.

Return ONLY a JSON object with exactly these two fields:
1. generic_alternatives: array of up to 3 strings, each being a generic version or cheaper alternative medicine name with its approximate price range in INR
2. food_interactions: array of up to 5 strings, each being a specific food or drink to avoid and a one-line reason why

No markdown, no explanation, only the JSON object.`;

      const pharmResponse = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          messages: [{ role: 'user', content: pharmPrompt }],
        },
        {
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
        }
      );

      let pharmRaw = pharmResponse.data.content[0].text;
      pharmRaw = pharmRaw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const pharmData = JSON.parse(pharmRaw);
      generic_alternatives = Array.isArray(pharmData.generic_alternatives) ? pharmData.generic_alternatives : [];
      food_interactions    = Array.isArray(pharmData.food_interactions)    ? pharmData.food_interactions    : [];
    } catch (pharmErr) {
      console.error('Pharmacy Claude call failed:', pharmErr.message);
      // continue with empty arrays
    }

    let conditions = [];
    try {
      if (req.body.conditions) {
        conditions = JSON.parse(req.body.conditions);
      }
    } catch (_) {
      // malformed conditions field — treat as empty
    }

    const condition_flags = checkConditionFlags({ warnings, adverse_reactions }, conditions);

    // ── Persist to SQLite ──
    let profile_id = null;
    if (req.body.profile_id && req.body.profile_id !== 'null') {
      profile_id = parseInt(req.body.profile_id, 10) || null;
    }

    try {
      const uid = req.user ? req.user.id : null;
      insertScan.run(
        medicineData.name         || '',
        medicineData.manufacturer || '',
        medicineData.dosage       || '',
        medicineData.usage        || '',
        JSON.stringify(conditions),
        JSON.stringify(condition_flags),
        JSON.stringify(generic_alternatives),
        JSON.stringify(food_interactions),
        profile_id,
        medicineData.expiry_date  || '',
        uid
      );
      if (req.user) incrementUserScans.run(req.user.id);
    } catch (dbErr) {
      console.error('DB insert error:', dbErr.message);
    }

    return res.json({
      name:             medicineData.name         || '',
      manufacturer:     medicineData.manufacturer || '',
      dosage:           medicineData.dosage        || '',
      usage:            medicineData.usage         || '',
      confidence:       medicineData.confidence    || '',
      expiry_date:      medicineData.expiry_date   || '',
      data_source,
      warnings,
      adverse_reactions,
      contraindications,
      drug_interactions,
      condition_flags,
      generic_alternatives,
      food_interactions,
      disclaimer: 'This is general medicine information only and not medical advice. Consult a doctor or pharmacist before making any health decisions.',
    });
  } catch (err) {
    console.error('Error in /api/analyze:', err.message);
    return res.status(500).json({ error: 'Failed to analyze image', details: err.message });
  }
});

app.get('/api/history', authenticateUser, (req, res) => {
  try {
    const { profile_id } = req.query;
    let rows;
    if (req.user) {
      const uid = req.user.id;
      if (profile_id === undefined) {
        rows = db.prepare(`SELECT * FROM scans WHERE user_id = ? ORDER BY scanned_at DESC LIMIT 20`).all(uid);
      } else if (!profile_id || profile_id === 'null') {
        rows = db.prepare(`SELECT * FROM scans WHERE user_id = ? AND profile_id IS NULL ORDER BY scanned_at DESC LIMIT 20`).all(uid);
      } else {
        rows = db.prepare(`SELECT * FROM scans WHERE user_id = ? AND profile_id = ? ORDER BY scanned_at DESC LIMIT 20`).all(uid, parseInt(profile_id, 10));
      }
    } else {
      if (profile_id === undefined) rows = selectAllScans.all();
      else if (!profile_id || profile_id === 'null') rows = selectNullScans.all();
      else rows = selectScansByProfile.all(parseInt(profile_id, 10));
    }
    const scans = rows.map(row => ({
      ...row,
      conditions:           JSON.parse(row.conditions           || '[]'),
      condition_flags:      JSON.parse(row.condition_flags      || '[]'),
      generic_alternatives: JSON.parse(row.generic_alternatives || '[]'),
      food_interactions:    JSON.parse(row.food_interactions    || '[]'),
    }));
    return res.json(scans);
  } catch (err) {
    console.error('Error in /api/history:', err.message);
    return res.status(500).json({ error: 'Failed to fetch history', details: err.message });
  }
});

app.get('/api/profiles', authenticateUser, (req, res) => {
  try {
    const rows = req.user
      ? db.prepare(`SELECT * FROM profiles WHERE user_id = ? ORDER BY created_at ASC`).all(req.user.id)
      : selectProfiles.all();
    return res.json(rows);
  } catch (err) {
    console.error('Error in /api/profiles:', err.message);
    return res.status(500).json({ error: 'Failed to fetch profiles', details: err.message });
  }
});

app.post('/api/profiles', authenticateUser, (req, res) => {
  try {
    const { name, relation, conditions } = req.body || {};
    if (!name || !relation) {
      return res.status(400).json({ error: 'name and relation are required' });
    }
    const uid = req.user ? req.user.id : null;
    const result = db.prepare(`INSERT INTO profiles (name, relation, conditions, user_id) VALUES (?, ?, ?, ?)`)
      .run(name, relation, JSON.stringify(conditions || []), uid);
    return res.json({ id: Number(result.lastInsertRowid), name, relation, conditions: conditions || [] });
  } catch (err) {
    console.error('Error in POST /api/profiles:', err.message);
    return res.status(500).json({ error: 'Failed to create profile', details: err.message });
  }
});

app.delete('/api/profiles/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    deleteProfileScans.run(id);
    deleteProfile.run(id);
    return res.json({ success: true });
  } catch (err) {
    console.error('Error in DELETE /api/profiles/:id:', err.message);
    return res.status(500).json({ error: 'Failed to delete profile', details: err.message });
  }
});

app.delete('/api/history/:id', (req, res) => {
  try {
    deleteScan.run(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('Error in DELETE /api/history/:id:', err.message);
    return res.status(500).json({ error: 'Failed to delete scan', details: err.message });
  }
});

app.post('/api/interactions', authenticateAPIKey, async (req, res) => {
  try {
    const { medicine1, medicine2 } = req.body || {};
    if (!medicine1 || !medicine2) {
      return res.status(400).json({ error: 'Both medicine1 and medicine2 are required' });
    }

    const prompt = `You are a clinical pharmacist. Check for drug interactions between: ${medicine1} and ${medicine2}.
Return ONLY a JSON object with these fields:
- severity: one of 'none', 'mild', 'moderate', 'severe'
- summary: one sentence plain English summary of the interaction
- effects: array of up to 4 strings describing specific interaction effects
- recommendation: one sentence on what the patient should do
No markdown, no explanation, only JSON.`;

    const claudeResponse = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
      }
    );

    let raw = claudeResponse.data.content[0].text;
    raw = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const result = JSON.parse(raw);
    return res.json(result);
  } catch (err) {
    console.error('Error in /api/interactions:', err.message);
    return res.status(500).json({ error: 'Failed to check interactions', details: err.message });
  }
});

// ── Admin routes ──
app.post('/admin/keys', requireAdminSecret, (req, res) => {
  try {
    const { client_name, email, plan = 'starter', monthly_limit = 500 } = req.body || {};
    if (!client_name || !email) {
      return res.status(400).json({ error: 'client_name and email are required' });
    }
    const key = 'pp_live_' + crypto.randomBytes(12).toString('hex');
    insertApiKey.run(client_name, email, key, plan, monthly_limit);
    return res.status(201).json({ client_name, email, api_key: key, plan, monthly_limit });
  } catch (err) {
    console.error('Error in POST /admin/keys:', err.message);
    return res.status(500).json({ error: 'Failed to create API key', details: err.message });
  }
});

app.get('/admin/keys', requireAdminSecret, (req, res) => {
  try {
    return res.json(selectAllKeys.all());
  } catch (err) {
    console.error('Error in GET /admin/keys:', err.message);
    return res.status(500).json({ error: 'Failed to fetch API keys', details: err.message });
  }
});

app.delete('/admin/keys/:id', requireAdminSecret, (req, res) => {
  try {
    deactivateKey.run(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('Error in DELETE /admin/keys/:id:', err.message);
    return res.status(500).json({ error: 'Failed to deactivate key', details: err.message });
  }
});

app.get('/admin/usage', requireAdminSecret, (req, res) => {
  try {
    return res.json(selectUsageLog.all());
  } catch (err) {
    console.error('Error in GET /admin/usage:', err.message);
    return res.status(500).json({ error: 'Failed to fetch usage log', details: err.message });
  }
});

// ── Reminder routes ──
app.post('/api/reminders', authenticateUser, (req, res) => {
  try {
    const { profile_id, medicine_name, dosage, frequency, times, notes } = req.body || {};
    if (!medicine_name || !frequency || !times) {
      return res.status(400).json({ error: 'medicine_name, frequency, and times are required' });
    }
    const pid = (profile_id && profile_id !== 'null') ? parseInt(profile_id, 10) : null;
    const uid = req.user ? req.user.id : null;
    const result = db.prepare(`INSERT INTO reminders (profile_id, medicine_name, dosage, frequency, times, notes, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(pid, medicine_name, dosage || '', frequency, JSON.stringify(times), notes || '', uid);
    return res.status(201).json({
      id: Number(result.lastInsertRowid), profile_id: pid,
      medicine_name, dosage: dosage || '', frequency, times, notes: notes || '',
    });
  } catch (err) {
    console.error('Error in POST /api/reminders:', err.message);
    return res.status(500).json({ error: 'Failed to create reminder', details: err.message });
  }
});

app.get('/api/reminders', authenticateUser, (req, res) => {
  try {
    const { profile_id } = req.query;
    let rows;
    if (req.user) {
      const uid = req.user.id;
      if (profile_id === undefined) {
        rows = db.prepare(`SELECT * FROM reminders WHERE user_id = ? AND active = 1 ORDER BY created_at DESC`).all(uid);
      } else if (!profile_id || profile_id === 'null') {
        rows = db.prepare(`SELECT * FROM reminders WHERE user_id = ? AND profile_id IS NULL AND active = 1 ORDER BY created_at DESC`).all(uid);
      } else {
        rows = db.prepare(`SELECT * FROM reminders WHERE user_id = ? AND profile_id = ? AND active = 1 ORDER BY created_at DESC`).all(uid, parseInt(profile_id, 10));
      }
    } else {
      if (profile_id === undefined) rows = selectAllReminders.all();
      else if (!profile_id || profile_id === 'null') rows = selectRemindersNull.all();
      else rows = selectRemindersByProfile.all(parseInt(profile_id, 10));
    }
    return res.json(rows.map(r => ({ ...r, times: JSON.parse(r.times || '[]') })));
  } catch (err) {
    console.error('Error in GET /api/reminders:', err.message);
    return res.status(500).json({ error: 'Failed to fetch reminders', details: err.message });
  }
});

app.delete('/api/reminders/:id', (req, res) => {
  try {
    deactivateReminder.run(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('Error in DELETE /api/reminders/:id:', err.message);
    return res.status(500).json({ error: 'Failed to delete reminder', details: err.message });
  }
});

// ── Analyze by name (for prescription medicine cards) ──
app.post('/api/analyze-by-name', authenticateAPIKey, async (req, res) => {
  try {
    const { medicine_name, conditions: condBody, profile_id: pidBody } = req.body || {};
    if (!medicine_name) return res.status(400).json({ error: 'medicine_name is required' });

    let warnings = '', adverse_reactions = '', contraindications = '', drug_interactions = '';
    let data_source = 'ai';

    try {
      const fdaUrl = `https://api.fda.gov/drug/label.json?search=openfda.brand_name:"${encodeURIComponent(medicine_name)}"&limit=1`;
      const fdaResponse = await axios.get(fdaUrl);
      if (fdaResponse.data.results && fdaResponse.data.results.length > 0) {
        const label = fdaResponse.data.results[0];
        warnings          = (label.warnings          && label.warnings[0]) || '';
        adverse_reactions = (label.adverse_reactions && label.adverse_reactions[0]) || '';
        contraindications = (label.contraindications && label.contraindications[0]) || '';
        drug_interactions = (label.drug_interactions && label.drug_interactions[0]) || '';
        if (warnings || adverse_reactions || contraindications || drug_interactions) data_source = 'fda';
      }
    } catch (_) {}

    if (data_source !== 'fda') {
      try {
        const indiaPrompt = `You are a pharmacist with expertise in Indian and global medicines. For the medicine: ${medicine_name}, provide safety information a patient should know. Return ONLY a JSON object with exactly these 4 fields as plain text strings: warnings, adverse_reactions, contraindications, drug_interactions. No markdown, no explanation.`;
        const r = await axios.post('https://api.anthropic.com/v1/messages',
          { model: 'claude-sonnet-4-20250514', max_tokens: 1024, messages: [{ role: 'user', content: indiaPrompt }] },
          { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
        );
        const d = JSON.parse(r.data.content[0].text.replace(/```json/gi, '').replace(/```/g, '').trim());
        warnings = d.warnings || ''; adverse_reactions = d.adverse_reactions || '';
        contraindications = d.contraindications || ''; drug_interactions = d.drug_interactions || '';
      } catch (_) {}
    }

    let generic_alternatives = [], food_interactions = [];
    try {
      const pharmPrompt = `You are a pharmacy assistant. Given this medicine: ${medicine_name}. Return ONLY a JSON object with exactly two fields: generic_alternatives (array of up to 3 strings, each a generic version with approximate price in INR), food_interactions (array of up to 5 strings, each a food/drink to avoid with reason). No markdown.`;
      const r = await axios.post('https://api.anthropic.com/v1/messages',
        { model: 'claude-sonnet-4-20250514', max_tokens: 1024, messages: [{ role: 'user', content: pharmPrompt }] },
        { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
      );
      const d = JSON.parse(r.data.content[0].text.replace(/```json/gi, '').replace(/```/g, '').trim());
      generic_alternatives = Array.isArray(d.generic_alternatives) ? d.generic_alternatives : [];
      food_interactions    = Array.isArray(d.food_interactions)    ? d.food_interactions    : [];
    } catch (_) {}

    let conditions = [];
    try { conditions = condBody ? JSON.parse(condBody) : []; } catch (_) {}
    const condition_flags = checkConditionFlags({ warnings, adverse_reactions }, conditions);

    let profile_id = null;
    if (pidBody && pidBody !== 'null') profile_id = parseInt(pidBody, 10) || null;

    try {
      insertScan.run(medicine_name, '', '', '', JSON.stringify(conditions),
        JSON.stringify(condition_flags), JSON.stringify(generic_alternatives),
        JSON.stringify(food_interactions), profile_id, '', null);
    } catch (_) {}

    return res.json({
      name: medicine_name, manufacturer: '', dosage: '', usage: '',
      confidence: 'From prescription', expiry_date: '', data_source,
      warnings, adverse_reactions, contraindications, drug_interactions,
      condition_flags, generic_alternatives, food_interactions,
      disclaimer: 'This is general medicine information only and not medical advice. Consult a doctor or pharmacist before making any health decisions.',
    });
  } catch (err) {
    console.error('Error in /api/analyze-by-name:', err.message);
    return res.status(500).json({ error: 'Failed to analyze medicine', details: err.message });
  }
});

// ── Prescription scanner ──
app.post('/api/scan-prescription', upload.single('prescription'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No prescription image uploaded' });

    const base64Image = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;

    const claudeResponse = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
            { type: 'text', text: 'You are a pharmacist. This is a doctor\'s prescription. Extract ALL medicine names listed. Return ONLY a JSON object with field: medicines (array of strings, each being a medicine name exactly as written). No markdown.' },
          ],
        }],
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
      }
    );

    let raw = claudeResponse.data.content[0].text;
    raw = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(raw);
    return res.json({ medicines: Array.isArray(parsed.medicines) ? parsed.medicines : [] });
  } catch (err) {
    console.error('Error in /api/scan-prescription:', err.message);
    return res.status(500).json({ error: 'Failed to scan prescription', details: err.message });
  }
});

// ── Medicine text search ──
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Query parameter q is required' });

    const claudePrompt = `You are a pharmacist. For the medicine: ${q}, return ONLY a JSON object with fields: name, manufacturer, dosage, usage, warnings, adverse_reactions, contraindications, drug_interactions, generic_alternatives (array of 3 strings with INR price), food_interactions (array of 5 strings), confidence (number 0-1). No markdown.`;

    let medicineData = {};
    try {
      const claudeRes = await axios.post(
        'https://api.anthropic.com/v1/messages',
        { model: 'claude-sonnet-4-20250514', max_tokens: 1500, messages: [{ role: 'user', content: claudePrompt }] },
        { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
      );
      medicineData = JSON.parse(claudeRes.data.content[0].text.replace(/```json/gi, '').replace(/```/g, '').trim());
    } catch (claudeErr) {
      console.error('Search Claude call failed:', claudeErr.message);
      return res.status(500).json({ error: 'Failed to fetch medicine information' });
    }

    let data_source = 'ai';
    try {
      const fdaUrl = `https://api.fda.gov/drug/label.json?search=openfda.brand_name:"${encodeURIComponent(q)}"&limit=1`;
      const fdaResponse = await axios.get(fdaUrl);
      if (fdaResponse.data.results && fdaResponse.data.results.length > 0) {
        const label = fdaResponse.data.results[0];
        const fw = (label.warnings          && label.warnings[0])          || '';
        const fa = (label.adverse_reactions && label.adverse_reactions[0]) || '';
        const fc = (label.contraindications && label.contraindications[0]) || '';
        const fd = (label.drug_interactions && label.drug_interactions[0]) || '';
        if (fw || fa || fc || fd) {
          medicineData.warnings          = fw || medicineData.warnings          || '';
          medicineData.adverse_reactions = fa || medicineData.adverse_reactions || '';
          medicineData.contraindications = fc || medicineData.contraindications || '';
          medicineData.drug_interactions = fd || medicineData.drug_interactions || '';
          data_source = 'fda';
        }
      }
    } catch (_) {}

    const generic_alternatives = Array.isArray(medicineData.generic_alternatives) ? medicineData.generic_alternatives : [];
    const food_interactions    = Array.isArray(medicineData.food_interactions)    ? medicineData.food_interactions    : [];

    try {
      insertScan.run(
        medicineData.name || q, medicineData.manufacturer || '', medicineData.dosage || '',
        medicineData.usage || '', JSON.stringify([]), JSON.stringify([]),
        JSON.stringify(generic_alternatives), JSON.stringify(food_interactions), null, ''
      );
    } catch (_) {}

    const confidenceRaw = medicineData.confidence;
    const confidenceStr = typeof confidenceRaw === 'number'
      ? `${Math.round(confidenceRaw * 100)}%`
      : (confidenceRaw || '');

    return res.json({
      name:             medicineData.name         || q,
      manufacturer:     medicineData.manufacturer || '',
      dosage:           medicineData.dosage        || '',
      usage:            medicineData.usage         || '',
      confidence:       confidenceStr,
      expiry_date:      '',
      data_source,
      warnings:         medicineData.warnings          || '',
      adverse_reactions:medicineData.adverse_reactions || '',
      contraindications:medicineData.contraindications || '',
      drug_interactions:medicineData.drug_interactions || '',
      condition_flags:  [],
      generic_alternatives,
      food_interactions,
      disclaimer: 'This is general medicine information only and not medical advice. Consult a doctor or pharmacist before making any health decisions.',
    });
  } catch (err) {
    console.error('Error in /api/search:', err.message);
    return res.status(500).json({ error: 'Failed to search medicine', details: err.message });
  }
});

// ── Medicine chatbot ──
app.post('/api/chat', async (req, res) => {
  try {
    const { message, medicine_context, chat_history } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message is required' });

    const contextStr = medicine_context ? JSON.stringify(medicine_context) : '{}';
    const systemPrompt = `You are Pill Pal, a friendly medicine information assistant. You have information about this medicine: ${contextStr}. Answer the user's question in plain, simple English. Be accurate, calm, and helpful. Never provide clinical advice or dosage recommendations. Always end responses that touch on safety with: 'Please consult your doctor or pharmacist for personal medical advice.' Keep responses under 100 words.`;

    const messages = [
      ...(Array.isArray(chat_history) ? chat_history : []),
      { role: 'user', content: message },
    ];

    const claudeResponse = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-4-20250514', max_tokens: 300, system: systemPrompt, messages },
      { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );

    return res.json({ reply: claudeResponse.data.content[0].text });
  } catch (err) {
    console.error('Error in /api/chat:', err.message);
    return res.status(500).json({ error: 'Failed to get response', details: err.message });
  }
});

app.get('/api/expiry-alerts', (req, res) => {
  try {
    const scans = selectScansWithExpiry.all();
    const now = new Date();

    const alerts = scans
      .map(scan => {
        const match = (scan.expiry_date || '').match(/(\d{1,2})\/(\d{4})/);
        if (!match) return null;
        const month = parseInt(match[1], 10);
        const year  = parseInt(match[2], 10);
        // Last day of the expiry month
        const expiryDate = new Date(year, month, 0);
        const daysLeft = Math.ceil((expiryDate - now) / (24 * 60 * 60 * 1000));
        if (daysLeft > 60) return null;
        return {
          id:            scan.id,
          medicine_name: scan.medicine_name,
          expiry_date:   scan.expiry_date,
          scanned_at:    scan.scanned_at,
          days_left:     daysLeft,
          expired:       daysLeft < 0,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.days_left - b.days_left);

    return res.json(alerts);
  } catch (err) {
    console.error('Error in /api/expiry-alerts:', err.message);
    return res.status(500).json({ error: 'Failed to fetch expiry alerts' });
  }
});

app.get('/',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
