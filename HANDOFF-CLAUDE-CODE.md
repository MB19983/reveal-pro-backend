# Noly - Handoff Document for Claude Code

## 🎯 Projet
**Noly** - SaaS de link tracking qui alerte en temps réel quand quelqu'un clique sur un lien.

## 🏗️ Architecture

```
Frontend (Cloudflare Pages)
├── app.noly.pro → Dashboard (index.html)
└── noly.pro → Landing page

Backend (Render)
└── go.noly.pro → API Node.js + Express

Database (Supabase)
└── PostgreSQL

Emails (Resend)
└── noly.pro domain

Payments (Stripe)
└── 3 plans: Free, Starter, Pro
```

---

## 📁 Fichiers à donner

1. **index.html** - Dashboard app (pour app.noly.pro)
2. **api-backend.js** - Backend Node.js
3. **package.json** - Dépendances npm
4. **landing-noly-seo.html** - Landing page EN
5. **landing-noly-fr.html** - Landing page FR

---

## 🗄️ Schema SQL Supabase

### Table: users
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  plan VARCHAR(50) DEFAULT 'free',
  whatsapp VARCHAR(50),
  click_threshold INTEGER DEFAULT 5,
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  subscription_status VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_stripe_customer ON users(stripe_customer_id);
```

### Table: links
```sql
CREATE TABLE links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  original_url TEXT NOT NULL,
  short_code VARCHAR(60) UNIQUE NOT NULL,
  name VARCHAR(255),
  click_threshold INTEGER DEFAULT 5,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_links_user ON links(user_id);
CREATE INDEX idx_links_short_code ON links(short_code);
```

### Table: clicks
```sql
CREATE TABLE clicks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  link_id UUID REFERENCES links(id) ON DELETE CASCADE,
  ip_address VARCHAR(45),
  country VARCHAR(100),
  city VARCHAR(100),
  device_type VARCHAR(50),
  device_model VARCHAR(100),
  os VARCHAR(50),
  os_version VARCHAR(50),
  browser VARCHAR(50),
  browser_version VARCHAR(50),
  referrer TEXT,
  user_agent TEXT,
  is_bot BOOLEAN DEFAULT FALSE,
  bot_type VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_clicks_link ON clicks(link_id);
CREATE INDEX idx_clicks_created ON clicks(created_at);
```

### Table: pages (optionnel - Smart Pages)
```sql
CREATE TABLE pages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  username VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(255),
  bio TEXT,
  avatar_url TEXT,
  links JSONB DEFAULT '[]',
  theme VARCHAR(50) DEFAULT 'default',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_pages_user ON pages(user_id);
CREATE INDEX idx_pages_username ON pages(username);
```

### Table: qr_codes (optionnel)
```sql
CREATE TABLE qr_codes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  original_url TEXT NOT NULL,
  short_code VARCHAR(60) UNIQUE NOT NULL,
  name VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_qr_user ON qr_codes(user_id);
CREATE INDEX idx_qr_short_code ON qr_codes(short_code);
```

---

## 🔐 Variables d'environnement (Render)

```env
# Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_KEY=eyJxxx...

# Auth
JWT_SECRET=minimum_32_characters_random_string

# Stripe
STRIPE_SECRET_KEY=sk_live_xxx
STRIPE_PRICE_ID_PRO=price_xxx
STRIPE_PRICE_ID_STARTER=price_xxx (optionnel)
STRIPE_WEBHOOK_SECRET=whsec_xxx

# Email
RESEND_API_KEY=re_xxx

# WhatsApp (optionnel)
TWILIO_ACCOUNT_SID=xxx
TWILIO_AUTH_TOKEN=xxx
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
```

---

## 💰 Plans & Limites

| Plan | Prix | Liens | Features |
|------|------|-------|----------|
| Free | $0 | 5 | Email alerts, basic analytics |
| Starter | $9/mo | 25 | + Full analytics, multi-device |
| Pro | $22/mo | ∞ | + WhatsApp alerts, custom thresholds |

---

## 🔗 Endpoints API

### Auth
- `POST /api/auth/register` - Inscription
- `POST /api/auth/login` - Connexion
- `POST /api/auth/logout` - Déconnexion
- `GET /api/auth/me` - User actuel
- `POST /api/auth/forgot-password` - Demande reset
- `POST /api/auth/reset-password` - Reset avec token

### Links
- `GET /api/links` - Liste des liens
- `POST /api/links` - Créer un lien
- `GET /api/links/:id` - Détails d'un lien
- `DELETE /api/links/:id` - Supprimer

### Stats
- `GET /api/stats` - Statistiques globales

### Stripe
- `POST /api/stripe/checkout` - Créer session paiement
- `POST /api/stripe/portal` - Portal client
- `GET /api/stripe/status` - Status abonnement
- `POST /api/stripe/webhook` - Webhook Stripe

### Redirections
- `GET /:shortCode` - Redirection + tracking

---

## 🐛 Problèmes connus à corriger

1. **Login ne fonctionne pas** - Les event listeners ne s'attachent pas correctement
2. **CORS** - Actuellement ouvert à tous, à restreindre en prod
3. **Rate limiting** - Configuré mais peut bloquer les tests

---

## 🎨 URLs de production

- **App**: https://app.noly.pro
- **API**: https://go.noly.pro
- **Landing**: https://noly.pro
- **Landing FR**: https://noly.pro/fr

---

## 📝 Notes importantes

1. Le dashboard utilise du JavaScript vanilla (pas de framework)
2. Les URLs de liens sont `go.noly.pro/slug` (pas de `/l/` prefix)
3. Le slug est extrait automatiquement de l'URL originale ou du nom de domaine
4. Cloudflare injecte des scripts d'email protection - les désactiver dans les settings
5. Le fichier original était tronqué - vérifier que tout le JS est présent

---

## ✅ Ce qui fonctionne (vérifié)

- [x] Création de compte
- [x] Création de liens
- [x] Tracking des clics
- [x] Alertes email
- [x] Stripe checkout
- [x] Landing pages SEO

## ❌ À corriger

- [ ] Login/Register buttons ne répondent pas
- [ ] Mot de passe oublié (formulaire ajouté, à tester)
- [ ] Plan Starter sur Stripe (à créer)
