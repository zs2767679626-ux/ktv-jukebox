"""播放客户端入口：python player.py [--config player_config.json] [--virtual]"""
import argparse
import asyncio
import glob
import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import load          # noqa: E402
from client import run           # noqa: E402

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(message)s')
log = logging.getLogger('player')


def main():
    parser = argparse.ArgumentParser(description='KTV 点歌台播放客户端')
    parser.add_argument('--config', default='player_config.json')
    parser.add_argument('--virtual', action='store_true', help='虚拟模式：不出声只打日志')
    args = parser.parse_args()

    cfg = load(args.config)
    if args.virtual:
        cfg['virtual'] = True
    if not cfg.get('token') or '换成' in str(cfg['token']):
        log.error('player_config.json 里还没填 token（云端设备口令）')
        sys.exit(1)
    cfg['server'] = str(cfg['server']).replace('http://', 'ws://').replace('https://', 'wss://')
    if not str(cfg['server']).endswith('/ws'):
        cfg['server'] += '/ws'   # 所有 scheme 统一补 /ws（Task 15 C2 修订：ws:// 直连也需补）
    # Windows 下自动找 libmpv dll
    if sys.platform == 'win32' and not cfg.get('libmpv'):
        hits = glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'libmpv', '**', 'mpv-2.dll'), recursive=True)
        if hits:
            cfg['libmpv'] = hits[0]
    log.info('server=%s virtual=%s libmpv=%s', cfg['server'], cfg['virtual'], cfg.get('libmpv') or 'auto')
    asyncio.run(run(cfg))


if __name__ == '__main__':
    main()
