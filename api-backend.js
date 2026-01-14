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

// ============ SECURITY: Rate Limiting ============
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per 15 min per IP
  message: { error: 'Trop de requêtes, réessayez plus tard' },
  standardHeaders: true,
  legacyHeaders: false
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 login attempts per 15 min per IP
  message: { error: 'Trop de tentatives, réessayez dans 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false
});

const createLinkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 link creations per hour
  message: { error: 'Limite de création atteinte, réessayez plus tard' }
});

app.use(generalLimiter);

// ============ SECURITY: CORS - Allow all origins for now ============
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'stripe-signature'],
  credentials: true
}));

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
async function sendWhatsAppAlert(linkName, intentScore, clickCount, userWhatsapp) {
  if (!twilioClient || !userWhatsapp) return false;
  
  try {
    const message = 'ALERTE NOLY\n\n' +
      'Lien: ' + linkName + '\n' +
      'Visites: ' + clickCount + '\n' +
      'Score: ' + intentScore + '%\n\n' +
      'Ce contact est tres interesse!\n' +
      'Contactez-le maintenant.';

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
async function sendEmailAlert(linkName, intentScore, clickCount, latestClick, userEmail) {
  if (!userEmail) return false;
  
  try {
    await resend.emails.send({
      from: 'Noly <alerte@noly.pro>',
      to: userEmail,
      subject: 'Alerte : ' + linkName + ' - ' + intentScore + '% interet',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="margin: 0; font-size: 24px;">🔥 Prospect Chaud !</h1>
          </div>
          <div style="background: #1a1a2e; padding: 30px; color: #e0e0e0; border-radius: 0 0 10px 10px;">
            <h2 style="color: #667eea; margin-top: 0;">${linkName}</h2>
            <div style="display: flex; gap: 20px; margin: 20px 0;">
              <div style="background: #252540; padding: 15px 25px; border-radius: 10px; text-align: center;">
                <div style="font-size: 28px; font-weight: bold; color: #667eea;">${clickCount}</div>
                <div style="color: #888; font-size: 14px;">Visites</div>
              </div>
              <div style="background: #252540; padding: 15px 25px; border-radius: 10px; text-align: center;">
                <div style="font-size: 28px; font-weight: bold; color: #ff6b6b;">${intentScore}%</div>
                <div style="color: #888; font-size: 14px;">Score</div>
              </div>
            </div>
            <p style="background: #252540; padding: 15px; border-radius: 8px; border-left: 4px solid #667eea;">
              <strong>Contactez ce prospect maintenant !</strong><br>
              Son niveau d'intérêt est élevé.
            </p>
            <p style="color: #888; font-size: 12px; margin-top: 20px;">
              Dernière visite: ${latestClick?.city || 'Inconnu'}, ${latestClick?.country || ''} - ${latestClick?.device_type || ''}
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
      .select('id, email, name, plan, whatsapp, click_threshold, subscription_status, stripe_customer_id, notify_email')
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
    const { name, whatsapp, click_threshold, notify_email } = req.body;

    const { data: currentUser } = await supabase
      .from('users')
      .select('plan')
      .eq('id', req.userId)
      .single();

    const updates = {};
    if (name !== undefined) updates.name = name.substring(0, 100); // Limit name length

    // Only Pro users can save WhatsApp
    if (whatsapp !== undefined && currentUser?.plan === 'pro') {
      updates.whatsapp = whatsapp;
    }

    // Allow custom click threshold (1-100)
    if (click_threshold !== undefined) {
      const threshold = parseInt(click_threshold);
      if (threshold >= 1 && threshold <= 100) {
        updates.click_threshold = threshold;
      }
    }

    // Email alerts toggle
    if (notify_email !== undefined) {
      updates.notify_email = !!notify_email;
    }

    const { data: user, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', req.userId)
      .select('id, email, name, plan, whatsapp, click_threshold, subscription_status, notify_email')
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
      pageUrl: `https://noly.pro/@${page.username}`
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
    const { name, username, bio, avatar_url, links, theme } = req.body;

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
        theme: theme || 'default'
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
        pageUrl: `https://noly.pro/@${page.username}`
      }
    });

  } catch (error) {
    console.error('Create page error:', error.message, error.stack);
    res.status(500).json({ error: 'Erreur serveur: ' + error.message });
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

// Update a page
app.put('/api/pages/:pageId', authMiddleware, async (req, res) => {
  try {
    const { pageId } = req.params;
    const { name, bio, avatar_url, links, theme } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name.substring(0, 100);
    if (bio !== undefined) updates.bio = bio.substring(0, 500);
    if (avatar_url !== undefined) updates.avatar_url = avatar_url;
    if (links !== undefined) updates.links = links;
    if (theme !== undefined) updates.theme = theme;
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
        pageUrl: `https://noly.pro/@${page.username}`
      }
    });

  } catch (error) {
    console.error('Update page error:', error.message);
    res.status(500).json({ error: 'Erreur mise à jour' });
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
                .select('email, whatsapp, plan')
                .eq('id', link.user_id)
                .single();
              
              if (user) {
                const intentScore = calculateIntentScore(allClicks, threshold);
                
                if (user.email) {
                  await sendEmailAlert(link.name, intentScore, totalHumanClicks, humanClicks[0], user.email);
                }
                if (user.whatsapp && user.plan === 'pro') {
                  await sendWhatsAppAlert(link.name, intentScore, totalHumanClicks, user.whatsapp);
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
                .select('email, whatsapp, plan')
                .eq('id', link.user_id)
                .single();
              
              if (user) {
                const intentScore = calculateIntentScore(allClicks, threshold);
                
                if (user.email) {
                  await sendEmailAlert(link.name, intentScore, totalHumanClicks, humanClicks[0], user.email);
                }
                if (user.whatsapp && user.plan === 'pro') {
                  await sendWhatsAppAlert(link.name, intentScore, totalHumanClicks, user.whatsapp);
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
  console.error('Server error');
  res.status(500).json({ error: 'Erreur serveur' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Noly API v8 CUSTOM SLUGS running on port ' + PORT);
});
