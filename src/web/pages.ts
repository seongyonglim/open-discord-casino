import { layout, esc, pts, LOGO_SVG } from './views';
import {
  bombIcon, ladderIcon, chartIcon, discordIcon,
  flipIcon, baccaratIcon, blackjackIcon, trophyIcon,
} from './icons';
import {
  getMyToday, getBalanceRank, LADDER_MULTIPLIER, LADDER_DOUBLE_MULTIPLIER,
  type LeaderboardRow, type WebUser,
} from '../db/queries';
import { recentHoldemWinners, prizePoolOf, type HoldemStatus } from '../db/holdem';
import * as T from '../services/tournament';
import { rewardBuff } from '../services/buff';
import { listNotices, noticeNeighbors, type Notice } from '../db/notices';
import { upcomingHint } from '../db/recurrence';

/* 로비의 게임 목록.
   ── 아이콘
   포커 플립·바카라·블랙잭·홀덤이 전부 같은 cardsIcon을 쓰고 있었다. 목록에서 넷이
   같은 그림이라 "카드게임 묶음"으로만 읽히고 서로 구분이 안 됐다. 게임마다 뜻이 통하는
   상징을 하나씩 준다.

   ── 설명
   한 줄로 줄였다. 예전 두세 줄은 고르는 동안 다 읽히지 않았고, 그렇다고 지표만
   나열하니(한때 그렇게 해봤다) 안내문이 아니라 사양표처럼 차가워졌다.
   말투는 그대로 두고 길이만 줄인다 — 자세한 규칙은 게임 화면의 ? 도움말이 받는다.

   ── 분류
   카드게임과 미니게임은 성격이 다르다(테이블에 앉는가 / 혼자 빠르게 도는가).
   홀덤 프리롤은 하루 한 번 열리는 대회라 둘 중 어디에도 안 들어간다.
   섹션을 나눠 두면 게임이 늘어도 목록이 무너지지 않는다. */
type GameGroup = 'table' | 'mini' | 'event';
interface GameDef {
  key: string; name: string; icon: string; group: GameGroup;
  /** 한 줄 소개 */
  desc: string;
  /** 버튼 문구. 게임마다 하는 일이 다르므로 "플레이"로 뭉뚱그리지 않는다 */
  cta: string;
  /** 시간·성격 배지 (없으면 표시하지 않는다) */
  badge?: string;
  /* 카드 아래 한 줄로 붙는 사실. 규칙 설명이 아니라 "고르기 전에 알면 도움이 되는 수치"다.
     실제로 참인 값만 적는다 — "현재 3명 플레이 중" 같은 것은 넣지 않는다.
     이 커뮤니티에서 그 숫자는 대체로 0이고, 그러면 카드가 사람을 돌려보낸다.
     지어낸 숫자는 더 나쁘다: 한 번 들키면 나머지 표시도 안 믿게 된다.

     값은 각 게임 코드에서 계산해 옮겨 적은 것이다(아래 주석에 출처를 적었다).
     game/*.ts가 pages.ts의 gameSwitcher를 import하므로 반대로 import하면 순환이 된다.
     그래서 손으로 적고, audit-pages [2]가 게임 모듈에서 다시 계산해 로비 화면에
     그 숫자가 실제로 들어 있는지 확인한다 — 어긋나면 감사가 깨진다. */
  fact?: string;
  ready: boolean;
}

