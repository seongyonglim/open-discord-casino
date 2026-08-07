/* 운영자 화면.
 *
 * 잠금이 두 겹이다.
 *   · 보기 — 로그인한 admin 만. 다른 사람은 403.
 *   · 바꾸기 — admin 이면서 ADMIN_TOKEN 헤더가 맞아야 한다.
 * 두 겹인 이유는 세션 하나가 새는 것과 DB 를 지울 수 있는 것이 같은 무게가 아니기
 * 때문이다. 토큰은 화면에 한 번 넣어 두면 브라우저 세션에만 남고 서버로는 헤더로만 간다.
 * ADMIN_TOKEN 이 비어 있으면 바꾸는 동작은 전부 막힌다 — 빈 값과 빈 헤더가 우연히
 * 같아지는 경로를 남기지 않는다.
 *
 * 화면에는 지우는 버튼이 있지만, 무엇을 지울 수 있는지는 화면이 아니라 db/admin.ts 가
 * 정한다. 상금이 나간 대회는 거기서 거절한다.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { layout, esc, jsonForScript } from './views';
import { readJson, sendJson } from './http';
import {
  listTournaments, purgeTournament, openTestTournament, searchUsers, grantPoints,
} from '../db/admin';
import type { WebUser } from '../db/queries';

/** 바꾸는 동작의 두 번째 잠금. 토큰이 설정돼 있지 않으면 무조건 잠긴다. */
export function adminTokenOk(req: IncomingMessage): boolean {
  const want = process.env.ADMIN_TOKEN ?? '';
  if (want === '') return false;
  return String(req.headers['x-admin-token'] ?? '') === want;
}

export function isAdmin(user: WebUser | null): boolean {
  return !!user && user.role === 'admin';
}

const num = (n: number) => Number(n || 0).toLocaleString('ko-KR');
const kst = (s: number | null) => s == null ? '—'
  : new Date((s + 9 * 3600) * 1000).toISOString().replace('T', ' ').slice(5, 16);

function tournamentState(t: { started_at: number | null; finished_at: number | null; cancelled_at: number | null }): string {
  if (t.cancelled_at != null) return '취소';
  if (t.finished_at != null) return '종료';
  if (t.started_at != null) return '진행 중';
  return '대기';
}

