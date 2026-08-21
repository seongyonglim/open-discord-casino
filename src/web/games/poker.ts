// 포커 플립: 텍사스 홀덤 규칙으로 Master/Shark의 홀카드 2장씩을 먼저 공개하고,
// 보드 5장을 뒤집기 전에 여러 시장에 베팅한다. 이후 플랍 3장 → 턴 → 리버 순서로 공개된다.
//
// 시장 (동시에 여러 개 베팅 가능, 칩을 쌓는 방식)
//   · master / shark : 누가 이기는지. 무승부면 원금 환불 (무승부 자체에 거는 시장은 없다)
//   · b0 ~ b4        : 최종 등급 묶음 — 두 핸드 중 **더 높은** 등급 하나에만 적중한다.
//                      (한동안 여기에 "하나라도" 라고 적혀 있었는데, 그러면 한 라운드에
//                       두 묶음이 동시에 터진다는 뜻이 되어 배당 계산과 어긋난다.)
//
// 배당은 공개된 홀카드로부터 남은 48장 전수 계산(C(48,5)=1,712,304)으로 정확히 산출한다.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomInt } from 'node:crypto';
import {
  advancePokerRound, stackPokerBet, clearPokerBets, getPokerBets, getMyPokerBets,
  getPokerPlayers, getRecentPokerResults, getPokerDrought, getWebUser,
  POKER_TURN_SEC, POKER_RIVER_SEC, POKER_SETTLE_SEC, POKER_REVEAL_SEC,
  POKER_KEEP_ROUNDS,
  type PokerRoundRow, type WebUser,
  chatTick,
} from '../../db/queries';
import {
  computeFlipProbabilities, computeFlipProbabilitiesYielding, oddsFromProbability, oddsForWinMarket, dealFlip,
  evaluate7, scoreCategory, categoryBucket, cardToString, CAT_NAMES, BUCKET_NAMES,
} from '../../services/poker';
import { readJson, sendJson } from '../http';
import { award, withUnlocked, withCommon, commonAwards } from '../achieve-hook';
import { layout, jsonForScript, sidePanel, rankPane, rankJs, helpDialog } from '../views';
import { ASSET_V } from '../assets';
import { gameSwitcher } from '../pages';
/* 브라우저로 나가는 인라인 스크립트의 조각들. 아래에서 원래 순서로 이어 붙인다 —
   순서가 곧 산출물이므로 바꾸지 말 것. */
import { pkHead } from './poker-client/head';
import { PK_CARDS_JS } from './poker-client/cards';
import { PK_CHIPS_JS } from './poker-client/chips';
import { PK_MARKETS_JS } from './poker-client/markets';
import { pkLoop } from './poker-client/loop';

/* 감사(scripts/audit-economy.ts)가 이 값을 그대로 읽는다. 예전에는 감사가 0.05 를
   손으로 적어 두어서, 실제로 팔리는 배당을 한 번도 검사하지 않았다 — 여기를
   고쳐도 감사는 옛 값으로 계속 통과했다. */
export const HOUSE_EDGE = 0.01;
// 앞의 3단(10·100·500)은 동전, 뒤의 3단(1000·5000·1만)은 골드바로 그린다
export const COIN_SIZES = [10, 100, 500, 1000, 5000, 10000];

// 무승부 시장은 두지 않는다. 무승부가 나면 master/shark 베팅은 원금을 그대로 돌려준다
// (배당 계산에서 무승부 확률을 빼는 oddsForWinMarket이 그 환불분을 이미 반영한다).
interface MarketOdds {
  master: number | null;
  shark: number | null;
  buckets: (number | null)[];
  prob: { master: number; shark: number; tie: number; buckets: number[] };
}

interface PreparedRound { hole: number[]; board: number[]; odds: MarketOdds }

function toOdds(p: { masterWin: number; sharkWin: number; tie: number; buckets: number[] }): MarketOdds {
  return {
    master: oddsForWinMarket(p.masterWin, p.tie, HOUSE_EDGE),
    shark: oddsForWinMarket(p.sharkWin, p.tie, HOUSE_EDGE),
    buckets: p.buckets.map(b => oddsFromProbability(b, HOUSE_EDGE)),
    prob: { master: p.masterWin, shark: p.sharkWin, tie: p.tie, buckets: p.buckets },
  };
}