const GAMES: GameDef[] = [
  /* "프리롤"이 아니라 "토너먼트"다. 참가비 대회도 열 수 있고(buy_in), 바운티·미스터리
     바운티까지 붙으면서 프리롤은 그중 한 방식일 뿐이 됐다 — 이름이 게임을 좁게 말하고
     있었다. 어떤 방식인지는 카드 설명과 상금 탭이 대회마다 말한다. */
  { key: 'holdem', name: '홀덤 토너먼트', icon: trophyIcon, group: 'event',
    desc: '모여서 한 판에 겨루는 토너먼트. 상위 입상자가 상금을 나눠 갖습니다.',
    /* 사실 줄을 두지 않는다 — 이 카드의 설명은 freerollOverride가 대회 상태로 갈아끼우고,
       거기에 신청 인원과 상금 풀이 들어 있다. 살아 있는 수치가 고정값보다 낫다. */
    /* 배지에 고정 시각을 적지 않는다. 예전에는 '매일 22:00'이었는데, 대회를 운영자가
       직접 여는 방식으로 바뀌면서 그 문장이 사실이 아니게 됐다. 실제 시각은 아래
       freerollOverride 가 대회 상태에서 읽어 갈아끼운다 — 없으면 '예정 없음'이 나온다. */
    cta: '참가 신청', badge: '토너먼트', ready: true },

  { key: 'baccarat', name: '바카라', icon: baccaratIcon, group: 'table',
    desc: '플레이어와 뱅커 중 9에 가까운 쪽이 이깁니다. 타이와 페어에도 걸 수 있어요.',
    // web/games/baccarat.ts baccaratOdds() — 페어 16.83이 최대(타이 10.57) · services/baccarat.ts DECKS 1
    fact: '1덱 · 최대 배당 16.83배 (페어)', cta: '입장하기', ready: true },
  { key: 'blackjack', name: '블랙잭', icon: blackjackIcon, group: 'table',
    desc: '5석 테이블에서 딜러를 함께 상대합니다. 21을 넘기지 않고 이기면 승리!',
    // services/blackjack.ts settleHand() — 블랙잭 배수 2.5 (3:2 + 원금) · DECKS 1
    fact: '1덱 · 블랙잭 2.5배', cta: '자리 잡기', ready: true },
  { key: 'poker', name: '포커 플립', icon: flipIcon, group: 'table',
    desc: '두 핸드가 맞붙습니다. 승자와 완성될 족보에 칩을 올려보세요.',
    /* services/poker.ts MAX_ODDS 3000 — 공정 배당이 이 값을 넘는 시장은 팔지 않고 막는다.
       그래서 3,000배는 "볼 수 있는 최대 배당"이 맞다(매치업마다 값이 달라진다). */
    fact: '매치업마다 배당 재계산 · 최대 3,000배', cta: '베팅하기', ready: true },

  { key: 'mines', name: '지뢰찾기', icon: bombIcon, group: 'mini',
    desc: '지뢰를 피해 칸을 열수록 배당이 오릅니다. 원할 때 캐시아웃!',
    /* web/games/mines.ts — TILE_COUNT 25 · ALLOWED_MINE_COUNTS [1,3,5,10,24].
       최대 배당은 적지 않는다. 이론상 최대(지뢰 10개에서 15칸 전부)가 3,236,072배인데,
       참이지만 확률이 300만분의 1이라 "최대 배당"으로 내놓으면 복권 문구가 된다.
       처음엔 24.75배로 적었다가 감사가 잡았다 — 그 값은 지뢰 1개·24개일 때의 최대다. */
    fact: '25칸 · 지뢰 1·3·5·10·24개', cta: '도전하기', ready: true },
  { key: 'graph', name: '그래프게임', icon: chartIcon, group: 'mini',
    desc: '배율이 계속 오릅니다. 터지기 전에 빠져나오세요. 늦으면 전액 손실!',
    // web/games/crash.ts MAX_CRASH 10_000 — 이론상 무한이라 둔 상한
    fact: '최대 배율 10,000배 · 자동 캐시아웃', cta: '베팅하기', ready: true },
  { key: 'ladder', name: '사다리게임', icon: ladderIcon, group: 'mini',
    /* 설명에서 배당 숫자를 뺐다 — 아래 사실 줄과 같은 값을 두 번 말하고 있었다.
       설명은 무엇을 하는 게임인지, 사실 줄은 얼마를 받는지로 나눈다. */
    desc: '출발과 도착을 예측하세요. 하나만 맞혀도 되고, 둘 다 맞히면 배당이 커집니다.',
    // 이 두 값만은 db/queries.ts에서 직접 가져온다(순환 없이 import된다) — 손으로 적을 이유가 없다
    fact: `단일 ${LADDER_MULTIPLIER}배 · 양쪽 ${LADDER_DOUBLE_MULTIPLIER}배`,
    cta: '예측하기', ready: true },
];

const GROUP_TITLE: Record<GameGroup, string> = {
  event: '이벤트',
  table: '테이블 게임',
  mini: '미니 게임',
};

