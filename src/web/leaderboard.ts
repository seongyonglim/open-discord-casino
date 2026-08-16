/* 시즌 랭킹 화면.
 *
 * 화면이 데이터를 따라간다 — 반대가 아니다. 시즌 목록도, 게임 카테고리도 코드에 박지
 * 않고 그 시즌에 실제로 있었던 것만 서버가 주는 대로 그린다. 시즌이 스무 개가 되든
 * 게임이 넷 더 붙든 이 파일을 고칠 일이 없어야 한다는 것이 이 화면의 요구사항이었다.
 *
 * 그래서 지표도 탭에 따라 달라진다. 통합 랭킹의 점수는 잔액이고(시즌 점수의 정의가
 * "종료 시점 잔액"이다), 게임 탭의 점수는 그 게임의 순수익이다. 열 구성이 아예 다르므로
 * 표를 두 벌 그리지 않고 서버가 준 kind 로 갈라 그린다.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { layout, esc, jsonForScript } from './views';
import { sendJson } from './http';
import {
  listSeasons, getSeason, seasonGames, seasonOverall, seasonGameRanking, mySeasonRank,
  seasonHoldemRanking, seasonHoldemCount, seasonHoldemPlayers, myHoldemRank, type HoldemGenre,
  type SeasonRow,
} from '../db/queries';
import type { WebUser } from '../db/queries';
import { getSeasonSchedule } from '../db/season-schedule';

const GAME_LABEL: Record<string, string> = {
  mines: '지뢰찾기', ladder: '사다리게임', graph: '그래프게임',
  poker: '포커 플립', baccarat: '바카라', blackjack: '블랙잭',
};
/* 표에 없는 게임이 와도 화면이 비지 않게 한다 — 새 게임이 붙는 날 이 표를 고치는 것을
   잊어도 키 이름이라도 나온다. 카테고리가 데이터에서 오므로 이 경우가 실제로 생긴다. */
const label = (g: string) => GAME_LABEL[g] ?? g;

export interface RankPayload {
  seasons: { id: number; number: number; name: string; closed: boolean }[];
  season: { id: number; number: number; name: string;
    startedAt: number; endsAt: number | null; closedAt: number | null;
    /* 종료 예약이 걸려 있으면 그 시각. 시즌 행의 ends_at 과 달리 "실제로 시즌을 닫을 시각"이라,
       둘이 어긋나면 이쪽이 참이다 — 배너도 이쪽을 먼저 본다. */
    closeAt: number | null };
  games: { key: string; label: string; rounds: number; players: number }[];
  tab: string;                       // 'overall' 또는 게임 키
  kind: 'overall' | 'game' | 'holdem';
  rows: RankRow[];
  me: { rank: number; total: number; score: number; userId: string; username: string;
        avatar: string | null;
        rounds?: number; rated?: number; wins?: number; pushes?: number;
        entries?: number; itm?: number } | null;
  serverNow: number;
}
interface RankRow {
  userId: string; username: string; avatar: string | null; rank: number;
  score: number; rounds?: number; rated?: number; wins?: number; pushes?: number;
  entries?: number; itm?: number;
}

