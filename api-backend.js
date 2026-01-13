// ============================================================
// NOLY V2 - BACKEND API
// Smart Link Pages + QR Codes + Enhanced Tracking
// ============================================================
// 
// Stack: Node.js + Express + Supabase
// Deploy: Render.com (free tier)
//
// ============================================================

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

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const BASE_URL = process.env.BASE_URL || 'https://noly.pro';

// Validate JWT_SECRET
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be set and at least 32 characters');
  process.exit(1);
}

// Initialize services
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN 
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function generateShortCode(length = 6) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < length; i++) {
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

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
         req.headers['x-real-ip'] || 
         req.connection?.remoteAddress || 
         req.ip;
}

// ============================================================
// AUTHENTICATION MIDDLEWARE
// ============================================================

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// Check if user has PRO plan
async function requirePro(req, res, next) {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('plan')
      .eq('id', req.user.id)
      .single();
      
    if (!user || user.plan !== 'pro') {
      return res.status(403).json({ error: 'This feature requires a PRO plan' });
    }
    next();
  } catch (error) {
    res.status(500).json({ error: 'Failed to verify plan' });
  }
}

// ============================================================
// EMAIL TEMPLATES (English)
// ============================================================

function getLinkAlertEmailHtml(linkName, clicks, deviceInfo, location, linkUrl) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0b; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <div style="max-width: 500px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: linear-gradient(135deg, #1c1c1e 0%, #2c2c2e 100%); border-radius: 20px; padding: 32px; border: 1px solid rgba(255,255,255,0.1);">
      
      <div style="text-align: center; margin-bottom: 24px;">
        <div style="font-size: 48px; margin-bottom: 8px;">🔔</div>
        <h1 style="color: #ffffff; font-size: 24px; font-weight: 700; margin: 0;">Someone viewed your link!</h1>
      </div>
      
      <div style="background: rgba(191, 90, 242, 0.1); border: 1px solid rgba(191, 90, 242, 0.3); border-radius: 12px; padding: 20px; margin-bottom: 24px;">
        <div style="color: #bf5af2; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Link Name</div>
        <div style="color: #ffffff; font-size: 20px; font-weight: 600;">${linkName}</div>
      </div>
      
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px;">
        <div style="background: #2c2c2e; border-radius: 12px; padding: 16px; text-align: center;">
          <div style="color: #bf5af2; font-size: 28px; font-weight: 700;">${clicks}</div>
          <div style="color: rgba(255,255,255,0.6); font-size: 12px; text-transform: uppercase;">Total Views</div>
        </div>
        <div style="background: #2c2c2e; border-radius: 12px; padding: 16px; text-align: center;">
          <div style="color: #ffffff; font-size: 18px; font-weight: 600;">${deviceInfo}</div>
          <div style="color: rgba(255,255,255,0.6); font-size: 12px; text-transform: uppercase;">Device</div>
        </div>
      </div>
      
      <div style="background: #2c2c2e; border-radius: 12px; padding: 16px; margin-bottom: 24px;">
        <div style="color: rgba(255,255,255,0.6); font-size: 12px; margin-bottom: 4px;">📍 Location</div>
        <div style="color: #ffffff; font-size: 16px;">${location}</div>
      </div>
      
      <div style="text-align: center;">
        <a href="${linkUrl}" style="display: inline-block; background: linear-gradient(135deg, #bf5af2 0%, #9945c7 100%); color: #ffffff; text-decoration: none; padding: 16px 32px; border-radius: 12px; font-weight: 600; font-size: 16px;">View Dashboard →</a>
      </div>
      
      <div style="text-align: center; margin-top: 24px;">
        <p style="color: rgba(255,255,255,0.4); font-size: 13px; margin: 0;">This is the perfect moment to follow up!</p>
      </div>
      
    </div>
    
    <div style="text-align: center; margin-top: 24px;">
      <p style="color: rgba(255,255,255,0.3); font-size: 12px; margin: 0;">Sent by Noly • Link Tracking Made Simple</p>
    </div>
  </div>