/* 게임 화면 상단의 게임 전환 바 — 로비를 거치지 않고 바로 다른 게임으로 이동할 수 있게 한다.
   출시된 게임만 노출하고, 현재 플레이 중인 게임은 활성 표시.

   규칙 도움말(?) 버튼도 여기 오른쪽 끝에 붙인다. 처음에는 게임 카드의 오른쪽 위 구석에
   띄웠는데, 게임마다 그 자리에 다른 것이 있어서 실제로 가렸다 — 사다리는 출목표,
   그래프는 최근 배율 기록, 바카라는 범례를 덮었고, 포커·지뢰찾기는 펠트 안에 떠 있었다.
   판 위에는 게임이 쓰는 자리가 아닌 곳이 없다는 게 문제였다.

   이 바는 모든 게임 화면이 공통으로 갖는 "게임 밖" 영역이라 무엇도 가리지 않고,
   일곱 게임에서 항상 같은 자리라 한 번 찾으면 계속 안다. 게임이 늘어도 그대로 간다. */
export function gameSwitcher(currentKey: string, helpDialogId?: string): string {
  const pills = GAMES.filter(g => g.ready).map(g => `
    <a class="gs-pill${g.key === currentKey ? ' active' : ''}" href="/games/${g.key}">
      <span class="gs-ic">${g.icon}</span>${esc(g.name)}
    </a>`).join('');
  const help = helpDialogId
    ? `<button class="helpbtn gs-help" type="button" data-help="${esc(helpDialogId)}"
         aria-label="규칙 보기" title="규칙 보기">?</button>`
    : '';
  return `<div class="game-switch">${pills}${help}</div>`;
}

/* 게임 선택 카드.
   카드 전체가 링크다 — 예전에는 안쪽 '플레이' 버튼만 눌려서, 카드에 마우스를 올리면
   살짝 떠오르는데도 정작 클릭이 안 돼 "반응이 없다"는 느낌을 줬다.

   버튼 문구는 게임마다 다르다. 전부 "플레이"였는데, 홀덤은 바로 플레이가 아니라
   대회에 신청하는 것이고 바카라·블랙잭은 테이블에 들어가는 것이라 하는 일이 서로 다르다.
   문구가 다르면 누르기 전에 무슨 일이 일어날지 알 수 있다. */
function gameCard(g: GameDef, override?: { badge?: string; desc?: string; cta?: string; hot?: boolean }): string {
  const o = override ?? {};
  const badgeText = o.badge ?? g.badge;
  const badge = badgeText ? `<span class="gc-badge">${esc(badgeText)}</span>` : '';
  /* 프리롤은 상태에 따라 설명이 바뀌는데, 그 문구가 이미 인원·상금 풀 같은 수치를 담는다.
     그 위에 고정 사실 줄까지 얹으면 숫자가 두 줄로 겹쳐서 어느 쪽이 지금인지 흐려진다.
     그래서 override로 설명이 갈아끼워진 카드에서는 사실 줄을 빼고 설명에 맡긴다. */
  const factText = o.desc ? undefined : g.fact;
  const fact = factText ? `<p class="gc-fact">${esc(factText)}</p>` : '';
  const inner = `<div class="gc-top"><div class="icon">${g.icon}</div>${badge}</div>
    <h3>${esc(g.name)}</h3>
    <p>${esc(o.desc ?? g.desc)}</p>${fact}`;
  if (!g.ready) {
    return `<div class="game-card">${inner}<span class="soon">출시 예정</span></div>`;
  }
  return `<a class="game-card ready${o.hot ? ' live' : ''}" href="/games/${g.key}">${inner}
    <span class="btn btn-gold">${esc(o.cta ?? g.cta)}</span>
  </a>`;
}

/* ── 프리롤 카드는 대회 상태를 그대로 비춘다 ────────────────────────────
   "매일 22:00"이라는 고정 배지만 붙여 두면 하루 23시간 동안 아무 정보가 없다.
   등록이 열렸는지, 지금 몇 명인지, 이미 끝났는지가 로비에서 보여야 한다.

   상태 판정은 advanceHoldem 하나에만 둔다 — 로비에서 따로 계산하면 로비 표시와
   실제 대회가 갈라진다. 이 함수는 그 결과를 문구로 옮기기만 한다.

   등록 중일 때만 카드를 강조한다(hot). 상시로 크게 띄우면 하루 대부분의 시간에
   거짓 긴박감을 만들고, 그런 배지는 한 번 들키면 나머지도 안 믿게 된다. */
