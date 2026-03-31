require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

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

db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT,
    relation   TEXT,
    conditions TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const insertScan           = db.prepare(`INSERT INTO scans (medicine_name, manufacturer, dosage, usage, conditions, condition_flags, generic_alternatives, food_interactions, profile_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const selectAllScans       = db.prepare(`SELECT * FROM scans ORDER BY scanned_at DESC LIMIT 20`);
const selectScansByProfile = db.prepare(`SELECT * FROM scans WHERE profile_id = ? ORDER BY scanned_at DESC LIMIT 20`);
const selectNullScans      = db.prepare(`SELECT * FROM scans WHERE profile_id IS NULL ORDER BY scanned_at DESC LIMIT 20`);
const deleteScan           = db.prepare(`DELETE FROM scans WHERE id = ?`);

const selectProfiles     = db.prepare(`SELECT * FROM profiles ORDER BY created_at ASC`);
const insertProfile      = db.prepare(`INSERT INTO profiles (name, relation, conditions) VALUES (?, ?, ?)`);
const deleteProfile      = db.prepare(`DELETE FROM profiles WHERE id = ?`);
const deleteProfileScans = db.prepare(`DELETE FROM scans WHERE profile_id = ?`);

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

// ── Routes ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/analyze', upload.single('medicine'), async (req, res) => {
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
        system: 'You are Pill Pal, a medicine identification assistant. When given a medicine image, extract: medicine name, manufacturer, dosage, usage/purpose. Return ONLY a JSON object with fields: name, manufacturer, dosage, usage, confidence. No markdown, no explanation.',
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

    let warnings = '';
    let adverse_reactions = '';
    let contraindications = '';
    let drug_interactions = '';

    try {
      const fdaUrl = `https://api.fda.gov/drug/label.json?search=openfda.brand_name:"${encodeURIComponent(medicineData.name)}"&limit=1`;
      const fdaResponse = await axios.get(fdaUrl);

      if (fdaResponse.data.results && fdaResponse.data.results.length > 0) {
        const label = fdaResponse.data.results[0];
        warnings          = (label.warnings          && label.warnings[0])          || '';
        adverse_reactions = (label.adverse_reactions && label.adverse_reactions[0]) || '';
        contraindications = (label.contraindications && label.contraindications[0]) || '';
        drug_interactions = (label.drug_interactions && label.drug_interactions[0]) || '';
      }
    } catch (fdaError) {
      // OpenFDA returned no results or errored — continue with empty strings
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
      insertScan.run(
        medicineData.name         || '',
        medicineData.manufacturer || '',
        medicineData.dosage       || '',
        medicineData.usage        || '',
        JSON.stringify(conditions),
        JSON.stringify(condition_flags),
        JSON.stringify(generic_alternatives),
        JSON.stringify(food_interactions),
        profile_id
      );
    } catch (dbErr) {
      console.error('DB insert error:', dbErr.message);
    }

    return res.json({
      name:             medicineData.name         || '',
      manufacturer:     medicineData.manufacturer || '',
      dosage:           medicineData.dosage        || '',
      usage:            medicineData.usage         || '',
      confidence:       medicineData.confidence    || '',
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

app.get('/api/history', (req, res) => {
  try {
    const { profile_id } = req.query;
    let rows;
    if (profile_id === undefined) {
      rows = selectAllScans.all();
    } else if (!profile_id || profile_id === 'null') {
      rows = selectNullScans.all();
    } else {
      rows = selectScansByProfile.all(parseInt(profile_id, 10));
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

app.get('/api/profiles', (req, res) => {
  try {
    return res.json(selectProfiles.all());
  } catch (err) {
    console.error('Error in /api/profiles:', err.message);
    return res.status(500).json({ error: 'Failed to fetch profiles', details: err.message });
  }
});

app.post('/api/profiles', (req, res) => {
  try {
    const { name, relation, conditions } = req.body || {};
    if (!name || !relation) {
      return res.status(400).json({ error: 'name and relation are required' });
    }
    const result = insertProfile.run(name, relation, JSON.stringify(conditions || []));
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

app.post('/api/interactions', async (req, res) => {
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

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
