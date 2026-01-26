// Noly Pro - Backend API SECURED
// Version 7.0 - Production Ready with Security Fixes

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const useragent = require('useragent');
const geoip = require('geoip-lite');
const { Resend } = require('resend');
const twilio = require('twilio');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const multer = require('multer');
const path = require('path');

const app = express();

// ============ SECURITY: Validate required env vars ============
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be set and at least 32 characters');
  process.exit(1);
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_KEY must be set');
  process.exit(1);
}

// ============ SECURITY: Helmet for security headers ============
app.use(helmet({
  contentSecurityPolicy: false, // Disable for API
  crossOriginEmbedderPolicy: false
}));

// ============ SECURITY: CORS - MUST be before rate limiting ============
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'stripe-signature'],
  credentials: true
}));

// Handle preflight requests
app.options('*', cors());

// ============ SECURITY: Rate Limiting ============
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // 500 requests per 15 min per IP (increased)
  message: { error: 'Trop de requêtes, réessayez plus tard' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS'
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 login attempts per 15 min per IP
  message: { error: 'Trop de tentatives, réessayez dans 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS'
});

const createLinkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50, // 50 link creations per hour
  message: { error: 'Limite de création atteinte, réessayez plus tard' },
  skip: (req) => req.method === 'OPTIONS'
});

app.use(generalLimiter);

// ============ Stripe Configuration - PRODUCTION ============
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const STRIPE_PUBLISHABLE_KEY = 'pk_live_51SmsVs3TJRCZE3zmCZIYO3N48MRGrvSCXLqwLrQc7RhUn7tEXBGrDFq1vtTbBVMETP3v1E1cFVuc7xmgzvcvurnE00pUY9iHpG';
const STRIPE_PRICE_ID_PRO = process.env.STRIPE_PRICE_ID_PRO || process.env.STRIPE_PRICE_ID;
const STRIPE_PRICE_ID_STARTER = process.env.STRIPE_PRICE_ID_STARTER;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Map price IDs to plans
const PRICE_TO_PLAN = {
  [STRIPE_PRICE_ID_PRO]: 'pro',
  [STRIPE_PRICE_ID_STARTER]: 'starter'
};

// Stripe webhook needs raw body
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    if (STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body);
    }
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  console.log('Stripe webhook:', event.type);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata.user_id;
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        const priceId = session.metadata.price_id;
        
        // Determine plan from price ID
        const plan = PRICE_TO_PLAN[priceId] || 'pro';

        console.log('Checkout completed for user:', userId, 'plan:', plan);

        await supabase
          .from('users')
          .update({
            plan: plan,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            subscription_status: 'active'
          })
          .eq('id', userId);

        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const status = subscription.status;
        const priceId = subscription.items?.data?.[0]?.price?.id;
        
        // Determine plan from price ID
        const plan = PRICE_TO_PLAN[priceId] || 'pro';

        console.log('Subscription updated:', status, 'plan:', plan);

        const { data: user } = await supabase
          .from('users')
          .select('id')
          .eq('stripe_customer_id', customerId)
          .single();

        if (user) {
          await supabase
            .from('users')
            .update({
              subscription_status: status,
              plan: status === 'active' ? plan : 'free'
            })
            .eq('id', user.id);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        console.log('Subscription cancelled');

        const { data: user } = await supabase
          .from('users')
          .select('id')
          .eq('stripe_customer_id', customerId)
          .single();

        if (user) {
          await supabase
            .from('users')
            .update({
              plan: 'free',
              subscription_status: 'cancelled',
              stripe_subscription_id: null
            })
            .eq('id', user.id);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;

        console.log('Payment failed for customer');

        const { data: user } = await supabase
          .from('users')
          .select('id')
          .eq('stripe_customer_id', customerId)
          .single();

        if (user) {
          await supabase
            .from('users')
            .update({ subscription_status: 'past_due' })
            .eq('id', user.id);
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Now use JSON parser for other routes
app.use(express.json({ limit: '1mb' }));

const resend = new Resend(process.env.RESEND_API_KEY);
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN 
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ============ Multer Configuration for File Uploads ============
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Type de fichier non autorisé. Utilisez JPG, PNG, GIF ou WebP.'), false);
    }
  }
});

// Plan limits
const PLAN_LIMITS = {
  free: 5,
  starter: 25,
  pro: 999999
};

// ============ SECURITY: Session limits per email ============
const MAX_SESSIONS_PER_USER = 3;
const activeSessions = new Map(); // In production, use Redis

function addSession(userId, token) {
  if (!activeSessions.has(userId)) {
    activeSessions.set(userId, []);
  }
  const sessions = activeSessions.get(userId);
  sessions.push({ token, createdAt: Date.now() });
  
  // Keep only last MAX_SESSIONS_PER_USER sessions
  if (sessions.length > MAX_SESSIONS_PER_USER) {
    sessions.shift(); // Remove oldest session
  }
}

function isSessionValid(userId, token) {
  const sessions = activeSessions.get(userId);
  if (!sessions) return true; // No sessions tracked yet, allow
  return sessions.some(s => s.token === token);
}

function removeSession(userId, token) {
  const sessions = activeSessions.get(userId);
  if (sessions) {
    const index = sessions.findIndex(s => s.token === token);
    if (index > -1) sessions.splice(index, 1);
  }
}

// ============ UTILITIES ============

function generateShortCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// ============ Extract slug from URL ============
function extractSlugFromUrl(url) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const hostname = urlObj.hostname;
    
    // Get all parts of the path
    const parts = pathname.split('/').filter(p => p.length > 0);
    
    // Find the best descriptive part (not just IDs or short codes)
    let bestSlug = null;
    let bestScore = 0;
    
    for (const part of parts) {
      // Decode and clean the part
      let cleaned = decodeURIComponent(part)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Remove accents
        .replace(/\.(html|php|pdf|htm|aspx)$/i, '') // Remove extensions
        .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric with dash
        .replace(/^-+|-+$/g, ''); // Remove leading/trailing dashes
      
      // Skip if too short
      if (cleaned.length < 4) continue;
      
      // Skip if mostly numbers (like IDs: r1921754, 12345, etc.)
      const letterCount = (cleaned.match(/[a-z]/g) || []).length;
      const numberCount = (cleaned.match(/[0-9]/g) || []).length;
      
      if (numberCount > letterCount) continue;
      
      // Score based on length and descriptiveness
      let score = cleaned.length;
      
      // Bonus for having multiple words (dashes)
      const dashCount = (cleaned.match(/-/g) || []).length;
      score += dashCount * 5;
      
      // Bonus for descriptive keywords
      if (cleaned.includes('appartement') || cleaned.includes('maison') || 
          cleaned.includes('vente') || cleaned.includes('location') ||
          cleaned.includes('annonce') || cleaned.includes('offre')) {
        score += 10;
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestSlug = cleaned;
      }
    }
    
    // If no good slug found from path, use the domain name
    if (!bestSlug) {
      // Extract domain name without TLD
      // e.g., "updatebase.io" -> "updatebase"
      // e.g., "www.clickmediax.com" -> "clickmediax"
      let domainSlug = hostname
        .toLowerCase()
        .replace(/^www\./, '') // Remove www.
        .split('.')[0]; // Get first part (before TLD)
      
      // Clean it
      domainSlug = domainSlug
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      
      if (domainSlug.length >= 3) {
        bestSlug = domainSlug;
      }
    }
    
    // Limit length
    if (bestSlug) {
      bestSlug = bestSlug.substring(0, 60);
    }
    
    return bestSlug;
  } catch (e) {
    return null;
  }
}

// ============ Generate unique slug ============
async function generateUniqueSlug(baseSlug) {
  // Check if baseSlug exists
  const { data: existing } = await supabase
    .from('links')
    .select('id')
    .eq('short_code', baseSlug)
    .single();
  
  if (!existing) {
    return baseSlug;
  }
  
  // Add random suffix if exists
  for (let i = 0; i < 10; i++) {
    const suffix = Math.random().toString(36).substring(2, 5);
    const newSlug = `${baseSlug}-${suffix}`;
    
    const { data: check } = await supabase
      .from('links')
      .select('id')
      .eq('short_code', newSlug)
      .single();
    
    if (!check) {
      return newSlug;
    }
  }
  
  // Fallback to random code
  return generateShortCode();
}

// ============ SECURITY: URL Validation ============
function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// ============ SECURITY: Sanitize log output ============
function sanitizeEmail(email) {
  if (!email) return 'unknown';
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return local.substring(0, 2) + '***@' + domain;
}

function extractDeviceInfo(userAgentString) {
  const agent = useragent.parse(userAgentString);
  const ua = userAgentString.toLowerCase();
  
  let deviceType = 'desktop';
  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) {
    deviceType = 'mobile';
  } else if (ua.includes('tablet') || ua.includes('ipad')) {
    deviceType = 'tablet';
  }
  
  return {
    deviceType,
    deviceModel: agent.device.family,
    os: agent.os.family,
    osVersion: agent.os.toVersion(),
    browser: agent.family,
    browserVersion: agent.toVersion()
  };
}

function getGeolocation(ip) {
  if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168') || ip.startsWith('10.')) {
    return { country: 'Local', city: 'Local', region: '' };
  }
  const geo = geoip.lookup(ip);
  if (!geo) return { country: 'Unknown', city: 'Unknown', region: '' };
  return { 
    country: geo.country || 'Unknown', 
    city: geo.city || 'Unknown',
    region: geo.region || ''
  };
}

function detectBot(userAgentString) {
  const ua = userAgentString.toLowerCase();
  const botPatterns = [
    'bot', 'crawler', 'spider', 'scraper', 'curl', 'wget', 'python',
    'java', 'perl', 'ruby', 'php', 'go-http', 'node-fetch', 'axios',
    'postman', 'insomnia', 'httpie', 'lighthouse', 'pagespeed',
    'googlebot', 'bingbot', 'yandex', 'baidu', 'duckduck', 'slack',
    'twitter', 'facebook', 'linkedin', 'whatsapp', 'telegram',
    'preview', 'fetch', 'headless', 'phantom', 'selenium', 'puppeteer'
  ];
  
  for (const pattern of botPatterns) {
    if (ua.includes(pattern)) {
      return { isBot: true, botType: pattern };
    }
  }
  return { isBot: false, botType: null };
}

