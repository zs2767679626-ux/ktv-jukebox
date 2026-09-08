// LRC 歌词解析与当前行定位（纯函数）
export function parseLrc(text) {
  const lines = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue;
    const content = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!content) continue;
    for (const m of tags) {
      // 小数部分对齐到毫秒：常见 2 位百分秒格式右侧补 0 到 3 位（.50→.500=0.5s），3 位毫秒原样
      lines.push({ t: (+m[1]) * 60 + (+m[2]) + (+((m[3] || '0').padEnd(3, '0'))) / 1000, text: content });
    }
  }
  lines.sort((a, b) => a.t - b.t);
  return lines;
}

export function activeIndex(lines, t) {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= t) idx = i; else break;
  }
  return idx;
}