function freerollOverride(st: HoldemStatus): { badge?: string; desc?: string; cta?: string; hot?: boolean } {
  const t = st.tournament;
  /* 대회가 하나도 없을 수 있다 — 자동 생성을 없앤 뒤로는 운영자가 열어야 생긴다.
     이때는 카드를 강조하지 않는다. 없는 대회를 기다리게 만드는 배지는 거짓말이 된다. */
  if (!t || !st.schedule) {
    /* 반복 개최를 켜 뒀거나 운영자가 다음 판을 미리 열어 뒀으면 그 시각을 안다.
       알면서 "예정 없음"이라고 말하지 않는다 — 기다릴 사람이 헛걸음한다. */
    const up = upcomingHint();
    if (up) {
      const s = Math.max(0, up.regOpenAt - Math.floor(Date.now() / 1000));
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
      return {
        badge: '예정',
        desc: `다음 대회 ${up.dateStr} — 등록까지 ${h > 0 ? `${h}시간 ${m}분` : `${m}분`} 남았습니다`,
        cta: '둘러보기',
      };
    }
    return { badge: '예정 없음', desc: '다음 대회가 열리면 여기에 안내됩니다', cta: '둘러보기' };
  }
  const n = st.registered;
  const pool = prizePoolOf(t, n, t.prize_fixed > 0 ? t.prize_fixed : 0);
  const now = Math.floor(Date.now() / 1000);
  const left = (at: number) => {
    const s = Math.max(0, at - now);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
  };

  switch (st.status) {
    case 'REGISTRATION_OPEN':
      return {
        badge: `등록 중 · ${left(st.schedule.scheduledStartAt)} 후 시작`,
        desc: n > 0
          ? `${n}명 신청 · 상금 풀 ${pool.toLocaleString('ko-KR')}P. 지금 신청할 수 있습니다.`
          : '참가 신청이 열렸습니다. 최소 3명이 모이면 시작합니다.',
        cta: '참가 신청',
        hot: true,
      };
    case 'WAITING_MIN_PLAYERS':
      return {
        badge: '인원 대기 중',
        desc: `${n}명 신청 — 최소 ${T.MIN_PLAYERS}명이 모이면 시작합니다. 아직 들어올 수 있어요.`,
        cta: '참가 신청', hot: true,
      };
    case 'RUNNING':
      return {
        badge: '진행 중',
        desc: `${n}명이 참가한 대회가 돌고 있습니다. 늦은 등록이나 관전으로 들어가세요.`,
        cta: '테이블 보기', hot: true,
      };
    case 'FINISHED':
      return {
        badge: '오늘 종료',
        desc: '오늘 대회는 끝났습니다. 결과는 안에서 확인할 수 있어요.',
        cta: '결과 보기',
      };
    case 'CANCELLED':
      return {
        badge: '취소',
        desc: `최소 인원(${T.MIN_PLAYERS}명)이 모이지 않아 오늘 대회는 취소됐습니다.`,
        cta: '자세히 보기',
      };
    default:
      return {
        badge: '매일 22:00',
        desc: `등록은 ${left(st.schedule.regOpenAt)} 후에 열립니다. 참가비 없이 상금만 걸린 대회예요.`,
        cta: '자세히 보기',
      };
  }
}

/* ── 최근 소식 ─────────────────────────────────────────────────────────
   로비가 "내가 없는 동안 무슨 일이 있었는지"를 전혀 알려주지 않았다.
   소규모 커뮤니티에서 다시 들어오는 이유는 대체로 그것이다.
   보여줄 게 하나도 없으면 이 칸 자체를 그리지 않는다 — 빈 상자가 더 허전하다. */
function newsSection(): string {
  const items: string[] = [];

  for (const w of recentHoldemWinners(1)) {
    items.push(`<li><span class="nw-k">프리롤</span>
      <span class="nw-v"><b>${esc(w.username)}</b> 우승
      ${w.prize > 0 ? `· ${w.prize.toLocaleString('ko-KR')}P` : ''}
      <span class="dim">(${esc(w.dateStr)} · ${w.players}명)</span></span></li>`);
  }

  /* "최근 큰 승리"를 넣었다가 뺐다.
     원장에서 뽑을 수 있는 값은 정산으로 받아간 금액이고, 그 판에 얼마를 걸었는지는
     짝지을 수 없다(원장 행에 라운드 번호가 없다). 그래서 그래프에서 30,000P를 걸고
     1.03배에 뺀 사람이 "+31,080P"로 찍혔다 — 실제 이익은 1,080P다.
     무엇을 뜻하는지 알 수 없는 숫자를 크게 보여주는 건 아예 없는 것보다 나쁘다.

     순이익을 제대로 내려면 게임별 라운드 표(ladder_bets·crash_bets·... 각각 amount와
     payout이 있다)를 여섯 개 합쳐야 한다. 그럴 가치가 있다고 판단되면 그때 만든다. */

  const notice = listNotices()[0];
  if (notice) {
    items.push(`<li><span class="nw-k">공지</span>
      <span class="nw-v"><a href="/notices/${esc(notice.id)}">${esc(notice.title)}</a></span></li>`);
  }

  if (!items.length) return '';
  return `<div class="card">
    <h2>최근 소식</h2>
    <ul class="news">${items.join('')}</ul>
  </div>`;
}

