// api/lead-history.js — stage history for one lead, plus the non-attributed
// recruit count. Read-only. CommonJS.
//   GET /api/lead-history?contact_id=<ghl contact id>   → that contact's events
//   GET /api/lead-history?summary=1                     → unattributed recruit tally

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

module.exports = async function handler(req, res) {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Missing Supabase env vars." });
  }
  res.setHeader("Cache-Control", "no-store");

  try {
    // Summary: recruits GHL has recorded that did NOT match a lead row.
    // Only counts events logged since the sync went live, so the caller can
    // date-stamp it honestly rather than implying an all-time total.
    if (req.query.summary) {
      const rows = await sb(
        "ghl_stage_events" +
        "?select=contact_id,received_at" +
        "&derived_status=eq.recruited&matched_kind=is.null"
      );
      const ids = new Set(rows.map((r) => r.contact_id).filter(Boolean));
      const since = rows.reduce(
        (min, r) => (!min || r.received_at < min ? r.received_at : min),
        null
      );
      return res.status(200).json({ unattributed_recruits: ids.size, since });
    }

    const contactId = req.query.contact_id;
    if (!contactId) return res.status(400).json({ error: "contact_id required" });

    const events = await sb(
      "ghl_stage_events" +
      `?select=received_at,stage_name,opp_status,derived_status` +
      `&contact_id=eq.${encodeURIComponent(contactId)}` +
      "&order=received_at.asc&limit=100"
    );
    return res.status(200).json({ events });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
