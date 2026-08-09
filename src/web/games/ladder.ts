// 사다리게임: 좌/우 2줄 사다리를 여러 유저가 "같은 라운드"에 함께 베팅하는 실시간 공용 게임.
// 베팅 대상은 두 가지이고, 각각 독립적인 동전던지기라 더블 베팅이 의미를 가진다:
//   · 출발 : 공이 좌/우 어디서 출발하는지        (좌 / 우)
//   · 도착 : 공이 어느 도착지로 떨어지는지        (왼쪽 도착 = 홀 / 오른쪽 도착 = 짝)
// 하나만 예측하면 1.95배, 둘 다 예측해 모두 맞히면 3.95배.
// 지뢰찾기와 달리 1인 1라운드가 아니라 베팅 마감 시각까지 모두가 같은 라운드에 참여하고, 결과도 동시에 공개된다.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomInt } from 'node:crypto';
import {
  advanceLadderRound, placeLadderBet, cancelLadderBet, getLadderBets, getMyLadderBet, getWebUser, getRecentLadderResults,
  LADDER_REVEAL_SEC, LADDER_MULTIPLIER, LADDER_DOUBLE_MULTIPLIER,
  type LadderRoundRow, type WebUser,
} from '../../db/queries';
import { readJson, sendJson } from '../http';
import { award, withUnlocked } from '../achieve-hook';
import { getStreak } from '../../db/streaks';
import { layout, jsonForScript, ROSTER_JS, sidePanel, rankPane, rankJs, helpDialog } from '../views';
import { gameSwitcher } from '../pages';

const TOTAL_ROWS = 8;

type Side = 'L' | 'R';

function flip(): Side {
  return randomInt(2) === 0 ? 'L' : 'R';
}

// 결정된 좌/우 배치가 "교차"인지에 맞춰 가로줄(rung) 배열을 만든다. 마지막 줄만 최종 패리티를 맞추는 데
// 쓰이고 나머지는 순수 무작위 — 그림만 다를 뿐 이미 정해진 결과에는 전혀 영향 없다.
function buildRungs(crossed: boolean): boolean[] {
  const rungs: boolean[] = [];
  for (let i = 0; i < TOTAL_ROWS - 1; i++) rungs.push(randomInt(2) === 1);
  const isOdd = rungs.filter(Boolean).length % 2 === 1;
  rungs.push(isOdd !== crossed);
  return rungs;
}

function computeResult(): { startSide: Side; endSide: Side; rungs: boolean[] } {
  const startSide = flip();
  const endSide = flip();
  const rungs = buildRungs(startSide !== endSide);
  return { startSide, endSide, rungs };
}

/* ── 하강 연출 타이밍 ────────────────────────────────────────────────────
   서버(다음 라운드 시각 계산)와 클라이언트(실제 애니메이션)가 반드시 같은 값을 써야
   "다음 라운드까지 3초"가 연출과 어긋나지 않는다. 그래서 여기 한 곳에만 두고
   클라이언트 스크립트에는 아래에서 값을 심어 넣는다(양쪽에 따로 적으면 언젠가 갈라진다). */
// 카운트다운이 하강이 끝난 뒤부터 시작되므로 연출 길이를 자유롭게 정할 수 있다.
// (예전에는 3초 창 안에 욱여넣느라 45ms까지 줄여야 했다 → 눈으로 따라가기 급했다)
const ANIM_INIT_MS = 200;   // 출발 지점을 강조하고 잠깐 멈추는 시간
const ANIM_FALL_MS = 70;    // 한 칸 내려가는 시간 (행마다 두 번: 가로줄까지, 가로줄에서 바닥까지)
const ANIM_GROW_MS = 60;    // 가로줄이 자라나는 시간
const ANIM_CROSS_MS = 70;   // 가로줄을 타고 옆으로 건너가는 시간

// 이 라운드의 하강 연출이 몇 ms 걸리는지. 가로줄(교차) 개수에 따라 달라진다.
function descentMs(rungs: boolean[]): number {
  const crossings = rungs.filter(Boolean).length;
  return ANIM_INIT_MS + rungs.length * (ANIM_FALL_MS * 2) + crossings * (ANIM_GROW_MS + ANIM_CROSS_MS);
}

// 정산 후 다음 라운드까지 실제로 둘 시간 = 하강 연출 + 결과 감상(LADDER_REVEAL_SEC).
// 이렇게 해야 "다음 라운드까지 N초" 카운트가 공이 다 내려온 뒤부터 시작된다.
function revealSecFor(round: LadderRoundRow): number {
  const rungs: boolean[] = round.rungs_json ? JSON.parse(round.rungs_json) : [];
  return Math.ceil(descentMs(rungs) / 1000) + LADDER_REVEAL_SEC;
}

