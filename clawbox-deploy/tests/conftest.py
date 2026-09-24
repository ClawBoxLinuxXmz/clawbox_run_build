"""pytest 公共配置: 让测试能 import clawbox-peripheral/ 下的模块。"""

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PERIPHERAL = os.path.join(os.path.dirname(_HERE), "clawbox-peripheral")
if _PERIPHERAL not in sys.path:
    sys.path.insert(0, _PERIPHERAL)
