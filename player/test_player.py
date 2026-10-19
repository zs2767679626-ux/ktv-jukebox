import asyncio
import unittest

import client
from config import load
from playback import VirtualPlayer


class TestVirtualPlayer(unittest.IsolatedAsyncioTestCase):
    async def test_finished_after_duration(self):
        p = VirtualPlayer(duration=0.1)
        await p.play('http://x.mp3', 60, False)
        self.assertIsNone(await p.wait_event(timeout=0.05))
        await asyncio.sleep(0.1)
        self.assertEqual(await p.wait_event(timeout=0.05), 'finished')

    async def test_stop_cancels_finish(self):
        p = VirtualPlayer(duration=0.1)
        await p.play('http://x.mp3', 60, False)
        await p.stop()
        await asyncio.sleep(0.2)
        self.assertIsNone(await p.wait_event(timeout=0.05))

    async def test_volume_mute(self):
        p = VirtualPlayer(duration=5)
        await p.play('http://x.mp3', 60, False)
        await p.set_volume(20)
        await p.set_mute(True)
        self.assertEqual(p.volume, 20)
        self.assertTrue(p.muted)

    async def test_pause_cleared_on_new_play(self):
        """与 MpvPlayer 同语义：新歌起播清暂停态（10-12「又不出声」根因的虚拟端对应回归）。"""
        p = VirtualPlayer(duration=5)
        await p.play('http://x.mp3', 60, False)
        await p.pause()
        self.assertTrue(p.paused)
        await p.play('http://y.mp3', 60, False)  # 暂停中切歌：新歌不带暂停出生
        self.assertFalse(p.paused)


class TestConfig(unittest.TestCase):
    def test_defaults(self):
        cfg = load('nonexistent.json')
        self.assertEqual(cfg['token'], '换成云端设备口令')
        self.assertFalse(cfg['virtual'])


class TestMpvPlayer(unittest.TestCase):
    def test_libmpv_path_passed_and_oserror_wrapped(self):
        import sys
        from unittest import mock
        from playback import MpvPlayer

        # 场景 1：DLL 目录加进 PATH（python-mpv 导入期靠 PATH 找 DLL），构造器不传 libmpv
        fake = mock.Mock()
        fake.MPV.return_value = mock.Mock(
            volume=0, mute=False, pause=False, eof_reached=False, core_idle=False)
        with mock.patch.dict(sys.modules, {'mpv': fake}):
            p = MpvPlayer('/opt/mpv/libmpv.dylib')
            kwargs = fake.MPV.call_args.kwargs
            self.assertNotIn('libmpv', kwargs)
            self.assertFalse(kwargs['ytdl'])
            self.assertIs(p.mpv, fake.MPV.return_value)
            import os
            expected = os.path.dirname(os.path.abspath('/opt/mpv/libmpv.dylib'))
            self.assertTrue(os.environ['PATH'].startswith(expected + os.pathsep))

        # 场景 2：libmpv 缺失（OSError）→ 包装成 RuntimeError
        fake2 = mock.Mock()
        fake2.MPV.side_effect = OSError('cannot load mpv')
        with mock.patch.dict(sys.modules, {'mpv': fake2}):
            with self.assertRaises(RuntimeError):
                MpvPlayer()

        # 场景 3：不传路径时构造器不接 libmpv 参数
        fake3 = mock.Mock()
        fake3.MPV.return_value = mock.Mock()
        with mock.patch.dict(sys.modules, {'mpv': fake3}):
            MpvPlayer()
            self.assertNotIn('libmpv', fake3.MPV.call_args.kwargs)


