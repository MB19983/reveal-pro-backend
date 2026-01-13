# Noly API v2.0.0

Link Tracking API with Smart Pages and QR Codes

## 🚀 Quick Deploy

### Step 1: Update Supabase Database

1. Go to **Supabase** > **SQL Editor**
2. Copy-paste the content of `01-supabase-migration.sql`
3. Click **Run**
4. You should see "Success. No rows returned"

### Step 2: Update Code on Render

1. Replace your current `api-backend.js` with `api-backend-v2.js`
2. Rename `api-backend-v2.js` to `api-backend.js`
3. Update `package.json` with the new version
4. Push to GitHub
5. Render will auto-deploy

### Step 3: Environment Variables

Make sure these are set on Render:

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | ✅ | Your Supabase project URL |
| `SUPABASE_KEY` | ✅ | Your Supabase anon key |
| `JWT_SECRET` | ✅ | Min 32 characters for auth |
| `BASE_URL` | ✅ | Your domain (e.g., https://noly.pro) |
| `RESEND_API_KEY` | Optional | For email alerts |
| `TWILIO_ACCOUNT_SID` | Optional | For WhatsApp alerts |
| `TWILIO_AUTH_TOKEN` | Optional | For WhatsApp alerts |
| `TWILIO_WHATSAPP_FROM` | Optional | Your Twilio WhatsApp number |

## 📡 API Endpoints

### Authentication
- `POST /api/auth/request` - Request magic link
- `GET /api/auth/verify` - Verify magic link token
- `GET /api/auth/me` - Get current user

### Links
- `POST /api/links` - Create tracked link
- `GET /api/links` - Get user's links
- `GET /api/links/:id/stats` - Get link statistics
- `GET /l/:code` - Track link click (public)

### Smart Pages (PRO)
- `POST /api/pages` - Create Smart Page
- `GET /api/pages` - Get user's pages
- `GET /api/pages/:id` - Get single page
- `PUT /api/pages/:id` - Update page
- `DELETE /api/pages/:id` - Delete page
- `POST /api/pages/:pageId/links` - Add link to page
- `PUT /api/pages/:pageId/links/:linkId` - Update page link
- `DELETE /api/pages/:pageId/links/:linkId` - Delete page link
- `GET /api/pages/:id/stats` - Get page statistics
- `GET /@:username` - View Smart Page (public)
- `GET /p/:linkId` - Track page link click (public)

### QR Codes (PRO)
- `POST /api/qr` - Create QR code
- `GET /api/qr` - Get user's QR codes
- `GET /api/qr/:id` - Get single QR code
- `PUT /api/qr/:id` - Update QR code
- `DELETE /api/qr/:id` - Delete QR code
- `GET /api/qr/:id/stats` - Get QR code statistics
- `GET /qr/:code` - Track QR code scan (public)

### Dashboard
- `GET /api/stats` - Get dashboard statistics

### Health
- `GET /health` - API health check

## 🔐 Authentication

All protected endpoints require the `Authorization` header:

```
Authorization: Bearer <your_jwt_token>
```

## 📊 New Features in v2.0.0

### Smart Link Pages
- Create custom pages like `noly.pro/@username`
- Add multiple tracked links
- Track views and clicks per link
- Get notified when someone clicks

### QR Code Tracking
- Generate tracked QR codes
- Real-time scan notifications
- Device and location analytics
- Custom alert thresholds

### Improved Alerts
- All alerts now in English
- Beautiful email templates
- WhatsApp notifications
- Configurable thresholds

## 📁 Files

| File | Description |
|------|-------------|
| `api-backend-v2.js` | Main API server |
| `package.json` | Dependencies |
| `01-supabase-migration.sql` | Database schema |

## 🆘 Troubleshooting

### "JWT_SECRET must be set"
Add `JWT_SECRET` environment variable with at least 32 characters.

### "This feature requires PRO plan"
The user's plan must be set to 'pro' in the users table.

### Alerts not sending
Check that `RESEND_API_KEY` is set for email alerts.

---

Made with 💜 by Noly
