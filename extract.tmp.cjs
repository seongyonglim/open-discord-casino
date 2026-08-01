// views.ts의 인라인 <style>·<script>를 상수로 뽑아, 캐시되는 외부 파일로 서빙할 수 있게 한다.
const fs = require('fs');
const p = 'src/web/views.ts';
const lines = fs.readFileSync(p, 'utf8').split('\n');

const iStyleOpen = lines.findIndex(l => l === '<style>');
const iStyleClose = lines.findIndex(l => l === '</style>');
const iScriptOpen = lines.findIndex(l => l === '<script>');
const iScriptClose = lines.findIndex(l => l === '</script>');
if (iStyleOpen < 0 || iStyleClose < 0 || iScriptOpen < 0 || iScriptClose < 0) {
  console.error('경계를 못 찾음'); process.exit(1);
}
const css = lines.slice(iStyleOpen + 1, iStyleClose).join('\n');
const js  = lines.slice(iScriptOpen + 1, iScriptClose).join('\n');
console.log('CSS ' + css.length + '자 · JS ' + js.length + '자 추출');

// layout() 안에서 style/script 블록을 링크로 교체
const head = lines.slice(0, iStyleOpen);
const between = lines.slice(iStyleClose + 1, iScriptOpen);   // </head> <body> ... 본문
const tail = lines.slice(iScriptClose + 1);

const newBody = [
  ...head,
  // CSS·공용 JS는 모든 페이지에서 완전히 동일하다. 인라인이면 게임을 오갈 때마다 44KB를
  // 다시 받고 다시 파싱하므로 외부 파일로 빼서 브라우저 캐시에 맡긴다(?v= 로 갱신).
  // JS를 <head>에 동기로 두는 이유: 게임 스크립트가 실행 시점에 window.casinoPoll을 쓴다.
  // 예전에 이 정의를 </body> 끝에 두었을 때 첫 폴링이 실패해 화면이 1초 늦게 떴다.
  '<link rel="stylesheet" href="/app.css?v=${ASSET_REV}">',
  '<script src="/app.js?v=${ASSET_REV}"></script>',
  ...between,
  ...tail,
].join('\n');

fs.writeFileSync(p, newBody);

// 추출한 내용을 별도 모듈로 저장 (템플릿 리터럴이 아니라 일반 문자열이므로 백틱·${} 를 이스케이프)
function toTemplate(s) { return s.replace(/\/g, '\\').replace(/`/g, '\`').replace(/\$\{/g, '\${'); }
fs.mkdirSync('src/web/assets', { recursive: true });
fs.writeFileSync('src/web/assets/app-css.ts',
  '// layout()에서 뽑아낸 전역 스타일시트. /app.css 로 서빙되며 브라우저가 캐시한다.\n' +
  '// 편집은 여기서 한다 (예전에는 views.ts 안에 인라인 <style>로 있었다).\n' +
  'export const APP_CSS = `' + toTemplate(css) + '`;\n');
fs.writeFileSync('src/web/assets/app-js.ts',
  '// layout()에서 뽑아낸 전역 스크립트(효과음 + 폴링 헬퍼). /app.js 로 서빙되며 브라우저가 캐시한다.\n' +
  '// <head>에서 동기로 불린다 — 게임 스크립트가 실행 시점에 window.casinoPoll을 필요로 한다.\n' +
  'export const APP_JS = `' + toTemplate(js) + '`;\n');
console.log('src/web/assets/app-css.ts, app-js.ts 생성');
