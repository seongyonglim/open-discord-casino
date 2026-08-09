/* 도전과제 화면.
 *
 * 과제를 하나도 알지 못한다. db/achievements 가 준 줄을 분류로 묶어 늘어놓을 뿐이라,
 * 새 과제를 붙일 때 이 파일은 손대지 않는다 — 표에 줄을 넣으면 그대로 뜬다.
 *
 * 탭 전환은 서버에 다시 묻지 않는다. 카드를 전부 그려 두고 보이기만 바꾼다 —
 * 열두 개 남짓한 목록이라 다시 받을 이유가 없고, 누를 때마다 깜빡이지도 않는다.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { layout, esc, jsonForScript } from './views';
import {
  bombIcon, coinIcon, ladderIcon, chartIcon, flipIcon,
  baccaratIcon, blackjackIcon, trophyIcon,
} from './icons';
import { sendJson } from './http';
import {
  ACH_TABS, achievementsFor, achievementProgress, unlockersOf, activePlayerCount,
  listAchievements, unlockCount, hasAchievement,
  type AchievementView,
} from '../db/achievements';
import type { WebUser } from '../db/queries';

/* 아이콘이 없는 과제에 쓸 기본 그림. 로비의 게임 아이콘을 그대로 쓴다 —
   같은 게임인데 로비에서는 선 아이콘, 여기서는 이모지면 두 화면이 남처럼 보이고,
   이모지는 OS 마다 모양과 크기가 달라 줄이 들쭉날쭉해진다(icons.ts 의 첫 줄이 그 이유다).
   전부 currentColor 기반이라 잠긴 카드에서 회색으로 눌리는 것도 그대로 따라온다. */
const TYPE_ICON: Record<string, string> = {
  HOLDEM: trophyIcon, BACCARAT: baccaratIcon, BLACKJACK: blackjackIcon, POKER: flipIcon,
  MINES: bombIcon, CRASH: chartIcon, LADDER: ladderIcon, ALL: coinIcon,
};
/** 자물쇠(감춘 과제). 나머지와 같은 선 굵기·크기로 그려야 한 줄에 섞여도 튀지 않는다. */
const LOCK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
  + ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
  + '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/>'
  + '<path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>'
  + '<circle cx="12" cy="15.5" r="1.4" fill="currentColor" stroke="none"/></svg>';

function kstDate(sec: number): string {
  const d = new Date((sec + 9 * 3600) * 1000);
  return `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.`
    + `${String(d.getUTCDate()).padStart(2, '0')}`;
}

/* 아바타. 디스코드 프로필 사진을 쓰고, 없거나 죽은 주소면 이름 첫 글자로 되돌린다 —
   프로필을 바꾸면 저장된 주소가 404가 되는데 갱신은 다시 로그인할 때뿐이라,
   폴백이 없으면 얼굴 자리에 깨진 그림이 남는다(머리의 아바타와 같은 규칙이다). */
function face(userId: string, avatar: string | null, username: string, cls: string): string {
  const ini = esc((username.trim()[0] ?? '?').toUpperCase());
  const ph = `<span class="${cls}">${ini}</span>`;
  if (!avatar) return ph;
  return `<img class="${cls}" src="${esc(avatar)}" alt="" width="22" height="22"`
    + ` referrerpolicy="no-referrer" title="${esc(username)}"`
    + ` onerror="this.onerror=null;this.outerHTML=${esc(JSON.stringify(ph))}">`;
}

/* 카드 아래 달성자 줄.
   얼굴은 앞의 다섯만 보여준다 — 여섯 명부터는 줄이 두 줄이 되고, 카드가 격자라
   한 장만 키가 커지면 그 줄 전체가 어긋난다. 나머지는 "+N"으로 접고, 누르면 전체 명단이 뜬다.
   먼저 해낸 순서로 세운다: 이 목록의 의미는 "누가 먼저 했나"다. */