function advance(): LadderRoundRow {
  return advanceLadderRound(computeResult, revealSecFor);
}

function secondsLeft(round: LadderRoundRow): number {
  const now = Math.floor(Date.now() / 1000);
  if (round.phase === 'betting') return Math.max(0, round.betting_ends_at - now);
  // 하강이 끝나기 전에는 카운트다운을 보여주지 않는다(클라이언트가 0 이하를 감춘다).
  return Math.max(0, (round.resolved_at ?? now) + revealSecFor(round) - now);
}

// 공이 다 내려온 시각까지 몇 초 남았는지 — 클라이언트가 이 값으로 카운트다운 표시 시점을 정한다
function descentEndsIn(round: LadderRoundRow): number {
  if (round.phase !== 'done') return 0;
  const now = Math.floor(Date.now() / 1000);
  const rungs: boolean[] = round.rungs_json ? JSON.parse(round.rungs_json) : [];
  return Math.max(0, (round.resolved_at ?? now) + Math.ceil(descentMs(rungs) / 1000) - now);
}

export async function handleState(_req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const round = advance();
  const myBet = getMyLadderBet(round.id, userId);
  return sendJson(res, 200, {
    ok: true,
    round: {
      id: round.id,
      phase: round.phase,
      secondsLeft: secondsLeft(round),
      // 공이 다 내려올 때까지 남은 초 — 이 값이 0이 되기 전에는 카운트다운을 감춘다
      descentLeft: descentEndsIn(round),
      startSide: round.start_side,
      endSide: round.end_side,
      rungs: round.rungs_json ? JSON.parse(round.rungs_json) : null,
    },
    bets: getLadderBets(round.id),
    myBet: myBet ?? null,
    history: getRecentLadderResults(20),
    balance: getWebUser(userId)?.balance ?? 0,
    multiplier: LADDER_MULTIPLIER,
    doubleMultiplier: LADDER_DOUBLE_MULTIPLIER,
    ...ladderAwards(userId),
  });
}

/* ── 도전과제: 극우 이대남 ─────────────────────────────────────────
   연승은 정산 자리에서 쌓인다(그 판의 승패는 거기서만 안다). 여기서는 쌓인 값만 보고
   과제를 연다 — 이 응답으로 나가야 화면이 토스트를 띄운다.

   문지기(1,000P)는 연승을 쌓는 자리에 있다. 과제 쪽 min_bet 을 0 으로 둔 것이 그래서다:
   여기서 다시 재면 "지금 판의 베팅"을 기준으로 삼게 되는데, 일곱 번째 판을 크게 걸었는지
   여부는 이 과제와 상관이 없다.

   매 폴링마다 도는 자리지만 값싸다 — 연승이 7 미만이면 조회 한 번으로 끝나고,
   7 이상이어도 awardIfBet 이 이미 달성한 사람을 곧바로 걸러 낸다. */
const RIGHT_STREAK_GOAL = 7;

function ladderAwards(userId: string): { unlocked?: { id: string; title: string; description: string }[] } {
  const streak = getStreak(userId, 'ladder_right_win');
  if (streak < RIGHT_STREAK_GOAL) return {};
  return withUnlocked(award(userId, 0, [['la-right-7', () => true]]));
}

export async function handleBet(req: IncomingMessage, res: ServerResponse, userId: string, username: string): Promise<void> {
  // 본문 파싱(await)을 먼저 끝낸다 — 라운드 확인과 베팅 사이에 await가 있으면 그 틈에 라운드가
  // 마감·정산되어 이미 끝난 라운드에 베팅이 들어갈 수 있다. (최종 방어는 placeLadderBet의 트랜잭션 내 재확인)
  const data = await readJson(req);
  const betAmount = Math.floor(Number(data?.betAmount));
  const startGuess: Side | null = data?.startGuess === 'L' || data?.startGuess === 'R' ? data.startGuess : null;
  const parityGuess: 'ODD' | 'EVEN' | null =
    data?.parityGuess === 'ODD' || data?.parityGuess === 'EVEN' ? data.parityGuess : null;
  if (!Number.isFinite(betAmount) || betAmount < 1) return sendJson(res, 400, { error: '베팅 금액은 1P 이상이어야 합니다' });
  if (!startGuess && !parityGuess) return sendJson(res, 400, { error: '출발 또는 홀짝 중 최소 하나는 예측해야 합니다' });

  const round = advance();
  if (round.phase !== 'betting') return sendJson(res, 400, { error: '이번 라운드는 베팅이 마감되었습니다. 다음 라운드를 기다려주세요.' });

  const result = placeLadderBet(userId, username, round.id, startGuess, parityGuess, betAmount);
  if (!result.ok) {
    const msg = result.error === 'already_bet' ? '이번 라운드에는 이미 베팅했습니다'
      : result.error === 'closed' ? '이번 라운드는 베팅이 마감되었습니다. 다음 라운드를 기다려주세요.'
      : '잔액이 부족합니다';
    return sendJson(res, 400, { error: msg });
  }
  return sendJson(res, 200, { ok: true, balance: result.balance });
}

