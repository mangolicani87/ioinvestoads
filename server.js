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
function getSetting(key, defaultVal = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultVal;
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

  // Get ads list with creatives
  const adsData = await metaFetch(
    `/${actId}/ads?fields=id,name,status,creative{thumbnail_url,video_id}&date_preset=last_90d&limit=200`,
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
    const leads = (ins.actions || []).find(a =>
      a.action_type === 'lead' || a.action_type === 'onsite_conversion.lead_grouped'
    );
    const cplAction = (ins.cost_per_action_type || []).find(a =>
      a.action_type === 'lead' || a.action_type === 'onsite_conversion.lead_grouped'
    );
    const video3s = (ins.video_p25_watched_actions || []).find(a => a.action_type === 'video_view');
    const videoThru = (ins.video_thruplay_watched_actions || []).find(a => a.action_type === 'video_view');

    insightsMap[ins.ad_id] = {
      spend: parseFloat(ins.spend || 0),
      impressions: parseInt(ins.impressions || 0),
      clicks: parseInt(ins.clicks || 0),
      ctr: parseFloat(ins.ctr || 0),
      leads: parseInt(leads?.value || 0),
      cpl: parseFloat(cplAction?.value || 0),
      video_views_3s: parseInt(video3s?.value || 0),
      video_views_100pct: parseInt(videoThru?.value || 0),
    };
  });

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO ads 
    (id, account_id, name, status, thumbnail_url, spend, impressions, clicks, ctr, leads, cpl, hook_rate, hold_rate, video_views_3s, video_views_100pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const ad of (adsData.data || [])) {
    const ins = insightsMap[ad.id] || {};
    const hook_rate = ins.impressions > 0 ? ((ins.video_views_3s / ins.impressions) * 100) : 0;
    const hold_rate = ins.video_views_3s > 0 ? ((ins.video_views_100pct / ins.video_views_3s) * 100) : 0;
    const thumbnail = ad.creative?.thumbnail_url || '';
    stmt.run(
      ad.id, accountId, ad.name, ad.status, thumbnail,
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

    const prompt = `Sei un esperto di performance marketing per servizi di consulenza finanziaria indipendente in Italia (fee-only advisory).

Analizza questo annuncio Meta Ads per IoInvesto SCF:

Nome: ${ad.name}
Status: ${ad.status}
Thumbnail URL: ${ad.thumbnail_url || 'non disponibile'}

METRICHE:
- Spesa: €${ad.spend.toFixed(2)}
- Impressioni: ${ad.impressions.toLocaleString('it')}
- Click: ${ad.clicks}
- CTR: ${ad.ctr.toFixed(2)}%
- Lead generati: ${ad.leads}
- CPL (costo per lead): €${ad.cpl.toFixed(2)} (target: €${cplTarget})
- Hook Rate (3s): ${ad.hook_rate.toFixed(1)}%
- Hold Rate: ${ad.hold_rate.toFixed(1)}%
- Performance: ${isWinner ? 'WINNER ✓' : 'DA OTTIMIZZARE ✗'}

Rispondi SOLO con un JSON valido (nessun testo fuori dal JSON):
{
  "asset_type": "UGC | Video Avatar AI | Static Image | Carousel | Screen Recording",
  "visual_format": "Talking Head | Testimonial | Demo | Infografica | Lifestyle",
  "messaging_angle": "Paura pensione | Indipendenza dal banker | Confronto fee-only vs banca | Autorità/Expert | Rendimento | Protezione patrimonio | Risparmio fiscale",
  "hook_tactic": "Domanda provocatoria | Dato/Statistica shock | Storia personale | Problema comune | Promessa risultato | Contraddizione",
  "offer_type": "Webinar gratuito | Consulenza gratuita | Lead magnet | Demo | Nessuna offerta",
  "funnel_stage": "Top of Funnel | Middle of Funnel | Bottom of Funnel",
  "ai_summary": "Sommario in 2-3 frasi dell'ad e perché sta performando così",
  "strengths": ["punto forza 1", "punto forza 2"],
  "improvements": ["area miglioramento 1", "area miglioramento 2"],
  "iterations": [
    {
      "title": "Iterazione 1",
      "description": "Descrizione concreta di cosa cambiare",
      "expected_impact": "Alto | Medio | Basso"
    },
    {
      "title": "Iterazione 2", 
      "description": "Seconda variante da testare",
      "expected_impact": "Alto | Medio | Basso"
    }
  ]
}`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content[0].text;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Risposta AI non valida');
    const analysis = JSON.parse(jsonMatch[0]);

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
app.listen(PORT, () => console.log(`IoInvesto Creative Analytics → http://localhost:${PORT}`));
