// api/ghl-backfill.js — one-time (repeatable) catch-up of current GHL stages.
// Reads every opportunity in the configured pipelines and writes ghl_stage /
// lead_status onto matching vpr_leads rows. Read-only against GHL.
// Protected by the same secret as the webhook.
//   POST /api/ghl-backfill            -> apply changes
//   POST /api/ghl-backfill?dry_run=1  -> report what WOULD change, write nothing

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET       = process.env.GHL_WEBHOOK_SECRET;
const GHL_TOKEN    = process.env.GHL_API_TOKEN;
const LOCATION_ID  = (process.env.GHL_ALLOWED_LOCATIONS || "").split(",")[0].trim();

// Pipelines to walk. Keys must match the derive() keys in ghl-status.js.
const PIPELINES = [
  { key: "hot",        id: "yypl3ySoUyhZ0ykTtvUJ", label: "Hot Urgent Leads" },
  { key: "onboarding", id: "QFPjPcO8W25CqxZPTW58", label: "Onboarding" },
];

function norm(s) { return String(s || "").toLowerCase().replace(/\s+/g, " ").trim(); }
function last10(p) {
  const d = String(p || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
}

// Same rules as the webhook. Kept in sync deliberately; if derive() changes there,
// change it here too.
function derive(pipelineKey, stageName, oppStatus) {
  const stage = norm(stageName), status = norm(oppStatus);
  if (pipelineKey === "onboarding" && (status === "won" || stage === "welcome to vpr")) {
    return "recruited";
  }
  if (status === "lost" || status === "abandoned") return null;
  return "working";
}

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: opts.method || "GET",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.prefer ? { Prefer: opts.prefer } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${t}`);
  return t ? JSON.parse(t) : null;
}

// Walk one pipeline, following GHL's cursor until exhausted.
// Stage id -> stage name, for one pipeline. GHL's opportunity search returns
// pipelineStageId but not the name, so we resolve names from the pipeline definition.
async function fetchStageNames(pipelineId) {
  const r = await fetch(
    `https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${encodeURIComponent(LOCATION_ID)}`,
    { headers: { Authorization: `Bearer ${GHL_TOKEN}`, Version: "2021-07-28", Accept: "application/json" } }
  );
  if (!r.ok) throw new Error(`GHL pipelines ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  const pipeline = (data.pipelines || []).find((p) => p.id === pipelineId);
  const map = {};
  for (const s of (pipeline && pipeline.stages) || []) map[s.id] = s.name;
  return map;
}