function formatDateFR(date) {
  return new Date(date).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function calculateIntentScore(clicks, threshold) {
  threshold = threshold || 5;
  if (!clicks || clicks.length === 0) return 0;
  
  const humanClicks = clicks.filter(c => !c.is_bot);
  if (humanClicks.length === 0) return 0;
  
  const totalVisits = humanClicks.length;
  const uniqueDevices = new Set(humanClicks.map(c => c.device_type)).size;
  
  let score = 0;
  
  const visitRatio = totalVisits / threshold;
  if (visitRatio >= 1.2) score = 85;
  else if (visitRatio >= 1) score = 70;
  else if (visitRatio >= 0.8) score = 55;
  else if (visitRatio >= 0.6) score = 40;
  else if (visitRatio >= 0.4) score = 25;
  else if (visitRatio >= 0.2) score = 15;
  else score = 5;
  
  if (uniqueDevices > 1) score += 10;
  
  const uniqueIPs = new Set(humanClicks.map(c => c.ip_address)).size;
  if (totalVisits > uniqueIPs) score += 5;
  
  return Math.min(score, 100);
}

// Send WhatsApp alert
async function sendWhatsAppAlert(linkName, intentScore, clickCount, userWhatsapp, sourceType = 'link') {
  if (!twilioClient || !userWhatsapp) return false;

  try {
    // Source type icons
    const sourceIcons = {
      'link': '🔗 Link',
      'qr': '📱 QR Code',
      'smartpage': '📄 Smart Page'
    };
    const sourceLabel = sourceIcons[sourceType] || '🔗 Link';

    // Heat indicator based on score
    let heatIndicator = '';
    if (intentScore >= 85) heatIndicator = '🔥 HOT LEAD!';
    else if (intentScore >= 50) heatIndicator = '🟡 Warm lead';
    else heatIndicator = '🔵 Interested';

    const message = '🔔 NOLY ALERT\n\n' +
      '📊 ' + linkName + '\n' +
      'Source: ' + sourceLabel + '\n' +
      'Views: ' + clickCount + ' | Score: ' + intentScore + '%\n\n' +
      heatIndicator + '\n' +
      'Contact them now!';

    let whatsappNumber = userWhatsapp.trim();
    if (!whatsappNumber.startsWith('whatsapp:')) {
      whatsappNumber = 'whatsapp:' + whatsappNumber;
    }

    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: whatsappNumber
    });

    console.log('WhatsApp alert sent');
    return true;
  } catch (error) {
    console.error('WhatsApp error:', error.message);
    return false;
  }
}

// Send Email alert
async function sendEmailAlert(linkName, intentScore, clickCount, latestClick, userEmail, sourceType = 'link') {
  if (!userEmail) return false;

  try {
    // Source type labels
    const sourceLabels = {
      'link': '🔗 Link',
      'qr': '📱 QR Code',
      'smartpage': '📄 Smart Page'
    };
    const sourceLabel = sourceLabels[sourceType] || '🔗 Link';

    // Heat indicator
    let heatColor = '#667eea';
    let heatText = 'Interested';
    if (intentScore >= 85) {
      heatColor = '#ff6b6b';
      heatText = '🔥 HOT LEAD';
    } else if (intentScore >= 50) {
      heatColor = '#f59e0b';
      heatText = '🟡 Warm Lead';
    }

    await resend.emails.send({
      from: 'Noly <alert@noly.pro>',
      to: userEmail,
      subject: 'Alert: ' + linkName + ' - ' + intentScore + '% interest',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="margin: 0; font-size: 24px;">${heatText}</h1>
          </div>
          <div style="background: #1a1a2e; padding: 30px; color: #e0e0e0; border-radius: 0 0 10px 10px;">
            <h2 style="color: #667eea; margin-top: 0;">${linkName}</h2>
            <p style="color: #a855f7; font-size: 14px; margin-bottom: 20px;">Source: ${sourceLabel}</p>
            <div style="display: flex; gap: 20px; margin: 20px 0;">
              <div style="background: #252540; padding: 15px 25px; border-radius: 10px; text-align: center;">
                <div style="font-size: 28px; font-weight: bold; color: #667eea;">${clickCount}</div>
                <div style="color: #888; font-size: 14px;">Views</div>
              </div>
              <div style="background: #252540; padding: 15px 25px; border-radius: 10px; text-align: center;">
                <div style="font-size: 28px; font-weight: bold; color: ${heatColor};">${intentScore}%</div>
                <div style="color: #888; font-size: 14px;">Score</div>
              </div>
            </div>
            <p style="background: #252540; padding: 15px; border-radius: 8px; border-left: 4px solid ${heatColor};">
              <strong>Contact this prospect now!</strong><br>
              Their interest level is high.
            </p>
            <p style="color: #888; font-size: 12px; margin-top: 20px;">
              Latest visit: ${latestClick?.city || 'Unknown'}, ${latestClick?.country || ''} - ${latestClick?.device_type || ''}
            </p>
          </div>
        </div>
      `
    });

    console.log('Email alert sent');
    return true;
  } catch (error) {
    console.error('Email error:', error.message);
    return false;
  }
}

// Auth middleware
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requis' });
  }
  
  const token = authHeader.substring(7);
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.token = token;
    
    // Check if session is still valid (not exceeded max sessions)
    // Note: In production, validate against stored sessions
    
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

// ============ AUTH ENDPOINTS ============

app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { email, password, name } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Format email invalide' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'Mot de passe trop court (min 6 caractères)' });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', normalizedEmail)
      .single();
    
    if (existing) {
      return res.status(400).json({ error: 'Cet email existe déjà' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 12); // Increased from 10 to 12
    
    const { data: user, error } = await supabase
      .from('users')
      .insert({
        email: normalizedEmail,
        password: hashedPassword,
        name: name || email.split('@')[0],
        plan: 'free',
        click_threshold: 5
      })
      .select()
      .single();
    
    if (error) {
      console.error('Register DB error');
      throw error;
    }
    
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    addSession(user.id, token);
    
    console.log('User registered:', sanitizeEmail(user.email));
    
    res.json({ 
      success: true, 
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan
      }
    });
    
  } catch (error) {
    console.error('Register error');
    res.status(500).json({ error: 'Erreur inscription' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', normalizedEmail)
      .single();
    
    if (error || !user) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }
    
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    addSession(user.id, token);
    
    console.log('User logged in:', sanitizeEmail(user.email));
    
    res.json({ 
      success: true, 
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan || 'free',
        whatsapp: user.whatsapp,
        click_threshold: user.click_threshold || 5,
        subscription_status: user.subscription_status
      }
    });
    
  } catch (error) {
    console.error('Login error');
    res.status(500).json({ error: 'Erreur connexion' });
  }
});

app.post('/api/auth/logout', authMiddleware, async (req, res) => {
  try {
    removeSession(req.userId, req.token);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erreur déconnexion' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, name, plan, whatsapp, whatsapp_number, notify_whatsapp, click_threshold, threshold_links, threshold_pages, threshold_qr, subscription_status, stripe_customer_id, notify_email')
      .eq('id', req.userId)
      .single();
    
    if (error || !user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }
    
    const { count } = await supabase
      .from('links')
      .select('id', { count: 'exact' })
      .eq('user_id', req.userId);
    
    const limit = PLAN_LIMITS[user.plan] || PLAN_LIMITS.free;
    
    res.json({ 
      success: true, 
      user: {
        ...user,
        linksCount: count || 0,
        linksLimit: limit,
        canCreateLink: (count || 0) < limit
      }
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Erreur' });
  }
});

app.put('/api/auth/settings', authMiddleware, async (req, res) => {
  try {
    const { name, whatsapp, whatsapp_number, notify_whatsapp, click_threshold, notify_email, threshold_links, threshold_pages, threshold_qr } = req.body;

    const { data: currentUser } = await supabase
      .from('users')
      .select('plan')
      .eq('id', req.userId)
      .single();

    const updates = {};
    if (name !== undefined) updates.name = name.substring(0, 100); // Limit name length

    // Only Pro users can save WhatsApp settings
    if (currentUser?.plan === 'pro') {
      // Legacy whatsapp field
      if (whatsapp !== undefined) {
        updates.whatsapp = whatsapp;
      }
      // New whatsapp_number field
      if (whatsapp_number !== undefined) {
        updates.whatsapp_number = whatsapp_number.substring(0, 20);
      }
      // WhatsApp alerts toggle
      if (notify_whatsapp !== undefined) {
        updates.notify_whatsapp = !!notify_whatsapp;
      }
    }

    // Allow custom click threshold (1-100) - legacy
    if (click_threshold !== undefined) {
      const threshold = parseInt(click_threshold);
      if (threshold >= 1 && threshold <= 100) {
        updates.click_threshold = threshold;
      }
    }

    // New threshold fields for different alert types
    if (threshold_links !== undefined) {
      const val = parseInt(threshold_links);
      if (val >= 1 && val <= 100) updates.threshold_links = val;
    }
    if (threshold_pages !== undefined) {
      const val = parseInt(threshold_pages);
      if (val >= 1 && val <= 100) updates.threshold_pages = val;
    }
    if (threshold_qr !== undefined) {
      const val = parseInt(threshold_qr);
      if (val >= 1 && val <= 100) updates.threshold_qr = val;
    }

    // Email alerts toggle
    if (notify_email !== undefined) {
      updates.notify_email = !!notify_email;
    }

    const { data: user, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', req.userId)
      .select('id, email, name, plan, whatsapp, whatsapp_number, notify_whatsapp, click_threshold, threshold_links, threshold_pages, threshold_qr, subscription_status, notify_email')
      .single();

    if (error) throw error;

    res.json({ success: true, user });

  } catch (error) {
    res.status(500).json({ error: 'Erreur mise à jour' });
  }
});

// Forgot password
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email requis' });
    }
    
    const { data: user } = await supabase
      .from('users')
      .select('id, email, name')
      .eq('email', email.toLowerCase().trim())
      .single();
    
    // Always return success to prevent email enumeration
    if (!user) {
      return res.json({ success: true });
    }
    
    const resetToken = jwt.sign(
      { userId: user.id, type: 'reset' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    
    const resetUrl = 'https://app.noly.pro?reset=' + resetToken;
    
    await resend.emails.send({
      from: 'Noly <noreply@noly.pro>',
      to: user.email,
      subject: 'Réinitialisation de votre mot de passe Noly',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="margin: 0; font-size: 24px;">Noly</h1>
          </div>
          <div style="background: #1a1a2e; padding: 30px; color: #e0e0e0; border-radius: 0 0 10px 10px;">
            <h2 style="color: #667eea; margin-top: 0;">Réinitialisation du mot de passe</h2>
            <p>Bonjour ${user.name || ''},</p>
            <p>Vous avez demandé à réinitialiser votre mot de passe. Cliquez sur le bouton ci-dessous :</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetUrl}" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 30px; border-radius: 10px; text-decoration: none; font-weight: 600; display: inline-block;">Réinitialiser mon mot de passe</a>
            </div>
            <p style="color: #888; font-size: 14px;">Ce lien expire dans 1 heure.</p>
            <p style="color: #888; font-size: 14px;">Si vous n'avez pas fait cette demande, ignorez cet email.</p>
          </div>
        </div>
      `
    });
    
    console.log('Reset email sent');
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Forgot password error');
    res.status(500).json({ error: 'Erreur envoi email' });
  }
});

