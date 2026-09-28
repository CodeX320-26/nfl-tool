// ---- Discord login gate (Cloudflare Pages Functions) ----
// Every request to nfl.gmgsports.org -- pages AND data.json -- passes
// through here. Access follows the member's CURRENT Discord roles: the bot
// token looks the member up server-side, and a signed session cookie only
// vouches for that check for RECHECK_MS, so losing the role (cancelled
// subscription, left the server, kicked) cuts access within that window.
//
// Setup finished 2026-09-28 (secrets added); ENFORCE below is the on switch.
// Stays switched OFF (site open) until the client ID, allowed roles, and
// both secrets (DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN -- Cloudflare Pages
// secrets, pushed from GitHub secrets by deploy.yml) are all in place.

const GUILD_ID = "1295760852892385290";
const CLIENT_ID = "1554268816521957447"; // Discord app's OAuth2 Client ID (not secret)
const ALLOWED_ROLE_IDS = ["1471877733868109937", "1471880013824393266"]; // roles that get in
const INVITE_URL = ""; // "Join the Discord" button
// false = TEST MODE: the site stays open to everyone, but /auth/login works
// and /auth/check shows whether this Discord account WOULD get in. Flip to
// true (one-line push) once that's confirmed.
const ENFORCE = true;

const COOKIE = "gmg_session";
const STATE_COOKIE = "gmg_oauth_state";
const RECHECK_MS = 15 * 60 * 1000; // re-verify roles with Discord this often
const SESSION_DAYS = 30; // stay logged in this long between visits
const OUTAGE_GRACE_MS = 2 * 60 * 60 * 1000; // Discord API down: honor a check this recent

const enc = new TextEncoder();
const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const b64urlText = (s) => b64url(enc.encode(s));
const fromB64urlText = (s) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

