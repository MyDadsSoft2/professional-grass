PROFESSIONAL GRASS - NO NGROK BUILD

This build removes ngrok completely.

Files:
- index.js      Full bot + OAuth callback web server
- package.json  Node dependencies
- render.yaml   Render deployment config

Required environment variables:
BOT_TOKEN
CLIENT_ID
CLIENT_SECRET
OWNER_ID
OAUTH_REDIRECT_URI

After Render gives you a URL such as:
https://professional-grass.onrender.com

Set:
OAUTH_REDIRECT_URI=https://professional-grass.onrender.com/callback

Then add that EXACT same URL in:
Discord Developer Portal -> OAuth2 -> Redirects

IMPORTANT:
Rotate the Discord bot token and Client Secret that were previously exposed.
Do not put secrets directly into these files.
