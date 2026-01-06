// Noly Pro - Backend API v3
// Features: Auth, Analytics, Bot Detection, Custom Thresholds

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

// Config
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

// Generate short code
function generateShortCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Extract device info
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

// Get geolocation
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

// Detect bot
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

// Calculate intent score
function calculateIntentScore(clicks, threshold = 5) {
  if (!clicks || clicks.length === 0) return 0;
  
  // Filter out bots
  const humanClicks = clicks.filter(c => !c.is_bot);
  if (humanClicks.length === 0) return 0;
  
  const totalVisits = humanClicks.length;
  const avgDuration = humanClicks.reduce((sum, c) => sum + (c.duration || 0), 0) / humanClicks.length;
  const uniqueDevices = new Set(humanClicks.map(c => c.device_type)).size;
  const uniqueIPs = new Set(humanClicks.map(c => c.ip_address)).size;
  
  let score = 0;
  
  // Visit frequency (scaled to threshold)
  const visitRatio = totalVisits / threshold;
  if (visitRatio >= 1.5) score += 70;
  else if (visitRatio >= 1) score += 60;
  else if (visitRatio >= 0.8) score += 50;
  else if (visitRatio >= 0.6) score += 40;
  else if (visitRatio >= 0.4) score += 25;
  else score += 10;
  
  // Duration bonus
  if (avgDuration > 120) score += 25;
  else if (avgDuration > 60) score += 15;
  else if (avgDuration > 30) score += 10;
  else if (avgDuration > 0) score += 5;
  
  // Multi-device bonus
  if (uniqueDevices > 1) score += 15;
  
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

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }
    
    // Check if exists
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();
    
    if (existing) {
      return res.status(400).json({ error: 'Cet email existe deja' });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Create user
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
    
    // Generate token
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

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }
    
    // Get user
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();
    
    if (error || !user) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }
    
    // Check password
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }
    
    // Generate token
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

// Get current user
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

// Update user settings
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

// Create link
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

