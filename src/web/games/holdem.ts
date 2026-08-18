/* 홀덤 데일리 프리롤 — 페이지와 API.
 *
 * 한 URL(/games/holdem)이 두 화면을 겸한다: 토너먼트가 진행 중이 아니면 로비,
 * 진행 중이고 내가 앉아 있으면 테이블. 상태에 따라 클라이언트가 갈아끼운다 —
 * 화면을 두 URL로 나누면 시작·종료 순간에 사용자가 직접 이동해야 한다.
 *
 * 히든 정보 규율 (다른 게임과 같다):
 *   · deck_json 은 어떤 단계에서도 내려보내지 않는다. 남은 카드가 새면 이후 판이 전부 무의미해진다.
 *   · 남의 홀 카드는 쇼다운 결과에 공개된 것만 내려보낸다. 진행 중에는 절대 안 된다.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  advanceHoldem, registerHoldem, unregisterHoldem, holdemAction, holdemSitIn, touchHoldemPresence,
  getTable, getSeats, getEntries, getCurrentHand, getHandSeats, getSeatAvatars, getEntryAvatars, rabbitBoard,
  showHoldemCards, holdemRecords, type ShowWhich,
  ACTION_SEC, actOpenAt, tuning, type HoldemStatus, isPko, isMystery, bountyPctOf, prizePoolOf,
} from '../../db/holdem';
import * as G from '../../services/holdem';
import * as T from '../../services/tournament';
import { getWebUser, chatTick } from '../../db/queries';
import { recentRecap } from '../../db/holdem-recap';
import { rolloverSkips } from '../../db/rollover';
import { upcomingHint } from '../../db/recurrence';
import { getConfig } from '../../db/settings';
import { readJson, sendJson } from '../http';
import { layout, jsonForScript, helpDialog } from '../views';
import { ASSET_V } from '../assets';
import { gameSwitcher } from '../pages';
/* 브라우저로 나가는 인라인 스크립트의 조각들. 실행되는 코드가 아니라 문자열이고,
   아래 holdemPage 가 원래 순서로 이어 붙여 하나의 <script> 로 만든다. 조각들은 하나의
   클로저를 공유하므로 순서를 바꾸면 안 되고, 바꿀 이유도 없다 — 나눈 목적은 읽기다.
   조립 결과가 원본과 한 글자도 다르지 않은지는 scripts/golden.ts 가 바이트로 확인한다. */
import { stateFragment } from './holdem-client/state';
import { CELEBRATE } from './holdem-client/celebrate';
import { RECORDS } from './holdem-client/records';
import { FORMAT } from './holdem-client/format';
import { LOBBY, LOBBY_EMPTY } from './holdem-client/lobby';
import { SEATS } from './holdem-client/seats';
import { EQUITY } from './holdem-client/equity';
import { BADGES } from './holdem-client/badges';
import { CLOCK } from './holdem-client/clock';
import { REVEAL } from './holdem-client/reveal';
import { CHIPS } from './holdem-client/chips';
import { SIDE } from './holdem-client/side';
import { BOARD } from './holdem-client/board';
import { SETTLE } from './holdem-client/settle';
import { DEAL } from './holdem-client/deal';
import { TABLE } from './holdem-client/table';
import { CONTROLS } from './holdem-client/controls';
import { LOOP } from './holdem-client/loop';
import type { WebUser } from '../../db/queries';

/* 대회가 끝난 뒤에도 테이블을 잠시 더 내려보내는 시간.
   0으로 두면(예전 동작) 마지막 판이 끝나는 순간 status가 FINISHED가 되면서 table이
   null이 되고, 화면이 그 자리에서 로비로 갈아치워진다 — 대회를 결정지은 그 판의
   쇼다운을 아무도 못 본다. 우승자가 무엇으로 이겼는지도, 팟이 넘어가는 것도 못 본다.
   그래서 마지막 판을 끝까지 보여주고 나서 축하로 넘어가게 이 창을 둔다.

   이 값은 이제 "축하가 언제 뜨는가"를 정하지 않는다 — 그건 화면이 정산 연출이 끝난
   것을 보고 스스로 판단한다(celebrate의 settleDone). 여기는 그동안 테이블이 살아
   있게 하는 상한일 뿐이다. 그래서 최악의 경우에 맞춘다:
     프리플랍 9인 올인 → 핸드 공개 5.1초 + 플랍·턴·리버·스퀴즈 12.1초
                       + 결과 지연 1.5초 + 정산 6.1초 + 팝업 0.5초 ≈ 25.3초
   30초면 그 끝까지 덮는다. 대부분의 판은 그 한참 전에 축하로 넘어가므로,
   이 숫자가 커진다고 해서 기다리는 시간이 늘지는 않는다.

   모자라면 증상이 고약하다 — 연출 도중에 서버가 table을 거둬 가면서 핸드 공개도
   팟 이동도 통째로 사라지고 결과 팝업만 남는다. 12초였을 때 6인 올인 판에서
   실제로 그렇게 보였다("연출이 스킵된다"는 제보의 정체다). */
/* 값과 이유는 services/tournament.ts 에 있다 — db 계층도 같은 값을 봐야 하기 때문이다.
   여기서 다시 내보내는 것은 이 모듈을 쓰는 쪽의 import 를 바꾸지 않기 위해서다. */
export const FINISH_LINGER_SEC = T.FINISH_LINGER_SEC;

/* ── 상태 응답 ────────────────────────────────────────────────────── */

/* 깐 장만 남기고 나머지는 null(뒷면)로 바꾼다.
   가리는 일을 화면에 맡기지 않는 이유는 하나다 — 응답에 들어 있으면 읽힌다. */
function maskCards(cards: string[], mask: number): (string | null)[] {
  return cards.map((c, i) => ((mask >> i) & 1) === 1 ? c : null);
}

