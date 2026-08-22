// 바카라(푼토 방코): 여러 유저가 같은 라운드에 함께 베팅하는 실시간 공용 게임.
//
// 포커 플립과 화면 구조·칩 조작은 같지만, 게임 원리가 다르다:
//   · 플레이어가 내리는 선택이 하나도 없다. 몇 장을 더 받을지가 규칙 표로 고정돼 있다.
//   · 그래서 확률이 매 라운드 똑같고, 배당도 고정이다(포커처럼 라운드마다 다시 계산하지 않는다).
//   · 대신 "무엇이 나올지"가 아니라 "어느 쪽에 걸지"만 정하면 되므로 판단이 빠르고 회전이 빠르다.
//
// 시장 5개: 플레이어 / 뱅커 / 타이 + 사이드 베팅 P페어 · B페어.
// 무승부가 나면 플레이어·뱅커 베팅은 원금을 그대로 돌려준다(배당 계산이 그 환불분을 이미 반영한다).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomInt } from 'node:crypto';
import {
  advanceBaccaratRound, stackBaccaratBet, clearBaccaratBets,
  getBaccaratBets, getBaccaratPlayers, getMyBaccaratBets, getRecentBaccaratResults, getWebUser,
  BACC_THIRD_SEC, BACC_SETTLE_SEC, BACC_REVEAL_SEC,
  type BaccRoundRow, type BaccOutcome, type WebUser,
  chatTick,
} from '../../db/queries';
import { baccaratProbabilities, drawRound, playRound, cardsToStrings, handTotal } from '../../services/baccarat';
import { oddsFromProbability, oddsForWinMarket } from '../../services/poker';
import { readJson, sendJson } from '../http';
import { award, withUnlocked, withCommon, commonAwards } from '../achieve-hook';
import { getStreak } from '../../db/streaks';
import { BACC_STREAK_MIN_BET } from '../../db/queries/bacc';
import { layout, jsonForScript, sidePanel, rankPane, rankJs, helpDialog } from '../views';
import { ASSET_V } from '../assets';
import { gameSwitcher } from '../pages';
import { COIN_SIZES } from './poker';
/* 브라우저로 나가는 인라인 스크립트의 조각들. 아래에서 원래 순서로 이어 붙인다 —
   순서가 곧 산출물이므로 바꾸지 말 것. */
import { bcHead } from './baccarat-client/head';
import { BC_CARDS_JS } from './baccarat-client/cards';
import { BC_REVEAL_JS } from './baccarat-client/reveal';
import { BC_MARKETS_JS } from './baccarat-client/markets';
import { BC_CHIPS_JS } from './baccarat-client/chips';
import { BC_ROSTER_JS } from './baccarat-client/roster';
import { bcLoop } from './baccarat-client/loop';

const HOUSE_EDGE = 0.01;

/* ── 배당 ────────────────────────────────────────────────────────────────
   확률이 고정이므로 배당도 고정이다. 프로세스 시작 때 한 번만 구해 캐시한다.
   플레이어·뱅커는 무승부가 환불이라 oddsForWinMarket(환불분을 빼고 계산)을 쓴다. */
export interface BaccOdds {
  player: number; banker: number; tie: number; ppair: number; bpair: number;
}

let oddsCache: BaccOdds | null = null;

export function baccaratOdds(): BaccOdds {
  if (oddsCache) return oddsCache;
  const p = baccaratProbabilities();
  // 확률이 0이 되는 시장이 없으므로 여기서 null이 나올 수 없다. 그래도 타입을 좁혀 둔다.
  const need = (v: number | null, name: string): number => {
    if (v == null) throw new Error(`바카라 ${name} 배당을 계산할 수 없습니다`);
    return v;
  };
  const pair = need(oddsFromProbability(p.pair, HOUSE_EDGE), 'pair');
  oddsCache = {
    player: need(oddsForWinMarket(p.player, p.tie, HOUSE_EDGE), 'player'),
    banker: need(oddsForWinMarket(p.banker, p.tie, HOUSE_EDGE), 'banker'),
    tie: need(oddsFromProbability(p.tie, HOUSE_EDGE), 'tie'),
    ppair: pair, bpair: pair,
  };
  return oddsCache;
}

const VALID_MARKETS = new Set(['player', 'banker', 'tie', 'ppair', 'bpair']);

/* ── 라운드 진행 ─────────────────────────────────────────────────────── */