class TestMpvPlayerWait(unittest.IsolatedAsyncioTestCase):
    async def test_core_idle_grace_period(self):
        """loadfile 后 10 秒缓冲期内 core_idle 不算失败（联网取流中），超时才报 error。"""
        import sys
        import time
        from unittest import mock
        from playback import MpvPlayer

        fake = mock.Mock()
        fake.MPV.return_value = mock.Mock(
            volume=0, mute=False, pause=False, eof_reached=False, core_idle=True)
        with mock.patch.dict(sys.modules, {'mpv': fake}):
            p = MpvPlayer()
            await p.play('http://x', 60, False)
            # 加载后 5 秒：缓冲期内，不判失败
            p._load_at = time.time() - 5
            self.assertIsNone(await p.wait_event(timeout=0.3))
            # 加载后 11 秒仍 idle：判加载失败
            p._load_at = time.time() - 11
            self.assertEqual(await p.wait_event(timeout=0.3), 'error')

    async def test_paused_core_idle_not_error(self):
        """暂停时 mpv 的 core_idle 为 True（实测），不能判加载失败。"""
        import sys
        import time
        from unittest import mock
        from playback import MpvPlayer

        fake = mock.Mock()
        fake.MPV.return_value = mock.Mock(
            volume=0, mute=False, pause=False, eof_reached=False, core_idle=True)
        with mock.patch.dict(sys.modules, {'mpv': fake}):
            p = MpvPlayer()
            await p.play('http://x', 60, False)
            await p.pause()  # 用户播放中按暂停：mpv.pause=True（真实暂停态由 play 之后的 pause() 建立）
            p._load_at = time.time() - 30  # 早已超过缓冲期，但处于暂停 → 不判失败
            self.assertIsNone(await p.wait_event(timeout=0.3))

    async def test_play_resets_stale_pause(self):
        """mpv 的 pause 跨 loadfile 持久（本机 libmpv-2.dll 实测）：
        上一首暂停时切歌/点歌，新歌起播必须显式清暂停，否则出声但 UI 显示暂停、后续每首都传染。"""
        import sys
        from unittest import mock
        from playback import MpvPlayer

        fake = mock.Mock()
        fake.MPV.return_value = mock.Mock(
            volume=0, mute=False, pause=True, eof_reached=False, core_idle=False)
        with mock.patch.dict(sys.modules, {'mpv': fake}):
            p = MpvPlayer()
            await p.play('http://x', 60, False)
            self.assertFalse(p.mpv.pause, '新歌起播必须清掉上一首遗留的暂停态')


class TestControlLoop(unittest.IsolatedAsyncioTestCase):
    """client.control_loop / play_session 的指令流回归。"""

    class _FakeWS:
        def __init__(self):
            self.sent = []

        async def send(self, msg):
            self.sent.append(msg)

    async def test_first_cmd_timeout_returns(self):
        """hello 后首条指令超时（token 错/被撤权时服务端只发 state 广播）：
        控制环必须超时退出，不能无声无错地永久挂起。"""
        old = client.FIRST_CMD_TIMEOUT
        client.FIRST_CMD_TIMEOUT = 0.1
        try:
            ws = self._FakeWS()
            await asyncio.wait_for(
                client.control_loop(ws, asyncio.Queue(), VirtualPlayer(duration=5)),
                timeout=2)
        finally:
            client.FIRST_CMD_TIMEOUT = old

    async def test_first_cmd_processed_then_sentinel_exits(self):
        """正常链路：首条 volume 照常执行，随后连接断开哨兵（None）结束控制环。"""
        q = asyncio.Queue()
        await q.put({'action': 'volume', 'value': 30})
        await q.put(None)
        p = VirtualPlayer(duration=5)
        await client.control_loop(self._FakeWS(), q, p)
        self.assertEqual(p.volume, 30)

    async def test_play_during_play_requeues(self):
        """播放中收到新 play（切歌竞态）：不能静默丢弃，停当前歌后送回队列交控制环处理。"""
        q = asyncio.Queue()
        await q.put({'action': 'play', 'url': 'http://b.mp3', 'volume': 60, 'muted': False})
        p = VirtualPlayer(duration=5)
        await client.play_session(self._FakeWS(), q, p)
        self.assertEqual(q.qsize(), 1)
        self.assertEqual(q.get_nowait()['url'], 'http://b.mp3')

    async def test_stop_returns_without_requeue(self):
        """播放中收到 stop：停播返回，队列不留残余指令。"""
        q = asyncio.Queue()
        await q.put({'action': 'stop'})
        p = VirtualPlayer(duration=5)
        await client.play_session(self._FakeWS(), q, p)
        self.assertEqual(q.qsize(), 0)


if __name__ == '__main__':
    unittest.main()
