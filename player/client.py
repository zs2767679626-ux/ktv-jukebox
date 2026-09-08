"""WebSocket 客户端：连接云端、上报事件、执行播放指令、断线自动重连。"""
import asyncio
import json
import logging

log = logging.getLogger('player.client')


def make_player(cfg):
    if cfg.get('virtual'):
        from playback import VirtualPlayer
        return VirtualPlayer(duration=float(cfg.get('virtual_duration', 10)))
    from playback import MpvPlayer
    return MpvPlayer(cfg.get('libmpv') or None)


async def run(cfg):
    player = make_player(cfg)
    try:
        while True:
            try:
                await session(cfg, player)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning('会话异常，5 秒后重连：%s', e)
                await asyncio.sleep(5)
    finally:
        await player.close()


async def session(cfg, player):
    import websockets
    async with websockets.connect(cfg['server'], ping_interval=20, ping_timeout=20, open_timeout=15) as ws:
        await ws.send(json.dumps({'type': 'player_hello', 'token': cfg['token']}))
        log.info('已连接云端并完成 hello')
        cmdq = asyncio.Queue()
        recv = asyncio.create_task(receiver(ws, cmdq))
        try:
            await control_loop(ws, cmdq, player)
        finally:
            recv.cancel()


async def receiver(ws, cmdq):
    async for raw in ws:
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        if msg.get('type') == 'player_cmd':
            await cmdq.put(msg.get('cmd') or {})


async def control_loop(ws, cmdq, player):
    while True:
        cmd = await cmdq.get()
        if cmd.get('action') == 'play':
            song = cmd.get('song') or {}
            await player.play(cmd.get('url'), cmd.get('volume', 60), cmd.get('muted', False))
            await ws.send(json.dumps({'type': 'player_event', 'event': 'started'}))
            log.info('开始播放：%s', song.get('title') or cmd.get('url'))
            await play_session(ws, cmdq, player)
        else:
            await apply_cmd(player, cmd)


async def play_session(ws, cmdq, player):
    """播放期间：每 0.2s 探测结束/错误事件，同时处理 pause/volume/mute/stop 指令。"""
    dev_at_start = player.audio_device()
    ticks = 0
    while True:
        ev = await player.wait_event(timeout=0.2)
        if ev == 'finished':
            log.info('播放完成')
            await ws.send(json.dumps({'type': 'player_event', 'event': 'finished'}))
            return
        if ev == 'error':
            log.warning('播放出错（加载失败或地址失效）')
            await ws.send(json.dumps({'type': 'player_event', 'event': 'error', 'detail': {'reason': '加载失败'}}))
            return
        ticks += 1
        if ticks % 10 == 0:  # 每 2 秒检测一次音频设备变化（蓝牙音箱掉线）
            cur = player.audio_device()
            if dev_at_start and cur and cur != dev_at_start:
                log.warning('音频设备变化（可能蓝牙音箱掉线）：%s → %s', dev_at_start, cur)
                await player.stop()
                await ws.send(json.dumps({'type': 'player_event', 'event': 'error', 'detail': {'reason': '音频设备掉线'}}))
                return
        while not cmdq.empty():
            cmd = cmdq.get_nowait()
            if cmd.get('action') == 'stop':
                await player.stop()
                return
            await apply_cmd(player, cmd)


async def apply_cmd(player, cmd):
    action = cmd.get('action')
    if action == 'pause':
        await player.pause()
    elif action == 'resume':
        await player.resume()
    elif action == 'volume':
        await player.set_volume(int(cmd.get('value', 60)))
    elif action == 'mute':
        await player.set_mute(bool(cmd.get('value')))
    elif action == 'stop':
        await player.stop()
    # 未知指令忽略