/* ── 다음 라운드 미리 계산 ────────────────────────────────────────────────
   배당 전수 계산(보드 171만 가지 × 핸드 2개)은 운영 환경에서 0.85초가 걸리고,
   서버가 단일 스레드라 그 사이 들어온 모든 요청이 함께 멈춘다.
   실측: 아무 일도 하지 않는 /health 응답이 평상시 39ms에서 새 라운드가 생기는 순간 854ms로 튀었고,
   같은 시점에 849바이트짜리 카드 SVG가 649ms씩 걸렸다.

   그래서 라운드가 필요해진 다음에 계산하지 않고, 응답을 보낸 뒤 한가할 때
   setImmediate로 끊어가며(한 조각 약 1ms) 다음 라운드를 미리 만들어 둔다.
   라운드 생성 시점에는 만들어 둔 값을 그대로 꺼내 쓰므로 지연이 없다.                     */
let readyRound: PreparedRound | null = null;
let building = false;

function dealAndBoard() {
  const { master, shark, deck } = dealFlip(randomInt);
  return { hole: [...master, ...shark], board: deck.slice(4, 9), master, shark };
}

// 논블로킹. 이미 준비돼 있거나 만드는 중이면 아무것도 하지 않는다.
export function prepareNextRound(): void {
  if (readyRound || building) return;
  building = true;
  const { hole, board, master, shark } = dealAndBoard();
  computeFlipProbabilitiesYielding(master[0], master[1], shark[0], shark[1])
    .then(p => { readyRound = { hole, board, odds: toOdds(p) }; })
    .catch(e => console.error('다음 포커 라운드 준비 실패:', e))
    .finally(() => { building = false; });
}

// 새 라운드 재료. 미리 만들어 둔 게 있으면 즉시 반환하고, 없으면 그 자리에서 계산한다(첫 라운드 등).
function makeRound(): PreparedRound {
  if (readyRound) {
    const r = readyRound;
    readyRound = null;
    return r;
  }
  const { hole, board, master, shark } = dealAndBoard();
  return { hole, board, odds: toOdds(computeFlipProbabilities(master[0], master[1], shark[0], shark[1])) };
}

// 라운드 정산: 양쪽 7장을 평가해 승자와 등급 묶음을 확정한다
function resolveRound(hole: number[], board: number[]) {
  const [m0, m1, s0, s1] = hole;
  const [b0, b1, b2, b3, b4] = board;
  const ms = evaluate7(m0, m1, b0, b1, b2, b3, b4);
  const ss = evaluate7(s0, s1, b0, b1, b2, b3, b4);
  const mCat = scoreCategory(ms), sCat = scoreCategory(ss);
  const mBucket = categoryBucket(mCat), sBucket = categoryBucket(sCat);
  const winner: 'master' | 'shark' | 'tie' = ms > ss ? 'master' : ss > ms ? 'shark' : 'tie';
  return {
    winner,
    // 등급 시장은 배타적 — 두 핸드 중 더 높은 등급 하나만 적중한다
    buckets: [mBucket > sBucket ? mBucket : sBucket],
    detail: { masterCat: mCat, sharkCat: sCat },
    masterCat: mCat,
    sharkCat: sCat,
  };
}

/* 서버 전진 타이머(src/tick.ts)도 이 함수를 부른다. 헬퍼를 밖으로 열지 않고
   이 한 함수만 내보내는 이유가 그것이다 — 어떤 규칙으로 전진하는지는 이 모듈이
   쥐고 있어야 하고, 부르는 쪽은 "포커 플립을 전진시켜라"만 알면 된다. */
export function advance(): PokerRoundRow {
  return advancePokerRound(makeRound, resolveRound, BUCKET_NAMES.length);
}

// 공개 범위: 플랍 3장 → 턴 4장 → 리버 5장. 공개 전 카드는 절대 클라이언트로 내려보내지 않는다.
function visibleBoardCount(phase: string): number {
  switch (phase) {
    case 'betting': return 0;
    case 'flop': return 3;
    case 'turn': return 4;
    default: return 5; // river, done
  }
}

