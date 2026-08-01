import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

// 로컬 DB 스냅샷을 읽어 표 형태로 보여주는 읽기 전용 뷰어
const DB_FILE = process.env.SNAPSHOT ?? 'data-snapshot.db';
const PORT = Number(process.env.PORT ?? 4000);

const db = new DatabaseSync(path.resolve(DB_FILE));

function tableNames(): string[] {
  const rows = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).all() as { name: string }[];
  return rows.map(r => r.name);
}

function esc(v: unknown): string {
  if (v === null || v === undefined) return '<span class="null">NULL</span>';
  return String(v).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}

function renderTable(name: string): string {
  const count = (db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get() as { c: number }).c;
  const rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid DESC LIMIT 500`).all() as Record<string, unknown>[];
  if (rows.length === 0) {
    return `<h2 id="${name}">${name} <span class="cnt">(0)</span></h2><p class="empty">비어있음</p>`;
  }
  const cols = Object.keys(rows[0]);
  const head = cols.map(c => `<th>${esc(c)}</th>`).join('');
  const body = rows.map(r => `<tr>${cols.map(c => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('');
  const more = count > rows.length ? `<p class="more">… ${count}개 중 최신 ${rows.length}개 표시</p>` : '';
  return `<h2 id="${name}">${name} <span class="cnt">(${count})</span></h2>
    <div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${more}`;
}

const STYLE = `
  body{font-family:system-ui,Segoe UI,sans-serif;margin:0;background:#0a0e14;color:#e6e9ef}
  header{position:sticky;top:0;background:#141a24;padding:12px 20px;border-bottom:1px solid #26303f}
  header a{color:#c8aa6e;margin-right:14px;text-decoration:none;font-size:14px}
  main{padding:20px}
  h2{margin:28px 0 8px;font-size:16px;border-left:3px solid #c8aa6e;padding-left:8px}
  .cnt{color:#8b96a8;font-weight:normal;font-size:13px}
  .scroll{overflow-x:auto;border:1px solid #26303f;border-radius:6px}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th,td{border:1px solid #26303f;padding:5px 9px;text-align:left;white-space:nowrap}
  th{background:#1b2330;position:sticky;top:0}
  tr:nth-child(even){background:#141a24}
  .null{color:#8b96a8;font-style:italic}
  .empty{color:#8b96a8;font-size:13px}
  .more{color:#8b96a8;font-size:12px;margin:6px 0 0}
`;

const server = createServer((req, res) => {
  try {
    const names = tableNames();
    const nav = names.map(n => `<a href="#${n}">${n}</a>`).join('');
    const sections = names.map(renderTable).join('');
    const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
      <title>카지노 DB</title><style>${STYLE}</style></head>
      <body><header><b>카지노 DB</b>　${nav}</header><main>${sections}</main></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('오류: ' + (e as Error).message);
  }
});

server.listen(PORT, () => {
  console.log(`DB 뷰어: http://localhost:${PORT}  (DB: ${DB_FILE})`);
});
