"""播放控制抽象：VirtualPlayer（无 libmpv，联调用）与 MpvPlayer（Task 14 实现）。

注意：本文件不叫 mpv.py —— 那样会与第三方 python-mpv 包同名，
MpvPlayer 内部的 `import mpv` 会导入到本模块自己。
"""
import asyncio
import logging
import time

log = logging.getLogger('player.playback')


class BasePlayer:
    async def play(self, url, volume, muted):
        raise NotImplementedError

    async def pause(self):
        raise NotImplementedError

    async def resume(self):
        raise NotImplementedError

    async def stop(self):
        raise NotImplementedError

    async def set_volume(self, v):
        raise NotImplementedError

    async def set_mute(self, m):
        raise NotImplementedError

    async def wait_event(self, timeout=0.5):
        """返回 'finished' | 'error' | None（超时）。"""
        raise NotImplementedError

    def audio_device(self):
        """当前音频设备名（蓝牙掉线检测用；不支持/虚拟实现返回 None）。"""
        return None

    async def close(self):
        pass


class VirtualPlayer(BasePlayer):
    """虚拟播放器：不出声，按设定时长假装播完，便于本地联调队列流转。"""

    def __init__(self, duration=10.0):
        self.duration = duration
        self.volume = 60
        self.muted = False
        self._end_at = None

    async def play(self, url, volume, muted):
        log.info('[virtual] play %s volume=%s muted=%s', url, volume, muted)
        self.volume = int(volume)
        self.muted = bool(muted)
        self._end_at = time.time() + self.duration

    async def pause(self):
        log.info('[virtual] pause')

    async def resume(self):
        log.info('[virtual] resume')

    async def stop(self):
        log.info('[virtual] stop')
        self._end_at = None

    async def set_volume(self, v):
        log.info('[virtual] volume=%s', v)
        self.volume = int(v)

    async def set_mute(self, m):
        log.info('[virtual] mute=%s', m)
        self.muted = bool(m)

    async def wait_event(self, timeout=0.5):
        await asyncio.sleep(timeout)
        if self._end_at is not None and time.time() >= self._end_at:
            self._end_at = None
            return 'finished'
        return None