// Reset password with token
app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, password } = req.body;
    
    if (!token || !password) {
      return res.status(400).json({ error: 'Token et mot de passe requis' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'Mot de passe trop court (min 6 caractères)' });
    }
    
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.type !== 'reset') {
        throw new Error('Invalid token type');
      }
    } catch (e) {
      return res.status(400).json({ error: 'Lien expiré ou invalide' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 12);
    
    const { error } = await supabase
      .from('users')
      .update({ password: hashedPassword })
      .eq('id', decoded.userId);
    
    if (error) throw error;
    
    // Clear all sessions for this user (force re-login)
    activeSessions.delete(decoded.userId);
    
    console.log('Password reset successful');
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Reset password error');
    res.status(500).json({ error: 'Erreur réinitialisation' });
  }
});

// ============ STRIPE ENDPOINTS ============

app.post('/api/stripe/checkout', authMiddleware, async (req, res) => {
  try {
    const { plan } = req.body; // 'starter' or 'pro'
    
    // Check Stripe configuration
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('STRIPE_SECRET_KEY not configured');
      return res.status(500).json({ error: 'Configuration Stripe manquante' });
    }
    
    // Determine which price ID to use
    let priceId;
    if (plan === 'starter') {
      priceId = STRIPE_PRICE_ID_STARTER;
      if (!priceId) {
        console.error('STRIPE_PRICE_ID_STARTER not configured');
        return res.status(500).json({ error: 'Prix Starter non configuré' });
      }
    } else {
      priceId = STRIPE_PRICE_ID_PRO;
      if (!priceId) {
        console.error('STRIPE_PRICE_ID_PRO not configured');
        return res.status(500).json({ error: 'Prix Pro non configuré' });
      }
    }
    
    const { data: user } = await supabase
      .from('users')
      .select('email, plan, stripe_customer_id')
      .eq('id', req.userId)
      .single();
    
    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }
    
    if (user.plan === 'pro') {
      return res.status(400).json({ error: 'Déjà abonné Pro' });
    }
    
    if (user.plan === 'starter' && plan === 'starter') {
      return res.status(400).json({ error: 'Déjà abonné Starter' });
    }
    
    console.log('Creating checkout for:', user.email, 'Plan:', plan, 'Price:', priceId);
    
    const sessionConfig = {
      payment_method_types: ['card'],
      line_items: [{
        price: priceId,
        quantity: 1
      }],
      mode: 'subscription',
      success_url: 'https://app.noly.pro?payment=success',
      cancel_url: 'https://app.noly.pro?payment=cancelled',
      metadata: {
        user_id: req.userId,
        price_id: priceId
      },
      billing_address_collection: 'auto'
    };
    
    if (user.stripe_customer_id) {
      sessionConfig.customer = user.stripe_customer_id;
    } else {
      sessionConfig.customer_email = user.email;
    }
    
    const session = await stripe.checkout.sessions.create(sessionConfig);
    
    console.log('Checkout session created:', session.id);
    
    res.json({ success: true, url: session.url });
    
  } catch (error) {
    console.error('Checkout error:', error.message);
    res.status(500).json({ error: 'Erreur paiement: ' + error.message });
  }
});

app.post('/api/stripe/portal', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('stripe_customer_id')
      .eq('id', req.userId)
      .single();
    
    if (!user || !user.stripe_customer_id) {
      return res.status(400).json({ error: 'Pas d\'abonnement actif' });
    }
    
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: 'https://app.noly.pro'
    });
    
    res.json({ success: true, url: session.url });
    
  } catch (error) {
    console.error('Portal error');
    res.status(500).json({ error: 'Erreur' });
  }
});

app.get('/api/stripe/status', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('plan, subscription_status, stripe_subscription_id')
      .eq('id', req.userId)
      .single();
    
    res.json({
      success: true,
      plan: user.plan || 'free',
      status: user.subscription_status,
      hasSubscription: !!user.stripe_subscription_id
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Erreur' });
  }
});

// ============ STATS ENDPOINT ============

app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    // Get all links for this user
    const { data: links, error: linksError } = await supabase
      .from('links')
      .select('id, click_threshold')
      .eq('user_id', req.userId);

    if (linksError) throw linksError;

    const linkIds = (links || []).map(l => l.id);
    const totalLinks = linkIds.length;

    if (linkIds.length === 0) {
      return res.json({
        success: true,
        total_links: 0,
        total_clicks: 0,
        hot_leads: 0,
        total_scans: 0
      });
    }

    // Get all clicks for user's links
    const { data: clicks, error: clicksError } = await supabase
      .from('clicks')
      .select('link_id, is_bot')
      .in('link_id', linkIds);

    if (clicksError) throw clicksError;

    // Calculate total human clicks
    const humanClicks = (clicks || []).filter(c => !c.is_bot);
    const totalClicks = humanClicks.length;

    // Calculate hot leads (links that reached their click threshold)
    const clicksByLink = {};
    humanClicks.forEach(click => {
      clicksByLink[click.link_id] = (clicksByLink[click.link_id] || 0) + 1;
    });

    let hotLeads = 0;
    links.forEach(link => {
      const linkClicks = clicksByLink[link.id] || 0;
      const threshold = link.click_threshold || 5;
      if (linkClicks >= threshold) {
        hotLeads++;
      }
    });

    // Get QR scans count (if QR codes table exists)
    let totalScans = 0;
    try {
      const { data: qrCodes } = await supabase
        .from('qr_codes')
        .select('id')
        .eq('user_id', req.userId);

      if (qrCodes && qrCodes.length > 0) {
        const qrIds = qrCodes.map(q => q.id);
        const { count } = await supabase
          .from('qr_scans')
          .select('id', { count: 'exact' })
          .in('qr_id', qrIds);
        totalScans = count || 0;
      }
    } catch (e) {
      // QR tables might not exist yet, ignore error
    }

    res.json({
      success: true,
      total_links: totalLinks,
      total_clicks: totalClicks,
      hot_leads: hotLeads,
      total_scans: totalScans
    });

  } catch (error) {
    console.error('Stats error:', error.message);
    res.status(500).json({ error: 'Erreur statistiques' });
  }
});

// ============ LINKS ENDPOINTS ============

app.post('/api/links', authMiddleware, createLinkLimiter, async (req, res) => {
  try {
    // Accept both camelCase and snake_case for compatibility
    const name = req.body.name;
    const originalUrl = req.body.originalUrl || req.body.original_url;
    const clickThreshold = req.body.clickThreshold || req.body.click_threshold;

    if (!originalUrl) {
      return res.status(400).json({ error: 'URL requis' });
    }

    // Validate URL format
    if (!isValidUrl(originalUrl)) {
      return res.status(400).json({ error: 'URL invalide (doit commencer par http:// ou https://)' });
    }
    
    // Sanitize name - use URL domain as default if no name
    const sanitizedName = (name || 'Untitled Link').substring(0, 200).trim();
    
    // Check plan limits
    const { data: user } = await supabase
      .from('users')
      .select('plan, click_threshold')
      .eq('id', req.userId)
      .single();
    
    const { count } = await supabase
      .from('links')
      .select('id', { count: 'exact' })
      .eq('user_id', req.userId);
    
    const limit = PLAN_LIMITS[user?.plan] || PLAN_LIMITS.free;
    
    if ((count || 0) >= limit) {
      return res.status(403).json({ 
        error: 'Limite atteinte',
        message: 'Passez à Pro pour créer plus de liens',
        upgrade: true
      });
    }
    
    // Generate slug from URL or fallback to random code
    let shortCode;
    const extractedSlug = extractSlugFromUrl(originalUrl);
    
    if (extractedSlug) {
      shortCode = await generateUniqueSlug(extractedSlug);
    } else {
      shortCode = generateShortCode();
    }
    
    // Use custom threshold from request, or user default, or 5
    let threshold = 5;
    if (clickThreshold !== undefined) {
      const parsed = parseInt(clickThreshold);
      if (parsed >= 1 && parsed <= 100) {
        threshold = parsed;
      }
    } else if (user?.click_threshold) {
      threshold = user.click_threshold;
    }
    
    const { data: link, error } = await supabase
      .from('links')
      .insert({
        user_id: req.userId,
        name: sanitizedName,
        original_url: originalUrl,
        short_code: shortCode,
        click_threshold: threshold,
        alerts_enabled: true
      })
      .select()
      .single();
    
    if (error) throw error;
    
    const baseUrl = process.env.BASE_URL || 'https://noly.pro';
    
    res.json({
      success: true,
      // Return both formats for compatibility
      id: link.id,
      name: link.name,
      original_url: link.original_url,
      originalUrl: link.original_url,
      short_code: link.short_code,
      shortCode: link.short_code,
      trackableUrl: baseUrl + '/' + shortCode,
      click_threshold: link.click_threshold,
      clickThreshold: link.click_threshold,
      created_at: link.created_at,
      createdAt: link.created_at,
      link: {
        id: link.id,
        name: link.name,
        originalUrl: link.original_url,
        original_url: link.original_url,
        shortCode: link.short_code,
        short_code: link.short_code,
        trackableUrl: baseUrl + '/' + shortCode,
        clickThreshold: link.click_threshold,
        click_threshold: link.click_threshold,
        createdAt: link.created_at,
        created_at: link.created_at
      }
    });
    
  } catch (error) {
    console.error('Create link error');
    res.status(500).json({ error: 'Erreur création lien' });
  }
});