function statePayload(st: HoldemStatus, userId: string) {
  const now = Math.floor(Date.now() / 1000);
  const t = st.tournament;
  /* 대회가 하나도 없을 수 있다 — 자동 생성을 없앤 뒤로는 운영자가 열어야 생긴다.
     화면은 이 응답을 "예정된 대회 없음"으로 그린다. tournament 를 null 로 두는 대신
     status 만 NONE 으로 주면 화면이 빈 값을 읽다가 죽으므로, 통째로 없는 것으로 준다. */
  if (!t) {
    /* 빈 화면 대신 두 가지를 준다 — 지난 판이 어땠는지(recap)와 다음이 언제인지(upcoming).
       둘 다 없을 수도 있고, 그때는 화면이 안내 문구만 그린다. */
    const up = upcomingHint(now);
    return {
      ok: true, me: userId, balance: getWebUser(userId)?.balance ?? 0,
      serverNow: now, tournament: null, results: [], table: null,
      recap: recentRecap(),
      upcoming: up ? { regOpenAt: up.regOpenAt, startAt: up.startAt, dateStr: up.dateStr } : null,
    };
  }
  const table = getTable(t.id);
  const entries = getEntries(t.id);
  const tune = tuning(t);
  // PKO 는 참가비의 절반이 바운티로 빠진다 — 상금 팟은 그 나머지로만 센다
  const pool = prizePoolOf(t, entries.length, tune.prizeFixed);

  const base = {
    ok: true,
    me: userId,
    balance: getWebUser(userId)?.balance ?? 0,
    /* 채팅은 폴링을 새로 만들지 않는다 — 이 숫자 하나(마지막 메시지 id)만 얹고,
       화면은 값이 늘었을 때만 /api/chat 을 부른다. 조용하면 요청이 안 는다. */
    ...chatTick(),
    serverNow: now,
    tournament: {
      id: t.id,
      title: t.title,
      status: st.status,
      dateStr: t.date_str,
      regOpenAt: t.reg_open_at,
      scheduledStartAt: t.scheduled_start_at,
      graceEndsAt: t.grace_ends_at,
      startedAt: t.started_at,
      finishedAt: t.finished_at,
      multiplier: t.prize_multiplier,
      registered: entries.length,
      minPlayers: T.MIN_PLAYERS,
      maxPlayers: T.MAX_PLAYERS,
      startingStack: tune.startingStack,
      // 참가비. 0 이면 프리롤이고, 화면은 그때 참가비 줄을 아예 그리지 않는다
      buyIn: t.buy_in,
      /* 판의 종류. 화면은 이 값 하나로 바운티 UI 를 켜고 끈다 — 일반 대회에서는
         머리 위 뱃지도 KO 연출도 아예 그려지지 않아야 한다(같은 베이스지만 다른 게임이다). */
      mode: t.mode,
      /* 바운티 관련 값은 PKO 에서만 싣는다. 일반 대회에 0 을 실어 보내면 화면 쪽에서
         "0 이면 숨긴다" 같은 조건이 하나 더 생기고, 그 조건이 언젠가 빠진다.
         아예 없으면 실수로 그릴 수가 없다. */
      bountyPool: isPko(t) ? t.bounty_pool : undefined,
      /* 내가 KO 로 받아 챙긴 현상금 누계와 지금 내 머리에 걸린 값.
         상금 탭이 "내 돈이 어떻게 되고 있나"를 보는 곳이라 거기에 적는다 —
         머리 위 명찰은 지금 값만 보여주고, 이미 받은 돈은 어디에도 없었다. */
      myBountyWon: isPko(t)
        ? (entries.find(e => e.user_id === userId)?.bounty_won ?? 0) : undefined,
      /* 내 봉투도 감춘다 — 미스터리의 재미는 아무도, 본인조차 모른다는 것이다.
         프로그레시브는 자기 머리 값을 늘 안다(자라는 것을 보는 것이 그 모드의 재미다). */
      myBounty: isPko(t)
        ? (isMystery(t) && entries.find(e => e.user_id === userId)?.bounty_revealed !== 1
          ? null
          : (entries.find(e => e.user_id === userId)?.bounty ?? 0))
        : undefined,
      /* 바운티 몫(%) — 상금 탭이 "1인당 금액의 몇 %가 바운티인가"를 적는 데 쓴다 */
      bountyPct: isPko(t) ? bountyPctOf(t) : undefined,
      /* 이월이 걸린 판인가. 배수는 대회를 만들 때 이미 굳혀 넣었으므로(db/rollover.ts)
         금액에는 반영돼 있고, 화면은 "왜 평소보다 큰가"를 말하기 위해 횟수만 받는다. */
      rolloverSkips: t.buy_in <= 0 ? rolloverSkips() : 0,
      /* 미스터리에서 봉투 하나가 받을 수 있는 최대 금액. 개별 봉투가 얼마인지는
         감추지만(위의 bountyBySeat), "얼마까지 나올 수 있나"는 감출 것이 아니다 —
         그게 이 모드를 고르는 이유이고, 규칙에서 계산되는 공개 값이다. */
      mysteryTop: isMystery(t) && entries.length > 0
        ? Math.floor(t.bounty_pool * T.envelopeRange(entries.length).hi / 100)
        : undefined,
      /* 누가 얼마를 벌었나. 상금 탭이 규칙 설명 대신 이 표를 보여준다 — 규칙은 공지에
         적어 두고, 화면은 "지금 누가 앞서 있나"만 말하는 편이 읽힌다.

         많이 번 사람 순으로 준다. 동액이면 신청 순서를 유지한다(entries 순) — 폴링마다
         순서가 뒤바뀌면 눈으로 따라갈 수 없다. 시작 전에는 전원 0 이고, 그 0 도 그린다:
         "아직 아무도 못 벌었다"는 것과 "표가 없다"는 것은 다르다. */
      bountyBoard: isPko(t)
        ? entries.map((e, i) => ({ name: e.username, won: e.bounty_won, i }))
          .sort((a, b) => b.won - a.won || a.i - b.i)
          .map(x => ({ name: x.name, won: x.won }))
        : undefined,
      prizePool: pool,
      prizes: T.prizeAmounts(pool, entries.length),
      itm: T.itmCount(entries.length),
      lateRegLeft: T.lateRegLeft(now, {
        startedAt: t.started_at, finishedAt: t.finished_at, cancelledAt: t.cancelled_at,
      }, tune.lateRegSec),
      iRegistered: entries.some(e => e.user_id === userId),
      /* 신청한 사람들. 숫자만 "2 / 9"로 적어 두면 누가 왔는지 알 수 없어서, 아는 사람이
         있는지 보려고 디스코드를 다시 열어야 한다 — 최소 인원(3명)이 모여야 열리는
         판이라 "누가 있나"가 갈지 말지를 정하는 정보다.
         신청 순서로 준다. 그게 곧 자리 순서는 아니지만(자리는 섞는다), 목록이 폴링마다
         뒤바뀌지 않으려면 순서가 고정돼야 한다. */
      players: (() => {
        const av = getEntryAvatars(t.id);
        return entries.map(e => ({
          userId: e.user_id, username: e.username, avatar: av.get(e.user_id) ?? null,
        }));
      })(),
    },
    // 결과는 끝난 뒤에만 (진행 중 순위를 흘리면 남은 사람의 정보가 된다)
    results: st.status === 'FINISHED'
      ? (() => {
        const av = getEntryAvatars(t.id);
        return entries.filter(e => e.finish_place != null)
          .sort((a, b) => a.finish_place! - b.finish_place!)
          .map(e => ({
            place: e.finish_place, username: e.username, prize: e.prize,
            /* 실제로 지급된 바운티. 결과 팝업이 순위 상금만 적으면 이 대회의 절반이
               사라진다 — 3위로 끝났지만 바운티로 10,000P 를 번 사람이 "0P" 로 찍혔다.
               예정액(bounty_won)이 아니라 지급액을 쓴다: 팝업은 "얼마 받았나"를 말하는
               자리이고, 중간에 끊긴 판이면 그 값은 0 이어야 한다. */
            bounty: e.bounty_paid,
            userId: e.user_id, avatar: av.get(e.user_id) ?? null,
          }));
      })()
      : [],
    table: null as unknown,
  };

  /* 끝난 직후 잠깐은 테이블을 계속 내려보낸다 — 마지막 판의 쇼다운을 보여주기 위해서다.
     이때 좌석은 전부 OUT이지만 shownSeats가 "끝난 판에 참여했던 자리"를 남기므로
     (탈락자에게 자기 쇼다운을 보여주려고 이미 있는 장치다) 그대로 그려진다. */
  const finishedAgo = t.finished_at != null ? now - t.finished_at : null;
  const lingering = st.status === 'FINISHED' && finishedAgo != null && finishedAgo < FINISH_LINGER_SEC;
  if (!table || (st.status !== 'RUNNING' && !lingering)) return base;

  const seats = getSeats(table.id);
  const living = seats.filter(s => s.presence !== 'OUT');
  /* 바운티는 대회 단위 값이라 참가 행(holdem_entries)에 있고 좌석 행에는 없다.
     좌석마다 조회하지 않고 한 번에 읽어 맵으로 둔다 — 9인 테이블이면 폴링마다 9번이다. */
  const pkoOn = isPko(t);
  /* 미스터리는 봉투 금액을 열리기 전까지 내려보내지 않는다 — 응답에 들어 있으면 개발자
     도구로 그대로 읽히고, 그러면 감춘 것이 아니다(홀 카드와 같은 규율이다).
     감춘 자리는 null 로 준다: 0 으로 주면 "0원짜리 봉투"와 구분되지 않는다. */
  const mysteryOn = isMystery(t);
  const bountyBySeat = new Map<string, number | null>(entries.map(e =>
    [e.user_id, (mysteryOn && e.bounty_revealed !== 1) ? null : e.bounty]));
  /* 잡아서 확보한 누계. 머리 값이 자라지 않게 되면서 명찰 숫자가 영구히 고정됐고, 그래서
     "잡았다"는 보상 피드백을 여기에 옮겼다 — 화면이 이 값의 증가를 보고 +N P 를 띄운다.
     감출 것이 없다: 이미 열린 봉투에서 나온 돈이고, 누가 얼마 벌었는지는 보여야 한다. */
  const wonBySeat = new Map<string, number>(entries.map(e => [e.user_id, e.bounty_won]));
  const hand = getCurrentHand(table.id);
  const profiles = getSeatAvatars(table.id);
  const avatarOf = (id: string) => profiles.get(id) ?? null;

  const level = hand
    ? { level: hand.level, sb: hand.sb, bb: hand.bb, ante: hand.ante }
    : T.levelAt(now - (t.started_at ?? now), tune.levelSec);
  const elapsed = now - (t.started_at ?? now);
  const totalChips = living.reduce((a, s) => a + s.stack, 0);

  const boardCards = hand ? JSON.parse(hand.board_json) as number[] : [];
  const handSeats = hand ? getHandSeats(hand.id) : [];
  const bySeat = new Map(handSeats.map(h => [h.seat, h]));
  /* 탈락한 사람도 "자기가 죽은 그 판"의 쇼다운은 봐야 한다.
     endHand는 결과를 쓴 뒤 같은 트랜잭션에서 presence를 OUT으로 바꾸므로,
     living만 보면 ended=true와 mySeat=null이 같은 응답에 실려 온다 —
     그러면 클라이언트가 테이블을 접어버려 자기가 어떻게 죽었는지 못 본다.
     끝난 판에 참여했던 자리는 OUT이어도 화면에 남긴다. */
  const endedNow = hand?.ended_at != null;
  const inEndedHand = (s: { seat: number; user_id: string }) =>
    endedNow && bySeat.get(s.seat)?.user_id === s.user_id;
  const shownSeats = seats.filter(s => s.presence !== 'OUT' || inEndedHand(s));
  const mySeat = shownSeats.find(s => s.user_id === userId);
  const myHand = mySeat ? bySeat.get(mySeat.seat) : undefined;
  const ended = hand?.ended_at != null;
  const result = ended && hand?.result_json ? JSON.parse(hand.result_json) : null;
  // 쇼다운에 공개된 홀 카드만 남의 것으로 내려보낸다
  const revealed = new Map<number, string[]>(
    (result?.reveal ?? []).map((r: { seat: number; cards: string[] }) => [r.seat, r.cards]));

  const views = handSeats.map(h => ({
    seat: h.seat, bet: h.bet, stack: h.stack, committed: h.committed,
    state: h.state, acted: h.acted === 1,
  }));
  const potTotal = views.reduce((a, v) => a + v.committed, 0);

  const myLegal = (() => {
    if (!hand || ended || !mySeat || !myHand || hand.to_act_seat !== mySeat.seat) return null;
    const me = views.find(v => v.seat === mySeat.seat);
    if (!me || me.state !== 'active') return null;
    const la = G.legalActions(me, views, hand.last_raise_size, hand.bb);
    return {
      canFold: la.canFold, canCheck: la.canCheck, canCall: la.canCall,
      callAmount: la.callAmount, minRaiseTo: la.minRaiseTo, maxRaiseTo: la.maxRaiseTo,
      raiseIsBet: la.raiseIsBet, myBet: me.bet, myStack: me.stack,
    };
  })();

  /* 사전 액션용 상황. 내 차례가 "아닐 때"만 채운다 — 내 차례에는 진짜 버튼이 뜬다.
     여기 담기는 것은 지금 내가 콜하려면 얼마가 드는가와 체크가 가능한가뿐이고, 둘 다
     이미 화면에 보이는 베팅 액수에서 나오는 값이다. 남의 카드는 물론 아무 히든 정보도
     섞이지 않는다.

     이걸 안 주면 사전 액션 상자를 내 차례에만 띄우게 되는데, 그러면 미리 정해 둘
     이유가 사라진다 — 실제로 그렇게 동작하고 있었다. */
  const myPre = (() => {
    if (!hand || ended || !mySeat || !myHand) return null;
    if (hand.to_act_seat === mySeat.seat) return null;
    const me = views.find(v => v.seat === mySeat.seat);
    if (!me || me.state !== 'active') return null;
    const la = G.legalActions(me, views, hand.last_raise_size, hand.bb);
    return { canCheck: la.canCheck, canCall: la.canCall, callAmount: la.callAmount };
  })();

  return {
    ...base,
    table: {
      handNo: hand?.hand_no ?? 0,
      /* 이 판에 열린 봉투들 — 개봉 연출이 봉투마다 "누구 것이 얼마였고 누가 가져갔나"를
         보여준다. 미스터리에서만 내려보낸다: 프로그레시브는 금액이 머리 위에 이미 적혀
         있어서 개봉이라는 사건이 없다.

         이 값이 결과보다 먼저 도착하는 것은 문제가 되지 않는다 — 화면이 처형이 끝날
         때까지 붙들고 있다가 그때 재생한다. 반대로 이 값 없이 확보 누계의 증가분만
         보면 봉투 여러 개가 한 숫자로 합쳐져 누구 것인지 알 수 없다. */
      bountyReveals: isMystery(t) && hand?.bounty_reveals
        ? (() => {
          try { return JSON.parse(hand.bounty_reveals) as unknown; }
          catch { return null; }   // 깨진 JSON 이 연출을 멈추게 하지 않는다
        })()
        : undefined,
      street: hand?.street ?? 'preflop',
      board: G.cardsToStrings(boardCards),
      buttonSeat: hand?.button_seat ?? table.button_seat,
      toActSeat: ended ? null : hand?.to_act_seat ?? null,
      /* 남은 제한 시간. 차례가 아직 열리지 않은 구간에서는 마감이 ACTION_SEC보다 멀리
         있으므로(최소 간격만큼 뒤로 밀려 있다) 그대로 쓰면 "23초"가 찍힌다.
         제한 시간은 열린 뒤부터라 상한을 씌운다 — 열릴 때까지는 20에 멈춰 있다. */
      actionLeft: !ended && hand?.action_deadline != null
        ? Math.min(ACTION_SEC, Math.max(0, hand.action_deadline - now)) : null,
      actionSec: ACTION_SEC,
      /* 이 차례가 열리기까지 남은 초. 0보다 크면 아직 아무도 행동할 수 없다 —
         커뮤니티 카드가 열리는 중이거나 앞 사람 액션 직후의 최소 간격이다. */
      actOpenIn: !ended && hand != null
        ? Math.max(0, (actOpenAt(hand) ?? now) - now) : 0,
      pot: potTotal,
      /* 팟의 층 구성. 올인이 섞이면 "메인 팟 + 사이드 팟"으로 갈라지는데, 합계만 보여주면
         내가 실제로 다툴 수 있는 금액이 얼마인지 알 수 없다 — 스택이 작은 사람은
         메인 팟만 가져갈 수 있다.
         정산용 buildPots를 쓰면 안 된다. 그건 투입액이 다를 때마다 층을 자르므로
         스몰·빅 블라인드만 낸 상태에서도 "사이드 팟"이 생긴다(실제로 그랬다).
         potLayers는 올인이 실제로 뚜껑을 덮은 지점에서만 자른다.
         eligible(자격 좌석)은 폴드 여부에서 나오는 값이라 히든 정보가 아니다. */
      pots: G.potLayers(views).map(p => ({ amount: p.amount, eligible: p.eligible })),
      ended,
      result,
      nextHandIn: table.next_hand_at != null ? Math.max(0, table.next_hand_at - now) : null,
      // 래빗 헌트 — 끝난 판에서만 채워진다(rabbitBoard가 진행 중에는 빈 배열을 준다)
      rabbit: hand ? rabbitBoard(hand) : [],
      /* 이 핸드의 마지막 행동. 스트리트를 닫은 행동은 좌석 표시가 같은 트랜잭션에서
         초기화되므로 이것 없이는 화면에 한 번도 뜨지 않는다. 클라이언트는 보드를
         깔기 전 정지 구간에서 이걸로 라벨을 채운다. */
      lastActor: hand && hand.last_actor_seat != null && hand.last_actor_action
        ? {
            seat: hand.last_actor_seat, act: hand.last_actor_action,
            amount: hand.last_actor_amount,
            /* 그 자리가 이 판에 넣은 총액. committed는 스트리트가 넘어가도 초기화되지
               않으므로(bet만 초기화된다) 스트리트를 닫은 행동에도 값이 살아 있다.
               올인 음악이 레이즈 올인과 콜 올인을 가르는 데 쓴다. */
            committed: bySeat.get(hand.last_actor_seat)?.committed ?? 0,
          }
        : null,
      level,
      nextLevelIn: T.nextLevelIn(elapsed, tune.levelSec),
      // 남은 인원·평균 스택은 실제로 살아 있는 사람만 센다 (표시용 좌석 목록과 다르다)
      remaining: living.length,
      avgStack: living.length ? Math.floor(totalChips / living.length) : 0,
      /* 탈락자. 칩 순위에서 아예 지우지 않고 아래에 남겨 두려고 내려보낸다 —
         누가 언제 나갔는지가 대회의 절반이고, 명단에서 사라지면 그 기록이 없어진다.
         늦게 탈락한 사람이 위다(오래 버텼다). 카드는 담지 않는다 — 탈락자의 홀 카드는
         공개 대상이 아니고, 여기 필요한 것은 이름과 순서뿐이다. */
      busted: (() => {
        const av = getEntryAvatars(t.id);
        return entries
          .filter(e => e.eliminated_at != null)
          .sort((a, b) => (b.elim_seq ?? 0) - (a.elim_seq ?? 0))
          .map(e => ({
            userId: e.user_id, username: e.username,
            avatar: av.get(e.user_id) ?? null, place: e.finish_place,
          }));
      })(),
      seats: shownSeats.map(s => {
        const h = bySeat.get(s.seat);
        return {
          seat: s.seat,
          userId: s.user_id,
          username: s.username,
          avatar: avatarOf(s.user_id),
          /* 스택은 두 곳에 있고 시점에 따라 옳은 쪽이 다르다.
             · 핸드 진행 중: 핸드 안 스택(holdem_hand_seats). 좌석 스택은 핸드가 끝날 때만
               갱신되므로 그걸 쓰면 베팅을 해도 내 스택이 줄지 않는다 — 칩은 앞에 쌓였는데
               스택은 그대로라 내가 얼마 남았는지 알 수 없다.
             · 핸드가 끝난 뒤: 좌석 스택. 딴 금액은 좌석 스택에만 더해지므로 핸드 안 스택을
               계속 쓰면 방금 이긴 팟이 반영되지 않는다(칩 총합이 어긋난다).
             핸드에 참여하지 않은 자리도 좌석 스택을 쓴다. */
          stack: h && !ended ? h.stack : s.stack,
          presence: s.presence,
          inHand: h != null,
          bet: h?.bet ?? 0,
          /* 이 판에 지금까지 넣은 총액. 베팅은 전부 공개 정보라 숨길 것이 없다.
             올인 음악이 "이건 레이즈 올인인가, 남의 올인에 대한 콜인가"를 가르는 데 쓴다 —
             스트리트 베팅액(bet)만으로는 스트리트가 넘어가면 비교가 어긋난다. */
          committed: h?.committed ?? 0,
          /* 머리에 걸린 바운티. PKO 가 아니면 아예 넣지 않는다 — 일반 대회의 좌석에는
             이 칸이 없어서 화면이 그리려 해도 그릴 것이 없다. */
          bounty: pkoOn ? (bountyBySeat.get(s.user_id) ?? null) : undefined,
          /* 잡아서 확보한 누계 — 화면이 이 값의 증가로 +N P 를 띄운다 */
          bountyWon: pkoOn ? (wonBySeat.get(s.user_id) ?? 0) : undefined,
          state: h?.state ?? 'out',
          won: h?.won ?? 0,
          // 마지막으로 한 행동 ("콜 300"처럼 자리 옆에 띄운다)
          act: h?.last_action ?? null,
          actAmount: h?.last_amount ?? 0,
          /* 내 카드는 항상, 남의 카드는 공개된 것만.
             본인이 끝난 판에서 직접 공개(shown)했다면 그것도 공개된 것으로 본다.

             한 장만 깔 수 있으므로 안 깐 장은 아예 내려보내지 않는다 — 화면에서 가리는
             것으로는 안 된다. 응답에 들어 있으면 개발자 도구로 그대로 읽히고, 그건
             "한 장만 깠다"가 성립하지 않는다는 뜻이다. 안 깐 자리는 null(뒷면)이 된다. */
          cards: s.user_id === userId && h
            ? G.cardsToStrings(JSON.parse(h.hole_json) as number[])
            : ended && h?.shown === 1
              ? maskCards(G.cardsToStrings(JSON.parse(h.hole_json) as number[]), h.shown_mask)
              : revealed.get(s.seat) ?? [],
          // 자발적으로 깐 패는 쇼다운 공개와 구분해서 표시한다
          shown: ended && h?.shown === 1 && !revealed.has(s.seat),
          /* 어느 장을 깠는지 장별로 준다. 좌석 하나에 참·거짓 하나만 주면 한 장만 깠어도
             두 장 다 "깐 카드"로 표시된다 — 내 화면에서 두 장이 함께 뒤집히는 것처럼
             보이던 원인이 이것이다(내 카드는 나에게 늘 앞면이라 표시만 남는다). */
          shownCards: ended && h?.shown === 1 && !revealed.has(s.seat)
            ? [((h.shown_mask >> 0) & 1) === 1, ((h.shown_mask >> 1) & 1) === 1]
            : [false, false],
        };
      }),
      // 내 두 장 + 보드로 지금 무엇이 완성됐는지. 내 카드로 계산한 내 정보다.
      myHand: myHand
        ? G.readHand(JSON.parse(myHand.hole_json) as number[], boardCards)
        : null,
      /* 패 공개 버튼을 띄울지. 판이 끝났고, 내가 그 판에 있었고,
         쇼다운에서 이미 까이지도 않았고, 아직 내가 까지도 않았을 때만. */
      /* 아직 안 깐 장이 남아 있으면 버튼을 띄운다. 한 장만 깐 사람은 나머지 한 장을
         더 깔 수 있어야 하므로 "shown 이 0인가"로는 부족하다. */
      canShow: ended && myHand != null && (myHand.shown_mask & 3) !== 3
        && !revealed.has(myHand.seat),
      /* 이미 깐 장 — 화면이 남은 선택지만 그린다 */
      shownMask: myHand ? (myHand.shown_mask & 3) : 0,
      mySeat: mySeat?.seat ?? null,
      myPresence: mySeat?.presence ?? null,
      legal: myLegal,
      pre: myPre,
      /* 대회가 끝났고 지금은 마지막 판을 보여주는 중이라는 신호.
         클라이언트는 이걸 보고 "다음 판 N초" 대신 종료를 알리고, 남은 시간이 다 되면
         우승 축하로 넘어간다. 이게 없으면 테이블이 왜 멈춰 있는지 알 수 없다. */
      tournamentOver: lingering,
      finishLeft: lingering ? Math.max(0, FINISH_LINGER_SEC - finishedAgo!) : null,
    },
  };
}

