const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const app = express();
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } }); // 20 MB max

const cleanEnv = (val) => (val || '').trim().replace(/[\r\n\t]+/g, '');

const CLIENT_ID = cleanEnv(process.env.ROBLOX_CLIENT_ID);
const CLIENT_SECRET = cleanEnv(process.env.ROBLOX_CLIENT_SECRET);
const REDIRECT_URI = cleanEnv(process.env.ROBLOX_REDIRECT_URI);

const SCOPES = 'openid profile asset:read asset:write';

const sessionStore = new Map();

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  cookieSession({
    name: 'rbx_sid',
    keys: [cleanEnv(process.env.SESSION_SECRET) || 'roblox_secret_key_999'],
    maxAge: 24 * 60 * 60 * 1000
  })
);

function getRobloxMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.rbxm' || ext === '.rbxmx') return 'model/x-rbxm';
  if (ext === '.fbx') return 'model/fbx';
  if (ext === '.glb') return 'model/gltf-binary';
  if (ext === '.gltf') return 'model/gltf+json';
  return 'model/x-rbxm';
}

// Build raw multipart/form-data buffer with exact Content-Length for Roblox Open Cloud
function buildRobloxMultipart(jsonString, fileBuffer, filename, fileMime) {
  const boundary = '----RobloxOpenCloudBoundary' + crypto.randomBytes(8).toString('hex');
  const crlf = '\r\n';

  const part1Header = Buffer.from(
    `--${boundary}${crlf}` +
    `Content-Disposition: form-data; name="request"${crlf}` +
    `Content-Type: application/json${crlf}${crlf}` +
    `${jsonString}${crlf}`,
    'utf-8'
  );

  const part2Header = Buffer.from(
    `--${boundary}${crlf}` +
    `Content-Disposition: form-data; name="fileContent"; filename="${filename}"${crlf}` +
    `Content-Type: ${fileMime}${crlf}${crlf}`,
    'utf-8'
  );

  const footer = Buffer.from(`${crlf}--${boundary}--${crlf}`, 'utf-8');

  const bodyBuffer = Buffer.concat([part1Header, part2Header, fileBuffer, footer]);
  return {
    bodyBuffer,
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: bodyBuffer.length
  };
}

// 1. Get current logged-in user status
app.get('/api/user', (req, res) => {
  const sid = req.session?.sid;
  if (!sid || !sessionStore.has(sid)) {
    return res.json({ authenticated: false });
  }
  const data = sessionStore.get(sid);
  res.json({
    authenticated: true,
    user: data.user
  });
});

// 2. Redirect to Roblox OAuth 2.0 login
app.get('/auth/roblox', (req, res) => {
  const authUrl = new URL('https://apis.roblox.com/oauth/v1/authorize');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('prompts', 'login consent');
  res.redirect(authUrl.toString());
});

// 3. OAuth Callback handler
app.get('/oauth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Authorization code missing.');

  try {
    const tokenParams = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code
    });

    const tokenRes = await fetch('https://apis.roblox.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString()
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      return res.status(tokenRes.status).send(`Token exchange error: ${errText}`);
    }

    const tokenData = await tokenRes.json();
    const accessToken = (tokenData.access_token || '').trim();

    const userRes = await fetch('https://apis.roblox.com/oauth/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!userRes.ok) return res.status(500).send('Failed to fetch user profile.');

    const userData = await userRes.json();

    const sid = crypto.randomBytes(16).toString('hex');
    sessionStore.set(sid, {
      accessToken: accessToken,
      scope: tokenData.scope,
      user: {
        userId: String(userData.sub),
        name: userData.name || userData.preferred_username || userData.nickname || 'Roblox User',
        picture: userData.picture || ''
      }
    });

    req.session.sid = sid;
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send('Authentication server error.');
  }
});

// 4. Upload Model API endpoint with 20s timeout protection
app.post('/api/upload-model', upload.single('modelFile'), async (req, res) => {
  const sid = req.session?.sid;
  if (!sid || !sessionStore.has(sid)) {
    return res.status(401).json({ error: 'Session expired. Please tap Log out and Log in again.' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Please select a model file (.rbxm, .glb, .fbx).' });
  }

  const sessionData = sessionStore.get(sid);
  const { displayName, description } = req.body;
  const verifiedUserId = sessionData.user.userId;
  const token = sessionData.accessToken;
  const filename = req.file.originalname || 'model.rbxm';
  const mimeType = getRobloxMimeType(filename);

  const requestJson = JSON.stringify({
    assetType: 'Model',
    displayName: displayName || filename.replace(/\.[^/.]+$/, ''),
    description: description || 'Uploaded via Mobile Web App',
    creationContext: {
      creator: {
        userId: String(verifiedUserId)
      }
    }
  });

  const { bodyBuffer, contentType, contentLength } = buildRobloxMultipart(
    requestJson,
    req.file.buffer,
    filename,
    mimeType
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000); // 20s max timeout

  try {
    console.log(`Uploading ${filename} (${contentLength} bytes, ${mimeType}) for user ${verifiedUserId}...`);

    const uploadResponse = await fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': contentType,
        'Content-Length': String(contentLength)
      },
      body: bodyBuffer,
      signal: controller.signal
    });

    clearTimeout(timeout);

    const rawText = await uploadResponse.text();
    console.log('Roblox Response:', uploadResponse.status, rawText);

    let responseBody = {};
    try {
      responseBody = JSON.parse(rawText);
    } catch {
      responseBody = { message: rawText };
    }

    if (!uploadResponse.ok) {
      return res.status(uploadResponse.status).json({
        error: `${responseBody.message || rawText || 'Upload rejected'} (HTTP ${uploadResponse.status})`,
        details: responseBody
      });
    }

    res.json({
      success: true,
      data: responseBody
    });
  } catch (err) {
    clearTimeout(timeout);
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload request failed: ' + err.message });
  }
});

// 5. Logout
app.get('/auth/logout', (req, res) => {
  const sid = req.session?.sid;
  if (sid) sessionStore.delete(sid);
  req.session = null;
  res.redirect('/');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
