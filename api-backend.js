// Noly Pro - Backend API FINAL
// Works on all devices - PC, iOS, Android

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const useragent = require('useragent');
const geoip = require('geoip-lite');
const { Resend } = require('resend');
const twilio = require('twilio');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

// CORS - Allow all origins
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'noly-secret-key-2024';
const resend = new Resend(process.env.RESEND_API_KEY);
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN 
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ============ UTILITIES ============

function generateShortCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
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
  
  // Score based on threshold - reaching threshold = 70%
  const visitRatio = totalVisits / threshold;
  if (visitRatio >= 1.2) score = 85;
  else if (visitRatio >= 1) score = 70;
  else if (visitRatio >= 0.8) score = 55;
  else if (visitRatio >= 0.6) score = 40;
  else if (visitRatio >= 0.4) score = 25;
  else if (visitRatio >= 0.2) score = 15;
  else score = 5;
  
  // Bonus for multi-device
  if (uniqueDevices > 1) score += 10;
  
  // Bonus for return visits
  const uniqueIPs = new Set(humanClicks.map(c => c.ip_address)).size;
  if (totalVisits > uniqueIPs) score += 5;
  
  return Math.min(score, 100);
}

// Send WhatsApp alert
async function sendWhatsAppAlert(linkName, intentScore, clickCount, userWhatsapp) {
  console.log('WhatsApp function called - Number:', userWhatsapp);
  
  if (!twilioClient) {
    console.log('WhatsApp: Twilio not configured');
    return false;
  }
  
  if (!userWhatsapp) {
    console.log('WhatsApp: No number provided');
    return false;
  }
  
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

    console.log('WhatsApp: Sending to', whatsappNumber);

    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: whatsappNumber
    });
    
    console.log('WhatsApp: Sent successfully');
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
    
    console.log('Email sent to', userEmail);
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
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token invalide' });
  }
}

// ============ AUTH ENDPOINTS ============

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    
    console.log('Register attempt:', email);
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'Mot de passe trop court (min 6 caracteres)' });
    }
    
    // Check if email exists
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase().trim())
      .single();
    
    if (existing) {
      return res.status(400).json({ error: 'Cet email existe deja' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const { data: user, error } = await supabase
      .from('users')
      .insert({
        email: email.toLowerCase().trim(),
        password: hashedPassword,
        name: name || email.split('@')[0],
        plan: 'free',
        click_threshold: 5
      })
      .select()
      .single();
    
    if (error) {
      console.error('Register DB error:', error);
      throw error;
    }
    
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    
    console.log('Register success:', user.id);
    
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
    console.error('Register error:', error);
    res.status(500).json({ error: 'Erreur inscription' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    console.log('Login attempt:', email);
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }
    
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .single();
    
    if (error || !user) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }
    
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    
    console.log('Login success:', user.id);
    
    res.json({ 
      success: true, 
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan,
        whatsapp: user.whatsapp,
        click_threshold: user.click_threshold || 5
      }
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Erreur connexion' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, name, plan, whatsapp, click_threshold')
      .eq('id', req.userId)
      .single();
    
    if (error || !user) {
      return res.status(404).json({ error: 'Utilisateur non trouve' });
    }
    
    res.json({ success: true, user });
    
  } catch (error) {
    res.status(500).json({ error: 'Erreur' });
  }
});