/* ── API ─────────────────────────────────────────────────────────── */

export async function handleState(
  _req: IncomingMessage, res: ServerResponse, userId: string
): Promise<void> {
  /* 화면에 무엇을 보여줄지는 "이 사람이 어디에 앉아 있었나"에서 나온다 — 시계가 아니다.
     방금 끝난 판을 붙들어 두는 것이 이 인자의 목적이다(db/holdem 의 seatedTournament).
     등록·액션 경로는 반대로 시계에서 유도해야 하므로 인자를 넘기지 않는다 —
     "지금 등록할 수 있는 판"은 사람이 앉았던 자리와 무관하다. */
  const st = advanceHoldem(userId);
  // 폴링 자체가 "접속 중" 신호다. SIT_OUT은 여기서 풀지 않는다 — 본인이 복귀를 눌러야 한다.
  const table = st.tournament ? getTable(st.tournament.id) : undefined;
  if (table) touchHoldemPresence(userId, table.id);
  return sendJson(res, 200, statePayload(st, userId));
}

export async function handleRegister(
  _req: IncomingMessage, res: ServerResponse, userId: string, username: string
): Promise<void> {
  const r = registerHoldem(userId, username);
  if (!r.ok) {
    const msg = r.error === 'not_open' ? '아직 등록이 열리지 않았습니다'
      : r.error === 'late_reg_closed' ? '늦은 등록 시간이 지났습니다'
      : r.error === 'table_full' ? '테이블이 꽉 찼습니다'
      : r.error === 'already' ? '이미 등록하셨습니다'
      : r.error === 'no_funds' ? '참가비를 낼 포인트가 모자랍니다'
      : '지금은 등록할 수 없습니다';
    return sendJson(res, 400, { error: msg });
  }
  return sendJson(res, 200, { ok: true, registered: r.registered });
}

