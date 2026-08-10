/* 홀덤 프리롤 — DB 계층과 지연 진행(lazy advancement).
 *
 * 이 파일의 유일한 설계 원칙: 서버 타이머를 쓰지 않는다.
 * 요청이 들어올 때마다 "지금 시각 기준으로 밀린 일을 전부 처리"한다.
 * 이 서버는 접속이 없으면 약 7분 뒤 절전에 들어가므로 setTimeout으로 블라인드
 * 시계나 액션 마감을 걸면 잠든 사이에 죽는다. 기존 게임 다섯 개가 모두 이 방식이다.
 *
 * 밀린 일이 여러 개일 수 있는 게 홀덤의 특징이다. 아무도 화면을 안 보는 사이
 * 세 명의 액션 마감이 연달아 지났다면 한 요청에서 세 번의 자동 액션을 처리해야
 * 한다. 그래서 advanceTable은 루프다 — 블랙잭처럼 "한 단계 전진"으로는 안 된다.
 *
 * 카드 규칙은 services/holdem.ts, 일정·상금은 services/tournament.ts에 있다.
 * 여기서는 그 순수 함수들을 불러 쓰고 상태를 저장하는 일만 한다.
 */
import { randomInt } from 'node:crypto';
import { one, all, run, tx, adjustBalance, getWebUser } from './queries';
import * as G from '../services/holdem';
import * as T from '../services/tournament';
import { getConfig } from './settings';
import { ensureRecurring } from './recurrence';
import { notifyAll } from './notifications';

/* 알림 문구에 쓸 KST 시:분. 화면이 아니라 알림 본문에 들어가는 값이라 여기서 만든다 —
   받는 사람의 기기 시간대가 무엇이든 우리 대회 시각은 KST 하나다. */
