// RACESIDE — proxy to The Racing API
// Keeps Basic auth credentials server-side. Whitelisted paths only.
// Env vars required in Vercel: RACING_API_USERNAME, RACING_API_PASSWORD
// (same names as prizerun/racing1 — copy the values across)

const ALLOWED = [
  /^\/v1\/(trainers|jockeys|owners|horses|sires|dams|damsires)\/search$/,
  /^\/v1\/(trainers|jockeys|owners|sires|dams|damsires|horses)\/[a-z]{2,8}_[\w-]+\/analysis\/[a-z-]+$/,
  /^\/v1\/(trainers|jockeys|owners|horses|sires|dams|damsires)\/[a-z]{2,8}_[\w-]+\/results$/,
  /^\/v1\/results$/,
  /^\/v1\/results\/today$/,
  /^\/v1\/courses$/,
  /^\/v1\/courses\/regions$/,
];

export default async function handler(req, res) {
  const user = process.env.RACING_API_USERNAME;
  const pass = process.env.RACING_API_PASSWORD;
  if (!user || !pass) {
    return res.status(500).json({ ok: false, error: 'no-credentials' });
  }

  const { path, ...rest } = req.query;
  if (!path || !ALLOWED.some((r) => r.test(path))) {
    return res.status(400).json({ ok: false, error: 'bad-path', path: path || null });
  }

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(rest)) {
    if (Array.isArray(v)) v.forEach((x) => x !== '' && qs.append(k, x));
    else if (v !== '' && v != null) qs.append(k, v);
  }

  const url = `https://api.theracingapi.com${path}${qs.toString() ? '?' + qs.toString() : ''}`;

  try {
    const upstream = await fetch(url, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
        Accept: 'application/json',
      },
    });
    const body = await upstream.text();
    // Historical stats barely move — cache hard at the edge to protect the 1 req/s limit
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.setHeader('Content-Type', 'application/json');
    return res.status(upstream.status).send(body);
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'upstream', detail: String(e) });
  }
}