export async function handleUnregister(
  _req: IncomingMessage, res: ServerResponse, userId: string
): Promise<void> {
  const r = unregisterHoldem(userId);
  if (!r.ok) {
    const msg = r.error === 'not_registered' ? '신청하지 않으셨습니다'
      : r.error === 'already_started' ? '대회가 이미 시작되어 취소할 수 없습니다'
      : '지금은 취소할 수 없습니다';
    return sendJson(res, 400, { error: msg });
  }
  return sendJson(res, 200, { ok: true, registered: r.registered });
}

export async function handleAction(
  req: IncomingMessage, res: ServerResponse, userId: string
): Promise<void> {
  // 본문 파싱(await)을 먼저 끝낸다 — 확인과 쓰기 사이에 await가 있으면
  // 그 틈에 차례가 넘어가 엉뚱한 시점에 액션이 들어갈 수 있다.
  const data = await readJson(req);
  const kinds: G.ActionKind[] = ['fold', 'check', 'call', 'bet', 'raise', 'allin'];
  const kind = kinds.find(k => k === data?.action);
  if (!kind) return sendJson(res, 400, { error: '알 수 없는 동작입니다' });
  const amount = Math.floor(Number(data?.amount ?? 0));
  if (!Number.isFinite(amount) || amount < 0) return sendJson(res, 400, { error: '금액이 올바르지 않습니다' });

  /* 사전 액션으로 콜할 때만 온다 — "걸어 둘 때 본 콜 금액"이다.
     화면도 콜 금액이 바뀌면 체크를 풀지만, 폴링 사이(최대 1초)에 상황이 바뀌고 그 틈에
     내 차례가 오면 늦는다. 돈이 걸린 자동 실행이라 그 1초가 실제 사고가 된다.
     여기서 다시 재고, 더 커졌으면 실행하지 않는다 — 마지막 문은 서버다. */
  const maxCall = data?.maxCall == null ? null : Math.floor(Number(data.maxCall));
  const r = holdemAction(userId, kind, amount,
    maxCall != null && Number.isFinite(maxCall) ? maxCall : undefined);
  if (!r.ok) {
    if (r.error === 'call_grew') {
      return sendJson(res, 409, { error: '콜 금액이 올라 자동 콜을 실행하지 않았습니다' });
    }
    const msg = r.error === 'not_your_turn' ? '지금은 당신의 차례가 아닙니다'
      : r.error === 'not_seated' ? '이 토너먼트에 참여하지 않았습니다'
      : r.error === 'no_hand' ? '진행 중인 핸드가 없습니다'
      : r.error === 'illegal' ? legalMessage(r.detail)
      : '토너먼트가 진행 중이 아닙니다';
    return sendJson(res, 400, { error: msg });
  }
  return sendJson(res, 200, { ok: true });
}

