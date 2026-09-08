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

        # 场景 1：libmpv 路径传给 MPV 构造器，且禁用 ytdl
        fake = mock.Mock()
        fake.MPV.return_value = mock.Mock(
            volume=0, mute=False, pause=False, eof_reached=False, core_idle=False)
        with mock.patch.dict(sys.modules, {'mpv': fake}):
            p = MpvPlayer('/opt/mpv/libmpv.dylib')
            kwargs = fake.MPV.call_args.kwargs
            self.assertEqual(kwargs.get('libmpv'), '/opt/mpv/libmpv.dylib')
            self.assertFalse(kwargs['ytdl'])
            self.assertIs(p.mpv, fake.MPV.return_value)

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


if __name__ == '__main__':
    unittest.main()
