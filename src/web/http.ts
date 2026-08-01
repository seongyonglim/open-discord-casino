// JSON 요청/응답 공용 헬퍼 (server.ts와 게임 API 핸들러가 공유)
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';

export function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

// ----- 응답 압축 -----
//
// 1초 폴링 게임이 3개라 응답 바이트가 그대로 fly 이그레스 요금이 된다.
// 프레임워크가 없으니 압축도 직접 한다. 측정값(포커 페이지 80,793B → 24,327B, 폴링 2,573B → 771B)
// 기준으로 전송량이 70% 줄어든다.
//
// 요청의 accept-encoding을 res에 기억시켜, 응답을 내보내는 모든 지점이 공유한다.
// (라우팅이 res만 넘기는 구조라 req를 전 함수에 다시 흘리지 않기 위한 선택)
// 이보다 작으면 gzip 헤더·트레일러(약 20B)가 이득을 먹는다.
// 폴링 응답(사다리 약 880B, 그래프 약 280B)이 임계값에 걸리므로 낮게 잡았다.
const GZIP_MIN = 400;

type TaggedRes = ServerResponse & { __gzip?: boolean };

export function markEncoding(req: IncomingMessage, res: ServerResponse): void {
  const ae = req.headers['accept-encoding'];
  (res as TaggedRes).__gzip = typeof ae === 'string' && ae.includes('gzip');
}

export function acceptsGzip(res: ServerResponse): boolean {
  return (res as TaggedRes).__gzip === true;
}

//   auto     — 클라이언트가 받아주고 크기가 충분하면 압축한다 (HTML·JSON)
//   gzip     — 이미 압축된 버퍼를 넘긴다 (자산 캐시에서 꺼낸 gzip본)
//   identity — 압축해도 이득이 없는 본문이니 손대지 말라 (mp3 등)
export type BodyEncoding = 'auto' | 'gzip' | 'identity';

export function sendBody(
  res: ServerResponse, status: number, mime: string,
  body: string | Buffer, extra: Record<string, string> = {}, encoding: BodyEncoding = 'auto',
): void {
  const headers: Record<string, string> = { 'content-type': mime, ...extra };
  let out = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  if (encoding === 'gzip') {
    headers['content-encoding'] = 'gzip';
    headers['vary'] = 'Accept-Encoding';
  } else if (encoding === 'auto' && out.length >= GZIP_MIN) {
    if (acceptsGzip(res)) {
      out = gzipSync(out, { level: 6 });
      headers['content-encoding'] = 'gzip';
    }
    // 압축을 못 받는 클라이언트에도 캐시가 인코딩별로 갈리도록 알려준다
    headers['vary'] = 'Accept-Encoding';
  }
  headers['content-length'] = String(out.length);
  res.writeHead(status, headers);
  res.end(out);
}

export function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  sendBody(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));
}