function kstHM(sec: number): string {
  const d = new Date((sec + 9 * 3600) * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** 액션 제한 시간. 스펙에 숫자가 없어 온라인 포커의 통상값(20초)으로 잡았다. */
export const ACTION_SEC = 20;
/* ── 최소 액션 간격 ────────────────────────────────────────────────────
   차례가 넘어와도 이 시간이 지나기 전에는 아무도 행동할 수 없다.

   왜 서버에 두는가: 봇(그리고 자동 체크·자동 콜)은 즉시 결정한다. 클라이언트에서만
   버튼을 잠가도 서버는 액션을 받으므로, 실제로는 "레이즈 → 폴드 → 폴드"가 0.1초 안에
   처리되고 화면은 그 셋을 한 프레임에 몰아 보여준다. 누가 무엇을 했는지 따라갈 수 없다.
   규칙 자체에 간격이 있어야 화면이 따라갈 수 있다.

   스트리트가 열릴 때는 더 길게 준다 — 커뮤니티 카드가 다 열리는 데 클라이언트가
   약 2.1초를 쓴다(ACTION_HOLD 1.1 + 첫 장 0.42 + 두 장 0.6). 그 뒤에 한 박자 쉬고
   첫 행동자가 열리게 3초로 둔다. 보드를 보기도 전에 베팅이 시작되면 안 된다.

   구현: 새 컬럼을 두지 않고 action_deadline을 그만큼 뒤로 민다.
   열리는 시각 = action_deadline - ACTION_SEC 이 항상 성립한다(간격이 0이면 즉시 열린다). */
export const ACT_GAP_SEC = 1;
export const STREET_OPEN_SEC = 3;
/* eslint 없이도 읽히게: 두 값의 관계가 규칙이다 — 스트리트 시작이 더 길다 */
/** 이 차례가 열리는 시각. 마감에서 제한 시간을 되돌리면 나온다. */
export function actOpenAt(hand: { action_deadline: number | null }): number | null {
  return hand.action_deadline == null ? null : hand.action_deadline - ACTION_SEC;
}
/* ── 다음 판이 시작되는 시각 ──────────────────────────────────────────
   이 게임에는 서버 타이머가 없다. 판이 끝나면 "다음 판은 이 시각 이후"만 적어 두고
   (next_hand_at) 실제 진행은 요청이 올 때 일어난다. 그래서 이 값이 곧 화면 연출의
   길이여야 한다 — 짧으면 연출 중에 판이 넘어가고, 길면 끝난 화면을 보고 앉아 있는다.

   화면(web/games/holdem.ts)이 재생하는 순서를 그대로 더한다:

     [카드]  첫 핸드까지 1.10초 + 사람당 0.50초
             남은 보드 — 마지막 핸드가 열린 시점부터
               리버까지 깔림  0
               턴까지 깔림    5.56초  2.5(핸드→보드) + 0.56(첫 장) + 2.5(스퀴즈)
               플랍까지 깔림  8.56초  위 + 3.0(턴 → 리버)
               그 이전       12.02초  2.5 + 0.56 + 0.33 + 0.33 + 2.8 + 3.0 + 2.5

     [정산]  결과 지연 1.50 + 팟 지연 0.55 + 배지 대기 2.50 + 칩 이동 1.80 = 6.35초
             ← 여기까지가 "마지막 칩이 승자 안으로 사라지는" 시점

     [여유]  1.25초 — 승자 스택이 오른 것을 확인하는 시간

   ── 왜 한 번에 반올림하나
   한때 [정산]과 [카드]를 각각 정수 초로 만들어 더했다. 반올림이 두 번 일어나면서
   오차가 최대 1초까지 쌓였고, 실측 간격이 1.5~2.05초로 벌어졌다.
   합을 구하고 마지막에 한 번만 반올림하면 ±0.5초 안에 들어온다.

   ── 왜 폴링 몫을 안 더하나
   예전에는 여기에 "폴링 1초"를 얹었다. 다음 판을 1초 간격 폴링이 발견할 때까지
   기다린다는 전제였는데, 지금은 화면이 그 시각에 직접 폴을 한 번 쏜다
   (holdem.ts의 nextHandPoke). 그 몫을 여기서 또 세면 이중이다. */
const SETTLE_TAIL_SEC = 6.35;   // 카드가 다 열린 뒤 마지막 칩이 흡수될 때까지
const NEXT_HAND_GAP_SEC = 1.25; // 흡수 → 다음 판
/* 사이드 팟 한 층을 더 보여주는 데 드는 시간.
   층마다 [WIN 배지 → 1.0초 대기 → 칩 이동 1.8초 → 더미 시차]를 재생한다. */
const SIDE_POT_STEP_SEC = 2.9;

/** 카드를 다 여는 데 드는 시간(초, 실수). 화면의 박자를 그대로 옮긴 것이다. */
export function revealSec(boardAtEnd: number, liveCount = 2): number {
  const holes = 1.1 + Math.max(0, liveCount - 1) * 0.5;
  const board = boardAtEnd >= 5 ? 0
    : boardAtEnd === 4 ? 5.56
    : boardAtEnd === 3 ? 8.56
    : 12.02;
  return holes + board;
}

/** 판이 끝난 시점부터 다음 판이 시작되기까지 (초, 정수). */
export function nextHandDelaySec(o: {
  showdown: boolean; boardAtEnd: number; liveCount: number; extraPots: number;
}): number {
  const reveal = o.showdown && o.liveCount > 1 ? revealSec(o.boardAtEnd, o.liveCount) : 0;
  const sides = Math.max(0, o.extraPots) * SIDE_POT_STEP_SEC;
  return Math.round(reveal + SETTLE_TAIL_SEC + sides + NEXT_HAND_GAP_SEC);
}
/** 한 요청에서 처리할 진행 단계의 상한 — 무한 루프 방지용 안전장치 */
const MAX_STEPS = 200;

export type Presence = 'ACTIVE' | 'SIT_OUT' | 'DISCONNECTED' | 'OUT';

export interface HtRow {
  id: number; date_str: string; title: string;
  reg_open_at: number; scheduled_start_at: number; grace_ends_at: number;
  prize_multiplier: number;
  started_at: number | null; finished_at: number | null; cancelled_at: number | null;
  starting_stack: number; level_sec: number; late_reg_sec: number;
  prize_fixed: number;
  /** 참가비. 0 이면 프리롤 — 기본값이라 예전 행은 전부 프리롤로 읽힌다 */
  buy_in: number;
  /** 판의 종류. 'CLASSIC'(지금까지의 대회) 또는 'PKO_BOUNTY' */
  mode: string;
  /** 걷은 바운티 펀드 총액. CLASSIC 은 늘 0 이다 */
  bounty_pool: number;
  /** 등록 시작 알림을 보낸 시각. 서버 타이머가 없어서 "한 번만"을 이 열로 지킨다 */
  reg_notified_at: number | null;
}

/** 바운티 대회인가. 문자열 비교를 한 곳에만 둔다 — 오타가 조용히 CLASSIC 으로 읽힌다. */
export function isPko(t: { mode?: string } | null | undefined): boolean {
  return t?.mode === 'PKO_BOUNTY';
}

/**
 * 이 판의 "순수 상금 팟" 총액.
 *
 * PKO 는 참가비의 절반이 바운티로 빠지므로 상금 팟은 그 나머지로만 세어야 한다.
 * 이 계산을 부르는 곳이 네 군데(지급·상태 payload·어드민·로비 안내)라 함수를 하나 둔다 —
 * 한 곳만 빠뜨리면 화면이 약속한 상금과 실제 지급액이 달라지고, 그건 운영자가 아니라
 * 유저가 먼저 발견한다.
 */
export function prizePoolOf(
  t: { prize_multiplier: number; prize_fixed?: number; buy_in: number; mode?: string },
  entryCount: number, prizeFixed = t.prize_fixed ?? 0
): number {
  const per = isPko(t) ? T.prizeShare(t.buy_in) : t.buy_in;
  return T.prizePool(entryCount, t.prize_multiplier, prizeFixed, per);
}
export interface HtTableRow {
  id: number; tournament_id: number; table_no: number;
  button_seat: number; hand_no: number; next_hand_at: number | null;
}
export interface HtSeatRow {
  id: number; table_id: number; seat: number; user_id: string; username: string;
  stack: number; presence: Presence; last_seen_at: number;
}
export interface HtHandRow {
  id: number; table_id: number; hand_no: number;
  level: number; sb: number; bb: number; ante: number; button_seat: number;
  deck_json: string; deck_pos: number; board_json: string;
  street: G.Street; to_act_seat: number | null; action_deadline: number | null;
  last_raise_size: number; ended_at: number | null; result_json: string | null;
  started_at: number;
  last_actor_seat: number | null; last_actor_action: string | null; last_actor_amount: number;
}
export interface HtHandSeatRow {
  id: number; hand_id: number; seat: number; user_id: string;
  hole_json: string; stack: number; bet: number; committed: number;
  state: G.SeatState; acted: number; won: number;
  last_action: string | null; last_amount: number; shown: number;
  /** 깐 장 — 1비트가 첫 장, 2비트가 둘째 장 (0·1·2·3) */
  shown_mask: number;
}
export interface HtEntryRow {
  id: number; tournament_id: number; user_id: string; username: string;
  registered_at: number; finish_place: number | null; elim_seq: number | null;
  eliminated_at: number | null; prize: number;
  /** 등록할 때 실제로 걷은 금액. 되돌릴 때 이 값을 쓴다 — 설정을 다시 읽으면 어긋난다 */
  paid_in: number;
  /** 이 대회에서 내가 떨어뜨린 사람 수 */
  ko_count: number;
  /** 지금 내 머리에 걸린 바운티. KO 당하면 0 이 된다 (PKO 전용) */
  bounty: number;
  /** KO 로 받아 챙긴 바운티 현금 누계 — 이미 잔액에 들어간 돈이다 (PKO 전용) */
  bounty_won: number;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

/* ── 조회 ─────────────────────────────────────────────────────────── */



/* 이미 만들어진 토너먼트의 일정은 저장된 값을 쓴다.
   매번 날짜에서 다시 계산하면 저장한 컬럼이 죽은 데이터가 되고, 특정 판의 시각을
   손볼 방법이 사라진다(감사에서 시각을 당겨 단계를 넘기는 것도 불가능해진다).
   행을 만들 때 계산값을 넣으므로 평소에는 두 값이 같다. */
function scheduleOf(t: HtRow): T.TournamentSchedule {
  const noon = T.kstTimeToUnix(t.date_str, 12, 0);
  return {
    dateStr: t.date_str,
    regOpenAt: t.reg_open_at,
    scheduledStartAt: t.scheduled_start_at,
    graceEndsAt: t.grace_ends_at,
    weekend: T.isKstWeekend(noon * 1000),
    prizeMultiplier: t.prize_multiplier,
    title: t.title,
  };
}

/**
 * 살아 있는 판. 아직 끝나지도 취소되지도 않은 것 — 시작 전(대기)도 포함한다.
 *
 * 하루에 여러 판을 열 수 있게 되면서 유니크 인덱스가 사라졌다. 대신 지켜야 할 규칙이
 * 이것 하나 남는다: 살아 있는 판은 한 번에 하나뿐이다. 둘이 동시에 살아 있으면
 * "지금 어느 판인가"가 사라지고, 등록이 어느 쪽으로 가는지도 알 수 없게 된다.
 *
 * 인덱스로는 표현할 수 없다 — 부분 유니크를 걸려면 조건이 NULL 세 개에 걸리고,
 * SQLite 의 부분 인덱스로는 "여럿 중 하나만"을 못 만든다. 그래서 질의가 지킨다.
 */
export function liveTournament(): HtRow | undefined {
  return one<HtRow>(
    `SELECT * FROM holdem_tournaments
      WHERE finished_at IS NULL AND cancelled_at IS NULL
      ORDER BY id DESC LIMIT 1`);
}

/**
 * 그 날짜의 판. 여러 개일 수 있다(운영자가 임시 판을 열 수 있으므로).
 *
 * 고르는 순서가 중요하다: 아직 살아 있는 판을 먼저 고르고, 그 다음이 최근 것이다.
 * "최근 것"만 보면 임시 판이 끝나는 순간 그 판이 계속 골라져서, 같은 날 대기 중이던
 * 정규 판이 영영 열리지 않는다. 살아 있는 쪽을 먼저 보면 임시 판이 끝난 뒤 정규 판으로
 * 저절로 돌아온다 — 그래서 임시 판을 돌리려고 정규 판을 지울 필요가 없다.
 *
 * 살아 있는 판이 없으면 최근 것을 준다. 그래야 오늘 판이 끝난 뒤에 자동 생성이
 * "오늘 판이 없다"고 보고 새로 만들어 버리는 일이 없다.
 */
function findTournament(dateStr: string): HtRow | undefined {
  return one<HtRow>(
    `SELECT * FROM holdem_tournaments WHERE date_str = ?
      ORDER BY (finished_at IS NULL AND cancelled_at IS NULL) DESC, id DESC LIMIT 1`, dateStr);
}

export function getTable(tournamentId: number): HtTableRow | undefined {
  return one<HtTableRow>(`SELECT * FROM holdem_tables WHERE tournament_id = ? AND table_no = 0`, tournamentId);
}

export function getSeats(tableId: number): HtSeatRow[] {
  return all<HtSeatRow>(`SELECT * FROM holdem_seats WHERE table_id = ? ORDER BY seat ASC`, tableId);
}

/* 최근에 끝난 대회의 우승자. 로비의 "최근 소식"이 쓴다 —
   소규모 커뮤니티에서 다시 들어오는 이유는 "내가 없는 동안 무슨 일이 있었나"다.
   진행 중인 대회는 제외한다(결과가 아직 없다). */
export function recentHoldemWinners(limit = 2): {
  dateStr: string; title: string; username: string; prize: number; players: number;
}[] {
  return all<{ dateStr: string; title: string; username: string; prize: number; players: number }>(
    `SELECT t.date_str AS dateStr, t.title AS title, e.username AS username, e.prize AS prize,
            (SELECT COUNT(*) FROM holdem_entries x WHERE x.tournament_id = t.id) AS players
       FROM holdem_tournaments t
       JOIN holdem_entries e ON e.tournament_id = t.id AND e.finish_place = 1
      WHERE t.finished_at IS NOT NULL
      ORDER BY t.finished_at DESC
      LIMIT ?`, limit);
}

/* ── 역대 프리롤 전적 ──────────────────────────────────────────────────
   지표를 게임별 랭킹(판수·승률·수익액)과 다르게 잡는다. 프리롤은 참가비가 0이라
   상금만 양수로 들어오므로 "수익액"이 실력과 무관하게 참가 횟수만큼 오른다 —
   그래서 게임 랭킹에서 홀덤을 뺐고, 여기서도 같은 함정을 반복하지 않는다.

   대신 대회에서 실제로 의미가 있는 것을 센다: 우승·입상·참가·누적 상금.

   줄 세우는 기준은 누적 상금 하나다 — "지금까지 쭉 얼마를 먹었나". 우승 횟수로도
   정렬할 수 있게 만들어 봤지만 표가 둘로 갈리기만 하고 알고 싶은 것은 하나였다.
   우승 횟수는 줄 안에 같이 적어 둔다.

   끝난 대회만 센다(finished_at). 진행 중인 대회는 등수가 아직 없다.
   새 테이블이 필요 없다 — holdem_entries에 finish_place와 prize가 이미 쌓여 있다. */
export interface HoldemRecordRow {
  userId: string; username: string;
  played: number; wins: number; itm: number; prize: number;
}
/* 범위는 이번 시즌이다.
   랭킹 페이지의 홀덤 탭이 시즌 창으로 세는데(queries/season 의 holdemWindow) 이 표만
   대회 전체를 세면, 같은 사람의 누적 상금이 화면 두 곳에서 다르게 나온다.

   첫 시즌에는 아래 경계가 없다. 시즌이 열리기 전에 이미 대회가 돌고 있었으므로
   시작 시각으로 자르면 그 전에 끝난 대회가 통째로 빠진다 — 랭킹 쪽에서 실제로 그래서
   홀덤 탭이 아예 안 뜬 적이 있다. 앞선 시즌이 없으면 그 기록을 가져갈 다른 주인도 없다.

   행은 지우지 않는다. 지난 시즌 대회는 holdem_entries 에 그대로 남아 있고,
   범위만 좁혀서 보여 준다. */
export function holdemRecords(limit = 20): HoldemRecordRow[] {
  const s = one<{ id: number; number: number; started_at: number; closed_at: number | null }>(
    `SELECT id, number, started_at, closed_at FROM seasons
      WHERE closed_at IS NULL ORDER BY number DESC LIMIT 1`);
  // 시즌이 아직 없으면(초기 상태) 예전처럼 전부 센다 — 빈 표를 보여줄 이유가 없다
  if (!s) return holdemRecordsIn(null, null, limit);
  const first = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM seasons WHERE number < ?`, s.number)!.n === 0;
  return holdemRecordsIn(first ? null : s.started_at, s.closed_at, limit);
}

function holdemRecordsIn(from: number | null, to: number | null, limit: number): HoldemRecordRow[] {
  return all<HoldemRecordRow>(
    `SELECT e.user_id AS userId,
            MAX(e.username) AS username,
            COUNT(*) AS played,
            SUM(CASE WHEN e.finish_place = 1 THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN e.prize > 0 THEN 1 ELSE 0 END) AS itm,
            SUM(e.prize) AS prize
       FROM holdem_entries e
       JOIN holdem_tournaments t ON t.id = e.tournament_id
      WHERE t.finished_at IS NOT NULL AND e.finish_place IS NOT NULL
        AND (? IS NULL OR t.finished_at >= ?)
        AND (? IS NULL OR t.finished_at < ?)
      GROUP BY e.user_id
      ORDER BY prize DESC, wins DESC, played DESC
      LIMIT ?`, from, from, to, to, limit);
}

export function getEntries(tournamentId: number): HtEntryRow[] {
  return all<HtEntryRow>(
    `SELECT * FROM holdem_entries WHERE tournament_id = ? ORDER BY registered_at ASC`, tournamentId);
}

export function getCurrentHand(tableId: number): HtHandRow | undefined {
  return one<HtHandRow>(`SELECT * FROM holdem_hands WHERE table_id = ? ORDER BY hand_no DESC LIMIT 1`, tableId);
}

export function getHandSeats(handId: number): HtHandSeatRow[] {
  return all<HtHandSeatRow>(`SELECT * FROM holdem_hand_seats WHERE hand_id = ? ORDER BY seat ASC`, handId);
}

/**
 * 래빗 헌트 — 폴드로 일찍 끝난 판에서 "깔렸을 카드"를 보여준다.
 *
 * 반드시 핸드가 끝난 뒤에만 부른다. 진행 중에 이걸 내려보내면 남은 카드가 새어
 * 이후 모든 판이 무의미해진다 — 그래서 호출부가 아니라 여기서 직접 막는다.
 * 실제로 깔린 보드는 그대로 두고, 그 뒤에 올 카드만 돌려준다(버닝 카드 규칙까지 그대로).
 */
export function rabbitBoard(hand: HtHandRow): string[] {
  if (hand.ended_at == null) return [];
  const board = JSON.parse(hand.board_json) as number[];
  if (board.length >= 5) return [];          // 이미 다 깔렸다 — 볼 게 없다
  const deck = JSON.parse(hand.deck_json) as number[];
  let pos = hand.deck_pos;
  const rest: number[] = [];
  /* 플랍 전이면 버닝 한 장 + 세 장, 그 뒤로는 스트리트마다 버닝 한 장 + 한 장.
     실제 딜링과 같은 순서로 뽑아야 "그때 나왔을 카드"가 된다. */
  if (board.length === 0) { pos++; for (let i = 0; i < 3 && pos < deck.length; i++) rest.push(deck[pos++]); }
  while (board.length + rest.length < 5 && pos + 1 < deck.length) { pos++; rest.push(deck[pos++]); }
  return G.cardsToStrings(rest);
}

/**
 * 끝난 판에서 내 패를 자발적으로 공개한다 (머킹된 패를 굳이 보여주는 실제 관례).
 *
 * 진행 중에는 절대 허용하지 않는다 — 아직 결과가 안 나온 판에서 자기 패를 흘리면
 * 남은 사람에게 정보를 주는 것이고, 담합의 통로가 된다. 조건을 `WHERE`에 박아
 * 판이 끝났고(ended_at) 내가 그 판에 있었을 때만 한 행이 바뀌게 한다.
 * 이미 쇼다운에 공개된 패라면 굳이 막지 않는다(멱등하다).
 */
/** 어느 장을 깔지. 1 = 첫 장, 2 = 둘째 장, 3 = 둘 다. 그 밖의 값은 둘 다로 본다. */
export type ShowWhich = 1 | 2 | 3;

export function showHoldemCards(userId: string, which: ShowWhich = 3): { ok: boolean } {
  const t = one<HtRow>(`SELECT * FROM holdem_tournaments
      WHERE started_at IS NOT NULL AND finished_at IS NULL AND cancelled_at IS NULL
      ORDER BY id DESC LIMIT 1`);
  if (!t) return { ok: false };
  const table = getTable(t.id);
  if (!table) return { ok: false };
  /* "가장 최근 판이면서 끝난 판"만 고른다. `ended_at IS NOT NULL`을 안쪽 조회에 걸면
     새 판이 도는 중에도 지난 판을 여는 요청이 통과한다 — 정보가 새지는 않지만
     화면(현재 판만 그린다)과 서버가 어긋난다. 하위 조회는 최신 판만 집고,
     끝났는지는 밖에서 본다. */
  /* 이미 깐 장은 도로 덮을 수 없다 — 한 장을 깐 뒤 마음이 바뀌어 나머지도 깔 수 있게
     비트를 더한다(OR). 반대로 줄이는 길은 두지 않는다. 남들이 이미 본 카드를 없던 일로
     만들 수는 없기 때문이다. */
  const mask = which === 1 || which === 2 || which === 3 ? which : 3;
  run(`UPDATE holdem_hand_seats SET shown = 1, shown_mask = shown_mask | ?
       WHERE user_id = ? AND hand_id = (
         SELECT id FROM holdem_hands
         WHERE table_id = ? AND ended_at IS NOT NULL
         ORDER BY hand_no DESC LIMIT 1)
         AND hand_id = (
         SELECT id FROM holdem_hands
         WHERE table_id = ? ORDER BY hand_no DESC LIMIT 1)`,
    mask, userId, table.id, table.id);
  return { ok: one<{ n: number }>(`SELECT changes() AS n`)!.n > 0 };
}

/* 등록자들의 디스코드 아바타 — 해시가 아니라 완성된 이미지 URL이다.
   users.avatar 에는 로그인할 때(web/auth.ts) CDN 주소를 통째로 만들어 넣는다.
   "해시"라고 적어 뒀던 이 주석 때문에 홀덤 화면이 값을 해시로 알고 주소를 한 번 더
   조립했고, 프로필이 전부 깨져 보였다. 주석이 틀리면 코드도 따라 틀린다. */
export function getEntryAvatars(tournamentId: number): Map<string, string | null> {
  const rows = all<{ user_id: string; avatar: string | null }>(
    `SELECT e.user_id, u.avatar FROM holdem_entries e JOIN users u ON u.id = e.user_id
     WHERE e.tournament_id = ?`, tournamentId);
  return new Map(rows.map(r => [r.user_id, r.avatar]));
}

/** 자리에 앉은 사람들의 디스코드 아바타 URL (화면에 원형 프로필로 쓴다) */
export function getSeatAvatars(tableId: number): Map<string, string | null> {
  const rows = all<{ user_id: string; avatar: string | null }>(
    `SELECT s.user_id, u.avatar FROM holdem_seats s JOIN users u ON u.id = s.user_id
     WHERE s.table_id = ?`, tableId);
  return new Map(rows.map(r => [r.user_id, r.avatar]));
}

/** 남아 있는(탈락하지 않은) 좌석 */
function livingSeats(tableId: number): HtSeatRow[] {
  return getSeats(tableId).filter(s => s.presence !== 'OUT');
}

/** DB 행 → 순수 엔진이 쓰는 형태 */
function toViews(rows: HtHandSeatRow[]): G.SeatView[] {
  return rows.map(r => ({
    seat: r.seat, bet: r.bet, stack: r.stack, committed: r.committed,
    state: r.state, acted: r.acted === 1,
  }));
}

/**
 * 마지막 행동을 기록한다. 화면에 "콜 300"처럼 띄우는 용도다.
 *
 * 두 곳에 쓴다.
 *  · 좌석 행 — 이 스트리트에서 그 사람이 뭘 했는지. 스트리트가 넘어가면 초기화된다.
 *  · 핸드 행 — 이 핸드에서 가장 마지막 행동. 초기화되지 않는다.
 * 두 번째가 필요한 이유: 스트리트를 닫는 행동은 nextStreet가 같은 트랜잭션에서
 * 좌석 표시를 지워버리기 때문에, 1초 폴링으로는 그 행동이 클라이언트에 한 번도
 * 도달하지 않는다. 그래서 "누가 마지막에 뭘 했나"를 핸드 쪽에 따로 남긴다.
 */
function noteAction(handId: number, seat: number, kind: G.ActionKind, paid: number): void {
  run(`UPDATE holdem_hand_seats SET last_action = ?, last_amount = ?
       WHERE hand_id = ? AND seat = ?`, kind, paid, handId, seat);
  run(`UPDATE holdem_hands SET last_actor_seat = ?, last_actor_action = ?, last_actor_amount = ?
       WHERE id = ?`, seat, kind, paid, handId);
}

function saveViews(handId: number, views: G.SeatView[]): void {
  for (const v of views) {
    run(`UPDATE holdem_hand_seats SET stack = ?, bet = ?, committed = ?, state = ?, acted = ?
         WHERE hand_id = ? AND seat = ?`,
      v.stack, v.bet, v.committed, v.state, v.acted ? 1 : 0, handId, v.seat);
  }
}

/* ── 토너먼트 상태 ─────────────────────────────────────────────────── */

export interface HoldemStatus {
  /** 대회가 하나도 없을 수 있다. 자동 생성을 없앤 뒤로는 운영자가 열어야 생긴다. */
  tournament: HtRow | null;
  schedule: T.TournamentSchedule | null;
  status: T.TournamentStatus | 'NONE';
  registered: number;
  seated: number;
}



/**
 * 지금 다뤄야 할 토너먼트.
 *
 * 진행 중인 판이 있으면 날짜와 무관하게 그것을 계속 쓴다.
 * 22:00에 시작한 판이 자정을 넘기면(레이트 레그가 붙거나 판이 길어지면 실제로 넘어간다)
 * 날짜가 바뀌는 순간 "오늘 판"이 새로 생기고, 진행 중이던 테이블은 화면에서 사라진다 —
 * 플레이 중에 로비로 튕긴다. 실제로 자정을 넘기며 이 일이 일어나는 것을 확인했다.
 *
 * 여기서 다루는 것은 "인원 미달"과 다른 상황이다.
 *   · 3명이 안 차서 시작조차 못 한 판 → 23:00에 CANCELLED (statusAt이 판정한다)
 *   · 이미 시작해 카드까지 돌린 판 → 시작한 뒤에는 23:00 규칙이 적용되지 않는다.
 *     아무도 안 보는 사이 얼어붙어 있을 수 있고, 그 판을 계속 붙들면 다음 날 로비를 연
 *     사람이 어제의 시체를 보게 된다.
 *
 * 그래서 버리는 기준을 "다음 판 등록이 열리는 순간"으로 잡는다. 임의의 시간(6시간 등)을
 * 두는 것보다 정확하다 — 충돌이 생길 수 있는 시점이 정확히 그 순간이기 때문이다.
 * 그 전까지는(자정을 넘겨도) 진행 중인 판이 우선이다.
 */
/**
 * 지금 다뤄야 할 대회. 없으면 null.
 *
 * 자동 생성을 없앤 뒤로 규칙이 아주 단순해졌다 — 살아 있는 판이 있으면 그것이고,
 * 없으면 방금 끝난 판(결과를 보여 주는 동안)이고, 그것도 없으면 대회가 없는 것이다.
 *
 * 날짜가 판단에서 완전히 빠졌다. 예전에는 "오늘 판"을 날짜로 찾았고, 그래서 자정을
 * 넘기면 진행 중인 판이 화면에서 사라지는 문제가 있었다(그걸 막는 특별 규칙이 따로 있었다).
 * 이제 살아 있는 판을 곧바로 고르므로 그 문제가 생길 자리가 없다.
 *
 * 살아 있는 판이 여럿일 수는 없다 — 만드는 쪽(db/admin.ts 의 createTournament)이 막는다.
 * 그래도 최근 것을 고르게 해 둔다. 어긋난 데이터가 화면을 죽이는 것보다는 낫다.
 */
function activeTournament(): HtRow | null {
  const live = one<HtRow>(
    `SELECT * FROM holdem_tournaments
      WHERE finished_at IS NULL AND cancelled_at IS NULL
      ORDER BY id DESC LIMIT 1`);
  if (live) return live;
  /* 막 끝난 판. 결과 화면을 띄울 시간을 준다 — 끝나는 순간 화면이 대회를 떠나면
     우승 연출도 마지막 쇼다운도 못 본다.
     유예로 묶는 이유: 안 묶으면 마지막 판이 영원히 "지금 대회"로 남아, 다음 대회를
     열기 전까지 로비가 며칠 전 결과를 계속 보여 준다. 그 시간이 지나면 대회는 없는 것이다. */
  return one<HtRow>(
    `SELECT * FROM holdem_tournaments
      WHERE finished_at IS NOT NULL AND finished_at > ?
      ORDER BY finished_at DESC LIMIT 1`, nowSec() - T.FINISH_LINGER_SEC) ?? null;
}

/* 대회 행에 박아 둔 운영 설정. 0 이면 '코드 기본값을 쓴다'는 뜻이다 —
   설정 기능이 없던 시절에 만들어진 행도 예전과 똑같이 동작해야 한다. */
export function tuning(t: HtRow) {
  return {
    startingStack: t.starting_stack > 0 ? t.starting_stack : T.STARTING_STACK,
    levelSec: t.level_sec > 0 ? t.level_sec : T.LEVEL_DURATION_SEC,
    lateRegSec: t.late_reg_sec > 0 ? t.late_reg_sec : T.LATE_REG_SEC,
    prizeFixed: t.prize_fixed > 0 ? t.prize_fixed : 0,
  };
}

function facts(t: HtRow): T.TournamentFacts {
  return { startedAt: t.started_at, finishedAt: t.finished_at, cancelledAt: t.cancelled_at };
}

/**
 * 이 사람이 앉아 있던 판. 방금 끝난 판을 화면에 붙들어 두기 위한 조회다.
 *
 * activeTournament 는 "지금 몇 시인가"에서 판을 유도한다. 그 방식은 판이 끝나는 순간
 * 무너진다 — 위의 자정 방어는 `finished_at IS NULL` 이 조건이라 종료와 동시에 풀리고,
 * 자정을 넘겨 끝난 판은 그 순간 "오늘 판"이 다음 날 판으로 바뀌어 버린다. 그러면
 * 우승 화면을 띄울 유예(FINISH_LINGER_SEC)가 아예 적용되지 않아, 이긴 사람이 결과를
 * 못 보고 로비로 튕긴다. 실제로 그랬다 — 2026-08-06 판이 23:49 에 시작해
 * 다음 날 01:13 에 끝나면서 이 일이 일어났다.
 *
 * 그래서 "무엇을 보여줄지"는 시계에서 떼어 낸다. 사람이 앉은 자리가 근거다 —
 * 자정이든 다음 판이 생겼든 상관이 없어진다. 시계는 "이제 등록할 수 있는 판"에만 쓴다.
 *
 * 유예 시간으로 창을 닫는다. 안 닫으면 어제 판에 앉았던 사람이 다음 날에도 그 시체를
 * 계속 보게 된다.
 */
function seatedTournament(userId: string, now: number): HtRow | undefined {
  return one<HtRow>(
    `SELECT t.* FROM holdem_tournaments t
       JOIN holdem_tables tb ON tb.tournament_id = t.id
       JOIN holdem_seats s   ON s.table_id = tb.id
      WHERE s.user_id = ? AND t.cancelled_at IS NULL
        AND t.finished_at IS NOT NULL AND t.finished_at > ?
      ORDER BY t.finished_at DESC LIMIT 1`,
    userId, now - T.FINISH_LINGER_SEC);
}

/* ── 진행 ─────────────────────────────────────────────────────────── */

/**
 * 오늘 토너먼트를 "지금" 기준으로 최신 상태로 만든다. 모든 요청의 첫 줄에서 부른다.
 * 여기서 하는 일: 시작 판정 → 취소 판정 → 진행 중이면 테이블 전진 → 종료 판정.
 */
export function advanceHoldem(userId?: string): HoldemStatus {
  return tx(() => {
    const now = nowSec();
    /* 방금 끝난 판에 앉아 있던 사람에게는 그 판을 돌려준다 — seatedTournament 를 보라.
       전진시킬 것은 없다(끝난 판이다). 여기서 바로 돌아가는 이유는, 그 사이에 운영자가
       새 대회를 열었을 때 화면이 그쪽으로 갈아치워지는 것을 막기 위해서다 —
       마지막 판의 쇼다운과 우승 화면을 보고 있는 중이다. */
    if (userId != null) {
      const mine = seatedTournament(userId, now);
      if (mine != null) {
        const ms = scheduleOf(mine);
        return {
          tournament: mine,
          schedule: ms,
          status: T.statusAt(now, ms, facts(mine), getEntries(mine.id).length),
          registered: getEntries(mine.id).length,
          seated: 0,   // 끝난 판이라 살아 있는 자리가 없다 — 화면은 shownSeats로 그린다
        };
      }
    }
    /* 반복 개최를 켜 뒀으면 다음 판을 미리 만들어 둔다. 꺼져 있으면 아무 일도 없다.
       서버 타이머가 없으므로 이런 일은 전부 요청이 들어올 때 따라잡는다. */
    ensureRecurring(now);

    let t = activeTournament();
    /* 대회가 하나도 없을 수 있다 — 자동 생성을 없앤 뒤로는 운영자가 열어야 생긴다.
       전진시킬 것도, 판정할 것도 없다. 화면은 이 상태를 "예정된 대회 없음"으로 그린다. */
    if (!t) return { tournament: null, schedule: null, status: 'NONE', registered: 0, seated: 0 };
    const s = scheduleOf(t);
    let regs = getEntries(t.id);

    /* 등록 창이 열렸다고 알린다.
       이 게임에는 서버 타이머가 없어서 "열렸다"를 요청이 들어올 때 알아채는데, 그 판정은
       한 번 참이 되면 계속 참이라 표시가 없으면 요청마다 알림이 나간다. 그래서 조건부
       UPDATE 로 먼저 자리를 차지하고, 실제로 줄을 바꾼 요청만 알린다.
       아직 시작도 취소도 안 한 판에만 보낸다 — 서버가 몇 시간 죽어 있다가 깨어나면
       이미 끝난 판의 등록 알림이 뒤늦게 나갈 수 있다. */
    if (t.reg_notified_at == null && t.started_at == null && t.cancelled_at == null
        && now >= s.regOpenAt && now < s.scheduledStartAt) {
      run(`UPDATE holdem_tournaments SET reg_notified_at = ?
            WHERE id = ? AND reg_notified_at IS NULL`, now, t.id);
      if (one<{ n: number }>(`SELECT changes() AS n`)!.n === 1) {
        notifyAll('TOURNAMENT_OPEN', '홀덤 프리롤 등록 시작',
          `${t.title} · ${kstHM(s.scheduledStartAt)} 시작`, '/games/holdem');
      }
      t = one<HtRow>(`SELECT * FROM holdem_tournaments WHERE id = ?`, t.id)!;
    }

    // 시작: 예정 시각이 지났고 최소 인원이 찼는데 아직 시작 기록이 없다
    if (t.started_at == null && t.cancelled_at == null && now >= s.scheduledStartAt
        && regs.length >= T.MIN_PLAYERS) {
      startTournament(t, regs, now);
      t = one<HtRow>(`SELECT * FROM holdem_tournaments WHERE id = ?`, t.id)!;
    }

    // 취소: 대기 시간까지 인원이 안 찼다
    if (t.started_at == null && t.cancelled_at == null && now >= s.graceEndsAt
        && regs.length < T.MIN_PLAYERS) {
      run(`UPDATE holdem_tournaments SET cancelled_at = ? WHERE id = ? AND cancelled_at IS NULL`, now, t.id);
      /* 참가비를 걷었으면 돌려준다. 판이 열리지 않았고, 인원 미달은 참가자 잘못이 아니다.
         돌려주지 않으면 3명이 안 모여 취소된 판에 돈만 잃는 사람이 생긴다. */
      refundEntries(t.id, 'holdem:cancel:');
      t = one<HtRow>(`SELECT * FROM holdem_tournaments WHERE id = ?`, t.id)!;
    }

    // 진행 중이면 테이블을 전진시킨다
    if (t.started_at != null && t.finished_at == null && t.cancelled_at == null) {
      const table = getTable(t.id);
      if (table) advanceTable(t, table, now);
      t = one<HtRow>(`SELECT * FROM holdem_tournaments WHERE id = ?`, t.id)!;
    }

    regs = getEntries(t.id);
    const table = getTable(t.id);
    return {
      tournament: t,
      schedule: s,
      status: T.statusAt(now, s, facts(t), regs.length),
      registered: regs.length,
      seated: table ? livingSeats(table.id).length : 0,
    };
  });
}

/** 토너먼트 시작 — 테이블을 만들고 등록자를 앉힌 뒤 첫 핸드를 돌린다. */
function startTournament(t: HtRow, regs: HtEntryRow[], now: number): void {
  run(`UPDATE holdem_tournaments SET started_at = ? WHERE id = ? AND started_at IS NULL`, now, t.id);
  // 경합으로 이미 다른 요청이 시작시켰다면 여기서 멈춘다
  const fresh = one<HtRow>(`SELECT * FROM holdem_tournaments WHERE id = ?`, t.id)!;
  if (fresh.started_at !== now) return;

  run(`INSERT INTO holdem_tables (tournament_id, table_no, button_seat, hand_no) VALUES (?, 0, 0, 0)`, t.id);
  const tableId = one<{ id: number }>(`SELECT last_insert_rowid() AS id`)!.id;

  /* 자리 배치는 등록 순서를 섞어서 정한다 — 등록 순서대로 앉히면
     먼저 등록한 사람이 항상 버튼 근처에 앉아 첫 판부터 위치 이득을 본다. */
  const order = regs.map(r => r);
  for (let i = order.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
  }
  order.forEach((r, seat) => {
    run(`INSERT INTO holdem_seats (table_id, seat, user_id, username, stack, presence, last_seen_at)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)`,
      tableId, seat, r.user_id, r.username, tuning(t).startingStack, now);
  });

  const table = one<HtTableRow>(`SELECT * FROM holdem_tables WHERE id = ?`, tableId)!;
  startHand(t, table, now);
}

/**
 * 진행 중인 대회를 "방금 시작한 상태"로 되돌린다. 관리자용이다.
 *
 * 앉아 있는 사람은 그대로 두고 전원 시작 스택으로, 블라인드는 1레벨로,
 * 판 번호는 0으로 돌린 뒤 첫 판을 새로 돌린다.
 *
 * 왜 필요한가: 서버가 죽거나 심하게 느려서 판이 제대로 진행되지 못한 대회를
 * 그대로 두면 칩만 엉킨 채 남는다. 취소하고 새로 열면 그날 대회가 사라지고
 * 모인 사람이 흩어진다 — 사람은 그대로 두고 판만 되감는 쪽이 낫다.
 *
 * 블라인드 레벨은 저장된 값이 아니라 started_at 으로부터 흐른 시간으로 계산된다
 * (levelAt). 그래서 started_at 을 지금으로 옮기는 것이 곧 1레벨로 되돌리는 것이다.
 *
 * 이 함수는 앱 자신의 DB 연결로 돈다. 예전에 같은 일을 외부 프로세스로 sqlite 파일을
 * 열어서 처리했다가 쓰기 락이 남아 서버가 통째로 멎었다 — 그래서 앱 안에 둔다.
 */
export function adminResetRunningTournament(): {
  ok: boolean; reason?: string; tournamentId?: number; seats?: number;
} {
  const now = nowSec();
  const t = one<HtRow>(
    `SELECT * FROM holdem_tournaments
      WHERE started_at IS NOT NULL AND finished_at IS NULL AND cancelled_at IS NULL
      ORDER BY id DESC LIMIT 1`);
  if (!t) return { ok: false, reason: 'no_running_tournament' };
  const table = one<HtTableRow>(`SELECT * FROM holdem_tables WHERE tournament_id = ?`, t.id);
  if (!table) return { ok: false, reason: 'no_table' };

  /* 진행 중이던 판을 통째로 버린다. hand_seats 를 먼저 지운다 — 핸드가 먼저 사라지면
     어느 핸드에 딸린 줄인지 알 수 없어 고아 행이 남는다. */
  run(`DELETE FROM holdem_hand_seats WHERE hand_id IN
         (SELECT id FROM holdem_hands WHERE table_id = ?)`, table.id);
  run(`DELETE FROM holdem_hands WHERE table_id = ?`, table.id);

  // 앉아 있는 사람은 그대로. 스택만 되돌리고 탈락 표시를 푼다
  run(`UPDATE holdem_seats SET stack = ?, presence = 'ACTIVE', last_seen_at = ?
        WHERE table_id = ?`, tuning(t).startingStack, now, table.id);
  /* KO 도 되돌린다. 안 되돌리면 되감기 전에 떨어뜨린 사람이 그대로 남아, 다시 돌린
     대회에서 실제로 떨어뜨린 수보다 많이 세어진다("한 대회에서"가 깨진다). */
  run(`UPDATE holdem_entries SET finish_place = NULL, elim_seq = NULL,
         eliminated_at = NULL, prize = 0, ko_count = 0 WHERE tournament_id = ?`, t.id);

  // 블라인드 1레벨 = 시작 시각을 지금으로
  run(`UPDATE holdem_tournaments SET started_at = ?, finished_at = NULL, cancelled_at = NULL
        WHERE id = ?`, now, t.id);
  run(`UPDATE holdem_tables SET hand_no = 0, button_seat = 0, next_hand_at = NULL
        WHERE id = ?`, table.id);

  const fresh = one<HtRow>(`SELECT * FROM holdem_tournaments WHERE id = ?`, t.id)!;
  const tb = one<HtTableRow>(`SELECT * FROM holdem_tables WHERE id = ?`, table.id)!;
  startHand(fresh, tb, now);

  const seats = one<{ c: number }>(
    `SELECT COUNT(*) AS c FROM holdem_seats WHERE table_id = ?`, table.id)!.c;
  return { ok: true, tournamentId: t.id, seats };
}

/**
 * 테이블을 전진시킨다. 밀린 일을 다 처리할 때까지 도는 루프다.
 *
 * 한 바퀴에서 하는 일 중 하나:
 *  · 다음 핸드를 시작한다 (쇼다운 시간이 끝났다)
 *  · 액션 마감이 지난 사람을 자동 처리한다 (체크 가능하면 체크, 아니면 폴드)
 *  · 베팅 라운드가 끝났으면 다음 스트리트로 넘기거나 쇼다운한다
 *  · 더 할 일이 없으면 빠져나온다
 */
function advanceTable(t: HtRow, table: HtTableRow, now: number): void {
  /* 베팅이 완전히 끝난 순간의 보드 장수.
     쇼다운 승률은 "결과가 남은 카드에만 달린" 시점의 보드로 계산해야 한다.
     그 값을 endHand에서 읽으면 이미 늦다 — 전원 올인이면 아래 루프가 nextStreet를
     연달아 불러 보드를 리버까지 채우고 나서 endHand에 닿기 때문에, endHand가 보는
     보드는 언제나 5장이다(실제로 승률이 한 번도 담기지 않았던 이유다).
     그래서 "더 이상 베팅이 있을 수 없다"를 처음 확인한 그 자리에서 기억해 둔다. */
  let lockedBoardLen: number | null = null;
  for (let step = 0; step < MAX_STEPS; step++) {
    const living = livingSeats(table.id);

    // 한 명만 남았으면 토너먼트 종료
    if (living.length <= 1) { finishTournament(t, table, now); return; }

    let hand = getCurrentHand(table.id);

    // 핸드가 끝났거나 아직 없다 → 다음 핸드 시작 시각을 기다린다
    if (!hand || hand.ended_at != null) {
      const at = table.next_hand_at;
      if (at == null) return;              // 시작 예약이 없다 (이상 상태 — 다음 요청에서 다시 본다)
      if (now < at) return;                // 쇼다운을 보여주는 중
      const fresh = one<HtTableRow>(`SELECT * FROM holdem_tables WHERE id = ?`, table.id)!;
      startHand(t, fresh, now);
      table = one<HtTableRow>(`SELECT * FROM holdem_tables WHERE id = ?`, table.id)!;
      continue;
    }

    const rows = getHandSeats(hand.id);
    const views = toViews(rows);

    // 팟을 다툴 사람이 한 명뿐이면 쇼다운 없이 끝난다
    if (G.contenders(views).length <= 1) {
      endHand(t, table, hand, views, false, now, lockedBoardLen);
      table = reload(table.id); continue;
    }

    /* 더 이상 베팅이 있을 수 없는가 — 남은 사람 중 칩이 있는 사람이 한 명 이하일 때다.
       혼자 남은 사람은 상대가 없어 베팅할 수 없으므로, 이 시점부터 보드는 그냥 깔릴 뿐이다.
       그 순간의 보드 장수가 승률 계산의 기준이 된다(그 뒤로는 정보가 늘지 않는다). */
    if (lockedBoardLen == null) {
      const live = views.filter(v => v.state !== 'folded');
      if (live.filter(v => v.state !== 'allin').length <= 1) {
        lockedBoardLen = (JSON.parse(hand.board_json) as number[]).length;
      }
    }

    if (G.bettingRoundClosed(views)) {
      if (hand.street === 'river') {
        endHand(t, table, hand, views, true, now, lockedBoardLen);
        table = reload(table.id); continue;
      }
      nextStreet(hand, views, now);
      continue;
    }

    // 아직 라운드가 안 끝났다 — 행동할 사람이 있어야 한다
    if (hand.to_act_seat == null) { setToAct(hand, views, hand.button_seat, now); continue; }

    /* 자리 비움인 사람은 기다리지 않고 바로 넘긴다.
       20초는 "지금 보고 있는 사람이 생각할 시간"이다. 이미 자리를 비운 사람에게 그 시간을
       주면 남은 사람 전부가 매 차례 20초씩 멈춰 서 있게 된다 — 3인 판이면 한 바퀴에 40초가
       빈다. SIT_OUT은 한 번 시간을 초과해서 붙는 표시이므로(아래) 유예는 이미 한 번 줬다.

       DISCONNECTED는 여기 넣지 않는다. 잠깐 끊긴 것일 수 있어서 20초는 돌아올 기회로 둔다 —
       돌아오지 못하면 그 한 번의 초과로 SIT_OUT이 되고, 그 뒤부터는 바로 넘어간다. */
    const awaySeat = hand.to_act_seat != null && one<{ presence: string }>(
      `SELECT presence FROM holdem_seats WHERE table_id = ? AND seat = ?`,
      table.id, hand.to_act_seat)?.presence === 'SIT_OUT';
    const deadline = hand.action_deadline ?? now;
    /* 자리 비움도 최소 간격은 지킨다. 예전에는 마감을 통째로 무시했는데, 그러면 자리 비움이
       둘 이상일 때 이 while 루프가 그들 전부를 한 번의 호출에서 접어 버린다 —
       화면에는 "레이즈 → 폴드 → 폴드"가 0.1초 안에 몰려 나온다.
       유예(20초)는 여전히 건너뛴다. 그게 자리 비움을 즉시 넘기는 목적이었다. */
    const openAt = deadline - ACTION_SEC;
    if (awaySeat ? now < openAt : now < deadline) return;   // 아직 기다리는 중

    /* 마감 초과 → 자동 액션. 체크할 수 있으면 체크, 없으면 폴드.
       강제로 콜하지 않는 게 중요하다. 게임이 플레이어 대신 칩을 걸어선 안 된다.
       그리고 스펙 8항대로 그 사람을 SIT_OUT으로 내린다. */
    const seat = hand.to_act_seat;
    const me = views.find(v => v.seat === seat);
    if (!me || !G.canAct(me)) { setToAct(hand, views, seat, now); continue; }
    const la = G.legalActions(me, views, hand.last_raise_size, hand.bb);
    const r = G.applyAction(views, seat, la.canCheck ? 'check' : 'fold', 0, hand.last_raise_size, hand.bb);
    if (r.ok) {
      saveViews(hand.id, views);
      noteAction(hand.id, seat, r.kind, r.paid);
      run(`UPDATE holdem_hands SET last_raise_size = ? WHERE id = ?`, r.lastRaiseSize, hand.id);
    }
    run(`UPDATE holdem_seats SET presence = 'SIT_OUT'
         WHERE table_id = ? AND seat = ? AND presence <> 'OUT'`, table.id, seat);
    hand = getCurrentHand(table.id)!;
    setToAct(hand, views, seat, now);
  }
}

function reload(tableId: number): HtTableRow {
  return one<HtTableRow>(`SELECT * FROM holdem_tables WHERE id = ?`, tableId)!;
}

/** 다음 행동자를 정한다. 없으면 to_act를 비운다(라운드 종료로 판정된다).
 *  gapSec: 차례가 열리기까지의 최소 간격. 마감을 그만큼 뒤로 밀어 표현한다
 *  (열리는 시각 = 마감 - ACTION_SEC). 제한 시간 20초는 열린 뒤부터 온전히 준다. */
function setToAct(
  hand: HtHandRow, views: G.SeatView[], from: number, now: number, gapSec = ACT_GAP_SEC
): void {
  const next = G.nextActor(views, from, T.MAX_PLAYERS);
  if (next == null) {
    run(`UPDATE holdem_hands SET to_act_seat = NULL, action_deadline = NULL WHERE id = ?`, hand.id);
  } else {
    run(`UPDATE holdem_hands SET to_act_seat = ?, action_deadline = ? WHERE id = ?`,
      next, now + gapSec + ACTION_SEC, hand.id);
  }
}

/** 새 핸드를 시작한다 — 블라인드 레벨을 확정하고 카드를 돌린다. */
function startHand(t: HtRow, table: HtTableRow, now: number): void {
  const living = livingSeats(table.id);
  if (living.length <= 1) return;

  const occupied = living.map(s => s.seat);
  /* 버튼은 "직전 핸드의 버튼 다음 생존자". 첫 핸드는 저장된 button_seat(0)에서
     한 칸 앞으로 되돌려 0번이 버튼이 되게 한다. */
  const button = table.hand_no === 0
    ? (occupied.includes(table.button_seat) ? table.button_seat : occupied[0])
    : (G.nextButton(occupied, table.button_seat, T.MAX_PLAYERS) ?? occupied[0]);

  /* 블라인드 레벨은 핸드를 시작하는 이 순간에 확정해서 저장한다.
     스펙 5항의 "8분이 지나도 진행 중인 핸드는 끝난 뒤 다음 핸드부터 상승"이
     이렇게 자동으로 지켜진다 — 핸드 도중에는 다시 계산하지 않는다. */
  const lv = T.levelAt(now - (t.started_at ?? now), tuning(t).levelSec);
  const deck = G.shuffleDeck(randomInt);
  const handNo = table.hand_no + 1;

  run(`INSERT INTO holdem_hands
         (table_id, hand_no, level, sb, bb, ante, button_seat, deck_json, deck_pos,
          board_json, street, last_raise_size, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', 'preflop', ?, ?)`,
    table.id, handNo, lv.level, lv.sb, lv.bb, lv.ante, button, JSON.stringify(deck), lv.bb, now);
  const handId = one<{ id: number }>(`SELECT last_insert_rowid() AS id`)!.id;
  run(`UPDATE holdem_tables SET hand_no = ?, button_seat = ?, next_hand_at = NULL WHERE id = ?`,
    handNo, button, table.id);

  // 좌석 등록 + 홀 카드 두 장 (실제 테이블처럼 한 바퀴씩 두 번 돈다)
  let pos = 0;
  const holes = new Map<number, number[]>();
  for (const s of living) holes.set(s.seat, []);
  for (let pass = 0; pass < 2; pass++) {
    for (const s of living) holes.get(s.seat)!.push(deck[pos++]);
  }
  for (const s of living) {
    run(`INSERT INTO holdem_hand_seats (hand_id, seat, user_id, hole_json, stack, state)
         VALUES (?, ?, ?, ?, ?, 'active')`,
      handId, s.seat, s.user_id, JSON.stringify(holes.get(s.seat)), s.stack);
  }
  run(`UPDATE holdem_hands SET deck_pos = ? WHERE id = ?`, pos, handId);

  const hand = one<HtHandRow>(`SELECT * FROM holdem_hands WHERE id = ?`, handId)!;
  const views = toViews(getHandSeats(handId));

  /* 앤티 → 블라인드 순서로 걷는다.
     스택이 부족하면 있는 만큼만 내고 올인이 된다(실제 규칙). */
  if (lv.ante > 0) {
    for (const v of views) {
      const paid = Math.min(lv.ante, v.stack);
      v.stack -= paid; v.committed += paid;
      if (v.stack === 0) v.state = 'allin';
    }
  }
  const bp = G.blindPositions(occupied, button, T.MAX_PLAYERS);
  if (!bp) { saveViews(handId, views); return; }
  for (const [seat, amount] of [[bp.sb, lv.sb], [bp.bb, lv.bb]] as const) {
    const v = views.find(x => x.seat === seat);
    if (!v) continue;
    const paid = Math.min(amount, v.stack);
    v.stack -= paid; v.bet += paid; v.committed += paid;
    if (v.stack === 0) v.state = 'allin';
  }
  saveViews(handId, views);

  /* 프리플랍 첫 행동자. 블라인드를 낸 것은 "행동"이 아니므로 acted는 그대로 0이다.
     카드가 다 돌아갈 때까지는 열지 않는다 — 화면은 앤티를 걷고 열두 장을 한 장씩 돌리는 데
     2~3초를 쓴다. 그 전에 첫 베팅이 들어오면 카드를 받기도 전에 판이 시작된다. */
  setToAct(hand, views, prevSeat(bp.firstToAct, occupied), now, STREET_OPEN_SEC);
}

/** occupied 안에서 seat의 바로 앞 자리 — setToAct가 "다음"을 찾으므로 한 칸 뒤에서 시작한다 */
function prevSeat(seat: number, occupied: number[]): number {
  for (let i = 1; i <= T.MAX_PLAYERS; i++) {
    const cand = (seat - i + T.MAX_PLAYERS * 2) % T.MAX_PLAYERS;
    if (occupied.includes(cand)) return cand;
  }
  return seat;
}

/** 다음 스트리트로 — 보드를 깔고 베팅을 초기화한다 */
function nextStreet(hand: HtHandRow, views: G.SeatView[], now: number): void {
  const idx = G.STREETS.indexOf(hand.street);
  const next = G.STREETS[idx + 1];
  const deck = JSON.parse(hand.deck_json) as number[];
  const board = JSON.parse(hand.board_json) as number[];
  let pos = hand.deck_pos;

  // 실제 딜링처럼 버닝 카드 한 장을 태운 뒤 깐다
  pos++;
  while (board.length < G.BOARD_COUNT[next]) board.push(deck[pos++]);

  for (const v of views) { v.bet = 0; v.acted = false; }
  run(`UPDATE holdem_hands SET street = ?, board_json = ?, deck_pos = ?, last_raise_size = ?,
         to_act_seat = NULL, action_deadline = NULL WHERE id = ?`,
    next, JSON.stringify(board), pos, hand.bb, hand.id);
  // 스트리트가 바뀌면 지난 스트리트의 행동 표시도 지운다 (폴드는 남겨 둔다 — 계속 유효하다)
  run(`UPDATE holdem_hand_seats SET bet = 0, acted = 0,
         last_action = CASE WHEN last_action = 'fold' THEN 'fold' ELSE NULL END,
         last_amount = 0
       WHERE hand_id = ?`, hand.id);
  saveViews(hand.id, views);

  const fresh = one<HtHandRow>(`SELECT * FROM holdem_hands WHERE id = ?`, hand.id)!;
  const occupied = views.map(v => v.seat);
  const first = G.firstToActPostflop(occupied, hand.button_seat, T.MAX_PLAYERS);
  /* 카드가 다 열릴 때까지는 아무도 행동할 수 없다. 보드를 보기 전에 베팅이 시작되면
     "카드가 펼쳐지는 중에 이미 다음 액션이 진행되는" 화면이 된다. */
  setToAct(fresh, views, prevSeat(first ?? hand.button_seat, occupied), now, STREET_OPEN_SEC);
}

/* 쇼다운에서 스트레이트 플러시를 띄운 사람에게 과제를 준다.
   족보 이름은 이미 result.reveal 에 들어 있다 — 다시 계산하면 그때 본 결과와 어긋날 수
   있고(판정이 바뀌면 옛 판이 다르게 읽힌다), 무엇보다 화면에 뜬 것과 같은 값이어야 한다.
   로열 플러시는 이름이 따로지만 스트레이트 플러시의 일종이라 함께 센다. */
const SF_NAMES = ['스트레이트 플러시', '로열 플러시'];

function awardStraightFlush(
  t: HtRow, rows: HtHandSeatRow[], reveal: { seat: number; hand: string }[], now: number
): void {
  void now;
  for (const r of reveal) {
    if (!SF_NAMES.includes(r.hand)) continue;
    const seat = rows.find(x => x.seat === r.seat);
    if (!seat) continue;
    /* 과제 판정이 판을 멈추면 안 된다 — 여기는 팟이 이미 나뉜 뒤라, 던지면 그 다음
       처리(탈락·다음 판 예약)가 통째로 안 돈다. */
    try {
      const { awardIfBet } = require('./achievements') as typeof import('./achievements');
      awardIfBet(seat.user_id, 'ho-straight-flush', t.buy_in, () => true);
    } catch (e) {
      console.error('스트레이트 플러시 판정 오류:', e);
    }
  }
}

/** 핸드 종료 — 팟을 나누고 스택에 반영한다.
 *  lockedBoardLen: 베팅이 완전히 끝난 순간의 보드 장수(advanceTable이 기억해 둔 값).
 *  여기서 board.length를 쓰면 안 된다 — 전원 올인이면 그 전에 nextStreet가 리버까지
 *  채워 놓아서 언제나 5가 나온다. null이면 이 핸드는 정상 진행으로 끝난 것이다. */
function endHand(
  t: HtRow, table: HtTableRow, hand: HtHandRow, views: G.SeatView[], showdown: boolean, now: number,
  lockedBoardLen: number | null = null
): void {
  const rows = getHandSeats(hand.id);
  const board = JSON.parse(hand.board_json) as number[];
  /* 콜되지 않은 초과 베팅을 먼저 돌려준다. 이걸 빼먹으면 상대가 스택이 부족해
     콜하지 못한 차액이 "자격자 없는 팟 층"으로 남아 분배에서 사라진다. */
  const uncalled = G.returnUncalled(views);
  const pots = G.buildPots(views);

  /* 쇼다운 점수. 보드가 5장이 아닌 채로 끝났다면(전원 올인 전에 폴드로 끝남)
     남은 사람이 한 명이므로 점수를 비교할 필요가 없다. */
  const scores = new Map<number, number>();
  const live = views.filter(v => v.state !== 'folded');
  /* 베팅이 끝난 시점의 보드 장수 — 클라이언트가 몇 장을 한 장씩 열어야 하는지가 이 값이고,
     다음 판 시작을 그만큼 미뤄야 마지막 카드를 열다가 판이 넘어가지 않는다.

     advanceTable이 넘겨준 값을 먼저 쓴다. 이 함수가 보는 board는 이미 리버까지 채워져
     있을 수 있다(전원 올인이면 nextStreet가 연달아 불려 여기 오기 전에 다 깐다).
     넘겨준 값이 없으면 정상 진행으로 끝난 판이므로 지금 보드가 그대로 답이다. */
  const boardAtEnd = lockedBoardLen ?? board.length;
  if (live.length === 1) {
    scores.set(live[0].seat, 1);
  } else {
    /* 전원 올인으로 베팅이 끝났는데 보드가 덜 깔렸으면 남은 카드를 채운다(런아웃).
       실제 카지노도 이렇게 한다 — 액션이 없어도 보드는 끝까지 깐다. */
    const deck = JSON.parse(hand.deck_json) as number[];
    let pos = hand.deck_pos;
    while (board.length < 5) { pos++; board.push(deck[pos++]); }
    run(`UPDATE holdem_hands SET board_json = ?, deck_pos = ? WHERE id = ?`,
      JSON.stringify(board), pos, hand.id);
    for (const v of live) {
      const row = rows.find(r => r.seat === v.seat)!;
      scores.set(v.seat, G.handScore(JSON.parse(row.hole_json) as number[], board));
    }
  }

  /* 층별 정산 내역을 그대로 받아 둔다. 화면이 팟을 하나씩 넘겨 보여주려면
     "어느 층을 누가 가져갔는지"가 필요한데, 좌석별 합계(awards)로는 알 수 없다. */
  const potAwards = G.awardPotsDetailed(pots, scores, hand.button_seat, T.MAX_PLAYERS);
  const awards = G.awardPots(pots, scores, hand.button_seat, T.MAX_PLAYERS);
  for (const a of awards) {
    run(`UPDATE holdem_hand_seats SET won = ? WHERE hand_id = ? AND seat = ?`, a.amount, hand.id, a.seat);
  }

  /* 좌석 스택 갱신. 핸드 중 스택(views)에 딴 금액을 더한 값이 최종 스택이다.
     여기서 칩 총량이 보존된다 — 나간 committed의 합과 받은 won의 합이 같아야 한다. */
  const wonBySeat = new Map(awards.map(a => [a.seat, a.amount]));
  for (const v of views) {
    const final = v.stack + (wonBySeat.get(v.seat) ?? 0);
    run(`UPDATE holdem_seats SET stack = ? WHERE table_id = ? AND seat = ?`, final, table.id, v.seat);
  }
  saveViews(hand.id, views);

  const result = {
    showdown,
    uncalled,                              // 되돌려준 초과 베팅 (없으면 null)
    board: G.cardsToStrings(board),
    pots: pots.map(p => ({ amount: p.amount, eligible: p.eligible })),
    awards,
    /* 쇼다운이면 남은 사람의 홀 카드를 공개한다 (폴드로 끝났으면 공개하지 않는다).
       무엇으로 이겼는지(hand)와 이긴 5장(five)도 같이 적어 둔다 — 화면에서 그 5장만
       밝히고 나머지를 흐리게 하려면 어느 카드가 쓰였는지 알아야 한다.
       여기서 한 번 계산해 result_json에 박아 두면 폴링마다 다시 계산할 일이 없고,
       나중에 판정이 바뀌어도 그때 본 결과가 그대로 남는다. */
    reveal: showdown && live.length > 1
      ? live.map(v => {
        const hole = JSON.parse(rows.find(r => r.seat === v.seat)!.hole_json) as number[];
        const sd = G.showdownHand(hole, board);
        return { seat: v.seat, cards: G.cardsToStrings(hole), hand: sd.name, five: sd.five };
      })
      : [],
    /* 층별 정산 — 화면이 팟을 하나씩 넘겨 보여주는 데 쓴다.
       보여줄 순서대로 담는다: 이긴 손이 강한 층부터. 실제 딜러도 가장 센 손이 걸린
       사이드 팟부터 밀어 주고 메인 팟을 마지막에 정리한다. 같은 점수면 위층(사이드)이 먼저다.
       족보 이름은 그 층을 가져간 사람의 것이다 — 층마다 이긴 손이 다를 수 있다. */
    potAwards: showdown && live.length > 1
      ? potAwards
        .slice()
        .sort((a, b) => (b.score - a.score) || (b.index - a.index))
        .map(pa => {
          const w = pa.winners[0];
          const row = w ? rows.find(r => r.seat === w.seat) : undefined;
          const name = row
            ? G.showdownHand(JSON.parse(row.hole_json) as number[], board).name
            : '';
          return {
            index: pa.index, amount: pa.amount,
            winners: pa.winners, hand: name,
          };
        })
      : [],
    /* 스트리트별 승률 — 리버 이전에 액션이 끝난 판(올인 등)에서만 채워진다.
       화면이 보드를 한 장씩 열면서 지금 깔린 장수에 맞는 단계를 보여준다.

       여기서 한 번 계산해 박아 둔다. 폴링마다 다시 계산하면 초당 한 번씩 전수 계산을
       돌리게 되고(턴 기준 46가지 × 사람 수), 무엇보다 판이 끝난 뒤에는 값이 바뀌지 않는다.
       진행 중인 판에는 절대 담기지 않는다 — 승률은 남의 홀 카드를 알아야 나오는 값이라
       진행 중에 내려보내면 그게 곧 정보 유출이다. endHand 안에서만 부르는 이유다. */
    equity: showdown && live.length > 1 && boardAtEnd < 5
      ? G.equityStages(
        live.map(v => ({
          seat: v.seat,
          hole: JSON.parse(rows.find(r => r.seat === v.seat)!.hole_json) as number[],
        })),
        board, boardAtEnd, randomInt)
      : [],
  };
  run(`UPDATE holdem_hands SET ended_at = ?, result_json = ?, to_act_seat = NULL, action_deadline = NULL
       WHERE id = ? AND ended_at IS NULL`, now, JSON.stringify(result), hand.id);

  /* ── 도전과제: 스트레이트 플러시 ────────────────────────────────
     쇼다운에서 공개된 손만 본다. 아무도 안 보고 접힌 손은 "띄웠다"고 하기 어렵고,
     무엇보다 그 손은 화면에도 안 나와서 본인조차 모르고 지나간다.
     result.reveal 이 이미 족보 이름을 담고 있으므로 다시 계산하지 않는다 —
     로열 플러시도 스트레이트 플러시의 일종이라 함께 센다.

     최소 베팅은 이 대회의 참가비를 쓴다. 프리롤은 0 이라 문지기가 서지 않는데,
     그건 맞다: 홀덤은 하루 한 번 열리는 대회라 소액으로 여러 번 돌릴 수가 없다.
     (과제 쪽 min_bet 도 0 으로 넣어 둔다.) */
  awardStraightFlush(t, rows, result.reveal, now);

  // 스택이 0이 된 사람을 탈락 처리한다 (같은 핸드에서 여러 명이 나가면 투입액이 많은 쪽이 상위)
  eliminateBusted(t, table, hand, views, now, potAwards, pots);

  /* 팟이 여러 층이면 화면이 하나씩 넘기며 보여주므로 그만큼 시간이 더 든다.
     늘리지 않으면 마지막 층을 보여주기도 전에 다음 판이 시작된다.
     층 수는 여기서 이미 알고 있으므로 그 값으로 정확히 계산한다.

     같은 승자가 연달아 가져가는 층은 화면이 하나로 합쳐서 한 번만 보여준다
     (mergeSameWinner). 그래서 층 수가 아니라 "승자가 바뀌는 횟수"로 세야 맞다 —
     사이드 팟 세 개를 한 사람이 다 먹으면 화면은 한 번만 재생한다. */
  const shownLayers = potAwards.reduce((n, pa, i) => {
    if (i === 0) return 1;
    const key = (x: typeof pa) => x.winners.map(w => w.seat).sort((a, b) => a - b).join(',');
    return key(pa) === key(potAwards[i - 1]) ? n : n + 1;
  }, 0);
  const extraPots = showdown && live.length > 1 ? Math.max(0, shownLayers - 1) : 0;
  const delay = nextHandDelaySec({
    showdown: showdown && live.length > 1,
    boardAtEnd, liveCount: live.length, extraPots,
  });
  run(`UPDATE holdem_tables SET next_hand_at = ? WHERE id = ?`, now + delay, table.id);
}

/**
 * 탈락 처리. 등수는 여기서 매기지 않고 "탈락 순서"만 기록한다 —
 * 늦은 등록으로 참가자가 늘면 탈락 시점에 계산한 등수가 어긋나기 때문이다
 * (4명일 때 4등을 준 뒤 5번째가 등록되면 5등이 없는 판이 된다).
 * 같은 핸드에서 둘 이상이 나가면 이 핸드에 적게 넣은 쪽이 먼저 나간다(실제 규칙).
 */
function eliminateBusted(
  t: HtRow, table: HtTableRow, hand: HtHandRow, views: G.SeatView[], now: number,
  potAwards: { index: number; winners: { seat: number }[] }[] = [],
  pots: { eligible: number[] }[] = []
): void {
  const busted = getSeats(table.id).filter(s => s.presence !== 'OUT' && s.stack <= 0);
  if (!busted.length) return;
  const ranked = busted.sort((a, b) => {
    const ca = views.find(v => v.seat === a.seat)?.committed ?? 0;
    const cb = views.find(v => v.seat === b.seat)?.committed ?? 0;
    return ca - cb;   // 적게 넣은 사람이 먼저 나간다(= 더 낮은 등수)
  });
  let seq = (one<{ n: number }>(
    `SELECT COALESCE(MAX(elim_seq), 0) AS n FROM holdem_entries WHERE tournament_id = ?`, t.id)!).n;
  /* 최종 스택은 이 함수가 불리기 전에 이미 좌석 표에 써 있다(endHand 가 딴 금액을 더해
     갱신한다). 그래서 "누가 이 판 끝에 칩이 더 많은가"를 여기서 그대로 읽을 수 있다. */
  const seatRows = getSeats(table.id);
  const seatUser = new Map(seatRows.map(s => [s.seat, s.user_id]));
  const seatStack = new Map(seatRows.map(s => [s.seat, s.stack]));
  for (const s of ranked) {
    seq++;
    run(`UPDATE holdem_seats SET presence = 'OUT' WHERE table_id = ? AND seat = ?`, table.id, s.seat);
    run(`UPDATE holdem_entries SET elim_seq = ?, eliminated_at = ?
         WHERE tournament_id = ? AND user_id = ? AND elim_seq IS NULL`, seq, now, t.id, s.user_id);

    /* ── KO 기록 ──────────────────────────────────────────────────
       이 사람의 마지막 칩을 가져간 사람에게 하나 준다.

       "마지막 칩"이 어느 층인지가 요점이다. 사이드 팟은 투입액이 적은 순서대로 쌓이고,
       각 층에는 그 층까지 낸 사람만 자격이 있다(pots[i].eligible). 탈락자가 자격을 가진
       가장 위 층이 그가 마지막 칩을 걸었던 자리이고, 그 층의 승자가 그를 떨어뜨린 사람이다.

       예: 스택 1 : 2 : 3 으로 셋이 올인하고 손 세기가 A > C > B 라면
         · 층0 (A·B·C) → A 가 가져간다
         · 층1 (B·C)   → C 가 가져간다
       B 만 탈락하는데, B 의 마지막 칩은 층1 에 있었으므로 KO 는 C 다.
       한때 이 자리를 "탈락자 순번 i → 층 i" 로 옮겼다가 그 경우에 A 를 세었다 —
       i 는 탈락자 중 몇 번째인지일 뿐이고 층은 투입액으로 정해지므로 서로 다른 값이다.

       자격이 있는 층이 없으면(블라인드로 마지막 칩을 내고 폴드한 경우 — 폴드한 사람은
       eligible 에 안 들어간다) 메인 팟 승자로 본다. 그 칩을 실제로 가져간 사람이다.

       한 층을 나눠 가진 경우(스플릿)에는 그 승자 전부에게 준다 — 둘 다 그를 이겼고,
       KO 를 반으로 쪼갤 방법이 없다. 그래서 탈락자 한 명에 KO 가 둘 붙을 수 있다:
       숏스택이 꼴찌로 터지고 위의 둘이 팟을 나눠 가지면 둘 다 그를 떨어뜨린 것이다.

       단, 이긴 사람이라도 그 판 끝에 칩이 탈락자보다 많지 않으면 세지 않는다. 규칙을
       "떨어진 사람보다 최종 칩이 많은 승자"로 두면, 같은 핸드에서 사이드 팟을 조금
       가져갔지만 자기도 털린 사람이 남을 떨어뜨린 것으로 세지는 일이 없다.

       실패해도 판을 멈추지 않는다: 여기는 팟이 이미 나뉜 뒤라, 던지면 그 다음 처리
       (다음 판 예약)가 통째로 안 돈다. */
    try {
      let layer: { winners: { seat: number }[] } | null = null;
      // potAwards 는 층 번호 오름차순이라, 자격이 있는 것 중 마지막이 가장 위 층이다
      for (const pa of potAwards) {
        if (pots[pa.index]?.eligible.includes(s.seat)) layer = pa;
      }
      if (!layer) layer = potAwards[0] ?? null;
      /* 자격을 통과한 사람만 모은다. 예전에는 이 자리에서 바로 ko_count 를 올렸는데,
         바운티는 "몇 명이 나눠 갖는가"를 먼저 알아야 몫을 정할 수 있다 — 한 명씩
         올리면서 나누면 마지막 사람 몫에 1P 가 붙거나 빠진다. */
      const killers: string[] = [];
      for (const w of layer?.winners ?? []) {
        const uid = seatUser.get(w.seat);
        // 자기 자신을 떨어뜨린 것으로 세지 않는다(같은 핸드에 스택이 0이 된 승자가 있을 수 있다)
        if (!uid || uid === s.user_id) continue;
        // 떨어진 사람보다 최종 칩이 많아야 한다 — 자기도 털린 승자는 남을 떨어뜨린 것이 아니다
        if ((seatStack.get(w.seat) ?? 0) <= s.stack) continue;
        if (!killers.includes(uid)) killers.push(uid);
      }
      for (const uid of killers) {
        run(`UPDATE holdem_entries SET ko_count = ko_count + 1
              WHERE tournament_id = ? AND user_id = ?`, t.id, uid);
      }
      if (isPko(t) && killers.length) settleBounty(t, s.user_id, killers, now);
    } catch (e) {
      console.error('KO 기록 실패:', e);
    }
  }
  void hand;
}

/**
 * PKO 바운티 정산 — 떨어진 사람의 머리 값을 떨어뜨린 사람들에게 넘긴다.
 *
 * 한 사람의 머리 값 b 는 이 함수 안에서 정확히 b 만큼만 움직인다:
 *   · 여럿이 나눠 가지면 splitBounty 가 1P 도 남기지 않고 쪼갠다(공동 KO — 팟을 나눠 이긴 경우).
 *   · 각자의 몫은 다시 [머리에 얹을 몫 + 즉시 현금]으로 갈리고 그 둘의 합이 몫과 같다.
 * 그래서 "펀드에 있던 b 가 사라지고, 같은 b 가 머리와 잔액에 다시 나타난다"가 된다.
 * 펀드 총액(bounty_pool)은 건드리지 않는다 — 그건 걷은 금액의 기록이고, 검산의 기준이다.
 *
 * 현금은 즉시 잔액에 넣는다. 요구서의 "확정 상금으로 즉시 정산"이고, 실제로도 그래야
 * 한다 — 나중에 몰아서 주면 대회가 중단됐을 때 이미 벌어진 KO 의 몫이 사라진다.
 *
 * 던지지 않는다. 부르는 자리가 팟이 이미 나뉜 뒤라 여기서 예외가 나가면 다음 판 예약이
 * 통째로 안 돈다. 대신 실패를 로그로 남긴다.
 */
function settleBounty(t: HtRow, bustedUserId: string, killers: string[], now: number): void {
  const victim = one<{ bounty: number }>(
    `SELECT bounty FROM holdem_entries WHERE tournament_id = ? AND user_id = ?`,
    t.id, bustedUserId);
  const bounty = Math.max(0, Math.floor(victim?.bounty ?? 0));
  if (bounty <= 0 || !killers.length) return;

  /* 먼저 머리를 0 으로 만든다. 조건부 UPDATE 로 "그 값이 그대로 있을 때만" 내린다 —
     같은 사람의 KO 가 두 경로에서 겹쳐 들어와도 두 번 나가지 않는다(상금 지급과 같은 방식).
     changes() 로 실제로 줄이 바뀌었는지 확인하고, 아니면 아무것도 주지 않는다. */
  run(`UPDATE holdem_entries SET bounty = 0
        WHERE tournament_id = ? AND user_id = ? AND bounty = ?`, t.id, bustedUserId, bounty);
  if (one<{ n: number }>(`SELECT changes() AS n`)!.n !== 1) return;

  const shares = T.splitBounty(bounty, killers.length);
  killers.forEach((uid, i) => {
    const { head, cash } = T.bountySplit(shares[i] ?? 0);
    if (head > 0) {
      run(`UPDATE holdem_entries SET bounty = bounty + ?
            WHERE tournament_id = ? AND user_id = ?`, head, t.id, uid);
    }
    if (cash > 0) {
      run(`UPDATE holdem_entries SET bounty_won = bounty_won + ?
            WHERE tournament_id = ? AND user_id = ?`, cash, t.id, uid);
      /* 반드시 adjustBalance 를 거친다 — 잔액을 직접 고치면 "잔액 = 원장 누적합"이 깨진다.
         이 서비스의 유일한 불변식이고 감사가 매번 검사한다. */
      adjustBalance(uid, cash, 'game:holdem:bounty:' + t.id);
    }
  });
  void now;
}

/**
 * 토너먼트 종료 — 마지막 생존자에게 가장 늦은 탈락 순서를 주고, 그 순서로 등수를 확정한다.
 * 등수를 여기서 한꺼번에 매기기 때문에 늦은 등록이 몇 명 끼어들었든 1..N이 빈틈없이 채워진다.
 */
function finishTournament(t: HtRow, table: HtTableRow, now: number): void {
  const living = livingSeats(table.id);
  let seq = (one<{ n: number }>(
    `SELECT COALESCE(MAX(elim_seq), 0) AS n FROM holdem_entries WHERE tournament_id = ?`, t.id)!).n;
  for (const s of living) {
    seq++;
    run(`UPDATE holdem_seats SET presence = 'OUT' WHERE table_id = ? AND seat = ?`, table.id, s.seat);
    run(`UPDATE holdem_entries SET elim_seq = ?, eliminated_at = ?
         WHERE tournament_id = ? AND user_id = ? AND elim_seq IS NULL`, seq, now, t.id, s.user_id);
  }
  /* 등록만 하고 한 판도 앉지 못한 사람(취소 직전 등록 등)도 순서를 받아야 1..N이 채워진다 */
  for (const e of getEntries(t.id)) {
    if (e.elim_seq != null) continue;
    seq++;
    run(`UPDATE holdem_entries SET elim_seq = ?, eliminated_at = ? WHERE id = ? AND elim_seq IS NULL`,
      seq, now, e.id);
  }
  // 탈락이 늦을수록 좋은 등수다 — 마지막 생존자가 1위
  const ordered = all<HtEntryRow>(
    `SELECT * FROM holdem_entries WHERE tournament_id = ? ORDER BY elim_seq ASC`, t.id);
  ordered.forEach((e, i) => {
    run(`UPDATE holdem_entries SET finish_place = ? WHERE id = ?`, ordered.length - i, e.id);
  });

  run(`UPDATE holdem_tournaments SET finished_at = ? WHERE id = ? AND finished_at IS NULL`, now, t.id);
  // 경합으로 이미 다른 요청이 정산했다면 두 번 지급하지 않는다
  const fresh = one<HtRow>(`SELECT * FROM holdem_tournaments WHERE id = ?`, t.id)!;
  if (fresh.finished_at !== now) return;
  payPrizes(fresh, now);
  awardBounty(fresh);
  announceWinner(fresh);
}

/* ── 도전과제: 죽음의 바운티 헌터 ──────────────────────────────────────
   한 대회에서 직접 떨어뜨린 사람이 KO_GOAL 명 이상이고, 그 대회를 우승한다.

   여기서 판정하는 이유: 이 조건은 대회가 끝나야 성립한다(우승이 조건의 절반이다).
   ko_count 는 대회마다 다시 세므로 통산으로 새는 일이 없다.

   최소 베팅은 이 대회의 참가비를 쓴다. 프리롤은 0 이라 문지기가 서지 않는데 그건 맞다 —
   홀덤은 하루 한 번 열리는 대회라 소액으로 여러 번 돌릴 수가 없다. */
const KO_GOAL = 4;

function awardBounty(t: HtRow): void {
  try {
    const win = one<{ user_id: string; ko_count: number }>(
      `SELECT user_id, ko_count FROM holdem_entries
        WHERE tournament_id = ? AND finish_place = 1 LIMIT 1`, t.id);
    if (!win) return;
    const { award } = require('../web/achieve-hook') as typeof import('../web/achieve-hook');
    award(win.user_id, t.buy_in, [['ho-bounty-4', () => win.ko_count >= KO_GOAL]]);
  } catch (e) {
    /* 판정이 던져도 대회 정산은 끝나야 한다 — 여기서 막히면 상금은 이미 나갔는데
       우승 소식이 안 가고, 다음 요청에서 이중 정산 가드에 걸려 영영 안 간다. */
    console.error('죽음의 바운티 헌터 판정 오류:', e);
  }
}

/**
 * 우승 소식을 전체에 알린다.
 *
 * 정산이 끝난 뒤에 부른다 — 상금 금액을 담아야 하는데 그 값은 payPrizes 가 정한다.
 * finishTournament 의 이중 정산 가드 안쪽이라 대회당 한 번만 지나간다.
 *
 * 팝업으로 띄우지는 않는다(TOURNAMENT_WIN). 지나간 일이라 놓쳐도 사라지지 않고,
 * 우승자 본인은 이미 게임 화면에서 우승 연출을 봤다.
 */
function announceWinner(t: HtRow): void {
  const win = one<{ username: string; prize: number }>(
    `SELECT username, prize FROM holdem_entries
      WHERE tournament_id = ? AND finish_place = 1 LIMIT 1`, t.id);
  if (!win) return;
  /* 참가자가 몇 명이었는지 함께 적는다. "3명 중 1등"과 "9명 중 1등"은 다른 소식이고,
     숫자가 없으면 그 판이 어느 정도였는지 알 수 없다. */
  const entries = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM holdem_entries WHERE tournament_id = ?`, t.id)!.n;
  const prize = win.prize > 0 ? ` · ${win.prize.toLocaleString('ko-KR')}P` : '';
  notifyAll('TOURNAMENT_WIN', '홀덤 프리롤 우승',
    `${win.username} 님 우승 (${entries}명 참가)${prize}`, '/games/holdem');
}

/**
 * 상금 지급. 프리롤이라 참가비가 없으므로 이 포인트는 새로 발행된다 —
 * 의도된 정책이다(재미 위주 커뮤니티 포인트). 원장에 남겨 잔액 불변식을 지킨다.
 */
function payPrizes(t: HtRow, now: number): void {
  const entries = getEntries(t.id);
  const pool = prizePoolOf(t, entries.length, tuning(t).prizeFixed);
  const amounts = T.prizeAmounts(pool, entries.length);
  /* 바운티 정산은 상금표와 별개로 돌아야 한다 — 프리롤 PKO 처럼 상금표가 빈 판에서도
     머리에 남은 값과 펀드 잔액은 우승자에게 나가야 하기 때문이다. */
  if (!amounts.length) { payBounties(t, entries); return; }
  const ranked = entries
    .filter(e => e.finish_place != null)
    .sort((a, b) => (a.finish_place ?? 0) - (b.finish_place ?? 0));
  amounts.forEach((amount, i) => {
    const e = ranked[i];
    if (!e || amount <= 0) return;
    /* 이미 지급된 항목은 건드리지 않는다 (조건부 UPDATE로 이중 지급 차단).
       실제로 이 UPDATE 가 줄을 바꿨는지를 changes() 로 본다. 예전에는 값을 다시 읽어
       비교했는데, 그것으로는 "내가 방금 넣었다"와 "원래 그 값이었다"를 구분하지 못한다 —
       이미 같은 금액이 들어 있으면 UPDATE 는 아무것도 안 했는데 검사는 통과해서
       잔액만 한 번 더 올라간다. 지급이 두 번 나가면 원장에 근거 없는 포인트가 남고,
       그건 이 서비스의 유일한 불변식(잔액 = 원장 누적합)이 깨진다는 뜻이다.
       베팅 차감·캐시아웃이 쓰는 것과 같은 방식으로 맞춘다. */
    run(`UPDATE holdem_entries SET prize = ? WHERE id = ? AND prize = 0`, amount, e.id);
    if (one<{ n: number }>(`SELECT changes() AS n`)!.n !== 1) return;
    run(`UPDATE users SET balance = balance + ? WHERE id = ?`, amount, e.user_id);
    const after = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, e.user_id);
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
      e.user_id, amount, 'game:holdem:prize', after?.balance ?? 0);
  });
  payBounties(t, entries);
  void now;
}

/**
 * PKO 마감 정산 — 우승자가 자기 머리에 남은 값과 펀드 잔액을 함께 가져간다.
 *
 * 왜 잔액까지 우승자에게 가는가: 걷은 바운티는 전부 유저에게 돌아가야 하고(요구서의
 * "1P 의 오차도 없이"), 대회가 끝난 시점에 남은 사람은 우승자뿐이다. 남은 것을 두면
 * 그 포인트는 아무에게도 가지 않은 채 DB 에만 남는다 — 걷을 때는 유저 잔액에서 실제로
 * 빠져나갔으므로 그건 서비스가 삼킨 돈이 된다.
 *
 * 잔액은 구조상 0 이어야 한다(머리와 현금의 합이 늘 원래 값이라서). 그래도 계산해서
 * 내보낸다: 등록 취소·중단·손으로 고친 값처럼 계산 밖의 일이 끼면 0 이 아닐 수 있고,
 * 그때 조용히 남는 것보다 우승자에게 가는 편이 맞다. 음수면 아무것도 하지 않는다 —
 * 없는 돈을 만들지 않는 쪽이 먼저다.
 *
 * 이중 지급은 조건부 UPDATE 로 막는다. 머리 값을 0 으로 내리는 것이 곧 "지급했다"는
 * 표시이고, 두 번째 호출은 bounty = 0 이라 아무것도 주지 않는다.
 */
function payBounties(t: HtRow, entries: HtEntryRow[]): void {
  if (!isPko(t)) return;
  const champ = entries.find(e => e.finish_place === 1);
  if (!champ) return;

  /* 지금 살아 있는 머리 값의 합과, 지금까지 현금으로 나간 합. 행을 다시 읽는다 —
     인자로 받은 entries 는 이 판의 KO 정산 이전 값일 수 있다. */
  const cur = all<{ user_id: string; bounty: number; bounty_won: number }>(
    `SELECT user_id, bounty, bounty_won FROM holdem_entries WHERE tournament_id = ?`, t.id);
  const heads = cur.reduce((n, r) => n + Math.max(0, r.bounty), 0);
  const cash = cur.reduce((n, r) => n + Math.max(0, r.bounty_won), 0);
  const mine = Math.max(0, cur.find(r => r.user_id === champ.user_id)?.bounty ?? 0);
  /* 아직 아무에게도 배정되지 않은 펀드 = 걷은 것 − 현금으로 나간 것 − 머리에 걸린 것.
     heads 에는 우승자 머리(mine)도 이미 들어 있으므로 여기서 빼지 않는다 —
     빼면 우승자 몫이 두 번 세어져 걷지 않은 포인트가 나간다(실측 15,000 펀드에 25,000 지급).
     구조상 이 값은 0 이다. 그래도 계산해 내보낸다: 등록 취소·중단처럼 계산 밖의 일이
     끼면 0 이 아닐 수 있고, 그때 DB 에 남기는 것보다 우승자에게 가는 편이 맞다. */
  const left = Math.max(0, Math.floor(t.bounty_pool) - cash - heads);
  const total = mine + left;
  if (total <= 0) return;

  run(`UPDATE holdem_entries SET bounty = 0, bounty_won = bounty_won + ?
        WHERE tournament_id = ? AND user_id = ? AND bounty = ?`,
    total, t.id, champ.user_id, mine);
  if (one<{ n: number }>(`SELECT changes() AS n`)!.n !== 1) return;
  adjustBalance(champ.user_id, total, 'game:holdem:bounty:final:' + t.id);
}

/* ── 유저 동작 ───────────────────────────────────────────────────── */

export type RegisterError =
  'not_open' | 'late_reg_closed' | 'table_full' | 'closed' | 'already' | 'no_funds';
export type UnregisterError = 'not_registered' | 'already_started' | 'closed';

/**
 * 참가 신청 취소 — 대회가 시작되기 전에만 된다.
 *
 * 시작 전에는 등록이 holdem_entries 행 하나일 뿐이라 그 행만 지우면 깨끗하다
 * (좌석과 스택은 시작할 때 한꺼번에 만들어진다). 반대로 시작한 뒤에는 이미 칩을
 * 들고 앉아 있으므로 취소가 성립하지 않는다 — 그건 기권이지 취소가 아니고,
 * 남은 사람의 상금 구조까지 흔든다.
 *
 * 조건을 DELETE의 WHERE에 함께 넣는다. 밖에서 미리 확인만 하면 확인과 삭제 사이에
 * 대회가 시작돼(다른 요청의 advanceHoldem이 시작시킬 수 있다) 이미 앉은 사람의
 * 등록이 지워질 수 있다.
 */
export function unregisterHoldem(userId: string):
  { ok: true; registered: number } | { ok: false; error: UnregisterError } {
  return tx(() => {
    const st = advanceHoldem();
    const t = st.tournament;
    // 대회가 하나도 없을 수 있다 — 자동 생성을 없앤 뒤로는 운영자가 열어야 생긴다
    if (!t || t.finished_at != null || t.cancelled_at != null) return { ok: false, error: 'closed' };

    /* 지우기 전에 얼마를 냈는지 읽어 둔다 — 지운 뒤에는 알 방법이 없다.
       설정의 참가비를 다시 읽지 않는 이유는, 그 사이에 값이 바뀌었으면 걷은 것과 다른
       액수를 돌려주게 되고 그 자리에서 "잔액 = 원장 누적합"이 깨지기 때문이다. */
    const row = one<{ paid_in: number; bounty: number }>(
      `SELECT paid_in, bounty FROM holdem_entries WHERE tournament_id = ? AND user_id = ?`,
      t.id, userId);
    const paid = row?.paid_in ?? 0;
    // 머리 값도 같은 이유로 지우기 전에 읽는다 — 펀드에서 그만큼을 빼야 총액이 맞는다
    const hadBounty = row?.bounty ?? 0;

    run(`DELETE FROM holdem_entries
          WHERE user_id = ? AND tournament_id = (
            SELECT id FROM holdem_tournaments
             WHERE id = ? AND started_at IS NULL
               AND finished_at IS NULL AND cancelled_at IS NULL)`,
      userId, t.id);
    if (one<{ n: number }>(`SELECT changes() AS n`)!.n === 0) {
      // 왜 안 됐는지 갈라서 안내 문구를 정확히 낸다
      const mine = one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM holdem_entries WHERE tournament_id = ? AND user_id = ?`,
        t.id, userId)!.n;
      if (mine === 0) return { ok: false, error: 'not_registered' };
      return { ok: false, error: 'already_started' };
    }
    // 신청을 물렸으니 낸 돈도 돌려준다 (프리롤이면 0이라 아무 일도 없다)
    if (paid > 0) adjustBalance(userId, paid, 'holdem:buyin:refund:' + t.id);
    /* 펀드에서도 뺀다. 안 빼면 남은 사람들의 머리 값 합보다 펀드가 커진 채로 시작해
       마지막에 우승자에게 없는 돈이 나간다(그 차액은 아무도 낸 적이 없는 포인트다). */
    if (hadBounty > 0) {
      run(`UPDATE holdem_tournaments SET bounty_pool = bounty_pool - ? WHERE id = ?`,
        hadBounty, t.id);
    }
    return { ok: true, registered: getEntries(t.id).length };
  });
}

