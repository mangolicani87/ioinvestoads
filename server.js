require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');
const Database = require('better-sqlite3');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ─── DATABASE SETUP ───────────────────────────────────────────────────────────
const db = new Database('ioinvesto.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS ad_accounts (
    id TEXT PRIMARY KEY,
    name TEXT,
    currency TEXT,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS ads (
    id TEXT PRIMARY KEY,
    account_id TEXT,
    name TEXT,
    status TEXT,
    effective_status TEXT,
    campaign_name TEXT,
    adset_name TEXT,
    thumbnail_url TEXT,
    video_url TEXT,
    spend REAL DEFAULT 0,
    impressions INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    ctr REAL DEFAULT 0,
    leads INTEGER DEFAULT 0,
    cpl REAL DEFAULT 0,
    hook_rate REAL DEFAULT 0,
    hold_rate REAL DEFAULT 0,
    video_views_3s INTEGER DEFAULT 0,
    video_views_100pct INTEGER DEFAULT 0,
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS ad_analysis (
    ad_id TEXT PRIMARY KEY,
    asset_type TEXT,
    visual_format TEXT,
    messaging_angle TEXT,
    hook_tactic TEXT,
    offer_type TEXT,
    funnel_stage TEXT,
    ai_summary TEXT,
    strengths TEXT,
    improvements TEXT,
    iterations TEXT,
    analyzed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT,
    period_start TEXT,
    period_end TEXT,
    data TEXT,
    ai_insights TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ─── HELPERS ──────────────────────────────────────────────────────────────────
// Mappa tra chiavi DB e variabili d'ambiente Render
const ENV_MAP = {
  meta_token: 'META_TOKEN',
  anthropic_key: 'ANTHROPIC_KEY',
  cpl_target: 'CPL_TARGET',
};

function getSetting(key, defaultVal = null) {
  // Prima cerca nel DB (impostato dall'UI)
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row && row.value) return row.value;
  // Poi cerca nelle variabili d'ambiente Render
  const envKey = ENV_MAP[key];
  if (envKey && process.env[envKey]) return process.env[envKey];
  return defaultVal;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

async function metaFetch(path, token) {
  const url = `https://graph.facebook.com/v19.0${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

// ─── SETTINGS ROUTES ──────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const keys = ['meta_token', 'anthropic_key', 'cpl_target', 'winner_threshold_type'];
  const result = {};
  keys.forEach(k => { result[k] = getSetting(k, ''); });
  res.json(result);
});

app.post('/api/settings', (req, res) => {
  const { meta_token, anthropic_key, cpl_target, winner_threshold_type } = req.body;
  if (meta_token !== undefined) setSetting('meta_token', meta_token);
  if (anthropic_key !== undefined) setSetting('anthropic_key', anthropic_key);
  if (cpl_target !== undefined) setSetting('cpl_target', cpl_target);
  if (winner_threshold_type !== undefined) setSetting('winner_threshold_type', winner_threshold_type);
  res.json({ ok: true });
});

// ─── META ACCOUNTS ────────────────────────────────────────────────────────────
app.get('/api/meta/accounts', async (req, res) => {
  try {
    const token = getSetting('meta_token');
    if (!token) return res.status(400).json({ error: 'Meta token non configurato' });
    const data = await metaFetch('/me/adaccounts?fields=id,name,currency,account_status', token);
    res.json(data.data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/add', async (req, res) => {
  try {
    const { account_id } = req.body;
    const token = getSetting('meta_token');
    const info = await metaFetch(`/${account_id}?fields=id,name,currency`, token);
    db.prepare('INSERT OR REPLACE INTO ad_accounts (id, name, currency) VALUES (?, ?, ?)')
      .run(info.id, info.name, info.currency);
    // sync ads immediately
    await syncAccountAds(info.id, token);
    res.json({ ok: true, account: info });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/accounts', (req, res) => {
  res.json(db.prepare('SELECT * FROM ad_accounts').all());
});

app.delete('/api/accounts/:id', (req, res) => {
  db.prepare('DELETE FROM ad_accounts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── SYNC ADS ─────────────────────────────────────────────────────────────────
async function syncAccountAds(accountId, token) {
  const actId = accountId.startsWith('act_') ? accountId : `act_${accountId}`;

  // Get ads with campaign/adset info and effective_status
  const adsData = await metaFetch(
    `/${actId}/ads?fields=id,name,status,effective_status,campaign{name},adset{name},creative{thumbnail_url,video_id}&date_preset=last_90d&limit=200`,
    token
  );

  // Get insights
  const insightsData = await metaFetch(
    `/${actId}/insights?fields=ad_id,spend,impressions,clicks,ctr,actions,cost_per_action_type,video_thruplay_watched_actions,video_p25_watched_actions&date_preset=last_90d&level=ad&limit=200`,
    token
  );

  // Map insights by ad_id
  const insightsMap = {};
  (insightsData.data || []).forEach(ins => {
    // Tutti i possibili action_type per conversioni IoInvesto
    // Include registrazioni webinar, typeform, lead nativi Meta, e custom conversions
    const CONVERSION_TYPES = [
      'complete_registration',           // Registrazione webinar (il principale per IoInvesto)
      'offsite_conversion.fb_pixel_complete_registration',
      'lead',
      'onsite_conversion.lead_grouped',
      'leadgen_grouped',
      'offsite_conversion.fb_pixel_lead',
      'contact',
      'contact_total',
      'subscribe',
      'offsite_conversion.fb_pixel_custom', // TypeformSubmit e altre custom
      'onsite_conversion.messaging_conversation_started_7d',
    ];

    // Trova la conversione principale con più risultati
    let bestLeadAction = null;
    let bestLeadCount = 0;

    (ins.actions || []).forEach(a => {
      const val = parseInt(a.value || 0);
      // Controlla sia tipi noti che qualsiasi custom conversion
      const isConversion = CONVERSION_TYPES.includes(a.action_type) ||
        a.action_type.startsWith('offsite_conversion.custom.') ||
        a.action_type.includes('typeform') ||
        a.action_type.includes('registration') ||
        a.action_type.includes('submit') ||
        a.action_type.includes('lead');

      if (isConversion && val > bestLeadCount) {
        bestLeadCount = val;
        bestLeadAction = a;
      }
    });

    // CPL corrispondente
    let totalCpl = 0;
    if (bestLeadAction) {
      const cplMatch = (ins.cost_per_action_type || []).find(a =>
        a.action_type === bestLeadAction.action_type
      );
      if (cplMatch) totalCpl = parseFloat(cplMatch.value || 0);
      else if (bestLeadCount > 0) totalCpl = parseFloat(ins.spend || 0) / bestLeadCount;
    }

    const video3s = (ins.video_p25_watched_actions || []).find(a => a.action_type === 'video_view');
    const videoThru = (ins.video_thruplay_watched_actions || []).find(a => a.action_type === 'video_view');

    insightsMap[ins.ad_id] = {
      spend: parseFloat(ins.spend || 0),
      impressions: parseInt(ins.impressions || 0),
      clicks: parseInt(ins.clicks || 0),
      ctr: parseFloat(ins.ctr || 0),
      leads: bestLeadCount,
      cpl: totalCpl,
      video_views_3s: parseInt(video3s?.value || 0),
      video_views_100pct: parseInt(videoThru?.value || 0),
    };
  });

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO ads 
    (id, account_id, name, status, effective_status, campaign_name, adset_name, thumbnail_url, spend, impressions, clicks, ctr, leads, cpl, hook_rate, hold_rate, video_views_3s, video_views_100pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const ad of (adsData.data || [])) {
    const ins = insightsMap[ad.id] || {};
    const hook_rate = ins.impressions > 0 ? ((ins.video_views_3s / ins.impressions) * 100) : 0;
    const hold_rate = ins.video_views_3s > 0 ? ((ins.video_views_100pct / ins.video_views_3s) * 100) : 0;
    const thumbnail = ad.creative?.thumbnail_url || '';
    const campaignName = ad.campaign?.name || '';
    const adsetName = ad.adset?.name || '';
    // effective_status riflette lo stato reale (include pause di campagna/adset)
    const effectiveStatus = ad.effective_status || ad.status || 'UNKNOWN';
    stmt.run(
      ad.id, accountId, ad.name, ad.status, effectiveStatus, campaignName, adsetName, thumbnail,
      ins.spend || 0, ins.impressions || 0, ins.clicks || 0,
      ins.ctr || 0, ins.leads || 0, ins.cpl || 0,
      hook_rate, hold_rate,
      ins.video_views_3s || 0, ins.video_views_100pct || 0
    );
  }
}

app.post('/api/sync/:accountId', async (req, res) => {
  try {
    const token = getSetting('meta_token');
    await syncAccountAds(req.params.accountId, token);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ADS ROUTES ───────────────────────────────────────────────────────────────
app.get('/api/ads', (req, res) => {
  const { account_id } = req.query;
  let query = `
    SELECT a.*, an.asset_type, an.visual_format, an.messaging_angle, 
           an.hook_tactic, an.offer_type, an.funnel_stage, an.ai_summary,
           an.strengths, an.improvements, an.iterations
    FROM ads a
    LEFT JOIN ad_analysis an ON a.id = an.ad_id
  `;
  const params = [];
  if (account_id && account_id !== 'all') {
    query += ' WHERE a.account_id = ?';
    params.push(account_id);
  }
  query += ' ORDER BY a.spend DESC';
  res.json(db.prepare(query).all(...params));
});

// ─── AI ANALYSIS ──────────────────────────────────────────────────────────────
app.post('/api/analyze/:adId', async (req, res) => {
  try {
    const apiKey = getSetting('anthropic_key');
    if (!apiKey) return res.status(400).json({ error: 'API key Anthropic non configurata' });

    const ad = db.prepare('SELECT * FROM ads WHERE id = ?').get(req.params.adId);
    if (!ad) return res.status(404).json({ error: 'Ad non trovato' });

    const client = new Anthropic({ apiKey });

    const cplTarget = parseFloat(getSetting('cpl_target', '50'));
    const isWinner = ad.leads > 0 && ad.cpl > 0 && ad.cpl <= cplTarget;

    const prompt = `Sei un esperto senior di performance marketing per servizi finanziari in Italia. Conosci bene IoInvesto SCF, la più grande rete di consulenti finanziari indipendenti fee-only in Italia.

CONTESTO IOINVESTO:
- Prodotto: consulenza finanziaria indipendente, zero conflitti di interesse, nessuna retrocessione
- Target principale: famiglie e professionisti italiani 35-60 anni con patrimonio €100k+ che sono delusi dalle banche tradizionali
- Funnel principale: webinar gratuiti sulla pensione/investimenti → consulenza gratuita → cliente pagante
- Differenziatore chiave: "paghiamo solo noi, non le banche" — il consulente lavora per il cliente, non per prodotti finanziari
- Competitor: promotori finanziari di banche (Mediolanum, Fineco, ecc.)
- CPL target: €${cplTarget} — sotto questa soglia l'ad è considerato vincente

NOME DELL'AD: ${ad.name}
STATUS: ${ad.status}

METRICHE PERFORMANCE:
- Spesa: €${ad.spend.toFixed(2)}
- Impressioni: ${ad.impressions.toLocaleString('it-IT')}
- Click: ${ad.clicks} | CTR: ${ad.ctr.toFixed(2)}%
- Lead generati: ${ad.leads}
- CPL: ${ad.cpl > 0 ? '€' + ad.cpl.toFixed(2) : 'nessun lead'} (target: €${cplTarget})
- Hook Rate (prime 3 secondi): ${ad.hook_rate.toFixed(1)}%
- Hold Rate (completamento video): ${ad.hold_rate.toFixed(1)}%
- Giudizio: ${isWinner ? '✓ WINNER — CPL sotto target' : ad.leads === 0 && ad.spend > 20 ? '✗ ZERO LEAD — spesa sprecata' : '⚠ DA OTTIMIZZARE — CPL sopra target'}

BENCHMARK DI SETTORE (finanza italiana Meta Ads):
- Hook Rate buono: >25% | medio: 15-25% | basso: <15%
- CTR buono: >1.5% | medio: 0.8-1.5% | basso: <0.8%
- CPL buono per webinar finanziario: €15-35 | medio: €35-60 | alto: >€60

Analizza il nome dell'ad per dedurre il contenuto (es. "avatar_pensione_hook1" → video avatar sul tema pensione con primo hook testato).

Rispondi SOLO con un JSON valido (nessun testo fuori dal JSON):
{
  "asset_type": "UGC | Video Avatar AI | Static Image | Carousel | Screen Recording | Carosello Grafico",
  "visual_format": "Talking Head | Avatar AI | Testimonial | Demo Prodotto | Infografica | Lifestyle | Testo Animato",
  "messaging_angle": "Paura pensione | Indipendenza dal banker | Confronto fee-only vs banca | Autorità/Expert | Rendimento garantito | Protezione patrimonio | Risparmio fiscale | Errori comuni investitori | Costi nascosti banca",
  "hook_tactic": "Domanda provocatoria | Dato/Statistica shock | Storia personale | Problema comune | Promessa risultato | Contraddizione | Sfida al sistema | Identificazione target",
  "offer_type": "Webinar gratuito pensione | Webinar gratuito investimenti | Consulenza gratuita | Analisi portafoglio gratuita | Lead magnet (guida/report) | Nessuna offerta chiara",
  "funnel_stage": "Top of Funnel | Middle of Funnel | Bottom of Funnel",
  "ai_summary": "Analisi in 3 frasi: cosa comunica l'ad, perché sta performando così (con riferimento ai dati specifici), e qual è il problema principale da risolvere",
  "strengths": ["punto forza specifico con dato", "secondo punto forza"],
  "improvements": ["problema specifico con dato", "secondo problema"],
  "iterations": [
    {
      "title": "Variante A: [nome descrittivo]",
      "description": "Descrizione concreta e specifica di cosa cambiare — non generica. Es: 'Sostituire l'hook con la statistica: X italiani su 10 arriveranno alla pensione con meno del 60% del loro stipendio attuale' oppure 'Aggiungere social proof: mostrare numero di famiglie già seguite da IoInvesto'",
      "expected_impact": "Alto | Medio | Basso"
    },
    {
      "title": "Variante B: [nome descrittivo]",
      "description": "Seconda variante concreta e diversa dalla prima — testa una leva diversa (es. se la prima testa l'hook, questa testa l'offerta o il formato)",
      "expected_impact": "Alto | Medio | Basso"
    }
  ]
}`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content[0].text;

    // Pulizia robusta del JSON
    let jsonStr = raw;
    // Rimuovi eventuali backtick markdown
    jsonStr = jsonStr.replace(/```json\s*/gi, '').replace(/```\s*/gi, '');
    // Estrai il primo oggetto JSON valido
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Risposta AI non valida - nessun JSON trovato');

    // Sanitizza caratteri problematici nelle stringhe JSON
    let cleanJson = jsonMatch[0]
      .replace(/[\x00-\x1F\x7F]/g, ' ') // rimuovi caratteri di controllo
      .replace(/,(\s*[}\]])/g, '$1');     // rimuovi virgole finali

    let analysis;
    try {
      analysis = JSON.parse(cleanJson);
    } catch(parseErr) {
      // Fallback: costruisci oggetto manuale dai campi trovati
      analysis = {
        asset_type: raw.match(/"asset_type"\s*:\s*"([^"]+)"/)?.[1] || 'Non classificato',
        visual_format: raw.match(/"visual_format"\s*:\s*"([^"]+)"/)?.[1] || 'Non classificato',
        messaging_angle: raw.match(/"messaging_angle"\s*:\s*"([^"]+)"/)?.[1] || 'Non classificato',
        hook_tactic: raw.match(/"hook_tactic"\s*:\s*"([^"]+)"/)?.[1] || 'Non classificato',
        offer_type: raw.match(/"offer_type"\s*:\s*"([^"]+)"/)?.[1] || 'Non classificato',
        funnel_stage: raw.match(/"funnel_stage"\s*:\s*"([^"]+)"/)?.[1] || 'Top of Funnel',
        ai_summary: raw.match(/"ai_summary"\s*:\s*"([^"]+)"/)?.[1] || 'Analisi non disponibile',
        strengths: ['Dati insufficienti per analisi completa'],
        improvements: ['Rianalizzare quando disponibili più dati'],
        iterations: [{ title: 'Rianalizzare', description: 'Clicca AI per una nuova analisi', expected_impact: 'Medio' }]
      };
    }

    db.prepare(`
      INSERT OR REPLACE INTO ad_analysis 
      (ad_id, asset_type, visual_format, messaging_angle, hook_tactic, offer_type, funnel_stage, ai_summary, strengths, improvements, iterations)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.adId,
      analysis.asset_type, analysis.visual_format, analysis.messaging_angle,
      analysis.hook_tactic, analysis.offer_type, analysis.funnel_stage,
      analysis.ai_summary,
      JSON.stringify(analysis.strengths),
      JSON.stringify(analysis.improvements),
      JSON.stringify(analysis.iterations)
    );

    res.json({ ok: true, analysis });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/analyze-all', async (req, res) => {
  const { account_id } = req.body;
  let query = 'SELECT a.id FROM ads a LEFT JOIN ad_analysis an ON a.id = an.ad_id WHERE an.ad_id IS NULL';
  const params = [];
  if (account_id && account_id !== 'all') {
    query += ' AND a.account_id = ?';
    params.push(account_id);
  }
  const unanalyzed = db.prepare(query).all(...params);
  res.json({ queued: unanalyzed.length, ids: unanalyzed.map(r => r.id) });
});

// ─── ANALYTICS ────────────────────────────────────────────────────────────────
app.get('/api/analytics', (req, res) => {
  const { account_id } = req.query;
  const cplTarget = parseFloat(getSetting('cpl_target', '50'));

  let where = account_id && account_id !== 'all' ? 'WHERE a.account_id = ?' : 'WHERE 1=1';
  const params = account_id && account_id !== 'all' ? [account_id] : [];

  const ads = db.prepare(`
    SELECT a.*, an.asset_type, an.messaging_angle, an.hook_tactic, 
           an.funnel_stage, an.offer_type, an.iterations, an.improvements
    FROM ads a LEFT JOIN ad_analysis an ON a.id = an.ad_id
    ${where} AND a.spend > 0
  `).all(...params);

  const total = ads.length;
  const winners = ads.filter(a => a.leads > 0 && a.cpl > 0 && a.cpl <= cplTarget);
  const avgCpl = ads.reduce((s, a) => s + a.cpl, 0) / (ads.filter(a => a.cpl > 0).length || 1);
  const totalSpend = ads.reduce((s, a) => s + a.spend, 0);
  const totalLeads = ads.reduce((s, a) => s + a.leads, 0);

  // Group by various dimensions
  function groupBy(field) {
    const groups = {};
    ads.forEach(a => {
      const key = a[field] || 'Non classificato';
      if (!groups[key]) groups[key] = { count: 0, winners: 0, spend: 0, leads: 0, cpls: [] };
      groups[key].count++;
      groups[key].spend += a.spend;
      groups[key].leads += a.leads;
      if (a.leads > 0 && a.cpl > 0) groups[key].cpls.push(a.cpl);
      if (a.leads > 0 && a.cpl > 0 && a.cpl <= cplTarget) groups[key].winners++;
    });
    return Object.entries(groups).map(([name, g]) => ({
      name,
      count: g.count,
      winners: g.winners,
      win_rate: g.count > 0 ? Math.round((g.winners / g.count) * 100) : 0,
      spend: g.spend,
      leads: g.leads,
      avg_cpl: g.cpls.length > 0 ? g.cpls.reduce((s, c) => s + c, 0) / g.cpls.length : 0
    })).sort((a, b) => b.spend - a.spend);
  }

  // Kill/Scale/Watch
  const killScaleWatch = {
    top_of_funnel: [],
    middle_of_funnel: [],
    bottom_of_funnel: []
  };

  const avgHookRate = ads.filter(a => a.hook_rate > 0).reduce((s, a) => s + a.hook_rate, 0) / (ads.filter(a => a.hook_rate > 0).length || 1);
  const avgCtr = ads.filter(a => a.ctr > 0).reduce((s, a) => s + a.ctr, 0) / (ads.filter(a => a.ctr > 0).length || 1);

  ads.forEach(a => {
    if (!a.funnel_stage || a.spend < 10) return;
    let rec = '', reason = '';

    if (a.funnel_stage === 'Top of Funnel') {
      if (a.hook_rate < avgHookRate * 0.7 && a.ctr < avgCtr * 0.7) { rec = 'kill'; reason = `Hook rate ${a.hook_rate.toFixed(1)}% e CTR ${a.ctr.toFixed(2)}% sotto media`; }
      else if (a.hook_rate > avgHookRate * 1.2 || a.ctr > avgCtr * 1.2) { rec = 'scale'; reason = `Hook rate ${a.hook_rate.toFixed(1)}% o CTR sopra media`; }
      else { rec = 'watch'; reason = 'Metriche nella media, continuare a monitorare'; }
      killScaleWatch.top_of_funnel.push({ ...a, recommendation: rec, reason });
    } else if (a.funnel_stage === 'Middle of Funnel') {
      if (a.ctr < avgCtr * 0.7 && (a.cpl > cplTarget * 1.5 || a.leads === 0)) { rec = 'kill'; reason = `CTR basso e CPL €${a.cpl.toFixed(0)} oltre target`; }
      else if (a.ctr > avgCtr * 1.2 && a.cpl > 0 && a.cpl <= cplTarget) { rec = 'scale'; reason = `CTR buono e CPL €${a.cpl.toFixed(0)} sotto target`; }
      else { rec = 'watch'; reason = 'Monitorare CTR e CPL'; }
      killScaleWatch.middle_of_funnel.push({ ...a, recommendation: rec, reason });
    } else if (a.funnel_stage === 'Bottom of Funnel') {
      if (a.leads === 0 && a.spend > 50) { rec = 'kill'; reason = `€${a.cpl.toFixed(0)} spesi, 0 lead generati`; }
      else if (a.cpl > 0 && a.cpl <= cplTarget * 0.8) { rec = 'scale'; reason = `CPL €${a.cpl.toFixed(0)} eccellente (target €${cplTarget})`; }
      else if (a.cpl > cplTarget * 1.3) { rec = 'kill'; reason = `CPL €${a.cpl.toFixed(0)} troppo alto (target €${cplTarget})`; }
      else { rec = 'watch'; reason = `CPL €${a.cpl.toFixed(0)} vicino al target`; }
      killScaleWatch.bottom_of_funnel.push({ ...a, recommendation: rec, reason });
    }
  });

  // Iteration priorities: high spend + underperforming
  const iterationPriority = ads
    .filter(a => a.spend > 30 && (a.cpl > cplTarget * 1.2 || (a.spend > 20 && a.leads === 0)))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);

  res.json({
    summary: { total, winners: winners.length, win_rate: total > 0 ? Math.round((winners.length / total) * 100) : 0, avg_cpl: avgCpl, total_spend: totalSpend, total_leads: totalLeads, cpl_target: cplTarget },
    by_asset_type: groupBy('asset_type'),
    by_messaging_angle: groupBy('messaging_angle'),
    by_hook_tactic: groupBy('hook_tactic'),
    by_funnel_stage: groupBy('funnel_stage'),
    kill_scale_watch: killScaleWatch,
    iteration_priority: iterationPriority
  });
});

