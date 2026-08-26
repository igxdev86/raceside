// RACESIDE — Supabase results warehouse helper
// Reads/writes the `results` table. All functions degrade gracefully:
// if env vars are missing or a call fails, readers return null and callers
// fall back to live Racing API paging.

function supa() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ''), key };
}

export async function fetchResultsRange(from, to) {
  const s = supa();
  if (!s) return null;
  const rows = [];
  try {
    for (let offset = 0; offset < 40000; offset += 1000) {
      let r = await fetch(
        `${s.url}/rest/v1/results?date=gte.${from}&date=lte.${to}` +
        `&select=race_id,date,course,region,type,off,runners,dist,going,class&order=date.asc,off.asc` +
        `&limit=1000&offset=${offset}`,
        { headers: { apikey: s.key, Authorization: `Bearer ${s.key}` } });
      if (r.status === 400) {
        // columns not migrated yet — legacy select
        r = await fetch(
          `${s.url}/rest/v1/results?date=gte.${from}&date=lte.${to}` +
          `&select=race_id,date,course,region,type,off,runners&order=date.asc,off.asc` +
          `&limit=1000&offset=${offset}`,
          { headers: { apikey: s.key, Authorization: `Bearer ${s.key}` } });
      }
      if (!r.ok) return null;
      const page = await r.json();
      rows.push(...page);
      if (page.length < 1000) break;
    }
  } catch { return null; }
  return rows.length ? rows : null;
}

export async function upsertResults(rows) {
  const s = supa();
  if (!s) return { ok: false, error: 'no-supabase-env' };
  let written = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    let r = await fetch(`${s.url}/rest/v1/results?on_conflict=race_id`, {
      method: 'POST',
      headers: {
        apikey: s.key, Authorization: `Bearer ${s.key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(batch),
    });
    if (r.status === 400) {
      // schema not migrated: strip the extended columns and retry this batch once
      const stripped = batch.map(({ dist, going, class: cls, ...rest }) => rest);
      r = await fetch(`${s.url}/rest/v1/results?on_conflict=race_id`, {
        method: 'POST',
        headers: {
          apikey: s.key, Authorization: `Bearer ${s.key}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(stripped),
      });
    }
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return { ok: false, error: 'upsert-' + r.status, detail: detail.slice(0, 300), written };
    }
    written += batch.length;
  }
  return { ok: true, written };
}

export async function countRange(from, to) {
  const s = supa();
  if (!s) return null;
  try {
    const r = await fetch(
      `${s.url}/rest/v1/results?date=gte.${from}&date=lte.${to}&select=race_id`,
      { headers: { apikey: s.key, Authorization: `Bearer ${s.key}`, Prefer: 'count=exact', Range: '0-0' } });
    if (!r.ok) return null;
    const cr = r.headers.get('content-range') || '';
    const total = Number(cr.split('/')[1]);
    return isNaN(total) ? null : total;
  } catch { return null; }
}


// ---- generic per-month JSON store (table: page_months) ----
// create table if not exists page_months (k text not null, month text not null,
//   data jsonb not null, updated_at timestamptz not null default now(), primary key (k, month));
export async function monthGet(k, month) {
  const s = supa();
  if (!s) return null;
  try {
    const r = await fetch(`${s.url}/rest/v1/page_months?k=eq.${encodeURIComponent(k)}&month=eq.${month}&select=data,updated_at`,
      { headers: { apikey: s.key, Authorization: `Bearer ${s.key}` } });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows[0] || null;
  } catch { return null; }
}
export async function monthGetAll(k, months) {
  const s = supa();
  if (!s) return null;
  try {
    const list = months.map((m) => `"${m}"`).join(',');
    const r = await fetch(`${s.url}/rest/v1/page_months?k=eq.${encodeURIComponent(k)}&month=in.(${months.join(',')})&select=month,data,updated_at`,
      { headers: { apikey: s.key, Authorization: `Bearer ${s.key}` } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
export async function monthPut(k, month, data) {
  const s = supa();
  if (!s) return false;
  try {
    const r = await fetch(`${s.url}/rest/v1/page_months?on_conflict=k,month`, {
      method: 'POST',
      headers: { apikey: s.key, Authorization: `Bearer ${s.key}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ k, month, data, updated_at: new Date().toISOString() }]),
    });
    return r.ok;
  } catch { return false; }
}