app.get('/api/links', authMiddleware, async (req, res) => {
  try {
    const { data: links, error } = await supabase
      .from('links')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    const baseUrl = process.env.BASE_URL || 'https://noly.pro';
    
    const linksWithStats = await Promise.all((links || []).map(async (link) => {
      const { data: clicks } = await supabase
        .from('clicks')
        .select('*')
        .eq('link_id', link.id)
        .order('timestamp', { ascending: false });

      const humanClicks = (clicks || []).filter(c => !c.is_bot);
      const botClicks = (clicks || []).filter(c => c.is_bot);
      const lastClick = humanClicks.length > 0 ? humanClicks[0] : null;
      const intentScore = calculateIntentScore(clicks, link.click_threshold || 5);

      // Return both camelCase and snake_case for frontend compatibility
      return {
        id: link.id,
        name: link.name,
        // Both formats
        originalUrl: link.original_url,
        original_url: link.original_url,
        shortCode: link.short_code,
        short_code: link.short_code,
        trackableUrl: baseUrl + '/' + link.short_code,
        clickThreshold: link.click_threshold || 5,
        click_threshold: link.click_threshold || 5,
        alertsEnabled: link.alerts_enabled !== false,
        alerts_enabled: link.alerts_enabled !== false,
        createdAt: link.created_at,
        created_at: link.created_at,
        // Flat stats for easy access
        clicks: humanClicks.length,
        totalClicks: humanClicks.length,
        botClicks: botClicks.length,
        intentScore: intentScore,
        intent_score: intentScore,
        uniqueVisitors: new Set(humanClicks.map(c => c.ip_address)).size,
        lastClickAt: lastClick ? lastClick.timestamp : null,
        lastClickFormatted: lastClick ? formatDateFR(lastClick.timestamp) : null,
        // Nested stats object too
        stats: {
          totalClicks: humanClicks.length,
          botClicks: botClicks.length,
          intentScore: intentScore,
          uniqueVisitors: new Set(humanClicks.map(c => c.ip_address)).size,
          lastClickAt: lastClick ? lastClick.timestamp : null,
          lastClickFormatted: lastClick ? formatDateFR(lastClick.timestamp) : null
        }
      };
    }));
    
    res.json({ success: true, links: linksWithStats });
    
  } catch (error) {
    console.error('Get links error');
    res.status(500).json({ error: 'Erreur' });
  }
});

// Get single link with detailed analytics
app.get('/api/links/:linkId', authMiddleware, async (req, res) => {
  try {
    const { linkId } = req.params;
    
    const { data: link, error } = await supabase
      .from('links')
      .select('*')
      .eq('id', linkId)
      .eq('user_id', req.userId)
      .single();
    
    if (error || !link) {
      return res.status(404).json({ error: 'Lien non trouvé' });
    }
    
    const { data: clicks } = await supabase
      .from('clicks')
      .select('*')
      .eq('link_id', linkId)
      .order('timestamp', { ascending: false });
    
    const humanClicks = (clicks || []).filter(c => !c.is_bot);
    const botClicks = (clicks || []).filter(c => c.is_bot);
    const lastClick = humanClicks.length > 0 ? humanClicks[0] : null;
    
    // Preferred hours
    const hourCounts = {};
    humanClicks.forEach(click => {
      const hour = new Date(click.timestamp).getHours();
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    });
    const preferredHours = Object.entries(hourCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([hour, count]) => ({ hour: parseInt(hour), count }));
    
    // Preferred days
    const dayCounts = {};
    const dayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
    humanClicks.forEach(click => {
      const day = new Date(click.timestamp).getDay();
      dayCounts[day] = (dayCounts[day] || 0) + 1;
    });
    const preferredDays = Object.entries(dayCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([day, count]) => ({ day: dayNames[parseInt(day)], count }));
    
    // Avg return delay
    const ipVisits = {};
    humanClicks.forEach(click => {
      if (!ipVisits[click.ip_address]) ipVisits[click.ip_address] = [];
      ipVisits[click.ip_address].push(new Date(click.timestamp));
    });
    let totalDelay = 0;
    let delayCount = 0;
    Object.values(ipVisits).forEach(visits => {
      if (visits.length > 1) {
        visits.sort((a, b) => a - b);
        for (let i = 1; i < visits.length; i++) {
          totalDelay += (visits[i] - visits[i-1]) / 60000;
          delayCount++;
        }
      }
    });
    const avgReturnDelay = delayCount > 0 ? Math.round(totalDelay / delayCount) : null;
    
    // Multi-device users
    const ipDevices = {};
    humanClicks.forEach(click => {
      const ip = click.ip_address;
      if (!ipDevices[ip]) ipDevices[ip] = new Set();
      ipDevices[ip].add(click.device_type);
    });
    const multiDeviceUsers = Object.entries(ipDevices)
      .filter(([ip, devices]) => devices.size > 1)
      .map(([ip, devices]) => ({ ip, devices: Array.from(devices) }));
    
    // Visitors
    const visitorMap = {};
    humanClicks.forEach(click => {
      const ip = click.ip_address;
      if (!visitorMap[ip]) {
        visitorMap[ip] = {
          ip,
          city: click.city,
          country: click.country,
          device: click.device_type,
          browser: click.browser,
          visits: [],
          firstVisit: click.timestamp,
          lastVisit: click.timestamp
        };
      }
      visitorMap[ip].visits.push(click.timestamp);
      if (new Date(click.timestamp) < new Date(visitorMap[ip].firstVisit)) {
        visitorMap[ip].firstVisit = click.timestamp;
      }
      if (new Date(click.timestamp) > new Date(visitorMap[ip].lastVisit)) {
        visitorMap[ip].lastVisit = click.timestamp;
      }
    });
    
    const visitors = Object.values(visitorMap).map(v => ({
      ...v,
      visitCount: v.visits.length,
      lastVisitFormatted: formatDateFR(v.lastVisit),
      isMultiDevice: ipDevices[v.ip] && ipDevices[v.ip].size > 1
    })).sort((a, b) => b.visitCount - a.visitCount);
    
    // Device breakdown
    const deviceBreakdown = {};
    humanClicks.forEach(click => {
      deviceBreakdown[click.device_type] = (deviceBreakdown[click.device_type] || 0) + 1;
    });
    
    // Referrer breakdown
    const referrerCounts = {};
    humanClicks.forEach(click => {
      let source = 'Direct';
      if (click.referrer && click.referrer !== 'direct') {
        try {
          const url = new URL(click.referrer);
          source = url.hostname;
        } catch (e) {}
      }
      referrerCounts[source] = (referrerCounts[source] || 0) + 1;
    });
    const referrerBreakdown = Object.entries(referrerCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([source, count]) => ({ source, count }));
    
    const baseUrl = process.env.BASE_URL || 'https://noly.pro';
    
    res.json({
      success: true,
      link: {
        id: link.id,
        name: link.name,
        originalUrl: link.original_url,
        shortCode: link.short_code,
        trackableUrl: baseUrl + '/' + link.short_code,
        clickThreshold: link.click_threshold || 5,
        alertsEnabled: link.alerts_enabled !== false,
        createdAt: link.created_at
      },
      analytics: {
        totalClicks: humanClicks.length,
        botClicks: botClicks.length,
        uniqueVisitors: visitors.length,
        intentScore: calculateIntentScore(clicks, link.click_threshold || 5),
        lastClickAt: lastClick ? lastClick.timestamp : null,
        lastClickFormatted: lastClick ? formatDateFR(lastClick.timestamp) : 'Aucun clic',
        preferredHours,
        preferredDays,
        avgReturnDelayMinutes: avgReturnDelay,
        referrerBreakdown,
        deviceBreakdown,
        multiDeviceUsers,
        hasMultiDeviceActivity: multiDeviceUsers.length > 0,
        visitors
      }
    });
    
  } catch (error) {
    console.error('Get link error');
    res.status(500).json({ error: 'Erreur' });
  }
});

app.delete('/api/links/:linkId', authMiddleware, async (req, res) => {
  try {
    const { linkId } = req.params;
    
    // Verify ownership first
    const { data: link } = await supabase
      .from('links')
      .select('id')
      .eq('id', linkId)
      .eq('user_id', req.userId)
      .single();
    
    if (!link) {
      return res.status(404).json({ error: 'Lien non trouvé' });
    }
    
    await supabase.from('alerts_sent').delete().eq('link_id', linkId);
    await supabase.from('clicks').delete().eq('link_id', linkId);
    
    const { error } = await supabase
      .from('links')
      .delete()
      .eq('id', linkId)
      .eq('user_id', req.userId);
    
    if (error) throw error;
    
    res.json({ success: true });
    
  } catch (error) {
    res.status(500).json({ error: 'Erreur suppression' });
  }
});

app.put('/api/links/:linkId/alerts', authMiddleware, async (req, res) => {
  try {
    const { linkId } = req.params;
    const { enabled } = req.body;
    
    const { data: link, error } = await supabase
      .from('links')
      .update({ alerts_enabled: enabled })
      .eq('id', linkId)
      .eq('user_id', req.userId)
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ success: true, alertsEnabled: link.alerts_enabled });
    
  } catch (error) {
    console.error('Toggle alerts error');
    res.status(500).json({ error: 'Erreur' });
  }
});

// Update link threshold
app.put('/api/links/:linkId/threshold', authMiddleware, async (req, res) => {
  try {
    const { linkId } = req.params;
    const { clickThreshold } = req.body;

    const threshold = parseInt(clickThreshold);
    if (isNaN(threshold) || threshold < 1 || threshold > 100) {
      return res.status(400).json({ error: 'Seuil invalide (1-100)' });
    }

    const { data: link, error } = await supabase
      .from('links')
      .update({ click_threshold: threshold })
      .eq('id', linkId)
      .eq('user_id', req.userId)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, clickThreshold: link.click_threshold });

  } catch (error) {
    console.error('Update threshold error');
    res.status(500).json({ error: 'Erreur' });
  }
});

