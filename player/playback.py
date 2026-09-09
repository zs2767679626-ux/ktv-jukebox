"""播放控制抽象：VirtualPlayer（无 libmpv，联调用）与 MpvPlayer（Task 14 实现）。

注意：本文件不叫 mpv.py —— 那样会与第三方 python-mpv 包同名，
MpvPlayer 内部的 `import mpv` 会导入到本模块自己。
"""
import asyncio
import logging
import os
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


class MpvPlayer(BasePlayer):
    """基于 python-mpv 的真实播放器。libmpv 需已安装（README/setup 脚本有步骤）。"""

    def __init__(self, libmpv=None):
        # python-mpv 在 import 阶段就按 PATH 找 DLL；把 DLL 所在目录加进 PATH 即可。
        # 注意：不要给 MPV 构造器传 libmpv 参数——python-mpv 会把未知 kwarg 当 mpv 选项，
        # 直接报 "mpv option does not exist"。
        if libmpv:
            dll_dir = os.path.dirname(os.path.abspath(libmpv))
            os.environ['PATH'] = dll_dir + os.pathsep + os.environ.get('PATH', '')
        import mpv
        try:
            kwargs = {'ytdl': False, 'input_default_bindings': False, 'input_vo_keyboard': False}
            self.mpv = mpv.MPV(**kwargs)
        except OSError as e:
            raise RuntimeError(f'找不到 libmpv，请先安装 mpv（见 README）：{e}')
        self._loaded = False

    async def play(self, url, volume, muted):
        self.mpv.loadfile(url)
        self._loaded = True
        self.mpv.volume = int(volume)
        self.mpv.mute = bool(muted)

    async def pause(self):
        self.mpv.pause = True

    async def resume(self):
        self.mpv.pause = False

    async def stop(self):
        self._loaded = False
        self.mpv.command('stop')

    async def set_volume(self, v):
        self.mpv.volume = int(v)

    async def set_mute(self, m):
        self.mpv.mute = bool(m)

    async def wait_event(self, timeout=0.5):
        t0 = time.time()
        while time.time() - t0 < timeout:
            await asyncio.sleep(0.2)
            if self._loaded:
                if self.mpv.eof_reached:
                    self._loaded = False
                    return 'finished'
                if self.mpv.core_idle:
                    # 载入后回到 idle：加载失败/地址失效
                    self._loaded = False
                    return 'error'
        return None

    def audio_device(self):
        """当前音频设备名（蓝牙掉线检测用；平台不支持时返回 None）。"""
        try:
            return self.mpv.audio_device
        except Exception:
            return None

    async def close(self):
        self.mpv.terminate()