function secondsLeft(round: PokerRoundRow): number {
  const now = Math.floor(Date.now() / 1000);
  if (round.phase === 'betting') return Math.max(0, round.betting_ends_at - now);
  if (round.phase === 'done') return Math.max(0, (round.resolved_at ?? now) + POKER_REVEAL_SEC - now);
  // 공개 진행 중 — 다음 단계까지 남은 초
  const e = now - round.betting_ends_at;
  const next = e < POKER_TURN_SEC ? POKER_TURN_SEC
    : e < POKER_RIVER_SEC ? POKER_RIVER_SEC : POKER_SETTLE_SEC;
  return Math.max(0, next - e);
}

function statePayload(round: PokerRoundRow, userId: string) {
  const hole = JSON.parse(round.hole_json) as number[];
  const board = JSON.parse(round.board_json) as number[];
  const odds = JSON.parse(round.odds_json) as MarketOdds;
  const vis = visibleBoardCount(round.phase);
  const result = round.result_json ? JSON.parse(round.result_json) : null;

  return {
    ok: true,
    round: {
      id: round.id,
      phase: round.phase,
      secondsLeft: secondsLeft(round),
      hole: hole.map(cardToString),
      board: board.slice(0, vis).map(cardToString), // 공개된 만큼만
      odds: { master: odds.master, shark: odds.shark, buckets: odds.buckets },
      prob: odds.prob,
      result: result
        ? {
            winner: result.winner,
            buckets: result.buckets,
            masterCat: CAT_NAMES[result.masterCat ?? result.detail?.masterCat],
            sharkCat: CAT_NAMES[result.sharkCat ?? result.detail?.sharkCat],
          }
        : null,
    },
    me: userId,
    bets: getPokerBets(round.id),
    myBets: getMyPokerBets(round.id, userId),
    players: getPokerPlayers(round.id),
    // 등급별 점등 전적(b0~b2)을 위해 보관 라운드 전체를 내려준다 (최신이 앞)
    history: getRecentPokerResults(POKER_KEEP_ROUNDS),
    /* 미출현 판수는 기록에서 세지 않는다. 보관이 30판이라 그 너머는 «29판+» 로 잘렸고,
       판수 자체가 이 게임의 재미인데 상한에 걸려 뭉개졌다. 서버가 세어 둔 값을 준다 —
       다섯 줄뿐이라 응답이 무거워지지도 않는다. */
    drought: getPokerDrought(),
    balance: getWebUser(userId)?.balance ?? 0,
    /* 채팅은 폴링을 새로 만들지 않는다 — 이 숫자 하나(마지막 메시지 id)만 얹고,
       화면은 값이 늘었을 때만 /api/chat 을 부른다. 조용하면 요청이 안 는다. */
    ...chatTick(),
    coins: COIN_SIZES,
    bucketNames: BUCKET_NAMES,
  };
}

export async function handleState(_req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const round = advance();
  sendJson(res, 200, { ...statePayload(round, userId), ...flipAwards(round.id, userId) });
  // 응답을 보낸 뒤에 다음 라운드를 미리 만들어 둔다 (논블로킹 · 이미 준비됐으면 즉시 반환)
  prepareNextRound();
}

/* ── 도전과제: 한탕주의자 ──────────────────────────────────────────
   완성 족보 예측 중 가장 희귀한 칸(포카드 이상 — 포카드·스트레이트 플러시·로열
   플러시)에 걸어 맞힌다.

   정산 자리가 아니라 여기서 본다. 정산은 라운드를 전진시키는 쪽에서 도는데 그건
   누구의 요청인지 정해져 있지 않고(먼저 폴링한 사람이 남의 판까지 정산한다),
   토스트를 띄우려면 그 사람 자신의 응답에 실려야 한다.

   시장 이름은 'b' + 칸 번호다. 마지막 칸이 '포카드 이상'이므로 번호를 박지 않고
   BUCKET_NAMES 의 길이에서 구한다 — 칸이 하나 늘면 번호가 밀린다. */
