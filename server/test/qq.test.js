'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createQQ } = require('../src/providers/qq');

// qq.js 直接调全局 fetch：测试里替换 globalThis.fetch 模拟 HTTP 层
function mockResponse({ body = '', headers = {}, setCookies = [] } = {}) {
  const h = new Map(Object.entries(headers));
  return {
    headers: {
      get: (k) => h.get(String(k).toLowerCase()) ?? null,
      getSetCookie: () => setCookies,
    },
    arrayBuffer: async () => Buffer.from(body),
  };
}

function withFetch(handler, fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return handler(calls.length, String(url), opts);
  };
  return fn(calls).finally(() => { globalThis.fetch = original; });
}

const MUSICU_RESP = (data, code = 0) => ({
  body: JSON.stringify({ code, req_0: { code, data } }),
});

test('search 归一化：songmid/歌手拼接/时长毫秒/fee', async () => {
  await withFetch(async () => mockResponse({
    body: JSON.stringify({ code: 0, data: { song: { list: [
      { songmid: '001abc', songname: '七里香', singer: [{ name: '周杰伦' }], albumname: '七里香', interval: 250, pay: { payplay: 1 } },
    ] } } }),
  }), async (calls) => {
    const q = createQQ();
    const r = await q.search('七里香');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('client_search_cp'));
    assert.equal(r[0].song_id, '001abc');
    assert.equal(r[0].title, '七里香');
    assert.equal(r[0].artist, '周杰伦');
    assert.equal(r[0].album, '七里香');
    assert.equal(r[0].duration_ms, 250000);
    assert.equal(r[0].fee, 1);
  });
});

test('songUrl：vkey 返回 purl → sip 前缀拼接；104003 全阶梯 → error:vip', async () => {
  await withFetch(async (n, url, opts) => {
    if (url.includes('musicu.fcg')) {
      const body = JSON.parse(opts.body);
      const filename = body.req_0.param.filename[0];
      // 有 url 的响应：M800 即成功
      return mockResponse({ body: JSON.stringify({
        code: 0, req_0: { code: 0, data: { sip: ['https://ws.stream.qqmusic.qq.com/'], midurlinfo: [{ purl: 'M800abc.mp3', songmid: 'abc', result: 0 }] } },
      }) });
    }
    return mockResponse({ body: '{}' });
  }, async () => {
    const q = createQQ();
    assert.deepEqual(await q.songUrl('abc'), { url: 'https://ws.stream.qqmusic.qq.com/M800abc.mp3' });
  });

  await withFetch(async () => mockResponse({
    body: JSON.stringify({ code: 0, req_0: { code: 0, data: { sip: ['https://s/'], midurlinfo: [{ purl: '', songmid: 'abc', result: 104003 }] } } }),
  }), async () => {
    const q = createQQ();
    assert.deepEqual(await q.songUrl('abc'), { error: 'vip' });
  });
});

test('songUrl 登录后：请求带 Cookie 且 g_tk 按 musickey 计算，音质阶梯 M800→M500→C400', async () => {
  const ladder = [];
  await withFetch(async (n, url, opts) => {
    if (url.includes('musicu.fcg')) {
      const body = JSON.parse(opts.body);
      ladder.push(body.req_0.param.filename[0].slice(0, 4));
      assert.ok((opts.headers.Cookie || '').includes('qqmusic_key=MK'));
      assert.equal(body.comm.g_tk, 5862525); // hash33('MK', 5381)
      assert.equal(body.comm.uin, '123');
      return mockResponse({ body: JSON.stringify({ code: 0, req_0: { code: 0, data: { midurlinfo: [{ purl: '', result: 104003 }] } } }) });
    }
    return mockResponse({ body: '{}' });
  }, async () => {
    const q = createQQ({ credential: JSON.stringify({ musicid: 123, musickey: 'MK' }) });
    assert.deepEqual(await q.songUrl('abc'), { error: 'vip' });
    assert.deepEqual(ladder, ['M800', 'M500', 'C400']);
  });
});

test('lyric：base64 解码', async () => {
  const b64 = Buffer.from('[00:00.00]歌词', 'utf-8').toString('base64');
  await withFetch(async () => mockResponse({ body: JSON.stringify({ code: 0, lyric: b64 }) }), async () => {
    const q = createQQ();
    assert.equal(await q.lyric('abc'), '[00:00.00]歌词');
  });
});

test('qrKey/qrCreate：ptqrshow 取图 + qrsig cookie，qrCreate 返回 data URI', async () => {
  await withFetch(async (n, url) => {
    if (url.includes('ptqrshow')) {
      return mockResponse({ body: '\x89PNG-fake-image', setCookies: ['qrsig=QSIG1; path=/;'] });
    }
    return mockResponse({ body: '{}' });
  }, async (calls) => {
    const q = createQQ();
    const key = await q.qrKey();
    assert.equal(key, 'QSIG1');
    assert.equal(calls[0].opts.headers.Referer, 'https://xui.ptlogin2.qq.com/');
    const img = await q.qrCreate('QSIG1');
    assert.ok(img.startsWith('data:image/png;base64,'));
  });
});

test('qrCheck 状态映射：66→801 待扫码，67/68→802 已扫待确认，65→800 过期', async () => {
  const q = createQQ();
  await withFetch(async () => mockResponse({ body: "ptuiCB('66','0','','0','二维码未失效','')" }), async () => {
    assert.deepEqual(await q.qrCheck('K'), { code: 801 });
  });
  await withFetch(async () => mockResponse({ body: "ptuiCB('67','0','','0','二维码已确认','')" }), async () => {
    assert.deepEqual(await q.qrCheck('K'), { code: 802 });
  });
  await withFetch(async () => mockResponse({ body: "ptuiCB('68','0','','0','登录中','')" }), async () => {
    assert.deepEqual(await q.qrCheck('K'), { code: 802 });
  });
  await withFetch(async () => mockResponse({ body: "ptuiCB('65','0','','0','二维码已失效','')" }), async () => {
    assert.deepEqual(await q.qrCheck('K'), { code: 800 });
  });
});