function legalMessage(detail?: string): string {
  return detail === 'below_min_raise' ? '최소 레이즈 금액보다 적습니다'
    : detail === 'above_stack' ? '스택보다 많이 걸 수 없습니다'
    : detail === 'cannot_check' ? '콜해야 하는 상황입니다'
    : detail === 'nothing_to_call' ? '콜할 금액이 없습니다'
    : detail === 'cannot_raise' ? '지금은 레이즈할 수 없습니다'
    : '허용되지 않는 동작입니다';
}

export async function handleSitIn(
  _req: IncomingMessage, res: ServerResponse, userId: string
): Promise<void> {
  const st = advanceHoldem();
  const table = st.tournament ? getTable(st.tournament.id) : undefined;
  if (!table) return sendJson(res, 400, { error: '진행 중인 테이블이 없습니다' });
  holdemSitIn(userId, table.id);
  return sendJson(res, 200, { ok: true });
}

/* 역대 프리롤 전적. 끝난 대회만 집계하므로 진행 중인 판의 정보가 새지 않는다.
   폴링에 얹지 않고 따로 둔다 — 판마다 바뀌는 값이 아니라서 매초 받을 이유가 없다. */
export async function handleRecords(
  _req: IncomingMessage, res: ServerResponse, userId: string
): Promise<void> {
  /* 갈래를 나눠 한 번에 준다. 탭을 누를 때마다 받아 오면 그때마다 기다림이 생기는데,
     스무 줄 두 벌은 수 KB 이고 이 경로는 탭을 열 때만 불린다.
     빈 갈래는 화면이 탭 자체를 안 붙인다 — 한 번도 안 연 종류의 빈 표는 자리만 먹는다. */
  return sendJson(res, 200, {
    ok: true, me: userId,
    classic: holdemRecords(20, 'CLASSIC'),
    bounty: holdemRecords(20, 'BOUNTY'),
  });
}

