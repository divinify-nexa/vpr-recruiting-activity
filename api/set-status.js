// /api/set-status.js — update a lead's or call's recruiting status in Supabase.
// CommonJS, zero-config Vercel. Reuses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
// POST body: { "kind": "lead" | "call", "id": "<row id>", "status": "captured" | "awaiting" | "recruited" }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const STATUSES = ["captured", "awaiting", "recruited"];

// Each intake type maps to its table + the column the dashboard uses as a stable id.
const TABLES = {
  lead: { table: "vpr_leads", idCol: "id" },        // vpr_leads primary key (uuid)
  call: { table: "vpr_calls", idCol: "call_sid" },  // vpr_calls unique Twilio id
};

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body; // already parsed
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res
      .status(500)
      .json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." });
  }

  try {
    const { kind, id, status } = await readJson(req);
    const map = TABLES[kind];

    if (!map) return res.status(400).json({ error: "Invalid kind (expected 'lead' or 'call')" });
    if (!id) return res.status(400).json({ error: "Missing id" });
    if (!STATUSES.includes(status)) return res.status(400).json({ error: "Invalid status" });

    const url =
      `${SUPABASE_URL}/rest/v1/${map.table}` +
      `?${map.idCol}=eq.${encodeURIComponent(id)}`;

    // We update the recruiting column (lead_status), NOT the call's connect status.
    const r = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ lead_status: status }),
    });

    if (!r.ok) {
      const detail = await r.text();
      return res.status(502).json({ error: "Supabase update failed", detail });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
};
