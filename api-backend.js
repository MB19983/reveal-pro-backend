// Reveal Pro - Backend API PRODUCTION FINAL
// Clean URLs, automatic alerts, production-ready

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

// Supabase setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Utility: Generate short code (clean, professional)
function generateShortCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
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
  if (!geo) return { country: 'Unknown', city: 'Unknown' };
  return { country: geo.country, city: geo.city || 'Unknown' };
}

// Utility: Calculate intent score (optimized for real estate)
function calculateIntentScore(clicks) {
  if (!clicks || clicks.length === 0) return 0;
  
  const totalVisits = clicks.length;
  const avgDuration = clicks.reduce((sum, c) => sum + (c.duration || 0), 0) / clicks.length;
  const uniqueDevices = new Set(clicks.map(c => c.device_type)).size;
  
  let score = 0;
  
  // Visit frequency (most important for real estate)
  if (totalVisits >= 7) score += 70;
  else if (totalVisits >= 5) score += 60;
  else if (totalVisits >= 4) score += 50;
  else if (totalVisits >= 3) score += 40;
  else if (totalVisits >= 2) score += 25;
  else score += 10;
  
  // Duration bonus
  if (avgDuration > 120) score += 25;
  else if (avgDuration > 60) score += 15;
  else if (avgDuration > 30) score += 10;
  else if (avgDuration > 0) score += 5;
  
  // Multi-device bonus (checking from phone AND computer = serious interest)
  if (uniqueDevices > 1) score += 15;
  
  return Math.min(score, 100);
}

// Utility: Send WhatsApp alert to user
async function sendWhatsAppAlert(prospectName, linkName, intentScore, clickCount, userWhatsapp) {
  if (!twilioClient) {
    console.log('Twilio not configured');
    return false;
  }
  
  if (!userWhatsapp) {
    console.log('No WhatsApp number for user');
    return false;
  }
  
  try {
    const prospectClean = prospectName.replace(/_/g, ' ');
    const message = 'ALERTE PROSPECT\n\n' +
      'Prospect: ' + prospectClean + '\n' +
      'Bien: ' + linkName + '\n' +
      'Visites: ' + clickCount + '\n' +
      'Score: ' + intentScore + '%\n\n' +
      'Ce prospect est tres interesse!\n' +
      'Contactez-le maintenant.';

    // Format WhatsApp number
    let whatsappNumber = userWhatsapp.trim();
    if (!whatsappNumber.startsWith('whatsapp:')) {
      whatsappNumber = 'whatsapp:' + whatsappNumber;
    }

    console.log('Sending WhatsApp to: ' + whatsappNumber);

    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: whatsappNumber
    });
    
    console.log('WhatsApp sent successfully');
    return true;
  } catch (error) {
    console.error('WhatsApp error:', error.message);
    return false;
  }
}

