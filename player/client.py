"""WebSocket 客户端：连接云端、上报事件、执行播放指令、断线自动重连。"""
import asyncio
import json
import logging
import os
import sys

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
            delay = 3
            try:
                await session(cfg, player)
            except asyncio.CancelledError:
                raise
            except SystemExit:
                raise  # 被新播放端顶替：直接退出进程，不再重连
            except Exception as e:
                log.warning('会话异常，5 秒后重连：%s', e)
                delay = 5
            # 会话结束（含被服务端正常关闭）也稍等再重连，避免与服务端对轰空转
            await asyncio.sleep(delay)
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
            try:
                await recv
            except asyncio.CancelledError:
                pass


async def receiver(ws, cmdq):
    """收帧并放入指令队列；连接断开（正常结束或异常）时放入 None 哨兵唤醒消费端。"""
    sent = False
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if msg.get('type') == 'player_replaced':
                log.info('被新播放端顶替，本端退出')
                # 立即退出进程，不等 asyncio 任务栈收尾（避免 SystemExit 走任务栈留噪音日志）
                os._exit(0)
            if msg.get('type') == 'player_cmd':
                await cmdq.put(msg.get('cmd') or {})
    finally:
        if not sent:
            sent = True
            cmdq.put_nowait(None)


async def control_loop(ws, cmdq, player):
    while True:
        cmd = await cmdq.get()
        if cmd is None:  # 连接断开哨兵：退出会话，交由 run() 5 秒后重连
            return
        if cmd.get('action') == 'play':
            song = cmd.get('song') or {}
            await player.play(cmd.get('url'), cmd.get('volume', 60), cmd.get('muted', False))
            await ws.send(json.dumps({'type': 'player_event', 'event': 'started'}))
            log.info('开始播放：%s', song.get('title') or cmd.get('url'))
            if await play_session(ws, cmdq, player) == 'disconnected':
                return
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
            return None
        if ev == 'error':
            log.warning('播放出错（加载失败或地址失效）')
            await ws.send(json.dumps({'type': 'player_event', 'event': 'error', 'detail': {'reason': '加载失败'}}))
            return None
        ticks += 1
        if ticks % 10 == 0:  # 每 2 秒检测一次音频设备变化（蓝牙音箱掉线）
            cur = player.audio_device()
            if dev_at_start and cur and cur != dev_at_start:
                log.warning('音频设备变化（可能蓝牙音箱掉线）：%s → %s', dev_at_start, cur)
                await player.stop()
                await ws.send(json.dumps({'type': 'player_event', 'event': 'error', 'detail': {'reason': '音频设备掉线'}}))
                return None
        while not cmdq.empty():
            cmd = cmdq.get_nowait()
            if cmd is None:  # 连接断开哨兵：停播并退出，控制环随后退出会话
                await player.stop()
                return 'disconnected'
            if cmd.get('action') == 'stop':
                await player.stop()
                return None
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
