# Reveal Pro Backend

API de tracking pour Reveal Pro

## Déploiement sur Railway

### Variables d'environnement requises :

```
SUPABASE_URL=https://ciacizzknxeegrttmlug.supabase.co
SUPABASE_KEY=sb_publishable_KBvFc6XApFL5VmNU22jU6A_iEzMz_g9
PORT=3000
```

### Endpoints disponibles :

- `POST /api/links/create` - Créer un nouveau lien trackable
- `GET /:shortCode` - Redirection + tracking
- `POST /api/track/duration` - Mise à jour durée de visite
- `GET /api/links/:linkId/analytics` - Analytics d'un lien
- `GET /api/users/:userId/links` - Tous les liens d'un user
- `GET /api/users/:userId/hot-leads` - Prospects chauds

## Test local

```bash
npm install
npm start
```

L'API sera disponible sur http://localhost:3000