export function adminPage(user: WebUser): string {
  const ts = listTournaments(30);
  const tokenSet = (process.env.ADMIN_TOKEN ?? '') !== '';

  const rows = ts.map(t => {
    const safe = t.paid === 0 && !(t.started_at != null && t.finished_at == null && t.cancelled_at == null);
    return `<tr>
      <td>${t.id}</td>
      <td>${esc(t.date_str)}</td>
      <td>${esc(t.title)}</td>
      <td>${tournamentState(t)}</td>
      <td class="r">${num(t.entries)}</td>
      <td class="r">${num(t.prize_multiplier)}</td>
      <td class="r ${t.paid > 0 ? 'paid' : ''}">${num(t.paid)}P</td>
      <td>${safe
        ? `<button type="button" class="ad-del" data-id="${t.id}" data-label="${esc(t.date_str)} · ${esc(t.title)}">지우기</button>`
        : `<span class="ad-no">${t.paid > 0 ? '상금 지급됨' : '진행 중'}</span>`}</td>
    </tr>`;
  }).join('');

  const body = `
  <div class="ad-wrap">
    <h1 class="ad-h">운영자 화면</h1>
    <p class="ad-sub">${esc(user.username)} 님으로 접속했습니다. 데이터를 바꾸는 동작에는 운영 토큰이 필요합니다.</p>

    <section class="ad-card">
      <h2>운영 토큰</h2>
      ${tokenSet
        ? `<p class="ad-note">서버에 ADMIN_TOKEN 이 설정돼 있습니다. 아래에 같은 값을 넣어야 바꾸는 동작이 열립니다.</p>`
        : `<p class="ad-warn">서버에 ADMIN_TOKEN 이 설정돼 있지 않습니다. 바꾸는 동작이 전부 막혀 있습니다.
             <code>flyctl secrets set ADMIN_TOKEN=...</code> 로 설정한 뒤 다시 여세요.</p>`}
      <div class="ad-row">
        <input type="password" id="adTok" placeholder="ADMIN_TOKEN" autocomplete="off">
        <button type="button" id="adTokSave">기억</button>
        <span id="adTokState" class="ad-note"></span>
      </div>
    </section>

    <section class="ad-card">
      <h2>대회 기록</h2>
      <p class="ad-note">상금이 한 푼이라도 나간 대회는 지울 수 없습니다 — 상금은 원장에 이미 발행돼 있어서,
        기록만 지우면 잔액과 원장이 어긋납니다. 테스트는 아래 [테스트 대회 열기]로 여세요(상금 배수 0).</p>
      <div class="ad-row">
        <button type="button" id="adTest">테스트 대회 열기</button>
        <span class="ad-note">오늘 자리를 상금 없는 대회로 바꿉니다. 끝나면 이 표에서 지우면 원래대로 돌아옵니다.</span>
      </div>
      <div class="ad-scroll">
        <table class="ad-tbl">
          <thead><tr><th>id</th><th>날짜</th><th>제목</th><th>상태</th><th class="r">참가</th>
            <th class="r">배수</th><th class="r">지급</th><th></th></tr></thead>
          <tbody id="adTBody">${rows}</tbody>
        </table>
      </div>
    </section>

    <section class="ad-card">
      <h2>포인트</h2>
      <p class="ad-note">지급·차감은 원장에 남습니다. 잔액을 음수로 만드는 차감은 거절됩니다.</p>
      <div class="ad-row">
        <input type="search" id="adQ" placeholder="닉네임 또는 아이디" autocomplete="off">
        <button type="button" id="adFind">찾기</button>
      </div>
      <div class="ad-scroll"><table class="ad-tbl">
        <thead><tr><th>닉네임</th><th>아이디</th><th class="r">잔액</th><th>권한</th><th></th></tr></thead>
        <tbody id="adUBody"><tr><td colspan="5" class="ad-note">검색해 주세요.</td></tr></tbody>
      </table></div>
    </section>
  </div>

  <dialog id="adConfirm" class="ad-dlg">
    <h3 id="adCTitle">확인</h3>
    <p id="adCBody"></p>
    <div class="ad-row">
      <button type="button" id="adCNo">취소</button>
      <button type="button" id="adCYes" class="danger">실행</button>
    </div>
  </dialog>

  <script>
  (function(){
    var tokKey = 'od_admin_token';
    var tokEl = document.getElementById('adTok');
    var tokState = document.getElementById('adTokState');
    function tok(){ try { return sessionStorage.getItem(tokKey) || ''; } catch (e) { return ''; } }
    function paintTok(){ tokState.textContent = tok() ? '기억됨 (이 탭에만)' : '없음 — 바꾸는 동작이 막힙니다'; }
    document.getElementById('adTokSave').addEventListener('click', function(){
      try { sessionStorage.setItem(tokKey, tokEl.value); } catch (e) { /* 저장 못 하면 이번만 */ }
      tokEl.value = '';
      paintTok();
    });
    paintTok();

    /* 되돌릴 수 없는 동작은 반드시 이 문을 지나간다. 버튼 하나로 바로 실행되는 자리를
       만들지 않는다 — 운영자가 목록을 훑다가 잘못 누르는 것이 실제로 일어나는 사고다. */
    var dlg = document.getElementById('adConfirm');
    var pending = null;
    function confirmThen(title, body, run){
      document.getElementById('adCTitle').textContent = title;
      document.getElementById('adCBody').textContent = body;
      pending = run;
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    }
    document.getElementById('adCNo').addEventListener('click', function(){
      pending = null; if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
    });
    document.getElementById('adCYes').addEventListener('click', function(){
      var run = pending; pending = null;
      if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
      if (run) run();
    });

    function post(url, body){
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-token': tok() },
        body: JSON.stringify(body || {}),
      }).then(function(r){ return r.json().then(function(d){ return { status: r.status, d: d }; }); });
    }
    function shout(r){
      if (r.status === 200 && r.d && r.d.ok) return true;
      var msg = (r.d && (r.d.error || r.d.message)) || ('실패 (' + r.status + ')');
      if (r.status === 403) msg = '운영 토큰이 맞지 않습니다.';
      alert(msg);
      return false;
    }

    document.getElementById('adTest').addEventListener('click', function(){
      confirmThen('테스트 대회를 열까요?',
        '오늘 자리의 대회가 상금 없는 테스트 대회로 바뀝니다. 진행 중인 대회가 있으면 거절됩니다.',
        function(){ post('/api/admin/tournament/test', {}).then(function(r){ if (shout(r)) location.reload(); }); });
    });

    document.getElementById('adTBody').addEventListener('click', function(ev){
      var b = ev.target.closest ? ev.target.closest('.ad-del') : null;
      if (!b) return;
      confirmThen('대회 기록을 지울까요?',
        b.getAttribute('data-label') + ' — 이 대회의 판·좌석·참가 기록이 모두 사라집니다. 되돌릴 수 없습니다.',
        function(){
          post('/api/admin/tournament/purge', { id: Number(b.getAttribute('data-id')) })
            .then(function(r){ if (shout(r)) location.reload(); });
        });
    });

    var uBody = document.getElementById('adUBody');
    function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function num(n){ return Number(n || 0).toLocaleString('ko-KR'); }
    function find(){
      var q = document.getElementById('adQ').value;
      fetch('/api/admin/users?q=' + encodeURIComponent(q))
        .then(function(r){ return r.json(); })
        .then(function(d){
          var rows = (d && d.users) || [];
          if (!rows.length) { uBody.innerHTML = '<tr><td colspan="5" class="ad-note">없습니다.<\\/td><\\/tr>'; return; }
          uBody.innerHTML = rows.map(function(u){
            return '<tr><td>' + esc(u.username) + '<\\/td>'
              + '<td class="ad-id">' + esc(u.id) + '<\\/td>'
              + '<td class="r">' + num(u.balance) + 'P<\\/td>'
              + '<td>' + esc(u.role || 'member') + '<\\/td>'
              + '<td><button type="button" class="ad-give" data-id="' + esc(u.id) + '" data-name="'
              + esc(u.username) + '">포인트<\\/button><\\/td><\\/tr>';
          }).join('');
        });
    }
    document.getElementById('adFind').addEventListener('click', find);
    document.getElementById('adQ').addEventListener('keydown', function(e){ if (e.key === 'Enter') find(); });

    uBody.addEventListener('click', function(ev){
      var b = ev.target.closest ? ev.target.closest('.ad-give') : null;
      if (!b) return;
      var name = b.getAttribute('data-name'), id = b.getAttribute('data-id');
      var raw = prompt(name + ' 님에게 줄 포인트 (빼려면 음수)', '');
      if (raw == null || raw === '') return;
      var amount = Math.floor(Number(raw));
      if (!isFinite(amount) || amount === 0) { alert('숫자를 넣어 주세요.'); return; }
      var memo = prompt('사유 (원장에 남습니다)', '운영 지급') || '';
      confirmThen(amount > 0 ? '포인트를 지급할까요?' : '포인트를 차감할까요?',
        name + ' 님에게 ' + num(amount) + 'P. 사유: ' + memo,
        function(){
          post('/api/admin/points', { userId: id, delta: amount, memo: memo })
            .then(function(r){ if (shout(r)) { alert('잔액 ' + num(r.d.balance) + 'P'); find(); } });
        });
    });

    void ${jsonForScript(user.id)};
  })();
  </script>`;
  return layout('운영자 화면', 'lobby', body);
}

