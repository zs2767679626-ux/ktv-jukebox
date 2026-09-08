import json
import os

DEFAULTS = {
    'server': 'https://你的应用.app.workbuddy.link',
    'token': '换成云端设备口令',
    'libmpv': '',      # libmpv 路径，留空自动查找
    'virtual': False,
}

def load(path='player_config.json'):
    cfg = dict(DEFAULTS)
    if os.path.exists(path):
        try:
            with open(path, encoding='utf-8') as f:
                cfg.update(json.load(f))
        except Exception:
            pass
    if os.environ.get('VIRTUAL') == '1':
        cfg['virtual'] = True
    if os.environ.get('VIRTUAL_DURATION'):
        cfg['virtual_duration'] = float(os.environ['VIRTUAL_DURATION'])
    return cfg