export function buildRankPayload(seasonId: number | null, tab: string, me: WebUser | null): RankPayload {
  const seasons = listSeasons();
  const s: SeasonRow = (seasonId != null ? getSeason(seasonId) : undefined) ?? seasons[0];
  const games = seasonGames(s.id).map(g => ({ key: g.game, label: label(g.game), rounds: g.rounds, players: g.players }));
  /* 홀덤은 season_stats 에 없다 — 판마다 걸고 되받는 게임이 아니라 대회이고, 집계를
     대회 결과(holdem_entries)에서 시즌 구간으로 잘라 온다. 그래서 카테고리도 여기서 붙인다.
     그 시즌에 끝난 대회가 있을 때만 붙으므로, 다른 게임과 마찬가지로 데이터가 정한다. */
  /* 대회는 장르로 가른다. 같은 홀덤이지만 "무엇으로 버느냐"가 달라서 한 표에 섞으면
     한쪽이 통째로 0 으로 잡힌다 — 미스터리 바운티 우승자(72,800P)가 «상금 0P» 로
     최하위권에 앉았던 것이 그 결과다(season.ts 의 GENRE_TOOK 주석에 자세히 적어 뒀다).
       홀덤 토너먼트 — 순위 상금으로 겨룬다
       바운티        — 순위 상금 + 잡아서 받은 바운티로 겨룬다
     탭 옆 숫자는 "몇 명이 했나"다(다른 게임도 그렇다).
     그 시즌에 그 장르의 대회가 있을 때만 붙으므로, 탭 구성은 데이터가 정한다.

     이름에서 "토너먼트"를 뺀다. 이 줄의 다른 칸은 3~5글자(지뢰찾기·블랙잭·바카라)인데
     "홀덤 클래식 토너먼트"는 10글자다 — 실측으로 칩 하나가 169px 이 되어 둘이 338px,
     줄 전체가 1,058px 로 컨테이너(860px)를 198px 넘긴다. "홀덤 클래식"이면 112px 씩
     224px 이고, 랭킹 화면에서 "토너먼트"는 어차피 홀덤이 대회라는 뜻 말고는 없다. */
  const htBounty = seasonHoldemCount(s.id, 'BOUNTY');
  if (htBounty > 0) {
    games.unshift({ key: 'bounty', label: '홀덤 바운티',
      rounds: htBounty, players: seasonHoldemPlayers(s.id, 'BOUNTY') });
  }
  const htCount = seasonHoldemCount(s.id, 'CLASSIC');
  if (htCount > 0) {
    games.unshift({ key: 'holdem', label: '홀덤 클래식',
      rounds: htCount, players: seasonHoldemPlayers(s.id, 'CLASSIC') });
  }
  // 요청한 탭이 그 시즌에 없으면 통합으로 되돌린다 — 시즌을 바꿨을 때 빈 화면이 나오지 않게
  const active = tab !== 'overall' && games.some(g => g.key === tab) ? tab : 'overall';

  /* 두 대회 탭은 같은 표를 쓴다 — 열 구성(참가·우승·입상·상금)이 같고, 다른 것은
     "상금"에 무엇을 세느냐뿐이다. 그 판단은 장르가 들고 있다. */
  const genre: HoldemGenre | null =
    active === 'holdem' ? 'CLASSIC' : active === 'bounty' ? 'BOUNTY' : null;

  const rows: RankRow[] = active === 'overall'
    ? seasonOverall(s.id, 100).map(r => ({ ...r }))
    : genre
      ? seasonHoldemRanking(s.id, genre, 100).map(r => ({
          userId: r.userId, username: r.username, avatar: r.avatar, rank: r.rank,
          score: r.prize, entries: r.entries, wins: r.wins, itm: r.itm,
        }))
      : seasonGameRanking(s.id, active, 100).map(r => ({
          userId: r.userId, username: r.username, avatar: r.avatar, rank: r.rank,
          score: r.profit, rounds: r.rounds, rated: r.rated, wins: r.wins, pushes: r.pushes,
        }));

  const mine = !me ? null
    : genre ? myHoldemRank(s.id, me.id, genre)
    : mySeasonRank(s.id, me.id, active === 'overall' ? null : active);
  return {
    seasons: seasons.map(x => ({ id: x.id, number: x.number, name: x.name, closed: x.closed_at != null })),
    season: { id: s.id, number: s.number, name: s.name,
      startedAt: s.started_at, endsAt: s.ends_at, closedAt: s.closed_at,
      /* 이미 닫힌 시즌에는 붙이지 않는다 — 예약은 "지금 열려 있는 시즌"을 닫는 것이라,
         지난 시즌 화면에 붙이면 다음 시즌 예약을 그 시즌의 종료일인 양 적게 된다. */
      closeAt: s.closed_at == null ? getSeasonSchedule().closeAt : null },
    games, tab: active,
    /* 두 대회 탭은 kind 가 같다 — 화면이 이 값으로 열 구성을 고르는데, 둘은 같은
       열(참가·우승·입상·상금)을 쓴다. 여기서 갈라 두면 바운티 탭만 다른 표가 된다. */
    kind: active === 'overall' ? 'overall' : genre ? 'holdem' : 'game',
    rows,
    /* userId 를 함께 준다. 이게 없어서 화면의 "내 줄" 표시가 한 번도 켜진 적이 없었다 —
       표는 r.userId === data.me.userId 로 판단하는데 오른쪽이 늘 undefined 였다.
       아무 에러도 안 나고 그냥 강조가 안 될 뿐이라 눈으로는 못 잡혔다. */
    me: mine && me
      ? { ...mine, userId: me.id, username: me.username, avatar: me.avatar ?? null }
      : null,
    serverNow: Math.floor(Date.now() / 1000),
  };
}

