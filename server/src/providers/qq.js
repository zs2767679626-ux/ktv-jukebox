'use strict';
const { randomUUID } = require('node:crypto');

// QQ 音乐适配器。直接对接 y.qq.com 系列公开接口，登录流程移植自
// Suxiaoqinx/QQMusicapi（open source，WEB 平台路径，无需安卓设备指纹/签名）。
// 登录态为 QQ 音乐凭证 JSON（musicid + musickey + openid 等），持久化在 settings.qq_cookie。
// 注意：songUrl 对 VIP/无权限歌返回 error:'vip'，调用方（queue）据此跳过。

const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://y.qq.com/';
const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
// 无登录 g_tk 默认值（登录后按 musickey 计算）
const DEFAULT_GTK = 5381;

function hash33(s, h = 0) {
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 2147483647 & h;
}

function parseSetCookies(headers) {
  const out = {};
  const list =
    typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  for (const c of list) {
    const first = c.split(';')[0];
    const idx = first.indexOf('=');
    if (idx <= 0) continue;
    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (!value) continue; // 跳过 "name=;Expires=1970" 式的删除指令
    out[name] = value;
  }
  return out;
}

function createQQ({ credential: initialCredential = '' } = {}) {
  let cookie = String(initialCredential || '');
  // 扫码过程中的二维码图缓存：qrsig → PNG Buffer（qrKey 拉图，qrCreate 取图）
  const qrStore = new Map();
  // vkey 请求的 guid：10 位数字（空 guid 会 guid-error 取不到 purl）
  const GUID = String(Math.floor(1e9 + Math.random() * 9e9));

  // —— 凭证解析：cookie 存的是 QQ 音乐凭证 JSON 字符串 ——
  function cred() {
    if (!cookie) return null;
    try {
      const c = JSON.parse(cookie);
      return {
        musicid: c.musicid ?? c.musicId ?? 0,
        musickey: c.musickey ?? c.musickeyStr ?? '',
      };
    } catch {
      return null;
    }
  }

  function cookieHeader(c) {
    if (!c || !c.musicid || !c.musickey) return '';
    const uin = String(c.musicid);
    return `uin=${uin}; qqmusic_uin=${uin}; qqmusic_key=${c.musickey}; qm_keyst=${c.musickey}`;
  }

  // —— HTTP 封装（Node 内置 fetch；redirect 手动处理以捕获 302 的 Location）——
  async function http(url, opts = {}) {
    const u = new URL(url);
    if (opts.params) {
      for (const [k, v] of Object.entries(opts.params)) {
        if (v === undefined || v === null) continue;
        u.searchParams.set(k, String(v));
      }
    }
    const headers = { 'User-Agent': WEB_UA, Referer: REFERER, ...(opts.headers || {}) };
    const res = await fetch(u, {
      method: opts.method || 'GET',
      headers,
      body: opts.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      headers: res.headers,
      cookies: parseSetCookies(res.headers),
      buf,
      text: buf.toString('utf-8'),
    };
  }

  // —— 内部 musicu.fcg 请求（WEB 平台 comm，无需签名）——
  async function musicu(module, method, param, opts = {}) {
    const c = opts.credential ?? cred();
    const gTk = c && c.musickey ? hash33(c.musickey, 5381) : DEFAULT_GTK;
    const comm = {
      ct: 24,
      cv: 4747474,
      platform: 'yqq.json',
      chid: '0',
      uin: c && c.musickey ? String(c.musicid) : undefined,
      g_tk: gTk,
      g_tk_new_20200303: gTk,
      format: 'json',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      notice: 0,
      need_new_code: 1,
      ...(opts.comm || {}),
    };
    for (const k of Object.keys(comm)) if (comm[k] === undefined) delete comm[k];
    const payload = { comm, req_0: { module, method, param } };
    const headers = { 'Content-Type': 'application/json' };
    const cookieStr = c ? cookieHeader(c) : '';
    if (cookieStr) headers.Cookie = cookieStr;
    const res = await http(MUSICU_URL, {
      method: 'POST', headers, body: JSON.stringify(payload),
    });
    let json;
    try {
      json = JSON.parse(res.text);
    } catch {
      throw new Error('QQ 接口响应不是有效 JSON');
    }
    const item = json?.req_0 ?? {};
    if ((item.code ?? 0) !== 0) throw new Error(`QQ 接口错误 ${item.code}`);
    return item.data ?? {};
  }

  // musicu 的旧版 GET 形式（data=JSON 查询参数，comm {ct:24, cv:0}）：
  // ToplistInfoServer 系列只认这种形式，POST 新版 comm 会报 500005
  async function musicuGet(module, method, param) {
    const payload = { req_0: { module, method, param }, comm: { ct: 24, cv: 0 } };
    const res = await http(MUSICU_URL, {
      params: {
        g_tk: DEFAULT_GTK, loginUin: '0', hostUin: '0', format: 'json',
        inCharset: 'utf-8', outCharset: 'utf-8', notice: 0, platform: 'yqq.json',
        needNewCode: 0, data: JSON.stringify(payload),
      },
    });
    const json = JSON.parse(res.text);
    const item = json?.req_0 ?? {};
    if ((item.code ?? 0) !== 0) throw new Error(`QQ 接口错误 ${item.code}`);
    return item.data ?? {};
  }

  // —— 歌曲字段归一化（与 netease 对齐：song_id/title/artist/album/duration_ms/fee）——
  // 兼容两种结构：搜索/榜单的平铺字段（albumname、pay.payplay），
  // 歌手歌单的嵌套字段（album.name、pay.pay_play）
  function normalize(s) {
    return {
      song_id: String(s.songmid || s.mid || s.song_id || ''),
      title: s.songname || s.name || s.title || '',
      artist: (s.singer || []).map((a) => a.name).join('/'),
      album: s.albumname || (s.album && s.album.name) || '',
      duration_ms: (s.interval || 0) * 1000,
      fee: s.pay ? (s.pay.payplay ?? s.pay.pay_play ?? 0) : 0,
    };
  }

  async function search(q, limit = 30) {
    const res = await http('https://c.y.qq.com/soso/fcgi-bin/client_search_cp', {
      params: {
        w: q, format: 'json', p: 1, n: limit, zhidaqu: 1, t: 0, flag: 1,
        ie: 'utf-8', oe: 'utf-8', aggr: 1, perpage: limit, catZhida: 1,
      },
    });
    const data = JSON.parse(res.text);
    return (data?.data?.song?.list || []).map(normalize);
  }

  // 音质阶梯：登录后优先 320k，未登录直接试 320k（免费歌也给 M500），失败降 128k m4a
  function qualityLadder(c) {
    return c && c.musickey ? ['M800', 'M500', 'C400'] : ['M500', 'C400'];
  }

  function extOf(q) {
    return q === 'C400' || q === 'C600' ? '.m4a' : '.mp3';
  }

  async function songUrl(id) {
    const c = cred();
    let sawVip = false;
    for (const q of qualityLadder(c)) {
      const data = await musicu('music.vkey.GetVkey', 'UrlGetVkey', {
        guid: GUID,
        songmid: [id],
        songtype: [0],
        filename: [`${q}${id}${id}${extOf(q)}`],
        uin: String(c?.musicid ?? ''),
        loginflag: 1,
        platform: '23',
        h5queryversion: 1,
        nettype: '',
        jsonpCallback: 'jsonp1',
        cms: 0,
        firstlogin: 1,
        newver: 1,
        nohash: 0,
        format: 'json',
        inCharset: 'utf-8',
        outCharset: 'utf-8',
        notice: 0,
        needNewCode: 0,
        songmid_pre: '',
        soundname: '',
        bitrate: 0,
        quality: q,
      });
      const info = (data?.midurlinfo || []).find((i) => i.purl) || (data?.midurlinfo || [])[0];
      if (info?.purl) {
        const sip = Array.isArray(data.sip) && data.sip.length ? data.sip : null;
        const purl = info.purl;
        const url = /^https?:\/\//i.test(purl)
          ? purl
          : (sip ? sip[Math.floor(Math.random() * sip.length)] : 'https://isure.stream.qqmusic.qq.com/') + purl;
        return { url };
      }
      if (info?.result === 104003) sawVip = true;
    }
    return { error: sawVip ? 'vip' : 'unavailable' };
  }

  async function lyric(id) {
    const res = await http('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg', {
      params: { songmid: id, format: 'json', nobase64: 0, g_tk: DEFAULT_GTK, platform: 'yqq.json' },
    });
    const data = JSON.parse(res.text);
    if (!data?.lyric) return null;
    return Buffer.from(data.lyric, 'base64').toString('utf-8');
  }

  async function toplists() {
    // GetAll：group[] → toplist[]（巅峰榜/地区榜/特色榜等分组拍平）
    const data = await musicuGet('musicToplist.ToplistInfoServer', 'GetAll', {});
    const out = [];
    for (const g of data?.group || []) {
      for (const t of g?.toplist || []) {
        if (t.topId != null) out.push({ id: String(t.topId), name: t.title || '' });
      }
    }
    return out;
  }

  async function toplistSongs(id) {
    const res = await http('https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg', {
      params: { topid: id, needNewCode: 1, uin: 0, tpl: 3, page: 'detail', type: 'top', format: 'json', platform: 'h5' },
    });
    const data = JSON.parse(res.text);
    return (data?.songlist || []).map((s) => normalize(s.data || s));
  }

  // 歌单分类名 → 分类 id 的缓存（catlist 拉取时填充）
  let catMap = null;

  async function catlist() {
    const res = await http('https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg', {
      params: { format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', platform: 'yqq.json', g_tk: DEFAULT_GTK, hostUin: 0, needNewCode: 0, notice: 0 },
    });
    const data = JSON.parse(res.text);
    catMap = {};
    for (const grp of data?.data?.categories || []) {
      for (const item of grp?.items || []) {
        const name = item.categoryName ?? item.itemName ?? item.name ?? '';
        const id = item.categoryId ?? item.itemId ?? item.id ?? '';
        if (name && id != null) catMap[name] = id;
      }
    }
    return Object.keys(catMap);
  }

  async function stylePlaylists(cat, limit = 30) {
    if (!catMap) await catlist();
    const id = catMap?.[cat];
    if (id == null) return [];
    // sortId=2（最新）：返回的 dissid 区间可用 qzone 接口取到歌单；
    // sortId 1/3/4 常返回新版 dissid，qzone 取不到（空歌单）
    const res = await http('https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg', {
      params: { categoryId: id, sortId: 2, sin: 0, ein: limit - 1, format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', platform: 'yqq.json', g_tk: DEFAULT_GTK, hostUin: 0, needNewCode: 0, notice: 0 },
    });
    const data = JSON.parse(res.text);
    return (data?.data?.list || []).map((p) => ({
      id: String(p.dissid ?? p.id ?? ''),
      name: p.dissname || p.name || '',
      cover: p.imgurl || p.cover || '',
    }));
  }

  async function playlistSongs(id) {
    const res = await http('https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg', {
      params: { type: 1, json: 1, utf8: 1, onlysong: 0, disstid: id, loginUin: 0, format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', platform: 'yqq.json', g_tk: DEFAULT_GTK, hostUin: 0, needNewCode: 0, notice: 0 },
      headers: { Referer: 'https://y.qq.com/n/yqq/playlist' },
    });
    const data = JSON.parse(res.text);
    const cd = data?.cdlist?.[0] || {};
    return (cd.songlist || []).map(normalize);
  }

  async function artists(type, initial) {
    // QQ 歌手列表无性别/组合分类：统一返回歌手列表，initial 为首字母（A-Z）
    const key = initial ? `all_all_${initial}` : 'all_all_all';
    const res = await http('https://c.y.qq.com/v8/fcg-bin/v8.fcg', {
      params: { channel: 'singer', page: 'list', key, pagesize: 60, pagenum: 1, format: 'json', platform: 'yqq.json', g_tk: DEFAULT_GTK, hostUin: 0, needNewCode: 0, notice: 0, inCharset: 'utf-8', outCharset: 'utf-8' },
    });
    const data = JSON.parse(res.text);
    return (data?.data?.list || []).map((a) => ({
      id: a.Fsinger_mid,
      name: a.Fsinger_name,
      pic: a.Fsinger_mid ? `https://y.gtimg.cn/music/photo_new/T001R150x150M000${a.Fsinger_mid}.jpg` : '',
    }));
  }

  async function artistSongs(id) {
    // 歌手页接口已下线，改用音乐馆歌曲列表（songInfo 嵌套结构）
    const data = await musicu('musichall.song_list_server', 'GetSingerSongList', {
      begin: 0, num: 50, order: 1, singerMid: id,
    });
    return (data?.songList || []).map((it) => normalize(it.songInfo || it));
  }

  // —— 登录态：QQ 扫码登录（ptlogin2 三步）+ 状态查询 ——
  // qrKey 返回 qrsig（同时拉取二维码图缓存）；qrCreate 返回 data URI；qrCheck 轮询。
  async function qrKey() {
    const res = await http('https://ssl.ptlogin2.qq.com/ptqrshow', {
      params: {
        appid: '716027609', e: '2', l: 'M', s: '3', d: '72', v: '4',
        t: String(Math.random()), daid: '383', pt_3rd_aid: '100497308',
      },
      headers: { Referer: 'https://xui.ptlogin2.qq.com/' },
    });
    const qrsig = res.cookies.qrsig;
    if (!qrsig) throw new Error('获取 qrsig 失败');
    qrStore.set(qrsig, res.buf);
    return qrsig;
  }

  async function qrCreate(key) {
    const png = qrStore.get(key);
    if (!png) throw new Error('二维码不存在或已过期');
    return 'data:image/png;base64,' + png.toString('base64');
  }

  // 返回 { code, cookie? }：801 待扫码，802 已扫码待确认/已确认登录中，803 成功（带凭证 JSON），800 过期
  async function qrCheck(key) {
    const res = await http('https://ssl.ptlogin2.qq.com/ptqrlogin', {
      params: {
        u1: 'https://graph.qq.com/oauth2.0/login_jump',
        ptqrtoken: String(hash33(key)),
        ptredirect: '0', h: '1', t: '1', g: '1', from_ui: '1', ptlang: '2052',
        action: `0-0-${Date.now()}`, js_ver: '20102616', js_type: '1', pt_uistyle: '40',
        aid: '716027609', daid: '383', pt_3rd_aid: '100497308', has_onekey: '1',
      },
      headers: { Referer: 'https://xui.ptlogin2.qq.com/', Cookie: `qrsig=${key}` },
    });
    const match = /ptuiCB\((.*?)\)/.exec(res.text);
    if (!match) return { code: -1 };
    const args = [];
    let m;
    const argRe = /'((?:\\.|[^'])*)'/g;
    while ((m = argRe.exec(match[1]))) args.push(m[1]);
    const code = parseInt(args[0] || '', 10);
    if (Number.isNaN(code)) return { code: -1 };
    if (code === 65) {
      qrStore.delete(key);
      return { code: 800 };
    }
    // 66=二维码未失效（等待扫码），67=已扫码待确认，68=已确认登录中
    if (code === 66) return { code: 801 };
    if (code === 67 || code === 68) return { code: 802 };
    if (code !== 0) return { code: -1 };
    // 登录成功：args[2] 是带回调的 URL，含 ptsigx 与 uin
    const target = args[2] || '';
    const sigx = /[?&]ptsigx=(.+?)&s_url/.exec(target)?.[1];
    const uin = /[?&]uin=(.+?)&service/.exec(target)?.[1];
    if (!sigx || !uin) throw new Error('解析 ptsigx/uin 失败');
    const credJson = await authorizeQQQr(uin, sigx);
    qrStore.delete(key);
    return { code: 803, cookie: credJson };
  }

  // 扫码成功后三步换凭证：check_sig 取 p_skey → oauth authorize 换 code → QQLogin 换 QQ 音乐凭证
  async function authorizeQQQr(uin, sigx) {
    const ck = await http('https://ssl.ptlogin2.graph.qq.com/check_sig', {
      params: {
        uin, pttype: '1', service: 'ptqrlogin', nodirect: '0', ptsigx: sigx,
        s_url: 'https://graph.qq.com/oauth2.0/login_jump', ptlang: '2052', ptredirect: '100',
        aid: '716027609', daid: '383', j_later: '0', low_login_hour: '0', regmaster: '0',
        pt_login_type: '3', pt_aid: '0', pt_aaid: '16', pt_light: '0', pt_3rd_aid: '100497308',
      },
      headers: { Referer: 'https://xui.ptlogin2.qq.com/' },
    });
    const pSkey = ck.cookies.p_skey ?? ck.cookies['p-skey'] ?? ck.cookies.pskey ?? ck.cookies.skey;
    if (!pSkey) throw new Error('获取 p_skey 失败');

    const body = new URLSearchParams({
      response_type: 'code',
      client_id: '100497308',
      redirect_uri: 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/',
      scope: 'get_user_info,get_app_friends',
      state: 'state', switch: '', from_ptlogin: '1', src: '1', update_auth: '1',
      openapi: '1010_1030',
      g_tk: String(hash33(pSkey, 5381)),
      auth_time: String(Date.now()),
      ui: randomUUID(),
    }).toString();
    const cookieStr = Object.entries(ck.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const auth = await http('https://graph.qq.com/oauth2.0/authorize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: 'https://xui.ptlogin2.qq.com/',
        Cookie: cookieStr,
      },
      body,
    });
    const location = auth.headers.get('location') || '';
    const code = /code=(.+?)(?=&)/.exec(location)?.[1];
    if (!code) throw new Error('获取授权 code 失败');

    const data = await musicu('QQConnectLogin.LoginServer', 'QQLogin', { code }, { comm: { tmeLoginType: 2 } });
    if (!data?.musickey || !data?.musicid) throw new Error('QQ 音乐凭证缺失');
    return JSON.stringify(data);
  }

  function setCookie(c) {
    cookie = String(c || '');
  }

  function clearCookie() {
    cookie = '';
  }

  // 当前登录态：null = 未登录；否则 { loggedIn, nickname, vipType }
  async function loginStatus() {
    const c = cred();
    if (!c || !c.musicid || !c.musickey) return null;
    try {
      const res = await http('https://c6.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg', {
        params: {
          g_tk: hash33(c.musickey, 5381),
          format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', notice: 0,
          cid: 205360838, needNewCode: 0,
          loginUin: c.musicid, hostUin: 0, userid: c.musicid, reqfrom: 1,
        },
        headers: { Cookie: cookieHeader(c) },
      });
      const data = JSON.parse(res.text);
      if (data?.code !== 0) return null;
      const u = data?.data?.userinfo?.usermsg || {};
      const nickname = u.nick || u.nickname || '';
      // 绿钻标识字段以实测为准，这里防御性取 vipIconFlag
      const vipType = u.vipIconFlag ? 1 : 0;
      return { loggedIn: true, nickname, vipType };
    } catch (e) {
      return null;
    }
  }

  return {
    search, songUrl, lyric, artists, artistSongs, toplists, toplistSongs,
    catlist, stylePlaylists, playlistSongs,
    qrKey, qrCreate, qrCheck, setCookie, clearCookie, loginStatus,
  };
}

module.exports = { createQQ };
