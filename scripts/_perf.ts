import * as H from '../src/services/holdem';

function rng(max: number): number { return Math.floor(Math.random() * max); }
// 6인 프리플랍 올인 — 서버가 endHand에서 실제로 도는 계산
const hands = [
  { seat: 0, hole: [51, 47] }, { seat: 1, hole: [43, 39] }, { seat: 2, hole: [35, 31] },
  { seat: 3, hole: [27, 23] }, { seat: 4, hole: [19, 15] }, { seat: 5, hole: [11, 7] },
];
const board = [0, 4, 8, 12, 16];
for (const [name, n] of [['2인', 2], ['4인', 4], ['6인', 6]] as [string, number][]) {
  const hs = hands.slice(0, n);
  const t = Date.now();
  const st = H.equityStages(hs, board, 0, rng);
  console.log(name, '프리플랍 올인 equityStages:', (Date.now() - t) + 'ms', '단계', st.map(s => s.boardLen).join(','));
}
