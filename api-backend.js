// Reveal Pro - Backend API FINAL
// Production-ready version

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const useragent = require('useragent');
const geoip = require('geoip-lite');
const { Resend } = require('resend');
const twilio = require('twilio');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// Resend setup for email alerts
const resend = new Resend(process.env.RESEND_API_KEY);

// Twilio setup for WhatsApp alerts
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN 
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// Supabase setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Secret key for encoding prospect names (simple obfuscation)
const ENCODE_SECRET = process.env.ENCODE_SECRET || 'reveal-pro-2024';

// Utility: Generate short code
function generateShortCode() {
  return Math.random().toString(36).substring(2, 8);
}

// Utility: Encode prospect name to hide it in URL
function encodeProspectName(name) {
  if (!name) return '';
  const encoded = Buffer.from(name + '|' + Date.now()).toString('base64');
  return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Utility: Decode prospect name from URL parameter
function decodeProspectName(encoded) {
  if (!encoded) return null;
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(base64, 'base64').toString('utf8');
    const [name] = decoded.split('|');
    return name;
  } catch (e) {
    return encoded; // Fallback to raw value if decoding fails
  }
}

// Utility: Extract device info
function extractDeviceInfo(userAgentString) {
  const agent = useragent.parse(userAgentString);
  return {
    deviceType: agent.device.family === 'Other' ? 
                (userAgentString.toLowerCase().includes('mobile') ? 'mobile' : 'desktop') :
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

// Utility: Calculate intent score (IMPROVED - easier to reach 70%)
function calculateIntentScore(clicks) {
  if (!clicks || clicks.length === 0) return 0;
  
  const totalVisits = clicks.length;
  const avgDuration = clicks.reduce((sum, c) => sum + (c.duration || 0), 0) / clicks.length;
  const uniqueDevices = new Set(clicks.map(c => c.device_type)).size;
  const uniqueIPs = new Set(clicks.map(c => c.ip_address)).size;
  
  let score = 0;
  
  // Visit frequency scoring (more generous)
  if (totalVisits >= 7) score += 70;
  else if (totalVisits >= 5) score += 60;
  else if (totalVisits >= 4) score += 50;
  else if (totalVisits >= 3) score += 40;
  else if (totalVisits >= 2) score += 25;
  else score += 10;
  
  // Duration scoring
  if (avgDuration > 180) score += 30;
  else if (avgDuration > 60) score += 20;
  else if (avgDuration > 30) score += 10;
  else if (avgDuration > 0) score += 5;
  
  // Multi-device bonus
  if (uniqueDevices > 1) score += 15;
  
  // Multiple sessions (different IPs or return visits)
  if (uniqueIPs > 1) score += 10;
  
  return Math.min(score, 100);
}

// Utility: Send WhatsApp alert
async function sendWhatsAppAlert(prospectName, linkName, intentScore, clicks, userWhatsapp) {
  const whatsappTo = userWhatsapp || process.env.WHATSAPP_TO;
  
  if (!twilioClient || !whatsappTo) {
    console.log('WhatsApp not configured');
    return false;
  }
  
  try {
    const prospectClean = prospectName.replace(/_/g, ' ');
    const message = 'PROSPECT CHAUD!\n\n' +
      'Prospect: ' + prospectClean + '\n' +
      'Dossier: ' + linkName + '\n\n' +
      'Statistiques:\n' +
      '- ' + clicks + ' visites\n' +
      '- Score: ' + intentScore + '%\n\n' +
      'Action: Relancer MAINTENANT!\n\n' +
      '-- Reveal Pro';

    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: whatsappTo.startsWith('whatsapp:') ? whatsappTo : 'whatsapp:' + whatsappTo
    });
    
    console.log('WhatsApp sent to ' + whatsappTo);
    return true;
  } catch (error) {
    console.error('WhatsApp error:', error.message);
    return false;
  }
}