function resolve(cards: number[]): BaccOutcome {
  const o = playRound(cards);
  return {
    winner: o.winner,
    playerTotal: o.playerTotal, bankerTotal: o.bankerTotal,
    playerPair: o.playerPair, bankerPair: o.bankerPair,
    natural: o.natural,
    playerCards: o.playerCards, bankerCards: o.bankerCards,
  };
}

function advance(): BaccRoundRow {
  return advanceBaccaratRound(() => drawRound(randomInt), resolve);
}

/* 공개 범위: 마감 즉시 양쪽 두 장 → 세 번째 카드 → 정산.
   공개 전 카드는 절대 클라이언트로 내려보내지 않는다(미리 알면 게임이 성립하지 않는다).

   끗수는 보이는 카드만으로 그때그때 계산한다. 정산 결과(result_json)를 기다렸다가 쓰면
   카드가 다 나온 뒤에도 큰 숫자가 '–'로 남아, 정작 결론이 제일 늦게 보인다.
   첫 두 장의 끗수는 "세 번째 카드가 올지"를 가늠하는 정보라 실제 테이블에서도 바로 보여준다. */
interface VisibleHands { player: string[]; banker: string[]; playerTotal: number | null; bankerTotal: number | null }

function visible(round: BaccRoundRow): VisibleHands {
  if (round.phase === 'betting') {
    return { player: [], banker: [], playerTotal: null, bankerTotal: null };
  }
  const o = playRound(JSON.parse(round.cards_json) as number[]);
  // deal 단계에서는 첫 두 장까지만
  const n = round.phase === 'deal' ? 2 : 3;
  const p = o.playerCards.slice(0, n);
  const b = o.bankerCards.slice(0, n);
  return {
    player: cardsToStrings(p),
    banker: cardsToStrings(b),
    playerTotal: handTotal(p),
    bankerTotal: handTotal(b),
  };
}

function secondsLeft(round: BaccRoundRow): number {
  const now = Math.floor(Date.now() / 1000);
  if (round.phase === 'betting') return Math.max(0, round.betting_ends_at - now);
  if (round.phase === 'done') return Math.max(0, (round.resolved_at ?? now) + BACC_REVEAL_SEC - now);
  const e = now - round.betting_ends_at;
  const next = e < BACC_THIRD_SEC ? BACC_THIRD_SEC : BACC_SETTLE_SEC;
  return Math.max(0, next - e);
}

function statePayload(round: BaccRoundRow, userId: string) {
  const vis = visible(round);
  const result = round.result_json ? JSON.parse(round.result_json) as BaccOutcome : null;
  const p = baccaratProbabilities();

  return {
    ok: true,
    round: {
      id: round.id,
      phase: round.phase,
      secondsLeft: secondsLeft(round),
      player: vis.player,
      banker: vis.banker,
      playerTotal: vis.playerTotal,
      bankerTotal: vis.bankerTotal,
      result: result && round.phase === 'done'
        ? {
            winner: result.winner,
            playerTotal: result.playerTotal, bankerTotal: result.bankerTotal,
            playerPair: result.playerPair, bankerPair: result.bankerPair,
            natural: result.natural,
          }
        : null,
    },
    odds: baccaratOdds(),
    prob: { player: p.player, banker: p.banker, tie: p.tie, pair: p.pair },
    coins: COIN_SIZES,
    me: userId,
    balance: getWebUser(userId)?.balance ?? 0,
    /* 채팅은 폴링을 새로 만들지 않는다 — 이 숫자 하나(마지막 메시지 id)만 얹고,
       화면은 값이 늘었을 때만 /api/chat 을 부른다. 조용하면 요청이 안 는다. */
    ...chatTick(),
    bets: getBaccaratBets(round.id),
    myBets: getMyBaccaratBets(round.id, userId),
    players: getBaccaratPlayers(round.id),
    history: getRecentBaccaratResults(20),
  };
}

export async function handleState(_req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  return sendJson(res, 200, { ...statePayload(advance(), userId), ...baccAwards(userId) });
}

