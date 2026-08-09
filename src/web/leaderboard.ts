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
  seasonHoldemRanking, seasonHoldemCount, seasonHoldemPlayers, myHoldemRank,
  type SeasonRow,
} from '../db/queries';
import type { WebUser } from '../db/queries';

const GAME_LABEL: Record<string, string> = {
  mines: '지뢰찾기', ladder: '사다리게임', graph: '그래프게임',
  poker: '포커 플립', baccarat: '바카라', blackjack: '블랙잭',
};
/* 표에 없는 게임이 와도 화면이 비지 않게 한다 — 새 게임이 붙는 날 이 표를 고치는 것을
   잊어도 키 이름이라도 나온다. 카테고리가 데이터에서 오므로 이 경우가 실제로 생긴다. */
const label = (g: string) => GAME_LABEL[g] ?? g;

export interface RankPayload {
  seasons: { id: number; number: number; name: string; closed: boolean }[];
  season: { id: number; number: number; name: string; reward: string;
    startedAt: number; endsAt: number | null; closedAt: number | null };
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
  const htCount = seasonHoldemCount(s.id);
  if (htCount > 0) {
    /* 탭 옆 숫자는 "몇 명이 했나"다(다른 게임도 그렇다). 예전에는 0을 넣어 두어
       홀덤에만 배지가 안 붙었고, 그래서 이 탭만 다른 규칙인 것처럼 보였다. */
    games.unshift({
      key: 'holdem', label: '홀덤 토너먼트', rounds: htCount, players: seasonHoldemPlayers(s.id),
    });
  }
  // 요청한 탭이 그 시즌에 없으면 통합으로 되돌린다 — 시즌을 바꿨을 때 빈 화면이 나오지 않게
  const active = tab !== 'overall' && games.some(g => g.key === tab) ? tab : 'overall';

  const rows: RankRow[] = active === 'overall'
    ? seasonOverall(s.id, 100).map(r => ({ ...r }))
    : active === 'holdem'
      ? seasonHoldemRanking(s.id, 100).map(r => ({
          userId: r.userId, username: r.username, avatar: r.avatar, rank: r.rank,
          score: r.prize, entries: r.entries, wins: r.wins, itm: r.itm,
        }))
      : seasonGameRanking(s.id, active, 100).map(r => ({
          userId: r.userId, username: r.username, avatar: r.avatar, rank: r.rank,
          score: r.profit, rounds: r.rounds, rated: r.rated, wins: r.wins, pushes: r.pushes,
        }));

  const mine = !me ? null
    : active === 'holdem' ? myHoldemRank(s.id, me.id)
    : mySeasonRank(s.id, me.id, active === 'overall' ? null : active);
  return {
    seasons: seasons.map(x => ({ id: x.id, number: x.number, name: x.name, closed: x.closed_at != null })),
    season: { id: s.id, number: s.number, name: s.name, reward: s.reward,
      startedAt: s.started_at, endsAt: s.ends_at, closedAt: s.closed_at },
    games, tab: active,
    kind: active === 'overall' ? 'overall' : active === 'holdem' ? 'holdem' : 'game',
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
    function seasonName(s){ return '시즌 ' + s.number + (s.name ? ' (' + s.name + ')' : ''); }
    function ymd(sec){
      var d = new Date((sec + 9 * 3600) * 1000);
      return (d.getUTCMonth() + 1) + '월 ' + d.getUTCDate() + '일';
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
      var right = s.closedAt != null
        ? '<div class="lb-bi"><span class="k">종료<\\/span><span class="v">' + ymd(s.closedAt) + '<\\/span><\\/div>'
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
        /* 보상은 적어 넣은 문구를 그대로 보여 주는 자리다 — 지급 로직이 있는 게 아니다.
           그래서 비어 있으면 줄을 아예 없앤다. '준비 중'이라고 적으면 없는 것을
           곧 준다고 약속하는 셈이 된다. */
        + (s.reward ? '<div class="lb-bi"><span class="k">보상<\\/span><span class="v">'
            + esc(s.reward) + '<\\/span><\\/div>' : '')
        + '<\\/div>';
    }

    /* 카테고리는 데이터에서 온다. 게임이 몇 개든 가로로 흐르고 넘치면 스크롤된다 —
       줄바꿈으로 쌓으면 게임이 늘어날수록 표가 아래로 밀려 첫 화면에서 사라진다. */
    function paintChips(){
      var items = [{ key: 'overall', label: '통합 랭킹' }].concat(data.games);
      document.getElementById('lbChips').innerHTML = items.map(function(g){
        return '<button type="button" class="lb-chip' + (g.key === data.tab ? ' on' : '')
          + '" role="tab" data-key="' + esc(g.key) + '">' + esc(g.label)
          + (g.players ? '<i>' + g.players + '<\\/i>' : '') + '<\\/button>';
      }).join('');
    }

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