</body>
</html>
  `;
}

function getQrAlertEmailHtml(qrName, scans, deviceInfo, location) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0b; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <div style="max-width: 500px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: linear-gradient(135deg, #1c1c1e 0%, #2c2c2e 100%); border-radius: 20px; padding: 32px; border: 1px solid rgba(255,255,255,0.1);">
      
      <div style="text-align: center; margin-bottom: 24px;">
        <div style="font-size: 48px; margin-bottom: 8px;">📱</div>
        <h1 style="color: #ffffff; font-size: 24px; font-weight: 700; margin: 0;">Someone scanned your QR code!</h1>
      </div>
      
      <div style="background: rgba(48, 209, 88, 0.1); border: 1px solid rgba(48, 209, 88, 0.3); border-radius: 12px; padding: 20px; margin-bottom: 24px;">
        <div style="color: #30d158; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">QR Code Name</div>
        <div style="color: #ffffff; font-size: 20px; font-weight: 600;">${qrName}</div>
      </div>
      
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px;">
        <div style="background: #2c2c2e; border-radius: 12px; padding: 16px; text-align: center;">
          <div style="color: #30d158; font-size: 28px; font-weight: 700;">${scans}</div>
          <div style="color: rgba(255,255,255,0.6); font-size: 12px; text-transform: uppercase;">Total Scans</div>
        </div>
        <div style="background: #2c2c2e; border-radius: 12px; padding: 16px; text-align: center;">
          <div style="color: #ffffff; font-size: 18px; font-weight: 600;">${deviceInfo}</div>
          <div style="color: rgba(255,255,255,0.6); font-size: 12px; text-transform: uppercase;">Device</div>
        </div>
      </div>
      
      <div style="background: #2c2c2e; border-radius: 12px; padding: 16px; margin-bottom: 24px;">
        <div style="color: rgba(255,255,255,0.6); font-size: 12px; margin-bottom: 4px;">📍 Location</div>
        <div style="color: #ffffff; font-size: 16px;">${location}</div>
      </div>
      
      <div style="text-align: center;">
        <p style="color: rgba(255,255,255,0.4); font-size: 13px; margin: 0;">Your QR code is getting attention!</p>
      </div>
      
    </div>
    
    <div style="text-align: center; margin-top: 24px;">
      <p style="color: rgba(255,255,255,0.3); font-size: 12px; margin: 0;">Sent by Noly • Link Tracking Made Simple</p>
    </div>
  </div>
</body>
</html>
  `;
}

function getPageLinkAlertEmailHtml(pageName, linkTitle, clicks, deviceInfo, location) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0b; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <div style="max-width: 500px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: linear-gradient(135deg, #1c1c1e 0%, #2c2c2e 100%); border-radius: 20px; padding: 32px; border: 1px solid rgba(255,255,255,0.1);">
      
      <div style="text-align: center; margin-bottom: 24px;">
        <div style="font-size: 48px; margin-bottom: 8px;">📄</div>
        <h1 style="color: #ffffff; font-size: 24px; font-weight: 700; margin: 0;">Someone clicked a link on your page!</h1>
      </div>
      
      <div style="background: rgba(191, 90, 242, 0.1); border: 1px solid rgba(191, 90, 242, 0.3); border-radius: 12px; padding: 20px; margin-bottom: 16px;">
        <div style="color: #bf5af2; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Smart Page</div>
        <div style="color: #ffffff; font-size: 20px; font-weight: 600;">${pageName}</div>
      </div>
      
      <div style="background: #2c2c2e; border-radius: 12px; padding: 16px; margin-bottom: 24px;">
        <div style="color: rgba(255,255,255,0.6); font-size: 12px; margin-bottom: 4px;">Link clicked</div>
        <div style="color: #ffffff; font-size: 16px; font-weight: 600;">${linkTitle}</div>
      </div>
      
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px;">
        <div style="background: #2c2c2e; border-radius: 12px; padding: 16px; text-align: center;">
          <div style="color: #bf5af2; font-size: 28px; font-weight: 700;">${clicks}</div>
          <div style="color: rgba(255,255,255,0.6); font-size: 12px; text-transform: uppercase;">Total Clicks</div>
        </div>
        <div style="background: #2c2c2e; border-radius: 12px; padding: 16px; text-align: center;">
          <div style="color: #ffffff; font-size: 16px; font-weight: 600;">${deviceInfo}</div>
          <div style="color: rgba(255,255,255,0.6); font-size: 12px; text-transform: uppercase;">Device</div>
        </div>
      </div>
      
      <div style="background: #2c2c2e; border-radius: 12px; padding: 16px;">
        <div style="color: rgba(255,255,255,0.6); font-size: 12px; margin-bottom: 4px;">📍 Location</div>
        <div style="color: #ffffff; font-size: 16px;">${location}</div>
      </div>
      
    </div>
    
    <div style="text-align: center; margin-top: 24px;">
      <p style="color: rgba(255,255,255,0.3); font-size: 12px; margin: 0;">Sent by Noly • Link Tracking Made Simple</p>
    </div>
  </div>
