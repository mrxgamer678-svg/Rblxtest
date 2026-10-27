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

// In-memory store so large Roblox OAuth tokens never exceed browser 4KB cookie limits
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

// Helper to get exact MIME type required by Roblox Open Cloud Assets API
function getRobloxMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.rbxm' || ext === '.rbxmx') return 'model/x-rbxm';
  if (ext === '.fbx') return 'model/fbx';
  if (ext === '.glb') return 'model/gltf-binary';
  if (ext === '.gltf') return 'model/gltf+json';
  return 'model/x-rbxm';
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

// 2. Redirect to Roblox OAuth 2.0 login (forces consent screen for asset:write)
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

    // Verify granted scopes include asset:write
    console.log('Granted OAuth Scopes:', tokenData.scope);

    // Fetch user info using OpenID endpoint
    const userRes = await fetch('https://apis.roblox.com/oauth/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!userRes.ok) return res.status(500).send('Failed to fetch user profile.');

    const userData = await userRes.json();

    // Generate lightweight session ID and save full token in server memory
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

// 4. Upload Model API endpoint
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

  try {
    const formData = new FormData();

    const requestJson = {
      assetType: 'Model',
      displayName: displayName || filename.replace(/\.[^/.]+$/, ''),
      description: description || 'Uploaded via Mobile Web App',
      creationContext: {
        creator: {
          userId: String(verifiedUserId)
        }
      }
    };

    formData.append('request', JSON.stringify(requestJson));

    const fileBlob = new Blob([req.file.buffer], { type: mimeType });
    formData.append('fileContent', fileBlob, filename);

    const uploadResponse = await fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: formData
    });

    const rawText = await uploadResponse.text();
    let responseBody = {};
    try {
      responseBody = JSON.parse(rawText);
    } catch {
      responseBody = { message: rawText };
    }

    if (!uploadResponse.ok) {
      console.error('Roblox Assets API Error:', uploadResponse.status, responseBody);
      return res.status(uploadResponse.status).json({
        error: `${responseBody.message || 'Upload rejected'} (HTTP ${uploadResponse.status} | Scopes: ${sessionData.scope || 'unknown'})`,
        details: responseBody
      });
    }

    res.json({
      success: true,
      data: responseBody
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed due to server error: ' + err.message });
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
