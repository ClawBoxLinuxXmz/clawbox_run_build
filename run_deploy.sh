#!/bin/bash
# 设备端：执行一键部署并记录退出码
bash /home/clawbox/deploy_all.sh > /tmp/deploy_all.log 2>&1
echo "EXIT=$?" >> /tmp/deploy_all.log
echo "DONE"