// Utility: Send Email alert to user
async function sendEmailAlert(prospectName, linkName, intentScore, clickCount, latestClick, userEmail) {
  if (!userEmail) {
    console.log('No email for user');
    return false;
  }
  
  try {
    const prospectClean = prospectName.replace(/_/g, ' ');
    
    console.log('Sending email to: ' + userEmail);
    
    await resend.emails.send({
      from: 'Alerte Prospect <onboarding@resend.dev>',
      to: userEmail,
      subject: 'Prospect interesse : ' + prospectClean + ' - ' + linkName,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f8f9fa;">
          <div style="background: #1a1a2e; color: white; padding: 25px; text-align: center;">
            <h1 style="margin: 0; font-size: 22px;">Nouveau Prospect Interesse</h1>
          </div>
          <div style="background: white; padding: 25px;">
            <div style="background: #28a745; color: white; padding: 20px; border-radius: 8px; text-align: center; margin-bottom: 20px;">
              <div style="font-size: 14px; opacity: 0.9;">PROSPECT</div>
              <div style="font-size: 26px; font-weight: bold;">${prospectClean}</div>
            </div>
            <h2 style="color: #333; margin: 0 0 15px;">${linkName}</h2>
            <table style="width: 100%; margin: 20px 0;">
              <tr>
                <td style="text-align: center; padding: 15px; background: #f8f9fa; border-radius: 8px;">
                  <div style="font-size: 28px; font-weight: bold; color: #28a745;">${clickCount}</div>
                  <div style="color: #666; font-size: 13px;">Visites</div>
                </td>
                <td style="width: 10px;"></td>
                <td style="text-align: center; padding: 15px; background: #f8f9fa; border-radius: 8px;">
                  <div style="font-size: 28px; font-weight: bold; color: #28a745;">${intentScore}%</div>
                  <div style="color: #666; font-size: 13px;">Interet</div>
                </td>
              </tr>
            </table>
            <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
              <strong style="color: #856404;">Action recommandee</strong>
              <p style="margin: 8px 0 0; color: #856404;">Contactez ce prospect rapidement, son interet est eleve !</p>
            </div>
            <div style="background: #f8f9fa; padding: 12px; border-radius: 6px; font-size: 13px; color: #666;">
              <strong>Derniere activite:</strong><br>
              ${latestClick?.city || 'Inconnu'}, ${latestClick?.country || ''} - ${latestClick?.device_type || ''}<br>
              ${new Date().toLocaleString('fr-FR')}
            </div>
          </div>
        </div>
      `
    });
    
    console.log('Email sent successfully');
    return true;
  } catch (error) {
    console.error('Email error:', error.message);
    return false;
  }
}

// ============ ENDPOINTS ============

// ENDPOINT: Create user
app.post('/api/users/create', async (req, res) => {
  try {
    const { email, name, whatsapp } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email requis' });
    }
    
    // Check if exists
    const { data: existing } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();
    
    if (existing) {
      // Update whatsapp if changed
      if (whatsapp && whatsapp !== existing.whatsapp) {
        await supabase.from('users').update({ whatsapp }).eq('id', existing.id);
        existing.whatsapp = whatsapp;
      }
      return res.json({ success: true, user: existing });
    }
    
    // Create new
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
    console.error('User creation error:', error);
    res.status(500).json({ error: 'Erreur creation utilisateur' });
  }
});

// ENDPOINT: Update user
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
    res.status(500).json({ error: 'Erreur mise a jour' });
  }
});

// ENDPOINT: Create trackable link (CLEAN URL - no visible tracking params)
app.post('/api/links/create', async (req, res) => {
  try {
    const { userId, name, originalUrl, prospectName } = req.body;
    
    if (!userId || !name || !originalUrl) {
      return res.status(400).json({ error: 'Champs requis manquants' });
    }
    
    const shortCode = generateShortCode();
    
    // Store prospect name directly in database (not in URL!)
    const { data, error } = await supabase
      .from('links')
      .insert({
        user_id: userId,
        name: name,
        original_url: originalUrl,
        short_code: shortCode,
        prospect_name: prospectName || null
      })
      .select()
      .single();
    
    if (error) throw error;
    
    // Clean URL without any tracking parameters visible
    const baseUrl = process.env.BASE_URL || 'https://reveal-pro-backend.onrender.com';
    const trackableUrl = baseUrl + '/d/' + shortCode;
    
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
    console.error('Link creation error:', error);
    res.status(500).json({ error: 'Erreur creation lien' });
  }
});

// ENDPOINT: Track click (CLEAN URL: /d/abc123)
app.get('/d/:shortCode', async (req, res) => {
  try {
    const { shortCode } = req.params;
    
    // Get link info
    const { data: link, error: linkError } = await supabase
      .from('links')
      .select('*')
      .eq('short_code', shortCode)
      .single();
    
    if (linkError || !link) {
      return res.status(404).send('Page non trouvee');
    }
    
    // Prospect name is stored in database, not visible in URL
    const prospectName = link.prospect_name;
    
    // Extract tracking data
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
    const userAgent = req.headers['user-agent'];
    const referrer = req.headers['referer'] || 'direct';
    
    const deviceInfo = extractDeviceInfo(userAgent);
    const geoInfo = getGeolocation(ip);
    const sessionId = ip + '-' + Date.now();
    
    // Get previous clicks
    const { data: previousClicks } = await supabase
      .from('clicks')
      .select('*')
      .eq('link_id', link.id)
      .eq('ip_address', ip);
    
    const visitNumber = (previousClicks?.length || 0) + 1;
    
    // Insert click
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
      referrer: referrer,
      user_agent: userAgent,
      session_id: sessionId,
      visit_number: visitNumber,
      prospect_name: prospectName,
      duration: 0
    });
    
    // AUTO-ALERT SYSTEM (runs async, doesn't block redirect)
    setImmediate(async () => {
      try {
        // Get all clicks
        const { data: allClicks } = await supabase
          .from('clicks')
          .select('*')
          .eq('link_id', link.id)
          .order('timestamp', { ascending: false });
        
        const intentScore = calculateIntentScore(allClicks);
        
        console.log('Click recorded - Link: ' + shortCode + ', Clicks: ' + allClicks.length + ', Score: ' + intentScore + '%');
        
        // Check if HOT (>= 70%)
        if (intentScore >= 70 && prospectName) {
          
          // Check if alert already sent in last 24h
          const { data: recentAlerts } = await supabase
            .from('alerts_sent')
            .select('*')
            .eq('link_id', link.id)
            .gte('sent_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
          
          if (!recentAlerts || recentAlerts.length === 0) {
            console.log('=== HOT PROSPECT DETECTED ===');
            console.log('Prospect: ' + prospectName);
            console.log('Score: ' + intentScore + '%');
            
            // Get user info
            const { data: user } = await supabase
              .from('users')
              .select('*')
              .eq('id', link.user_id)
              .single();
            
            console.log('User found:', user ? user.email : 'NOT FOUND');
            console.log('User WhatsApp:', user?.whatsapp || 'NOT SET');
            
            if (user) {
              const latestClick = allClicks[0];
              
              // Send Email
              if (user.email) {
                const emailSent = await sendEmailAlert(
                  prospectName, 
                  link.name, 
                  intentScore, 
                  allClicks.length, 
                  latestClick, 
                  user.email
                );
                console.log('Email result:', emailSent);
              }
              
              // Send WhatsApp
              if (user.whatsapp) {
                const whatsappSent = await sendWhatsAppAlert(
                  prospectName, 
                  link.name, 
                  intentScore, 
                  allClicks.length, 
                  user.whatsapp
                );
                console.log('WhatsApp result:', whatsappSent);
              }
              
              // Record alert
              await supabase.from('alerts_sent').insert({
                user_id: link.user_id,
                link_id: link.id,
                intent_score: intentScore
              });
              
              console.log('Alert recorded in database');
            }
          } else {
            console.log('Alert already sent in last 24h');
          }
        }
      } catch (alertError) {
        console.error('Alert error:', alertError);
      }
    });
    
    // Redirect to original URL (clean, instant)
    res.redirect(302, link.original_url);
    
  } catch (error) {
    console.error('Click tracking error:', error);
    res.status(500).send('Erreur');
  }
});

// ENDPOINT: Update duration (beacon)
app.post('/api/track/duration', express.text({ type: '*/*' }), async (req, res) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { linkId, sessionId, duration } = body;
    
    if (linkId && sessionId && duration !== undefined) {
      await supabase
        .from('clicks')
        .update({ duration: duration })
        .eq('link_id', linkId)
        .eq('session_id', sessionId);
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed' });
  }
});

// ENDPOINT: Get link analytics
app.get('/api/links/:linkId/analytics', async (req, res) => {
  try {
    const { linkId } = req.params;
    
    const { data: link } = await supabase
      .from('links')
      .select('*')
      .eq('id', linkId)
      .single();
    
    if (!link) return res.status(404).json({ error: 'Lien non trouve' });
    
    const { data: clicks } = await supabase
      .from('clicks')
      .select('*')
      .eq('link_id', linkId)
      .order('timestamp', { ascending: false });
    
    const intentScore = calculateIntentScore(clicks);
    
    res.json({
      success: true,
      analytics: {
        link,
        totalClicks: clicks?.length || 0,
        uniqueVisitors: new Set(clicks?.map(c => c.ip_address)).size,
        intentScore,
        recentClicks: clicks?.slice(0, 10) || []
      }
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Erreur' });
  }
});

// ENDPOINT: Get user's links
app.get('/api/users/:userId/links', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const { data: links } = await supabase
      .from('links')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    
    const linksWithStats = await Promise.all((links || []).map(async (link) => {
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
    res.status(500).json({ error: 'Erreur' });
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
          latestClick: clicks?.[0]
        });
      }
    }
    
    res.json({ success: true, hotLeads: hotLeads.sort((a, b) => b.intentScore - a.intentScore) });
    
  } catch (error) {
    res.status(500).json({ error: 'Erreur' });
  }
});

// ENDPOINT: Manual test alert
app.get('/api/test-alert/:linkId', async (req, res) => {
  try {
    const { linkId } = req.params;
    
    const { data: link } = await supabase
      .from('links')
      .select('*')
      .eq('id', linkId)
      .single();
    
    if (!link) return res.status(404).json({ error: 'Lien non trouve' });
    
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
    const prospectName = link.prospect_name || clicks?.[0]?.prospect_name || 'Test';
    
    let emailSent = false;
    let whatsappSent = false;
    
    if (user?.email) {
      emailSent = await sendEmailAlert(prospectName, link.name, intentScore, clicks?.length || 0, clicks?.[0], user.email);
    }
    
    if (user?.whatsapp) {
      whatsappSent = await sendWhatsAppAlert(prospectName, link.name, intentScore, clicks?.length || 0, user.whatsapp);
    }
    
    res.json({ 
      success: true,
      user: user ? { email: user.email, whatsapp: user.whatsapp } : null,
      emailSent,
      whatsappSent,
      intentScore,
      clicks: clicks?.length || 0
    });
    
  } catch (error) {
    console.error('Test alert error:', error);
    res.status(500).json({ error: 'Erreur', details: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Legacy support: old URL format
app.get('/:shortCode', async (req, res) => {
  // Redirect old format to new format
  res.redirect(301, '/d/' + req.params.shortCode);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('API running on port ' + PORT);
});