// Utility: Send Email alert
async function sendEmailAlert(prospectName, linkName, intentScore, allClicks, latestClick, userEmail) {
  if (!userEmail) {
    console.log('No email configured');
    return false;
  }
  
  try {
    const prospectClean = prospectName.replace(/_/g, ' ');
    
    await resend.emails.send({
      from: 'Reveal Pro <onboarding@resend.dev>',
      to: userEmail,
      subject: 'PROSPECT CHAUD : ' + linkName + ' - ' + prospectClean,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto; background: #f5f5f5; padding: 20px;">
          <div style="background: linear-gradient(135deg, #0A0A0A 0%, #1a1a1a 100%); color: white; padding: 30px; text-align: center; border-radius: 16px 16px 0 0;">
            <h1 style="margin: 0; font-size: 24px;">Prospect Chaud Detecte !</h1>
          </div>
          <div style="background: white; padding: 30px; border-radius: 0 0 16px 16px;">
            <div style="background: #2D5016; color: white; padding: 20px; border-radius: 12px; text-align: center; margin-bottom: 25px;">
              <div style="font-size: 14px; opacity: 0.9; margin-bottom: 5px;">PROSPECT IDENTIFIE</div>
              <div style="font-size: 28px; font-weight: bold;">${prospectClean}</div>
            </div>
            <h2 style="margin: 0 0 20px; color: #333;">${linkName}</h2>
            <div style="display: flex; justify-content: space-around; text-align: center; margin: 25px 0; background: #f9f9f9; padding: 20px; border-radius: 12px;">
              <div>
                <div style="font-size: 32px; font-weight: bold; color: #2D5016;">${allClicks.length}</div>
                <div style="color: #666; font-size: 14px;">Visites</div>
              </div>
              <div>
                <div style="font-size: 32px; font-weight: bold; color: #2D5016;">${intentScore}%</div>
                <div style="color: #666; font-size: 14px;">Score</div>
              </div>
            </div>
            <div style="background: #fef2f2; border-left: 4px solid #dc2626; padding: 15px 20px; margin: 20px 0; border-radius: 8px;">
              <strong style="color: #dc2626; font-size: 16px;">RECOMMANDATION</strong>
              <p style="margin: 10px 0 0; color: #7f1d1d;">Relancez MAINTENANT pendant que l'interet est au maximum !</p>
            </div>
            <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; font-size: 14px; color: #666;">
              <strong style="color: #333;">Dernier clic :</strong><br>
              Localisation: ${latestClick?.city || 'Inconnu'}, ${latestClick?.country || 'Inconnu'}<br>
              Appareil: ${latestClick?.device_type || 'Inconnu'} - ${latestClick?.browser || 'Inconnu'}<br>
              Date: ${new Date().toLocaleString('fr-FR')}
            </div>
          </div>
          <p style="text-align: center; color: #999; font-size: 12px; margin-top: 20px;">
            Envoye par Reveal Pro
          </p>
        </div>
      `
    });
    
    console.log('Email sent to ' + userEmail);
    return true;
  } catch (error) {
    console.error('Email error:', error.message);
    return false;
  }
}

// ENDPOINT: Create a new user
app.post('/api/users/create', async (req, res) => {
  try {
    const { email, name, whatsapp } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    // Check if user already exists
    const { data: existingUser } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();
    
    if (existingUser) {
      // Update whatsapp if provided
      if (whatsapp && whatsapp !== existingUser.whatsapp) {
        await supabase
          .from('users')
          .update({ whatsapp: whatsapp })
          .eq('id', existingUser.id);
        existingUser.whatsapp = whatsapp;
      }
      return res.json({ success: true, user: existingUser, message: 'User already exists' });
    }
    
    // Create new user
    const { data, error } = await supabase
      .from('users')
      .insert({
        email: email,
        name: name || email.split('@')[0],
        plan: 'free',
        whatsapp: whatsapp || null
      })
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ success: true, user: data });
    
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// ENDPOINT: Update user settings
app.put('/api/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { email, whatsapp } = req.body;
    
    const updates = {};
    if (email) updates.email = email;
    if (whatsapp !== undefined) updates.whatsapp = whatsapp;
    
    const { data, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', userId)
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ success: true, user: data });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// ENDPOINT: Encode prospect name (for generating hidden URLs)
app.post('/api/encode-prospect', (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }
  const encoded = encodeProspectName(name);
  res.json({ success: true, encoded });
});

// ENDPOINT: Create a new trackable link
app.post('/api/links/create', async (req, res) => {
  try {
    const { userId, name, originalUrl, prospectName } = req.body;
    
    if (!userId || !name || !originalUrl) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const shortCode = generateShortCode();
    
    // Encode prospect name if provided
    const encodedProspect = prospectName ? encodeProspectName(prospectName) : null;
    
    // Insert into database
    const { data, error } = await supabase
      .from('links')
      .insert({
        user_id: userId,
        name: name,
        original_url: originalUrl,
        short_code: shortCode,
        prospect_name: prospectName || null // Store original name in DB
      })
      .select()
      .single();
    
    if (error) throw error;
    
    // Build trackable URL with encoded prospect (hidden from user)
    const baseUrl = process.env.BASE_URL || 'https://reveal-pro-backend.onrender.com';
    const trackableUrl = encodedProspect 
      ? `${baseUrl}/${shortCode}?t=${encodedProspect}`
      : `${baseUrl}/${shortCode}`;
    
    res.json({
      success: true,
      link: {
        id: data.id,
        name: data.name,
        trackableUrl: trackableUrl,
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
    
    // Support both ?p= (old) and ?t= (new encoded) parameters
    const encodedProspect = req.query.t || null;
    const rawProspect = req.query.p || null;
    const prospectName = encodedProspect ? decodeProspectName(encodedProspect) : rawProspect;
    
    // Get link info
    const { data: link, error: linkError } = await supabase
      .from('links')
      .select('*')
      .eq('short_code', shortCode)
      .single();
    
    if (linkError || !link) {
      return res.status(404).send('Link not found');
    }
    
    // Use prospect name from link if not in URL
    const finalProspectName = prospectName || link.prospect_name;
    
    // Extract tracking data
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
    const userAgent = req.headers['user-agent'];
    const referrer = req.headers['referer'] || 'direct';
    
    const deviceInfo = extractDeviceInfo(userAgent);
    const geoInfo = getGeolocation(ip);
    
    const sessionId = req.headers['x-session-id'] || `${ip}-${Date.now()}`;
    
    // Get previous clicks
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
        prospect_name: finalProspectName,
        duration: 0
      });
    
    if (clickError) throw clickError;
    
    // AUTO-ALERT: Check if prospect is HOT and send alerts
    (async () => {
      try {
        // Get all clicks for this link
        const { data: allClicks } = await supabase
          .from('clicks')
          .select('*')
          .eq('link_id', link.id)
          .order('timestamp', { ascending: false });
        
        const intentScore = calculateIntentScore(allClicks);
        
        console.log('Link ' + shortCode + ': ' + allClicks.length + ' clicks, score: ' + intentScore + '%');
        
        // Alert if score >= 70 AND prospect has a name
        if (intentScore >= 70 && finalProspectName) {
          // Check if we already sent an alert recently (last 24h)
          const { data: recentAlerts } = await supabase
            .from('alerts_sent')
            .select('*')
            .eq('link_id', link.id)
            .gte('sent_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
          
          if (!recentAlerts || recentAlerts.length === 0) {
            console.log('HOT PROSPECT DETECTED: ' + finalProspectName + ' - Score: ' + intentScore + '%');
            
            // Get user info (email and whatsapp)
            const { data: user } = await supabase
              .from('users')
              .select('*')
              .eq('id', link.user_id)
              .single();
            
            const userEmail = user?.email;
            const userWhatsapp = user?.whatsapp;
            const latestClick = allClicks[0];
            
            // Send alerts to USER's configured email/whatsapp
            if (userEmail) {
              await sendEmailAlert(finalProspectName, link.name, intentScore, allClicks, latestClick, userEmail);
            }
            
            if (userWhatsapp) {
              await sendWhatsAppAlert(finalProspectName, link.name, intentScore, allClicks.length, userWhatsapp);
            }
            
            // Record alert sent
            await supabase
              .from('alerts_sent')
              .insert({
                user_id: link.user_id,
                link_id: link.id,
                intent_score: intentScore
              });
              
            console.log('Alerts sent for ' + finalProspectName);
          } else {
            console.log('Alert already sent in last 24h for this link');
          }
        }
      } catch (alertError) {
        console.error('Auto-alert error:', alertError);
      }
    })();
    
    // Serve tracking page that redirects
    const trackingHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta http-equiv="refresh" content="0;url=${link.original_url}">
          <title>Redirection...</title>
          <script>
            let startTime = Date.now();
            
            window.addEventListener('beforeunload', () => {
              const duration = Math.floor((Date.now() - startTime) / 1000);
              navigator.sendBeacon('/api/track/duration', JSON.stringify({
                linkId: '${link.id}',
                sessionId: '${sessionId}',
                duration: duration
              }));
            });
            
            document.addEventListener('visibilitychange', () => {
              if (document.visibilityState === 'hidden') {
                const duration = Math.floor((Date.now() - startTime) / 1000);
                navigator.sendBeacon('/api/track/duration', JSON.stringify({
                  linkId: '${link.id}',
                  sessionId: '${sessionId}',
                  duration: duration
                }));
              }
            });
            
            setTimeout(() => {
              window.location.href = '${link.original_url}';
            }, 100);
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
    res.status(500).send('Error');
  }
});

// ENDPOINT: Update duration
app.post('/api/track/duration', express.text({ type: '*/*' }), async (req, res) => {
  try {
    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    
    const { linkId, sessionId, duration } = body;
    
    if (!linkId || !sessionId || duration === undefined) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    
    const { error } = await supabase
      .from('clicks')
      .update({ duration: duration })
      .eq('link_id', linkId)
      .eq('session_id', sessionId);
    
    if (error) throw error;
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating duration:', error);
    res.status(500).json({ error: 'Failed' });
  }
});

// ENDPOINT: Get analytics for a link
app.get('/api/links/:linkId/analytics', async (req, res) => {
  try {
    const { linkId } = req.params;
    
    const { data: link } = await supabase
      .from('links')
      .select('*')
      .eq('id', linkId)
      .single();
    
    if (!link) {
      return res.status(404).json({ error: 'Link not found' });
    }
    
    const { data: clicks } = await supabase
      .from('clicks')
      .select('*')
      .eq('link_id', linkId)
      .order('timestamp', { ascending: false });
    
    const intentScore = calculateIntentScore(clicks);
    const totalClicks = clicks?.length || 0;
    const uniqueVisitors = new Set(clicks?.map(c => c.ip_address)).size;
    const avgDuration = totalClicks > 0 
      ? Math.round(clicks.reduce((sum, c) => sum + (c.duration || 0), 0) / totalClicks)
      : 0;
    
    const deviceBreakdown = {};
    clicks?.forEach(c => {
      deviceBreakdown[c.device_type] = (deviceBreakdown[c.device_type] || 0) + 1;
    });
    
    const countryBreakdown = {};
    clicks?.forEach(c => {
      countryBreakdown[c.country] = (countryBreakdown[c.country] || 0) + 1;
    });
    
    res.json({
      success: true,
      analytics: {
        link: link,
        totalClicks,
        uniqueVisitors,
        avgDuration,
        intentScore,
        deviceBreakdown,
        countryBreakdown,
        recentClicks: clicks?.slice(0, 10) || []
      }
    });
    
  } catch (error) {
    console.error('Error getting analytics:', error);
    res.status(500).json({ error: 'Failed' });
  }
});

// ENDPOINT: Get all links for a user
app.get('/api/users/:userId/links', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const { data: links, error } = await supabase
      .from('links')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    // Get click counts and scores for each link
    const linksWithStats = await Promise.all(links.map(async (link) => {
      const { data: clicks } = await supabase
        .from('clicks')
        .select('*')
        .eq('link_id', link.id);
      
      return {
        ...link,
        clickCount: clicks?.length || 0,
        intentScore: calculateIntentScore(clicks)
      };
    }));
    
    res.json({ success: true, links: linksWithStats });
    
  } catch (error) {
    console.error('Error getting links:', error);
    res.status(500).json({ error: 'Failed' });
  }
});

// ENDPOINT: Get hot leads
app.get('/api/users/:userId/hot-leads', async (req, res) => {
  try {
    const { userId } = req.params;
    const threshold = parseInt(req.query.threshold) || 70;
    
    const { data: links } = await supabase
      .from('links')
      .select('*')
      .eq('user_id', userId);
    
    const hotLeads = [];
    
    for (const link of links || []) {
      const { data: clicks } = await supabase
        .from('clicks')
        .select('*')
        .eq('link_id', link.id)
        .order('timestamp', { ascending: false });
      
      const intentScore = calculateIntentScore(clicks);
      
      if (intentScore >= threshold) {
        hotLeads.push({
          link,
          intentScore,
          recentClicks: clicks?.length || 0,
          latestClick: clicks?.[0] || null
        });
      }
    }
    
    hotLeads.sort((a, b) => b.intentScore - a.intentScore);
    
    res.json({ success: true, hotLeads });
    
  } catch (error) {
    console.error('Error getting hot leads:', error);
    res.status(500).json({ error: 'Failed' });
  }
});

// ENDPOINT: Manual test alert (for testing)
app.get('/api/test-alert/:linkId', async (req, res) => {
  try {
    const { linkId } = req.params;
    
    const { data: link } = await supabase
      .from('links')
      .select('*')
      .eq('id', linkId)
      .single();
    
    if (!link) {
      return res.status(404).json({ error: 'Link not found' });
    }
    
    const { data: clicks } = await supabase
      .from('clicks')
      .select('*')
      .eq('link_id', linkId)
      .order('timestamp', { ascending: false });
    
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('id', link.user_id)
      .single();
    
    const intentScore = calculateIntentScore(clicks);
    const latestClick = clicks?.[0];
    const prospectName = latestClick?.prospect_name || link.prospect_name || 'Prospect Test';
    
    const userEmail = user?.email;
    const userWhatsapp = user?.whatsapp;
    
    let emailSent = false;
    let whatsappSent = false;
    
    if (userEmail) {
      emailSent = await sendEmailAlert(prospectName, link.name, intentScore, clicks || [], latestClick, userEmail);
    }
    
    if (userWhatsapp) {
      whatsappSent = await sendWhatsAppAlert(prospectName, link.name, intentScore, clicks?.length || 0, userWhatsapp);
    }
    
    res.json({ 
      success: true, 
      message: 'Test alert sent',
      userEmail: userEmail || 'not configured',
      userWhatsapp: userWhatsapp || 'not configured',
      emailSent,
      whatsappSent,
      intentScore,
      clicks: clicks?.length || 0
    });
    
  } catch (error) {
    console.error('Error sending test alert:', error);
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Reveal Pro API running on port ' + PORT);
});
