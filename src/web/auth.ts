// 디스코드 OAuth2 로그인 + 세션 (프레임워크 없이 raw http + node:crypto)
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  upsertUser, ensureSeedAdmin, getWebUser, createSession, getSessionUserId, deleteSession, adjustBalance,
  renewSession, getSessionExpiry,
  type WebUser,
} from '../db/queries';
import { env } from '../env';

const CLIENT_ID = env('DISCORD_CLIENT_ID');
const CLIENT_SECRET = env('DISCORD_CLIENT_SECRET');
const REDIRECT_URI = env('DISCORD_OAUTH_REDIRECT_URI');
const GUILD_ID = env('DISCORD_GUILD_ID');
const SEED_ADMIN = env('SEED_ADMIN_DISCORD_ID');
// 슬라이딩 갱신(currentUser)과 함께 동작한다 — 이 기간 안에 한 번이라도 접속하면 만료가 미뤄지므로,
// 계속 쓰는 사람은 사실상 다시 로그인할 일이 없다. 완전히 방치된 세션만 이 기간 후 만료된다.
const SESSION_DAYS = 60;

export function authConfigured(): boolean {
  return !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI && GUILD_ID);
}

// OAuth 환경변수가 비어 있을 때의 안내 화면.
// charset을 빼먹으면 한글이 깨져서 무슨 말인지 알 수 없으므로 반드시 명시한다.
function sendAuthNotice(res: ServerResponse): void {
  const preview = process.env.PREVIEW_LOGIN === '1'
    ? `<p><a href="/dev/login" style="color:#d4af37">임시 계정으로 들어가기</a></p>`
    : `<p style="color:#8b8b92;font-size:13px">로컬에서 화면만 확인하려면 <code>PREVIEW_LOGIN=1</code>로 서버를 켜세요.</p>`;
  res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8">' +
    '<body style="background:#050506;color:#ececee;font-family:sans-serif;text-align:center;padding:80px">' +
    '<h2 style="color:#d4af37">디스코드 로그인이 아직 설정되지 않았습니다</h2>' +
    '<p style="color:#8b8b92">.env에 DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / DISCORD_OAUTH_REDIRECT_URI / DISCORD_GUILD_ID 를 채워주세요.</p>' +
    preview + '</body>');
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// 현재 요청의 로그인 유저 (없으면 null).
//
// res를 함께 넘기면 세션 만료를 뒤로 미룬다(슬라이딩 만료). 이게 없으면 로그인 후
// 정확히 SESSION_DAYS가 지나는 순간 매일 쓰던 사람도 다시 디스코드 인증을 거쳐야 한다.
// 갱신은 하루에 한 번까지만 — 매 요청마다 UPDATE + Set-Cookie를 하면 폴링이 초당 도는
// 게임 화면에서 쓸데없는 쓰기와 헤더가 계속 발생한다.
export function currentUser(req: IncomingMessage, res?: ServerResponse): WebUser | null {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const uid = getSessionUserId(sid);
  if (!uid) return null;

  if (res) {
    const now = Math.floor(Date.now() / 1000);
    const exp = getSessionExpiry(sid);
    const full = SESSION_DAYS * 86400;
    if (exp != null && exp - now < full - 86400) {
      renewSession(sid, now + full);
      res.setHeader('set-cookie', cookie('sid', sid, full, !!process.env.FLY_APP_NAME));
    }
  }
  return getWebUser(uid) ?? null;
}

function cookie(name: string, value: string, maxAgeSec: number, secure = true): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  parts.push(`Max-Age=${maxAgeSec}`);
  return parts.join('; ');
}

// 로컬 확인용 임시 로그인 (로그인 우회이므로 조건을 세 겹으로 잠근다):
//   1. PREVIEW_LOGIN=1 을 직접 켰고
//   2. OAuth가 설정돼 있지 않고
//   3. fly.io 위에서 돌고 있지 않을 때
// 3번은 .env가 실수로 이미지에 들어가더라도 실서버에서는 절대 열리지 않게 하는 안전장치다.
// (FLY_APP_NAME 은 fly 머신에 항상 주입되는 환경변수)
export function previewLoginEnabled(): boolean {
  if (process.env.FLY_APP_NAME) return false;
  return process.env.PREVIEW_LOGIN === '1' && !authConfigured();
}

