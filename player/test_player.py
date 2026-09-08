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


if __name__ == '__main__':
    unittest.main()
