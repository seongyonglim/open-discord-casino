// 재난 지원금 신청 화면 + API
import type { IncomingMessage, ServerResponse } from 'node:http';
import { layout, esc, pts } from './views';
import { sendJson } from './http';
import { reliefView, claim, RELIEF_AMOUNT, RELIEF_COOLDOWN_SEC } from '../services/relief';
import type { WebUser } from '../db/queries';

function hoursLabel(sec: number): string {
  return `${Math.round(sec / 3600)}시간`;
}

// 남은 쿨다운을 "2시간 13분" 형태로. 1분 미만은 "곧"으로 뭉갠다(초 단위까지 보여줄 이유가 없다).
function waitLabel(sec: number): string {
  if (sec <= 0) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}시간 ${m}분`;
  return m > 0 ? `${m}분` : '곧';
}

export function reliefPage(user: WebUser): string {
  const v = reliefView(user.id)!;
  const amount = esc(pts(RELIEF_AMOUNT));

  // 상태별 안내 — 왜 못 받는지 분명히 알려준다(조건이 두 개라 뭉뚱그리면 답답하다)
  const state = v.claimable
    ? `<div class="relief-state ok">지금 신청할 수 있습니다</div>`
    : v.blockedBy === 'not_broke'
      ? `<div class="relief-state">보유 포인트가 <b>${esc(pts(v.balance))}</b> 남아 있습니다 —
           <b>0P</b>가 되면 신청할 수 있습니다</div>`
      : `<div class="relief-state">다음 신청까지 <b id="rWait">${esc(waitLabel(v.waitSec))}</b> 남았습니다</div>`;

  const body = `
    <div class="card relief-card">
      <h2>재난 지원금</h2>
      <p class="relief-lead">포인트를 모두 잃었을 때 다시 시작할 수 있도록 드리는 소액 지원금입니다.</p>

      <div class="relief-amount">${amount}</div>
      ${state}

      <button id="rClaim" class="btn btn-gold relief-btn" type="button"${v.claimable ? '' : ' disabled'}>
        ${v.claimable ? '지원금 신청' : '신청 불가'}
      </button>
      <p id="rMsg" class="game-msg relief-msg"></p>

      <ul class="relief-rules">
        <li>보유 포인트가 <b>정확히 0P</b>일 때만 신청할 수 있습니다</li>
        <li>한 번 받으면 <b>${hoursLabel(RELIEF_COOLDOWN_SEC)}</b> 뒤에 다시 신청할 수 있습니다</li>
        <li>지급 내역은 출석 보상과 함께 포인트 기록에 남습니다</li>
      </ul>
    </div>
    <script>
    (function(){
      var btn = document.getElementById('rClaim');
      var msg = document.getElementById('rMsg');
      if (!btn) return;
      btn.addEventListener('click', async function(){
        btn.disabled = true;
        var r = await fetch('/api/relief/claim', { method:'POST' });
        var d = await r.json().catch(function(){ return {}; });
        if (!r.ok) {
          msg.textContent = d.error || '신청하지 못했습니다';
          // 잔액이 생겼거나 쿨다운이 남은 상태이므로 화면을 최신으로 맞춘다
          setTimeout(function(){ location.reload(); }, 1200);
          return;
        }
        msg.innerHTML = '<span style="color:var(--win);font-weight:700">지원금 지급 완료</span> +' + d.granted + 'P';
        if (window.casinoSfx) window.casinoSfx.win();
        setTimeout(function(){ location.reload(); }, 1200);
      });
    })();
    </script>`;
  return layout('재난 지원금', 'relief', body);
}

export async function handleClaim(_req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const r = claim(userId);
  if (!r.ok) {
    const msg = r.error === 'not_broke'
      ? '보유 포인트가 0P일 때만 신청할 수 있습니다'
      : r.error === 'cooldown'
        ? `아직 신청할 수 없습니다. ${hoursLabel(RELIEF_COOLDOWN_SEC)}에 한 번만 받을 수 있습니다.`
        : '계정을 찾을 수 없습니다';
    return sendJson(res, 400, { error: msg });
  }
  return sendJson(res, 200, {
    ok: true, granted: RELIEF_AMOUNT, balance: r.balance, nextAvailableAt: r.nextAvailableAt,
  });
}