// ============ PAGES ENDPOINTS (Smart Pages / Bio Links) ============

// Get all pages for user
app.get('/api/pages', authMiddleware, async (req, res) => {
  try {
    const { data: pages, error } = await supabase
      .from('pages')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const pagesWithUrl = (pages || []).map(page => ({
      ...page,
      pageUrl: `https://noly.space/@${page.username}`
    }));

    res.json({ success: true, pages: pagesWithUrl });

  } catch (error) {
    console.error('Get pages error:', error.message);
    res.status(500).json({ error: 'Erreur récupération pages' });
  }
});

// Create a new page
app.post('/api/pages', authMiddleware, async (req, res) => {
  try {
    const { name, username, bio, avatar_url, links, theme, social_links } = req.body;

    console.log('Creating page:', { name, username, userId: req.userId });

    if (!username) {
      return res.status(400).json({ error: 'Username requis' });
    }

    // Validate username format (alphanumeric and underscores only)
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
      return res.status(400).json({ error: 'Username invalide (3-30 caractères, lettres, chiffres et _ uniquement)' });
    }

    // Check if username already exists
    const { data: existing, error: existingError } = await supabase
      .from('pages')
      .select('id')
      .eq('username', username.toLowerCase())
      .single();

    if (existing) {
      return res.status(400).json({ error: 'Ce username est déjà pris' });
    }

    // Check plan limits (free: 1 page, starter: 3, pro: unlimited)
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('plan')
      .eq('id', req.userId)
      .single();

    if (userError) {
      console.error('User fetch error:', userError.message);
      return res.status(500).json({ error: 'Erreur utilisateur: ' + userError.message });
    }

    const { count, error: countError } = await supabase
      .from('pages')
      .select('id', { count: 'exact' })
      .eq('user_id', req.userId);

    if (countError) {
      console.error('Pages count error:', countError.message);
      // Table might not exist - continue with 0 count
    }

    const pageLimits = { free: 1, starter: 3, pro: 999999 };
    const limit = pageLimits[user?.plan] || pageLimits.free;

    if ((count || 0) >= limit) {
      return res.status(403).json({
        error: 'Limite de pages atteinte (' + limit + ')',
        upgrade: true
      });
    }

    const { data: page, error } = await supabase
      .from('pages')
      .insert({
        user_id: req.userId,
        username: username.toLowerCase(),
        name: name || username,
        bio: bio || '',
        avatar_url: avatar_url || '',
        links: links || [],
        theme: theme || 'default',
        social_links: social_links || {}
      })
      .select()
      .single();

    if (error) {
      console.error('Page insert error:', error.message, error.details, error.hint);
      return res.status(500).json({ error: 'Erreur création: ' + error.message });
    }

    console.log('Page created:', page.id);

    res.json({
      success: true,
      page: {
        ...page,
        pageUrl: `https://noly.space/@${page.username}`
      }
    });

  } catch (error) {
    console.error('Create page error:', error.message, error.stack);
    res.status(500).json({ error: 'Erreur serveur: ' + error.message });
  }
});

// Upload avatar image (returns base64 data URL - no storage needed)
app.post('/api/upload/avatar', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier fourni' });
    }

    const file = req.file;

    // Compress image if too large (max 500KB for database storage)
    if (file.size > 500 * 1024) {
      return res.status(400).json({ error: 'Image trop volumineuse (max 500KB)' });
    }

    // Convert to base64 data URL
    const base64 = file.buffer.toString('base64');
    const dataUrl = `data:${file.mimetype};base64,${base64}`;

    console.log('Avatar converted to data URL, size:', Math.round(dataUrl.length / 1024) + 'KB');

    res.json({
      success: true,
      url: dataUrl
    });

  } catch (error) {
    console.error('Upload error:', error.message);
    res.status(500).json({ error: 'Erreur upload: ' + error.message });
  }
});

// Get single page (public - for viewing)
app.get('/api/pages/view/:username', async (req, res) => {
  try {
    const { username } = req.params;

    const { data: page, error } = await supabase
      .from('pages')
      .select('username, name, bio, avatar_url, links, theme')
      .eq('username', username.toLowerCase())
      .single();

    if (error || !page) {
      return res.status(404).json({ error: 'Page non trouvée' });
    }

    res.json({ success: true, page });

  } catch (error) {
    res.status(500).json({ error: 'Erreur' });
  }
});