function unlockerRow(v: AchievementView, total: number): string {
  if (v.unlockedBy < 0) return '';                       // 감춘 과제 — 인원도 알려주지 않는다
  if (v.unlockedBy === 0) {
    return `<div class="ac-who none"><span class="ac-who-n">아직 아무도 달성하지 못했습니다</span></div>`;
  }
  const shown = unlockersOf(v.id, 5);
  const rest = v.unlockedBy - shown.length;
  const faces = shown.map(u => face(u.userId, u.avatar, u.username, 'ac-face')).join('')
    + (rest > 0 ? `<span class="ac-face more">+${rest}</span>` : '');
  const pct = total > 0 ? Math.floor((v.unlockedBy * 100) / total) : 0;
  return `<button type="button" class="ac-who" data-id="${esc(v.id)}" data-title="${esc(v.title)}">
      <span class="ac-faces">${faces}</span>
      <span class="ac-who-n num">${v.unlockedBy}명 달성${total > 0 ? ` · ${pct}%` : ''}</span>
    </button>`;
}

function card(v: AchievementView, total: number): string {
  const icon = v.iconUrl
    ? `<img class="ac-ic-img" src="${esc(v.iconUrl)}" alt="" width="46" height="46">`
    : `<span class="ac-ic-svg">${v.unlocked || !v.hidden
      ? (TYPE_ICON[v.gameType] ?? coinIcon) : LOCK_ICON}</span>`;
  /* 잠긴 카드는 흑백에 자물쇠다. 달성한 카드만 색이 살아 있어야 목록을 훑을 때
     "내가 한 것"이 먼저 눈에 들어온다. */
  const cls = 'ac-card' + (v.unlocked ? ' on' : ' off') + (v.hidden && !v.unlocked ? ' secret' : '');
  /* 최소 베팅을 카드마다 적는다. 안내 문구 한 줄로만 두면 "이 과제도 해당되나"를
     매번 위로 올라가 확인해야 하고, 과제마다 기준이 다를 수 있으면 그 문구가 거짓이 된다.
     0 이면 베팅과 무관한 과제라 아무것도 안 적는다 — "0P 이상"은 뜻이 없다.
     감춘 과제에는 안 적는다: 베팅으로 깨는 것인지 아닌지도 알려 주지 않아야 감춘 것이다. */
  const hiddenYet = v.hidden && !v.unlocked;
  const need = !hiddenYet && v.minBet > 0
    ? `<span class="ac-need num">베팅 ${v.minBet.toLocaleString('ko-KR')}P 이상</span>`
    : '';
  const foot = (v.unlocked
    ? `<span class="ac-date num">${kstDate(v.unlockedAt ?? 0)} 달성</span>`
    : `<span class="ac-lock">잠김</span>`) + need;
  return `<div class="${cls}" data-type="${esc(v.gameType)}">
      <div class="ac-ic">${icon}</div>
      <div class="ac-body">
        <div class="ac-title">${esc(v.title)}</div>
        <div class="ac-desc">${esc(v.description)}</div>
      </div>
      <div class="ac-foot">${foot}</div>
      ${unlockerRow(v, total)}
    </div>`;
}

