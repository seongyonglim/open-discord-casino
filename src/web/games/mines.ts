// 지뢰찾기: 25칸 중 지뢰 M개, 안전 칸을 열수록 배당 상승, 원할 때 캐시아웃.
// 배당(k) = (1 - 하우스엣지) × C(25,k) / C(25-M,k)  — "k칸을 연속으로 안전하게 열 확률"의 역수라 완전공정(하우스엣지 제외)하다.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomInt } from 'node:crypto';
import { placeBet, getActiveRound, updateRoundState, settleGameRound, type GameRound } from '../../db/queries';
import { readJson, sendJson } from '../http';
import { layout, sidePanel, rankPane, rankJs } from '../views';
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

function calcMultiplier(mineCount: number, revealedCount: number): number {
  if (revealedCount <= 0) return 1;
  let m = 1;
  for (let i = 0; i < revealedCount; i++) {
    m *= (TILE_COUNT - i) / (TILE_COUNT - mineCount - i);
  }
  return m * (1 - HOUSE_EDGE);
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
    const payout = Math.floor(round.bet_amount * multiplier);
    const balance = settleGameRound(round.id, userId, payout, multiplier, `game:${GAME_TYPE}`);
    const settled: GameRound = { ...round, status: 'settled', payout, multiplier };
    return sendJson(res, 200, { ok: true, autoCashedOut: true, balance, round: publicRound(settled, newState, true) });
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
  const payout = Math.floor(round.bet_amount * multiplier);
  // 0칸 캐시아웃은 전액 환불과 같으므로 랭킹의 판수에 넣지 않는다 (위 주석 참조)
  const balance = settleGameRound(round.id, userId, payout, multiplier, `game:${GAME_TYPE}`,
    state.revealed.length > 0);
  const settled: GameRound = { ...round, status: 'settled', payout, multiplier };
  return sendJson(res, 200, { ok: true, balance, round: publicRound(settled, state, true) });
}


export function minesPage(user: WebUser): string {
  const active = activeRoundPayload(user.id);
  const body = `
    ${gameSwitcher('mines')}
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
      window.__SFX_NEED__ = ['minecoin','explode','gain'];
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
      function setIdle(){
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

      function markTile(i, kind){
        var b=tiles[i]; if (!b) return;
        b.disabled=true; b.classList.remove('safe','mine'); b.innerHTML=kind==='mine'?ICONS.bomb:ICONS.coin;
        void b.offsetWidth; b.classList.add(kind);
      }

      function updateStats(round){
        multiEl.textContent = round.multiplier.toFixed(2) + 'x';
        potEl.textContent = fmt(round.betAmount * round.multiplier);
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
          msg.innerHTML = '<span style="color:var(--lose);font-weight:700">지뢰 적중</span> — 베팅액을 잃었습니다.';
          setBalance(res.data.balance); setIdle();
        } else if (res.data.autoCashedOut) {
          markTile(i, 'safe');
          msg.innerHTML = '<span style="color:var(--gold);font-weight:700">퍼펙트 클리어</span> — 자동 캐시아웃 +' + fmt(round.payout) + ' (잔액 ' + fmt(res.data.balance) + ')';
          setBalance(res.data.balance); setIdle(); if (card) replay(card, 'gold-flash');
          if (pbal) replay(pbal, 'bump');
          if (window.casinoSfx) window.casinoSfx.win();
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
    </script>`;
  return layout('지뢰찾기', 'lobby', body);
}