// Public Smart Page HTML - displays the user's page like Linktree
app.get('/@:username', async (req, res) => {
  try {
    const { username } = req.params;
    console.log('Loading Smart Page for:', username);

    const { data: page, error } = await supabase
      .from('pages')
      .select('*')
      .eq('username', username.toLowerCase())
      .single();

    if (error) {
      console.log('Page query error:', error.message);
    }

    if (!page) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html><head><title>Page Not Found - Noly</title>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>body{font-family:system-ui;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
        .box{text-align:center;padding:40px;}.title{font-size:2rem;margin-bottom:8px;}.text{color:#888;}</style>
        </head><body><div class="box"><div class="title">Page not found</div><div class="text">@${escapeHtml(username)} doesn't exist.</div></div></body></html>
      `);
    }

    // Get visitor info for personalization
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const userAgent = req.headers['user-agent'] || '';
    const isMobile = /Mobile|Android|iPhone/i.test(userAgent);

    // Increment view count (non-blocking)
    supabase.from('pages')
      .update({ total_views: (page.total_views || 0) + 1 })
      .eq('id', page.id)
      .then(() => {})
      .catch(e => console.log('View count update error:', e.message));

    // Track page view with device info
    const deviceInfo = extractDeviceInfo(userAgent);
    const geoInfo = getGeolocation(ip);

    supabase.from('page_views').insert({
      page_id: page.id,
      ip_address: ip,
      user_agent: userAgent.substring(0, 500),
      referrer: req.get('Referer') || '',
      country: geoInfo.country,
      city: geoInfo.city,
      device_type: deviceInfo.deviceType,
      browser: deviceInfo.browser
    }).then(() => {}).catch(() => {});

    // Smart Page alert check (async)
    setImmediate(async () => {
      try {
        const totalViews = (page.total_views || 0) + 1;

        // Get user info for alerts (including threshold setting)
        const { data: user } = await supabase
          .from('users')
          .select('email, whatsapp_number, whatsapp_alerts_enabled, email_alerts_enabled, threshold_pages, plan')
          .eq('id', page.user_id)
          .single();

        if (!user) return;

        const threshold = user.threshold_pages || 5; // Use user's threshold or default to 5

        if (totalViews > 0 && totalViews % threshold === 0) {
          // Check if alert was already sent for this view count
          const { data: existingAlert } = await supabase
            .from('alerts_sent')
            .select('id')
            .eq('link_id', page.id)
            .eq('click_count', totalViews)
            .single();

          if (!existingAlert) {
            const pageName = page.name || '@' + page.username;
            const intentScore = Math.min(40 + totalViews * 3, 100);
            const latestView = { country: geoInfo.country, city: geoInfo.city, device_type: deviceInfo.deviceType };

            // Send email alert
            if (user.email && user.email_alerts_enabled !== false) {
              await sendEmailAlert(pageName, intentScore, totalViews, latestView, user.email, 'smartpage');
            }

            // Send WhatsApp alert (PRO only)
            if (user.whatsapp_number && user.whatsapp_alerts_enabled !== false && user.plan === 'pro') {
              await sendWhatsAppAlert(pageName, intentScore, totalViews, user.whatsapp_number, 'smartpage');
            }

            // Record alert sent
            await supabase.from('alerts_sent').insert({
              user_id: page.user_id,
              link_id: page.id,
              intent_score: intentScore,
              click_count: totalViews
            });
          }
        }
      } catch (e) {
        console.log('Smart Page alert error:', e.message);
      }
    });

    const links = Array.isArray(page.links) ? page.links : [];
    const baseUrl = process.env.BASE_URL || 'https://go.noly.pro';

    // Generate links HTML with tracking
    const linksHtml = links.map((link, index) => {
      const trackUrl = `${baseUrl}/p/${page.id}/l/${index}`;
      const isWhatsApp = link.type === 'whatsapp';

      // Check scheduling
      const now = new Date();
      if (link.startDate && new Date(link.startDate) > now) return '';
      if (link.endDate && new Date(link.endDate) < now) return '';

      if (isWhatsApp && link.phone) {
        const waMessage = encodeURIComponent(link.message || 'Hello!');
        const waUrl = `https://wa.me/${link.phone.replace(/[^0-9]/g, '')}?text=${waMessage}`;
        return '<a href="' + waUrl + '" target="_blank" rel="noopener" class="link-btn">' +
          (link.icon ? '<span class="link-icon">' + escapeHtml(link.icon) + '</span>' : '') +
          '<span class="link-text">' + escapeHtml(link.title || 'WhatsApp') + '</span></a>';
      }

      return '<a href="' + trackUrl + '" target="_blank" rel="noopener" class="link-btn">' +
        (link.icon ? '<span class="link-icon">' + escapeHtml(link.icon) + '</span>' : '') +
        '<span class="link-text">' + escapeHtml(link.title || link.url || 'Link') + '</span></a>';
    }).filter(Boolean).join('');

    // Theme backgrounds
    const themeBackgrounds = {
      nature: 'https://images.unsplash.com/photo-1518531933037-91b2f5f229cc?w=800&q=80',
      ocean: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=800&q=80',
      desert: 'https://images.unsplash.com/photo-1509316785289-025f5b846b35?w=800&q=80',
      city: 'https://images.unsplash.com/photo-1480714378408-67cf0d13bc1b?w=800&q=80',
      minimal: '',
      dark: ''
    };

    // Theme styles
    const themeStyles = {
      nature: { btnBg: 'rgba(255,255,255,0.85)', btnText: '#2d3436', textColor: '#fff', overlay: 'rgba(0,0,0,0.3)' },
      ocean: { btnBg: 'rgba(255,255,255,0.9)', btnText: '#2d3436', textColor: '#fff', overlay: 'rgba(0,0,0,0.25)' },
      desert: { btnBg: 'rgba(232,178,152,0.9)', btnText: '#2d3436', textColor: '#fff', overlay: 'rgba(0,0,0,0.25)' },
      city: { btnBg: 'rgba(255,255,255,0.85)', btnText: '#2d3436', textColor: '#fff', overlay: 'rgba(0,0,0,0.4)' },
      minimal: { btnBg: 'rgba(0,0,0,0.05)', btnText: '#1a1a2e', textColor: '#1a1a2e', overlay: '' },
      dark: { btnBg: 'rgba(255,255,255,0.1)', btnText: '#fff', textColor: '#fff', overlay: '' }
    };

    const currentTheme = page.theme || 'dark';
    const bgImage = page.background_url || themeBackgrounds[currentTheme] || '';
    const style = themeStyles[currentTheme] || themeStyles.dark;
    const hasImage = bgImage && bgImage.length > 0;

    // Social icons
    const socialIcons = {
      github: '<svg viewBox="0 0 24 24"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>',
      linkedin: '<svg viewBox="0 0 24 24"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>',
      instagram: '<svg viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>',
      twitter: '<svg viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
      tiktok: '<svg viewBox="0 0 24 24"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>',
      youtube: '<svg viewBox="0 0 24 24"><path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>',
      website: '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>'
    };

    const socials = page.social_links || {};
    const socialLinksHtml = Object.entries(socials)
      .filter(([_, url]) => url && url.trim())
      .map(([platform, url]) => {
        const icon = socialIcons[platform] || socialIcons.website;
        return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener" class="social-icon">' + icon + '</a>';
      }).join('');

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>${escapeHtml(page.name || page.username)} | Noly</title>
  <meta name="description" content="${escapeHtml(page.bio || 'Check out my links')}">
  <meta property="og:title" content="${escapeHtml(page.name || page.username)}">
  <meta property="og:description" content="${escapeHtml(page.bio || 'Check out my links')}">
  <link rel="icon" href="https://noly.pro/favicon.ico">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{height:100%;overflow-x:hidden}
    body{
      font-family:'Inter',system-ui,sans-serif;
      min-height:100vh;
      ${hasImage ? `
        background:url('${bgImage}') center/cover no-repeat fixed;
      ` : currentTheme === 'minimal' ? `
        background:#f5f5f5;
      ` : `
        background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);
      `}
    }
    ${hasImage ? `
    .overlay{
      position:fixed;top:0;left:0;right:0;bottom:0;
      background:${style.overlay};
      z-index:0;
    }
    ` : ''}
    .container{
      position:relative;z-index:1;
      max-width:420px;
      margin:0 auto;
      padding:60px 24px 40px;
      min-height:100vh;
      display:flex;
      flex-direction:column;
    }
    .profile{text-align:center;margin-bottom:32px}
    .avatar{
      width:96px;height:96px;
      border-radius:50%;
      margin:0 auto 16px;
      overflow:hidden;
      border:3px solid rgba(255,255,255,0.3);
      box-shadow:0 8px 32px rgba(0,0,0,0.2);
    }
    .avatar img{width:100%;height:100%;object-fit:cover}
    .avatar-letter{
      width:100%;height:100%;
      display:flex;align-items:center;justify-content:center;
      background:linear-gradient(135deg,#667eea,#764ba2);
      color:#fff;font-size:2.5rem;font-weight:700;
    }
    .name{
      font-size:1.5rem;font-weight:700;
      color:${style.textColor};
      margin-bottom:8px;
      text-shadow:${hasImage ? '0 2px 4px rgba(0,0,0,0.3)' : 'none'};
    }
    .bio{
      font-size:0.95rem;
      color:${style.textColor};
      opacity:0.85;
      line-height:1.5;
      max-width:300px;
      margin:0 auto;
      text-shadow:${hasImage ? '0 1px 2px rgba(0,0,0,0.3)' : 'none'};
    }
    .social-row{
      display:flex;justify-content:center;gap:12px;
      margin-top:20px;
    }
    .social-icon{
      width:40px;height:40px;
      display:flex;align-items:center;justify-content:center;
      background:${hasImage ? 'rgba(255,255,255,0.15)' : style.btnBg};
      backdrop-filter:blur(10px);
      -webkit-backdrop-filter:blur(10px);
      border-radius:50%;
      color:${style.textColor};
      transition:transform 0.2s,background 0.2s;
    }
    .social-icon:hover{transform:scale(1.1);background:${hasImage ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.1)'}}
    .social-icon svg{width:20px;height:20px;fill:currentColor}
    .links{display:flex;flex-direction:column;gap:12px;flex:1}
    .link-btn{
      display:flex;align-items:center;gap:12px;
      padding:16px 20px;
      background:${style.btnBg};
      backdrop-filter:blur(20px);
      -webkit-backdrop-filter:blur(20px);
      border-radius:12px;
      color:${style.btnText};
      text-decoration:none;
      font-weight:500;
      font-size:0.95rem;
      transition:transform 0.2s,box-shadow 0.2s;
      box-shadow:0 2px 8px rgba(0,0,0,0.1);
    }
    .link-btn:hover{transform:translateY(-2px);box-shadow:0 4px 16px rgba(0,0,0,0.15)}
    .link-btn:active{transform:translateY(0)}
    .link-icon{font-size:1.2rem;flex-shrink:0}
    .link-text{flex:1;text-align:center}
    .footer{
      margin-top:auto;padding-top:32px;text-align:center;
    }
    .footer a{
      font-size:0.8rem;
      color:${style.textColor};
      opacity:0.6;
      text-decoration:none;
    }
    .footer a:hover{opacity:1}
    .empty{
      text-align:center;padding:40px 20px;
      color:${style.textColor};opacity:0.7;
    }
    @media(max-width:480px){
      .container{padding:40px 16px 32px}
      .avatar{width:80px;height:80px}
      .name{font-size:1.3rem}
    }
  </style>
</head>
<body>
  ${hasImage ? '<div class="overlay"></div>' : ''}
  <div class="container">
    <div class="profile">
      <div class="avatar">
        ${page.avatar_url
          ? '<img src="' + escapeHtml(page.avatar_url) + '" alt="' + escapeHtml(page.name) + '">'
          : '<div class="avatar-letter">' + (page.name || 'U')[0].toUpperCase() + '</div>'}
      </div>
      <h1 class="name">${escapeHtml(page.name || page.username)}</h1>
      ${page.bio ? '<p class="bio">' + escapeHtml(page.bio) + '</p>' : ''}
      ${socialLinksHtml ? '<div class="social-row">' + socialLinksHtml + '</div>' : ''}
    </div>
    <div class="links">
      ${linksHtml || '<div class="empty">No links yet</div>'}
    </div>
    <div class="footer">
      <a href="https://noly.pro" target="_blank">Made with Noly</a>
    </div>
  </div>
</body>
</html>`;
    res.send(html);

  } catch (error) {
    console.error('Smart page error:', error.message, error.stack);
    res.status(500).send(`
      <!DOCTYPE html>
      <html><head><title>Error - Noly</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{font-family:system-ui;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
      .box{text-align:center;padding:40px;}.title{font-size:2rem;margin-bottom:8px;color:#f00;}.text{color:#888;}</style>
      </head><body><div class="box"><div class="title">Error</div><div class="text">Something went wrong. Please try again later.</div></div></body></html>
    `);
  }
});

// Track link clicks on Smart Page
app.get('/p/:pageId/l/:linkIndex', async (req, res) => {
  try {
    const { pageId, linkIndex } = req.params;
    const idx = parseInt(linkIndex, 10);

    const { data: page, error } = await supabase
      .from('pages')
      .select('links, user_id, name')
      .eq('id', pageId)
      .single();

    if (error || !page || !page.links || !page.links[idx]) {
      return res.status(404).send('Link not found');
    }

    const link = page.links[idx];
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const userAgent = req.headers['user-agent'] || '';
    const deviceInfo = extractDeviceInfo(userAgent);
    const geoInfo = getGeolocation(ip);

    // Track the link click with await
    const { error: insertError } = await supabase.from('link_clicks').insert({
      page_id: pageId,
      link_index: idx,
      link_title: link.title || '',
      link_url: link.url || '',
      ip_address: ip,
      user_agent: userAgent.substring(0, 500),
      country: geoInfo.country,
      city: geoInfo.city,
      device_type: deviceInfo.deviceType,
      browser: deviceInfo.browser,
      referrer: req.get('Referer') || ''
    });

    if (insertError) {
      console.error('Link click insert error:', insertError.message);
    }

    // Check for alert threshold and send alerts (async)
    setImmediate(async () => {
      try {
        // Get click count for this specific link
        const { count } = await supabase
          .from('link_clicks')
          .select('id', { count: 'exact' })
          .eq('page_id', pageId)
          .eq('link_index', idx);

        // Get user settings
        const { data: user } = await supabase
          .from('users')
          .select('email, whatsapp_number, email_alerts_enabled, whatsapp_alerts_enabled, threshold_pages, plan')
          .eq('id', page.user_id)
          .single();

        if (!user) return;

        const threshold = user.threshold_pages || 5;
        const linkName = link.title || 'Link ' + (idx + 1);
        const pageName = page.name || 'Smart Page';
        const alertName = pageName + ' - ' + linkName;

        // Send alert if threshold reached
        if (count && count > 0 && count % threshold === 0) {
          const intentScore = Math.min(50 + count * 2, 100);
          const latestClick = { country: geoInfo.country, city: geoInfo.city, device_type: deviceInfo.deviceType };

          // Send email alert
          if (user.email && user.email_alerts_enabled !== false) {
            await sendEmailAlert(alertName, intentScore, count, latestClick, user.email, 'smartpage');
          }

          // Send WhatsApp alert
          if (user.whatsapp_number && user.whatsapp_alerts_enabled !== false && user.plan === 'pro') {
            await sendWhatsAppAlert(alertName, intentScore, count, user.whatsapp_number, 'smartpage');
          }
        }
      } catch (e) {
        console.log('Link alert error:', e.message);
      }
    });

    res.redirect(302, link.url);

  } catch (error) {
    console.error('Link track error:', error.message);
    res.status(500).send('Error');
  }
});

// Helper function to escape HTML
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Update a page
app.put('/api/pages/:pageId', authMiddleware, async (req, res) => {
  try {
    const { pageId } = req.params;
    const { name, bio, avatar_url, links, theme, social_links, background_url } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name.substring(0, 100);
    if (bio !== undefined) updates.bio = bio.substring(0, 500);
    if (avatar_url !== undefined) updates.avatar_url = avatar_url;
    if (links !== undefined) updates.links = links;
    if (theme !== undefined) updates.theme = theme;
    if (social_links !== undefined) updates.social_links = social_links;
    if (background_url !== undefined) updates.background_url = background_url;
    updates.updated_at = new Date().toISOString();

    const { data: page, error } = await supabase
      .from('pages')
      .update(updates)
      .eq('id', pageId)
      .eq('user_id', req.userId)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      page: {
        ...page,
        pageUrl: `https://noly.space/@${page.username}`
      }
    });

  } catch (error) {
    console.error('Update page error:', error.message);
    res.status(500).json({ error: 'Erreur mise à jour' });
  }
});

