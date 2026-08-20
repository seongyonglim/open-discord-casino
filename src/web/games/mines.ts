// 지뢰찾기: 25칸 중 지뢰 M개, 안전 칸을 열수록 배당 상승, 원할 때 캐시아웃.
// 배당(k) = (1 - 하우스엣지) × C(25,k) / C(25-M,k)  — "k칸을 연속으로 안전하게 열 확률"의 역수라 완전공정(하우스엣지 제외)하다.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomInt } from 'node:crypto';
import { placeBet, getActiveRound, updateRoundState, settleGameRound, type GameRound } from '../../db/queries';
import { readJson, sendJson } from '../http';
import { award, withUnlocked, withCommon, commonAwards } from '../achieve-hook';
import { layout, sidePanel, rankPane, rankJs, helpDialog } from '../views';
import { gameSwitcher } from '../pages';
import { bombIcon, coinIcon, mysteryMark } from '../icons';
import type { WebUser } from '../../db/queries';

export const TILE_COUNT = 25;
export const ALLOWED_MINE_COUNTS = [1, 3, 5, 10, 24] as const;
const HOUSE_EDGE = 0.01;
const GAME_TYPE = 'mines';

interface MinesState {
  mineCount: number;
  minePositions: number[];
  revealed: number[];
}

/* 시즌 마감 강제 정산(web/lockdown)이 이 식을 그대로 써야 한다 — 그때 나가는 금액은
   "지금 캐시아웃을 눌렀다면 받았을 금액"이고, 그 계산이 두 곳에 있으면 언젠가 갈라진다. */
export function calcMultiplier(mineCount: number, revealedCount: number): number {
  if (revealedCount <= 0) return 1;
  let m = 1;
  for (let i = 0; i < revealedCount; i++) {
    m *= (TILE_COUNT - i) / (TILE_COUNT - mineCount - i);
  }
  return m * (1 - HOUSE_EDGE);
}

/** n 개에서 k 개를 고르는 경우의 수. 정확해야 하므로 BigInt 로 센다. */
function comb(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n;
  let r = 1n;
  for (let i = 0n; i < BigInt(k); i++) r = (r * BigInt(n) - r * i) / (i + 1n);
  return r;
}

/**
 * 실제로 지급할 금액. 화면의 배수가 아니라 이 함수가 돈의 근거다.
 *
 * calcMultiplier 는 분수를 하나씩 곱해 쌓는다. double 안에서 그렇게 하면 참값보다
 * 아주 조금 작은 값이 나오는 조합이 있고(지뢰 1개 · 10칸이면 1.65 가 아니라
 * 1.6499999999999997), 그걸 내림하면 한 칸 더 내려간다 — 1,000P 를 걸고 화면이
 * "1.65배 · 1,650P" 라고 적어 둔 자리에서 1,649P 가 나갔다. 32개 조합이 그랬고
 * 오차는 언제나 유저 손해 쪽이었다.
 *
 * 곱을 정리하면 소수가 아예 안 나온다:
 *   ∏(25-i)/(25-M-i) = C(25,k) / C(25-M,k)
 * 이므로 지급액은 bet × 99 × C(25,k) / (100 × C(25-M,k)) 이고, 이 값을 정수로만
 * 계산해 마지막에 한 번 내린다. 화면 배수는 표시용으로 그대로 둔다.
 */
export function minesPayout(bet: number, mineCount: number, revealedCount: number): number {
  const b = Math.max(0, Math.floor(bet));
  const k = Math.max(0, Math.floor(revealedCount));
  // 한 칸도 안 열었으면 배당이 정확히 1.00 배다 — 원금 그대로 돌려준다
  if (k <= 0) return b;
  const den = comb(TILE_COUNT - mineCount, k);
  if (den <= 0n) return b;
  const pct = BigInt(Math.round((1 - HOUSE_EDGE) * 100));   // 99
  return Number((BigInt(b) * pct * comb(TILE_COUNT, k)) / (100n * den));
}

