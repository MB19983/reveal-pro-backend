// Noly Pro - Backend API v4
// Enhanced Analytics: time tracking, patterns, multi-device

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
app.use(cors());
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

function parseReferrer(referrer) {
  if (!referrer || referrer === 'direct') return 'Direct';
  try {
    const url = new URL(referrer);
    const host = url.hostname.toLowerCase();
    if (host.includes('google')) return 'Google';
    if (host.includes('facebook') || host.includes('fb.com')) return 'Facebook';
    if (host.includes('linkedin')) return 'LinkedIn';
    if (host.includes('twitter') || host.includes('t.co')) return 'Twitter/X';
    if (host.includes('instagram')) return 'Instagram';
    if (host.includes('whatsapp') || host.includes('wa.me')) return 'WhatsApp';
    if (host.includes('mail') || host.includes('gmail') || host.includes('outlook')) return 'Email';
    return host;
  } catch (e) {
    return 'Direct';
  }
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

function calculateIntentScore(clicks, threshold = 5) {
  if (!clicks || clicks.length === 0) return 0;
  
  const humanClicks = clicks.filter(c => !c.is_bot);
  if (humanClicks.length === 0) return 0;
  
  const totalVisits = humanClicks.length;
  const uniqueDevices = new Set(humanClicks.map(c => c.device_type)).size;
  
  let score = 0;
  
  // Score based on threshold - reaching threshold = 70%
  const visitRatio = totalVisits / threshold;
  if (visitRatio >= 1.2) score = 85;      // 20% above threshold
  else if (visitRatio >= 1) score = 70;   // At threshold = HOT
  else if (visitRatio >= 0.8) score = 55; // 80% of threshold
  else if (visitRatio >= 0.6) score = 40; // 60% of threshold
  else if (visitRatio >= 0.4) score = 25; // 40% of threshold
  else if (visitRatio >= 0.2) score = 15; // 20% of threshold
  else score = 5;
  
  // Bonus for multi-device (shows high interest)
  if (uniqueDevices > 1) score += 10;
  
  // Bonus for return visits from same IP
  const uniqueIPs = new Set(humanClicks.map(c => c.ip_address)).size;
  if (totalVisits > uniqueIPs) score += 5; // Has return visits
  
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
        <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto; background: #0a0a0f;">
          <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: white; padding: 30px; text-align: center;">
            <h1 style="margin: 0; font-size: 24px; font-weight: 600;">Nouveau prospect interesse</h1>
          </div>
          <div style="background: #1a1a2e; padding: 30px; color: #e0e0e0;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 25px; border-radius: 12px; text-align: center; margin-bottom: 25px;">
              <div style="font-size: 14px; opacity: 0.9; margin-bottom: 8px;">LIEN ACTIF</div>
              <div style="font-size: 22px; font-weight: bold; color: white;">${linkName}</div>
            </div>
            <table style="width: 100%; margin: 25px 0;">
              <tr>
                <td style="text-align: center; padding: 20px; background: #252540; border-radius: 10px;">
                  <div style="font-size: 36px; font-weight: bold; color: #667eea;">${clickCount}</div>
                  <div style="color: #888; font-size: 14px; margin-top: 5px;">Visites</div>
                </td>
                <td style="width: 15px;"></td>
                <td style="text-align: center; padding: 20px; background: #252540; border-radius: 10px;">
                  <div style="font-size: 36px; font-weight: bold; color: #667eea;">${intentScore}%</div>
                  <div style="color: #888; font-size: 14px; margin-top: 5px;">Interet</div>
                </td>
              </tr>
            </table>
            <div style="background: #252540; border-left: 4px solid #667eea; padding: 15px 20px; margin: 20px 0; border-radius: 0 8px 8px 0;">
              <strong style="color: #667eea;">Recommandation</strong>
              <p style="margin: 8px 0 0; color: #aaa;">Contactez ce prospect rapidement, son interet est eleve !</p>
            </div>
            <div style="background: #252540; padding: 15px; border-radius: 8px; font-size: 13px; color: #888;">
              <strong style="color: #e0e0e0;">Derniere activite:</strong><br>
              ${latestClick?.city || 'Inconnu'}, ${latestClick?.country || ''}<br>
              ${latestClick?.device_type || ''} - ${latestClick?.browser || ''}<br>
              ${new Date().toLocaleString('fr-FR')}
            </div>
          </div>
          <div style="background: #0a0a0f; padding: 20px; text-align: center;">
            <p style="color: #555; font-size: 12px; margin: 0;">Noly Pro - Tracking intelligent</p>
          </div>
        </div>
      `
    });
    
    console.log('Email sent');
    return true;
  } catch (error) {
    console.error('Email error:', error.message);
    return false;
  }
}

// Auth middleware
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ error: 'Token requis' });
  }
  
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
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }
    
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();
    
    if (existing) {
      return res.status(400).json({ error: 'Cet email existe deja' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const { data: user, error } = await supabase
      .from('users')
      .insert({
        email,
        password: hashedPassword,
        name: name || email.split('@')[0],
        plan: 'free',
        click_threshold: 5
      })
      .select()
      .single();
    
    if (error) throw error;
    
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    
    res.json({ 
      success: true, 
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan,
        click_threshold: user.click_threshold
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
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }
    
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();
    
    if (error || !user) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }
    
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    
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
    const { name, whatsapp, click_threshold } = req.body;
    
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (whatsapp !== undefined) updates.whatsapp = whatsapp;
    if (click_threshold !== undefined) updates.click_threshold = parseInt(click_threshold) || 5;
    
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
        click_threshold: clickThreshold || 5
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
        trackableUrl: `${baseUrl}/d/${shortCode}`,
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
    
    const linksWithStats = await Promise.all(links.map(async (link) => {
      const { data: clicks } = await supabase
        .from('clicks')
        .select('*')
        .eq('link_id', link.id)
        .order('timestamp', { ascending: false });
      
      const humanClicks = clicks?.filter(c => !c.is_bot) || [];
      const botClicks = clicks?.filter(c => c.is_bot) || [];
      
      // Get last click time
      const lastClick = humanClicks.length > 0 ? humanClicks[0] : null;
      
      return {
        id: link.id,
        name: link.name,
        originalUrl: link.original_url,
        shortCode: link.short_code,
        trackableUrl: `${process.env.BASE_URL || 'https://v.noly.pro'}/d/${link.short_code}`,
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
    
    const humanClicks = clicks?.filter(c => !c.is_bot) || [];
    const botClicks = clicks?.filter(c => c.is_bot) || [];
    
    // ===== ENHANCED ANALYTICS =====
    
    // 1. Last click
    const lastClick = humanClicks.length > 0 ? humanClicks[0] : null;
    
    // 2. Hour analysis (preferred hours)
    const hourCounts = {};
    humanClicks.forEach(click => {
      const hour = new Date(click.timestamp).getHours();
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    });
    const preferredHours = Object.entries(hourCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([hour, count]) => ({ hour: parseInt(hour), count }));
    
    // 3. Day of week analysis
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
    
    // 4. Return delays (time between visits for same IP)
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
    
    // 5. Referrer analysis
    const referrerCounts = {};
    humanClicks.forEach(click => {
      const source = parseReferrer(click.referrer);
      referrerCounts[source] = (referrerCounts[source] || 0) + 1;
    });
    const referrerBreakdown = Object.entries(referrerCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([source, count]) => ({ source, count }));
    
    // 6. Multi-device detection
    const ipDevices = {};
    humanClicks.forEach(click => {
      const ip = click.ip_address;
      if (!ipDevices[ip]) ipDevices[ip] = new Set();
      ipDevices[ip].add(click.device_type);
    });
    const multiDeviceUsers = Object.entries(ipDevices)
      .filter(([ip, devices]) => devices.size > 1)
      .map(([ip, devices]) => ({ ip, devices: Array.from(devices) }));
    
    // 7. Visitors with return count
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
          os: click.os,
          visits: [],
          firstVisit: click.timestamp,
          lastVisit: click.timestamp
        };
      }
      visitorMap[ip].visits.push({
        timestamp: click.timestamp,
        device: click.device_type,
        referrer: parseReferrer(click.referrer)
      });
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
      firstVisitFormatted: formatDateFR(v.firstVisit),
      lastVisitFormatted: formatDateFR(v.lastVisit),
      isMultiDevice: ipDevices[v.ip]?.size > 1
    })).sort((a, b) => b.visitCount - a.visitCount);
    
    // Geographic breakdown
    const geoBreakdown = {};
    humanClicks.forEach(click => {
      const loc = `${click.city}, ${click.country}`;
      geoBreakdown[loc] = (geoBreakdown[loc] || 0) + 1;
    });
    
    // Device breakdown
    const deviceBreakdown = {};
    humanClicks.forEach(click => {
      deviceBreakdown[click.device_type] = (deviceBreakdown[click.device_type] || 0) + 1;
    });
    
    // Recent clicks with formatted time
    const recentClicks = humanClicks.slice(0, 20).map(c => ({
      timestamp: c.timestamp,
      timestampFormatted: formatDateFR(c.timestamp),
      city: c.city,
      country: c.country,
      device: c.device_type,
      browser: c.browser,
      referrer: parseReferrer(c.referrer)
    }));
    
    res.json({
      success: true,
      link: {
        id: link.id,
        name: link.name,
        originalUrl: link.original_url,
        shortCode: link.short_code,
        trackableUrl: `${process.env.BASE_URL || 'https://v.noly.pro'}/d/${link.short_code}`,
        clickThreshold: link.click_threshold || 5,
        alertsEnabled: link.alerts_enabled !== false,
        createdAt: link.created_at
      },
      analytics: {
        totalClicks: humanClicks.length,
        botClicks: botClicks.length,
        uniqueVisitors: visitors.length,
        intentScore: calculateIntentScore(clicks, link.click_threshold || 5),
        
        // Last click info
        lastClickAt: lastClick?.timestamp || null,
        lastClickFormatted: lastClick ? formatDateFR(lastClick.timestamp) : 'Aucun clic',
        lastClickCity: lastClick?.city || null,
        lastClickDevice: lastClick?.device_type || null,
        
        // Time patterns
        preferredHours,
        preferredDays,
        avgReturnDelayMinutes: avgReturnDelay,
        
        // Sources
        referrerBreakdown,
        
        // Multi-device
        multiDeviceUsers,
        hasMultiDeviceActivity: multiDeviceUsers.length > 0,
        
        // Breakdowns
        geoBreakdown,
        deviceBreakdown,
        
        // Visitors
        visitors,
        recentClicks
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
    
    await supabase.from('clicks').delete().eq('link_id', linkId);
    await supabase.from('alerts_sent').delete().eq('link_id', linkId);
    
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

// Toggle alerts for a link
app.put('/api/links/:linkId/alerts', authMiddleware, async (req, res) => {
  try {
    const { linkId } = req.params;
    const { enabled } = req.body;
    
    console.log('Toggle alerts:', linkId, 'enabled:', enabled);
    
    // First check if link exists and belongs to user
    const { data: existingLink, error: findError } = await supabase
      .from('links')
      .select('id, alerts_enabled')
      .eq('id', linkId)
      .eq('user_id', req.userId)
      .single();
    
    if (findError || !existingLink) {
      console.log('Link not found:', findError);
      return res.status(404).json({ error: 'Lien non trouve' });
    }
    
    // Update alerts_enabled
    const { data: link, error } = await supabase
      .from('links')
      .update({ alerts_enabled: enabled })
      .eq('id', linkId)
      .eq('user_id', req.userId)
      .select()
      .single();
    
    if (error) {
      console.log('Update error:', error);
      // If column doesn't exist, try to handle gracefully
      if (error.message && error.message.includes('alerts_enabled')) {
        return res.status(500).json({ error: 'Colonne alerts_enabled manquante. Executez la migration SQL.' });
      }
      throw error;
    }
    
    console.log('Alerts updated:', link.alerts_enabled);
    res.json({ success: true, alertsEnabled: link.alerts_enabled });
    
  } catch (error) {
    console.error('Toggle alerts error:', error);
    res.status(500).json({ error: 'Erreur mise a jour: ' + (error.message || 'inconnue') });
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
    const sessionId = `${ip}-${Date.now()}`;
    
    const { data: prevClicks } = await supabase
      .from('clicks')
      .select('id')
      .eq('link_id', link.id)
      .eq('ip_address', ip);
    
    const visitNumber = (prevClicks?.length || 0) + 1;
    
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
      session_id: sessionId,
      visit_number: visitNumber,
      is_bot: botInfo.isBot,
      bot_type: botInfo.botType
    });
    
    // Auto-alert check
    if (!botInfo.isBot) {
      setImmediate(async () => {
        try {
          const { data: allClicks } = await supabase
            .from('clicks')
            .select('*')
            .eq('link_id', link.id)
            .order('timestamp', { ascending: false });
          
          const threshold = link.click_threshold || 5;
          const intentScore = calculateIntentScore(allClicks, threshold);
          
          console.log(`Click: ${shortCode} | Visits: ${allClicks.filter(c => !c.is_bot).length} | Score: ${intentScore}%`);
          
          if (intentScore >= 70) {
            // Check if alerts are enabled for this link
            if (link.alerts_enabled === false) {
              console.log('Alerts disabled for link: ' + link.name);
              return;
            }
            
            const { data: recentAlerts } = await supabase
              .from('alerts_sent')
              .select('id')
              .eq('link_id', link.id)
              .gte('sent_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
            
            if (!recentAlerts || recentAlerts.length === 0) {
              console.log('HOT LINK: ' + link.name);
              
              const { data: user } = await supabase
                .from('users')
                .select('email, whatsapp')
                .eq('id', link.user_id)
                .single();
              
              if (user) {
                const humanClicks = allClicks.filter(c => !c.is_bot);
                
                console.log('User email:', user.email);
                console.log('User whatsapp:', user.whatsapp);
                
                if (user.email) {
                  await sendEmailAlert(link.name, intentScore, humanClicks.length, humanClicks[0], user.email);
                }
                
                if (user.whatsapp) {
                  await sendWhatsAppAlert(link.name, intentScore, humanClicks.length, user.whatsapp);
                } else {
                  console.log('No WhatsApp configured for user');
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '4.0' });
});

app.get('/:shortCode', (req, res) => {
  res.redirect(301, '/d/' + req.params.shortCode);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Noly API v4 running on port ' + PORT);
});