export function achievementsPage(me: WebUser | null): string {
  const views = achievementsFor(me?.id ?? null);
  const p = achievementProgress(views);

  /* 탭에도 로비와 같은 아이콘을 단다. [전체]는 특정 게임이 아니라 아이콘이 없다 —
     아무 그림이나 붙이면 그것도 게임 하나로 읽힌다. */
  const tabs = ACH_TABS.map((t, i) => {
    const ic = t.types.length === 1 ? TYPE_ICON[t.types[0]] : null;
    return `<button type="button" class="ac-tab${i === 0 ? ' on' : ''}" data-tab="${esc(t.key)}">`
      + (ic ? `<span class="ac-tab-ic">${ic}</span>` : '') + esc(t.label) + `</button>`;
  }).join('');
  const players = activePlayerCount();
  const cards = views.map(v => card(v, players)).join('');

  /* 과제가 하나도 없을 때. 틀만 먼저 만들어 두고 과제는 나중에 넣는 구조라,
     이 화면이 비어 있는 것은 고장이 아니라 정상이다 — 그렇게 읽히도록 적는다. */
  const empty = `<div class="ac-empty">
      <div class="ac-empty-ic">🏆</div>
      <div class="ac-empty-t">아직 공개된 도전과제가 없습니다</div>
      <div class="ac-empty-s">준비되는 대로 이곳에 하나씩 올라갑니다.</div>
    </div>`;

  const body = `
    <div class="card ac-wrap">
      <div class="ac-head">
        <div>
          <h2>도전과제</h2>
          <p class="ac-lead">한 번 달성하면 계정에 영구히 남습니다 — 시즌이 바뀌어도 사라지지 않습니다.</p>
          <p class="ac-rule"><b>게임 도전과제는 그 판의 베팅이 기준 금액 이상일 때만 판정됩니다.</b>
            소액으로 여러 번 돌려 얻는 것을 막기 위한 규칙이며, 기준은 카드마다 적혀 있습니다.</p>
        </div>
        <div class="ac-sum">
          <div class="ac-sum-n num"><b id="acDone">${p.unlocked}</b> / <span id="acTotal">${p.total}</span></div>
          <div class="ac-sum-l">달성</div>
        </div>
      </div>
      <div class="ac-bar" role="progressbar" aria-valuenow="${p.percent}" aria-valuemin="0" aria-valuemax="100">
        <div class="ac-bar-in" id="acBarIn" style="width:${p.percent}%"></div>
      </div>
      <div class="ac-bar-cap">전체 도전과제 달성률 <b class="num">${p.unlocked} / ${p.total}</b>
        <span class="num">(${p.percent}%)</span></div>
      <div class="ac-tabs" id="acTabs">${tabs}</div>
      <div class="ac-grid" id="acGrid">${cards}</div>
      ${views.length === 0 ? empty : ''}
    </div>
    <dialog id="acWho" class="ac-dlg">
      <h3 id="acWhoT">달성자</h3>
      <div class="ac-who-list" id="acWhoL"></div>
      <div class="ac-dlg-row"><button type="button" id="acWhoX">닫기</button></div>
    </dialog>`;

  const script = `<script>(function(){
    var TABS = ${jsonForScript(ACH_TABS.map(t => ({ key: t.key, types: t.types })))};
    var tabsEl = document.getElementById('acTabs');
    var cards = Array.prototype.slice.call(document.querySelectorAll('#acGrid .ac-card'));
    if (!tabsEl) return;
    function show(key){
      var def = null;
      for (var i = 0; i < TABS.length; i++) if (TABS[i].key === key) def = TABS[i];
      cards.forEach(function(c){
        // types 가 비었으면 [전체] 탭이라 거르지 않는다
        var ok = !def || def.types.length === 0 || def.types.indexOf(c.getAttribute('data-type')) >= 0;
        c.hidden = !ok;
      });
      Array.prototype.forEach.call(tabsEl.children, function(b){
        b.classList.toggle('on', b.getAttribute('data-tab') === key);
      });
    }
    tabsEl.addEventListener('click', function(ev){
      var b = ev.target.closest ? ev.target.closest('.ac-tab') : null;
      if (!b) return;
      show(b.getAttribute('data-tab'));
      /* 탭이 아홉이라 좁은 화면에서는 줄이 넘친다. 고른 탭이 반쯤 잘린 채로 남으면
         지금 어느 탭인지 확인하려고 다시 옆으로 밀어야 한다. */
      if (b.scrollIntoView) b.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    });

    /* 달성자 전체 명단. 카드에는 얼굴 다섯까지만 보이므로 나머지를 여기서 본다.
       열 때 받아 온다 — 과제가 열둘이고 사람이 늘면 첫 화면에 전부 실어 보내는 것이
       그대로 응답 크기가 된다. */
    var dlg = document.getElementById('acWho');
    var dlgT = document.getElementById('acWhoT'), dlgL = document.getElementById('acWhoL');
    function esc(s){
      return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function when(sec){
      var d = new Date(sec * 1000);
      return d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0')
        + '.' + String(d.getDate()).padStart(2, '0');
    }
    document.getElementById('acGrid').addEventListener('click', function(ev){
      var b = ev.target.closest ? ev.target.closest('.ac-who[data-id]') : null;
      if (!b || !dlg) return;
      dlgT.textContent = b.getAttribute('data-title') + ' — 달성자';
      dlgL.innerHTML = '<div class="ac-who-empty">불러오는 중…<\/div>';
      dlg.showModal();
      fetch('/api/achievements/unlockers?id=' + encodeURIComponent(b.getAttribute('data-id')))
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (!d || !d.ok) { dlgL.innerHTML = '<div class="ac-who-empty">불러오지 못했습니다<\/div>'; return; }
          if (!d.items.length) { dlgL.innerHTML = '<div class="ac-who-empty">아직 아무도 달성하지 못했습니다<\/div>'; return; }
          dlgL.innerHTML = d.items.map(function(u, i){
            var ini = esc((u.username || '?').trim().charAt(0).toUpperCase());
            var av = u.avatar
              ? '<img class="ac-face lg" src="' + esc(u.avatar) + '" alt="" width="28" height="28" referrerpolicy="no-referrer">'
              : '<span class="ac-face lg">' + ini + '<\/span>';
            return '<div class="ac-who-row"><span class="ac-who-i num">' + (i + 1) + '<\/span>'
              + av + '<span class="ac-who-nm">' + esc(u.username) + '<\/span>'
              + '<span class="ac-who-d num">' + when(u.at) + '<\/span><\/div>';
          }).join('')
          + (d.more > 0 ? '<div class="ac-who-empty">그 밖에 ' + d.more + '명<\/div>' : '');
        })
        .catch(function(){ dlgL.innerHTML = '<div class="ac-who-empty">불러오지 못했습니다<\/div>'; });
    });
    var x = document.getElementById('acWhoX');
    if (x) x.addEventListener('click', function(){ dlg.close(); });
  })();<\/script>`;

  return layout('도전과제', 'achievements', body + script);
}