/* ── 상단 통계 줄 ──────────────────────────────────────────────────────
   잔액과 연속 출석 둘만 있었다. 둘 다 "지금 내 상태"이고, 로비에 들어와서 알고 싶은
   나머지 — 오늘 내가 잃었나 벌었나, 다음 대회가 언제인가 — 는 아무 데도 없었다.

   "온라인 인원"은 넣지 않는다. 이 커뮤니티에서 대부분의 시간에 0~2명이라
   사실을 말하면 오히려 들어온 사람을 돌려보낸다. 사실이 아닌 값을 넣는 건 더 나쁘고,
   그러면 남는 선택은 넣지 않는 것이다.

   각 칸의 작은 줄(sub)은 큰 숫자를 읽는 데 필요한 맥락만 적는다 —
   순위 없는 잔액, 판수 없는 손익은 크기를 가늠할 수 없다. */
function statRow(user: WebUser, ht: HoldemStatus | null): string {
  const now = Date.now();
  const sinceKstMidnight = T.kstTimeToUnix(T.kstDateStr(now), 0, 0);
  const today = getMyToday(user.id, sinceKstMidnight);
  const rank = getBalanceRank(user.balance);

  /* 연속 출석 0일은 초록으로 쓰지 않는다.
     초록(--win)은 "좋은 상태"를 뜻하는 색인데 0일은 아직 시작하지 않은 상태다.
     하루라도 쌓였을 때부터 초록이 되어야 색이 정보를 전달한다. */
  const streakCls = user.current_streak > 0 ? 'val hi' : 'val';

  // 오늘 아직 한 판도 안 했으면 0을 초록/빨강으로 칠하지 않는다 — 아직 아무 일도 없었다
  const netCls = today.rounds === 0 ? 'val' : today.net > 0 ? 'val hi' : today.net < 0 ? 'val lo' : 'val';
  const netText = today.rounds === 0 ? '–'
    : (today.net > 0 ? '+' : '') + today.net.toLocaleString('ko-KR') + 'P';
  const netSub = today.rounds === 0 ? '아직 플레이 없음' : `${today.rounds}판`;

  const ff = nextFreerollStat(ht);
  /* 도전과제 버프. 출석 칸 아래에 붙인다 — 출석과 지원금에만 걸리는 버프라 그 자리가
     맞고, 버프가 없는 사람에게는 "디스코드에서 출석" 안내가 그대로 남아야 한다
     (0% 뱃지는 알려주는 것이 없고 자리만 차지한다). */
  const buff = rewardBuff(user.id);

  return `<div class="stat-row">
    <div class="stat"><div class="lbl">내 잔액</div>
      <div class="val gold">${esc(pts(user.balance))}</div>
      <div class="sub">${rank.rank}위 / ${rank.total}명</div></div>
    <div class="stat"><div class="lbl">오늘 손익</div>
      <div class="${netCls}">${esc(netText)}</div>
      <div class="sub">${esc(netSub)}</div></div>
    <div class="stat"><div class="lbl">연속 출석</div>
      <div class="${streakCls}">${user.current_streak}일</div>
      <div class="sub">${buff.percent > 0
        ? `<span class="buff-badge">🏆 도전과제 버프 +${buff.percent}%</span>`
        : '디스코드에서 출석'}</div></div>
    <div class="stat"><div class="lbl">${esc(ff.label)}</div>
      <div class="val">${esc(ff.value)}</div>
      <div class="sub">${esc(ff.sub)}</div></div>
  </div>`;
}