const HIGH_BUCKET = `b${BUCKET_NAMES.length - 1}`;

function flipAwards(roundId: number, userId: string) {
  const mine = getMyPokerBets(roundId, userId).filter(b => b.market === HIGH_BUCKET && b.won === 1);
  // 적중이 없어도 공통 과제는 봐야 한다 — 되살아난 것은 이 판의 결과와 무관하다
  if (!mine.length) return withUnlocked(commonAwards(userId));
  /* 여러 번 걸 수 있으니 가장 크게 건 것을 기준으로 본다 — 문지기가 "그 판에 얼마를
     걸었나"를 묻는 것이라, 같은 판의 작은 베팅 때문에 막히면 뜻이 어긋난다. */
  const top = Math.max(...mine.map(b => b.amount));
  return withCommon(userId, award(userId, top, [['pk-quads-plus', () => true]]));
}

const VALID_MARKETS = new Set(['master', 'shark', 'b0', 'b1', 'b2', 'b3', 'b4']);

export async function handleBet(req: IncomingMessage, res: ServerResponse, userId: string, username: string): Promise<void> {
  // 본문 파싱(await)을 먼저 — 검증과 쓰기 사이에 await가 끼면 그 틈에 라운드가 넘어갈 수 있다
  const data = await readJson(req);
  const market = String(data?.market ?? '');
  const amount = Math.floor(Number(data?.amount));
  if (!VALID_MARKETS.has(market)) return sendJson(res, 400, { error: '알 수 없는 베팅 시장입니다' });
  if (!Number.isFinite(amount) || amount < 1) return sendJson(res, 400, { error: '베팅 금액은 1P 이상이어야 합니다' });
  if (!COIN_SIZES.includes(amount)) return sendJson(res, 400, { error: '코인 단위가 올바르지 않습니다' });

  const round = advance();
  if (round.phase !== 'betting') return sendJson(res, 400, { error: '베팅이 마감되었습니다. 다음 라운드를 기다려주세요.' });

  // 배당은 서버가 보관한 값을 쓴다 (클라이언트가 보낸 배당은 신뢰하지 않음)
  const odds = JSON.parse(round.odds_json) as MarketOdds;
  const marketOdds = market === 'master' ? odds.master
    : market === 'shark' ? odds.shark
    : odds.buckets[Number(market.slice(1))];
  if (marketOdds == null) return sendJson(res, 400, { error: '이 시장은 이번 라운드에 베팅할 수 없습니다' });

  const result = stackPokerBet(userId, username, round.id, market, amount, marketOdds);
  if (!result.ok) {
    return sendJson(res, 400, {
      error: result.error === 'closed' ? '베팅이 마감되었습니다. 다음 라운드를 기다려주세요.' : '잔액이 부족합니다',
    });
  }
  return sendJson(res, 200, { ok: true, balance: result.balance, staked: result.staked });
}

export async function handleClear(_req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const round = advance();
  const result = clearPokerBets(userId, round.id);
  if (!result.ok) {
    return sendJson(res, 400, {
      error: result.error === 'no_bet' ? '올린 칩이 없습니다' : '베팅이 마감되어 회수할 수 없습니다',
    });
  }
  return sendJson(res, 200, { ok: true, balance: result.balance, refunded: result.refunded });
}

/* 규칙 도움말. 배당은 고정값이 아니라 매 판 계산되므로 숫자를 적지 않는다 —
   여기에 예시 배당을 적으면 화면과 어긋난다. HOUSE_EDGE 0.01 · MAX_ODDS 3000.
   단계 초는 POKER_BETTING_SEC 15 · TURN 2 · RIVER 4 · SETTLE 7. */