test('qrCheck 成功链路：ptqrlogin→check_sig→authorize→QQLogin 换凭证 JSON', async () => {
  const target = "https://ssl.ptlogin2.graph.qq.com/check_sig?ptsigx=SIGX123&s_url=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump&uin=12345&service=ptqrlogin&pttype=1";
  await withFetch(async (n, url, opts) => {
    // 只匹配 ptqrlogin 端点本身；check_sig 的查询串里也有 service=ptqrlogin，不能误匹配
    if (url.includes('ssl.ptlogin2.qq.com/ptqrlogin')) return mockResponse({ body: `ptuiCB('0','0','${target}','0','登录成功！','QQ音乐')` });
    if (url.includes('check_sig')) return mockResponse({ body: 'ok', setCookies: ['p_skey=PSK; path=/;'] });
    if (url.includes('graph.qq.com/oauth2.0/authorize')) {
      return mockResponse({ headers: { location: 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=x&code=CODE9&state=state' } });
    }
    if (url.includes('musicu.fcg')) {
      const body = JSON.parse(opts.body);
      assert.equal(body.req_0.module, 'QQConnectLogin.LoginServer');
      assert.equal(body.req_0.method, 'QQLogin');
      return mockResponse({ body: JSON.stringify({ code: 0, req_0: { code: 0, data: { musicid: 123, musickey: 'MKKEY', openid: 'OP' } } }) });
    }
    return mockResponse({ body: '{}' });
  }, async (calls) => {
    const q = createQQ();
    const r = await q.qrCheck('QSIG1');
    assert.equal(r.code, 803);
    const cred = JSON.parse(r.cookie);
    assert.equal(cred.musickey, 'MKKEY');
    assert.equal(cred.musicid, 123);
  });
});

test('loginStatus：登录后返回昵称；凭证无效返回 null', async () => {
  await withFetch(async () => mockResponse({
    body: JSON.stringify({ code: 0, data: { userinfo: { usermsg: { nick: '绿钻用户', vipIconFlag: 1 } } } }),
  }), async () => {
    const q = createQQ({ credential: JSON.stringify({ musicid: 123, musickey: 'MK' }) });
    assert.deepEqual(await q.loginStatus(), { loggedIn: true, nickname: '绿钻用户', vipType: 1 });
  });
  // 手机 QQ 扫码登录的另一种响应形状：creator 里带昵称
  await withFetch(async () => mockResponse({
    body: JSON.stringify({ code: 0, data: { creator: { nick: 'QQ用户', uin: 123 } } }),
  }), async () => {
    const q = createQQ({ credential: JSON.stringify({ musicid: 123, musickey: 'MK' }) });
    assert.deepEqual(await q.loginStatus(), { loggedIn: true, nickname: 'QQ用户', vipType: 0 });
  });
  await withFetch(async () => mockResponse({ body: JSON.stringify({ code: 1000 }) }), async () => {
    const q = createQQ({ credential: JSON.stringify({ musicid: 123, musickey: 'MK' }) });
    assert.equal(await q.loginStatus(), null);
  });
  const q = createQQ();
  assert.equal(await q.loginStatus(), null);
});

test('toplists/toplistSongs/playlistSongs 归一化', async () => {
  await withFetch(async (n, url) => {
    // GetAll 走 musicu 的 GET data= 形式
    if (url.includes('musicu.fcg')) {
      return mockResponse({ body: JSON.stringify({ code: 0, req_0: { code: 0, data: { group: [{ groupName: '巅峰榜', toplist: [{ topId: 26, title: '热歌榜' }] }] } } }) });
    }
    if (url.includes('toplist_cp')) {
      return mockResponse({ body: JSON.stringify({ code: 0, songlist: [{ data: { songmid: 'm1', songname: '热歌', singer: [{ name: 'S' }], albumname: 'A', interval: 10 } }] }) });
    }
    return mockResponse({ body: JSON.stringify({ code: 0, cdlist: [{ songlist: [{ songmid: 'm2', songname: '歌单歌', singer: [], albumname: '', interval: 20 }] }] }) });
  }, async () => {
    const q = createQQ();
    assert.deepEqual(await q.toplists(), [{ id: '26', name: '热歌榜' }]);
    const s = await q.toplistSongs('26');
    assert.equal(s[0].song_id, 'm1');
    const p = await q.playlistSongs('9');
    assert.equal(p[0].song_id, 'm2');
    assert.equal(p[0].duration_ms, 20000);
  });
});

test('catlist 缓存分类名→id，stylePlaylists 按名查 id 请求', async () => {
  await withFetch(async (n, url, opts) => {
    if (url.includes('diss_tag_conf')) {
      return mockResponse({ body: JSON.stringify({ code: 0, data: { categories: [{ categoryGroupName: '语种', items: [{ categoryName: '流行', categoryId: 31 }] }] } }) });
    }
    if (url.includes('diss_by_tag')) {
      const u = new URL(url);
      assert.equal(u.searchParams.get('categoryId'), '31');
      return mockResponse({ body: JSON.stringify({ code: 0, data: { list: [{ dissid: '88', dissname: '流行精选', imgurl: 'img' }] } }) });
    }
    return mockResponse({ body: '{}' });
  }, async () => {
    const q = createQQ();
    assert.deepEqual(await q.catlist(), ['流行']);
    const ps = await q.stylePlaylists('流行');
    assert.equal(ps[0].id, '88');
    assert.equal(ps[0].cover, 'img');
  });
});
