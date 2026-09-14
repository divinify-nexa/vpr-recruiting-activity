// api/ghl-status.js — GHL pipeline movement → dashboard lead_status.
// CommonJS, zero-config Vercel. Deterministic, no inference.
// Every webhook hit is logged to ghl_stage_events, matched or not.

const { createHash } = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET       = process.env.GHL_WEBHOOK_SECRET;
const ALLOWED_LOCATIONS = (process.env.GHL_ALLOWED_LOCATIONS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// MAPPING — the only place status logic lives. Edit here, nowhere else.
// Buckets: new (not in a pipeline) | working (open in either pipeline) | recruited (won).
// The real stage name is carried separately in ghl_stage and shown on the row.
// ---------------------------------------------------------------------------
const PIPELINE_LABELS = { hot: "Hot Urgent Leads", onboarding: "Onboarding" };

function derive(pipelineKey, stageName, oppStatus) {
  const stage  = norm(stageName);
  const status = norm(oppStatus);
  if (!PIPELINE_LABELS[pipelineKey]) return null;        // unknown pipeline → log only
  if (pipelineKey === "onboarding" && (status === "won" || stage === "welcome to vpr")) {
    return "recruited";
  }
  if (status === "lost" || status === "abandoned") return null;  // leave status as is
  return "working";
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function norm(s) { return String(s || "").toLowerCase().replace(/\s+/g, " ").trim(); }
function last10(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
}
function pick(...vals) { for (const v of vals) if (v !== undefined && v !== null && v !== "") return v; return null; }

// Returns { body, raw }. Uses Vercel's parsed body when present, else reads the stream.
async function getBody(req) {
  if (req.body && typeof req.body === "object") return { body: req.body, raw: JSON.stringify(req.body) };
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  const body = JSON.parse(raw);
  return { body, raw: JSON.stringify(body) };
}

async function sb(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${method} ${path} → ${r.status}: ${text}`);
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

// Find rows in one table by contact id, normalized phone, or email (leads only).
async function findRows(table, idCol, { contactId, phone10, email }) {
  const q = [];
  if (contactId) q.push(`ghl_contact_id.eq.${encodeURIComponent(contactId)}`);
  if (phone10)   q.push(`phone_norm.eq.${phone10}`);
  if (email && table === "vpr_leads") q.push(`email.ilike.${encodeURIComponent(email)}`);
  if (!q.length) return [];
  return sb(`${table}?select=${idCol},lead_status,status_override&or=(${q.join(",")})`);
}

// Update one row. lead_status is only written when derived is non-null and the
// row is not already recruited (recruited is sticky).
async function applyRow(table, idCol, row, { contactId, stageText, derived, at }) {
  const patch = { ghl_stage: stageText, ghl_stage_at: at, stage_source: "live" };
  if (contactId) patch.ghl_contact_id = contactId;
  // Manual override wins; recruited is sticky and never downgrades.
  if (derived && !row.status_override && row.lead_status !== "recruited") {
    patch.lead_status = derived;
  }
  await sb(`${table}?${idCol}=eq.${encodeURIComponent(row[idCol])}`, {
    method: "PATCH", body: patch, prefer: "return=minimal",
  });
}

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------
module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!SUPABASE_URL || !SERVICE_KEY || !SECRET || !ALLOWED_LOCATIONS.length) {
    return res.status(500).json({ error: "Endpoint not configured (env vars missing)" });
  }

  const provided = req.headers["x-webhook-secret"] || (req.query && req.query.key);
  if (provided !== SECRET) return res.status(401).json({ error: "Unauthorized" });

  let body, raw;
  try { ({ body, raw } = await getBody(req)); }
  catch { return res.status(400).json({ error: "Body is not JSON" }); }

  const cd = body.customData || body.custom_data || {};
  const locationId = pick(cd.location_id, body.location && body.location.id, body.location_id, body.locationId);
  if (!ALLOWED_LOCATIONS.includes(locationId)) {
    return res.status(403).json({ error: "Unknown location", location_id: locationId });
  }

  try {
    // Idempotency: identical body = duplicate fire.
    const hash = createHash("sha256").update(raw).digest("hex");
    const seen = await sb(`ghl_stage_events?select=id&payload_hash=eq.${hash}&limit=1`);
    if (Array.isArray(seen) && seen.length) return res.status(200).json({ ok: true, duplicate: true });

    // customData (set explicitly in the GHL workflow) wins; GHL's standard fields are the fallback.
    const pipelineKey   = norm(pick(cd.pipeline_key));
    const stageName     = pick(cd.stage_name, body.pipleline_stage, body.pipeline_stage, body.stage_name);
    const oppStatus     = pick(cd.opp_status, body.status, body.opportunity_status);
    const opportunityId = pick(cd.opportunity_id, body.opportunity_id, body.opportunityId);
    const contactId     = pick(cd.contact_id, body.contact_id, body.contactId, body.id);
    const phone         = pick(cd.phone, body.phone);
    const email         = pick(cd.email, body.email);
    const phone10       = last10(phone);
    const emailNorm     = email ? String(email).trim().toLowerCase() : null;

    const derived   = derive(pipelineKey, stageName, oppStatus);
    const at        = new Date().toISOString();
    const statusTag = norm(oppStatus) && norm(oppStatus) !== "open" ? ` (${oppStatus})` : "";
    const stageText = `${PIPELINE_LABELS[pipelineKey] || pipelineKey || "?"} / ${stageName || "?"}${statusTag}`;

    const keys  = { contactId, phone10, email: emailNorm };
    const leads = await findRows("vpr_leads", "id", keys);
    const calls = await findRows("vpr_calls", "call_sid", keys);

    for (const row of leads) await applyRow("vpr_leads", "id", row, { contactId, stageText, derived, at });
    for (const row of calls) await applyRow("vpr_calls", "call_sid", row, { contactId, stageText, derived, at });

    const matchedKind = leads.length ? "lead" : calls.length ? "call" : null;
    const matchedId   = leads.length ? String(leads[0].id) : calls.length ? String(calls[0].call_sid) : null;

    await sb("ghl_stage_events?on_conflict=payload_hash", {
      method: "POST",
      prefer: "return=minimal,resolution=ignore-duplicates",
      body: {
        location_id: locationId,
        contact_id: contactId,
        opportunity_id: opportunityId,
        pipeline_id: pick(cd.pipeline_id, body.pipeline_id),
        pipeline_name: pipelineKey || null,
        stage_id: pick(cd.stage_id, body.pipeline_stage_id),
        stage_name: stageName,
        opp_status: oppStatus,
        contact_phone: phone,
        contact_email: email,
        matched_kind: matchedKind,
        matched_id: matchedId,
        derived_status: derived,
        payload_hash: hash,
        payload: body,
      },
    });

    return res.status(200).json({
      ok: true,
      duplicate: false,
      pipeline_key: pipelineKey || null,
      stage: stageName,
      opp_status: oppStatus,
      derived_status: derived,
      matched: { leads: leads.length, calls: calls.length },
    });
  } catch (e) {
    console.error("ghl-status error:", e);
    return res.status(500).json({ error: String(e.message || e) });
  }
};
