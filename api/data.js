// Reads vpr_calls and vpr_leads from Supabase server-side.
// The service role key stays here on the server and never reaches the browser.
// The browser only ever receives the trimmed fields selected below.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async function handler(req, res) {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res
      .status(500)
      .json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." });
  }

  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
  };

  // Only pull the fields the dashboard actually shows.
  // Calls: who called, where, did they connect, how long, recruiting status.
  //   call_sid is included as a stable row id for status updates (not PII). No raw_payload.
  // Leads: name + where it came from + when + recruiting status.
  //   id is included as a stable row id for status updates (not PII). No email/phone.
  const callsUrl =
    `${SUPABASE_URL}/rest/v1/vpr_calls` +
    `?select=call_sid,from_caller_name,from_number,from_city,from_state,status,duration_seconds,started_at,lead_status` +
    `&order=started_at.desc&limit=1000`;

  const leadsUrl =
    `${SUPABASE_URL}/rest/v1/vpr_leads` +
    `?select=id,first_name,last_name,source,utm_source,utm_campaign,created_at,lead_status` +
    `&order=created_at.desc&limit=1000`;

  try {
    const [callsRes, leadsRes] = await Promise.all([
      fetch(callsUrl, { headers }),
      fetch(leadsUrl, { headers }),
    ]);

    if (!callsRes.ok || !leadsRes.ok) {
      return res.status(502).json({
        error: "Supabase request failed.",
        detail: `calls ${callsRes.status}, leads ${leadsRes.status}`,
      });
    }

    const calls = await callsRes.json();
    const leads = await leadsRes.json();

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ calls, leads });
  } catch (err) {
    return res
      .status(500)
      .json({ error: "Could not reach Supabase.", detail: String(err) });
  }
};
