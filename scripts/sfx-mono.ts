// 효과음 wav를 스테레오 → 모노로 변환한다 (npm run sfx:mono).
//
// UI 효과음은 짧고 화면 중앙에서 한 번 울리는 소리라 스테레오 정보가 사실상 쓰이지 않는데,
// 파일 크기와 브라우저가 디코딩할 메모리는 정확히 두 배가 된다.
// (44.1kHz 16bit 스테레오 2.5초 = 430KB → 모노 215KB)
//
// 샘플레이트는 건드리지 않는다. 22.05kHz로 내리면 11kHz 위가 잘려서
// 동전·카드 소리의 금속성 고역이 뭉개진다 — 크기보다 그 특성이 중요하다.
//
// 이미 모노인 파일은 건너뛰므로 여러 번 실행해도 안전하다.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, '..', 'public', 'sfx');

interface Chunks { fmtOffset: number; dataOffset: number; dataLength: number }

function findChunks(b: Buffer): Chunks {
  let off = 12, fmtOffset = -1, dataOffset = -1, dataLength = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmtOffset = off + 8;
    if (id === 'data') { dataOffset = off + 8; dataLength = size; }
    off += 8 + size + (size % 2);
  }
  if (fmtOffset < 0 || dataOffset < 0) throw new Error('fmt/data 청크를 찾을 수 없음');
  return { fmtOffset, dataOffset, dataLength };
}

let changed = 0, skipped = 0, before = 0, after = 0;

for (const name of readdirSync(DIR).filter(f => f.endsWith('.wav'))) {
  const path = join(DIR, name);
  const b = readFileSync(path);
  const { fmtOffset, dataOffset, dataLength } = findChunks(b);
  const channels = b.readUInt16LE(fmtOffset + 2);
  const rate = b.readUInt32LE(fmtOffset + 4);
  const bits = b.readUInt16LE(fmtOffset + 14);

  before += b.length;
  if (channels === 1) {
    console.log(`  건너뜀  ${name} (이미 모노)`);
    after += b.length; skipped++;
    continue;
  }
  if (channels !== 2 || bits !== 16) {
    console.log(`  건너뜀  ${name} (${channels}채널 ${bits}bit — 이 스크립트는 16bit 스테레오만 다룬다)`);
    after += b.length; skipped++;
    continue;
  }

  // 좌우를 평균해 한 채널로 합친다 (단순 합은 클리핑되므로 반드시 평균)
  const frames = Math.floor(dataLength / 4);
  const mono = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const l = b.readInt16LE(dataOffset + i * 4);
    const r = b.readInt16LE(dataOffset + i * 4 + 2);
    mono.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((l + r) / 2))), i * 2);
  }

  // 헤더를 새로 쓴다 (청크 순서를 보존하지 않고 표준 44바이트 헤더로 정규화)
  const out = Buffer.alloc(44 + mono.length);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + mono.length, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);          // fmt 청크 크기
  out.writeUInt16LE(1, 20);           // PCM
  out.writeUInt16LE(1, 22);           // 채널 1
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);    // 초당 바이트 = rate × 채널 × 2
  out.writeUInt16LE(2, 32);           // 프레임당 바이트
  out.writeUInt16LE(16, 34);          // 비트
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(mono.length, 40);
  mono.copy(out, 44);

  writeFileSync(path, out);
  console.log(`  변환    ${name}  ${(b.length / 1024).toFixed(0)}KB → ${(out.length / 1024).toFixed(0)}KB`
    + `  (${rate}Hz ${(frames / rate).toFixed(2)}초 유지)`);
  after += out.length;
  changed++;
}

console.log(`\n변환 ${changed}개 · 건너뜀 ${skipped}개`);
console.log(`합계 ${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB`
  + ` (${Math.round((1 - after / before) * 100)}% 감소)`);
