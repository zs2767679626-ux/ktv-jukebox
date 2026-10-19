import json
import logging
import os

log = logging.getLogger('player.config')

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
        except Exception as e:
            # 文件在但解析失败：留一条日志再回退默认。此前静默吞掉，
            # 用户只会看到误导性的「还没填 token」
            log.warning('配置文件存在但解析失败，回退默认配置（%s）：%s', path, e)
    if os.environ.get('VIRTUAL') == '1':
        cfg['virtual'] = True
    if os.environ.get('VIRTUAL_DURATION'):
        cfg['virtual_duration'] = float(os.environ['VIRTUAL_DURATION'])
    return cfg
