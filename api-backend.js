// ============================================================
// NOLY API v3.0.0 - Backend with Email + Password Auth
// ============================================================

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const useragent = require('useragent');
const geoip = require('geoip-lite');

const app = express();

// ============================================================
// CONFIGURATION
// ============================================================
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-min-32-chars-here';
const BASE_URL = process.env.BASE_URL || 'https://go.noly.pro';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

// Initialize Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Middleware
app.use(cors());
app.use(express.json());

// ============================================================
// HELPER FUNCTIONS
// ============================================================

// Generate short code
function generateShortCode(length = 6) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Parse user agent
function parseUserAgent(ua) {
  const agent = useragent.parse(ua);
  return {
    browser: agent.family,
    browser_version: agent.toVersion(),
    os: agent.os.family,
    os_version: agent.os.toVersion(),
    device_type: agent.device.family === 'Other' ? 'Desktop' : agent.device.family
  };
}

// Get geo location from IP
function getGeoFromIP(ip) {
  const geo = geoip.lookup(ip);
  if (geo) {
    return {
      country: geo.country,
      city: geo.city || 'Unknown'
    };
  }
  return { country: 'Unknown', city: 'Unknown' };
}

// Get client IP
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || 
         req.headers['x-real-ip'] || 
         req.connection?.remoteAddress || 
         'Unknown';
}

// Bot detection patterns
const BOT_PATTERNS = [
  'bot', 'crawler', 'spider', 'scraper', 'curl', 'wget', 'python', 'java',
  'go-http', 'ruby', 'perl', 'php', 'node-fetch', 'axios', 'got', 'request',
  'googlebot', 'bingbot', 'slurp', 'duckduckbot', 'baiduspider', 'yandexbot',
  'facebookexternalhit', 'twitterbot', 'linkedinbot', 'whatsapp', 'telegram',
  'slackbot', 'discordbot', 'applebot', 'semrushbot', 'ahrefsbot', 'mj12bot',
  'dotbot', 'rogerbot', 'screaming frog', 'headlesschrome', 'phantomjs', 'selenium'
];

