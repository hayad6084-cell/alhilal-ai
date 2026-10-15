# الهلال AI — Vercel + Supabase build

## What's included in this build
- Vercel catch-all API adapter (`api/index.js`) and `vercel.json` rewrites, so the existing API routes can run as a Vercel function rather than relying only on a long-running Node listener.
- Supabase-backed persistent storage adapter for users, coin balances, browser bindings, projects, payment requests, and redeem-code records.
- SQL schema in `SUPABASE_SETUP.sql`.
- More conservative session expiry handling: a random 401 from a non-session endpoint no longer clears the user's login.
- A persistent local fallback for `SESSION_SECRET`; production should still use a stable `SESSION_SECRET` environment variable.
- Video generator UI supports 1–4 sequential 10-second scene clips (10–40 seconds total). Clips are currently separate files, not auto-stitched into one MP4.

## Required Vercel Environment Variables
Set these under **Vercel → Project → Settings → Environment Variables** for **Production** (and Preview if you use it):

- `SESSION_SECRET` — a new long random secret; do not reuse a secret that has been shared in chat.
- `SUPABASE_URL` — your project URL, e.g. `https://YOUR_PROJECT_REF.supabase.co`.
- `SUPABASE_SECRET_KEY` — the server-only Supabase secret key (`sb_secret_...`). Do not use `NEXT_PUBLIC_` in this variable name and never expose this key to the browser.
- Existing AI provider variables you actually use: `GEMINI_API_KEY`, `XKIRO_API_KEY`, and whichever video API keys are already configured.

The public browser variables `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` are not enough for this server-side storage adapter. The backend requires `SUPABASE_SECRET_KEY` to write account/coin/project records securely.

## Database setup
1. Open Supabase → SQL Editor.
2. Open `SUPABASE_SETUP.sql` from this package, copy its contents, paste into SQL Editor, and press **Run**.
3. Add `SUPABASE_URL` and `SUPABASE_SECRET_KEY` to Vercel Environment Variables.
4. Set `SESSION_SECRET` to a newly generated value and save.
5. Redeploy the Vercel project after saving environment variables.
6. Open `/api/health` to check that the API responds. Sign in and verify account/coin/project behavior before relying on production data.

## Important limitations to verify before production
- SMS/WhatsApp one-time passwords require a real SMS/WhatsApp provider and credentials; a personal WhatsApp number alone cannot send automated OTPs.
- Vodafone Cash payments in this app are requests for manual review, not an automatic payment gateway.
- Video generation is currently implemented through the existing API routes in `server.mjs`. The requested Magic Hour, Tavus, Runway, and Wan AI provider-specific job flows still need their individual request/status adapters and any provider-specific settings (for example, Tavus replica ID and Wan region/workspace). The presence of environment keys alone does not mean these integrations are fully working.
- Multi-scene generation creates separate 10-second clips. It does not yet merge them into one 20–40 second MP4.
- Keep all secret keys server-side. Never commit `.env` files or secret keys to GitHub.