export async function handleShow(
  req: IncomingMessage, res: ServerResponse, userId: string
): Promise<void> {
  const b = await readJson(req) as { which?: unknown } | null;
  /* 어느 장을 깔지. 값이 없거나 이상하면 둘 다로 본다 — 예전 화면이 본문 없이 보내던
     요청과 같은 뜻이 되어야 한다(그때는 공개가 두 장 전부였다). */
  const n = Math.floor(Number(b?.which ?? 3));
  const which: ShowWhich = n === 1 || n === 2 ? n : 3;
  // 판이 끝났는지는 showHoldemCards가 SQL 조건으로 직접 확인한다.
  const r = showHoldemCards(userId, which);
  if (!r.ok) return sendJson(res, 400, { error: '지금은 패를 공개할 수 없습니다' });
  return sendJson(res, 200, { ok: true });
}

/* ── 도움말 ──────────────────────────────────────────────────────── */

/* 도움말의 숫자는 전부 [대회 설정]에서 온다.
   예전에는 21:00 · 22:00 · 10,000칩 · 8분이 문장 안에 박혀 있었는데, 운영자가 그 값을
   바꿀 수 있게 된 순간부터 이 글이 조용히 거짓말을 하기 시작했다. 규칙을 설명하는
   글이 실제 규칙과 다른 것은 설명이 없는 것보다 나쁘다. */