export function registerHoldem(userId: string, username: string):
  { ok: true; registered: number } | { ok: false; error: RegisterError } {
  return tx(() => {
    const st = advanceHoldem();
    const t = st.tournament;
    if (!t || !st.schedule) return { ok: false, error: 'closed' };
    const can = T.canRegister(nowSec(), st.schedule, facts(t), st.registered, st.seated,
      tuning(t).lateRegSec);
    if (!can.ok) return { ok: false, error: can.reason };

    /* 참가비가 있으면 낼 수 있는지 먼저 본다. 걷는 것은 등록이 성립한 뒤다 —
       순서를 바꾸면 자리가 없어서 거절된 사람의 돈이 빠져나간다. */
    const fee = Math.max(0, Math.floor(t.buy_in));
    if (fee > 0 && (getWebUser(userId)?.balance ?? 0) < fee) {
      return { ok: false, error: 'no_funds' };
    }

    /* 마지막 자리를 두고 두 요청이 겹치는 것은 유니크 인덱스가 막는다.
       "빈자리 수를 세고 나서 INSERT" 사이에 다른 요청이 끼어들 수 있으므로
       코드 순서에 기대지 않고 DB 제약으로 막는 게 핵심이다. */
    /* PKO 는 참가비를 두 통으로 나눈다 — 머리에 걸릴 바운티와 순수 상금이다.
       나눈 값을 걷을 때 확정해 행에 적는다: 나중에 참가비 설정을 보고 다시 계산하면
       그 사이에 값이 바뀌었을 때 걷은 것과 다른 액수를 나눠 주게 되고, 이 펀드는
       마지막에 1P 까지 맞춰 내보내야 하는 돈이라 그 어긋남이 곧 없는 포인트가 된다. */
    const myBounty = isPko(t) ? T.bountyShare(fee) : 0;
    try {
      run(`INSERT INTO holdem_entries
             (tournament_id, user_id, username, registered_at, paid_in, bounty)
           VALUES (?, ?, ?, ?, ?, ?)`, t.id, userId, username, nowSec(), fee, myBounty);
    } catch {
      return { ok: false, error: 'already' };
    }
    /* 펀드 총액은 머리 값의 합이다. 인원으로 다시 계산하지 않고 걷은 만큼만 더한다 —
       등록 취소가 섞이면 인원 × 참가비는 실제로 들고 있는 돈과 달라진다. */
    if (myBounty > 0) {
      run(`UPDATE holdem_tournaments SET bounty_pool = bounty_pool + ? WHERE id = ?`,
        myBounty, t.id);
    }

    /* 등록이 성립했으니 걷는다. 반드시 adjustBalance 를 거친다 — 잔액을 직접 고치면
       "잔액 = 원장 누적합"이 깨지고, 그 불변식은 감사가 매번 검사한다.
       걷은 금액은 참가 행(paid_in)에도 남는다. 되돌릴 때 설정을 다시 읽지 않기 위해서다. */
    if (fee > 0) adjustBalance(userId, -fee, 'holdem:buyin:' + t.id);

    /* 진행 중(늦은 등록)이면 빈자리에 바로 앉힌다. 시작 전이면 시작할 때 한꺼번에 앉는다.
       늦게 온 사람도 시작 스택을 받는다 — 프리롤이므로 형평이 아니라 참여가 목적이다. */
    if (t.started_at != null) {
      const table = getTable(t.id);
      if (table) {
        const taken = new Set(getSeats(table.id).filter(s => s.presence !== 'OUT').map(s => s.seat));
        for (let seat = 0; seat < T.MAX_PLAYERS; seat++) {
          if (taken.has(seat)) continue;
          // 예전에 그 자리에 앉았다 탈락한 행이 남아 있으면 치운다
          run(`DELETE FROM holdem_seats WHERE table_id = ? AND seat = ?`, table.id, seat);
          run(`INSERT INTO holdem_seats (table_id, seat, user_id, username, stack, presence, last_seen_at)
               VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)`,
            table.id, seat, userId, username, tuning(t).startingStack, nowSec());
          break;
        }
      }
    }
    return { ok: true, registered: getEntries(t.id).length };
  });
}

