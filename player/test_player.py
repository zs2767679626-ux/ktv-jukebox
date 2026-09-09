import asyncio
import unittest

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
            volume=0, mute=False, pause=True, eof_reached=False, core_idle=True)
        with mock.patch.dict(sys.modules, {'mpv': fake}):
            p = MpvPlayer()
            await p.play('http://x', 60, False)
            p._load_at = time.time() - 30  # 早已超过缓冲期，但处于暂停 → 不判失败
            self.assertIsNone(await p.wait_event(timeout=0.3))


if __name__ == '__main__':
    unittest.main()