export function handlePreviewLogin(req: IncomingMessage, res: ServerResponse): void {
  if (!previewLoginEnabled()) { res.writeHead(404); res.end(); return; }
  const id = 'preview-user';
  upsertUser(id, '미리보기', null);
  /* 디스코드 경로와 같은 규칙을 여기에도 둔다 — 운영자 전용 화면을 로컬에서 열어 보려면
     미리보기 사용자도 admin 이 될 수 있어야 한다:
       SEED_ADMIN_DISCORD_ID=preview-user PREVIEW_LOGIN=1 npm run dev
     이 문은 previewLoginEnabled() 안쪽이라 실서버에서는 아예 닿지 않는다. */
  if (SEED_ADMIN && id === SEED_ADMIN) ensureSeedAdmin(id);
  if ((getWebUser(id)?.balance ?? 0) <= 0) adjustBalance(id, 200000, 'preview_seed');
  const token = crypto.randomBytes(24).toString('hex');
  createSession(token, id, Math.floor(Date.now() / 1000) + 86400 * 7);
  // 로컬은 http라서 Secure를 붙이면 쿠키가 저장되지 않는 환경이 있다
  res.writeHead(302, { 'set-cookie': cookie('sid', token, 86400 * 7, false), location: '/' });
  res.end();
}

// GET /go → 디스코드 채널의 "카지노 입장" 버튼이 가리키는 주소.
// 세션이 있으면 로비로 바로 보내고, 없으면 OAuth로 보낸다.
// 이미 앱을 승인한 사용자는 디스코드가 확인 화면 없이 즉시 되돌려주므로 클릭 한 번으로 입장이 끝난다.
// (링크 버튼 자체는 신원을 담지 못하므로, 로그인은 표준 OAuth 경로로만 처리한다)
export function handleGo(req: IncomingMessage, res: ServerResponse): void {
  const location = currentUser(req) ? '/' : '/auth/login';
  res.writeHead(302, { location });
  res.end();
}

// GET /auth/login → 디스코드 인증 화면으로 리다이렉트
export function handleLogin(req: IncomingMessage, res: ServerResponse): void {
  if (!authConfigured()) return sendAuthNotice(res);
  const state = crypto.randomBytes(16).toString('hex');
  const auth = 'https://discord.com/api/oauth2/authorize?' + new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: 'identify guilds', state,
  }).toString();
  res.writeHead(302, { 'set-cookie': cookie('oauth_state', state, 600), location: auth });
  res.end();
}

// GET /auth/callback → 토큰교환 → 길드멤버 검증 → 유저 생성/갱신 → 세션
export async function handleCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const saved = parseCookies(req).oauth_state;
  if (!code || !state || state !== saved) { res.writeHead(302, { location: '/?login=error' }); res.end(); return; }
  try {
    const tokRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
      }).toString(),
    });
    const tok = await tokRes.json() as any;
    if (!tok.access_token) throw new Error('no access_token');
    const headers = { authorization: `Bearer ${tok.access_token}` };
    const me = await fetch('https://discord.com/api/users/@me', { headers }).then(r => r.json()) as any;
    const guilds = await fetch('https://discord.com/api/users/@me/guilds', { headers }).then(r => r.json()) as any;
    const inGuild = Array.isArray(guilds) && guilds.some((g: any) => g.id === GUILD_ID);
    if (!inGuild) { res.writeHead(302, { location: '/?login=notmember' }); res.end(); return; }

    const id: string = me.id;
    const name: string = me.global_name || me.username || id;
    const avatar = me.avatar ? `https://cdn.discordapp.com/avatars/${id}/${me.avatar}.png?size=64` : null;
    upsertUser(id, name, avatar);
    if (SEED_ADMIN && id === SEED_ADMIN) ensureSeedAdmin(id);

    const token = crypto.randomBytes(32).toString('hex');
    const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
    createSession(token, id, exp);
    res.writeHead(302, {
      'set-cookie': [cookie('sid', token, SESSION_DAYS * 86400), cookie('oauth_state', '', 0)],
      location: '/?login=ok',
    });
    res.end();
  } catch (e) {
    console.error('OAuth 콜백 오류:', e);
    res.writeHead(302, { location: '/?login=error' });
    res.end();
  }
}

// GET /auth/logout
export function handleLogout(req: IncomingMessage, res: ServerResponse): void {
  const sid = parseCookies(req).sid;
  if (sid) deleteSession(sid);
  res.writeHead(302, { 'set-cookie': cookie('sid', '', 0), location: '/' });
  res.end();
}