// Session signing key derived from the bot token, so there's no extra
// secret to manage (rotating the bot token simply logs everyone out).
async function hmacKey(env) {
  const base = await crypto.subtle.importKey("raw", enc.encode(env.DISCORD_BOT_TOKEN), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", base, enc.encode("gmg-session-v1"));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function sign(env, payload) {
  const body = b64urlText(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}
async function verify(env, token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = await sign(env, JSON.parse(fromB64urlText(body)));
  if (expected.split(".")[1] !== sig) return null;
  const payload = JSON.parse(fromB64urlText(body));
  return payload.exp > Date.now() ? payload : null;
}

function getCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  const m = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function setCookie(name, value, maxAgeSec) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

// Member lookup with the bot token -- the source of truth for roles.
// Returns { ok: true, roles } / { ok: false, reason: "not-member" } /
// { ok: false, reason: "api" } when Discord itself can't answer.
async function memberRoles(env, userId) {
  const res = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`, {
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
  });
  if (res.status === 404) return { ok: false, reason: "not-member" };
  if (!res.ok) return { ok: false, reason: "api" };
  const m = await res.json();
  return { ok: true, roles: m.roles || [] };
}
const hasAllowedRole = (roles) => roles.some((r) => ALLOWED_ROLE_IDS.includes(r));

// The data build (build_stats.py fetch_previous_odds_snapshot) reads the
// live data.json; it sends HMAC(bot token, "gmg-build-v1") as X-GMG-Build.
async function isBuildRequest(request, env) {
  const sent = request.headers.get("X-GMG-Build");
  if (!sent) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(env.DISCORD_BOT_TOKEN), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode("gmg-build-v1")));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sent === hex;
}

function gateReady(env) {
  return !!(CLIENT_ID && ALLOWED_ROLE_IDS.length && env.DISCORD_CLIENT_SECRET && env.DISCORD_BOT_TOKEN);
}
function gateEnabled(env) {
  return ENFORCE && gateReady(env);
}

// ---- pages ----
function page(title, inner, status = 200, headers = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Barlow+Semi+Condensed:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#070b13;--panel:#0d1422;--panel2:#111a2b;--border:#1d2a41;--text:#e7edf7;--muted:#8797b0;--accent:#22c55e}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:radial-gradient(1000px 420px at 50% -80px,rgba(34,197,94,.12),transparent 70%),var(--bg);color:var(--text);font-family:"Barlow Semi Condensed",system-ui,sans-serif}
.box{width:100%;max-width:440px;background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:28px 26px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.45)}
.mark{display:inline-block;font-family:"Barlow Condensed",sans-serif;font-weight:800;font-size:1.1rem;letter-spacing:.04em;color:#03140a;background:var(--accent);border-radius:7px;padding:3px 9px 2px;box-shadow:0 0 18px rgba(34,197,94,.35)}
h1{font-family:"Barlow Condensed",sans-serif;font-weight:800;font-size:1.9rem;letter-spacing:.03em;text-transform:uppercase;margin:12px 0 6px}h1 b{color:var(--accent)}
p{color:var(--muted);line-height:1.45;margin:0 0 18px}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:12px 16px;border-radius:10px;font-weight:700;font-size:1rem;text-decoration:none;margin-top:10px}
.discord{background:#5865f2;color:#fff}.discord:hover{background:#4752c4}
.ghost{background:var(--panel2);color:var(--text);border:1px solid var(--border)}
small{display:block;margin-top:16px;color:var(--muted);font-size:.78rem}
</style></head><body><div class="box"><span class="mark">GMG</span><h1>NFL <b>Suite</b></h1>${inner}</div></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}
const DISCORD_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.6 1.3a18.4 18.4 0 0 0-5.6 0L8.6 3a19.7 19.7 0 0 0-4.9 1.4C.6 9 -.3 13.5.1 18a19.9 19.9 0 0 0 6 3l1.3-2.1a12.9 12.9 0 0 1-2-1l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4a12.9 12.9 0 0 1-2 1L18 21a19.9 19.9 0 0 0 6-3c.5-5.2-.8-9.7-3.7-13.6zM8.3 15.3c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4zm7.4 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4z"/></svg>`;

function loginPage(next) {
  return page(
    "Sign in -- GMG's NFL Suite",
    `<p>Access is for members of the GMG Discord.</p>
     <a class="btn discord" href="/auth/login?next=${encodeURIComponent(next)}">${DISCORD_ICON}Log in with Discord</a>
     ${INVITE_URL ? `<a class="btn ghost" href="${INVITE_URL}" target="_blank" rel="noopener">Not in the Discord yet? Join here</a>` : ""}
     <small>We only see your Discord name and your roles in the GMG server.</small>`,
    401
  );
}
function deniedPage(reason) {
  const msg =
    reason === "not-member"
      ? "Your Discord account isn't in the GMG server."
      : reason === "api"
      ? "Discord isn't answering right now, so we can't check your access. Try again in a minute."
      : "Your Discord account doesn't have a role with access to the NFL Suite.";
  return page(
    "No access -- GMG's NFL Suite",
    `<p>${msg}</p>
     ${INVITE_URL && reason !== "api" ? `<a class="btn discord" href="${INVITE_URL}" target="_blank" rel="noopener">${DISCORD_ICON}Open the GMG Discord</a>` : ""}
     <a class="btn ghost" href="/auth/logout">Use a different Discord account</a>`,
    403,
    // Discord outage keeps the session; a real "no" clears it.
    reason === "api" ? {} : { "Set-Cookie": setCookie(COOKIE, "", 0) }
  );
}

// ---- OAuth routes ----
async function handleLogin(request) {
  const url = new URL(request.url);
  const next = url.searchParams.get("next") || "/";
  const state = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const auth = new URL("https://discord.com/oauth2/authorize");
  auth.searchParams.set("client_id", CLIENT_ID);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", "identify");
  auth.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
  auth.searchParams.set("state", state);
  auth.searchParams.set("prompt", "none");
  return new Response(null, {
    status: 302,
    headers: { Location: auth.toString(), "Set-Cookie": setCookie(STATE_COOKIE, JSON.stringify({ state, next: next.startsWith("/") ? next : "/" }), 600) },
  });
}

async function handleCallback(request, env) {
  const url = new URL(request.url);
  let saved = {};
  try {
    saved = JSON.parse(getCookie(request, STATE_COOKIE) || "{}");
  } catch (e) {
    saved = {};
  }
  if (!url.searchParams.get("code") || !saved.state || saved.state !== url.searchParams.get("state")) return loginPage("/");
  const tokenRes = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: url.searchParams.get("code"),
      redirect_uri: `${url.origin}/auth/callback`,
    }),
  });
  if (!tokenRes.ok) return deniedPage("api");
  const { access_token } = await tokenRes.json();
  const meRes = await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bearer ${access_token}` } });
  if (!meRes.ok) return deniedPage("api");
  const me = await meRes.json();
  const check = await memberRoles(env, me.id);
  if (!check.ok) return deniedPage(check.reason);
  if (!hasAllowedRole(check.roles)) return deniedPage("no-role");
  const now = Date.now();
  const session = await sign(env, { uid: me.id, name: me.global_name || me.username, checked: now, exp: now + SESSION_DAYS * 864e5 });
  const headers = new Headers({ Location: ENFORCE ? saved.next || "/" : "/auth/check" });
  headers.append("Set-Cookie", setCookie(COOKIE, session, SESSION_DAYS * 86400));
  headers.append("Set-Cookie", setCookie(STATE_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

// Test page: logs this Discord account's live result without gating anything.
async function handleCheck(request, env) {
  let session = null;
  try {
    session = await verify(env, getCookie(request, COOKIE));
  } catch (e) {
    session = null;
  }
  if (!session) return loginPage("/auth/check");
  const check = await memberRoles(env, session.uid);
  if (!check.ok) return deniedPage(check.reason);
  if (!hasAllowedRole(check.roles)) return deniedPage("no-role");
  return page(
    "Access check -- GMG's NFL Suite",
    `<p><b style="color:#6ee79b">You're in, ${session.name}.</b><br>Your Discord roles give you access to the NFL Suite.</p>
     <a class="btn discord" href="/">Open the site</a>
     <a class="btn ghost" href="/auth/logout">Log out</a>`
  );
}

function handleLogout() {
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", setCookie(COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

// ---- the gate ----
export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  // Setup check: which pieces are in place (never the secret values).
  if (url.pathname === "/auth/status") {
    const status = {
      gate: gateEnabled(env) ? "on" : gateReady(env) ? "test mode" : "off",
      clientId: !!CLIENT_ID,
      roles: ALLOWED_ROLE_IDS.length,
      clientSecret: !!env.DISCORD_CLIENT_SECRET,
      botToken: !!env.DISCORD_BOT_TOKEN,
    };
    return new Response(JSON.stringify(status), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  if (gateReady(env)) {
    if (url.pathname === "/auth/login") return handleLogin(request);
    if (url.pathname === "/auth/callback") return handleCallback(request, env);
    if (url.pathname === "/auth/logout") return handleLogout();
    if (url.pathname === "/auth/check") return handleCheck(request, env);
  }
  if (!gateEnabled(env)) return next(); // not configured / test mode: site stays open
  if (await isBuildRequest(request, env)) return next();

  let session = null;
  try {
    session = await verify(env, getCookie(request, COOKIE));
  } catch (e) {
    session = null;
  }
  if (!session) return loginPage(url.pathname + url.search);

  // Roles re-checked with Discord whenever the last check is older than
  // RECHECK_MS -- this is what makes a cancelled role stop working.
  const age = Date.now() - session.checked;
  if (age < RECHECK_MS) return next();
  const check = await memberRoles(env, session.uid);
  if (!check.ok && check.reason === "api") {
    return age < OUTAGE_GRACE_MS ? next() : deniedPage("api");
  }
  if (!check.ok) return deniedPage(check.reason);
  if (!hasAllowedRole(check.roles)) return deniedPage("no-role");
  const refreshed = await sign(env, { ...session, checked: Date.now() });
  const res = await next();
  const out = new Response(res.body, res);
  out.headers.append("Set-Cookie", setCookie(COOKIE, refreshed, SESSION_DAYS * 86400));
  out.headers.set("Cache-Control", "private, no-store");
  return out;
}