function helpBody(): string {
  const cfg = getConfig();
  const clock = (min: number) =>
    `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  const num = (n: number) => n.toLocaleString('ko-KR');
  return `
  <h4>어떤 대회인가요</h4>
  <p>참가비가 없는 <b>프리롤</b>입니다. 포인트를 잃지 않고, 상위 입상자만 상금을 받습니다.
     평일은 참가자 1인당 ${num(cfg.weekdayMultiplier)}P, 주말은 ${num(cfg.weekendMultiplier)}P가
     상금 풀에 쌓입니다.</p>
  <ul>
    <li>대회가 열리는 시각은 그때그때 다릅니다 — 로비의 <b>다음 대회</b> 안내를 보세요
        (지금 설정은 등록 <b>${clock(cfg.regOpenMin)}</b> · 시작 <b>${clock(cfg.startMin)}</b> KST)</li>
    <li>최소 ${T.MIN_PLAYERS}명 · 최대 ${T.MAX_PLAYERS}명 (한 테이블)</li>
    <li>시작 시각에 ${T.MIN_PLAYERS}명이 안 되면 <b>${cfg.graceMin}분</b> 더 기다리고,
        그래도 미달이면 취소됩니다</li>
    <li>시작 후 <b>${cfg.lateRegMin}분</b>까지 늦은 등록이 가능합니다 (빈자리가 있을 때)</li>
    <li>시작 스택 ${num(cfg.startingStack)}칩 · 블라인드는 ${cfg.levelMin}분마다 오릅니다</li>
  </ul>

  <h4>상금</h4>
  <p>참가자의 약 30%가 상금을 받습니다. 1위가 가장 많이 받고 순위가 내려갈수록 줄어듭니다.
     늦은 등록으로 참가자가 늘면 상금 풀도 함께 커집니다.</p>

  <h4>진행</h4>
  <ul>
    <li>노리밋 텍사스 홀덤. 각자 두 장을 받고 보드 다섯 장과 조합해 가장 센 다섯 장을 만듭니다</li>
    <li>내 차례에 <b>폴드 / 체크 / 콜 / 베팅·레이즈 / 올인</b> 중 하나를 고릅니다</li>
    <li>제한 시간을 넘기면 자동으로 체크(체크가 불가하면 폴드)되고 자리 비움으로 바뀝니다.
        액션 버튼 자리에 나오는 <b>게임 복귀</b>를 누르면 다시 정상 플레이로 돌아옵니다</li>
    <li>브라우저를 닫아도 자리는 유지됩니다. 다시 들어오면 그대로 이어집니다</li>
  </ul>

  <h4>베팅 버튼</h4>
  <p>빠른 금액 버튼(1BB, 2BB, 1/3 팟, 1/2 팟, 팟, 올인 — 왼쪽일수록 작습니다)은
     <b>금액만 채워 넣습니다.</b>
     실제로 나가려면 <b>베팅 / 레이즈</b> 확인 버튼을 눌러야 합니다 — 실수로 전 재산이
     나가는 일을 막기 위한 안전장치입니다.</p>
  <p>스택 표시는 <b>칩</b>과 <b>BB</b>(빅블라인드 배수) 중에서 고를 수 있습니다.</p>
`;
}
/* ── 페이지 ──────────────────────────────────────────────────────────
 *
 * 배치 규칙(참고 디자인을 그대로 따른 것 — 여기서 어긋나면 화면이 무너진다):
 *
 *  · 테이블은 스타디움(양끝이 둥근 사각). 바깥에 두꺼운 레일, 안쪽에 초록 펠트,
 *    펠트 안쪽으로 한 겹 더 얇은 트랙 선.
 *  · 라이브 딜러는 두지 않는다. 홀덤은 버튼이 플레이어를 돌기 때문에 상단에 딜러를
 *    앉히면 "누가 딜러인가"가 두 곳에서 말해져 오히려 헷갈린다. 버튼 퍽만 쓴다.
 *  · 좌석 9개는 테이블 둘레 바깥에. 내(Hero) 자리는 언제나 6시 방향이고,
 *    나머지는 자리 번호 순서대로 시계방향으로 돌려서 붙인다.
 *  · 좌석판은 가로형: [아바타][Seat N (이름)] / [스택]
 *  · 각 좌석의 카드 두 장은 좌석판 "바로 위"에. 모든 자리가 같은 규칙이라
 *    위치가 들쭉날쭉해 보이지 않는다.
 *  · 베팅 칩은 좌석과 테이블 중앙 "사이"에. 좌석마다 안쪽 좌표를 따로 잡아 둔다.
 *  · 딜러 버튼(퍽)은 그 좌석판의 중앙을 향한 옆면에 붙인다 — 펠트 위에 띄워 두면
 *    "떠 있는 물체"로 보여서 누구 버튼인지 한눈에 안 잡힌다.
 *  · 보드 5장과 POT은 중앙. 액션 버튼은 테이블 아래.
 *  · 오른쪽 패널에 토너먼트 정보와 칩 순위.
 */

export function holdemPage(user: WebUser): string {
  const body = `
    ${gameSwitcher('holdem', 'htHelp')}

    <div id="htLobby" class="ht-lobby" hidden></div>

    <!-- 로비(대회 전·후)에서도 역대 전적을 보여준다. 테이블 오른쪽 패널에만 두면
         자리에 앉은 사람만 볼 수 있는데, 정작 "누가 상금을 제일 많이 먹었나"가
         궁금해지는 시점은 대회를 기다리는 동안이다. -->
    <div id="htLobbyRec" class="ht-lrec" hidden>
      <h3 class="ht-h3">누적 상금 순위</h3>
      <div class="ht-rec" id="htLobbyRecList"></div>
    </div>

    <div id="htTable" class="game-shell ht-shell" hidden>
      <div class="game-main">
        <div class="ht-felt">
          <!-- 레일(바깥) → 펠트(안) → 트랙 선. 세 겹이라야 테이블처럼 보인다 -->
          <div class="ht-rail">
            <div class="ht-cloth" id="htCloth">
              <div class="ht-track" aria-hidden="true"></div>


              <div class="ht-center">
                <!-- "POT"이라는 세 글자는 이 화면을 처음 보는 사람에게 약어다.
                     "Total Pot"이면 그 자체로 문장이라 설명이 필요 없다. -->
                <div class="ht-pot"><span class="ht-pot-k">Total Pot</span><span id="htPot">0</span></div>
                <!-- 보드를 감싸는 이유는 리버 스퀴즈 때문이다. 마지막 장 위에 뒷면을
                     덮고 왼쪽부터 벗겨내는데, 그 덮개를 #htBoard 안에 넣으면 paintBoard가
                     "카드 수보다 자식이 많다"고 보고 지워 버린다. -->
                <div class="ht-board-hold">
                  <div class="ht-board" id="htBoard"></div>
                  <div class="ht-squeeze" id="htSqueeze" hidden></div>
                </div>
                <!-- 중앙에 쌓이는 팟 칩 더미. 팟이 갈라지면 층마다 더미가 따로 선다 —
                     하나로 뭉쳐 있으면 어느 팟을 누가 가져가는지 보여줄 방법이 없다.
                     이름표(MAIN / SIDE 1…)도 각 더미가 직접 달고 있다. -->
                <div class="ht-piles" id="htPotPile"></div>
                <div class="ht-msg" id="htMsg"></div>
                <!-- 승자 족보를 알리던 노란 캡슐(.ht-outro)은 없앴다. 펠트 한가운데에
                     글자 줄이 뜨면 그것이 커뮤니티 카드보다 먼저 눈에 들어온다.
                     족보는 이제 이긴 사람의 좌석 위(.ht-win-h)에 붙는다 — 누가 무엇으로
                     이겼는지가 한 점에서 읽힌다. -->
                <!-- 내 족보를 알리던 줄(.ht-read)도 없앴다. "플러시를 만들어 놓고 모르고
                     폴드하는 걸 막는다"는 목적으로 넣었는데, 자리가 틀렸다 — 펠트 한가운데는
                     앤티와 베팅 칩이 모이는 곳이라 프리플랍에는 그 위에 "QTo"가 겹쳐 앉아
                     칩 금액을 가렸다. 내 카드는 이미 6시 자리에 크게 펼쳐져 있다. -->
                <!-- 래빗 카드가 몇 장인지 글자로도 알려준다 (색만으로는 부족하다) -->
                <div class="ht-rnote" id="htRNote" hidden></div>
                <!-- 래빗 헌트 · 패 공개 버튼은 아래 액션 버튼 줄에 있다 (ht-acts) -->
              </div>

              <!-- 블라인드 상승 알림 — 3초만 뜬다. 테이블 위에 겹쳐 띄워서 놓치지 않게 한다. -->
              <div class="ht-lvup" id="htLvUp" hidden>
                <div class="ht-lvup-t">LEVEL UP</div>
                <div class="ht-lvup-n" id="htLvNo"></div>
                <div class="ht-lvup-b">
                  <span class="ht-lvup-from" id="htLvFrom"></span>
                  <span class="ht-lvup-ar">→</span>
                  <span class="ht-lvup-to" id="htLvTo"></span>
                </div>
              </div>

              <!-- 미스터리 바운티 개봉 — 처형(3발)이 끝난 뒤 펠트 한가운데에서 돈다.
                   미스터리에서는 머리 위 명찰을 아예 그리지 않으므로, 금액이 공개되는
                   자리가 화면에 여기 하나뿐이다. 그래서 중앙에 크게 둔다.

                   카지노 전광판 모양이다. 상자 그림을 CSS 로 만들어 봤는데 조악했다 —
                   숫자가 굴러가다 멈추는 것이 이 연출의 내용이고, 전광판은 그 내용을
                   그대로 담는 틀이다(그림 솜씨에 기대지 않는다).

                   세 줄로 읽힌다: 누구 봉투인가 → 얼마인가 → 누가 가져갔나.
                   여러 명이 동시에 털리면 봉투마다 한 번씩 돈다.

                   골격에 만들어 두고 감췄다 켠다 — 요소를 그때 만들면 첫 프레임에
                   애니메이션이 시작되지 않는다(레이아웃이 아직 없다).
                   ht-seats 보다 앞에 두어 좌석이 전광판 위에 오지 않게 한다. -->
              <div class="ht-mysbox" id="htMysBox" hidden aria-hidden="true">
                <div class="ht-mysbox-glow"></div>
                <div class="ht-mysbox-panel">
                  <div class="ht-mysbox-cap">MYSTERY BOUNTY</div>
                  <div class="ht-mysbox-of" id="htMysOf"></div>
                  <div class="ht-mysbox-reel"><span class="ht-mysbox-amt" id="htMysAmt">?</span></div>
                  <div class="ht-mysbox-who" id="htMysWho"></div>
                  <div class="ht-mysbox-dots" id="htMysDots"></div>
                </div>
              </div>
              <!-- 자리 비움 배너는 없앴다. 상태는 좌석 위 회색 태그가,
                   복귀는 액션 버튼 줄의 [게임 복귀]가 맡는다(htBack3). -->
              <div id="htSeats" class="ht-seats"></div>
              <!-- 베팅 칩·행동 표시는 좌석과 분리한다. 여기가 매 액션마다 바뀌어도
                   좌석의 카드는 그대로 남아 움찔거리지 않는다. -->
              <div id="htSpots" class="ht-seats"></div>
              <!-- 앤티 연출만 쓰는 층. htSpots는 폴링마다 innerHTML로 다시 그려지므로
                   거기에 넣으면 다음 폴링(최대 1초)에 앤티 칩이 사라진다. -->
              <div id="htAnte" class="ht-seats"></div>
            </div>
          </div>
        </div>

        <div class="ht-controls" id="htControls" hidden>
          <div class="ht-ctop" id="htCtop">
            <!-- 왼쪽에서 오른쪽으로 갈수록 금액이 커진다.
                 예전 순서는 1/3 팟 · 1/2 팟 · 팟 · 2BB · 3BB · 올인이었다. 팟 기준
                 셋과 BB 기준 둘을 각각 묶어 놓은 것인데, 화면에서는 그냥 여섯 개가
                 한 줄로 보이므로 "팟 다음에 2BB가 더 작다"가 눈에 걸렸다.
                 손이 가는 방향이 곧 금액의 방향이면 크기를 읽지 않아도 고를 수 있다.
                 3BB를 1BB로 바꾼 것도 같은 이유다 — 최소 단위가 줄의 맨 앞에 있어야
                 "여기서부터 커진다"가 성립한다(3BB는 1/3 팟과 자주 겹쳤다). -->
            <div class="ht-quick" id="htQuick">
              <button type="button" class="ht-q" data-q="bb1">1BB</button>
              <button type="button" class="ht-q" data-q="bb2">2BB</button>
              <button type="button" class="ht-q" data-q="third">1/3 팟</button>
              <button type="button" class="ht-q" data-q="half">1/2 팟</button>
              <button type="button" class="ht-q" data-q="pot">팟</button>
              <button type="button" class="ht-q" data-q="allin">올인</button>
            </div>
            <div class="ht-slider">
              <input type="range" id="htRange" min="0" max="0" step="1" value="0">
              <input type="text" id="htAmount" class="ht-amount" inputmode="numeric" value="0">
              <span class="ht-unit-tag" id="htUnitTag">칩</span>
            </div>
          </div>
          <div class="ht-acts">
            <button type="button" class="hta fold" id="htFold">폴드</button>
            <button type="button" class="hta check" id="htCheck">체크</button>
            <button type="button" class="hta call" id="htCall">콜</button>
            <button type="button" class="hta raise" id="htRaise">레이즈</button>
            <!-- 판이 끝나면 위 네 버튼이 사라지므로 그 자리를 그대로 쓴다.
                 테이블 중앙의 작은 버튼은 눈에 잘 들어오지 않았다.
                 래빗은 왼쪽(나만 보는 것), 패 공개는 오른쪽(남에게 보이는 것). -->
            <button type="button" class="hta post rabbit" id="htRabbit" hidden>🐇 남은 카드 보기</button>
            <!-- 패 공개는 세 갈래다 — 왼쪽 한 장 · 오른쪽 한 장 · 두 장.
                 한 장만 까는 것은 실제 포커의 관례다(블러프였는지 아닌지만 흘린다).
                 이미 깐 장의 버튼은 화면이 감춘다. -->
            <button type="button" class="hta post show" id="htShowL" hidden>👁 왼쪽</button>
            <button type="button" class="hta post show" id="htShowR" hidden>👁 오른쪽</button>
            <button type="button" class="hta post show" id="htShow" hidden>👁 두 장 공개</button>
            <!-- 자리 비움일 때 이 줄에 혼자 선다. 액션 버튼이 늘 같은 자리에 있으므로
                 자리를 비운 사이에도 "내가 누르는 곳"이 바뀌지 않는다. -->
            <button type="button" class="hta back" id="htBack3" hidden>▶ 게임 복귀</button>
          </div>
          <!-- 사전 액션. 내 차례가 아닐 때 액션 버튼 자리에 뜬다.
               상황에 따라 둘씩만 보인다 — 베팅이 없으면 [체크/폴드][체크],
               베팅이 있으면 [폴드][콜 N]. 지금 할 수 없는 선택을 늘어놓으면
               무엇을 고르는 자리인지가 흐려진다. -->
          <div class="ht-pre" id="htPre">
            <label id="htPreCFBox"><input type="checkbox" id="htPreCheckFold"> 체크 / 폴드</label>
            <label id="htPreCBox"><input type="checkbox" id="htPreCheck"> 체크</label>
            <label id="htPreFBox"><input type="checkbox" id="htPreFold"> 폴드</label>
            <label id="htPreCallBox"><input type="checkbox" id="htPreCall"> <span id="htPreCallLabel">콜</span></label>
          </div>
        </div>
      </div>

      <!-- 오른쪽: 토너먼트 정보 + 칩 순위 / 역대 전적 (탭으로 갈아 본다)
           대회 전·후에는 칩 순위가 비어 있어서 이 자리가 통째로 남는다.
           프리롤을 보러 온 사람이 그때 궁금해하는 건 "역대 누가 잘했나"다. -->
      <div class="game-side ht-side">
        <div class="ht-side-head">
          <span id="htSideTitle">데일리 프리롤</span>
        </div>
        <!-- 대회 종료 안내. 테이블 펠트가 아니라 여기다 — 바닥에 시스템 문구를
             인쇄하면 마지막 판의 쇼다운 위로 글자가 겹친다. -->
        <div class="ht-side-note" id="htSideNote" hidden></div>
        <div class="ht-info" id="htInfo"></div>
        <div class="ht-tabs">
          <button type="button" class="ht-tab active" data-htab="live">칩 순위</button>
          <!-- 상금 구조. 예전에는 "지급 인원 2명"만 적혀 있어서, 몇 등까지 얼마를 받는지
               알려면 규칙 도움말을 열어야 했다. 지금 판의 실제 금액을 여기서 보여준다. -->
          <button type="button" class="ht-tab" data-htab="prize">상금</button>
          <button type="button" class="ht-tab" data-htab="rec">역대 전적</button>
        </div>
        <div class="ht-rank" id="htRank"></div>
        <div class="ht-prize-tab" id="htPrizeTab" hidden></div>
        <div class="ht-rec-wrap" id="htRec" hidden>
          <div class="ht-rec" id="htRecList"></div>
        </div>
        <button type="button" class="btn ht-back" id="htBack" hidden>게임 복귀</button>
      </div>
    </div>

    <!-- 우승 축하 — 토너먼트가 끝나는 순간 한 번 뜬다.
         결과표만 조용히 갈아끼우면 대회가 끝난 게 아니라 화면이 넘어간 것처럼 느껴진다. -->
    <div class="ht-win" id="htWin" hidden>
      <div class="ht-win-box">
        <!-- 금빛 후광과 흩날리는 조각. 1등이 났다는 사실 자체가 연출이어야 한다 —
             결과표만 갈아끼우면 대회가 끝난 게 아니라 화면이 넘어간 것처럼 느껴진다. -->
        <div class="ht-win-glow" aria-hidden="true"></div>
        <div class="ht-win-conf" aria-hidden="true"></div>
        <div class="ht-win-crown">👑</div>
        <div class="ht-win-title">WINNER</div>
        <!-- 디스코드 프로필 + 이름을 한 줄에 — 누가 이겼는지가 한눈에 잡혀야 한다 -->
        <div class="ht-win-id"><span id="htWinAv"></span><span class="ht-win-who" id="htWinWho"></span></div>
        <div class="ht-win-prize" id="htWinPrize"></div>
        <div class="ht-win-rest" id="htWinRest"></div>
        <button type="button" class="btn btn-gold ht-win-close" id="htWinClose">확인</button>
      </div>
    </div>

    ${helpDialog('htHelp', '홀덤 토너먼트 규칙', helpBody())}
  <script>window.__ME__ = ${jsonForScript(user.username)}; window.__MEID__ = ${jsonForScript(user.id)};
    window.__CHAT_WHERE__ = 'holdem';
    window.__SFX_NEED__ = ['card','shuffle','deal','chipbet','chipwin','victory',
      'actallin','actbet','actcall','actcheck','actraise','actfold','foldslide','myturn',
      'potwin','clockwarn','allinbgm',
      /* 처형 총성 — 미리 받아 둔다. 탈락은 판이 끝나는 순간에 터지는데 그때 받으러
         가면 소리가 총자국보다 늦게 도착하고, 첫 KO 는 합성음으로 대체된다.
         미스터리 전광판 소리(회전·멈춤)와 바운티 획득 소리도 같은 이유로 함께 받는다 —
         처형이 끝나자마자 이어진다. */
      'gunshot', 'reelroll', 'reelstop', 'bountyearn'];</script>
  <script>
  (function(){
${stateFragment(jsonForScript(ASSET_V))}${CELEBRATE}${RECORDS}${FORMAT}${LOBBY_EMPTY}${LOBBY}${SEATS}${EQUITY}${BADGES}${CLOCK}${REVEAL}${CHIPS}${SIDE}${BOARD}${SETTLE}${DEAL}${TABLE}${CONTROLS}${LOOP}
  })();
  </script>`;
  return layout('홀덤 토너먼트', 'lobby', body);
}
