# Roblox Mobile Model Uploader

Full mobile-first web app to authenticate Roblox users with OAuth 2.0 and upload `.rbxm` models to their inventory without requiring user API keys.

## 1. Configure Roblox Creator Dashboard
1. Go to [create.roblox.com/dashboard/credentials](https://create.roblox.com/dashboard/credentials).
2. Click **OAuth 2.0 Apps** -> **Create App**.
3. Under **Permissions / Scopes**, enable:
   - `openid`
   - `profile`
   - `asset:read`
   - `asset:write`
4. Add your Redirect URI:
   - Local: `http://localhost:3000/oauth/callback`
   - Render: `https://<YOUR-RENDER-APP>.onrender.com/oauth/callback`
5. Copy your **Client ID** and **Client Secret**.

## 2. Deploy to Render
1. Create a new GitHub repo and push all these files.
2. Go to [Render Dashboard](https://dashboard.render.com/) -> **New** -> **Web Service**.
3. Select your repo.
4. Settings:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Under **Environment Variables**, set:
   - `ROBLOX_CLIENT_ID`
   - `ROBLOX_CLIENT_SECRET`
   - `ROBLOX_REDIRECT_URI`
   - `SESSION_SECRET`