/* 프리롤 칸. 상태 판정은 advanceHoldem이 이미 해 뒀으므로 문구로만 옮긴다.
   오늘 대회가 끝났거나 취소됐으면 내일 일정을 계산해서 보여준다 — 그래야
   하루 중 언제 들어와도 "다음이 언제인가"에 답이 있다. */
function nextFreerollStat(ht: HoldemStatus | null): { label: string; value: string; sub: string } {
  /* 예정된 대회가 없을 수 있다 — 자동 생성을 없앤 뒤로는 운영자가 열어야 생긴다.
     예전에는 '매일 22:00'을 적어 뒀는데, 이제 그건 사실이 아니다.
     없는 일정을 적으면 기다린 사람이 헛걸음한다. */
  if (!ht || !ht.schedule) return { label: '홀덤 토너먼트', value: '예정 없음', sub: '열리면 공지합니다' };
  const now = Math.floor(Date.now() / 1000);
  const short = (at: number) => {
    const s = Math.max(0, at - now);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
  };
  const hhmm = (at: number) => new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(at * 1000));

  switch (ht.status) {
    case 'REGISTRATION_OPEN':
      return { label: '프리롤 시작까지', value: short(ht.schedule.scheduledStartAt),
        sub: `등록 중 · ${ht.registered}명 신청` };
    case 'WAITING_MIN_PLAYERS':
      return { label: '프리롤 인원 대기', value: `${ht.registered} / ${T.MIN_PLAYERS}명`,
        sub: `${hhmm(ht.schedule.graceEndsAt)}까지 안 차면 취소` };
    case 'RUNNING':
      return { label: '토너먼트', value: '진행 중', sub: `${ht.registered}명 참가` };
    case 'FINISHED': case 'CANCELLED': {
      /* 이 판은 끝났다. 다음이 언제인지는 예약된 판이나 반복 규칙에서 온다 —
         예전에는 "내일 같은 시각"을 계산했는데, 매일 열린다는 보장이 없어졌다. */
      const up = upcomingHint(now);
      if (!up) return { label: '홀덤 토너먼트', value: '예정 없음', sub: '열리면 공지합니다' };
      return { label: '다음 대회 등록까지', value: short(up.regOpenAt),
        sub: `${up.dateStr} · ${hhmm(up.startAt)} 시작` };
    }
    default:
      return { label: '대회 등록까지', value: short(ht.schedule.regOpenAt),
        sub: `${hhmm(ht.schedule.scheduledStartAt)} 시작 · ${ht.schedule.title}` };
  }
}

/* 섹션으로 나눠 그린다. 한 격자에 일곱 개를 늘어놓으면 둘째 줄이 반만 차서 미완성처럼
   보이고, 게임이 늘수록 "무엇을 고를지" 판단할 근거가 사라진다. */
function gameSections(ht: HoldemStatus | null): string {
  const order: GameGroup[] = ['event', 'table', 'mini'];
  const htOverride = ht ? freerollOverride(ht) : undefined;
  return order.map(gr => {
    const list = GAMES.filter(g => g.group === gr);
    if (!list.length) return '';
    const cards = list.map(g =>
      g.key === 'holdem' ? gameCard(g, htOverride) : gameCard(g)).join('');
    return `<div class="card">
      <h2>${esc(GROUP_TITLE[gr])}</h2>
      <div class="game-grid">${cards}</div>
    </div>`;
  }).join('');
}

export function lobbyPage(user: WebUser | null, ht: HoldemStatus | null = null): string {
  // 로그인 전에는 보여줄 게 없으므로 화면 가운데에 로그인만 크게 놓는다
  // (좁은 카드 안에 작은 버튼을 넣으면 빈 화면에 덩그러니 남아 허전해 보인다).
  if (!user) {
    return layout('로그인', 'lobby', `
      <div class="login-hero">
        <div class="login-mark">${LOGO_SVG}</div>
        <h1 class="login-title">OD <span>CASINO</span></h1>
        <p class="login-sub">매일 출석해서 모은 포인트로 즐기는 오픈디코 전용 카지노</p>
        <a class="login-cta" href="/auth/login">${discordIcon(20)}디스코드로 로그인</a>
        <p class="login-note">오픈디코 서버 멤버만 입장할 수 있습니다</p>
        <div class="login-games">${GAMES.filter(g => g.ready).map(g =>
          `<span class="login-game">${g.icon}${esc(g.name)}</span>`).join('')}</div>
      </div>`, 'login-page');
  }

  const body = `
    ${statRow(user, ht)}
    ${gameSections(ht)}
    ${newsSection()}
    <div class="card">
      <h2>출석체크</h2>
      <p style="color:var(--muted);font-size:13.5px;margin:0">디스코드 서버의 출석체크 채널에서 버튼을 눌러 매일 포인트를 받으세요. KST 자정이 지나면 다시 누를 수 있습니다.</p>
    </div>`;
  return layout('로비', 'lobby', body);
}

