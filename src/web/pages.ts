import { layout, esc, pts, LOGO_SVG } from './views';
import {
  bombIcon, ladderIcon, chartIcon, discordIcon,
  flipIcon, baccaratIcon, blackjackIcon, trophyIcon,
} from './icons';
import {
  getMyToday, getBalanceRank, LADDER_MULTIPLIER, LADDER_DOUBLE_MULTIPLIER,
  type LeaderboardRow, type WebUser,
} from '../db/queries';
import { recentHoldemWinners, totalPoolOf, getEntries, type HoldemStatus } from '../db/holdem';
import { rolloverSkips } from '../db/rollover';
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
  /** 카드용 짧은 한 줄. desc 는 로그인 화면 등 설명이 필요한 자리에서 계속 쓰고,
   *  카드에서는 이것을 쓴다 — 여섯 장이 나란히 서면 두세 줄짜리 문장은 안 읽힌다. */
  short?: string;
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
    short: '모여서 한 판에 겨루고 상위 입상자가 상금을 나눕니다.',
    cta: '참가 신청', badge: '토너먼트', ready: true },

  { key: 'baccarat', name: '바카라', icon: baccaratIcon, group: 'table',
    desc: '플레이어와 뱅커 중 9에 가까운 쪽이 이깁니다. 타이와 페어에도 걸 수 있어요.',
    // web/games/baccarat.ts baccaratOdds() — 페어 16.83이 최대(타이 10.57) · services/baccarat.ts DECKS 1
    short: '플레이어와 뱅커 중 9에 가까운 쪽에 베팅하세요.',
    fact: '1덱 · 최대 배당 16.83배 (페어)', cta: '입장하기', ready: true },
  { key: 'blackjack', name: '블랙잭', icon: blackjackIcon, group: 'table',
    desc: '5석 테이블에서 딜러를 함께 상대합니다. 21을 넘기지 않고 이기면 승리!',
    // services/blackjack.ts settleHand() — 블랙잭 배수 2.5 (3:2 + 원금) · DECKS 1
    short: '딜러와 승부하여 21을 넘기지 않고 승리하세요.',
    fact: '1덱 · 블랙잭 2.5배', cta: '자리 잡기', ready: true },
  { key: 'poker', name: '포커 플립', icon: flipIcon, group: 'table',
    desc: '두 핸드가 맞붙습니다. 승자와 완성될 족보에 칩을 올려보세요.',
    /* services/poker.ts MAX_ODDS 3000 — 공정 배당이 이 값을 넘는 시장은 팔지 않고 막는다.
       그래서 3,000배는 "볼 수 있는 최대 배당"이 맞다(매치업마다 값이 달라진다). */
    short: '두 핸드의 승자와 완성될 족보를 예측해 보세요.',
    fact: '매치업마다 배당 재계산 · 최대 3,000배', cta: '베팅하기', ready: true },

  { key: 'mines', name: '지뢰찾기', icon: bombIcon, group: 'mini',
    desc: '지뢰를 피해 칸을 열수록 배당이 오릅니다. 원할 때 캐시아웃!',
    /* web/games/mines.ts — TILE_COUNT 25 · ALLOWED_MINE_COUNTS [1,3,5,10,24].
       최대 배당은 적지 않는다. 이론상 최대(지뢰 10개에서 15칸 전부)가 3,236,072배인데,
       참이지만 확률이 300만분의 1이라 "최대 배당"으로 내놓으면 복권 문구가 된다.
       처음엔 24.75배로 적었다가 감사가 잡았다 — 그 값은 지뢰 1개·24개일 때의 최대다. */
    short: '지뢰를 피해 칸을 열고 원할 때 캐시아웃하세요.',
    fact: '25칸 · 지뢰 1·3·5·10·24개', cta: '도전하기', ready: true },
  { key: 'graph', name: '그래프게임', icon: chartIcon, group: 'mini',
    desc: '배율이 계속 오릅니다. 터지기 전에 빠져나오세요. 늦으면 전액 손실!',
    // web/games/crash.ts MAX_CRASH 10_000 — 이론상 무한이라 둔 상한
    short: '배율이 폭발하기 전에 멈추고 수익을 실현하세요.',
    fact: '최대 배율 10,000배 · 자동 캐시아웃', cta: '베팅하기', ready: true },
  { key: 'ladder', name: '사다리게임', icon: ladderIcon, group: 'mini',
    /* 설명에서 배당 숫자를 뺐다 — 아래 사실 줄과 같은 값을 두 번 말하고 있었다.
       설명은 무엇을 하는 게임인지, 사실 줄은 얼마를 받는지로 나눈다. */
    desc: '출발과 도착을 예측하세요. 하나만 맞혀도 되고, 둘 다 맞히면 배당이 커집니다.',
    short: '출발과 도착을 예측하여 배당을 노려보세요.',
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
function gameCard(
  g: GameDef,
  override?: { badge?: string; desc?: string; cta?: string; hot?: boolean },
  live = 0,
): string {
  const o = override ?? {};
  const badgeText = o.badge ?? g.badge;
  const badge = badgeText ? `<span class="gc-badge">${esc(badgeText)}</span>` : '';
  /* 지금 보고 있는 사람 수. 0 이면 아예 안 그린다 — "0명 플레이 중" 은 정직하지만
     아무에게도 도움이 안 되고, 처음 온 사람을 돌려세운다. 사람이 없을 때는 그 자리에
     게임의 성질(사실 줄)이 대신 선다. */
  const liveBadge = live > 0
    ? `<span class="gc-live"><i class="gc-dot"></i>${live}명 플레이 중</span>`
    : '';
  /* 설명은 한 줄로 줄인다. 두세 줄짜리 문장은 고르는 동안 끝까지 안 읽히고, 카드 여섯
     장이 나란히 서면 그 문장들이 서로 비슷해 보여 구분에도 도움이 안 된다.
     프리롤처럼 상태가 설명을 갈아끼우는 카드는 그 문구가 이미 수치를 담으므로 사실
     줄을 빼고 설명에 맡긴다 — 숫자가 두 줄로 겹치면 어느 쪽이 지금인지 흐려진다. */
  /* 카드에는 설명 한 줄만 둔다.
     예전에는 그 아래 규격 줄("1덱 · 최대 배당 16.83배")이 한 줄 더 있었다. 참인 값이고
     고르는 데 도움이 되기는 하는데, 여섯 장이 나란히 서면 그 줄들이 먼저 눈에 들어와
     로비가 안내가 아니라 사양표처럼 읽혔다. 그 수치는 게임마다 규칙 도움말(?)로
     옮겼다 — 자세히 알고 싶은 사람이 가는 자리다(감사도 거기를 본다). */
  const sub = o.desc ?? g.short ?? g.desc;
  const inner = `<div class="gc-top"><div class="icon">${g.icon}</div>
      <span class="gc-tags">${badge}${liveBadge}</span></div>
    <h3>${esc(g.name)}</h3>
    <p>${esc(sub)}</p>`;
  if (!g.ready) {
    return `<div class="game-card">${inner}<span class="soon">출시 예정</span></div>`;
  }
  /* 단추도, 단추를 대신하던 "입장하기 ›" 도 두지 않는다. 카드 여섯 장이 저마다 그것을
     달고 있으면 같은 말이 여섯 번 반복되는데, 카드 전체가 이미 링크라 아무 데나 눌러도
     들어간다 — 마우스를 올리면 떠오르고 테두리가 밝아지는 것이 이미 그 말을 한다. */
  return `<a class="game-card ready${o.hot ? ' live' : ''}" href="/games/${g.key}">${inner}</a>`;
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
  // 배너와 같은 값을 쓴다 — 한쪽만 순위 팟이면 같은 화면이 두 금액을 말한다
  const pool = totalPoolOf(t, n, t.prize_fixed > 0 ? t.prize_fixed : 0);
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
      /* 예약은 됐지만 등록이 아직 안 열린 상태(SCHEDULED).
         여기 뱃지가 오래도록 '매일 22:00' 이었다. 자동 개최를 없앤 뒤로는 사실이
         아니다 — 운영자가 열어야 생기고, 시각도 대회마다 다르다. 감사에도 이 문구를
         금지하는 검사가 있는데(audit-pages), 그 환경에는 대회 행이 없어서 이 갈래를
         안 타는 바람에 통과하고 있었다.
         참가비도 단정하지 않는다 — 참가비가 걸린 대회를 운영자가 열 수 있다. */
      return {
        badge: '예정',
        desc: t.buy_in > 0
          ? `등록은 ${left(st.schedule.regOpenAt)} 후에 열립니다 · 참가비 ${t.buy_in.toLocaleString('ko-KR')}P`
          : `등록은 ${left(st.schedule.regOpenAt)} 후에 열립니다 · 참가비 없이 상금만 걸린 대회예요`,
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

  /* 잔액은 상단바가 이미 늘 보여주고 있다 — 로비 첫 칸이 같은 숫자를 한 번 더 적으면
     네 칸 중 하나를 쓰고도 새로 알려주는 것이 없다. 그 자리에 순위를 둔다.
     상위 몇 %인지는 등수보다 위치를 빨리 알려준다("312명 중 8위"는 세어 봐야 안다).
     혼자일 때는 백분율이 뜻을 잃으므로(언제나 상위 100%) 그때는 안 적는다. */
  const pct = rank.total > 1
    ? `상위 ${Math.max(1, Math.round(rank.rank / rank.total * 100))}%`
    : '첫 참가자';

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
    <div class="stat"><div class="lbl">내 순위</div>
      <div class="val gold">${rank.rank}위</div>
      <div class="sub">${rank.total}명 중 ${pct}</div></div>
    <div class="stat"><div class="lbl">오늘 손익</div>
      <div class="${netCls}">${esc(netText)}</div>
      <div class="sub">${esc(netSub)}</div></div>
    <div class="stat"><div class="lbl">연속 출석</div>
      <div class="${streakCls}">${user.current_streak}일</div>
      <div class="sub">${buff.percent > 0
        ? `<span class="buff-badge">${trophyIcon}도전과제 버프 +${buff.percent}%</span>`
        : '디스코드에서 출석'}</div></div>
    <div class="stat"><div class="lbl">${esc(ff.label)}</div>
      <div class="val num"${ff.until != null ? ` data-countdown="${ff.until}"` : ''}>${esc(ff.value)}</div>
      <div class="sub">${esc(ff.sub)}</div></div>
  </div>`;
}

/* 프리롤 칸. 상태 판정은 advanceHoldem이 이미 해 뒀으므로 문구로만 옮긴다.
   오늘 대회가 끝났거나 취소됐으면 내일 일정을 계산해서 보여준다 — 그래야
   하루 중 언제 들어와도 "다음이 언제인가"에 답이 있다. */
/* 네 번째 스탯 카드와 이벤트 배너가 같이 쓰는 한 줄 요약.
   until 은 세어 내려갈 목표 시각(epoch 초)이다. 값이 있는 갈래만 붙는다 —
   "진행 중"이나 "예정 없음"처럼 셀 것이 없는 상태에 0 을 넣으면 화면이 00:00 을
   그리고, 그건 곧 시작한다는 뜻으로 읽힌다. */
function nextFreerollStat(ht: HoldemStatus | null):
  { label: string; value: string; sub: string; until?: number } {
  /* 예정된 대회가 없을 수 있다 — 자동 생성을 없앤 뒤로는 운영자가 열어야 생긴다.
     예전에는 '매일 22:00'을 적어 뒀는데, 이제 그건 사실이 아니다.
     없는 일정을 적으면 기다린 사람이 헛걸음한다. */
  const now = Math.floor(Date.now() / 1000);
  /* 대회 행이 없어도 반복 개최 일정은 있을 수 있다. 예전에는 여기서 곧바로 "예정 없음"
     으로 빠졌는데, 그러면 내일 열릴 판이 잡혀 있는데도 로비가 없다고 말한다 —
     실제로 그 상태를 봤다. 아래 FINISHED 갈래가 이미 하던 일을 여기서도 한다. */
  if (!ht || !ht.schedule) {
    const up = upcomingHint(now);
    if (!up) return { label: '홀덤 토너먼트', value: '예정 없음', sub: '열리면 공지합니다' };
    const s = Math.max(0, up.regOpenAt - now);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return {
      label: '다음 대회 등록까지',
      until: up.regOpenAt,
      value: h > 0 ? `${h}시간 ${m}분` : `${m}분`,
      sub: `${up.dateStr} · ${new Intl.DateTimeFormat('ko-KR', {
        timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(up.startAt * 1000))} 시작`,
    };
  }
  /* 한 시간 안쪽이면 MM:SS. 예전에는 분까지만 적어서 "1분"이 60초 동안 그대로 서
     있었고, 그 사이에 판이 시작되기도 했다. 한 시간을 넘으면 초는 의미가 없어
     H:MM:SS 로 늘린다 — 자릿수가 고정이라 숫자가 좌우로 흔들리지 않는다. */
  const short = (at: number) => {
    const s = Math.max(0, at - now);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const p2 = (n: number) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p2(m)}:${p2(ss)}` : `${p2(m)}:${p2(ss)}`;
  };
  const hhmm = (at: number) => new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(at * 1000));

  switch (ht.status) {
    case 'REGISTRATION_OPEN':
      return { label: '시작까지', value: short(ht.schedule.scheduledStartAt),
        until: ht.schedule.scheduledStartAt,
        sub: `등록 중 · ${ht.registered}명 신청` };
    case 'WAITING_MIN_PLAYERS':
      return { label: '인원 대기 마감까지', value: short(ht.schedule.graceEndsAt),
        until: ht.schedule.graceEndsAt,
        sub: `${ht.registered} / ${T.MIN_PLAYERS}명 · 안 차면 취소` };
    case 'RUNNING':
      return { label: '토너먼트', value: '진행 중', sub: `${ht.registered}명 참가` };
    case 'FINISHED': case 'CANCELLED': {
      /* 이 판은 끝났다. 다음이 언제인지는 예약된 판이나 반복 규칙에서 온다 —
         예전에는 "내일 같은 시각"을 계산했는데, 매일 열린다는 보장이 없어졌다. */
      const up = upcomingHint(now);
      if (!up) return { label: '홀덤 토너먼트', value: '예정 없음', sub: '열리면 공지합니다' };
      return { label: '다음 대회 등록까지', value: short(up.regOpenAt),
        until: up.regOpenAt,
        sub: `${up.dateStr} · ${hhmm(up.startAt)} 시작` };
    }
    default:
      return { label: '등록까지', value: short(ht.schedule.regOpenAt),
        until: ht.schedule.regOpenAt,
        sub: `${hhmm(ht.schedule.scheduledStartAt)} 시작 · ${ht.schedule.title}` };
  }
}

/* 섹션으로 나눠 그린다. 한 격자에 일곱 개를 늘어놓으면 둘째 줄이 반만 차서 미완성처럼
   보이고, 게임이 늘수록 "무엇을 고를지" 판단할 근거가 사라진다. */
function gameSections(ht: HoldemStatus | null, live: Record<string, number> = {}): string {
  /* 이벤트는 카드가 아니라 배너로 낸다 — 아래 참조. */
  const order: GameGroup[] = ['table', 'mini'];
  return order.map(gr => {
    const list = GAMES.filter(g => g.group === gr);
    if (!list.length) return '';
    const cards = list.map(g => gameCard(g, undefined, live[g.key] ?? 0)).join('');
    return `<div class="card">
      <h2>${esc(GROUP_TITLE[gr])}</h2>
      <div class="game-grid">${cards}</div>
    </div>`;
  }).join('');
}

/* ── 이벤트 배너 ────────────────────────────────────────────────────────
   토너먼트는 나머지 여섯과 성격이 다르다. 언제나 열려 있는 방이 아니라 시각이 정해진
   행사이고, 놓치면 그날은 없다. 같은 크기의 카드로 여섯 장 사이에 끼워 두면 그 차이가
   사라진다 — 배너 하나로 따로 세운다.

   그리고 이 화면에서 금색 단추는 여기 하나뿐이다. 예전에는 카드 여섯 장이 저마다
   금색 단추를 달고 있어서 제일 눈에 띄는 색이 여섯 번 반복됐고, 그러면 어느 것도
   강조가 아니게 된다. */
/* 이월 태그 앞에 붙는 표식. 불꽃 이모지를 쓰던 자리인데, OS 마다 다른 그림이 나오고
   컬러 이모지 하나가 글줄 안에서 혼자 튀어서 선 아이콘으로 바꿨다 — 글자 색을 따라간다. */
const SPARK_SVG = '<svg class="ev-spark" width="11" height="11" viewBox="0 0 24 24" fill="none"'
  + ' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
  + ' aria-hidden="true"><path d="M12 3 14.5 9.5 21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/></svg>';
/* ── 이 판이 무엇이고 언제인가 ────────────────────────────────────────
   왼쪽은 "무엇", 오른쪽은 "언제 · 무엇을 누르는가". 두 가지만 둔다.

   ── 라이브 뱃지를 여기에는 달지 않는다
   게임 카드의 "N명 플레이 중"은 지금 그 방을 보고 있는 사람 수다. 대회는 방이 아니라
   시각이 정해진 행사라, 지금 페이지를 보고 있는 사람 수는 갈지 말지를 정하는 데
   아무 도움이 안 된다. 여기서 세어야 하는 것은 신청한 사람 수(3 / 9)이고 그건 아래
   줄이 이미 말한다 — 성격이 다른 두 숫자를 나란히 두면 어느 쪽이 참가 인원인지 흐려진다.

   ── 시간은 오른쪽 하나뿐이다
   예전에는 뱃지가 "등록 중 · 6분 후 시작"이라 말하고 오른쪽이 다시 "시작까지 6분"을
   말했다. 같은 값이 한 화면에 두 번 있으면 읽는 쪽은 둘이 다른 값인지 확인하느라
   한 번 더 본다. 뱃지는 상태만 말하고, 시간은 오른쪽 타이머가 혼자 맡는다. */
function eventBanner(ht: HoldemStatus | null, joined = false): string {
  const g = GAMES.find(x => x.group === 'event');
  if (!g) return '';
  const o = ht ? freerollOverride(ht) : undefined;
  const stat = nextFreerollStat(ht);
  const t = ht?.tournament ?? null;

  /* 뱃지는 둘. 상태(등록 중)와 성격(클래식·바운티) — 참가를 정하기 전에 알아야 하는
     것이 이 둘뿐이다. 상태 문구에 시각이 섞여 있으면(예전의 "등록 중 · 6분 후 시작")
     오른쪽 타이머와 겹치므로 가운뎃점 뒤를 잘라 낸다. */
  const state = (o?.badge ?? g.badge ?? '토너먼트').split(' · ')[0];
  const mode = t?.mode === 'MYSTERY_BOUNTY' ? '미스터리 바운티'
    : t?.mode === 'PKO_BOUNTY' ? '바운티' : '클래식';
  const modeTag = t ? `<span class="ev-mode">${esc(mode)}</span>` : '';

  /* 제목은 대회 이름을 그대로 쓴다. 게임 이름("홀덤 토너먼트")은 왼쪽 뱃지와 아래 카드
     목록이 이미 말하고 있어서, 이 자리까지 같은 말을 하면 배너가 무엇을 알리는지 모른다. */
  const title = t?.title?.trim() || g.name;

  /* 아래 한 줄이 "지금 얼마나 모였고 얼마가 걸려 있나"를 맡는다.
     아무도 없을 때는 총액을 적지 않는다 — 0P 로 나오면 상금이 없는 대회로 읽힌다.
     그때는 이 판이 보장하는 값(1인당 금액)을 말하는 편이 사실에 가깝다. */
  /* 문장을 먼저 짓고, 화면에 넣기 직전에 한 번만 이스케이프한다. 예전 초안은 한쪽
     갈래만 esc 를 거치고 다른 갈래는 날것으로 두었는데, 지금은 숫자뿐이라 괜찮아도
     여기에 대회 이름을 한 줄 더 붙이는 순간 조용히 구멍이 된다. 두 갈래가 같은 길로
     나가게 해 두면 그런 편집이 위험해질 수가 없다. */
  let facts = o?.desc ?? g.short ?? g.desc;
  if (t && ht) {
    const n = ht.registered;
    /* 순위 상금만 세면 안 된다 — 바운티 판은 1인당 금액의 대부분(미스터리는 전부)이
       바운티 통으로 가 있어서, 그 통을 빼놓으면 미스터리 대회가 "총 상금 풀 0P" 로
       광고된다. totalPoolOf 가 둘을 합쳐 준다. */
    const pool = totalPoolOf(t, n, t.prize_fixed > 0 ? t.prize_fixed : 0);
    const head = t.buy_in > 0
      ? `참가비 ${t.buy_in.toLocaleString('ko-KR')}P`
      : `1인당 ${Math.max(0, Math.floor(t.prize_multiplier)).toLocaleString('ko-KR')}P`;
    facts = n > 0
      ? `현재 ${n} / ${T.MAX_PLAYERS}명 등록 완료 · 총 상금 풀 ${pool.toLocaleString('ko-KR')}P`
      : `${T.MAX_PLAYERS}명 정원 · ${head} · 최소 ${T.MIN_PLAYERS}명이 모이면 시작합니다`;
  }

  /* 이월은 이 판이 평소보다 큰 이유다. 배수는 대회를 만들 때 이미 금액에 굳혀 넣었으므로
     여기서는 "왜 큰가"만 말한다 — 횟수를 곱하지 않는다(db/rollover.ts). */
  const skips = t && t.buy_in <= 0 ? (rolloverSkips()) : 0;
  const rollTag = skips > 0
    ? `<span class="ev-roll">${SPARK_SVG}${skips}회 이월 누적 적용</span>` : '';

  /* 남은 시간은 서버가 그린 순간 멈춘 글자다. 분 단위였을 때는 그래도 견뎠지만 초까지
     적으면 보고 있는 동안 틀린 값이 된다 — 목표 시각을 같이 실어 보내 화면이 세게 한다.
     스크립트가 안 돌아도 서버가 넣어 둔 값이 그대로 남으므로 빈칸이 되지는 않는다. */
  const until = stat.until != null ? ` data-countdown="${stat.until}"` : '';

  return `<a class="ev-banner" href="/games/${g.key}">
    <span class="ev-shine" aria-hidden="true"></span>
    <div class="ev-left">
      <div class="ev-tags"><span class="gc-badge">${esc(state)}</span>${modeTag}</div>
      <h3 class="ev-title">${esc(title)}</h3>
      <p class="ev-desc">${esc(facts)}${rollTag}</p>
    </div>
    <div class="ev-right">
      <div class="ev-when">
        <span class="ev-lbl">${esc(stat.label)}</span>
        <span class="ev-val num"${until}>${esc(stat.value)}</span>
      </div>
      <span class="ev-cta${joined ? ' is-done' : ''}">${esc(joined ? '참가 완료' : (o?.cta ?? g.cta))}</span>
    </div>
  </a>`;
}

export function lobbyPage(
  user: WebUser | null,
  ht: HoldemStatus | null = null,
  live: Record<string, number> = {},
): string {
  const inviteUrl = (process.env.DISCORD_INVITE_URL ?? '').trim();
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

  /* 최근 소식과 출석체크를 가로로 묶는다. 세로로 쌓아 두었을 때는 둘 다 짧은데 화면
     두 칸을 차지해서, 게임 카드까지 보려면 그만큼 더 굴려야 했다. */
  /* 배너의 단추가 [참가 신청]인지 [참가 완료]인지 가른다. 대회 화면까지 들어가야
     알 수 있던 것을 로비에서 먼저 말해 준다 — 이미 신청했는데 [참가 신청]이 계속
     보이면 신청이 안 된 줄 알고 한 번 더 들어간다. */
  const htJoined = !!(ht?.tournament && user &&
    getEntries(ht.tournament.id).some(e => e.user_id === user.id));

  const body = `
    ${statRow(user, ht)}
    ${eventBanner(ht, htJoined)}
    ${gameSections(ht, live)}
    <div class="lobby-foot">
      ${newsSection()}
      <div class="card">
        <h2>출석체크</h2>
        <p class="lf-note">디스코드 서버의 출석체크 채널에서 버튼을 눌러 매일 포인트를 받으세요.
          KST 자정이 지나면 다시 누를 수 있습니다.</p>
        ${inviteUrl
          ? `<a class="lf-go" href="${esc(inviteUrl)}" target="_blank" rel="noopener noreferrer">
               ${discordIcon(16)}디스코드 바로가기</a>`
          /* 초대 주소는 지어내지 않는다. 안 정해 두었으면 단추를 아예 그리지 않는다 —
             눌러도 아무 데도 안 가는 단추는 없느니만 못하다.
             DISCORD_INVITE_URL 환경변수에 넣으면 그때부터 나온다. */
          : ''}
      </div>
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