// Get page analytics
app.get('/api/pages/:pageId/analytics', authMiddleware, async (req, res) => {
  try {
    const { pageId } = req.params;

    // Verify page belongs to user
    const { data: page, error: pageError } = await supabase
      .from('pages')
      .select('id, total_views')
      .eq('id', pageId)
      .eq('user_id', req.userId)
      .single();

    if (pageError || !page) {
      return res.status(404).json({ error: 'Page not found' });
    }

    // Get page views (ignore errors if table doesn't exist)
    let views = [];
    try {
      const { data: viewsData } = await supabase
        .from('page_views')
        .select('*')
        .eq('page_id', pageId)
        .order('viewed_at', { ascending: false })
        .limit(50);
      views = viewsData || [];
    } catch (e) {
      console.log('page_views query failed:', e.message);
    }

    // Calculate analytics
    const totalViews = page.total_views || 0;
    const uniqueIps = [...new Set(views.map(v => v.ip_address).filter(Boolean))];
    const uniqueVisitors = uniqueIps.length;

    const mobileViews = views.filter(v => v.device_type === 'mobile' || v.device_type === 'tablet').length;
    const desktopViews = views.filter(v => v.device_type === 'desktop').length;

    // Get link clicks (ignore errors if table doesn't exist)
    let totalLinkClicks = 0;
    let linkClicksDetail = [];
    try {
      const { data: linkClicks } = await supabase
        .from('link_clicks')
        .select('link_index, link_title, link_url')
        .eq('page_id', pageId);

      if (linkClicks && linkClicks.length > 0) {
        totalLinkClicks = linkClicks.length;

        // Group by link_index
        const clicksByLink = {};
        linkClicks.forEach(click => {
          const key = click.link_index;
          if (!clicksByLink[key]) {
            clicksByLink[key] = {
              index: click.link_index,
              title: click.link_title || 'Link ' + (click.link_index + 1),
              url: click.link_url || '',
              clicks: 0
            };
          }
          clicksByLink[key].clicks++;
        });

        // Convert to array and sort by clicks
        linkClicksDetail = Object.values(clicksByLink).sort((a, b) => b.clicks - a.clicks);
      }
    } catch (e) {
      console.log('link_clicks query failed:', e.message);
    }

    // Calculate intent score (based on return visitors and link clicks)
    let intentScore = 0;
    if (totalViews > 0) {
      const clickRate = totalLinkClicks / totalViews;
      const returnRate = uniqueVisitors > 0 ? (totalViews - uniqueVisitors) / totalViews : 0;
      intentScore = Math.min(100, Math.round((clickRate * 50 + returnRate * 50) * 100));
    }

    res.json({
      success: true,
      analytics: {
        totalViews,
        uniqueVisitors,
        intentScore,
        linkClicks: totalLinkClicks,
        linkClicksDetail,
        mobileViews,
        desktopViews,
        recentViews: views.slice(0, 10).map(v => ({
          viewed_at: v.viewed_at || v.created_at,
          is_mobile: v.device_type === 'mobile' || v.device_type === 'tablet',
          city: v.city || 'Unknown',
          country: v.country || 'Unknown'
        }))
      }
    });

  } catch (error) {
    console.error('Page analytics error:', error.message);
    res.status(500).json({ error: 'Failed to get analytics' });
  }
});

// Delete a page
app.delete('/api/pages/:pageId', authMiddleware, async (req, res) => {
  try {
    const { pageId } = req.params;

    const { error } = await supabase
      .from('pages')
      .delete()
      .eq('id', pageId)
      .eq('user_id', req.userId);

    if (error) throw error;

    res.json({ success: true });

  } catch (error) {
    res.status(500).json({ error: 'Erreur suppression' });
  }
});

// ============ QR CODES ENDPOINTS ============

// Get all QR codes for user
app.get('/api/qr', authMiddleware, async (req, res) => {
  try {
    const { data: qrCodes, error } = await supabase
      .from('qr_codes')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Get QR codes DB error:', error.message);
      return res.status(500).json({ error: 'Erreur base de données: ' + error.message });
    }

    const baseUrl = process.env.BASE_URL || 'https://noly.pro';

    // Get scan counts for each QR code (with error handling for missing table)
    const qrWithStats = await Promise.all((qrCodes || []).map(async (qr) => {
      let scans = 0;
      try {
        const { count, error: scanError } = await supabase
          .from('qr_scans')
          .select('id', { count: 'exact' })
          .eq('qr_id', qr.id);
        if (!scanError) scans = count || 0;
      } catch (e) {
        // qr_scans table might not exist yet
      }

      return {
        ...qr,
        scanUrl: `${baseUrl}/qr/${qr.short_code}`,
        scans: scans
      };
    }));

    res.json({ success: true, qrCodes: qrWithStats });

  } catch (error) {
    console.error('Get QR codes error:', error.message);
    res.status(500).json({ error: 'Erreur: ' + error.message });
  }
});

// Create a new QR code
app.post('/api/qr', authMiddleware, async (req, res) => {
  try {
    const { name, url } = req.body;

    console.log('Creating QR code:', { name, url, userId: req.userId });

    if (!url) {
      return res.status(400).json({ error: 'URL requis' });
    }

    if (!isValidUrl(url)) {
      return res.status(400).json({ error: 'URL invalide (doit commencer par http:// ou https://)' });
    }

    // Check plan limits (free: 2 QR, starter: 10, pro: unlimited)
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('plan')
      .eq('id', req.userId)
      .single();

    if (userError) {
      console.error('User fetch error:', userError.message);
      return res.status(500).json({ error: 'Erreur utilisateur: ' + userError.message });
    }

    const { count, error: countError } = await supabase
      .from('qr_codes')
      .select('id', { count: 'exact' })
      .eq('user_id', req.userId);

    if (countError) {
      console.error('QR count error:', countError.message);
      // Table might not exist - continue with 0 count
    }

    const qrLimits = { free: 2, starter: 10, pro: 999999 };
    const limit = qrLimits[user?.plan] || qrLimits.free;

    if ((count || 0) >= limit) {
      return res.status(403).json({
        error: 'Limite de QR codes atteinte (' + limit + ')',
        upgrade: true
      });
    }

    // Generate unique short code for QR
    const shortCode = 'qr-' + generateShortCode();

    const { data: qrCode, error } = await supabase
      .from('qr_codes')
      .insert({
        user_id: req.userId,
        original_url: url,
        short_code: shortCode,
        name: name || 'QR Code'
      })
      .select()
      .single();

    if (error) {
      console.error('QR insert error:', error.message, error.details, error.hint);
      return res.status(500).json({ error: 'Erreur création: ' + error.message });
    }

    const baseUrl = process.env.BASE_URL || 'https://noly.pro';

    console.log('QR code created:', qrCode.id);

    res.json({
      success: true,
      qrCode: {
        ...qrCode,
        scanUrl: `${baseUrl}/qr/${qrCode.short_code}`,
        scans: 0
      }
    });

  } catch (error) {
    console.error('Create QR code error:', error.message, error.stack);
    res.status(500).json({ error: 'Erreur serveur: ' + error.message });
  }
});

// Update a QR code
app.put('/api/qr/:qrId', authMiddleware, async (req, res) => {
  try {
    const { qrId } = req.params;
    const { name, original_url, scan_threshold } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name.substring(0, 100);
    if (original_url !== undefined) updates.original_url = original_url;
    if (scan_threshold !== undefined) {
      const threshold = parseInt(scan_threshold);
      if (threshold >= 1 && threshold <= 100) {
        updates.scan_threshold = threshold;
      }
    }

    const { data, error } = await supabase
      .from('qr_codes')
      .update(updates)
      .eq('id', qrId)
      .eq('user_id', req.userId)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, qr: data });

  } catch (error) {
    console.error('Update QR error:', error.message);
    res.status(500).json({ error: 'Erreur mise à jour' });
  }
});

// Delete a QR code
app.delete('/api/qr/:qrId', authMiddleware, async (req, res) => {
  try {
    const { qrId } = req.params;

    // Delete associated scans first
    await supabase.from('qr_scans').delete().eq('qr_id', qrId);

    const { error } = await supabase
      .from('qr_codes')
      .delete()
      .eq('id', qrId)
      .eq('user_id', req.userId);

    if (error) throw error;

    res.json({ success: true });

  } catch (error) {
    res.status(500).json({ error: 'Erreur suppression' });
  }
});

// ============ TRACKING ENDPOINT ============