export type ActionError =
  /* too_soon은 "차례는 맞지만 아직 열리지 않았다"다. 실패가 아니라 잠깐 뒤에 다시 하면
     되는 상태이므로 호출부(봇·자동 액션)는 다음 주기에 그대로 재시도하면 된다. */
  | 'no_tournament' | 'not_seated' | 'no_hand' | 'not_your_turn' | 'too_soon' | 'illegal'
  /* 사전 액션으로 걸어 둔 콜인데 그 사이 금액이 올랐다 — 실행하지 않는다 */
  | 'call_grew';

/** 힛/폴드가 아니라 포커 액션. amount는 "이 스트리트에 올릴 총액"이다. */
export function holdemAction(
  userId: string, kind: G.ActionKind, amount: number, maxCall?: number
): { ok: true } | { ok: false; error: ActionError; detail?: string } {
  return tx(() => {
    /* 자리 비움 상태에서 직접 버튼을 눌렀다면 전진시키기 전에 먼저 앉은 것으로 되돌린다.
       advanceHoldem이 자리 비움 좌석을 기다리지 않고 즉시 넘기기 때문에, 순서가 반대면
       내 차례가 사라진 뒤에 요청이 도착해 'not_your_turn'이 된다 — 돌아온 사람이
       버튼을 눌러도 아무 일도 일어나지 않고 계속 자동 폴드된다.
       (아래 "직접 행동했으니 앉아 있는 상태로 되돌린다"는 이미 있던 규칙이다.
        즉시 넘기기를 넣으면서 그 규칙이 닿기 전에 차례가 사라지게 됐다.) */
    run(`UPDATE holdem_seats SET presence = 'ACTIVE', last_seen_at = ?
         WHERE user_id = ? AND presence = 'SIT_OUT' AND table_id IN (
           SELECT tb.id FROM holdem_tables tb
             JOIN holdem_tournaments t ON t.id = tb.tournament_id
            WHERE t.finished_at IS NULL AND t.cancelled_at IS NULL)`, nowSec(), userId);
    const st = advanceHoldem();
    if (st.status !== 'RUNNING' || !st.tournament) return { ok: false, error: 'no_tournament' };
    const tour = st.tournament;
    const table = getTable(tour.id);
    if (!table) return { ok: false, error: 'no_tournament' };
    const seatRow = getSeats(table.id).find(s => s.user_id === userId && s.presence !== 'OUT');
    if (!seatRow) return { ok: false, error: 'not_seated' };
    const hand = getCurrentHand(table.id);
    if (!hand || hand.ended_at != null) return { ok: false, error: 'no_hand' };
    if (hand.to_act_seat !== seatRow.seat) return { ok: false, error: 'not_your_turn' };
    const now = nowSec();
    if (hand.action_deadline != null && now > hand.action_deadline) {
      return { ok: false, error: 'not_your_turn' };   // 이미 마감돼 자동 처리될 차례다
    }
    /* 아직 차례가 열리지 않았다. 최소 간격이 규칙에 있어야 봇도 그것을 지킨다 —
       클라이언트에서 버튼만 잠그면 봇(과 자동 체크·자동 콜)은 그대로 즉시 눌러서
       화면이 따라갈 수 없는 속도로 판이 흘러간다. */
    const open = actOpenAt(hand);
    if (open != null && now < open) return { ok: false, error: 'too_soon' };

    const views = toViews(getHandSeats(hand.id));
    /* 사전 액션으로 걸어 둔 콜은 "그때 본 금액"을 넘어서면 실행하지 않는다.
       화면도 금액이 바뀌면 체크를 풀지만 폴링 사이(최대 1초)의 틈이 있고, 하필 그 틈에
       내 차례가 오면 늦는다 — 콜 200을 걸어 뒀는데 5,000이 나가는 사고가 그 틈에서 난다.
       걸어 둔 사람만 이 값을 보내므로 직접 누른 콜은 여기에 걸리지 않는다. */
    if (kind === 'call' && maxCall != null) {
      const me = views.find(v => v.seat === seatRow.seat);
      const la = me ? G.legalActions(me, views, hand.last_raise_size, hand.bb) : null;
      if (la && la.callAmount > maxCall) return { ok: false, error: 'call_grew' };
    }
    const r = G.applyAction(views, seatRow.seat, kind, amount, hand.last_raise_size, hand.bb);
    if (!r.ok) return { ok: false, error: 'illegal', detail: r.error };
    saveViews(hand.id, views);
    noteAction(hand.id, seatRow.seat, r.kind, r.paid);
    run(`UPDATE holdem_hands SET last_raise_size = ? WHERE id = ?`, r.lastRaiseSize, hand.id);
    // 직접 행동했으니 앉아 있는 상태로 되돌린다
    run(`UPDATE holdem_seats SET presence = 'ACTIVE', last_seen_at = ?
         WHERE table_id = ? AND seat = ? AND presence <> 'OUT'`, now, table.id, seatRow.seat);
    const fresh = one<HtHandRow>(`SELECT * FROM holdem_hands WHERE id = ?`, hand.id)!;
    setToAct(fresh, views, seatRow.seat, now);
    // 이 액션으로 라운드가 끝났을 수 있다 — 바로 이어서 전진시킨다
    advanceTable(tour, reload(table.id), now);
    return { ok: true };
  });
}