function isBot(userAgent) {
  if (!userAgent) return true;
  const ua = userAgent.toLowerCase();
  return BOT_PATTERNS.some(pattern => ua.includes(pattern));
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// PRO plan middleware
async function requirePro(req, res, next) {
  const { data: user } = await supabase
    .from('users')
    .select('plan')
    .eq('id', req.user.userId)
    .single();
  
  if (!user || user.plan !== 'pro') {
    return res.status(403).json({ error: 'PRO plan required' });
  }
  next();
}

// ============================================================
// AUTH ROUTES - EMAIL + PASSWORD
// ============================================================

// Register new user
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    
    // Check if user exists
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();
    
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    
    // Hash password
    const password_hash = await bcrypt.hash(password, 10);
    
    // Create user
    const { data: user, error } = await supabase
      .from('users')
      .insert({
        email: email.toLowerCase(),
        password_hash,
        name: name || email.split('@')[0],
        plan: 'free'
      })
      .select()
      .single();
    
    if (error) {
      console.error('Register error:', error);
      return res.status(500).json({ error: 'Failed to create account' });
    }
    
    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    
    res.json({
      message: 'Account created successfully',
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan
      }
    });
    
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login with email + password
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    // Find user
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();
    
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Check password
    if (!user.password_hash) {
      return res.status(401).json({ error: 'Please use magic link to login, then set a password' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    
    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan
      }
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get current user
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, name, plan, created_at')
      .eq('id', req.user.userId)
      .single();
    
    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// LINKS ROUTES
// ============================================================

// Create link
app.post('/api/links', authMiddleware, async (req, res) => {
  try {
    const { original_url, name, custom_slug, threshold } = req.body;
    
    if (!original_url) {
      return res.status(400).json({ error: 'URL required' });
    }
    
    let short_code = custom_slug || generateShortCode();
    
    // Check if custom slug is available
    if (custom_slug) {
      const { data: existing } = await supabase
        .from('links')
        .select('id')
        .eq('short_code', custom_slug)
        .single();
      
      if (existing) {
        return res.status(400).json({ error: 'This slug is already taken' });
      }
    }
    
    const { data: link, error } = await supabase
      .from('links')
      .insert({
        user_id: req.user.userId,
        original_url,
        short_code,
        name: name || 'Untitled Link',
        threshold: threshold || 3
      })
      .select()
      .single();
    
    if (error) {
      console.error('Create link error:', error);
      return res.status(500).json({ error: 'Failed to create link' });
    }
    
    res.json({
      ...link,
      tracking_url: `${BASE_URL}/l/${link.short_code}`
    });
    
  } catch (error) {
    console.error('Create link error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's links
app.get('/api/links', authMiddleware, async (req, res) => {
  try {
    const { data: links, error } = await supabase
      .from('links')
      .select('*')
      .eq('user_id', req.user.userId)
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Get links error:', error);
      return res.status(500).json({ error: 'Failed to get links' });
    }
    
    res.json(links || []);
  } catch (error) {
    console.error('Get links error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Track link click (public)
app.get('/l/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const userAgent = req.headers['user-agent'] || '';
    const ip = getClientIP(req);
    
    // Find link
    const { data: link, error } = await supabase
      .from('links')
      .select('*, users(email, name, notify_email)')
      .eq('short_code', code)
      .single();
    
    if (error || !link) {
      return res.status(404).send('Link not found');
    }
    
    // Skip bot tracking
    if (!isBot(userAgent)) {
      const uaInfo = parseUserAgent(userAgent);
      const geoInfo = getGeoFromIP(ip);
      
      // Record click
      await supabase.from('clicks').insert({
        link_id: link.id,
        ip_address: ip,
        user_agent: userAgent,
        device_type: uaInfo.device_type,
        browser: uaInfo.browser,
        browser_version: uaInfo.browser_version,
        os: uaInfo.os,
        os_version: uaInfo.os_version,
        country: geoInfo.country,
        city: geoInfo.city,
        referrer: req.headers.referer || null
      });
      
      // Increment click count
      await supabase
        .from('links')
        .update({ clicks: (link.clicks || 0) + 1 })
        .eq('id', link.id);
    }
    
    // Redirect to original URL
    res.redirect(link.original_url);
    
  } catch (error) {
    console.error('Track click error:', error);
    res.status(500).send('Error');
  }
});

// ============================================================
// STATS ROUTE
// ============================================================

app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    // Get links count and clicks
    const { data: links } = await supabase
      .from('links')
      .select('clicks')
      .eq('user_id', req.user.userId);
    
    const total_links = links?.length || 0;
    const total_clicks = links?.reduce((sum, l) => sum + (l.clicks || 0), 0) || 0;
    const hot_leads = links?.filter(l => (l.clicks || 0) >= 10).length || 0;
    
    // Get QR scans
    const { data: qrs } = await supabase
      .from('qr_codes')
      .select('scans')
      .eq('user_id', req.user.userId);
    
    const total_scans = qrs?.reduce((sum, q) => sum + (q.scans || 0), 0) || 0;
    
    res.json({
      total_links,
      total_clicks,
      hot_leads,
      total_scans
    });
    
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// PAGES ROUTES (PRO)
// ============================================================

// Create page
app.post('/api/pages', authMiddleware, requirePro, async (req, res) => {
  try {
    const { name, username, bio } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username required' });
    }
    
    // Clean username
    const cleanUsername = username.toLowerCase().replace(/[^a-z0-9_]/g, '');
    
    // Check availability
    const { data: existing } = await supabase
      .from('pages')
      .select('id')
      .eq('username', cleanUsername)
      .single();
    
    if (existing) {
      return res.status(400).json({ error: 'Username already taken' });
    }
    
    const { data: page, error } = await supabase
      .from('pages')
      .insert({
        user_id: req.user.userId,
        name: name || 'My Page',
        username: cleanUsername,
        bio: bio || ''
      })
      .select()
      .single();
    
    if (error) {
      console.error('Create page error:', error);
      return res.status(500).json({ error: 'Failed to create page' });
    }
    
    res.json(page);
    
  } catch (error) {
    console.error('Create page error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's pages
app.get('/api/pages', authMiddleware, async (req, res) => {
  try {
    const { data: pages, error } = await supabase
      .from('pages')
      .select('*, page_links(*)')
      .eq('user_id', req.user.userId)
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Get pages error:', error);
      return res.status(500).json({ error: 'Failed to get pages' });
    }
    
    res.json(pages || []);
  } catch (error) {
    console.error('Get pages error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Public page view
app.get('/@:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    const { data: page, error } = await supabase
      .from('pages')
      .select('*, page_links(*)')
      .eq('username', username.toLowerCase())
      .eq('is_active', true)
      .single();
    
    if (error || !page) {
      return res.status(404).send('Page not found');
    }
    
    // Track view (skip bots)
    const userAgent = req.headers['user-agent'] || '';
    if (!isBot(userAgent)) {
      const ip = getClientIP(req);
      const uaInfo = parseUserAgent(userAgent);
      const geoInfo = getGeoFromIP(ip);
      
      await supabase.from('page_views').insert({
        page_id: page.id,
        ip_address: ip,
        user_agent: userAgent,
        device_type: uaInfo.device_type,
        browser: uaInfo.browser,
        os: uaInfo.os,
        country: geoInfo.country,
        city: geoInfo.city,
        referrer: req.headers.referer || null
      });
      
      // Increment view count
      await supabase.rpc('increment_page_views', { p_id: page.id });
    }
    
    // Return simple HTML page
    const linksHTML = (page.page_links || [])
      .sort((a, b) => a.position - b.position)
      .map(link => `<a href="${BASE_URL}/p/${link.id}" style="display:block;padding:16px;margin:8px 0;background:#1c1c1e;border-radius:12px;color:#fff;text-decoration:none;text-align:center;">${link.title}</a>`)
      .join('');
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${page.name} - Noly</title>
        <style>body{font-family:-apple-system,sans-serif;background:#000;color:#fff;margin:0;padding:40px 20px;text-align:center;}</style>
      </head>
      <body>
        <div style="max-width:400px;margin:0 auto;">
          <div style="width:80px;height:80px;background:linear-gradient(135deg,#bf5af2,#9945c7);border-radius:50%;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:700;">${(page.name || 'P')[0].toUpperCase()}</div>
          <h1 style="font-size:24px;margin-bottom:8px;">${page.name}</h1>
          <p style="color:#888;margin-bottom:24px;">${page.bio || ''}</p>
          ${linksHTML}
          <p style="margin-top:40px;font-size:12px;color:#666;">Powered by <a href="https://noly.pro" style="color:#bf5af2;">Noly</a></p>
        </div>
      </body>
      </html>
    `);
    
  } catch (error) {
    console.error('Page view error:', error);
    res.status(500).send('Error');
  }
});

// ============================================================
// QR CODES ROUTES (PRO)
// ============================================================

// Create QR
app.post('/api/qr', authMiddleware, requirePro, async (req, res) => {
  try {
    const { destination_url, name } = req.body;
    
    if (!destination_url) {
      return res.status(400).json({ error: 'URL required' });
    }
    
    const short_code = generateShortCode();
    
    const { data: qr, error } = await supabase
      .from('qr_codes')
      .insert({
        user_id: req.user.userId,
        destination_url,
        name: name || 'QR Code',
        short_code
      })
      .select()
      .single();
    
    if (error) {
      console.error('Create QR error:', error);
      return res.status(500).json({ error: 'Failed to create QR code' });
    }
    
    res.json({
      ...qr,
      qr_url: `${BASE_URL}/qr/${qr.short_code}`
    });
    
  } catch (error) {
    console.error('Create QR error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's QR codes
app.get('/api/qr', authMiddleware, async (req, res) => {
  try {
    const { data: qrs, error } = await supabase
      .from('qr_codes')
      .select('*')
      .eq('user_id', req.user.userId)
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Get QRs error:', error);
      return res.status(500).json({ error: 'Failed to get QR codes' });
    }
    
    res.json(qrs || []);
  } catch (error) {
    console.error('Get QRs error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Track QR scan (public)
app.get('/qr/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const userAgent = req.headers['user-agent'] || '';
    const ip = getClientIP(req);
    
    // Find QR
    const { data: qr, error } = await supabase
      .from('qr_codes')
      .select('*')
      .eq('short_code', code)
      .single();
    
    if (error || !qr) {
      return res.status(404).send('QR code not found');
    }
    
    // Track scan (skip bots)
    if (!isBot(userAgent)) {
      const uaInfo = parseUserAgent(userAgent);
      const geoInfo = getGeoFromIP(ip);
      
      await supabase.from('qr_scans').insert({
        qr_id: qr.id,
        ip_address: ip,
        user_agent: userAgent,
        device_type: uaInfo.device_type,
        browser: uaInfo.browser,
        browser_version: uaInfo.browser_version,
        os: uaInfo.os,
        os_version: uaInfo.os_version,
        country: geoInfo.country,
        city: geoInfo.city,
        is_bot: false
      });
      
      // Increment scan count
      await supabase.rpc('increment_qr_scans', { qr_code_id: qr.id });
    }
    
    // Redirect
    res.redirect(qr.destination_url);
    
  } catch (error) {
    console.error('QR scan error:', error);
    res.status(500).send('Error');
  }
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '3.0.0',
    auth: 'email+password',
    timestamp: new Date().toISOString() 
  });
});

// Root route
app.get('/', (req, res) => {
  res.json({ 
    name: 'Noly API',
    version: '3.0.0',
    docs: 'https://noly.pro/docs'
  });
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`Noly API v3.0.0 running on port ${PORT}`);
  console.log(`Auth: Email + Password`);
});
