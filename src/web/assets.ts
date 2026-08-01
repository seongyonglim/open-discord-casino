// 정적 자산(카드 SVG, 효과음) 캐시 무효화용 버전 문자열.
// 브라우저에 1주일 캐시를 걸어두기 때문에, 카드 도안을 다시 생성해도 URL이 같으면
// 예전 그림이 계속 보인다. 서버가 뜰 때 public/ 안의 가장 최근 수정 시각으로 버전을 만들어
// URL 뒤에 붙여서, 자산이 바뀌면 자동으로 새로 받아가게 한다.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function newestMtime(dir: string): number {
  let newest = 0;
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) newest = Math.max(newest, newestMtime(p));
      else newest = Math.max(newest, st.mtimeMs);
    }
  } catch { /* public/ 이 없으면 0 */ }
  return newest;
}

// public/(카드·효과음)과 src/web/assets/(app.css·app.js) 중 가장 최근 수정 시각을 쓴다.
// app.css/app.js도 1주일 캐시로 서빙하므로, 이 둘이 빠지면 스타일을 고쳐도 반영되지 않는다.
// mtimeMs는 소수점이 있어 그대로 36진수로 바꾸면 "msanypvk.bhk"처럼 점이 섞인다 — 내림해서 정수로.
export const ASSET_V = Math.floor(Math.max(
  newestMtime(join(process.cwd(), 'public')),
  newestMtime(join(process.cwd(), 'src', 'web', 'assets')),
)).toString(36);