/** 폴링마다 부른다 — 접속 중임을 표시하되 SIT_OUT은 자동으로 풀지 않는다 */
export function touchHoldemPresence(userId: string, tableId: number): void {
  run(`UPDATE holdem_seats SET last_seen_at = ?,
         presence = CASE WHEN presence = 'DISCONNECTED' THEN 'ACTIVE' ELSE presence END
       WHERE table_id = ? AND user_id = ? AND presence <> 'OUT'`, nowSec(), tableId, userId);
}

/** [게임 복귀] — SIT_OUT을 직접 풀 때만 부른다 */
export function holdemSitIn(userId: string, tableId: number): void {
  run(`UPDATE holdem_seats SET presence = 'ACTIVE', last_seen_at = ?
       WHERE table_id = ? AND user_id = ? AND presence <> 'OUT'`, nowSec(), tableId, userId);
}

/**
 * 부팅 시 진행 중이던 토너먼트를 취소한다(스펙 9항).
 * 절전-재개는 부팅이 아니므로 여기 걸리지 않는다 — 상태를 전부 SQLite에 두었기 때문에
 * 절전은 애초에 복구할 게 없다. 실제 재시작(배포·장애)에서만 걸린다.
 */
export function cancelRunningHoldemOnBoot(): number {
  return tx(() => {
    const rows = all<HtRow>(
      `SELECT * FROM holdem_tournaments WHERE started_at IS NOT NULL
         AND finished_at IS NULL AND cancelled_at IS NULL`);
    for (const t of rows) {
      run(`UPDATE holdem_tournaments SET cancelled_at = ? WHERE id = ?`, nowSec(), t.id);
      /* 상금은 대회가 끝날 때만 나가므로 여기서 되돌릴 상금은 없다. 하지만 참가비는
         등록할 때 이미 걷었다 — 판이 중간에 없어졌으니 돌려준다. */
      refundEntries(t.id, 'holdem:cancel:');
    }
    return rows.length;
  });
}

