// Backend API - Tracking System
// Stack: Node.js + Express + Supabase
// This would be deployed on Vercel/Railway/Render (free tier)

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const useragent = require('useragent');
const geoip = require('geoip-lite');
const { Resend } = require('resend');
const twilio = require('twilio');

const app = express();
app.use(cors());
app.use(express.json());

// Resend setup for email alerts
const resend = new Resend(process.env.RESEND_API_KEY);

// Twilio setup for WhatsApp alerts
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN 
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// Supabase setup (use free tier)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/**
 * DATABASE SCHEMA (Supabase tables)
 * 
 * Table: users
 * - id (uuid, primary key)
 * - email (text)
 * - name (text)
 * - plan (text: 'free', 'pro', 'agency')
 * - created_at (timestamp)
 * 
 * Table: links
 * - id (uuid, primary key)
 * - user_id (uuid, foreign key)
 * - name (text)
 * - original_url (text)
 * - short_code (text, unique)
 * - created_at (timestamp)
 * 
 * Table: clicks
 * - id (uuid, primary key)
 * - link_id (uuid, foreign key)
 * - timestamp (timestamp)
 * - duration (integer, seconds)
 * - ip_address (text)
 * - country (text)
 * - city (text)
 * - device_type (text: 'mobile', 'tablet', 'desktop')
 * - device_model (text)
 * - os (text)
 * - os_version (text)
 * - browser (text)
 * - browser_version (text)
 * - referrer (text)
 * - user_agent (text)
 * - session_id (text)
 * - visit_number (integer)
 */

// Utility: Generate short code
function generateShortCode() {
  return Math.random().toString(36).substring(2, 8);
}

// Utility: Extract comprehensive device info
function extractDeviceInfo(userAgent) {
  const agent = useragent.parse(userAgent);
  
  return {
    deviceType: agent.device.family === 'Other' ? 'desktop' : 
                (agent.device.family.includes('iPad') || agent.device.family.includes('Tablet') ? 'tablet' : 'mobile'),
    deviceModel: agent.device.family,
    os: agent.os.family,
    osVersion: agent.os.toVersion(),
    browser: agent.family,
    browserVersion: agent.toVersion()
  };
}

// Utility: Get geolocation from IP
function getGeolocation(ip) {
  // Remove local IPs
  if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168')) {
    return { country: 'Unknown', city: 'Unknown' };
  }
  
  const geo = geoip.lookup(ip);
  
  if (!geo) {
    return { country: 'Unknown', city: 'Unknown' };
  }
  
  return {
    country: geo.country,
    city: geo.city || 'Unknown'
  };
}

// Utility: Calculate intent score
function calculateIntentScore(clicks) {
  if (!clicks || clicks.length === 0) return 0;
  
  const totalVisits = clicks.length;
  const avgDuration = clicks.reduce((sum, c) => sum + c.duration, 0) / clicks.length;
  const uniqueDevices = new Set(clicks.map(c => c.device_type)).size;
  
  let score = 0;
  
  // Visit frequency scoring
  if (totalVisits >= 5) score += 50;
  else if (totalVisits >= 3) score += 40;
  else if (totalVisits === 2) score += 20;
  else score += 5;
  
  // Duration scoring
  if (avgDuration > 300) score += 40;
  else if (avgDuration > 180) score += 30;
  else if (avgDuration > 120) score += 25;
  else if (avgDuration > 60) score += 10;
  
  // Multi-device (sharing = high interest)
  if (uniqueDevices > 1) score += 20;
  
  return Math.min(score, 100);
}

// Utility: Send WhatsApp alert
async function sendWhatsAppAlert(prospectName, linkName, intentScore, clicks) {
  // Skip if Twilio not configured
  if (!twilioClient || !process.env.WHATSAPP_TO) {
    console.log('⚠️ WhatsApp non configuré (Twilio credentials manquants)');
    return false;
  }
  
  try {
    const message = `🔥 *PROSPECT CHAUD !*

👤 *${prospectName.replace(/_/g, ' ')}*
📄 ${linkName}

📊 *Statistiques :*
• ${clicks} visites
• Score d'intention : ${intentScore}%

⚡ *Action recommandée :*
Relancer MAINTENANT pendant que l'intérêt est au maximum !

---
Reveal Pro`;

    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: process.env.WHATSAPP_TO
    });
    
    console.log('✅ WhatsApp envoyé !');
    return true;
  } catch (error) {
    console.error('❌ Erreur WhatsApp:', error.message);
    return false;
  }
}