async function fetchOpportunities(pipelineId) {
  const out = [];
  let url = `https://services.leadconnectorhq.com/opportunities/search` +
            `?location_id=${encodeURIComponent(LOCATION_ID)}` +
            `&pipeline_id=${encodeURIComponent(pipelineId)}&limit=100`;
  for (let page = 0; page < 25 && url; page++) {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${GHL_TOKEN}`, Version: "2021-07-28", Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`GHL ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const data = await r.json();
    const batch = data.opportunities || [];
    out.push(...batch);
    const next = data.meta && data.meta.nextPageUrl;
    url = batch.length && next ? next : null;
  }
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!SUPABASE_URL || !SERVICE_KEY || !SECRET || !GHL_TOKEN || !LOCATION_ID) {
    return res.status(500).json({ error: "Not configured (env vars missing)" });
  }
  const provided = req.headers["x-webhook-secret"] || (req.query && req.query.key);
  if (provided !== SECRET) return res.status(401).json({ error: "Unauthorized" });

  const dryRun = Boolean(req.query && req.query.dry_run);
  const inspect = Boolean(req.query && req.query.inspect);

  try {
    // Load every lead once; match in memory rather than one query per opportunity.
    const leads = await sb("vpr_leads?select=id,first_name,last_name,email,phone_norm,lead_status,status_override,ghl_contact_id&limit=2000");
    const byPhone = new Map(), byEmail = new Map(), byContact = new Map();
    for (const l of leads) {
      if (l.phone_norm) byPhone.set(l.phone_norm, l);
      if (l.email) byEmail.set(String(l.email).trim().toLowerCase(), l);
      if (l.ghl_contact_id) byContact.set(l.ghl_contact_id, l);
    }

    const now = new Date().toISOString();
    const changes = [], skipped = [];
    let scanned = 0, unmatched = 0;

    for (const p of PIPELINES) {
      const stageNames = await fetchStageNames(p.id);
      const opps = await fetchOpportunities(p.id);
      if (inspect) {
        const o = opps[0] || {};
        return res.status(200).json({
          inspect: true,
          pipeline: p.label,
          opportunity_keys: Object.keys(o).sort(),
          date_like_fields: Object.fromEntries(
            Object.entries(o).filter(([k]) => /date|time|at$|updated|created|moved|status/i.test(k))
          ),
          contact_keys: Object.keys(o.contact || {}).sort(),
        });
      }
      for (const o of opps) {
        scanned++;
        const c = o.contact || {};
        const contactId = o.contactId || c.id;
        const phone10 = last10(c.phone);
        const email = c.email ? String(c.email).trim().toLowerCase() : null;

        const lead = (contactId && byContact.get(contactId)) ||
                     (phone10 && byPhone.get(phone10)) ||
                     (email && byEmail.get(email)) || null;
        if (!lead) { unmatched++; continue; }

        const stageName = o.pipelineStageName ||
                          stageNames[o.pipelineStageId] ||
                          o.pipelineStageId || "?";
        const status = o.status || "open";
        const derived = derive(p.key, stageName, status);
        const statusTag = norm(status) && norm(status) !== "open" ? ` (${status})` : "";
        const stageText = `${p.label} / ${stageName}${statusTag}`;
        // GHL's authoritative stage-change timestamp. Falls back only if absent.
        const movedAt = o.lastStageChangeAt || o.lastStatusChangeAt || null;

        if (lead.status_override) {
          skipped.push({ name: `${lead.first_name || ""} ${lead.last_name || ""}`.trim(), reason: "override" });
          // still record the stage text so the row shows where they are
          changes.push({ id: lead.id, stageText, newStatus: null, movedAt,
                         name: `${lead.first_name || ""} ${lead.last_name || ""}`.trim(),
                         from: lead.lead_status });
          continue;
        }

        const newStatus = (derived && lead.lead_status !== "recruited") ? derived : null;
        changes.push({ id: lead.id, stageText, newStatus, contactId, movedAt,
                       name: `${lead.first_name || ""} ${lead.last_name || ""}`.trim(),
                       from: lead.lead_status });
      }
    }

    if (!dryRun) {
      for (const ch of changes) {
        // stage_source records how we learned this: 'backfill' = read from GHL's
        // current state, 'live' = observed via webhook at the moment it happened.
        const patch = {
          ghl_stage: ch.stageText,
          ghl_stage_at: ch.movedAt || now,
          stage_source: ch.movedAt ? "backfill" : "backfill-approx",
        };
        if (ch.contactId) patch.ghl_contact_id = ch.contactId;
        if (ch.newStatus) patch.lead_status = ch.newStatus;
        await sb(`vpr_leads?id=eq.${encodeURIComponent(ch.id)}`, {
          method: "PATCH", body: patch, prefer: "return=minimal",
        });
      }
    }

    return res.status(200).json({
      dry_run: dryRun,
      opportunities_scanned: scanned,
      matched: changes.length,
      unmatched_in_ghl: unmatched,
      skipped_overrides: skipped.length,
      status_changes: changes.filter((c) => c.newStatus && c.newStatus !== c.from).length,
      sample: changes.slice(0, 8).map((c) => ({ name: c.name, from: c.from, to: c.newStatus || "(stage only)", stage: c.stageText, moved_at: c.movedAt })),
    });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