// QR Code scan tracking: noly.pro/qr/:shortCode
app.get('/qr/:shortCode', async (req, res) => {
  try {
    const { shortCode } = req.params;

    const { data: qrCode, error } = await supabase
      .from('qr_codes')
      .select('*')
      .eq('short_code', shortCode)
      .single();

    if (error || !qrCode) {
      return res.status(404).send('QR Code non trouvé');
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const userAgent = req.headers['user-agent'] || '';
    const referrer = req.headers['referer'] || 'direct';

    const deviceInfo = extractDeviceInfo(userAgent);
    const geoInfo = getGeolocation(ip);
    const botInfo = detectBot(userAgent);

    // Record scan
    await supabase.from('qr_scans').insert({
      qr_id: qrCode.id,
      ip_address: ip,
      country: geoInfo.country,
      city: geoInfo.city,
      device_type: deviceInfo.deviceType,
      device_model: deviceInfo.deviceModel,
      os: deviceInfo.os,
      browser: deviceInfo.browser,
      referrer,
      user_agent: userAgent.substring(0, 500),
      is_bot: botInfo.isBot
    });

    // Check for alerts (async, don't wait)
    if (!botInfo.isBot) {
      setImmediate(async () => {
        try {
          // Get user info
          const { data: user } = await supabase
            .from('users')
            .select('id, email, plan, whatsapp, whatsapp_number, notify_whatsapp, notify_email, threshold_qr')
            .eq('id', qrCode.user_id)
            .single();

          if (user) {
            const threshold = user.threshold_qr || 2;

            // Count total scans for this QR code
            const { count: totalScans } = await supabase
              .from('qr_scans')
              .select('*', { count: 'exact', head: true })
              .eq('qr_id', qrCode.id)
              .eq('is_bot', false);

            // Check if we should send alert
            if (totalScans >= threshold && totalScans % threshold === 0) {
              // Check if alert was already sent for this count
              const { data: existingAlert } = await supabase
                .from('alerts_sent')
                .select('id')
                .eq('qr_id', qrCode.id)
                .eq('click_count', totalScans)
                .single();

              if (!existingAlert) {
                // Send alerts
                if (user.notify_email !== false && user.email) {
                  await sendEmailAlert(qrCode.name || 'QR Code', 80, totalScans, { country: geoInfo.country, city: geoInfo.city, device_type: deviceInfo.deviceType }, user.email, 'qr');
                }

                const whatsappNum = user.whatsapp_number || user.whatsapp;
                if (user.notify_whatsapp && whatsappNum && user.plan === 'pro') {
                  await sendWhatsAppAlert(qrCode.name || 'QR Code', 80, totalScans, whatsappNum, 'qr');
                }

                // Record that we sent this alert
                await supabase.from('alerts_sent').insert({
                  user_id: user.id,
                  qr_id: qrCode.id,
                  intent_score: 80,
                  click_count: totalScans
                });
              }
            }
          }
        } catch (e) {
          console.error('QR alert error:', e.message);
        }
      });
    }

    res.redirect(302, qrCode.original_url);

  } catch (error) {
    console.error('QR scan error:', error.message);
    res.status(500).send('Erreur');
  }
});

// New short format: noly.pro/slug
app.get('/:shortCode', async (req, res) => {
  try {
    const { shortCode } = req.params;
    
    // Skip API routes and static files
    if (shortCode === 'api' || shortCode === 'health' || shortCode.includes('.')) {
      return res.status(404).send('Not found');
    }
    
    // Allow alphanumeric and dashes, 3-60 chars
    if (!/^[a-z0-9-]{3,60}$/.test(shortCode)) {
      return res.status(404).send('Page non trouvée');
    }
    
    const { data: link, error } = await supabase
      .from('links')
      .select('*')
      .eq('short_code', shortCode)
      .single();
    
    if (error || !link) {
      return res.status(404).send('Page non trouvée');
    }
    
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const userAgent = req.headers['user-agent'] || '';
    const referrer = req.headers['referer'] || 'direct';
    
    const deviceInfo = extractDeviceInfo(userAgent);
    const geoInfo = getGeolocation(ip);
    const botInfo = detectBot(userAgent);
    
    // Record click
    await supabase.from('clicks').insert({
      link_id: link.id,
      ip_address: ip,
      country: geoInfo.country,
      city: geoInfo.city,
      device_type: deviceInfo.deviceType,
      device_model: deviceInfo.deviceModel,
      os: deviceInfo.os,
      os_version: deviceInfo.osVersion,
      browser: deviceInfo.browser,
      browser_version: deviceInfo.browserVersion,
      referrer,
      user_agent: userAgent.substring(0, 500),
      is_bot: botInfo.isBot,
      bot_type: botInfo.botType
    });
    
    // Auto-alert check (async)
    if (!botInfo.isBot) {
      setImmediate(async () => {
        try {
          const { data: allClicks } = await supabase
            .from('clicks')
            .select('*')
            .eq('link_id', link.id);
          
          const threshold = link.click_threshold || 5;
          const humanClicks = (allClicks || []).filter(c => !c.is_bot);
          const totalHumanClicks = humanClicks.length;
          
          console.log('Click on link - Total:', totalHumanClicks, '- Threshold:', threshold);
          
          // Check if we've hit a threshold multiple (1, 2, 3... x threshold)
          if (totalHumanClicks > 0 && totalHumanClicks % threshold === 0 && link.alerts_enabled !== false) {
            
            // Check if we already sent an alert for this exact click count
            const { data: existingAlert } = await supabase
              .from('alerts_sent')
              .select('id')
              .eq('link_id', link.id)
              .eq('click_count', totalHumanClicks)
              .single();
            
            if (!existingAlert) {
              console.log('ALERT TRIGGERED at', totalHumanClicks, 'clicks');
              
              const { data: user } = await supabase
                .from('users')
                .select('email, whatsapp_number, notify_whatsapp, plan')
                .eq('id', link.user_id)
                .single();

              if (user) {
                const intentScore = calculateIntentScore(allClicks, threshold);

                if (user.email) {
                  await sendEmailAlert(link.name, intentScore, totalHumanClicks, humanClicks[0], user.email, 'link');
                }
                if (user.whatsapp_number && user.notify_whatsapp && user.plan === 'pro') {
                  await sendWhatsAppAlert(link.name, intentScore, totalHumanClicks, user.whatsapp_number, 'link');
                }

                await supabase.from('alerts_sent').insert({
                  user_id: link.user_id,
                  link_id: link.id,
                  intent_score: intentScore,
                  click_count: totalHumanClicks
                });
              }
            }
          }
        } catch (e) {
          console.error('Alert error');
        }
      });
    }

    res.redirect(302, link.original_url);
    
  } catch (error) {
    console.error('Track error');
    res.status(500).send('Erreur');
  }
});

// Legacy format: /d/shortcode (keep for backward compatibility)
app.get('/d/:shortCode', async (req, res) => {
  try {
    const { shortCode } = req.params;
    
    // Validate shortCode format
    if (!/^[a-z0-9]{6}$/.test(shortCode)) {
      return res.status(404).send('Page non trouvée');
    }
    
    const { data: link, error } = await supabase
      .from('links')
      .select('*')
      .eq('short_code', shortCode)
      .single();
    
    if (error || !link) {
      return res.status(404).send('Page non trouvée');
    }
    
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const userAgent = req.headers['user-agent'] || '';
    const referrer = req.headers['referer'] || 'direct';
    
    const deviceInfo = extractDeviceInfo(userAgent);
    const geoInfo = getGeolocation(ip);
    const botInfo = detectBot(userAgent);
    
    // Record click
    await supabase.from('clicks').insert({
      link_id: link.id,
      ip_address: ip,
      country: geoInfo.country,
      city: geoInfo.city,
      device_type: deviceInfo.deviceType,
      device_model: deviceInfo.deviceModel,
      os: deviceInfo.os,
      os_version: deviceInfo.osVersion,
      browser: deviceInfo.browser,
      browser_version: deviceInfo.browserVersion,
      referrer,
      user_agent: userAgent.substring(0, 500), // Limit UA length
      is_bot: botInfo.isBot,
      bot_type: botInfo.botType
    });
    
    // Auto-alert check (async)
    if (!botInfo.isBot) {
      setImmediate(async () => {
        try {
          const { data: allClicks } = await supabase
            .from('clicks')
            .select('*')
            .eq('link_id', link.id);
          
          const threshold = link.click_threshold || 5;
          const humanClicks = (allClicks || []).filter(c => !c.is_bot);
          const totalHumanClicks = humanClicks.length;
          
          console.log('Click on link - Total:', totalHumanClicks, '- Threshold:', threshold);
          
          // Check if we've hit a threshold multiple (1, 2, 3... x threshold)
          if (totalHumanClicks > 0 && totalHumanClicks % threshold === 0 && link.alerts_enabled !== false) {
            
            // Check if we already sent an alert for this exact click count
            const { data: existingAlert } = await supabase
              .from('alerts_sent')
              .select('id')
              .eq('link_id', link.id)
              .eq('click_count', totalHumanClicks)
              .single();
            
            if (!existingAlert) {
              console.log('ALERT TRIGGERED at', totalHumanClicks, 'clicks');
              
              const { data: user } = await supabase
                .from('users')
                .select('email, whatsapp_number, notify_whatsapp, plan')
                .eq('id', link.user_id)
                .single();

              if (user) {
                const intentScore = calculateIntentScore(allClicks, threshold);

                if (user.email) {
                  await sendEmailAlert(link.name, intentScore, totalHumanClicks, humanClicks[0], user.email, 'link');
                }
                if (user.whatsapp_number && user.notify_whatsapp && user.plan === 'pro') {
                  await sendWhatsAppAlert(link.name, intentScore, totalHumanClicks, user.whatsapp_number, 'link');
                }

                await supabase.from('alerts_sent').insert({
                  user_id: link.user_id,
                  link_id: link.id,
                  intent_score: intentScore,
                  click_count: totalHumanClicks
                });
              }
            }
          }
        } catch (e) {
          console.error('Alert error');
        }
      });
    }

    res.redirect(302, link.original_url);
    
  } catch (error) {
    console.error('Track error');
    res.status(500).send('Erreur');
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '8.0-custom-slugs' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint non trouvé' });
});

// Error handler
app.use((err, req, res, next) => {
  // Handle Multer errors
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Fichier trop volumineux (max 5MB)' });
    }
    return res.status(400).json({ error: 'Erreur upload: ' + err.message });
  }

  // Handle custom file filter errors
  if (err.message && err.message.includes('Type de fichier')) {
    return res.status(400).json({ error: err.message });
  }

  console.error('Server error:', err.message);
  res.status(500).json({ error: 'Erreur serveur' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Noly API v8 CUSTOM SLUGS running on port ' + PORT);
});
// Deploy trigger Mon Jan 26 18:25:31 UTC 2026
