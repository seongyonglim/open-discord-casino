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
import { listSeasons, updateSeason, closeSeason, seasonPlayers, backfillFirstSeason } from '../db/queries';
import { getConfig, defaultConfig, saveConfig, resetConfig } from '../db/settings';
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

  const cfg = getConfig();
  const d = defaultConfig();
  const seasons = listSeasons();
  const cur = seasons.find(s => s.closed_at == null);
  const seasonRows = seasons.map(s => `<tr>
      <td>시즌 ${s.number}${s.closed_at == null ? ' <span class="ad-live">진행 중</span>' : ''}</td>
      <td>${esc(s.name || '—')}</td>
      <td>${kst(s.started_at)}</td>
      <td>${s.closed_at != null ? kst(s.closed_at) : s.ends_at != null ? kst(s.ends_at) + ' 예정' : '미정'}</td>
      <td class="r">${num(seasonPlayers(s.id))}</td>
      <td>${esc(s.reward || '—')}</td>
    </tr>`).join('');

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
      <h2>대회 설정</h2>
      <p class="ad-note">바꾼 값은 <b>다음에 만들어질 대회부터</b> 적용됩니다. 진행 중인 대회는 만들어질 때의
        값을 자기 행에 갖고 있어서 흔들리지 않습니다 — 블라인드가 갑자기 뛰거나 늦게 온 사람만
        다른 스택을 받는 일이 없습니다. 순위별 분배(ITM 비율)는 검증된 산식이라 고정입니다.</p>
      <div class="ad-grid">
        <label>등록 시작 시각<input type="number" id="cfRegHour" min="0" max="23" value="${cfg.regOpenHour}"><i>시 (KST)</i></label>
        <label>대회 시작 시각<input type="number" id="cfStartHour" min="0" max="23" value="${cfg.startHour}"><i>시 (KST)</i></label>
        <label>최소 인원 대기<input type="number" id="cfGrace" min="1" value="${cfg.graceMin}"><i>분 (시작 시각 이후)</i></label>
        <label>레이트 레지<input type="number" id="cfLateReg" min="1" value="${cfg.lateRegMin}"><i>분 (실제 시작 이후)</i></label>
        <label>시작 칩<input type="number" id="cfStack" min="1" value="${cfg.startingStack}"><i>칩</i></label>
        <label>블라인드 주기<input type="number" id="cfLevel" min="1" value="${cfg.levelMin}"><i>분</i></label>
        <label>평일 상금 배수<input type="number" id="cfWd" min="0" value="${cfg.weekdayMultiplier}"><i>× 등록자 수</i></label>
        <label>주말 상금 배수<input type="number" id="cfWe" min="0" value="${cfg.weekendMultiplier}"><i>× 등록자 수</i></label>
        <label>고정 상금 풀<input type="number" id="cfFixed" min="0" value="${cfg.prizeFixed}"><i>0이면 인원 × 배수</i></label>
      </div>
      <div class="ad-row">
        <button type="button" id="cfSave">설정 저장</button>
        <button type="button" id="cfReset">기본값으로</button>
        <span class="ad-note">지금 기본값: 등록 ${d.regOpenHour}시 · 시작 ${d.startHour}시 · 대기 ${d.graceMin}분 ·
          레이트 ${d.lateRegMin}분 · 칩 ${num(d.startingStack)} · 블라인드 ${d.levelMin}분</span>
      </div>
    </section>

    <section class="ad-card">
      <h2>시즌</h2>
      <p class="ad-note">시즌을 닫으면 <b>그 순간의 잔액이 성적표로 찍히고</b>, 전원 잔액이 0으로
        초기화되며 다음 시즌이 열립니다. 게임별 전적은 지우지 않습니다 — 시즌이 열쇠에 들어 있어
        새 시즌은 저절로 비어 있고 지난 시즌 기록은 그대로 남습니다.
        지원금 쿨다운도 함께 풀립니다(0에서 시작하므로 바로 받을 수 있어야 합니다).</p>
      <div class="ad-scroll"><table class="ad-tbl">
        <thead><tr><th>시즌</th><th>이름</th><th>시작</th><th>종료</th><th class="r">참여</th><th>보상</th></tr></thead>
        <tbody>${seasonRows}</tbody>
      </table></div>
      <div class="ad-row" style="margin-top:12px">
        <input type="text" id="adSName" placeholder="현재 시즌 이름 (예: 오픈베타)" autocomplete="off">
        <input type="text" id="adSReward" placeholder="보상 안내" autocomplete="off">
        <input type="date" id="adSEnd">
        <button type="button" id="adSSave">안내 저장</button>
      </div>
      <div class="ad-row">
        <button type="button" id="adSFill">지난 기록을 첫 시즌으로 가져오기</button>
        <span class="ad-note">시즌 표를 만들기 전의 판은 시즌 장부에 없습니다. 첫 시즌의 범위가
          "지금까지 전부"이므로 통산 기록을 그대로 옮깁니다. 더하는 것이 아니라 맞추는 것이라
          여러 번 눌러도 결과가 같습니다.</span>
      </div>
      <div class="ad-row">
        <button type="button" id="adSClose" class="danger">시즌 종료 · 다음 시즌 열기</button>
        <span class="ad-note">되돌릴 수 없습니다.</span>
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

    document.getElementById('adSSave').addEventListener('click', function(){
      var d = document.getElementById('adSEnd').value;
      post('/api/admin/season/update', {
        name: document.getElementById('adSName').value,
        reward: document.getElementById('adSReward').value,
        // 날짜만 받고 그날 끝으로 본다 — 시각까지 고르게 하면 KST 환산 실수가 늘어난다
        endsAt: d ? Math.floor(new Date(d + 'T23:59:59+09:00').getTime() / 1000) : null,
      }).then(function(r){ if (shout(r)) location.reload(); });
    });

    /* 저장 전에 화면에서도 한 번 본다. 서버가 마지막 문이지만, 눌러 보고 나서야
       "시간 순서가 틀렸다"는 말을 듣는 것보다 미리 막는 편이 낫다. */
    function cfNum(id){ return Math.floor(Number(document.getElementById(id).value)); }
    function cfRead(){
      return {
        regOpenHour: cfNum('cfRegHour'), startHour: cfNum('cfStartHour'),
        graceMin: cfNum('cfGrace'), lateRegMin: cfNum('cfLateReg'),
        startingStack: cfNum('cfStack'), levelMin: cfNum('cfLevel'),
        weekdayMultiplier: cfNum('cfWd'), weekendMultiplier: cfNum('cfWe'),
        prizeFixed: cfNum('cfFixed'),
      };
    }
    function cfCheck(c){
      var bad = [];
      for (var k in c) if (!isFinite(c[k])) bad.push('숫자가 아닌 값이 있습니다');
      if (c.regOpenHour < 0 || c.regOpenHour > 23 || c.startHour < 0 || c.startHour > 23) {
        bad.push('시각은 0~23 사이여야 합니다');
      }
      if (c.regOpenHour >= c.startHour) bad.push('등록 시작은 대회 시작보다 앞서야 합니다');
      if (c.startHour * 60 + c.graceMin > 24 * 60) bad.push('대기 마감이 자정을 넘습니다');
      if (c.graceMin <= 0 || c.lateRegMin <= 0 || c.startingStack <= 0 || c.levelMin <= 0) {
        bad.push('대기·레이트 레지·칩·블라인드 주기는 1 이상이어야 합니다');
      }
      if (c.weekdayMultiplier < 0 || c.weekendMultiplier < 0 || c.prizeFixed < 0) {
        bad.push('배수와 고정 상금은 0 이상이어야 합니다');
      }
      return bad;
    }
    document.getElementById('cfSave').addEventListener('click', function(){
      var c = cfRead();
      var bad = cfCheck(c);
      if (bad.length) { alert(bad.join('\\n')); return; }
      confirmThen('대회 설정을 저장할까요?',
        '다음에 만들어질 대회부터 적용됩니다. 진행 중인 대회는 바뀌지 않습니다.',
        function(){ post('/api/admin/config', c).then(function(r){ if (shout(r)) location.reload(); }); });
    });
    document.getElementById('cfReset').addEventListener('click', function(){
      confirmThen('기본값으로 되돌릴까요?',
        '저장된 설정을 지워 코드의 기본값을 쓰게 합니다. 다음 대회부터 적용됩니다.',
        function(){ post('/api/admin/config/reset', {}).then(function(r){ if (shout(r)) location.reload(); }); });
    });

    document.getElementById('adSFill').addEventListener('click', function(){
      confirmThen('지난 기록을 첫 시즌으로 가져올까요?',
        '통산 기록(game_stats)을 첫 시즌의 시즌 장부에 맞춰 넣습니다. 더하는 것이 아니라 맞추는 것이라 여러 번 눌러도 같습니다.',
        function(){
          post('/api/admin/season/backfill', {})
            .then(function(r){ if (shout(r)) { alert(r.d.rows + '행을 시즌 장부에 넣었습니다.'); location.reload(); } });
        });
    });

    document.getElementById('adSClose').addEventListener('click', function(){
      confirmThen('시즌을 끝낼까요?',
        '지금 잔액이 성적표로 찍히고, 전원 잔액이 0으로 초기화되며 다음 시즌이 열립니다. '
        + '게임별 전적은 시즌별로 남습니다. 되돌릴 수 없습니다.',
        function(){
          post('/api/admin/season/close', {})
            .then(function(r){ if (shout(r)) { alert('시즌 ' + r.d.closed + ' 종료 · '
              + r.d.ranked + '명 기록 · 시즌 ' + r.d.nextNumber + ' 시작'); location.reload(); } });
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

export async function handleAdminSeasonUpdate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await readJson(req) as { name?: unknown; reward?: unknown; endsAt?: unknown } | null;
  const cur = listSeasons().find(s => s.closed_at == null);
  if (!cur) return sendJson(res, 400, { error: '진행 중인 시즌이 없습니다' });
  const endsAt = b?.endsAt == null ? null : Math.floor(Number(b.endsAt));
  const ok = updateSeason(cur.id, {
    name: String(b?.name ?? '').slice(0, 40),
    reward: String(b?.reward ?? '').slice(0, 200),
    endsAt: endsAt != null && Number.isFinite(endsAt) ? endsAt : null,
  });
  return ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 400, { error: '고칠 수 없습니다' });
}

export async function handleAdminSeasonClose(
  _req: IncomingMessage, res: ServerResponse
): Promise<void> {
  /* 시작 잔액은 0 이다. 시즌은 0 에서 시작하고, 거기서부터는 지원금과 출석으로 올린다 —
     closeSeason 이 지원금 쿨다운도 함께 풀어 모두가 같은 출발선에 선다. */
  const r = closeSeason({ seed: 0 });
  if (!r.ok) return sendJson(res, 400, { error: '진행 중인 시즌이 없습니다' });
  return sendJson(res, 200, { ok: true, closed: r.closed, ranked: r.ranked, nextNumber: r.nextNumber });
}

export async function handleAdminSeasonBackfill(
  _req: IncomingMessage, res: ServerResponse
): Promise<void> {
  const r = backfillFirstSeason();
  if (!r.ok) {
    return sendJson(res, 400, {
      error: r.error === 'not_first_season'
        ? '시즌이 이미 한 번 닫혔습니다 — 통산 기록이 여러 시즌에 걸쳐 있어 옮길 수 없습니다'
        : '진행 중인 시즌이 없습니다',
    });
  }
  return sendJson(res, 200, { ok: true, rows: r.rows });
}

export async function handleAdminConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await readJson(req) as Record<string, unknown> | null;
  const n = (k: string) => Math.floor(Number(b?.[k]));
  /* 검증은 saveConfig 안에서 한다 — 여기서 한 번 더 쓰면 두 벌이 되고, 언젠가 갈라진다.
     화면에도 같은 검사가 있지만 그건 편의고 마지막 문은 질의 계층이다. */
  const r = saveConfig({
    regOpenHour: n('regOpenHour'), startHour: n('startHour'),
    graceMin: n('graceMin'), lateRegMin: n('lateRegMin'),
    startingStack: n('startingStack'), levelMin: n('levelMin'),
    weekdayMultiplier: n('weekdayMultiplier'), weekendMultiplier: n('weekendMultiplier'),
    prizeFixed: n('prizeFixed'),
  });
  if (!r.ok) return sendJson(res, 400, { error: r.errors.join(' · ') });
  return sendJson(res, 200, { ok: true });
}

export async function handleAdminConfigReset(
  _req: IncomingMessage, res: ServerResponse
): Promise<void> {
  resetConfig();
  return sendJson(res, 200, { ok: true });
}
