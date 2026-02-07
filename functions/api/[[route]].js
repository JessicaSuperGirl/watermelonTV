/**
 * Cloudflare Pages Adapter for DongguaTV (Hardcoded & Env-Ready)
 */

// ==========================================
// 📝 默认站点配置 (如果你不想用环境变量，直接在这里改代码)
// ==========================================
const DEFAULT_SITES = {
  "sites": [
    {
      "key": "ffzy",
      "name": "非凡资源",
      "api": "https://api.ffzyapi.com/api.php/provide/vod/",
      "active": true
    },
    {
      "key": "lzzy",
      "name": "量子资源",
      "api": "https://cj.lziapi.com/api.php/provide/vod/",
      "active": true
    },
    {
      "key": "snzy",
      "name": "索尼资源",
      "api": "https://suoniapi.com/api.php/provide/vod/",
      "active": true
    }
  ]
};

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\//, '');

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  try {
    if (path === 'config') return handleConfig(env, url);
    if (path === 'sites') return await handleSites(env);
    if (path === 'search') return await handleSearch(request, env);
    if (path === 'detail') return await handleDetail(request, env);
    if (path === 'tmdb-proxy') return await handleTmdbProxy(request, env);
    if (path === 'auth/check') return handleAuthCheck(env);
    if (path === 'auth/verify') return await handleAuthVerify(request, env);
    if (path === 'cors') return await handleCorsProxy(request);
    if (path === 'debug') return handleDebug(env);
    if (path.startsWith('tmdb-image/')) return await handleTmdbImage(path);

    return new Response(JSON.stringify({ error: 'API Not Found' }), { status: 404, headers: corsHeaders() });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders() });
  }
}

// ========== 逻辑分发 ========== 

async function handleSites(env) {
  // 1. 优先环境变量 (支持 JSON 和 Base64)
  if (env.SITES_JSON) {
    try {
      return new Response(env.SITES_JSON, { headers: corsHeaders() });
    } catch (e) {
      try {
        const decoded = atob(env.SITES_JSON);
        return new Response(decoded, { headers: corsHeaders() });
      } catch (e2) {}
    }
  }
  // 2. 其次远程 URL
  if (env.REMOTE_DB_URL) {
    try {
      const resp = await fetch(env.REMOTE_DB_URL);
      if (resp.ok) return new Response(await resp.text(), { headers: corsHeaders() });
    } catch (e) {}
  }
  // 3. 兜底默认值
  return new Response(JSON.stringify(DEFAULT_SITES), { headers: corsHeaders() });
}

function handleConfig(env, url) {
  const passwords = getPasswords(env);
  return new Response(JSON.stringify({
    tmdb_api_key: env.TMDB_API_KEY || '',
    tmdb_proxy_url: env.TMDB_PROXY_URL || '',
    cors_proxy_url: `${url.origin}\/api\/cors`, 
    enable_local_image_cache: false,
    sync_enabled: false,
    multi_user_mode: passwords.length > 1
  }), { headers: corsHeaders() });
}

async function handleSearch(request, env) {
  const url = new URL(request.url);
  const keyword = url.searchParams.get('wd');
  if (!keyword) return errorResponse('Missing wd');

  const sitesResp = await handleSites(env);
  const sitesData = await sitesResp.json();
  const sites = sitesData.sites?.filter(s => s.active) || [];

  const {readable, writable} = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    const promises = sites.map(async (site) => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch(`${site.api}?ac=detail&wd=${encodeURIComponent(keyword)}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        const data = await resp.json();
        const list = data.list ? data.list.map(item => ({...item, site_key: site.key, site_name: site.name})) : [];
        if (list.length > 0) await writer.write(encoder.encode(`data: ${JSON.stringify(list)}\n\n`));
      } catch (e) {}
    });
    await Promise.allSettled(promises);
    await writer.write(encoder.encode('event: done\ndata: {}\n\n'));
    await writer.close();
  })();

  return new Response(readable, { headers: { ...corsHeaders(), 'Content-Type': 'text/event-stream' } });
}

async function handleDetail(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const siteKey = url.searchParams.get('site_key');
  const sitesResp = await handleSites(env);
  const sitesData = await sitesResp.json();
  const site = sitesData.sites?.find(s => s.key === siteKey);
  if (!site) return errorResponse('Site not found', 404);
  const resp = await fetch(`${site.api}?ac=detail&ids=${id}`);
  return new Response(await resp.text(), { headers: corsHeaders() });
}

async function handleTmdbProxy(request, env) {
  const url = new URL(request.url);
  const tmdbPath = url.searchParams.get('path');
  if (!tmdbPath || !env.TMDB_API_KEY) return errorResponse('Missing TMDB Config');
  const params = new URLSearchParams(url.search);
  params.delete('path');
  params.set('api_key', env.TMDB_API_KEY);
  params.set('language', 'zh-CN');
  const resp = await fetch(`https://api.themoviedb.org/3${tmdbPath}?${params.toString()}`);
  return new Response(await resp.text(), { headers: { ...corsHeaders(), 'Cache-Control': 'public, max-age=3600' } });
}

async function handleTmdbImage(path) {
  const parts = path.split('/');
  const target = `https://image.tmdb.org/t/p/${parts[1]}/${parts[2]}`;
  const resp = await fetch(target);
  return new Response(resp.body, { headers: { ...corsHeaders(), 'Content-Type': resp.headers.get('Content-Type'), 'Cache-Control': 'public, max-age=86400' } });
}

async function handleCorsProxy(request) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target) return errorResponse('Missing url');
  const resp = await fetch(target, { headers: { 'User-Agent': 'Mozilla\/5.0' } });
  let body = resp.body;
  let contentType = resp.headers.get('Content-Type') || '';

  if (target.includes('.m3u8') || contentType.includes('mpegurl')) {
    const text = await resp.text();
    const proxyBase = `${url.origin}\/api\/cors?url=`;
    body = text.replace(/^(?!#)(.+)$/gm, (m) => `${proxyBase}${encodeURIComponent(new URL(m, target).toString())}`)
               .replace(/URI="([^"]+)"/g, (m, u) => `URI="${proxyBase}${encodeURIComponent(new URL(u, target).toString())}"`);
    contentType = 'application/vnd.apple.mpegurl';
  }
  return new Response(body, { headers: { ...corsHeaders(), 'Content-Type': contentType } });
}

async function handleAuthVerify(request, env) {
  const { password } = await request.json();
  const passwords = getPasswords(env);
  if (passwords.length === 0 || passwords.includes(password)) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password || ''));
    const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
    return new Response(JSON.stringify({ success: true, passwordHash: hashHex, syncEnabled: false }), { headers: corsHeaders() });
  }
  return new Response(JSON.stringify({ success: false }));
}

function handleAuthCheck(env) {
  const passwords = getPasswords(env);
  return new Response(JSON.stringify({ requirePassword: passwords.length > 0, multiUserMode: passwords.length > 1 }), { headers: corsHeaders() });
}

function handleDebug(env) {
  return new Response(JSON.stringify({ env: 'Cloudflare Pages', tmdb: !!env.TMDB_API_KEY }), { headers: corsHeaders() });
}

function getPasswords(env) { return (env.ACCESS_PASSWORD || '').split(',').map(p => p.trim()).filter(Boolean); }
function corsHeaders() { return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json; charset=utf-8' }; }
function errorResponse(msg, status = 400) { return new Response(JSON.stringify({ error: msg }), { status, headers: corsHeaders() }); }