// ─── REPORTS ──────────────────────────────────────────────────────────────────
app.post('/api/reports/generate', async (req, res) => {
  try {
    const { account_id, days = 30 } = req.body;
    const apiKey = getSetting('anthropic_key');
    if (!apiKey) return res.status(400).json({ error: 'API key Anthropic non configurata' });

    let where = account_id && account_id !== 'all' ? 'WHERE a.account_id = ?' : 'WHERE 1=1';
    const params = account_id && account_id !== 'all' ? [account_id] : [];

    const ads = db.prepare(`
      SELECT a.*, an.asset_type, an.messaging_angle, an.funnel_stage
      FROM ads a LEFT JOIN ad_analysis an ON a.id = an.ad_id
      ${where} AND a.spend > 0
    `).all(...params);

    const cplTarget = parseFloat(getSetting('cpl_target', '50'));
    const totalSpend = ads.reduce((s, a) => s + a.spend, 0);
    const totalLeads = ads.reduce((s, a) => s + a.leads, 0);
    const winners = ads.filter(a => a.cpl > 0 && a.cpl <= cplTarget);
    const avgCpl = totalLeads > 0 ? totalSpend / totalLeads : 0;

    const top5 = [...ads].filter(a => a.leads > 0).sort((a, b) => a.cpl - b.cpl).slice(0, 5);
    const bottom5 = [...ads].filter(a => a.spend > 20).sort((a, b) => b.cpl - a.cpl).slice(0, 5);

    const reportData = { totalSpend, totalLeads, avgCpl, winners: winners.length, total: ads.length, top5, bottom5, cplTarget };

    const client = new Anthropic({ apiKey });
    const aiMessage = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Sei un senior performance marketer specializzato in financial services B2C in Italia.

Analizza questi dati di performance delle ultime ${days} campagne Meta Ads di IoInvesto SCF (consulenza finanziaria indipendente fee-only):

RIEPILOGO:
- Spesa totale: €${totalSpend.toFixed(2)}
- Lead totali: ${totalLeads}
- CPL medio: €${avgCpl.toFixed(2)} (target: €${cplTarget})
- Win rate (CPL ≤ €${cplTarget}): ${winners.length}/${ads.length} (${Math.round(winners.length/ads.length*100)||0}%)

TOP 5 ADS PER CPL:
${top5.map(a => `- ${a.name}: €${a.cpl.toFixed(2)} CPL, ${a.leads} lead, €${a.spend.toFixed(0)} spesa | Angolo: ${a.messaging_angle || 'n/a'} | Stage: ${a.funnel_stage || 'n/a'}`).join('\n')}

BOTTOM 5 ADS (più costosi):
${bottom5.map(a => `- ${a.name}: €${a.cpl.toFixed(2)} CPL, ${a.leads} lead, €${a.spend.toFixed(0)} spesa | Angolo: ${a.messaging_angle || 'n/a'}`).join('\n')}

Scrivi un report strategico in italiano con:
1. **Executive Summary** (3-4 frasi)
2. **Cosa sta funzionando** (con dati specifici)
3. **Problemi critici da risolvere** 
4. **3 azioni prioritarie per la prossima settimana**
5. **Insight sul target audience** basati sugli angoli vincenti

Sii diretto, concreto, usa i dati. Parla come un consulente senior.`
      }]
    });

    const insights = aiMessage.content[0].text;

    db.prepare('INSERT INTO reports (account_id, period_start, period_end, data, ai_insights) VALUES (?, ?, ?, ?, ?)')
      .run(account_id || 'all', new Date(Date.now() - days * 86400000).toISOString(), new Date().toISOString(), JSON.stringify(reportData), insights);

    res.json({ ok: true, data: reportData, insights });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/reports', (req, res) => {
  const reports = db.prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT 10').all();
  res.json(reports);
});

// ─── SERVE FRONTEND ───────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`IoInvesto Creative Analytics → porta ${PORT}`));