app.put('/api/auth/settings', authMiddleware, async (req, res) => {
  try {
    const { name, whatsapp } = req.body;
    
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (whatsapp !== undefined) updates.whatsapp = whatsapp;
    
    const { data: user, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', req.userId)
      .select('id, email, name, plan, whatsapp, click_threshold')
      .single();
    
    if (error) throw error;
    
    res.json({ success: true, user });
    
  } catch (error) {
    res.status(500).json({ error: 'Erreur mise a jour' });
  }
});

// ============ LINKS ENDPOINTS ============

app.post('/api/links', authMiddleware, async (req, res) => {
  try {
    const { name, originalUrl, clickThreshold } = req.body;
    
    if (!name || !originalUrl) {
      return res.status(400).json({ error: 'Nom et URL requis' });
    }
    
    const shortCode = generateShortCode();
    
    const { data: link, error } = await supabase
      .from('links')
      .insert({
        user_id: req.userId,
        name,
        original_url: originalUrl,
        short_code: shortCode,
        click_threshold: clickThreshold || 5,
        alerts_enabled: true
      })
      .select()
      .single();
    
    if (error) throw error;
    
    const baseUrl = process.env.BASE_URL || 'https://v.noly.pro';
    
    res.json({
      success: true,
      link: {
        id: link.id,
        name: link.name,
        originalUrl: link.original_url,
        shortCode: link.short_code,
        trackableUrl: baseUrl + '/d/' + shortCode,
        clickThreshold: link.click_threshold,
        createdAt: link.created_at
      }
    });
    
  } catch (error) {
    console.error('Create link error:', error);
    res.status(500).json({ error: 'Erreur creation lien' });
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
    
    const baseUrl = process.env.BASE_URL || 'https://v.noly.pro';
    
    const linksWithStats = await Promise.all((links || []).map(async (link) => {
      const { data: clicks } = await supabase
        .from('clicks')
        .select('*')
        .eq('link_id', link.id)
        .order('timestamp', { ascending: false });
      
      const humanClicks = (clicks || []).filter(c => !c.is_bot);
      const botClicks = (clicks || []).filter(c => c.is_bot);
      const lastClick = humanClicks.length > 0 ? humanClicks[0] : null;
      
      return {
        id: link.id,
        name: link.name,
        originalUrl: link.original_url,
        shortCode: link.short_code,
        trackableUrl: baseUrl + '/d/' + link.short_code,
        clickThreshold: link.click_threshold || 5,
        alertsEnabled: link.alerts_enabled !== false,
        createdAt: link.created_at,
        stats: {
          totalClicks: humanClicks.length,
          botClicks: botClicks.length,
          intentScore: calculateIntentScore(clicks, link.click_threshold || 5),
          uniqueVisitors: new Set(humanClicks.map(c => c.ip_address)).size,
          lastClickAt: lastClick ? lastClick.timestamp : null,
          lastClickFormatted: lastClick ? formatDateFR(lastClick.timestamp) : null
        }
      };
    }));
    
    res.json({ success: true, links: linksWithStats });
    
  } catch (error) {
    console.error('Get links error:', error);
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
      return res.status(404).json({ error: 'Lien non trouve' });
    }
    
    const { data: clicks } = await supabase
      .from('clicks')
      .select('*')
      .eq('link_id', linkId)
      .order('timestamp', { ascending: false });
    
    const humanClicks = (clicks || []).filter(c => !c.is_bot);
    const botClicks = (clicks || []).filter(c => c.is_bot);
    
    // Last click
    const lastClick = humanClicks.length > 0 ? humanClicks[0] : null;
    
    // Hour analysis
    const hourCounts = {};
    humanClicks.forEach(click => {
      const hour = new Date(click.timestamp).getHours();
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    });
    const preferredHours = Object.entries(hourCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([hour, count]) => ({ hour: parseInt(hour), count }));
    
    // Day analysis
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
    
    // Return delays
    const ipVisits = {};
    humanClicks.forEach(click => {
      const ip = click.ip_address;
      if (!ipVisits[ip]) ipVisits[ip] = [];
      ipVisits[ip].push(new Date(click.timestamp));
    });
    
    const returnDelays = [];
    Object.values(ipVisits).forEach(visits => {
      if (visits.length > 1) {
        visits.sort((a, b) => a - b);
        for (let i = 1; i < visits.length; i++) {
          const delayMs = visits[i] - visits[i-1];
          const delayMin = Math.round(delayMs / 60000);
          returnDelays.push(delayMin);
        }
      }
    });
    const avgReturnDelay = returnDelays.length > 0 
      ? Math.round(returnDelays.reduce((a, b) => a + b, 0) / returnDelays.length)
      : null;
    
    // Multi-device detection
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
    
    const baseUrl = process.env.BASE_URL || 'https://v.noly.pro';
    
    res.json({
      success: true,
      link: {
        id: link.id,
        name: link.name,
        originalUrl: link.original_url,
        shortCode: link.short_code,
        trackableUrl: baseUrl + '/d/' + link.short_code,
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
    console.error('Get link error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

app.delete('/api/links/:linkId', authMiddleware, async (req, res) => {
  try {
    const { linkId } = req.params;
    
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
    console.error('Toggle alerts error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ============ TRACKING ENDPOINT ============

app.get('/d/:shortCode', async (req, res) => {
  try {
    const { shortCode } = req.params;
    
    const { data: link, error } = await supabase
      .from('links')
      .select('*')
      .eq('short_code', shortCode)
      .single();
    
    if (error || !link) {
      return res.status(404).send('Page non trouvee');
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
      user_agent: userAgent,
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
          const intentScore = calculateIntentScore(allClicks, threshold);
          const humanClicks = (allClicks || []).filter(c => !c.is_bot);
          
          console.log('Click on', link.name, '- Score:', intentScore + '%');
          
          if (intentScore >= 70 && link.alerts_enabled !== false) {
            const { data: recentAlerts } = await supabase
              .from('alerts_sent')
              .select('id')
              .eq('link_id', link.id)
              .gte('sent_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
            
            if (!recentAlerts || recentAlerts.length === 0) {
              console.log('HOT LINK:', link.name);
              
              const { data: user } = await supabase
                .from('users')
                .select('email, whatsapp')
                .eq('id', link.user_id)
                .single();
              
              if (user) {
                if (user.email) {
                  await sendEmailAlert(link.name, intentScore, humanClicks.length, humanClicks[0], user.email);
                }
                if (user.whatsapp) {
                  await sendWhatsAppAlert(link.name, intentScore, humanClicks.length, user.whatsapp);
                }
                
                await supabase.from('alerts_sent').insert({
                  user_id: link.user_id,
                  link_id: link.id,
                  intent_score: intentScore
                });
              }
            }
          }
        } catch (e) {
          console.error('Alert error:', e);
        }
      });
    }
    
    res.redirect(302, link.original_url);
    
  } catch (error) {
    console.error('Track error:', error);
    res.status(500).send('Erreur');
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '5.0' });
});

// Redirect shortcode without /d/
app.get('/:shortCode', (req, res) => {
  if (req.params.shortCode.length === 6) {
    res.redirect(301, '/d/' + req.params.shortCode);
  } else {
    res.status(404).send('Not found');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Noly API v5 FINAL running on port ' + PORT);
});
