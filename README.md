# VPR Recruiting Activity Dashboard

A single-page dashboard showing all-time recruiting **calls** (`vpr_calls`) and
**form leads** (`vpr_leads`) from Supabase. KPI counts on top, clean activity
feeds below. Auto-refreshes every 60s.

## Files
- `index.html` — the dashboard (static, vanilla JS)
- `api/data.js` — serverless function that reads Supabase server-side

The service role key lives only in the function. The browser receives just the
trimmed fields shown on the page — no `call_sid`, no raw payloads, and no
lead email/phone.

## Deploy
1. Push this folder to a new GitHub repo (e.g. `vpr-dashboard`).
2. In Vercel: **Add New → Project → import the repo**. No build settings needed.
3. Add two Environment Variables (same values as the `vpr-landing` project):
   - `SUPABASE_URL` = `https://uaclfvcirfludhmllnat.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` = the service role key (starts with `eyJ`)
4. Deploy. Share the resulting URL with Jamie.

## Notes
- The page is intentionally open (anyone with the URL). `noindex` keeps it out
  of search engines, but it is not access-controlled.
- **To gate it later:** add a `DASHBOARD_PASSWORD` env var and a one-line check
  in `api/data.js` (return 401 unless a matching `?key=` is passed). ~5 min.
- **To show lead email/phone:** add `email,phone` to the leads `select` in
  `api/data.js` and a line in `renderLeads()`.
- **"Answered"** counts calls with Twilio status `completed`. Avg talk time
  averages connected calls with duration > 0.