/** 화면이 새로고침 없이 다시 그릴 때 쓴다 (달성 직후 진행률 갱신). */
export async function handleAchievements(
  _req: IncomingMessage, res: ServerResponse, userId: string | null
): Promise<void> {
  const views = achievementsFor(userId);
  return sendJson(res, 200, { ok: true, progress: achievementProgress(views), items: views });
}

/**
 * 한 과제의 달성자 명단.
 *
 * 감춘 과제는 내주지 않는다 — 본인이 달성했으면 이미 내용을 아는 사람이라 보여 준다.
 * 화면에서 버튼을 안 그리는 것만으로는 부족하다: 주소를 직접 치면 그대로 나온다.
 */
const WHO_LIMIT = 50;

export async function handleUnlockers(
  _req: IncomingMessage, res: ServerResponse, url: URL, userId: string | null
): Promise<void> {
  const id = (url.searchParams.get('id') ?? '').trim();
  const a = listAchievements().find(x => x.id === id);
  if (!a) return sendJson(res, 404, { error: '없는 도전과제입니다' });
  if (a.is_hidden === 1 && !(userId && hasAchievement(userId, id))) {
    return sendJson(res, 403, { error: '아직 공개되지 않은 도전과제입니다' });
  }
  const total = unlockCount(id);
  const items = unlockersOf(id, WHO_LIMIT);
  return sendJson(res, 200, {
    ok: true, total, items, more: Math.max(0, total - items.length),
  });
}