/* ── API ─────────────────────────────────────────────────────────── */

export async function handleAdminUsers(
  _req: IncomingMessage, res: ServerResponse, q: string
): Promise<void> {
  return sendJson(res, 200, { ok: true, users: searchUsers(q) });
}

export async function handleAdminPoints(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await readJson(req) as { userId?: unknown; delta?: unknown; memo?: unknown } | null;
  const userId = String(b?.userId ?? '');
  const r = grantPoints(userId, Number(b?.delta ?? 0), String(b?.memo ?? ''));
  if (!r.ok) {
    const msg = r.error === 'no_user' ? '없는 사용자입니다'
      : r.error === 'bad_amount' ? '금액이 올바르지 않습니다'
      : '잔액이 음수가 됩니다';
    return sendJson(res, 400, { error: msg });
  }
  return sendJson(res, 200, { ok: true, balance: r.balance });
}

export async function handleAdminPurge(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await readJson(req) as { id?: unknown } | null;
  const r = purgeTournament(Number(b?.id ?? 0));
  if (!r.ok) {
    const msg = r.error === 'not_found' ? '없는 대회입니다'
      : r.error === 'paid' ? '상금이 지급된 대회는 지울 수 없습니다'
      : '진행 중인 대회는 지울 수 없습니다';
    return sendJson(res, 400, { error: msg });
  }
  return sendJson(res, 200, { ok: true, removed: r.removed });
}

export async function handleAdminTestTournament(
  _req: IncomingMessage, res: ServerResponse
): Promise<void> {
  const r = openTestTournament();
  if (!r.ok) return sendJson(res, 400, { error: '진행 중인 대회가 있습니다' });
  return sendJson(res, 200, { ok: true, id: r.id });
}
