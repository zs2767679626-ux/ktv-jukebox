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


def app_dir():
    """程序所在目录：PyInstaller 冻结后 __file__ 指向临时解包目录，要用 exe 所在目录"""
    if getattr(sys, 'frozen', False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


# 冻结成 exe（无控制台）后日志写 exe 旁的 player.log；开发模式仍打控制台
_log_kwargs = dict(level=logging.INFO, format='%(asctime)s %(name)s %(message)s')
if getattr(sys, 'frozen', False):
    _log_kwargs['filename'] = os.path.join(app_dir(), 'player.log')
logging.basicConfig(**_log_kwargs)
log = logging.getLogger('player')


def main():
    parser = argparse.ArgumentParser(description='KTV 点歌台播放客户端')
    parser.add_argument('--config', default=None)
    parser.add_argument('--virtual', action='store_true', help='虚拟模式：不出声只打日志')
    args = parser.parse_args()
    config_path = args.config or os.path.join(app_dir(), 'player_config.json')

    cfg = load(config_path)
    if args.virtual:
        cfg['virtual'] = True
    if not cfg.get('token') or '换成' in str(cfg['token']):
        log.error('player_config.json 里还没填 token（云端设备口令）')
        sys.exit(1)
    cfg['server'] = str(cfg['server']).replace('http://', 'ws://').replace('https://', 'wss://')
    if not str(cfg['server']).endswith('/ws'):
        cfg['server'] += '/ws'   # 所有 scheme 统一补 /ws（Task 15 C2 修订：ws:// 直连也需补）
    # Windows 下自动找 libmpv dll（新版 mpv-dev 包叫 libmpv-2.dll，旧版叫 mpv-2.dll）
    if sys.platform == 'win32' and not cfg.get('libmpv'):
        base = app_dir()
        hits = glob.glob(os.path.join(base, 'mpv-2.dll')) \
            + glob.glob(os.path.join(base, 'libmpv-2.dll')) \
            + glob.glob(os.path.join(base, 'libmpv', '**', 'mpv-2.dll'), recursive=True) \
            + glob.glob(os.path.join(base, 'libmpv', '**', 'libmpv-2.dll'), recursive=True)
        if hits:
            cfg['libmpv'] = hits[0]
    log.info('server=%s virtual=%s libmpv=%s', cfg['server'], cfg['virtual'], cfg.get('libmpv') or 'auto')
    asyncio.run(run(cfg))


if __name__ == '__main__':
    main()