/* ── 도전과제: 플레이어의 수호신 ──────────────────────────────────────
   연승은 정산 자리에서 쌓인다(그 판의 승패와 "플레이어에만 걸었나"는 거기서만 안다).
   여기서는 쌓인 값만 보고 과제를 연다 — 이 응답으로 나가야 화면이 토스트를 띄운다.

   문지기(1,000P)는 두 곳에 선다. 진짜 문은 연승을 쌓는 자리(queries/bacc)이고, 여기서
   한 번 더 재는 이유는 화면 때문이다: 과제의 min_bet 이 0 이면 카드에 «베팅 1,000P 이상»이
   안 붙어서, 규칙이 있는데 어디에도 안 적힌 상태가 된다(사다리와 같은 이유다).

   매 폴링마다 도는 자리지만 값싸다 — 연승이 7 미만이면 조회 한 번으로 끝난다. */
const PLAYER_STREAK_GOAL = 7;

function baccAwards(userId: string): { unlocked?: { id: string; title: string; description: string }[] } {
  if (getStreak(userId, 'bacc_player_win') < PLAYER_STREAK_GOAL) {
    return withUnlocked(commonAwards(userId));
  }
  return withCommon(userId, award(userId, BACC_STREAK_MIN_BET, [['bc-player-7', () => true]]));
}

export async function handleBet(req: IncomingMessage, res: ServerResponse, userId: string, username: string): Promise<void> {
  // 본문 파싱(await)을 먼저 끝낸다 — 라운드 확인과 베팅 사이에 await가 있으면 그 틈에
  // 라운드가 마감·정산되어 이미 끝난 라운드에 베팅이 들어갈 수 있다.
  const data = await readJson(req);
  const market = String(data?.market ?? '');
  const amount = Math.floor(Number(data?.amount));
  if (!VALID_MARKETS.has(market)) return sendJson(res, 400, { error: '알 수 없는 베팅 시장입니다' });
  if (!COIN_SIZES.includes(amount)) return sendJson(res, 400, { error: '코인 단위가 올바르지 않습니다' });

  const round = advance();
  if (round.phase !== 'betting') return sendJson(res, 400, { error: '베팅이 마감되었습니다. 다음 라운드를 기다려주세요.' });

  const odds = baccaratOdds()[market as keyof BaccOdds];
  const r = stackBaccaratBet(userId, username, round.id, market, amount, odds);
  if (!r.ok) {
    return sendJson(res, 400, {
      error: r.error === 'closed' ? '베팅이 마감되었습니다. 다음 라운드를 기다려주세요.' : '잔액이 부족합니다',
    });
  }
  return sendJson(res, 200, { ok: true, balance: r.balance, staked: r.staked });
}

export async function handleClear(_req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const round = advance();
  const r = clearBaccaratBets(userId, round.id);
  if (!r.ok) {
    return sendJson(res, 400, {
      error: r.error === 'nothing' ? '회수할 칩이 없습니다' : '베팅이 마감되어 회수할 수 없습니다',
    });
  }
  return sendJson(res, 200, { ok: true, balance: r.balance, refunded: r.refunded });
}

/* ── 화면 ────────────────────────────────────────────────────────────── */

/* 규칙 도움말.
   확률은 baccaratProbabilities()가 1덱 전수 계산으로 내는 값이고(플레이어 44.68 ·
   뱅커 45.96 · 타이 9.36 · 페어 5.88%), 배당은 거기서 HOUSE_EDGE 1%로 만든다.
   배당은 화면에서 실제 값을 보여주므로 여기에는 숫자를 박지 않는다 — 어긋날 수 있다. */
const RULES_HTML = `
  <h4>목표</h4>
  <p><b>플레이어</b>와 <b>뱅커</b> 중 카드 합이 <b>9에 가까운 쪽</b>이 이깁니다.
     나는 카드를 받지 않고 어느 쪽이 이길지에만 겁니다.</p>

  <h4>끗수</h4>
  <ul>
    <li><b>A</b> 1 · <b>2~9</b> 숫자 그대로 · <b>10 · J · Q · K</b> 0</li>
    <li>합이 두 자리면 <b>일의 자리만</b> 씁니다 (7 + 8 = 15 → <b>5</b>)</li>
  </ul>

  <h4>다섯 갈래에 걸 수 있습니다</h4>
  <table>
    <tr><td>플레이어 승</td><td>약 44.7%</td></tr>
    <tr><td>뱅커 승</td><td>약 46.0%</td></tr>
    <tr><td>타이 (무승부)</td><td>약 9.4%</td></tr>
    <tr><td>플레이어 페어 · 뱅커 페어</td><td>각 약 5.9%</td></tr>
  </table>
  <p>배당은 이 확률에서 만들어 화면에 표시됩니다.
     <b>플레이어·뱅커에 걸었는데 타이가 나오면 원금을 돌려받습니다.</b></p>

  <h4>카드는 한 벌(52장)입니다</h4>
  <p>매 판 <b>한 벌을 새로 섞어</b> 씁니다. 실제 카지노는 6~8벌을 쓰지만
     여기는 내부 친선 룰로 한 벌만 씁니다.</p>

  <h4>세 번째 카드</h4>
  <p>두 장씩 받은 뒤 규칙에 따라 <b>자동으로</b> 한 장을 더 받습니다.
     내가 고를 것은 없습니다 — 정해진 표대로 딜러가 처리합니다.</p>

  <p class="tip"><b>꿀팁 —</b> 뱅커가 플레이어보다 조금 자주 이깁니다(46.0% vs 44.7%).
     타이와 페어는 배당이 큰 만큼 드뭅니다.</p>

  <h4>이 판의 규격</h4>
  <p class="spec">1덱 · 최대 배당 16.83배 (페어)</p>
`;