</body>
</html>
  `;
}

// ============================================================
// NOTIFICATION FUNCTIONS
// ============================================================

async function sendEmailAlert(to, subject, html) {
  if (!resend) {
    console.log('Email alert (Resend not configured):', subject);
    return;
  }
  
  try {
    await resend.emails.send({
      from: 'Noly <alerts@noly.pro>',
      to: to,
      subject: subject,
      html: html
    });
    console.log('Email sent to:', to);
  } catch (error) {
    console.error('Failed to send email:', error);
  }
}

async function sendWhatsAppAlert(to, message) {
  if (!twilioClient || !process.env.TWILIO_WHATSAPP_FROM) {
    console.log('WhatsApp alert (Twilio not configured):', message);
    return;
  }
  
  try {
    await twilioClient.messages.create({
      body: message,
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
      to: `whatsapp:${to}`
    });
    console.log('WhatsApp sent to:', to);
  } catch (error) {
    console.error('Failed to send WhatsApp:', error);
  }
}

// ============================================================
// AUTH ENDPOINTS
// ============================================================

// Request magic link
app.post('/api/auth/request', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    // Check if user exists, create if not
    let { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();
      
    if (!user) {
      const { data: newUser, error } = await supabase
        .from('users')
        .insert({ email: email.toLowerCase(), plan: 'free' })
        .select()
        .single();
        
      if (error) throw error;
      user = newUser;
    }
    
    // Generate magic link token
    const token = jwt.sign(
      { id: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '15m' }
    );
    
    const magicLink = `${BASE_URL}/auth/verify?token=${token}`;
    
    // Send email
    if (resend) {
      await resend.emails.send({
        from: 'Noly <login@noly.pro>',
        to: email,
        subject: 'Your login link for Noly',
        html: `
          <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;">
            <h2>Login to Noly</h2>
            <p>Click the button below to log in. This link expires in 15 minutes.</p>
            <a href="${magicLink}" style="display: inline-block; background: #bf5af2; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; margin: 20px 0;">Log in to Noly →</a>
            <p style="color: #666; font-size: 12px;">If you didn't request this, ignore this email.</p>
          </div>
        `
      });
    }
    
    res.json({ message: 'Magic link sent! Check your email.' });
    
  } catch (error) {
    console.error('Auth request error:', error);
    res.status(500).json({ error: 'Failed to send magic link' });
  }
});

// Verify magic link
app.get('/api/auth/verify', async (req, res) => {
  try {
    const { token } = req.query;
    
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }
    
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Generate session token (longer lived)
    const sessionToken = jwt.sign(
      { id: decoded.id, email: decoded.email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    
    res.json({ token: sessionToken, user: decoded });
    
  } catch (error) {
    res.status(403).json({ error: 'Invalid or expired token' });
  }
});

// Get current user
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', req.user.id)
      .single();
      
    if (error) throw error;
    res.json(user);
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// ============================================================
// LINKS ENDPOINTS (existing functionality)
// ============================================================

// Create a tracked link
app.post('/api/links', authenticateToken, async (req, res) => {
  try {
    const { name, original_url, custom_slug, threshold } = req.body;
    const userId = req.user.id;
    
    // Check link limit for free users
    const { data: user } = await supabase
      .from('users')
      .select('plan')
      .eq('id', userId)
      .single();
      
    const { count } = await supabase
      .from('links')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);
      
    const limit = user.plan === 'pro' ? 999 : 5;
    if (count >= limit) {
      return res.status(403).json({ error: `Link limit reached (${limit}). Upgrade to PRO for unlimited links.` });
    }
    
    // Generate or use custom slug
    let short_code = custom_slug || generateShortCode();
    
    // Check if slug is taken
    const { data: existing } = await supabase
      .from('links')
      .select('id')
      .eq('short_code', short_code)
      .single();
      
    if (existing) {
      short_code = generateShortCode(); // Generate new one if taken
    }
    
    const { data, error } = await supabase
      .from('links')
      .insert({
        user_id: userId,
        name: name || 'Untitled Link',
        original_url,
        short_code,
        threshold: threshold || 3
      })
      .select()
      .single();
      
    if (error) throw error;
    
    res.json({
      ...data,
      tracking_url: `${BASE_URL}/l/${short_code}`
    });
    
  } catch (error) {
    console.error('Create link error:', error);
    res.status(500).json({ error: 'Failed to create link' });
  }
});

// Get user's links
app.get('/api/links', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('links')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
      
    if (error) throw error;
    
    // Add tracking URLs
    const linksWithUrls = data.map(link => ({
      ...link,
      tracking_url: `${BASE_URL}/l/${link.short_code}`
    }));
    
    res.json(linksWithUrls);
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to get links' });
  }
});

// Get link stats
app.get('/api/links/:id/stats', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: clicks, error } = await supabase
      .from('clicks')
      .select('*')
      .eq('link_id', id)
      .order('timestamp', { ascending: false });
      
    if (error) throw error;
    
    // Calculate stats
    const totalClicks = clicks.length;
    const uniqueIps = [...new Set(clicks.map(c => c.ip_address))].length;
    const devices = clicks.reduce((acc, c) => {
      acc[c.device_type] = (acc[c.device_type] || 0) + 1;
      return acc;
    }, {});
    
    res.json({
      total_clicks: totalClicks,
      unique_visitors: uniqueIps,
      devices,
      recent_clicks: clicks.slice(0, 10)
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// Track link click (public endpoint)
app.get('/l/:shortCode', async (req, res) => {
  try {
    const { shortCode } = req.params;
    const userAgent = req.headers['user-agent'] || '';
    const ip = getClientIp(req);
    const referrer = req.headers['referer'] || 'direct';
    
    // Get link
    const { data: link, error } = await supabase
      .from('links')
      .select('*, users(*)')
      .eq('short_code', shortCode)
      .single();
      
    if (error || !link) {
      return res.status(404).send('Link not found');
    }
    
    // Check if bot
    const botCheck = detectBot(userAgent);
    if (botCheck.isBot) {
      return res.redirect(link.original_url);
    }
    
    // Get device and location info
    const deviceInfo = extractDeviceInfo(userAgent);
    const geo = getGeolocation(ip);
    
    // Record click
    await supabase.from('clicks').insert({
      link_id: link.id,
      ip_address: ip,
      country: geo.country,
      city: geo.city,
      device_type: deviceInfo.deviceType,
      device_model: deviceInfo.deviceModel,
      os: deviceInfo.os,
      os_version: deviceInfo.osVersion,
      browser: deviceInfo.browser,
      browser_version: deviceInfo.browserVersion,
      referrer: referrer,
      user_agent: userAgent
    });
    
    // Update click count
    const newClicks = (link.clicks || 0) + 1;
    await supabase
      .from('links')
      .update({ clicks: newClicks })
      .eq('id', link.id);
    
    // Check if should send alert
    const threshold = link.threshold || 3;
    if (newClicks % threshold === 0) {
      // Check if alert already sent for this count
      const { data: existingAlert } = await supabase
        .from('alerts_sent')
        .select('id')
        .eq('link_id', link.id)
        .eq('click_count', newClicks)
        .single();
        
      if (!existingAlert && link.users) {
        const user = link.users;
        const location = `${geo.city}, ${geo.country}`;
        
        // Send email alert
        if (user.email && user.notify_email !== false) {
          const emailHtml = getLinkAlertEmailHtml(
            link.name,
            newClicks,
            `${deviceInfo.deviceType} (${deviceInfo.os})`,
            location,
            `${BASE_URL}/dashboard`
          );
          await sendEmailAlert(
            user.email,
            `🔔 ${link.name} - ${newClicks} views!`,
            emailHtml
          );
        }
        
        // Send WhatsApp alert
        if (user.whatsapp_number && user.notify_whatsapp) {
          await sendWhatsAppAlert(
            user.whatsapp_number,
            `🔔 Noly Alert!\n\n"${link.name}" just hit ${newClicks} views!\n\n📱 Device: ${deviceInfo.deviceType}\n📍 Location: ${location}\n\nTime to follow up!`
          );
        }
        
        // Record alert sent
        await supabase.from('alerts_sent').insert({
          user_id: user.id,
          link_id: link.id,
          click_count: newClicks
        });
      }
    }
    
    // Redirect to destination
    res.redirect(link.original_url);
    
  } catch (error) {
    console.error('Track click error:', error);
    res.status(500).send('Error processing link');
  }
});

// ============================================================
// SMART PAGES ENDPOINTS (PRO feature)
// ============================================================

// Create a Smart Page
app.post('/api/pages', authenticateToken, requirePro, async (req, res) => {
  try {
    const { name, username, bio } = req.body;
    const userId = req.user.id;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    
    // Clean username
    const cleanUsername = username.toLowerCase().replace(/[^a-z0-9_]/g, '');
    
    // Check if username is taken
    const { data: existing } = await supabase
      .from('pages')
      .select('id')
      .eq('username', cleanUsername)
      .single();
      
    if (existing) {
      return res.status(400).json({ error: 'Username is already taken' });
    }
    
    const { data, error } = await supabase
      .from('pages')
      .insert({
        user_id: userId,
        name: name || 'My Page',
        username: cleanUsername,
        bio: bio || ''
      })
      .select()
      .single();
      
    if (error) throw error;
    
    res.json({
      ...data,
      page_url: `${BASE_URL}/@${cleanUsername}`
    });
    
  } catch (error) {
    console.error('Create page error:', error);
    res.status(500).json({ error: 'Failed to create page' });
  }
});

// Get user's pages
app.get('/api/pages', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pages')
      .select('*, page_links(*)')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
      
    if (error) throw error;
    
    const pagesWithUrls = data.map(page => ({
      ...page,
      page_url: `${BASE_URL}/@${page.username}`
    }));
    
    res.json(pagesWithUrls);
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to get pages' });
  }
});

// Get single page
app.get('/api/pages/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data, error } = await supabase
      .from('pages')
      .select('*, page_links(*)')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .single();
      
    if (error) throw error;
    
    res.json({
      ...data,
      page_url: `${BASE_URL}/@${data.username}`
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to get page' });
  }
});

// Update a page
app.put('/api/pages/:id', authenticateToken, requirePro, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, bio, theme } = req.body;
    
    const { data, error } = await supabase
      .from('pages')
      .update({ name, bio, theme, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select()
      .single();
      
    if (error) throw error;
    
    res.json(data);
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to update page' });
  }
});

// Delete a page
app.delete('/api/pages/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabase
      .from('pages')
      .delete()
      .eq('id', id)
      .eq('user_id', req.user.id);
      
    if (error) throw error;
    
    res.json({ message: 'Page deleted' });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete page' });
  }
});

// Add link to a page
app.post('/api/pages/:pageId/links', authenticateToken, requirePro, async (req, res) => {
  try {
    const { pageId } = req.params;
    const { title, url, icon } = req.body;
    
    // Verify page belongs to user
    const { data: page } = await supabase
      .from('pages')
      .select('id')
      .eq('id', pageId)
      .eq('user_id', req.user.id)
      .single();
      
    if (!page) {
      return res.status(404).json({ error: 'Page not found' });
    }
    
    // Get current max position
    const { data: links } = await supabase
      .from('page_links')
      .select('position')
      .eq('page_id', pageId)
      .order('position', { ascending: false })
      .limit(1);
      
    const newPosition = links && links.length > 0 ? links[0].position + 1 : 0;
    
    const { data, error } = await supabase
      .from('page_links')
      .insert({
        page_id: pageId,
        title: title || 'Untitled Link',
        url,
        icon,
        position: newPosition
      })
      .select()
      .single();
      
    if (error) throw error;
    
    res.json(data);
    
  } catch (error) {
    console.error('Add page link error:', error);
    res.status(500).json({ error: 'Failed to add link' });
  }
});

// Update page link
app.put('/api/pages/:pageId/links/:linkId', authenticateToken, async (req, res) => {
  try {
    const { pageId, linkId } = req.params;
    const { title, url, icon, position } = req.body;
    
    const { data, error } = await supabase
      .from('page_links')
      .update({ title, url, icon, position })
      .eq('id', linkId)
      .eq('page_id', pageId)
      .select()
      .single();
      
    if (error) throw error;
    
    res.json(data);
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to update link' });
  }
});

// Delete page link
app.delete('/api/pages/:pageId/links/:linkId', authenticateToken, async (req, res) => {
  try {
    const { pageId, linkId } = req.params;
    
    const { error } = await supabase
      .from('page_links')
      .delete()
      .eq('id', linkId)
      .eq('page_id', pageId);
      
    if (error) throw error;
    
    res.json({ message: 'Link deleted' });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete link' });
  }
});

// Public: View a Smart Page
app.get('/@:username', async (req, res) => {
  try {
    const { username } = req.params;
    const userAgent = req.headers['user-agent'] || '';
    const ip = getClientIp(req);
    
    const { data: page, error } = await supabase
      .from('pages')
      .select('*, page_links(*), users(*)')
      .eq('username', username.toLowerCase())
      .eq('is_active', true)
      .single();
      
    if (error || !page) {
      return res.status(404).json({ error: 'Page not found' });
    }
    
    // Check if bot
    const botCheck = detectBot(userAgent);
    if (!botCheck.isBot) {
      // Record page view
      const deviceInfo = extractDeviceInfo(userAgent);
      const geo = getGeolocation(ip);
      
      await supabase.from('page_views').insert({
        page_id: page.id,
        ip_address: ip,
        country: geo.country,
        city: geo.city,
        device_type: deviceInfo.deviceType,
        os: deviceInfo.os,
        browser: deviceInfo.browser,
        referrer: req.headers['referer'] || 'direct',
        user_agent: userAgent
      });
      
      // Increment view count
      await supabase.rpc('increment_page_views', { p_id: page.id });
    }
    
    // Return page data (remove sensitive user info)
    const { users, ...pageData } = page;
    res.json({
      ...pageData,
      page_links: page.page_links.sort((a, b) => a.position - b.position)
    });
    
  } catch (error) {
    console.error('View page error:', error);
    res.status(500).json({ error: 'Failed to load page' });
  }
});

// Track click on page link (public endpoint)
app.get('/p/:linkId', async (req, res) => {
  try {
    const { linkId } = req.params;
    const userAgent = req.headers['user-agent'] || '';
    const ip = getClientIp(req);
    
    // Get link and page info
    const { data: link, error } = await supabase
      .from('page_links')
      .select('*, pages(*, users(*))')
      .eq('id', linkId)
      .single();
      
    if (error || !link) {
      return res.status(404).send('Link not found');
    }
    
    // Check if bot
    const botCheck = detectBot(userAgent);
    if (!botCheck.isBot) {
      const deviceInfo = extractDeviceInfo(userAgent);
      const geo = getGeolocation(ip);
      
      // Record click
      await supabase.from('page_link_clicks').insert({
        page_link_id: linkId,
        page_id: link.page_id,
        ip_address: ip,
        country: geo.country,
        city: geo.city,
        device_type: deviceInfo.deviceType,
        os: deviceInfo.os,
        browser: deviceInfo.browser,
        referrer: req.headers['referer'] || 'direct',
        user_agent: userAgent
      });
      
      // Increment click count
      await supabase.rpc('increment_page_link_clicks', { link_id: linkId });
      
      // Send alert to page owner
      const newClicks = (link.clicks || 0) + 1;
      if (newClicks % 3 === 0 && link.pages && link.pages.users) {
        const user = link.pages.users;
        const location = `${geo.city}, ${geo.country}`;
        
        if (user.email && user.notify_email !== false) {
          const emailHtml = getPageLinkAlertEmailHtml(
            link.pages.name,
            link.title,
            newClicks,
            `${deviceInfo.deviceType} (${deviceInfo.os})`,
            location
          );
          await sendEmailAlert(
            user.email,
            `📄 ${link.title} clicked on your page!`,
            emailHtml
          );
        }
      }
    }
    
    // Redirect to destination
    res.redirect(link.url);
    
  } catch (error) {
    console.error('Track page link error:', error);
    res.status(500).send('Error processing link');
  }
});

// Get page stats
app.get('/api/pages/:id/stats', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get page views
    const { data: views } = await supabase
      .from('page_views')
      .select('*')
      .eq('page_id', id)
      .order('timestamp', { ascending: false })
      .limit(100);
      
    // Get link clicks
    const { data: clicks } = await supabase
      .from('page_link_clicks')
      .select('*, page_links(title)')
      .eq('page_id', id)
      .order('timestamp', { ascending: false })
      .limit(100);
      
    res.json({
      total_views: views?.length || 0,
      total_clicks: clicks?.length || 0,
      recent_views: views?.slice(0, 10) || [],
      recent_clicks: clicks?.slice(0, 10) || []
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// ============================================================
// QR CODES ENDPOINTS (PRO feature)
// ============================================================

// Create a QR code
app.post('/api/qr', authenticateToken, requirePro, async (req, res) => {
  try {
    const { name, destination_url, alert_threshold } = req.body;
    const userId = req.user.id;
    
    if (!destination_url) {
      return res.status(400).json({ error: 'Destination URL is required' });
    }
    
    const short_code = generateShortCode();
    
    const { data, error } = await supabase
      .from('qr_codes')
      .insert({
        user_id: userId,
        name: name || 'Untitled QR Code',
        destination_url,
        short_code,
        alert_threshold: alert_threshold || 3
      })
      .select()
      .single();
      
    if (error) throw error;
    
    res.json({
      ...data,
      qr_url: `${BASE_URL}/qr/${short_code}`
    });
    
  } catch (error) {
    console.error('Create QR error:', error);
    res.status(500).json({ error: 'Failed to create QR code' });
  }
});

// Get user's QR codes
app.get('/api/qr', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('qr_codes')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
      
    if (error) throw error;
    
    const qrWithUrls = data.map(qr => ({
      ...qr,
      qr_url: `${BASE_URL}/qr/${qr.short_code}`
    }));
    
    res.json(qrWithUrls);
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to get QR codes' });
  }
});

// Get single QR code
app.get('/api/qr/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data, error } = await supabase
      .from('qr_codes')
      .select('*')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .single();
      
    if (error) throw error;
    
    res.json({
      ...data,
      qr_url: `${BASE_URL}/qr/${data.short_code}`
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to get QR code' });
  }
});

// Update QR code
app.put('/api/qr/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, destination_url, alert_threshold, is_active } = req.body;
    
    const { data, error } = await supabase
      .from('qr_codes')
      .update({
        name,
        destination_url,
        alert_threshold,
        is_active,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select()
      .single();
      
    if (error) throw error;
    
    res.json(data);
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to update QR code' });
  }
});

// Delete QR code
app.delete('/api/qr/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabase
      .from('qr_codes')
      .delete()
      .eq('id', id)
      .eq('user_id', req.user.id);
      
    if (error) throw error;
    
    res.json({ message: 'QR code deleted' });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete QR code' });
  }
});

// Track QR code scan (public endpoint)
app.get('/qr/:shortCode', async (req, res) => {
  try {
    const { shortCode } = req.params;
    const userAgent = req.headers['user-agent'] || '';
    const ip = getClientIp(req);
    
    // Get QR code
    const { data: qr, error } = await supabase
      .from('qr_codes')
      .select('*, users(*)')
      .eq('short_code', shortCode)
      .eq('is_active', true)
      .single();
      
    if (error || !qr) {
      return res.status(404).send('QR code not found');
    }
    
    // Check if bot
    const botCheck = detectBot(userAgent);
    
    // Get device and location info
    const deviceInfo = extractDeviceInfo(userAgent);
    const geo = getGeolocation(ip);
    
    // Record scan
    await supabase.from('qr_scans').insert({
      qr_id: qr.id,
      ip_address: ip,
      country: geo.country,
      city: geo.city,
      device_type: deviceInfo.deviceType,
      device_model: deviceInfo.deviceModel,
      os: deviceInfo.os,
      os_version: deviceInfo.osVersion,
      browser: deviceInfo.browser,
      browser_version: deviceInfo.browserVersion,
      referrer: req.headers['referer'] || 'direct',
      user_agent: userAgent,
      is_bot: botCheck.isBot
    });
    
    // Update scan count (only for non-bots)
    if (!botCheck.isBot) {
      const newScans = (qr.scans || 0) + 1;
      await supabase
        .from('qr_codes')
        .update({ scans: newScans, updated_at: new Date().toISOString() })
        .eq('id', qr.id);
      
      // Check if should send alert
      const threshold = qr.alert_threshold || 3;
      if (newScans % threshold === 0 && qr.users) {
        // Check if alert already sent for this count
        const { data: existingAlert } = await supabase
          .from('qr_alerts_sent')
          .select('id')
          .eq('qr_id', qr.id)
          .eq('scan_count', newScans)
          .single();
          
        if (!existingAlert) {
          const user = qr.users;
          const location = `${geo.city}, ${geo.country}`;
          
          // Send email alert
          if (user.email && user.notify_email !== false) {
            const emailHtml = getQrAlertEmailHtml(
              qr.name,
              newScans,
              `${deviceInfo.deviceType} (${deviceInfo.os})`,
              location
            );
            await sendEmailAlert(
              user.email,
              `📱 ${qr.name} - ${newScans} scans!`,
              emailHtml
            );
          }
          
          // Send WhatsApp alert
          if (user.whatsapp_number && user.notify_whatsapp) {
            await sendWhatsAppAlert(
              user.whatsapp_number,
              `📱 Noly Alert!\n\nYour QR code "${qr.name}" just hit ${newScans} scans!\n\n📱 Device: ${deviceInfo.deviceType}\n📍 Location: ${location}\n\nYour QR code is getting attention!`
            );
          }
          
          // Record alert sent
          await supabase.from('qr_alerts_sent').insert({
            user_id: user.id,
            qr_id: qr.id,
            scan_count: newScans
          });
        }
      }
    }
    
    // Redirect to destination
    res.redirect(qr.destination_url);
    
  } catch (error) {
    console.error('Track QR scan error:', error);
    res.status(500).send('Error processing QR code');
  }
});

// Get QR code stats
app.get('/api/qr/:id/stats', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: scans, error } = await supabase
      .from('qr_scans')
      .select('*')
      .eq('qr_id', id)
      .eq('is_bot', false)
      .order('timestamp', { ascending: false });
      
    if (error) throw error;
    
    // Calculate stats
    const totalScans = scans.length;
    const uniqueIps = [...new Set(scans.map(s => s.ip_address))].length;
    const devices = scans.reduce((acc, s) => {
      acc[s.device_type] = (acc[s.device_type] || 0) + 1;
      return acc;
    }, {});
    const countries = scans.reduce((acc, s) => {
      acc[s.country] = (acc[s.country] || 0) + 1;
      return acc;
    }, {});
    
    res.json({
      total_scans: totalScans,
      unique_visitors: uniqueIps,
      devices,
      countries,
      recent_scans: scans.slice(0, 10)
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// ============================================================
// DASHBOARD STATS ENDPOINT
// ============================================================

app.get('/api/stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get total links and clicks
    const { data: links } = await supabase
      .from('links')
      .select('id, clicks')
      .eq('user_id', userId);
      
    const totalLinks = links?.length || 0;
    const totalClicks = links?.reduce((sum, l) => sum + (l.clicks || 0), 0) || 0;
    
    // Get total pages and views
    const { data: pages } = await supabase
      .from('pages')
      .select('id, total_views')
      .eq('user_id', userId);
      
    const totalPages = pages?.length || 0;
    const totalPageViews = pages?.reduce((sum, p) => sum + (p.total_views || 0), 0) || 0;
    
    // Get total QR codes and scans
    const { data: qrCodes } = await supabase
      .from('qr_codes')
      .select('id, scans')
      .eq('user_id', userId);
      
    const totalQrCodes = qrCodes?.length || 0;
    const totalScans = qrCodes?.reduce((sum, q) => sum + (q.scans || 0), 0) || 0;
    
    // Get hot links (most active in last 24h)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentClicks } = await supabase
      .from('clicks')
      .select('link_id')
      .gte('timestamp', yesterday);
      
    const hotLinkIds = [...new Set(recentClicks?.map(c => c.link_id) || [])];
    
    res.json({
      total_links: totalLinks,
      total_clicks: totalClicks,
      total_pages: totalPages,
      total_page_views: totalPageViews,
      total_qr_codes: totalQrCodes,
      total_scans: totalScans,
      hot_leads: hotLinkIds.length
    });
    
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0', timestamp: new Date().toISOString() });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║                    NOLY API v2.0.0                       ║
║══════════════════════════════════════════════════════════║
║  Server running on port ${PORT}                            ║
║                                                          ║
║  Features:                                               ║
║  ✓ Link Tracking                                         ║
║  ✓ Smart Link Pages (PRO)                                ║
║  ✓ QR Code Tracking (PRO)                                ║
║  ✓ Email Alerts (English)                                ║
║  ✓ WhatsApp Alerts                                       ║
║                                                          ║
║  Endpoints:                                              ║
║  • /l/:code     - Track link click                       ║
║  • /@:username  - View Smart Page                        ║
║  • /p/:linkId   - Track page link click                  ║
║  • /qr/:code    - Track QR code scan                     ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
  `);
});