/**
 * 그 대회에서 걷은 참가비를 전부 되돌린다. 프리롤이면 걷은 것이 없어 아무 일도 없다.
 *
 * 되돌린 뒤 paid_in 을 0 으로 내린다. 두 번 부르는 경로가 실제로 있기 때문이다 —
 * 인원 미달로 취소된 판을 운영자가 다시 지우면 취소와 삭제가 잇달아 지나간다.
 * 그때 두 번 돌려주면 없던 포인트가 생기고, 그건 "잔액 = 원장 누적합"이 아니라
 * 경제 자체가 어긋나는 일이다.
 *
 * 반드시 adjustBalance 를 거친다(원장을 함께 쓴다). 잔액을 직접 UPDATE 하면
 * 감사가 매번 검사하는 그 불변식이 깨진다.
 */
export function refundEntries(tournamentId: number, reasonPrefix: string): number {
  const rows = all<{ user_id: string; paid_in: number }>(
    `SELECT user_id, SUM(paid_in) AS paid_in FROM holdem_entries
      WHERE tournament_id = ? AND paid_in > 0 GROUP BY user_id`, tournamentId);
  let total = 0;
  for (const r of rows) {
    adjustBalance(r.user_id, r.paid_in, reasonPrefix + tournamentId);
    total += r.paid_in;
  }
  if (rows.length) {
    run(`UPDATE holdem_entries SET paid_in = 0 WHERE tournament_id = ?`, tournamentId);
  }
  return total;
}