// ENDPOINT: Create a new trackable link
app.post('/api/links/create', async (req, res) => {
  try {
    const { userId, name, originalUrl } = req.body;
    
    // Validate
    if (!userId || !name || !originalUrl) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const shortCode = generateShortCode();
    
    // Insert into database
    const { data, error } = await supabase
      .from('links')
      .insert({
        user_id: userId,
        name: name,
        original_url: originalUrl,
        short_code: shortCode
      })
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({
      success: true,
      link: {
        id: data.id,
        name: data.name,
        trackableUrl: `https://reveal.pro/${shortCode}`,
        shortCode: shortCode
      }
    });
    
  } catch (error) {
    console.error('Error creating link:', error);
    res.status(500).json({ error: 'Failed to create link' });
  }
});

// ENDPOINT: Redirect and track click
app.get('/:shortCode', async (req, res) => {
  try {
    const { shortCode } = req.params;
    const prospectName = req.query.p || null; // Capture ?p=Jean_Dupont parameter
    
    // Get link info
    const { data: link, error: linkError } = await supabase
      .from('links')
      .select('*')
      .eq('short_code', shortCode)
      .single();
    
    if (linkError || !link) {
      return res.status(404).send('Link not found');
    }
    
    // Extract tracking data
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
    const userAgent = req.headers['user-agent'];
    const referrer = req.headers['referer'] || 'direct';
    
    const deviceInfo = extractDeviceInfo(userAgent);
    const geoInfo = getGeolocation(ip);
    
    // Generate session ID (simple version - in production use cookies)
    const sessionId = req.headers['x-session-id'] || `${ip}-${Date.now()}`;
    
    // Get previous clicks to determine visit number
    const { data: previousClicks } = await supabase
      .from('clicks')
      .select('*')
      .eq('link_id', link.id)
      .eq('ip_address', ip)
      .order('timestamp', { ascending: false });
    
    const visitNumber = (previousClicks?.length || 0) + 1;
    
    // Insert click record
    const { error: clickError } = await supabase
      .from('clicks')
      .insert({
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
        referrer: referrer,
        user_agent: userAgent,
        session_id: sessionId,
        visit_number: visitNumber,
        prospect_name: prospectName, // Store prospect name from ?p= parameter
        duration: 0 // Will be updated on page unload
      });
    
    if (clickError) throw clickError;
    
    // Serve tracking page that redirects and tracks duration
    const trackingHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta http-equiv="refresh" content="0;url=${link.original_url}">
          <title>Redirection...</title>
          <script>
            let startTime = Date.now();
            
            // Track duration on page unload
            window.addEventListener('beforeunload', () => {
              const duration = Math.floor((Date.now() - startTime) / 1000);
              
              // Send duration update
              navigator.sendBeacon('/api/track/duration', JSON.stringify({
                linkId: '${link.id}',
                sessionId: '${sessionId}',
                duration: duration
              }));
            });
            
            // Track page visibility changes (tab switches)
            document.addEventListener('visibilitychange', () => {
              if (document.hidden) {
                const duration = Math.floor((Date.now() - startTime) / 1000);
                
                fetch('/api/track/duration', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    linkId: '${link.id}',
                    sessionId: '${sessionId}',
                    duration: duration
                  })
                }).catch(() => {});
              }
            });
            
            // Redirect immediately
            window.location.href = '${link.original_url}';
          </script>
        </head>
        <body>
          <p>Redirection en cours...</p>
        </body>
      </html>
    `;
    
    res.send(trackingHtml);
    
  } catch (error) {
    console.error('Error tracking click:', error);
    res.status(500).send('Error processing request');
  }
});

// ENDPOINT: Update click duration
app.post('/api/track/duration', async (req, res) => {
  try {
    const { linkId, sessionId, duration } = req.body;
    
    // Update the most recent click for this session
    const { error } = await supabase
      .from('clicks')
      .update({ duration: duration })
      .eq('link_id', linkId)
      .eq('session_id', sessionId)
      .order('timestamp', { ascending: false })
      .limit(1);
    
    if (error) throw error;
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Error updating duration:', error);
    res.status(500).json({ error: 'Failed to update duration' });
  }
});

// ENDPOINT: Get analytics for a link
app.get('/api/links/:linkId/analytics', async (req, res) => {
  try {
    const { linkId } = req.params;
    
    // Get all clicks for this link
    const { data: clicks, error } = await supabase
      .from('clicks')
      .select('*')
      .eq('link_id', linkId)
      .order('timestamp', { ascending: false });
    
    if (error) throw error;
    
    // Calculate intent score
    const intentScore = calculateIntentScore(clicks);
    
    // Aggregate stats
    const stats = {
      totalClicks: clicks.length,
      uniqueVisitors: new Set(clicks.map(c => c.ip_address)).size,
      avgDuration: clicks.reduce((sum, c) => sum + c.duration, 0) / clicks.length,
      intentScore: intentScore,
      deviceBreakdown: {
        mobile: clicks.filter(c => c.device_type === 'mobile').length,
        desktop: clicks.filter(c => c.device_type === 'desktop').length,
        tablet: clicks.filter(c => c.device_type === 'tablet').length
      },
      topCountries: [...new Set(clicks.map(c => c.country))]
        .map(country => ({
          country,
          count: clicks.filter(c => c.country === country).length
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
      clicks: clicks
    };
    
    res.json({ success: true, analytics: stats });
    
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// ENDPOINT: Get all links for a user
app.get('/api/users/:userId/links', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Get all links
    const { data: links, error: linksError } = await supabase
      .from('links')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    
    if (linksError) throw linksError;
    
    // Get click counts and intent scores for each link
    const linksWithStats = await Promise.all(
      links.map(async (link) => {
        const { data: clicks } = await supabase
          .from('clicks')
          .select('*')
          .eq('link_id', link.id);
        
        const intentScore = calculateIntentScore(clicks);
        
        return {
          ...link,
          clickCount: clicks?.length || 0,
          intentScore: intentScore,
          trackableUrl: `https://reveal.pro/${link.short_code}`
        };
      })
    );
    
    res.json({ success: true, links: linksWithStats });
    
  } catch (error) {
    console.error('Error fetching links:', error);
    res.status(500).json({ error: 'Failed to fetch links' });
  }
});

