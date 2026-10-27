const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

const app = express();
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } }); // 20 MB max

// Helper function to sanitize environment strings (removes spaces, \r, \n)
const cleanEnv = (val) => (val || '').trim().replace(/[\r\n\t]+/g, '');

const CLIENT_ID = cleanEnv(process.env.ROBLOX_CLIENT_ID);
const CLIENT_SECRET = cleanEnv(process.env.ROBLOX_CLIENT_SECRET);
const REDIRECT_URI = cleanEnv(process.env.ROBLOX_REDIRECT_URI);

// Scopes required for OpenID identity & asset uploads
const SCOPES = 'openid profile asset:read asset:write';

// Trust Render reverse proxy for secure cookies
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  cookieSession({
    name: 'session',
    keys: [cleanEnv(process.env.SESSION_SECRET) || 'roblox_session_secret_key'],
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  })
);

// 1. Get current logged-in user status
app.get('/api/user', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ authenticated: false });
  }
  res.json({
    authenticated: true,
    user: req.session.user
  });
});

// 2. Redirect to Roblox OAuth 2.0 login
app.get('/auth/roblox', (req, res) => {
  const authUrl = new URL('https://apis.roblox.com/oauth/v1/authorize');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES);
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
      return res.status(tokenRes.status).send(`Token error: ${errText}`);
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // Fetch user info using OpenID endpoint to acquire correct 'sub' (Roblox User ID)
    const userRes = await fetch('https://apis.roblox.com/oauth/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!userRes.ok) return res.status(500).send('Failed to fetch user profile.');

    const userData = await userRes.json();

    // Store token and verified user ID in secure session
    req.session.accessToken = accessToken;
    req.session.user = {
      userId: userData.sub,
      name: userData.name || userData.preferred_username || userData.nickname,
      picture: userData.picture
    };

    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send('Authentication server error.');
  }
});

// 4. Upload Model API endpoint
app.post('/api/upload-model', upload.single('modelFile'), async (req, res) => {
  if (!req.session || !req.session.accessToken || !req.session.user) {
    return res.status(401).json({ error: 'Please log in with Roblox first.' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Please choose an .rbxm model file to upload.' });
  }

  const { displayName, description } = req.body;
  const verifiedUserId = req.session.user.userId;

  try {
    const formData = new FormData();

    const requestJson = {
      assetType: 'Model',
      displayName: displayName || req.file.originalname.replace(/\.[^/.]+$/, ''),
      description: description || 'Uploaded via Mobile Web App',
      creationContext: {
        creator: {
          userId: String(verifiedUserId)
        }
      }
    };

    formData.append('request', JSON.stringify(requestJson));

    const fileBlob = new Blob([req.file.buffer], { type: 'application/octet-stream' });
    formData.append('fileContent', fileBlob, req.file.originalname || 'model.rbxm');

    const uploadResponse = await fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${req.session.accessToken}`
      },
      body: formData
    });

    const responseBody = await uploadResponse.json();

    if (!uploadResponse.ok) {
      console.error('Roblox API Error:', responseBody);
      return res.status(uploadResponse.status).json({
        error: responseBody.message || 'Roblox rejected the upload.',
        details: responseBody
      });
    }

    res.json({
      success: true,
      message: 'Model uploaded successfully to your Roblox inventory!',
      data: responseBody
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed due to server error.' });
  }
});

// 5. Logout
app.get('/auth/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