export async function handleCancel(_req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const round = advance();
  const result = cancelLadderBet(userId, round.id);
  if (!result.ok) {
    const msg = result.error === 'no_bet' ? '취소할 베팅이 없습니다' : '베팅이 마감되어 취소할 수 없습니다';
    return sendJson(res, 400, { error: msg });
  }
  return sendJson(res, 200, { ok: true, balance: result.balance });
}

/* 규칙 도움말.
   숫자는 전부 코드 상수에서 온다 — LADDER_MULTIPLIER 1.95 · LADDER_DOUBLE_MULTIPLIER 3.95 ·
   LADDER_BETTING_SEC 10. 여기와 코드가 어긋나면 설명이 거짓말을 하므로, 상수를 바꾸면
   이 글도 같이 고쳐야 한다. */
const RULES_HTML = `
  <h4>목표</h4>
  <p>사다리를 타고 내려온 공이 <b>어디서 출발했는지</b>와 <b>어디로 도착했는지</b>를 맞힙니다.</p>

  <h4>두 갈래에 겁니다</h4>
  <ul>
    <li><b>출발</b> — 좌 / 우</li>
    <li><b>도착</b> — 홀 / 짝 <span class="dim">(왼쪽 도착 = 홀, 오른쪽 도착 = 짝)</span></li>
  </ul>

  <h4>배당</h4>
  <table>
    <tr><td>하나만 골라서 맞히면</td><td>1.95 배</td></tr>
    <tr><td>둘 다 골라서 <b>모두</b> 맞히면</td><td>3.95 배</td></tr>
  </table>

  <h4>진행</h4>
  <ul>
    <li>베팅 <b>10초</b> → 공이 내려옴 → 결과</li>
    <li>사다리는 매 판 새로 만들어집니다 (가로줄 위치도 매번 다릅니다)</li>
  </ul>

  <p class="tip"><b>꿀팁 —</b> 길게 보면 <b>더블이 유리합니다.</b>
     단일은 50% × 1.95 = 0.975, 더블은 25% × 3.95 = 0.9875 —
     되돌려받는 비율이 더블 쪽이 높습니다.<br>
     그리고 <b>20의 배수로 걸면</b> 내림으로 버려지는 돈이 없습니다
     (1.95 · 3.95는 20으로 나누어떨어집니다). 어중간한 금액은 최대 0.95P가 사라집니다.</p>

  <div class="warn"><b>주의 —</b> 둘 다 골랐으면 <b>둘 다</b> 맞아야 이깁니다.
  하나만 맞으면 못 맞힌 것과 같습니다 — 부분 지급은 없습니다.</div>
`;