// ENDPOINT: Check for hot leads (for email alerts)
app.get('/api/users/:userId/hot-leads', async (req, res) => {
  try {
    const { userId } = req.params;
    const { threshold = 70 } = req.query; // Default hot threshold
    
    // Get all links for user
    const { data: links } = await supabase
      .from('links')
      .select('*')
      .eq('user_id', userId);
    
    const hotLeads = [];
    
    for (const link of links) {
      const { data: clicks } = await supabase
        .from('clicks')
        .select('*')
        .eq('link_id', link.id)
        .gte('timestamp', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()); // Last 24h
      
      const intentScore = calculateIntentScore(clicks);
      
      if (intentScore >= threshold) {
        hotLeads.push({
          link: link,
          intentScore: intentScore,
          recentClicks: clicks.length,
          lastClick: clicks[0]?.timestamp
        });
      }
    }
    
    res.json({ success: true, hotLeads });
    
  } catch (error) {
    console.error('Error fetching hot leads:', error);
    res.status(500).json({ error: 'Failed to fetch hot leads' });
  }
});

// ENDPOINT: Test email alert (for manual testing)
app.get('/api/test-alert/:linkId', async (req, res) => {
  try {
    const { linkId } = req.params;
    const testEmail = 'matthieubaloche@hotmail.fr';
    
    // Get link info
    const { data: link, error: linkError } = await supabase
      .from('links')
      .select('*')
      .eq('id', linkId)
      .single();
    
    if (linkError || !link) {
      return res.status(404).json({ error: 'Link not found' });
    }
    
    // Get user info
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('id', link.user_id)
      .single();
    
    // Get all clicks for this link
    const { data: clicks } = await supabase
      .from('clicks')
      .select('*')
      .eq('link_id', linkId)
      .order('timestamp', { ascending: false });
    
    if (!clicks || clicks.length === 0) {
      return res.json({ 
        success: false, 
        message: 'No clicks found for this link. Click on the link first to generate data.' 
      });
    }
    
    const intentScore = calculateIntentScore(clicks);
    const latestClick = clicks[0];
    const avgDuration = Math.round(clicks.reduce((sum, c) => sum + c.duration, 0) / clicks.length / 60);
    const uniqueDevices = new Set(clicks.map(c => c.device_type)).size;
    
    // Determine intent label
    let intentLabel, intentEmoji, intentColor;
    if (intentScore >= 70) {
      intentLabel = 'CHAUD';
      intentEmoji = '🔥';
      intentColor = '#dc2626';
    } else if (intentScore >= 40) {
      intentLabel = 'TIÈDE';
      intentEmoji = '🟠';
      intentColor = '#f97316';
    } else {
      intentLabel = 'FROID';
      intentEmoji = '❄️';
      intentColor = '#3b82f6';
    }
    
    // Send email
    const emailResult = await resend.emails.send({
      from: 'Reveal Pro <onboarding@resend.dev>',
      to: testEmail,
      subject: `${intentEmoji} PROSPECT ${intentLabel} : ${link.name}`,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                line-height: 1.6;
                color: #333;
                max-width: 600px;
                margin: 0 auto;
                padding: 20px;
              }
              .header {
                background: linear-gradient(135deg, #0A0A0A 0%, #1a1a1a 100%);
                padding: 30px;
                border-radius: 12px 12px 0 0;
                text-align: center;
                color: white;
              }
              .logo {
                font-size: 28px;
                font-weight: bold;
                margin-bottom: 10px;
              }
              .alert-badge {
                display: inline-block;
                background: ${intentColor};
                color: white;
                padding: 10px 20px;
                border-radius: 25px;
                font-weight: bold;
                font-size: 18px;
                margin: 15px 0;
              }
              .content {
                background: white;
                padding: 30px;
                border: 2px solid #e5e5e5;
                border-top: none;
              }
              .property-name {
                font-size: 24px;
                font-weight: bold;
                color: #0A0A0A;
                margin-bottom: 20px;
              }
              .stats-grid {
                display: grid;
                grid-template-columns: repeat(3, 1fr);
                gap: 15px;
                margin: 25px 0;
              }
              .stat {
                text-align: center;
                padding: 15px;
                background: #f9fafb;
                border-radius: 8px;
              }
              .stat-value {
                font-size: 28px;
                font-weight: bold;
                color: #2D5016;
              }
              .stat-label {
                font-size: 12px;
                color: #666;
                margin-top: 5px;
              }
              .insight {
                background: #fef2f2;
                border-left: 4px solid ${intentColor};
                padding: 20px;
                margin: 20px 0;
                border-radius: 8px;
              }
              .insight-title {
                font-weight: bold;
                color: ${intentColor};
                font-size: 16px;
                margin-bottom: 10px;
              }
              .insight-text {
                color: #7f1d1d;
                font-size: 14px;
                line-height: 1.8;
              }
              .details {
                background: #f9fafb;
                padding: 20px;
                border-radius: 8px;
                margin: 20px 0;
              }
              .detail-row {
                display: flex;
                padding: 10px 0;
                border-bottom: 1px solid #e5e5e5;
              }
              .detail-row:last-child {
                border-bottom: none;
              }
              .detail-label {
                font-weight: 600;
                color: #666;
                width: 150px;
              }
              .detail-value {
                color: #0A0A0A;
              }
              .cta-button {
                display: inline-block;
                background: #2D5016;
                color: white;
                padding: 15px 30px;
                text-decoration: none;
                border-radius: 8px;
                font-weight: bold;
                margin: 20px 0;
              }
              .footer {
                text-align: center;
                padding: 20px;
                color: #999;
                font-size: 12px;
                border-top: 1px solid #e5e5e5;
              }
            </style>
          </head>
          <body>
            <div class="header">
              <div class="logo">Reveal Pro</div>
              <div class="alert-badge">${intentEmoji} ${intentLabel}</div>
            </div>
            
            <div class="content">
              <div class="property-name">${link.name}</div>
              ${latestClick.prospect_name ? `
              <div style="background: #2D5016; color: white; padding: 15px; border-radius: 8px; margin-bottom: 20px; text-align: center;">
                <div style="font-size: 12px; opacity: 0.8; margin-bottom: 5px;">PROSPECT IDENTIFIÉ</div>
                <div style="font-size: 22px; font-weight: bold;">👤 ${latestClick.prospect_name.replace(/_/g, ' ')}</div>
              </div>
              ` : ''}
              
              <div class="stats-grid">
                <div class="stat">
                  <div class="stat-value">${clicks.length}</div>
                  <div class="stat-label">Visites</div>
                </div>
                <div class="stat">
                  <div class="stat-value">${avgDuration}min</div>
                  <div class="stat-label">Durée moy.</div>
                </div>
                <div class="stat">
                  <div class="stat-value">${intentScore}%</div>
                  <div class="stat-label">Score</div>
                </div>
              </div>
              
              <div class="insight">
                <div class="insight-title">🎯 ANALYSE D'INTENTION</div>
                <div class="insight-text">
                  Ce prospect montre des signes d'intérêt <strong>${intentScore >= 70 ? 'très fort' : intentScore >= 40 ? 'modéré' : 'faible'}</strong> :
                  <ul style="margin-top: 10px;">
                    <li><strong>${clicks.length} visites</strong> du dossier</li>
                    <li>Durée moyenne de <strong>${avgDuration} minutes</strong> par visite</li>
                    ${uniqueDevices > 1 ? '<li><strong>Consultation multi-device</strong> détectée</li>' : ''}
                    <li>Dernière visite : <strong>${new Date(latestClick.timestamp).toLocaleString('fr-FR')}</strong></li>
                  </ul>
                  
                  ${intentScore >= 70 ? `
                  <strong style="color: ${intentColor}; font-size: 16px; margin-top: 15px; display: block;">
                    ⚡ RECOMMANDATION : Relancer MAINTENANT
                  </strong>
                  ` : ''}
                </div>
              </div>
              
              <div class="details">
                <div style="font-weight: bold; margin-bottom: 15px;">Détails du dernier clic :</div>
                <div class="detail-row">
                  <span class="detail-label">📍 Localisation</span>
                  <span class="detail-value">${latestClick.city || 'Unknown'}, ${latestClick.country}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">📱 Device</span>
                  <span class="detail-value">${latestClick.device_type} ${latestClick.device_model ? '(' + latestClick.device_model + ')' : ''}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">💻 Système</span>
                  <span class="detail-value">${latestClick.os} ${latestClick.os_version || ''}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">🌐 Navigateur</span>
                  <span class="detail-value">${latestClick.browser} ${latestClick.browser_version || ''}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">🔢 IP</span>
                  <span class="detail-value">${latestClick.ip_address}</span>
                </div>
              </div>
              
              <center>
                <a href="https://reveal-pro-backend.onrender.com/api/links/${link.id}/analytics" class="cta-button">
                  Voir le dashboard complet
                </a>
              </center>
              
              <p style="margin-top: 30px; color: #666; font-size: 14px;">
                💡 <strong>Astuce :</strong> Relancez maintenant pendant que l'intérêt est au maximum. 
                Les prospects qui consultent plusieurs fois ont 3x plus de chances de conclure.
              </p>
            </div>
            
            <div class="footer">
              Email de test envoyé depuis Reveal Pro<br>
              <small>Lien : ${link.short_code}</small>
            </div>
          </body>
        </html>
      `
    });
    
    // Send WhatsApp alert if prospect identified and hot
    let whatsappSent = false;
    if (latestClick.prospect_name && intentScore >= 70) {
      whatsappSent = await sendWhatsAppAlert(
        latestClick.prospect_name,
        link.name,
        intentScore,
        clicks.length
      );
    }
    
    res.json({ 
      success: true, 
      message: `Email envoyé à ${testEmail}`,
      intentScore: intentScore,
      clicks: clicks.length,
      emailId: emailResult.id,
      whatsappSent: whatsappSent
    });
    
  } catch (error) {
    console.error('Error sending test alert:', error);
    res.status(500).json({ error: 'Failed to send test alert', details: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Reveal Pro API running on port ${PORT}`);
});

module.exports = app;
