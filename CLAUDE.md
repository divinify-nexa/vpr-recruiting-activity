# VPR Recruiting Activity dashboard

Static index.html + Vercel serverless functions in /api. Data lives in Supabase project uaclfvcirfludhmllnat (tables: vpr_leads, vpr_calls, lead_sessions, ghl_stage_events).

## Rules
- Accuracy over features. Nothing on the dashboard may guess a status; lead_status is set only by /api/ghl-status from GHL pipeline events, or the manual dropdown until that sync is verified.
- Status mapping lives ONLY in derive() in api/ghl-status.js. Never duplicate it.
- Recruited is sticky. Lost/abandoned never downgrades a row.
- Every GHL webhook is logged to ghl_stage_events, matched or not.
- Multi-tenant later (Alabama). Never hard-code a GHL location id outside env vars.
- No ad, link, or form ships without UTMs.
- Targeted edits over full-file rewrites. Do not commit or push unless explicitly told to.
- Ampersands not "and", no em dashes in any user-facing copy.