export function ladderPage(user: WebUser): string {
  const body = `
    ${gameSwitcher('ladder', 'ldHelp')}
    <div class="game-shell">
      <div class="game-main">
        <div class="card">
          <div id="lHistory" class="bead"></div>
          <div class="board-stage">
            <div id="lBoard" class="ladder-board"></div>
            <div id="lCountdown" class="stage-status"></div>
          </div>
        </div>
        <div class="card game-controls">
          <div class="field-grid">
            <div class="field">
              <label>베팅 금액 (P)</label>
              <div class="bet-row">
                <input id="lBet" class="game-input" type="number" min="1" step="1" value="10">
                <button type="button" class="chip-btn" id="lHalf">½</button>
                <button type="button" class="chip-btn" id="lDouble">2×</button>
              </div>
              <div class="quick-row">
                <button type="button" class="chip-btn wide" data-amt="10">10</button>
                <button type="button" class="chip-btn wide" data-amt="100">100</button>
                <button type="button" class="chip-btn wide" data-amt="1000">1000</button>
                <button type="button" class="chip-btn wide" data-amt="10000">1만</button>
              </div>
            </div>
            <div class="field">
              <label>예측 (하나만 ${LADDER_MULTIPLIER.toFixed(2)}x · 둘 다 ${LADDER_DOUBLE_MULTIPLIER.toFixed(2)}x)</label>
              <div class="predict-row">
                <span class="predict-lbl">출발</span>
                <button type="button" class="toggle-btn side-l" data-group="start" data-side="L">좌</button>
                <button type="button" class="toggle-btn side-r" data-group="start" data-side="R">우</button>
              </div>
              <div class="predict-row" style="margin-top:6px">
                <span class="predict-lbl">도착</span>
                <button type="button" class="toggle-btn parity-odd" data-group="parity" data-side="ODD">홀</button>
                <button type="button" class="toggle-btn parity-even" data-group="parity" data-side="EVEN">짝</button>
              </div>
            </div>
          </div>
          <div class="payout-line">
            <span>배당 <b id="lMulti" class="gold">${LADDER_MULTIPLIER.toFixed(2)}x</b></span>
            <span>적중 시 <b id="lPotential" class="hi">-</b></span>
          </div>
          <button id="lPlay" class="btn btn-primary game-action" type="button" disabled>예측을 선택하세요</button>
          <button id="lCancel" class="btn game-action" type="button" style="display:none">베팅 취소</button>
          <p id="lMsg" class="game-msg"></p>
        </div>
      </div>
      ${sidePanel('l', `
        <div class="side-head">
          <span id="lBetCount">참가자 0명</span>
          <span id="lPot" class="num">0P</span>
        </div>
        <div id="lFeed" class="roster"><div class="empty" style="padding:16px 0">아직 베팅이 없습니다</div></div>
      `, rankPane('l'))}
    </div>
    <script>window.__ME__ = ${jsonForScript(user.username)}; window.__MEID__ = ${jsonForScript(user.id)}; window.__SFX_NEED__ = ['fanfare'];</script>
    <script>
    (function(){
    ${ROSTER_JS}
      var betInput=document.getElementById('lBet');
      var halfBtn=document.getElementById('lHalf'), doubleBtn=document.getElementById('lDouble');
      var multiEl=document.getElementById('lMulti'), potEl=document.getElementById('lPotential');
      var playBtn=document.getElementById('lPlay'), cancelBtn=document.getElementById('lCancel');
      var board=document.getElementById('lBoard'), msg=document.getElementById('lMsg');
      var feed=document.getElementById('lFeed'), historyEl=document.getElementById('lHistory'), countdownEl=document.getElementById('lCountdown');
      var betCountEl=document.getElementById('lBetCount'), potTotalEl=document.getElementById('lPot');
      var pbal=document.querySelector('.prof .pbal');
      var card=document.querySelector('.card');

      var SINGLE = ${LADDER_MULTIPLIER}, DOUBLE = ${LADDER_DOUBLE_MULTIPLIER};
      var startGuess=null, parityGuess=null, myBetThisRound=false, lastAnimatedRoundId=null, animating=false;
      var revealedRoundId=null, lastState=null; // 공이 도착해 결과를 공개해도 되는 라운드 id
      // 첫 상태인지 여부 — 페이지 진입 직후에는 하강 연출을 건너뛰고 결과를 즉시 보여준다
      var firstState = true;

      // 아직 공개 전이면 결과 컬럼을 "진행 중"으로 가려서 스포일러를 막는다
      // 공이 도착하기 전까지 승패만 가린다. 참가자 패널에 쓰는 정보(아이디·아바타·잔액)는 그대로 둔다.
      function maskResult(b){
        return { user_id:b.user_id, username:b.username, avatar:b.avatar, balance:b.balance,
                 start_guess:b.start_guess, parity_guess:b.parity_guess,
                 amount:b.amount, won:null, payout:null };
      }

      function fmt(n){ return new Intl.NumberFormat('ko-KR').format(Math.floor(n)) + 'P'; }
      function setBalance(n){ if(pbal && typeof n === 'number') pbal.textContent = fmt(n); }
      function replay(el, cls){ el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
      function currentBalance(){ if(!pbal) return 0; return parseInt(pbal.textContent.replace(/[^0-9]/g,''),10) || 0; }
      function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
      function sideLabel(s){ return s==='L' ? '<span class="side-l-text">좌</span>' : '<span class="side-r-text">우</span>'; }
      function parityLabel(p){
        return '<span class="parity-text ' + (p==='ODD'?'odd':'even') + '">' + (p==='ODD'?'홀':'짝') + '</span>';
      }
      // 도착 지점의 홀짝 표기 — 왼쪽 도착 = 홀, 오른쪽 도착 = 짝
      function parityOf(r){ return r.endSide === 'L' ? 'ODD' : 'EVEN'; }

      function savePrefs(){ try{ localStorage.setItem('ladder_bet', betInput.value); }catch(e){} }
      function loadPrefs(){ try{ var b=localStorage.getItem('ladder_bet'); if(b) betInput.value=b; }catch(e){} }
      function setBet(n){ if(betInput.disabled) return; betInput.value=Math.max(1, Math.floor(n)); savePrefs(); updatePreview(); }
      loadPrefs();
      betInput.addEventListener('change', savePrefs);
      betInput.addEventListener('input', updatePreview);
      halfBtn.addEventListener('click', function(){ setBet(Number(betInput.value)/2); });
      doubleBtn.addEventListener('click', function(){ setBet(Number(betInput.value)*2); });
      // 빠른 금액 버튼은 칩을 쌓듯 현재 금액에 더한다 (크래시와 동일한 조작감)
      document.querySelectorAll('.chip-btn[data-amt]').forEach(function(b){
        b.addEventListener('click', function(){
          setBet((Number(betInput.value) || 0) + Number(b.getAttribute('data-amt')));
        });
      });

      // 출발/도착 각각 좌·우 토글 그룹 — 이미 선택된 걸 다시 누르면 선택 해제(둘 다 선택 안 함도 가능)
      function bindGroup(group){
        var btns = document.querySelectorAll('.toggle-btn[data-group="'+group+'"]');
        btns.forEach(function(btn){
          btn.addEventListener('click', function(){
            if (btn.disabled || myBetThisRound) return; // 베팅 확정 후엔 예측을 바꿀 수 없다 (취소 후 다시 베팅)
            var val = btn.getAttribute('data-side');
            var cur = group === 'start' ? startGuess : parityGuess;
            var next = cur === val ? null : val;
            if (group === 'start') startGuess = next; else parityGuess = next;
            btns.forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-side') === next); });
            updatePreview(); updatePlayBtn();
          });
        });
      }
      // 그룹 이름은 마크업의 data-group과 정확히 같아야 한다 ('end'가 아니라 'parity')
      bindGroup('start'); bindGroup('parity');

      function updatePreview(){
        var isDouble = startGuess && parityGuess;
        var m = isDouble ? DOUBLE : SINGLE;
        multiEl.textContent = m.toFixed(2) + 'x';
        potEl.textContent = fmt(Number(betInput.value||0) * m);
      }

      // 베팅 확정 후에는 금액/예측을 잠근다. 바꾸고 싶으면 "베팅 취소"로 환불받고 다시 걸어야 한다.
      function setControlsLocked(locked){
        betInput.disabled = locked;
        halfBtn.disabled = doubleBtn.disabled = locked;
        document.querySelectorAll('.chip-btn[data-amt]').forEach(function(b){ b.disabled = locked; });
        document.querySelectorAll('.toggle-btn').forEach(function(b){ b.disabled = locked; });
      }

      function updatePlayBtn(betting){
        if (myBetThisRound) {
          setControlsLocked(true);
          playBtn.disabled = true; playBtn.textContent = '베팅 완료 · 결과를 기다려주세요';
          cancelBtn.style.display = (betting === false) ? 'none' : 'inline-flex';
          return;
        }
        setControlsLocked(false);
        cancelBtn.style.display = 'none';
        if (betting === false) { playBtn.disabled = true; playBtn.textContent = '베팅 마감'; return; }
        var has = startGuess || parityGuess;
        playBtn.disabled = !has;
        playBtn.textContent = !has ? '예측을 선택하세요' : (startGuess && parityGuess ? '더블 베팅하기 (' + DOUBLE.toFixed(2) + 'x)' : '베팅하기');
      }

      var NS='http://www.w3.org/2000/svg';
      function svgEl(tag, attrs){ var el=document.createElementNS(NS, tag); for (var k in attrs) el.setAttribute(k, attrs[k]); return el; }

      var ROW_H=18, TOP_PAD=34, BOTTOM_PAD=34, W=190;
      var xs=[50,140];
      var height = TOP_PAD + BOTTOM_PAD + ROW_H*${TOTAL_ROWS};

      // 가로줄은 미리 그리지 않는다(결과를 미리 알 수 없게) — 공이 내려가면서 그때그때 생긴다.
      function buildBoard(){
        board.innerHTML='';
        // '출발' 글자의 baseline이 y=8(TOP_PAD-26)이라 글자 윗부분이 viewBox 위로 잘렸다.
        // 노드·애니메이션 좌표를 건드리지 않고 보이는 영역만 위아래로 넓힌다(min-y를 음수로).
        var CAP_PAD = 14;
        var svg = svgEl('svg', {
          viewBox: '0 ' + (-CAP_PAD) + ' ' + W + ' ' + (height + CAP_PAD + 6),
          width:'100%', height: height + CAP_PAD + 6, class:'ladder-svg',
        });
        xs.forEach(function(x){ svg.appendChild(svgEl('line', { x1:x, y1:TOP_PAD, x2:x, y2:height-BOTTOM_PAD, class:'ladder-line' })); });

        var cap1 = svgEl('text', { x:W/2, y:TOP_PAD-26, class:'ladder-cap', 'text-anchor':'middle' });
        cap1.textContent='출발'; svg.appendChild(cap1);
        var cap2 = svgEl('text', { x:W/2, y:height-BOTTOM_PAD+32, class:'ladder-cap', 'text-anchor':'middle' });
        cap2.textContent='도착'; svg.appendChild(cap2);

        // 출발 노드는 좌/우(파랑·빨강), 도착 노드는 홀/짝(골드·보라)으로 표기해 두 베팅 축을 구분한다
        ['L','R'].forEach(function(s, i){
          var topCls = s==='L' ? 'side-l' : 'side-r';
          var botCls = s==='L' ? 'parity-odd' : 'parity-even';
          var top = svgEl('circle', { cx:xs[i], cy:TOP_PAD, r:16, class:'ladder-node '+topCls, 'data-node':'start-'+s });
          svg.appendChild(top);
          var t1=svgEl('text', { x:xs[i], y:TOP_PAD+5, class:'ladder-label '+topCls, 'text-anchor':'middle' });
          t1.textContent = s==='L' ? '좌' : '우'; svg.appendChild(t1);
          var bot = svgEl('circle', { cx:xs[i], cy:height-BOTTOM_PAD, r:16, class:'ladder-node '+botCls, 'data-node':'end-'+s });
          svg.appendChild(bot);
          var t2=svgEl('text', { x:xs[i], y:height-BOTTOM_PAD+5, class:'ladder-label '+botCls, 'text-anchor':'middle' });
          t2.textContent = s==='L' ? '홀' : '짝'; svg.appendChild(t2);
        });

        board.appendChild(svg);
        return svg;
      }

      function markNode(svg, kind, side){
        var n = svg.querySelector('[data-node="'+kind+'-'+side+'"]');
        if (n) n.classList.add('hit');
      }

      // 가로줄을 "공이 갈 방향으로" 뻗어나가게 그린다 (공이 우측이고 좌로 갈 거면 우→좌로 자라남).
      // stroke-dashoffset을 x1(=공이 있는 쪽) 끝에서 0으로 줄여 방향성 있는 성장 효과를 만든다.
      function growRung(svg, y, fromCol, toCol, ms, token){
        var len = Math.abs(xs[1] - xs[0]);
        var ln = svgEl('line', { x1:xs[fromCol], y1:y, x2:xs[toCol], y2:y, class:'ladder-rung' });
        ln.style.strokeDasharray = len;
        ln.style.strokeDashoffset = len;
        svg.insertBefore(ln, token);
        void ln.getBoundingClientRect(); // 초기 상태를 확정시킨 뒤 트랜지션 시작
        ln.style.transition = 'stroke-dashoffset ' + ms + 'ms ease-out';
        ln.style.strokeDashoffset = 0;
      }

      function wait(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

      // 가로줄은 미리 보여주지 않고, 공이 그 칸에 도달한 순간 "갈 방향으로" 뻗어나온 뒤 공이 건너간다.
      // 지나온 길은 트레일로 남겨서 출발 → 도착 경로가 한눈에 보이게 한다.
      async function animateResult(round, myBet){
        animating = true;
        var svg = buildBoard();

        var startCol = round.startSide==='L' ? 0 : 1;
        var col = startCol;
        markNode(svg, 'start', round.startSide); // 출발 지점 먼저 강조
        await wait(${ANIM_INIT_MS});

        var token = svgEl('circle', { cx:xs[startCol], cy:TOP_PAD, r:9, class:'ladder-token' });
        svg.appendChild(token);
        function trail(x1,y1,x2,y2){
          svg.insertBefore(svgEl('line', { x1:x1, y1:y1, x2:x2, y2:y2, class:'ladder-trail' }), token);
        }

        // 서버가 다음 라운드 시각을 계산할 때 쓰는 값과 동일해야 한다 (ladder.ts 상단에서 주입)
        var FALL = ${ANIM_FALL_MS}, GROW = ${ANIM_GROW_MS}, CROSS = ${ANIM_CROSS_MS};
        for (var i=0; i<round.rungs.length; i++){
          var rungY = TOP_PAD + ROW_H*i + ROW_H/2;
          var rowBotY = TOP_PAD + ROW_H*(i+1);
          var prevY = Number(token.getAttribute('cy'));

          token.style.transition = 'cy ' + FALL + 'ms linear';
          token.setAttribute('cy', rungY);
          trail(xs[col], prevY, xs[col], rungY);
          await wait(FALL);

          if (round.rungs[i]) {
            var from = col, to = col===0?1:0;
            growRung(svg, rungY, from, to, GROW, token); // 공이 갈 방향으로 선이 자라남
            await wait(GROW);
            col = to;
            token.style.transition = 'cx ' + CROSS + 'ms ease-in-out';
            token.setAttribute('cx', xs[col]);
            trail(xs[from], rungY, xs[col], rungY);
            await wait(CROSS);
          }

          token.style.transition = 'cy ' + FALL + 'ms linear';
          token.setAttribute('cy', rowBotY);
          trail(xs[col], rungY, xs[col], rowBotY);
          await wait(FALL);
        }

        markNode(svg, 'end', round.endSide); // 도착 지점 강조
        if (myBet) token.classList.add(myBet.won ? 'win' : 'lose');

        // 여기서부터 결과 공개 — 히스토리/참가자 목록/잔액을 한꺼번에 갱신하고 연출을 재생한다
        revealedRoundId = round.id;
        if (lastState) applyState(lastState);
        showRoundResult(round, myBet);
        animating = false;
      }

      function showRoundResult(round, myBet){
        var line = '이번 판 결과 — 출발: ' + sideLabel(round.startSide) +
          ' · 도착: ' + parityLabel(parityOf(round));
        if (myBet) {
          var isDouble = myBet.start_guess && myBet.parity_guess;
          var guessLabel = isDouble
            ? ('출발 ' + sideLabel(myBet.start_guess) + ' + 도착 ' + parityLabel(myBet.parity_guess))
            : (myBet.start_guess ? ('출발 ' + sideLabel(myBet.start_guess)) : ('도착 ' + parityLabel(myBet.parity_guess)));
          if (myBet.won) {
            line += '<br><span style="color:var(--win);font-weight:700">적중</span> (' + guessLabel + ') — +' + fmt(myBet.payout) + ' (잔액 ' + fmt(currentBalance()) + ')';
            if (card) replay(card, 'gold-flash');
            if (pbal) replay(pbal, 'bump'); // 잔액이 오르는 순간을 눈에 띄게
            if (window.casinoSfx) window.casinoSfx.win('fanfare');
          } else {
            line += '<br><span style="color:var(--lose);font-weight:700">낙첨</span> (' + guessLabel + ')';
            if (window.casinoSfx) window.casinoSfx.lose();
          }
        }
        msg.innerHTML = line;
      }

      // 우측 실시간 목록 (크래시와 동일한 3열 구조: 플레이어 / 예측 / 베팅)
      function renderFeed(bets){
        var total = 0;
        bets.forEach(function(b){ total += b.amount; });
        betCountEl.textContent = '참가자 ' + bets.length + '명';
        potTotalEl.textContent = fmt(total);

        // 예측 표기는 접두어 없이 글자만 붙여 "좌홀"처럼 — 좁은 칸에서 읽기 쉽게
        renderRosterRows(feed, bets, window.__MEID__, function(b){
          var parts = [];
          if (b.start_guess) parts.push(sideLabel(b.start_guess));
          if (b.parity_guess) parts.push(parityLabel(b.parity_guess));
          var amt = (b.won && b.payout) ? '<span class="pos">+'+fmt(b.payout)+'</span>' : fmt(b.amount);
          return '<span class="rw-tag">'+parts.join('')+'</span><span class="rw-amt">'+amt+'</span>';
        });
      }

      // 출목표: 출발(좌/우) 행 / 도착(홀/짝) 행 — 베팅 대상과 정확히 같은 두 가지를 보여준다 (최신이 왼쪽)
      function renderHistory(history){
        if (!history.length) { historyEl.innerHTML = ''; return; }
        var startCells = history.map(function(r){
          return '<span class="bead-cell '+(r.startSide==='L'?'l':'r')+'">'+(r.startSide==='L'?'좌':'우')+'</span>';
        }).join('');
        var parityCells = history.map(function(r){
          var odd = parityOf(r) === 'ODD';
          return '<span class="bead-cell '+(odd?'odd':'even')+'">'+(odd?'홀':'짝')+'</span>';
        }).join('');
        historyEl.innerHTML =
          '<div class="bead-row"><span class="bead-lbl">출발</span>'+startCells+'</div>' +
          '<div class="bead-row"><span class="bead-lbl">도착</span>'+parityCells+'</div>';
      }

      async function play(){
        if (playBtn.disabled) return;
        savePrefs();
        var bet = Number(betInput.value);
        var r = await fetch('/api/games/ladder/bet', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ betAmount:bet, startGuess:startGuess, parityGuess:parityGuess }) });
        var d = await r.json();
        if (!r.ok) { msg.textContent = d.error || '오류가 발생했습니다'; return; }
        setBalance(d.balance);
        myBetThisRound = true;
        updatePlayBtn();
        poll();
      }

      async function cancel(){
        var r = await fetch('/api/games/ladder/cancel', { method:'POST' });
        var d = await r.json();
        if (!r.ok) { msg.textContent = d.error || '오류가 발생했습니다'; poll(); return; }
        setBalance(d.balance);
        myBetThisRound = false;
        startGuess = null; parityGuess = null;
        document.querySelectorAll('.toggle-btn').forEach(function(x){ x.classList.remove('active'); });
        msg.innerHTML = '베팅을 취소했습니다. 다시 예측을 선택하세요.';
        updatePreview();
        poll();
      }

      var lastRoundId = null;
      // 통신 실패는 화면에 알리고 다음 주기에 다시 시도한다 (조용히 죽으면 반쪽 화면으로 굳는다)
      var pollFails = 0;
      async function poll(){
        var d = await window.casinoPoll('/api/games/ladder/state');
        if (!d) {
          if (++pollFails >= 2) countdownEl.textContent = '서버에 연결하는 중…';
          return;
        }
        pollFails = 0;
        lastState = d;
        applyState(d);
      }

      // 결과 공개 게이트: 공이 도착하기 전에는 히스토리/참가자 목록/잔액이 결과를 미리 보여주지 않는다.
      // (미리 보여주면 애니메이션을 보는 재미가 사라진다 — 공이 내려가는 중엔 아직 "진행 중"으로 표시)
      function applyState(d){
        var round = d.round;
        var spoiler = round.phase === 'done' && revealedRoundId !== round.id;

        if (!spoiler) setBalance(d.balance);
        // 최신순 배열이므로 이번 라운드 결과는 맨 앞 하나 — 공개 전에는 그것만 잘라서 보여준다
        renderHistory(spoiler ? d.history.slice(1) : d.history);

        if (round.id !== lastRoundId) {
          myBetThisRound = !!d.myBet;
          startGuess = null; parityGuess = null;
          document.querySelectorAll('.toggle-btn').forEach(function(x){ x.classList.remove('active'); });
          updatePreview();
          if (round.phase === 'betting') { buildBoard(); msg.innerHTML=''; }
        }
        lastRoundId = round.id;

        renderFeed(spoiler ? d.bets.map(maskResult) : d.bets);

        var betting = round.phase === 'betting';
        // 하강 중에는 카운트다운을 띄우지 않는다 — 공이 다 내려온 뒤부터 "다음 라운드까지"를 센다
        countdownEl.textContent = betting
          ? ('베팅 마감까지 ' + round.secondsLeft + '초')
          : (round.descentLeft > 0 ? '결과 공개 중…' : ('다음 라운드까지 ' + round.secondsLeft + '초'));
        updatePlayBtn(betting);

        // 하강 연출은 "보고 있는 동안 결과가 나올 때"만 돌린다.
        // 페이지에 처음 들어온 순간은 lastAnimatedRoundId가 비어 있어, 공개 구간에 들어오면
        // 최대 3초짜리 하강을 처음부터 재생하며 그동안 결과를 가린다(페이지가 안 뜬 것처럼 느껨진다).
        // 처음 받은 상태는 이미 끝난 라운드로 취급해 결과를 즉시 보여준다.
        if (round.phase === 'done' && round.id !== lastAnimatedRoundId) {
          lastAnimatedRoundId = round.id;
          if (firstState) {
            // 이미 끝난 라운드로 취급해 결과를 즉시 보여준다.
            // (아래 applyState 재호출은 spoiler가 풀린 상태로 다시 그리기 위한 것이고,
            //  이때는 round.id === lastAnimatedRoundId 이므로 이 분기에 다시 들어오지 않는다)
            revealedRoundId = round.id;
            firstState = false;
            applyState(d);
            showRoundResult(round, d.myBet);
            return;
          }
          animateResult(round, d.myBet);
        }
        firstState = false;
      }

      playBtn.addEventListener('click', play);
      cancelBtn.addEventListener('click', cancel);
      buildBoard();
      updatePreview();
      updatePlayBtn(true);

      // 폴링 비용 관리: 이 페이지가 1초마다 서버를 깨우므로, 탭이 백그라운드로 가거나 오랫동안
      // 조작이 없으면 폴링을 멈춰 서버가 잠들 수 있게 한다(fly.io scale-to-zero 비용 절감).
      // 다시 조작하거나 탭으로 돌아오면 즉시 재개된다.
      var IDLE_MS = 3 * 60 * 1000;
      var timer = null, lastAct = Date.now(), idleStopped = false;

      function startPolling(){
        if (timer) return;
        idleStopped = false;
        poll();
        timer = setInterval(function(){
          if (document.hidden) { stopPolling(); return; }
          if (Date.now() - lastAct > IDLE_MS) {
            stopPolling(); idleStopped = true;
            countdownEl.textContent = '일시정지 (화면을 클릭하면 재개)';
            return;
          }
          poll();
        }, 1000);
      }
      function stopPolling(){ if (timer) { clearInterval(timer); timer = null; } }

      function activity(){
        lastAct = Date.now();
        if (!timer && !document.hidden) startPolling();
      }
      ['pointerdown','keydown','focus'].forEach(function(ev){
        window.addEventListener(ev, activity, true);
      });
      document.addEventListener('visibilitychange', function(){
        if (document.hidden) stopPolling(); else activity();
      });
      startPolling();
    })();

      // 우측 패널 랭킹 탭
      ${rankJs('l', 'ladder')}
    </script>
    ${helpDialog('ldHelp', '사다리게임 규칙', RULES_HTML)}`;
  return layout('사다리게임', 'lobby', body);
}
