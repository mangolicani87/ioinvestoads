# IoInvesto · Creative Analytics
Dashboard AI per analizzare le campagne Meta Ads di IoInvesto — ottimizzata per **CPL** (costo per lead).

---

## ⚡ Setup su Replit (5 minuti)

### 1. Importa su Replit
1. Vai su [replit.com](https://replit.com)
2. Clicca **+ Create Repl**
3. Scegli **Import from GitHub** o carica la cartella
4. Seleziona template **Node.js**
5. Clicca **Run** — installerà automaticamente le dipendenze

### 2. Ottieni il Meta Access Token
1. Vai su [developers.facebook.com](https://developers.facebook.com)
2. Crea un'app di tipo **Business**
3. Nel menu laterale: **Tools → Graph API Explorer**
4. Seleziona la tua app dal dropdown
5. Clicca **Generate Access Token**
6. Spunta i permessi: `ads_read` + `ads_management`
7. Copia il token (inizia con `EAA...`)

> ⚠️ Il token scade ogni ~60 giorni. Usa il **System User Token** da Business Manager per un token permanente.

### 3. Ottieni l'API Key di Anthropic (per l'AI)
1. Vai su [console.anthropic.com](https://console.anthropic.com)
2. API Keys → Create Key
3. Copia la key (inizia con `sk-ant-...`)

### 4. Configura l'app
1. Apri l'app nel browser
2. Vai su **Impostazioni**
3. Inserisci Meta Token + API Key
4. Imposta il tuo **CPL Target** (es. €30-50 per IoInvesto)
5. Salva

### 5. Aggiungi il tuo account
1. Clicca **+ Aggiungi account**
2. Seleziona il tuo account Meta Ads
3. L'app sincronizzerà automaticamente gli ultimi 90 giorni di dati

---

## 🚀 Funzionalità

| Feature | Descrizione |
|---------|-------------|
| **Sync Meta** | Importa tutti gli ad con spend, lead, CPL, CTR, hook/hold rate |
| **AI Analysis** | Claude analizza ogni creativo e assegna: angolo, hook tactic, funnel stage, asset type |
| **Win Rate** | % di ad con CPL ≤ target, breakdown per categoria |
| **Kill/Scale/Watch** | Raccomandazioni automatiche per ToF (hook rate), MoF (CTR), BoF (CPL) |
| **Iterazioni** | 2 varianti concrete da testare per ogni ad underperforming |
| **Report AI** | Analisi strategica periodica in italiano con priorità d'azione |

---

## 📊 Angoli di messaggio supportati
- Paura pensione
- Indipendenza dal banker
- Confronto fee-only vs banca
- Autorità/Expert
- Rendimento
- Protezione patrimonio
- Risparmio fiscale

---

## 🔧 Tech Stack
- **Backend**: Node.js + Express
- **DB**: SQLite (locale, zero config)
- **AI**: Claude Sonnet (Anthropic)
- **API**: Meta Graph API v19

---

Made for IoInvesto SCF 🇮🇹