// Get all links
app.get('/api/links', authMiddleware, async (req, res) => {
  try {
    const { data: links, error } = await supabase
      .from('links')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    // Get stats for each link
    const linksWithStats = await Promise.all(links.map(async (link) => {
      const { data: clicks } = await supabase
        .from('clicks')
        .select('*')
        .eq('link_id', link.id);
      
      const humanClicks = clicks?.filter(c => !c.is_bot) || [];
      const botClicks = clicks?.filter(c => c.is_bot) || [];
      
      return {
        id: link.id,
        name: link.name,
        originalUrl: link.original_url,
        shortCode: link.short_code,
        trackableUrl: `${process.env.BASE_URL || 'https://v.noly.pro'}/d/${link.short_code}`,
        clickThreshold: link.click_threshold || 5,
        createdAt: link.created_at,
        stats: {
          totalClicks: humanClicks.length,
          botClicks: botClicks.length,
          intentScore: calculateIntentScore(clicks, link.click_threshold || 5),
          uniqueVisitors: new Set(humanClicks.map(c => c.ip_address)).size
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
    
    // Get all clicks
    const { data: clicks } = await supabase
      .from('clicks')
      .select('*')
      .eq('link_id', linkId)
      .order('timestamp', { ascending: false });
    
    const humanClicks = clicks?.filter(c => !c.is_bot) || [];
    const botClicks = clicks?.filter(c => c.is_bot) || [];
    
    // Group by IP for visitor analysis
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
          totalDuration: 0,
          firstVisit: click.timestamp,
          lastVisit: click.timestamp
        };
      }
      visitorMap[ip].visits.push({
        timestamp: click.timestamp,
        duration: click.duration || 0,
        device: click.device_type
      });
      visitorMap[ip].totalDuration += click.duration || 0;
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
      avgDuration: v.visits.length > 0 ? Math.round(v.totalDuration / v.visits.length) : 0
    })).sort((a, b) => b.visitCount - a.visitCount);
    
    // Bot analysis
    const botAnalysis = {};
    botClicks.forEach(click => {
      const type = click.bot_type || 'unknown';
      botAnalysis[type] = (botAnalysis[type] || 0) + 1;
    });
    
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
    
    res.json({
      success: true,
      link: {
        id: link.id,
        name: link.name,
        originalUrl: link.original_url,
        shortCode: link.short_code,
        trackableUrl: `${process.env.BASE_URL || 'https://v.noly.pro'}/d/${link.short_code}`,
        clickThreshold: link.click_threshold || 5,
        createdAt: link.created_at
      },
      analytics: {
        totalClicks: humanClicks.length,
        botClicks: botClicks.length,
        uniqueVisitors: visitors.length,
        intentScore: calculateIntentScore(clicks, link.click_threshold || 5),
        avgDuration: humanClicks.length > 0 
          ? Math.round(humanClicks.reduce((sum, c) => sum + (c.duration || 0), 0) / humanClicks.length)
          : 0,
        visitors,
        botAnalysis,
        geoBreakdown,
        deviceBreakdown,
        recentClicks: humanClicks.slice(0, 20).map(c => ({
          timestamp: c.timestamp,
          city: c.city,
          country: c.country,
          device: c.device_type,
          browser: c.browser,
          duration: c.duration
        }))
      }
    });
    
  } catch (error) {
    console.error('Get link error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Delete link
app.delete('/api/links/:linkId', authMiddleware, async (req, res) => {
  try {
    const { linkId } = req.params;
    
    // Delete clicks first
    await supabase.from('clicks').delete().eq('link_id', linkId);
    
    // Delete link
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

// Get hot links
app.get('/api/links/hot', authMiddleware, async (req, res) => {
  try {
    const { data: links } = await supabase
      .from('links')
      .select('*')
      .eq('user_id', req.userId);
    
    const hotLinks = [];
    
    for (const link of links || []) {
      const { data: clicks } = await supabase
        .from('clicks')
        .select('*')
        .eq('link_id', link.id);
      
      const intentScore = calculateIntentScore(clicks, link.click_threshold || 5);
      const humanClicks = clicks?.filter(c => !c.is_bot) || [];
      
      if (intentScore >= 70) {
        hotLinks.push({
          id: link.id,
          name: link.name,
          shortCode: link.short_code,
          trackableUrl: `${process.env.BASE_URL || 'https://v.noly.pro'}/d/${link.short_code}`,
          intentScore,
          totalClicks: humanClicks.length,
          latestClick: humanClicks[0]
        });
      }
    }
    
    res.json({ 
      success: true, 
      hotLinks: hotLinks.sort((a, b) => b.intentScore - a.intentScore) 
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Erreur' });
  }
});

// ============ TRACKING ENDPOINT ============

app.get('/d/:shortCode', async (req, res) => {
  try {
    const { shortCode } = req.params;
    
    // Get link
    const { data: link, error } = await supabase
      .from('links')
      .select('*')
      .eq('short_code', shortCode)
      .single();
    
    if (error || !link) {
      return res.status(404).send('Page non trouvee');
    }
    
    // Extract data
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const userAgent = req.headers['user-agent'] || '';
    const referrer = req.headers['referer'] || 'direct';
    
    const deviceInfo = extractDeviceInfo(userAgent);
    const geoInfo = getGeolocation(ip);
    const botInfo = detectBot(userAgent);
    const sessionId = `${ip}-${Date.now()}`;
    
    // Count previous visits
    const { data: prevClicks } = await supabase
      .from('clicks')
      .select('id')
      .eq('link_id', link.id)
      .eq('ip_address', ip);
    
    const visitNumber = (prevClicks?.length || 0) + 1;
    
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
      session_id: sessionId,
      visit_number: visitNumber,
      is_bot: botInfo.isBot,
      bot_type: botInfo.botType,
      duration: 0
    });
    
    // Auto-alert check (async)
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
            // Check recent alerts
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
    
    // Redirect
    res.redirect(302, link.original_url);
    
  } catch (error) {
    console.error('Track error:', error);
    res.status(500).send('Erreur');
  }
});

// Update duration
app.post('/api/track/duration', express.text({ type: '*/*' }), async (req, res) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { linkId, sessionId, duration } = body;
    
    if (linkId && sessionId && duration !== undefined) {
      await supabase
        .from('clicks')
        .update({ duration })
        .eq('link_id', linkId)
        .eq('session_id', sessionId);
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '3.0' });
});

// Legacy redirect
app.get('/:shortCode', (req, res) => {
  res.redirect(301, '/d/' + req.params.shortCode);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Noly API v3 running on port ' + PORT);
});