const RULES_HTML = `
  <h4>목표</h4>
  <p>홀덤 두 핸드 <b>MASTER</b> 와 <b>SHARK</b> 가 겨룹니다. 카드를 직접 받지 않고
     <b>어느 쪽이 이길지</b> 또는 <b>어떤 등급이 완성될지</b>에 칩을 겁니다.</p>

  <h4>두 종류의 시장</h4>
  <ul>
    <li><b>승자</b> — MASTER / SHARK. 무승부면 <b>원금을 그대로 돌려받습니다</b></li>
    <li><b>완성 등급</b> — 이긴 핸드의 최종 족보가 어느 묶음에 드는가</li>
  </ul>

  <h4>등급 묶음</h4>
  <table>
    <tr><td>하이카드 · 원페어</td><td>가장 흔함</td></tr>
    <tr><td>투페어</td><td></td></tr>
    <tr><td>트리플 · 스트레이트 · 플러시</td><td></td></tr>
    <tr><td>풀하우스</td><td></td></tr>
    <tr><td>포카드 이상</td><td>가장 드묾</td></tr>
  </table>

  <h4>배당은 매 판 새로 계산됩니다</h4>
  <p>고정 배당표가 없습니다. 지금 공개된 카드로 <b>남은 덱을 전부 세어</b> 확률을 구하고,
     그 확률에서 배당을 만듭니다. 그래서 카드가 한 장 열릴 때마다 배당이 움직입니다.</p>

  <h4>진행</h4>
  <ul>
    <li>베팅 <b>15초</b> → 플랍 3장 → 턴 → 리버 → 정산</li>
    <li>베팅은 <b>처음 15초에만</b> 받습니다. 카드가 열리기 시작하면 더 걸 수 없습니다</li>
  </ul>

  <p class="tip"><b>꿀팁 —</b> 배당이 높다는 건 그만큼 잘 안 나온다는 뜻입니다.
     확률에서 만든 값이라 어느 쪽을 골라도 기대값은 같습니다.</p>

  <h4>이 판의 규격</h4>
  <p class="spec">매치업마다 배당 재계산 · 최대 3,000배</p>
`;

export function pokerPage(user: WebUser): string {
  const body = `
    ${gameSwitcher('poker', 'pfHelp')}
    <div class="game-shell poker-shell">
      <div class="game-main">
        <div class="card">
          <div class="poker-table">
            <div class="poker-seats">
              <div class="seat">
                <div class="seat-name master">MASTER</div>
                <div id="pMasterCards" class="hand"></div>
                <div id="pMasterCat" class="seat-cat"></div>
              </div>
              <div class="board-wrap">
                <div id="pStatus" class="poker-status"></div>
                <div id="pBoard" class="board"></div>
              </div>
              <div class="seat">
                <div class="seat-name shark">SHARK</div>
                <div id="pSharkCards" class="hand"></div>
                <div id="pSharkCat" class="seat-cat"></div>
              </div>
            </div>
          </div>
          <div id="pMarkets" class="market-grid"></div>
        </div>
        <!-- 칩과 Clear만 한 줄에 둔다.
             올린 칩·참가자수·총액은 오른쪽 참가자 패널에 이미 다 나오고,
             안내 문구는 나타났다 사라질 때마다 칩 위치를 밀어서 아예 넣지 않는다.
             (승패·회수 결과는 사운드·잔액 애니메이션·참가자 패널 금액으로 전달된다) -->
        <div class="card game-controls poker-controls">
          <div class="coin-row" id="pCoins"></div>
          <button id="pClear" class="btn" type="button">초기화</button>
        </div>
      </div>
      ${sidePanel('p', `
        <div class="side-head"><span>참가자</span><span id="pPot" class="num">0P</span></div>
        <div id="pRoster" class="roster"><div class="empty" style="padding:16px 0">아직 참가자가 없습니다</div></div>
      `, rankPane('p'))}
    </div>
    <script>window.__ME__ = ${jsonForScript(user.username)}; window.__MEID__ = ${jsonForScript(user.id)};
      window.__SFX_NEED__ = ['coin','gain','card','shuffle','deal'];
      window.__CHAT_WHERE__ = 'poker';</script>
    <script>
${pkHead(JSON.stringify(ASSET_V))}${PK_CARDS_JS}${PK_CHIPS_JS}${PK_MARKETS_JS}${pkLoop(rankJs('p', 'poker'))}
    </script>
    ${helpDialog("pfHelp", "포커 플립 규칙", RULES_HTML)}`;
  return layout('포커 플립', 'lobby', body);
}