export function leaderboardPage(rows: LeaderboardRow[], meId: string | null): string {
  const body = rows.map((r, i) => `<tr${r.id === meId ? ' style="background:rgba(200,170,110,.07)"' : ''}>
    <td class="rank${i === 0 ? ' top1' : ''}">${i + 1}</td>
    <td>${esc(r.username)}${r.id === meId ? ' <span style="color:var(--gold);font-size:11px">(나)</span>' : ''}</td>
    <td class="num" style="color:var(--gold);font-weight:600">${esc(pts(r.balance))}</td>
    <td class="num">${r.current_streak}일</td>
  </tr>`).join('');

  return layout('랭킹', 'leaderboard', `
    <div class="card">
      <h2>포인트 랭킹 TOP ${rows.length}</h2>
      <table>
        <thead><tr><th>순위</th><th>유저</th><th>잔액</th><th>연속 출석</th></tr></thead>
        <tbody>${body || `<tr><td colspan="4" class="empty">아직 데이터가 없습니다</td></tr>`}</tbody>
      </table>
    </div>`);
}


/* ── 공지사항 ─────────────────────────────────────────────────────────
   게임사 공지 형식을 따른다: 분류 태그 · 제목 · 날짜, 본문은 소제목으로 끊는다.
   글은 코드(web/notices.ts)에 있고 여기서는 그리기만 한다. */

function noticeBody(n: Notice): string {
  return n.sections.map(s => {
    const paras = (s.paras ?? []).map(p => `<p>${p}</p>`).join('');
    const bullets = s.bullets?.length
      ? `<ul>${s.bullets.map(b => `<li>${b}</li>`).join('')}</ul>` : '';
    const table = s.table
      ? `<div class="nt-tw"><table class="nt-table">
           <thead><tr>${s.table.head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
           <tbody>${s.table.rows.map(r =>
             `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
         </table></div>`
      : '';
    return `<section class="nt-sec"><h3>${esc(s.heading)}</h3>${paras}${bullets}${table}</section>`;
  }).join('');
}

export function noticeListPage(): string {
  const rows = listNotices().map(n => `
    <a class="nt-row" href="/notices/${esc(n.id)}">
      <span class="nt-kind k-${esc(n.kind)}">${esc(n.kind)}</span>
      <span class="nt-mid">
        <span class="nt-title">${esc(n.title)}</span>
        <span class="nt-sum">${esc(n.summary)}</span>
      </span>
      <span class="nt-date num">${esc(n.date)}</span>
    </a>`).join('');

  return layout('공지사항', 'notices', `
    <div class="card">
      <h2>공지사항</h2>
      <p class="nt-lead">업데이트 · 밸런스 조정 · 오류 수정 내역을 안내합니다.</p>
      <div class="nt-list">${rows || `<p class="empty">등록된 공지가 없습니다</p>`}</div>
    </div>`);
}

export function noticeDetailPage(n: Notice): string {
  // 앞뒤 글은 목록과 같은 순서를 써야 넘길 때 어긋나지 않는다 (db/notices)
  const { prev, next } = noticeNeighbors(n.id);
  const nav = [
    next ? `<a class="nt-nav" href="/notices/${esc(next.id)}">← 다음 글 · ${esc(next.title)}</a>` : '',
    prev ? `<a class="nt-nav" href="/notices/${esc(prev.id)}">이전 글 · ${esc(prev.title)} →</a>` : '',
  ].filter(Boolean).join('');

  return layout(n.title, 'notices', `
    <div class="card nt-doc">
      <div class="nt-head">
        <span class="nt-kind k-${esc(n.kind)}">${esc(n.kind)}</span>
        <h2>${esc(n.title)}</h2>
        <span class="nt-date num">${esc(n.date)}</span>
      </div>
      ${noticeBody(n)}
      <div class="nt-foot">
        <a class="btn nt-back" href="/notices">목록으로</a>
        ${nav}
      </div>
    </div>`);
}