// 암호학적으로 안전한 셔플(Fisher-Yates)로 지뢰 위치를 뽑는다 — Math.random 금지
function generateMinePositions(mineCount: number): number[] {
  const positions = Array.from({ length: TILE_COUNT }, (_, i) => i);
  for (let i = TILE_COUNT - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  return positions.slice(0, mineCount).sort((a, b) => a - b);
}

function parseState(round: GameRound): MinesState {
  return JSON.parse(round.state_json) as MinesState;
}

// 클라이언트로 내려줄 공개 정보 (진행 중엔 지뢰 위치를 절대 노출하지 않음)
function publicRound(round: GameRound, state: MinesState, revealMines: boolean) {
  const revealedCount = state.revealed.length;
  const maxSafe = TILE_COUNT - state.mineCount;
  return {
    roundId: round.id,
    betAmount: round.bet_amount,
    mineCount: state.mineCount,
    revealed: state.revealed,
    multiplier: Number(calcMultiplier(state.mineCount, revealedCount).toFixed(4)),
    nextMultiplier: revealedCount < maxSafe ? Number(calcMultiplier(state.mineCount, revealedCount + 1).toFixed(4)) : null,
    /* 화면이 적을 «획득» 금액. 배수를 넘겨 주고 화면에서 곱하게 두면 두 계산이
       갈라진다 — 배수는 네 자리로 자른 표시용 값이라 실제 지급액과 몇 P 씩 어긋났다.
       나갈 금액을 그대로 실어 보내면 화면이 약속한 숫자와 통장에 찍히는 숫자가
       같아진다. 그게 이 칸의 유일한 쓸모다. */
    potAmount: minesPayout(round.bet_amount, state.mineCount, revealedCount),
    nextPotAmount: revealedCount < maxSafe
      ? minesPayout(round.bet_amount, state.mineCount, revealedCount + 1) : null,
    status: round.status,
    payout: round.payout,
    minePositions: revealMines ? state.minePositions : undefined,
  };
}

export function activeRoundPayload(userId: string) {
  const round = getActiveRound(userId, GAME_TYPE);
  if (!round) return null;
  return publicRound(round, parseState(round), false);
}

// 주의: 본문 파싱(await)은 반드시 DB 조회보다 "먼저" 해야 한다. 검증과 쓰기 사이에 await가 끼면
// 동시 요청이 그 틈으로 들어와 같은 라운드를 두 번 처리할 수 있다(중복 베팅/이중 정산).
// 파싱을 앞으로 빼면 이후 로직이 전부 동기라 단일 스레드 특성상 원자적으로 실행된다.
export async function handleStart(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const data = await readJson(req);
  const betAmount = Math.floor(Number(data?.betAmount));
  const mineCount = Number(data?.mineCount);
  if (!Number.isFinite(betAmount) || betAmount < 1) return sendJson(res, 400, { error: '베팅 금액은 1P 이상이어야 합니다' });
  if (!(ALLOWED_MINE_COUNTS as readonly number[]).includes(mineCount)) return sendJson(res, 400, { error: '지뢰 개수가 올바르지 않습니다' });

  const existing = getActiveRound(userId, GAME_TYPE);
  if (existing) return sendJson(res, 409, { error: '이미 진행 중인 라운드가 있습니다', round: publicRound(existing, parseState(existing), false) });

  const state: MinesState = { mineCount, minePositions: generateMinePositions(mineCount), revealed: [] };
  const result = placeBet(userId, GAME_TYPE, betAmount, state);
  if (!result.ok) return sendJson(res, 400, { error: '잔액이 부족합니다' });

  const round = getActiveRound(userId, GAME_TYPE)!;
  return sendJson(res, 200, { ok: true, balance: result.balance, round: publicRound(round, state, false) });
}

export async function handleReveal(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const data = await readJson(req);
  const tile = Number(data?.tile);
  if (!Number.isInteger(tile) || tile < 0 || tile >= TILE_COUNT) return sendJson(res, 400, { error: '잘못된 칸입니다' });

  const round = getActiveRound(userId, GAME_TYPE);
  if (!round) return sendJson(res, 400, { error: '진행 중인 라운드가 없습니다' });

  const state = parseState(round);
  if (state.revealed.includes(tile)) return sendJson(res, 400, { error: '이미 연 칸입니다' });

  const newState: MinesState = { ...state, revealed: [...state.revealed, tile] };
  updateRoundState(round.id, newState);

  const busted = state.minePositions.includes(tile);
  const maxSafe = TILE_COUNT - state.mineCount;

  if (busted) {
    const balance = settleGameRound(round.id, userId, 0, 0, `game:${GAME_TYPE}`);
    const settled: GameRound = { ...round, status: 'settled', payout: 0, multiplier: 0 };
    return sendJson(res, 200, { ok: true, busted: true, balance, round: publicRound(settled, newState, true) });
  }

  if (newState.revealed.length === maxSafe) {
    const multiplier = calcMultiplier(state.mineCount, newState.revealed.length);
    const payout = minesPayout(round.bet_amount, state.mineCount, newState.revealed.length);
    const balance = settleGameRound(round.id, userId, payout, multiplier, `game:${GAME_TYPE}`);
    const settled: GameRound = { ...round, status: 'settled', payout, multiplier };
    /* ── 도전과제 둘 ─────────────────────────────────────────────────
       여기는 "안전한 칸을 하나도 남기지 않고 다 열었다"는 자리다. 마지막 칸을 열면
       그 자리에서 자동 정산되므로, 판을 끝까지 간 과제는 전부 여기서 판정해야 한다 —
       handleCashout 에 붙이면 영영 도달하지 않는다.

         · 1/25의 사나이 — 안전 칸이 하나뿐인 판(지뢰 24개)에서 그 한 칸을 짚었다.
         · 안전불감증   — 지뢰 하나 판에서 24칸을 끝까지 다 열었다. 마지막 한 칸을
                          남기고 나오는 것이 안전한 선택인데 거기서 한 번 더 눌렀다.

       1/25 쪽은 지뢰 개수가 아니라 maxSafe 로 쓴다 — "안전 칸이 하나뿐인 판"이 그 과제의
       뜻이라 판 크기나 지뢰 선택지가 바뀌어도 뜻이 따라온다. 안전불감증은 반대로
       "지뢰 하나짜리 판"이 조건 자체라 지뢰 개수를 그대로 본다. */
    const got = award(userId, round.bet_amount, [
      ['mi-1-of-25', () => maxSafe === 1],
      ['mi-24-of-24', () => state.mineCount === 1 && newState.revealed.length === TILE_COUNT - 1],
    ]);
    /* 공통 과제(롤러코스터 등)도 여기서 함께 본다. 지뢰찾기에는 폴링하는 상태
       엔드포인트가 없어서(라우트가 page·start·reveal·cashout 넷뿐이다) 이 자리를
       빼먹으면 "화면을 열어 두면 언젠가 열린다"가 성립하지 않는다.
       그리고 롤러코스터는 그 날만 유효하다 — 지뢰찾기로 되살아난 사람이 다른 게임을
       열기 전에 자정을 넘기면 그 날의 달성이 영구히 사라졌다(실측). */
    return sendJson(res, 200, {
      ok: true, autoCashedOut: true, balance,
      round: publicRound(settled, newState, true), ...withCommon(userId, got),
    });
  }

  return sendJson(res, 200, { ok: true, round: publicRound(round, newState, false) });
}

export async function handleCashout(_req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const round = getActiveRound(userId, GAME_TYPE);
  if (!round) return sendJson(res, 400, { error: '진행 중인 라운드가 없습니다' });

  const state = parseState(round);
  // 아무 칸도 열지 않은 상태의 캐시아웃은 배당이 정확히 1.00x이므로 베팅액 전액 환불과 동일하게 동작한다.
  // (칸을 열지 않았다면 유저가 얻은 정보가 없으므로 환불해도 악용 여지가 없다 — 별도 취소 버튼이 필요 없는 이유)
  const multiplier = calcMultiplier(state.mineCount, state.revealed.length);
  const payout = minesPayout(round.bet_amount, state.mineCount, state.revealed.length);
  // 0칸 캐시아웃은 전액 환불과 같으므로 랭킹의 판수에 넣지 않는다 (위 주석 참조)
  const balance = settleGameRound(round.id, userId, payout, multiplier, `game:${GAME_TYPE}`,
    state.revealed.length > 0);
  const settled: GameRound = { ...round, status: 'settled', payout, multiplier };
  /* 이 자리에는 지뢰찾기 고유 과제가 없다. 안전불감증은 "끝까지 다 열었다"로 바뀌면서
     handleReveal 의 자동 정산 쪽으로 옮겼다 — 다 열면 여기까지 오지 않기 때문이다.

     다만 공통 과제(롤러코스터 등)는 봐야 한다. 캐시아웃이 이 게임에서 잔액이 크게
     오르는 자리이고, 지뢰찾기에는 폴링하는 상태 엔드포인트가 없어서 여기서 안 보면
     다른 게임을 열 때까지 판정이 미뤄진다. 롤러코스터는 그 날만 유효하므로 그 사이
     자정을 넘기면 달성이 영구히 사라진다. 잔액 게이트가 앞에 있어 비용은 색인 조회
     한 번이다(achieve-hook 의 commonAwards). */
  return sendJson(res, 200, {
    ok: true, balance, round: publicRound(settled, state, true),
    ...withUnlocked(commonAwards(userId)),
  });
}


/* ── 규칙 표의 배수 ────────────────────────────────────────────────────
   손으로 적지 않고 calcMultiplier 로 만든다. 예전에는 문자열로 박아 두었는데, 그러면
   하우스 엣지나 판 크기를 고치는 날 규칙 설명만 옛 숫자로 남는다(지뢰 10개 줄은 아예
   전부 열기 값이 빠져 있었다 — 3,236,072배가 너무 커서 적기를 멈춘 흔적이다).

   전부 열기 확률도 함께 적는다. 그 값이 없으면 "5만 배"가 버그로 읽힌다 — 실제로 그
   제보를 받았다. 배수 = (1 - 엣지) / 확률 이므로 확률의 분모는 배수에서 되돌려 구한다:
   따로 조합 함수를 두면 같은 수를 두 방법으로 계산하게 되고, 언젠가 갈라진다. */
function ruleMult(n: number): string {
  /* 100배 미만은 소수 둘째 자리까지 — 1.03 과 1.13 의 차이가 이 게임의 전부다.
     자리를 채워 적는다(5 가 아니라 5.00): 표에서 자릿수가 들쭉날쭉하면 열이 어긋나 보인다. */
  const d = n < 100 ? 2 : 0;
  return n.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
}

const MINE_RULE_ROWS = ALLOWED_MINE_COUNTS.map(m => {
  const maxSafe = TILE_COUNT - m;
  const full = calcMultiplier(m, maxSafe);
  // 배수 = (1 - 엣지) / 확률  →  1/확률 = 배수 / (1 - 엣지)
  const odds = Math.round(full / (1 - HOUSE_EDGE));
  const cell = (k: number): string =>
    k <= maxSafe ? `${ruleMult(calcMultiplier(m, k))}배` : '<span class="dim">—</span>';
  return `<tr><td>지뢰 ${m}개</td>`
    + `<td class="r">${cell(1)}</td>`
    + `<td class="r">${cell(10)}</td>`
    + `<td class="r"><b>${ruleMult(full)}배</b>`
    + `<span class="dim"> · 1/${odds.toLocaleString('ko-KR')}</span></td></tr>`;
}).join('\n    ');

/* 규칙 도움말. 숫자는 코드에서 온다 —
   TILE_COUNT 25 · ALLOWED_MINE_COUNTS [1,3,5,10,24] · HOUSE_EDGE 0.01.
   배수 표는 위 MINE_RULE_ROWS 가 calcMultiplier 로 만든다(어림수가 아니다). */
const RULES_HTML = `
  <h4>목표</h4>
  <p><b>25칸</b> 중 지뢰를 피해 칸을 엽니다. 안전한 칸을 열 때마다 배수가 오르고,
     <b>원할 때 캐시아웃</b>하면 그 배수로 받습니다.</p>

  <h4>진행</h4>
  <ul>
    <li>지뢰 개수를 <b>1 · 3 · 5 · 10 · 24</b> 중에서 고르고 베팅합니다</li>
    <li>칸을 하나씩 엽니다. 지뢰를 열면 그 순간 전액 손실</li>
    <li>한 번에 한 판만 진행할 수 있습니다</li>
  </ul>

  <h4>배수는 "그 일이 얼마나 드문가"입니다</h4>
  <p>배수는 <b>성공 확률의 역수</b>입니다(하우스 엣지 1% 제외). 그래서 전부 열기 배수가
     수만 배로 적혀 있는 것은 금액이 큰 것이 아니라 <b>그만큼 드문 일</b>이라는 뜻입니다 —
     확률을 나란히 적어 두었으니 함께 보세요.</p>
  <table>
    <tr><th>지뢰</th><th class="r">1칸</th><th class="r">10칸</th><th class="r">전부 열기</th></tr>
    ${MINE_RULE_ROWS}
  </table>
  <p class="dim">지뢰 24개는 안전한 칸이 하나뿐이라 그 한 칸이 곧 전부 열기입니다.</p>

  <p class="tip"><b>여기서 감이 잡힙니다 —</b> 지뢰 <b>1개</b>를 전부 열기와 지뢰 <b>24개</b>에서
     한 칸 맞히기는 배수가 똑같이 <b>24.75배</b>입니다. 둘 다 25번에 한 번 되는 일이라서요.
     한쪽은 24번 연속 성공, 다른 한쪽은 한 번에 정답 — <b>어려움이 같으면 배수도 같습니다.</b></p>

  <p class="tip"><b>꿀팁 —</b> 어디서 멈추든 기대값은 같습니다. 지뢰 수와 여는 칸 수는
     <b>"자주 조금" 과 "드물게 크게" 중 무엇을 고를지</b>일 뿐입니다.
     목표 배수를 미리 정하고 거기서 빠지는 게 가장 단순합니다.</p>

  <div class="warn"><b>주의 —</b> 지뢰를 밟으면 그때까지 쌓인 배수는 <b>전부 사라집니다.</b>
  캐시아웃을 눌러야 내 것이 됩니다.</div>

  <h4>이 판의 규격</h4>
  <p class="spec">25칸 · 지뢰 1·3·5·10·24개</p>
`;

export function minesPage(user: WebUser): string {
  const active = activeRoundPayload(user.id);
  const body = `
    ${gameSwitcher('mines', 'mnHelp')}
    <div class="game-shell mines-shell">
      <div class="game-main">
        <div class="card">
          <div class="board-stage">
            <div id="mGrid" class="mines-grid"></div>
          </div>
        </div>
        <div class="card game-controls">
          <div class="field-grid">
            <div class="field">
              <label>베팅 금액 (P)</label>
              <div class="bet-row">
                <input id="mBet" class="game-input" type="number" min="1" step="1" value="10">
                <button type="button" class="chip-btn" id="mHalf">½</button>
                <button type="button" class="chip-btn" id="mDouble">2×</button>
              </div>
              <div class="quick-row">
                <button type="button" class="chip-btn wide" data-amt="10">10</button>
                <button type="button" class="chip-btn wide" data-amt="100">100</button>
                <button type="button" class="chip-btn wide" data-amt="1000">1000</button>
                <button type="button" class="chip-btn wide" data-amt="10000">1만</button>
              </div>
            </div>
            <div class="field">
              <label>지뢰 개수</label>
              <select id="mMineCount" class="game-input" style="width:100%">
                <option value="1">1개</option>
                <option value="3">3개</option>
                <option value="5" selected>5개</option>
                <option value="10">10개</option>
                <option value="24">24개</option>
              </select>
              <div class="payout-line" style="margin-top:6px">
                <span>배당 <b id="mMulti" class="gold">1.00x</b></span>
                <span>획득 <b id="mPotential" class="hi">-</b></span>
              </div>
            </div>
          </div>
          <button id="mStart" class="btn btn-primary game-action" type="button">베팅 시작</button>
          <button id="mCashout" class="btn btn-primary game-action" type="button" style="display:none">캐시아웃</button>
          <p id="mMsg" class="game-msg"></p>
        </div>
      </div>
      <!-- 지뢰찾기는 혼자 하는 게임이라 참가자 목록이 없다 — 랭킹만 둔다 -->
      ${sidePanel('m', '', rankPane('m'))}
    </div>
    <script>window.__MINES_ACTIVE__ = ${active ? JSON.stringify(active) : 'null'};
      window.__SFX_NEED__ = ['minecoin','explode','gain','mineperfect'];
      /* 지뢰찾기에는 폴링이 없다(혼자 하는 게임이라 상태를 물을 이유가 없다).
         그래서 채팅은 도크가 열려 있는 동안만 스스로 5초 폴을 돈다 — 이 값은 말한 자리를
         적는 데만 쓴다. */
      window.__CHAT_WHERE__ = 'mines';
      window.__MINES_ICONS__ = ${JSON.stringify({ bomb: bombIcon, coin: coinIcon, mark: mysteryMark })};</script>
    <script>
    (function(){
      var ICONS = window.__MINES_ICONS__;
      var betInput=document.getElementById('mBet'), mineSelect=document.getElementById('mMineCount');
      var startBtn=document.getElementById('mStart'), cashoutBtn=document.getElementById('mCashout');
      var halfBtn=document.getElementById('mHalf'), doubleBtn=document.getElementById('mDouble');
      var grid=document.getElementById('mGrid'), msg=document.getElementById('mMsg');
      var multiEl=document.getElementById('mMulti'), potEl=document.getElementById('mPotential');
      var pbal=document.querySelector('.prof .pbal');
      var card=document.querySelector('.card');
      var tiles=[];
      var pendingTimers=[];

      function fmt(n){ return new Intl.NumberFormat('ko-KR').format(Math.floor(n)) + 'P'; }
      function setBalance(n){ if(pbal && typeof n === 'number') pbal.textContent = fmt(n); }
      function replay(el, cls){ el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
      function currentBalance(){ if(!pbal) return 0; return parseInt(pbal.textContent.replace(/[^0-9]/g,''),10) || 0; }

      // 베팅 금액/지뢰 개수는 다음 방문에도 그대로 쓰도록 기억해둔다 (매 라운드 재입력 방지)
      function savePrefs(){ try{ localStorage.setItem('mines_bet', betInput.value); localStorage.setItem('mines_mineCount', mineSelect.value); }catch(e){} }
      function loadPrefs(){
        try{
          var b=localStorage.getItem('mines_bet'); if(b) betInput.value=b;
          var m=localStorage.getItem('mines_mineCount'); if(m) mineSelect.value=m;
        }catch(e){}
      }
      function setBet(n){ if (betInput.disabled) return; betInput.value=Math.max(1, Math.floor(n)); savePrefs(); }
      loadPrefs();
      betInput.addEventListener('change', savePrefs);
      mineSelect.addEventListener('change', savePrefs);
      halfBtn.addEventListener('click', function(){ setBet(Number(betInput.value)/2); });
      doubleBtn.addEventListener('click', function(){ setBet(Number(betInput.value)*2); });
      // 빠른 금액 버튼은 칩을 쌓듯 현재 금액에 더한다 (다른 게임과 동일한 조작감)
      document.querySelectorAll('.chip-btn[data-amt]').forEach(function(b){
        b.addEventListener('click', function(){
          setBet((Number(betInput.value) || 0) + Number(b.getAttribute('data-amt')));
        });
      });

      // 베팅 중엔 조건을 못 바꾸게 잠그고, 끝나면 바로 다음 베팅을 받을 수 있게 연다 (재입력 없이 이어서 플레이)
      /* 라운드가 끝났으면 남은 칸을 더 못 누르게 한다.
         예전에는 잠그지 않아서, 캐시아웃한 뒤 아무 칸이나 누르면 서버가 400 을 주고
         그 문구("진행 중인 라운드가 없습니다")가 방금 딴 금액을 덮어썼다 — 이 게임에서
         가장 보고 싶은 줄이 실수 한 번에 사라졌다. */
      function lockBoard(){
        tiles.forEach(function(b){ if (b) b.disabled = true; });
      }
      function setIdle(){
        lockBoard();
        betInput.disabled=false; mineSelect.disabled=false;
        halfBtn.disabled=doubleBtn.disabled=false;
        document.querySelectorAll('.chip-btn[data-amt]').forEach(function(b){ b.disabled=false; });
        startBtn.style.display='inline-flex'; cashoutBtn.style.display='none';
      }
      function setActive(){
        betInput.disabled=true; mineSelect.disabled=true;
        halfBtn.disabled=doubleBtn.disabled=true;
        document.querySelectorAll('.chip-btn[data-amt]').forEach(function(b){ b.disabled=true; });
        startBtn.style.display='none'; cashoutBtn.style.display='inline-flex';
      }

      function clearPendingReveals(){ pendingTimers.forEach(function(id){ clearTimeout(id); }); pendingTimers=[]; }

      function buildGrid(revealed){
        clearPendingReveals();
        // 지난 판의 퍼펙트 카드를 치운다 — 새 판 위에 남아 있으면 보드를 가린다
        var pf = grid.parentNode && grid.parentNode.querySelector('.mn-perfect');
        if (pf) pf.parentNode.removeChild(pf);
        grid.innerHTML=''; grid.classList.remove('shake'); tiles=[];
        var revealedSet={}; (revealed||[]).forEach(function(i){ revealedSet[i]=true; });
        for (var i=0;i<${TILE_COUNT};i++){
          (function(i){
            var b=document.createElement('button');
            b.type='button'; b.className='mines-tile';
            if (revealedSet[i]) {
              b.disabled=true; b.classList.add('safe'); b.innerHTML=ICONS.coin;
            } else {
              b.innerHTML='<span class="mark">'+ICONS.mark+'</span>';
              b.addEventListener('click', function(){ reveal(i); });
            }
            tiles[i]=b;
            grid.appendChild(b);
          })(i);
        }
      }

      /* ── 퍼펙트 클리어 연출 ──────────────────────────────────────────
         남은 칸은 전부 지뢰다(안전 칸을 하나도 남기지 않았으므로). 그걸 한꺼번에 열어
         "내가 이 전부를 피했다"를 보이게 한다. 터진 지뢰(.mine)와는 다른 모양으로 둔다 —
         같은 붉은색으로 칠하면 이긴 판이 진 판처럼 보인다. */
      function revealAllMines(round){
        var mines = round.minePositions || [];
        mines.forEach(function(m, idx){
          var b = tiles[m]; if (!b) return;
          // 한 칸씩 짧은 간격으로 뒤집는다 — 스물넷이 동시에 뒤집히면 무슨 일인지 안 보인다
          pendingTimers.push(setTimeout(function(){
            b.disabled = true;
            b.classList.remove('safe','mine');
            b.innerHTML = ICONS.bomb;
            void b.offsetWidth;
            b.classList.add('dud');
          }, 40 + idx * 45));
        });
      }

      /* 보드 가운데 떠오르는 카드. 이모지는 쓰지 않는다 — OS 마다 모양이 달라 크기와
         정렬이 제각각이고, 이 화면의 다른 그림은 전부 선 아이콘이다. */
      function perfectCard(round){
        var stage = grid.parentNode; if (!stage) return;
        var old = stage.querySelector('.mn-perfect');
        if (old) old.parentNode.removeChild(old);
        var el = document.createElement('div');
        el.className = 'mn-perfect';
        el.innerHTML = '<div class="mn-pf-t">PERFECT CLEAR<\/div>'
          + '<div class="mn-pf-s">지뢰 ' + round.mineCount + '개 완파<\/div>'
          + '<div class="mn-pf-rows">'
          +   '<div><span>최종 배당<\/span><b class="num">' + round.multiplier.toFixed(2) + 'x<\/b><\/div>'
          +   '<div><span>획득<\/span><b class="num win">+' + fmt(round.payout) + '<\/b><\/div>'
          + '<\/div>';
        stage.appendChild(el);
        requestAnimationFrame(function(){ el.classList.add('in'); });
        /* 다음 판을 시작하면 치운다. 시간으로 지우지 않는 이유: 이 카드는 결과 표시라
           읽는 동안 사라지면 안 되고, 남아 있어도 다음 판을 막지 않는다. */
      }

      /* 금빛 파티클. 캔버스로 그린다 — 글자나 이모지를 뿌리면 화면마다 다르게 보이고,
         DOM 요소 수십 개를 움직이면 폰에서 눈에 띄게 버벅인다.
         1.5초만 돌고 스스로 사라진다. 움직임을 줄이는 설정을 켠 사람에게는 아예 안 띄운다. */
      function confetti(){
        try {
          if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        } catch (e) { }
        var cv = document.createElement('canvas');
        cv.className = 'mn-confetti';
        document.body.appendChild(cv);
        var dpr = Math.min(2, window.devicePixelRatio || 1);
        var W = cv.width = Math.floor(innerWidth * dpr), H = cv.height = Math.floor(innerHeight * dpr);
        var g = cv.getContext('2d');
        if (!g) { document.body.removeChild(cv); return; }
        var COLORS = ['#d4af37','#f0d67a','#f7e199','#c8a52f','#ffffff'];
        var N = innerWidth < 520 ? 70 : 130;
        var ps = [];
        for (var i = 0; i < N; i++) {
          ps.push({
            // 화면 위쪽 가로 전체에서 아래로 흩뿌린다
            x: Math.random() * W, y: -Math.random() * H * 0.3,
            vx: (Math.random() - 0.5) * 2.2 * dpr, vy: (2 + Math.random() * 3.4) * dpr,
            w: (4 + Math.random() * 5) * dpr, h: (7 + Math.random() * 9) * dpr,
            rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.32,
            c: COLORS[Math.floor(Math.random() * COLORS.length)]
          });
        }
        var DUR = 1500, t0 = null, raf = 0;
        function frame(t){
          if (t0 === null) t0 = t;
          var p = (t - t0) / DUR;
          if (p >= 1) { cancelAnimationFrame(raf); if (cv.parentNode) cv.parentNode.removeChild(cv); return; }
          g.clearRect(0, 0, W, H);
          // 끝으로 갈수록 사라진다 — 툭 끊기면 지워진 것이 아니라 고장난 것처럼 보인다
          g.globalAlpha = p < 0.75 ? 1 : (1 - p) / 0.25;
          for (var k = 0; k < ps.length; k++) {
            var q = ps[k];
            q.x += q.vx; q.y += q.vy; q.vy += 0.06 * dpr; q.rot += q.vr;
            g.save(); g.translate(q.x, q.y); g.rotate(q.rot);
            g.fillStyle = q.c; g.fillRect(-q.w / 2, -q.h / 2, q.w, q.h);
            g.restore();
          }
          raf = requestAnimationFrame(frame);
        }
        raf = requestAnimationFrame(frame);
      }

      function markTile(i, kind){
        var b=tiles[i]; if (!b) return;
        b.disabled=true; b.classList.remove('safe','mine'); b.innerHTML=kind==='mine'?ICONS.bomb:ICONS.coin;
        void b.offsetWidth; b.classList.add(kind);
      }

      function updateStats(round){
        multiEl.textContent = round.multiplier.toFixed(2) + 'x';
        /* 서버가 보낸 실제 지급액을 그대로 적는다. 예전에는 여기서 베팅액 × 배수를
           다시 곱했는데, 그 배수는 네 자리로 자른 표시용이라 실제로 나가는 금액과
           달랐다 — 화면이 적어 둔 금액과 통장이 어긋나면 그건 화면의 잘못이다. */
        potEl.textContent = fmt(round.potAmount != null ? round.potAmount
          : Math.floor(round.betAmount * round.multiplier));
        // 0칸 캐시아웃은 1.00x = 전액 환불이므로, 버튼 문구로 그 의미를 분명히 알려준다
        cashoutBtn.textContent = round.revealed.length === 0 ? '베팅 취소 (전액 환불)' : '캐시아웃';
      }

      async function post(url, body){
        var r = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: body ? JSON.stringify(body) : undefined });
        var data = await r.json();
        return { ok: r.ok, data: data };
      }

      async function start(){
        msg.innerHTML='';
        savePrefs();
        var bet = Number(betInput.value), mineCount = Number(mineSelect.value);
        var res = await post('/api/games/mines/start', { betAmount: bet, mineCount: mineCount });
        if (!res.ok) { msg.textContent = res.data.error || '오류가 발생했습니다'; return; }
        setBalance(res.data.balance);
        setActive();
        buildGrid([]);
        updateStats(res.data.round);
      }

      async function reveal(i){
        var tileBtn = tiles[i];
        if (!tileBtn || tileBtn.disabled) return;
        var res = await post('/api/games/mines/reveal', { tile: i });
        if (!res.ok) { msg.textContent = res.data.error || '오류가 발생했습니다'; return; }
        var round = res.data.round;
        if (res.data.busted) {
          markTile(i, 'mine');
          replay(grid, 'shake');
          if (window.casinoSfx) window.casinoSfx.boom(0.16, 1); // 내가 밟은 지뢰: 제일 크게
          // 나머지 지뢰가 순차 공개될 때 연쇄 폭발음을 얹는다. 지뢰가 많을 때(최대 24개) 기관총처럼
          // 시끄러워지지 않도록 소리는 앞쪽 몇 개까지만, 갈수록 작고 낮게 — 잔향처럼 들리게 한다.
          var SFX_MAX = 4;
          var mines = round.minePositions || [], delay = 70, k = 0;
          mines.forEach(function(m){
            if (m === i) return;
            var idx = k++;
            pendingTimers.push(setTimeout(function(){
              markTile(m, 'mine');
              if (idx < SFX_MAX && window.casinoSfx) {
                window.casinoSfx.boom(0.085 / (idx + 1), 0.85 - idx * 0.12);
              }
            }, delay));
            delay += 90;
          });
          /* 안 열었던 칸은 그대로 둔다.

             한때 여기서 남은 안전 칸까지 전부 금화로 까 놓았다. "판이 어떻게 생겼었나"
             를 보여 주려던 것인데, 화면에서는 정반대로 읽혔다 — 내가 실제로 연 금화와
             안 열어 본 금화가 같은 모양으로 섞여서, 어디까지 가다 밟았는지가 사라졌다.

             이 마지막 화면이 답해야 하는 것은 하나다: "지뢰가 어디 있었나".
             금화는 내가 연 것만 남아야 그 답이 읽힌다. */
          msg.innerHTML = '<span style="color:var(--lose);font-weight:700">지뢰 적중</span> — 베팅액을 잃었습니다.';
          setBalance(res.data.balance); setIdle();
        } else if (res.data.autoCashedOut) {
          markTile(i, 'safe');
          /* 여기가 버그였다: updateStats 를 부르지 않아 배당·획득 칸이 직전 값에 멈춰 있었다.
             안전 칸이 하나뿐인 판(지뢰 24개)에서는 그 값이 1.00x·0P 라, 이 게임에서 가장 큰
             순간에 화면이 "아무 일도 없었다"고 적고 있었다. 정산된 라운드를 그대로 넣는다 —
             round.multiplier 와 payout 은 서버가 계산한 최종값이다. */
          updateStats(round);
          replay(multiEl, 'bump'); replay(potEl, 'bump');
          revealAllMines(round);
          perfectCard(round);
          confetti();
          msg.innerHTML = '<span style="color:var(--gold);font-weight:700">퍼펙트 클리어</span> — 자동 캐시아웃 +' + fmt(round.payout) + ' (잔액 ' + fmt(res.data.balance) + ')';
          setBalance(res.data.balance); setIdle(); if (card) replay(card, 'gold-flash');
          if (pbal) replay(pbal, 'bump');
          /* 승리음 대신 퍼펙트 전용 음악. 이 순간에만 쓰므로 다른 캐시아웃과 소리가 갈린다 —
             같은 소리를 내면 "전부 열었다"가 그냥 한 번의 캐시아웃으로 들린다. */
          if (window.casinoSfx) window.casinoSfx.minePerfect();
        } else {
          markTile(i, 'safe');
          updateStats(round);
          replay(multiEl, 'bump'); replay(potEl, 'bump');
          if (window.casinoSfx) window.casinoSfx.safe();
        }
      }

      async function cashout(){
        var res = await post('/api/games/mines/cashout');
        if (!res.ok) { msg.textContent = res.data.error || '오류가 발생했습니다'; return; }
        var round = res.data.round;
        setBalance(res.data.balance); setIdle();
        if (round.revealed.length === 0) {
          // 실제로 딴 게 없는 환불이므로 승리 연출(골드 플래시·효과음)은 넣지 않는다
          msg.innerHTML = '베팅을 취소하고 ' + fmt(round.payout) + '를 환불했습니다.';
          return;
        }
        /* 지뢰가 어디 있었는지 보여 준다. 안 보여 주면 "운이 좋았나"를 알 수가 없고,
           그걸 확인하려고 안 연 칸을 누르다가 딴 금액 문구를 지우곤 했다.
           폭발음은 얹지 않는다 — 이긴 판이다. */
        (round.minePositions || []).forEach(function(m, idx){
          pendingTimers.push(setTimeout(function(){ markTile(m, 'mine'); }, 60 + idx * 70));
        });
        msg.innerHTML = '<span style="color:var(--win);font-weight:700">캐시아웃 성공</span> — +' + fmt(round.payout) + ' (잔액 ' + fmt(res.data.balance) + ')';
        if (card) replay(card, 'gold-flash');
        if (pbal) replay(pbal, 'bump');
        if (window.casinoSfx) window.casinoSfx.win();
      }

      startBtn.addEventListener('click', start);
      cashoutBtn.addEventListener('click', cashout);

      if (window.__MINES_ACTIVE__) {
        var a = window.__MINES_ACTIVE__;
        betInput.value = a.betAmount; mineSelect.value = a.mineCount;
        setActive();
        buildGrid(a.revealed);
        updateStats(a);
      } else {
        setIdle();
        buildGrid([]);
      }
    })();

      // 우측 패널 랭킹 탭
      ${rankJs('m', 'mines')}
    </script>
    ${helpDialog("mnHelp", "지뢰찾기 규칙", RULES_HTML)}`;
  return layout('지뢰찾기', 'lobby', body);
}