export function baccaratPage(user: WebUser): string {
  const o = baccaratOdds();
  const p = baccaratProbabilities();

  const body = `
    ${gameSwitcher('baccarat', 'bcHelp')}
    <div class="game-shell">
      <div class="game-main">
        <div class="card">
          <!-- 제목과 구슬은 한 줄이다 — 범례는 걷었다(구슬에 P·B·T 가 이미 찍혀 있다) -->
          <div class="bacc-bead-head">
            <span class="bacc-bead-cap">최근 결과</span>
            <div id="bHistory" class="bacc-bead-row"></div>
          </div>

          <div class="bacc-table">
            <div id="bStatus" class="bacc-status">베팅을 기다리는 중…</div>
            <div class="bacc-seats">
              <div class="bacc-seat side-player" id="bPlayerSeat">
                <div class="bacc-name">PLAYER</div>
                <div id="bPlayerCards" class="bacc-hand"></div>
                <div id="bPlayerTotal" class="bacc-total wait">–</div>
              </div>
              <div class="bacc-vs">VS</div>
              <div class="bacc-seat side-banker" id="bBankerSeat">
                <div class="bacc-name">BANKER</div>
                <div id="bBankerCards" class="bacc-hand"></div>
                <div id="bBankerTotal" class="bacc-total wait">–</div>
              </div>
            </div>
          </div>

          <!-- 상자 골격은 스크립트가 통째로 그린다 — 칩 더미가 상자 안에 살기 때문에
               라운드/결과가 바뀔 때만 다시 그려야 쌓아둔 칩이 날아가지 않는다 -->
          <div class="market-grid" id="bMarkets"></div>
        </div>

        <div class="card game-controls poker-controls">
          <div class="coin-row" id="bCoins"></div>
          <button id="bClear" class="btn" type="button">초기화</button>
        </div>
      </div>

      ${sidePanel('b', `
        <div class="side-head"><span>참가자</span><span id="bPot" class="num">0P</span></div>
        <div id="bRoster" class="roster"><div class="empty" style="padding:16px 0">아직 참가자가 없습니다</div></div>
      `, rankPane('b'))}
    </div>
    <script>
      window.__ME__ = ${jsonForScript(user.username)};
      window.__MEID__ = ${jsonForScript(user.id)};
      /* chipbet · chipwin 을 여기 적지 않으면 첫 베팅이 «엉뚱한 소리» 를 낸다 —
         버퍼가 없으면 playSample 이 실패하고 대체 경로로 떨어져서, 칩 소리 대신
         합성음이나 코인 획득음이 울린다. coin 은 남긴다: 음량 슬라이더를 만질 때
         확인음으로 쓰인다. */
      window.__SFX_NEED__ = ['coin','gain','card','shuffle','deal','chipbet','chipwin'];
      window.__CHAT_WHERE__ = 'baccarat';
    </script>
    <script>
${bcHead(JSON.stringify(ASSET_V), jsonForScript(o), jsonForScript({ player: p.player, banker: p.banker, tie: p.tie, pair: p.pair }))}${BC_CARDS_JS}${BC_REVEAL_JS}${BC_MARKETS_JS}${BC_CHIPS_JS}${BC_ROSTER_JS}${bcLoop(rankJs('b', 'baccarat'))}
    </script>
    ${helpDialog("bcHelp", "바카라 규칙", RULES_HTML)}`;

  return layout('바카라', 'lobby', body);
}