export async function handleRankApi(
  _req: IncomingMessage, res: ServerResponse, url: URL, me: WebUser | null
): Promise<void> {
  const sid = Number(url.searchParams.get('season'));
  const tab = url.searchParams.get('tab') ?? 'overall';
  return sendJson(res, 200, { ok: true, ...buildRankPayload(Number.isFinite(sid) && sid > 0 ? sid : null, tab, me) });
}

export function leaderboardPage(me: WebUser | null): string {
  const data = buildRankPayload(null, 'overall', me);
  const body = `
  <div class="lb">
    <div class="lb-head">
      <h1 class="lb-title">랭킹</h1>
      <div class="lb-sel" id="lbSel">
        <button type="button" class="lb-selbtn" id="lbSelBtn" aria-haspopup="listbox" aria-expanded="false">
          <span id="lbSelLabel"></span>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>
        </button>
        <div class="lb-selmenu" id="lbSelMenu" role="listbox" hidden></div>
      </div>
    </div>

    <div class="lb-banner" id="lbBanner"></div>
    <div class="lb-chips" id="lbChips" role="tablist"></div>

    <div class="lb-podium" id="lbPodium"></div>
    <div class="lb-listwrap">
      <table class="lb-tbl"><thead id="lbHead"></thead><tbody id="lbBody"></tbody></table>
    </div>
    <div class="lb-empty" id="lbEmpty" hidden>아직 기록이 없습니다.</div>
  </div>
  <div class="lb-mebar" id="lbMe" hidden></div>

  <script>
  (function(){
    var data = ${jsonForScript(data)};
    var selBtn = document.getElementById('lbSelBtn');
    var selMenu = document.getElementById('lbSelMenu');
    var selLabel = document.getElementById('lbSelLabel');

    function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function num(n){ return Number(n || 0).toLocaleString('ko-KR'); }
    /* 이름은 괄호로 덧붙인다 — "시즌 0 (오픈베타)" 처럼 번호만으로는 알 수 없는 것을
       알려 주는 자리다. 그런데 시즌을 넘길 때 이름을 "시즌 1" 로 넣으면 "시즌 1 (시즌 1)"
       이 된다. 같은 말을 두 번 하는 괄호는 아무것도 알려 주지 않으므로 뗀다.
       (이름을 지우는 대신 화면에서 판단한다 — 다음 시즌에 또 그렇게 넣어도 그대로 맞는다.) */
    function seasonName(s){
      var label = '시즌 ' + s.number;
      var name = (s.name || '').trim();
      if (!name || name === label || name === String(s.number)) return label;
      return label + ' (' + name + ')';
    }
    function ymd(sec){
      var d = new Date((sec + 9 * 3600) * 1000);
      return (d.getUTCMonth() + 1) + '월 ' + d.getUTCDate() + '일';
    }
    /* 종료일은 "그 시즌이 마지막으로 살아 있던 날"이다. 종료 시각을 그대로 적으면
       자정에 끝난 시즌이 하루 더 살아 있었던 것처럼 보인다(8/10 00:00 종료 → 8월 10일).

       게다가 실제로 찍히는 종료 시각은 예약된 순간이 아니라 "그 뒤 첫 요청이 들어온
       순간"이다 — 서버에 타이머가 없어서(fly 는 아무도 안 쓰면 잠든다) 요청이 올 때
       처리한다. 시즌 0 은 00:00:06 으로 찍혔다. 그래서 1초만 빼서는 여전히 10일이다.

       그래서 자정 직후(5분 안)에 닫힌 시즌은 그 자정을 진짜 종료 시각으로 본다.
       그 밖의 시각에 끝난 시즌은 늦게 찍힐 이유가 없으므로 1초만 뺀다. */
    var LAZY_SLACK = 300;
    function endYmd(sec){
      var into = ((sec + 9 * 3600) % 86400 + 86400) % 86400;   // KST 그날 몇 초째인가
      return ymd(into < LAZY_SLACK ? sec - into - 1 : sec - 1);
    }
    /* 남은 시간은 "며칠 몇 시간"까지만 적는다. 초 단위로 흐르면 시선을 뺏는데
       시즌은 몇 주 단위라 그 정밀도가 아무 의미가 없다. */
    function left(sec){
      if (sec <= 0) return '종료';
      var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
      return d > 0 ? d + '일 ' + h + '시간' : h > 0 ? h + '시간' : Math.floor(sec / 60) + '분';
    }
    function avatar(u, cls){
      var ini = esc((u.username || '?').slice(0, 1));
      var ph = '<span class="' + cls + ' ph">' + ini + '<\\/span>';
      if (!u.avatar) return ph;
      return '<img class="' + cls + '" src="' + esc(u.avatar) + '" alt="" referrerpolicy="no-referrer"'
        + ' onerror="this.onerror=null;this.outerHTML=' + esc(JSON.stringify(ph)) + '">';
    }
    // 승률은 rated 를 분모로 쓴다 — 원장에서 백필한 과거 판은 승패를 판정할 수 없다
    function winRate(r){
      var denom = (r.rated || 0) - (r.pushes || 0);
      return denom > 0 ? Math.round((r.wins || 0) / denom * 1000) / 10 + '%' : '—';
    }

    function paintSeasons(){
      selLabel.textContent = seasonName(data.season);
      selMenu.innerHTML = data.seasons.map(function(s){
        return '<button type="button" class="lb-selitem' + (s.id === data.season.id ? ' on' : '')
          + '" role="option" data-id="' + s.id + '">' + esc(seasonName(s))
          + (s.closed ? '<span class="lb-done">종료<\\/span>' : '<span class="lb-live">진행 중<\\/span>')
          + '<\\/button>';
      }).join('');
    }

    function paintBanner(){
      var s = data.season;
      /* 끝난 시즌은 끝난 날을, 종료 예약이 걸린 시즌은 끝날 날을 적는다.
         둘 다 endYmd 를 지난다 — "언제까지인가"가 사람이 읽는 종료일이다. */
      var right = s.closedAt != null
        ? '<div class="lb-bi"><span class="k">종료<\\/span><span class="v">' + endYmd(s.closedAt) + '<\\/span><\\/div>'
        : s.closeAt != null
          ? '<div class="lb-bi"><span class="k">종료<\\/span><span class="v gold">'
            + endYmd(s.closeAt) + '<\\/span><\\/div>'
          : s.endsAt != null
            ? '<div class="lb-bi"><span class="k">종료까지<\\/span><span class="v gold">'
              + esc(left(s.endsAt - data.serverNow)) + '<\\/span><\\/div>'
            : '<div class="lb-bi"><span class="k">종료<\\/span><span class="v">미정<\\/span><\\/div>';
      document.getElementById('lbBanner').innerHTML =
        '<div class="lb-bname">' + esc(seasonName(s))
        + (s.closedAt == null ? '<span class="lb-live">진행 중<\\/span>' : '') + '<\\/div>'
        + '<div class="lb-brow">'
        + '<div class="lb-bi"><span class="k">시작<\\/span><span class="v">' + ymd(s.startedAt) + '<\\/span><\\/div>'
        + right
        + '<\\/div>';
    }

    /* 카테고리는 데이터에서 온다. 게임이 몇 개든 가로로 흐르고 넘치면 스크롤된다 —
       줄바꿈으로 쌓으면 게임이 늘어날수록 표가 아래로 밀려 첫 화면에서 사라진다. */
    function paintChips(){
      var items = [{ key: 'overall', label: '통합 랭킹' }].concat(data.games);
      /* el 같은 흔한 이름을 쓰지 않는다. 화면 코드가 한 문자열로 이어 붙는 구조라
         이름이 겹치기 쉽고, 실제로 감사가 이 자리의 el 을 다른 조각의 el.hidden 대입과
         묶어 "hidden 이 안 먹는 요소"로 오탐했다.
         (이 주석에 백틱을 쓰면 안 된다 — 이 조각 자체가 템플릿 문자열이라 거기서 끊긴다) */
      chipsEl.innerHTML = items.map(function(g){
        return '<button type="button" class="lb-chip' + (g.key === data.tab ? ' on' : '')
          + '" role="tab" data-key="' + esc(g.key) + '">' + esc(g.label)
          + (g.players ? '<i>' + g.players + '<\\/i>' : '') + '<\\/button>';
      }).join('');
      /* 고른 칸이 화면 밖이면 끌어와 보여준다. 넘친 줄에서는 [포커 플립]을 누르고
         돌아왔을 때 그 칩이 오른쪽 밖에 있어 "어디가 켜졌는지" 보이지 않는다. */
      var on = chipsEl.querySelector('.lb-chip.on');
      if (on && on.scrollIntoView) {
        on.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      }
      chipEdges();
    }

    /* ── 넘친 줄을 끌어서 넘긴다 ────────────────────────────────────
       게임이 늘면서 칩 줄이 화면 밖으로 넘쳤다(실측: 860px 칸에 983px — [사다리게임]이
       잘리고 [포커 플립]은 아예 안 보인다). 줄 하나에 가로 스크롤바가 붙으면 지저분해서
       감춰 두었는데, 그러면 마우스로는 넘어간 것에 닿을 방법이 사라진다.

       세 가지를 함께 둔다. 하나만으로는 부족하다:
         · 끌기      — 손으로 미는 가장 직접적인 방법
         · 세로 휠   — 휠 마우스는 가로 스크롤을 주지 않는다(트랙패드만 준다)
         · 끝 흐림   — 넘어간 것이 있다는 신호. 없으면 끌어 볼 생각 자체를 못 한다 */
    var chipsEl = document.getElementById('lbChips');
    function chipEdges(){
      var max = chipsEl.scrollWidth - chipsEl.clientWidth;
      chipsEl.classList.toggle('more-l', chipsEl.scrollLeft > 2);
      chipsEl.classList.toggle('more-r', chipsEl.scrollLeft < max - 2);
    }
    (function(){
      var down = false, startX = 0, startLeft = 0, moved = 0;
      chipsEl.addEventListener('pointerdown', function(e){
        if (e.button !== 0) return;
        down = true; moved = 0; startX = e.clientX; startLeft = chipsEl.scrollLeft;
        try { chipsEl.setPointerCapture(e.pointerId); } catch (err) { /* 구형 브라우저 */ }
      });
      chipsEl.addEventListener('pointermove', function(e){
        if (!down) return;
        var dx = e.clientX - startX;
        moved = Math.max(moved, Math.abs(dx));
        if (moved > 4) chipsEl.classList.add('dragging');
        chipsEl.scrollLeft = startLeft - dx;
      });
      function release(e){
        if (!down) return;
        down = false;
        chipsEl.classList.remove('dragging');
        try { chipsEl.releasePointerCapture(e.pointerId); } catch (err) { /* 위와 같다 */ }
      }
      chipsEl.addEventListener('pointerup', release);
      chipsEl.addEventListener('pointercancel', release);
      /* 끌고 놓은 것을 클릭으로 세지 않는다 — 줄을 넘기려다 엉뚱한 탭이 열리면 그건
         고장으로 읽힌다. 캡처 단계에서 막아 탭 리스너에 닿지 않게 한다.
         4px 은 손떨림과 의도를 가르는 선이다(누를 때 손가락은 늘 조금 움직인다). */
      chipsEl.addEventListener('click', function(e){
        if (moved > 4) { e.stopPropagation(); e.preventDefault(); }
        moved = 0;
      }, true);
      chipsEl.addEventListener('wheel', function(e){
        if (chipsEl.scrollWidth <= chipsEl.clientWidth) return;
        if (e.deltaX !== 0) return;              // 트랙패드는 가로를 직접 준다 — 건드리지 않는다
        chipsEl.scrollLeft += e.deltaY;
        e.preventDefault();
      }, { passive: false });
      chipsEl.addEventListener('scroll', chipEdges);
      window.addEventListener('resize', chipEdges);
    })();

    function paintTable(){
      var overall = data.kind === 'overall';
      var ht = data.kind === 'holdem';       // 홀덤은 대회라 열이 또 다르다 (상금·우승·입상·참가)
      var rows = data.rows;
      document.getElementById('lbEmpty').hidden = rows.length > 0;

      // 1~3위는 포디움으로 크게, 나머지는 표로. 셋이 안 되면 포디움을 아예 안 만든다.
      var top = rows.slice(0, 3);
      document.getElementById('lbPodium').innerHTML = top.length < 3 ? '' :
        [top[1], top[0], top[2]].map(function(r){
          /* 내가 포디움에 있으면 그 카드를 초록으로 두른다. 등수 색(금·은·동)은 그대로
             두고 테두리만 바꾼다 — 등수와 "내 자리"는 다른 정보라 서로 덮으면 안 된다. */
          var pmine = data.me && r.userId === data.me.userId;
          return '<div class="lb-pod p' + r.rank + (pmine ? ' mine' : '') + '">'
            + (pmine ? '<span class="lb-you">나<\\/span>' : '')
            + '<div class="lb-medal">' + (r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : '🥉') + '<\\/div>'
            + avatar(r, 'lb-pav')
            + '<div class="lb-pname">' + esc(r.username) + '<\\/div>'
            + '<div class="lb-pscore">' + num(r.score) + (overall ? 'P' : 'P') + '<\\/div>'
            /* 포디움에 적는 것과 아래 표의 열을 같게 둔다. 예전에는 포디움만
               "5회 · 우승 3"이라 1~3위와 4위 아래를 나란히 볼 수가 없었다 —
               같은 화면의 같은 사람인데 보여 주는 값이 달랐다. 순서도 표와 맞춘다. */
            + (overall ? ''
                : ht ? '<div class="lb-psub">우승 ' + num(r.wins) + ' · 입상 ' + num(r.itm)
                       + ' · 참가 ' + num(r.entries) + '<\\/div>'
                : '<div class="lb-psub">' + num(r.rounds) + '판 · 승률 ' + winRate(r) + '<\\/div>')
            + '<\\/div>';
        }).join('');

      document.getElementById('lbHead').innerHTML = overall
        ? '<tr><th class="c">#<\\/th><th>유저<\\/th><th class="r">포인트<\\/th><\\/tr>'
        : ht
          ? '<tr><th class="c">#<\\/th><th>유저<\\/th><th class="r">총 상금<\\/th>'
            + '<th class="r">우승<\\/th><th class="r">입상<\\/th><th class="r">참가<\\/th><\\/tr>'
          /* 홀덤과 열 순서를 맞춘다: 돈 → 횟수 → 비율.
             예전에는 홀덤만 상금·우승·입상·참가였고 나머지는 순수익·승률·판수여서,
             탭을 옮길 때마다 어느 열이 무엇인지 다시 읽어야 했다. */
          : '<tr><th class="c">#<\\/th><th>유저<\\/th><th class="r">순수익<\\/th>'
            + '<th class="r">판수<\\/th><th class="r">승률<\\/th><\\/tr>';

      var from = top.length < 3 ? 0 : 3;
      document.getElementById('lbBody').innerHTML = rows.slice(from).map(function(r){
        var mine = data.me && r.userId === data.me.userId;
        // 상금은 손익이 아니라 받은 돈이라 붉게 물들 일이 없다 — 색은 순수익 탭에만 쓴다
        var profitCls = (overall || ht) ? '' : (r.score > 0 ? ' pos' : r.score < 0 ? ' neg' : '');
        return '<tr' + (mine ? ' class="me"' : '') + '>'
          + '<td class="c rk">' + r.rank + '<\\/td>'
          + '<td><span class="lb-who">' + avatar(r, 'lb-av') + esc(r.username)
            + (mine ? '<span class="lb-youtag">(나)<\\/span>' : '') + '<\\/span><\\/td>'
          + '<td class="r n' + profitCls + '">' + (r.score > 0 && !overall && !ht ? '+' : '') + num(r.score) + 'P<\\/td>'
          + (overall ? ''
              : ht ? '<td class="r n">' + num(r.wins) + '<\\/td><td class="r n">' + num(r.itm)
                     + '<\\/td><td class="r n">' + num(r.entries) + '<\\/td>'
              : '<td class="r n">' + num(r.rounds) + '<\\/td><td class="r n">' + winRate(r) + '<\\/td>')
          + '<\\/tr>';
      }).join('');
    }

    /* 내 순위는 아래에 붙여 둔다. 100위 밖이면 표에 없어서, 고정바가 없으면
       "내가 몇 등인지"를 알 방법이 사라진다. */
    function paintMe(){
      var bar = document.getElementById('lbMe');
      if (!data.me) { bar.hidden = true; return; }
      /* 이미 화면에 보이는 사람에게는 띄우지 않는다. 포디움이나 표에 내 줄이 이미
         초록으로 칠해져 있는데 아래에 같은 말을 한 번 더 적으면 중복이다.
         이 고정바의 쓸모는 100위 밖이라 표에 없는 경우 하나뿐이다. */
      var shown = false;
      for (var i = 0; i < data.rows.length; i++) {
        if (data.rows[i].userId === data.me.userId) { shown = true; break; }
      }
      if (shown) { bar.hidden = true; return; }
      bar.hidden = false;
      var overall = data.kind === 'overall';
      var ht = data.kind === 'holdem';
      /* 위 표와 같은 순서·같은 자리에 놓는다 — [등수][아바타 이름][보조][점수].
         예전에는 등수 뒤에 이름이 바로 붙고 아바타가 없어서, 표에서 눈이 내려오다가
         이 줄에서 한 번 끊겼다. 같은 줄의 연장으로 읽히는 편이 낫다. */
      bar.innerHTML = '<div class="lb-mebox">'
        + '<span class="lb-merk">' + data.me.rank + '<span>/' + data.me.total + '<\\/span><\\/span>'
        + '<span class="lb-mewho">' + avatar(data.me, 'lb-av')
        + '<span class="lb-mename">' + esc(data.me.username) + '<\\/span>'
        + '<span class="lb-youtag">(나)<\\/span><\\/span>'
        /* 포디움·표와 같은 말로 적는다. 세 자리가 서로 다른 요약을 쓰면 같은 내 기록인데
           보는 자리마다 다른 숫자가 나온다. */
        + (overall ? ''
            : ht ? '<span class="lb-mesub">우승 ' + num(data.me.wins || 0)
                   + ' · 입상 ' + num(data.me.itm || 0)
                   + ' · 참가 ' + num(data.me.entries || 0) + '<\\/span>'
            : '<span class="lb-mesub">' + num(data.me.rounds || 0) + '판 · 승률 '
                   + winRate(data.me) + '<\\/span>')
        + '<span class="lb-mescore">' + (data.me.score > 0 && !overall && !ht ? '+' : '')
        + num(data.me.score) + 'P<\\/span>'
        + '<\\/div>';
    }

    function paintAll(){ paintSeasons(); paintBanner(); paintChips(); paintTable(); paintMe(); }

    var loading = false;
    function load(seasonId, tab){
      if (loading) return;
      loading = true;
      document.querySelector('.lb').classList.add('busy');
      fetch('/api/leaderboard?season=' + seasonId + '&tab=' + encodeURIComponent(tab))
        .then(function(r){ return r.json(); })
        .then(function(d){ if (d && d.ok) { data = d; paintAll(); } })
        .catch(function(){ /* 다음 조작에서 다시 시도된다 */ })
        .then(function(){ loading = false; document.querySelector('.lb').classList.remove('busy'); });
    }

    selBtn.addEventListener('click', function(){
      var open = !selMenu.hidden;
      selMenu.hidden = open;
      selBtn.setAttribute('aria-expanded', String(!open));
    });
    document.addEventListener('click', function(e){
      if (!document.getElementById('lbSel').contains(e.target)) {
        selMenu.hidden = true; selBtn.setAttribute('aria-expanded', 'false');
      }
    });
    selMenu.addEventListener('click', function(e){
      var b = e.target.closest ? e.target.closest('.lb-selitem') : null;
      if (!b) return;
      selMenu.hidden = true; selBtn.setAttribute('aria-expanded', 'false');
      load(Number(b.getAttribute('data-id')), data.tab);
    });
    document.getElementById('lbChips').addEventListener('click', function(e){
      var b = e.target.closest ? e.target.closest('.lb-chip') : null;
      if (!b) return;
      load(data.season.id, b.getAttribute('data-key'));
    });

    paintAll();
  })();
  </script>`;
  return layout('랭킹', 'leaderboard', body);
}
