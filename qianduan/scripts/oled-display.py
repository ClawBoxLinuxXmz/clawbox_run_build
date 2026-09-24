#!/usr/bin/env python3
import time
import socket
import fcntl
import struct
import sys
import os
import json

# 尝试导入OLED库
try:
    from luma.core.interface.serial import i2c
    from luma.core.render import canvas
    from luma.oled.device import ssd1306, ssd1309
    OLED_AVAILABLE = True
except ImportError:
    OLED_AVAILABLE = False
    print("[OLED] luma.oled library not found, running in dummy mode")

def get_ip_address(ifname):
    """获取指定网络接口的IP地址"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        return socket.inet_ntoa(fcntl.ioctl(
            s.fileno(),
            0x8915,  # SIOCGIFADDR
            struct.pack('256s', ifname[:15].encode('utf-8'))
        )[20:24])
    except:
        return None

def find_wifi_interface():
    """查找WiFi接口"""
    interfaces = ['wlan0', 'wlan1', 'eth0', 'en0']
    for iface in interfaces:
        ip = get_ip_address(iface)
        if ip:
            return iface, ip
    # 尝试获取所有接口
    try:
        import netifaces
        for iface in netifaces.interfaces():
            if iface.startswith('wlan') or iface.startswith('eth'):
                addrs = netifaces.ifaddresses(iface)
                if netifaces.AF_INET in addrs:
                    return iface, addrs[netifaces.AF_INET][0]['addr']
    except:
        pass
    return None, None

def get_device_identity():
    config_root = os.environ.get("CLAWBOX_ROOT", "/home/clawbox/clawbox")
    identity_path = os.path.join(config_root, "data", "device-identity.json")
    hostname = os.environ.get("CLAWBOX_DEVICE_HOSTNAME")
    local_dns_alias = None

    try:
        with open(identity_path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
            if not hostname and isinstance(payload.get("hostname"), str):
                hostname = payload["hostname"].strip() or None
            if isinstance(payload.get("localDnsAlias"), str):
                local_dns_alias = payload["localDnsAlias"].strip() or None
    except:
        pass

    if not hostname:
        hostname = socket.gethostname()

    return hostname, local_dns_alias

class DummyOLED:
    """虚拟OLED类，在库不可用时使用"""
    def __init__(self):
        self.width = 128
        self.height = 64
        self.mode = "1"
    
    def cleanup(self):
        pass

class OLEDDisplay:
    def __init__(self):
        self.device = None
        self.current_ip = None
        self.init_display()
    
    def init_display(self):
        if not OLED_AVAILABLE:
            self.device = DummyOLED()
            print("[OLED] Using dummy display")
            return
        
        try:
            # 尝试不同的I2C地址
            for address in [0x3C, 0x3D]:
                try:
                    serial = i2c(port=1, address=address)
                    # 尝试SSD1306
                    try:
                        self.device = ssd1306(serial)
                        print(f"[OLED] Connected to SSD1306 at 0x{address:02X}")
                        return
                    except:
                        pass
                    # 尝试SSD1309
                    try:
                        self.device = ssd1309(serial)
                        print(f"[OLED] Connected to SSD1309 at 0x{address:02X}")
                        return
                    except:
                        pass
                except:
                    continue
            
            print("[OLED] No OLED display found, using dummy mode")
            self.device = DummyOLED()
        except Exception as e:
            print(f"[OLED] Error initializing display: {e}")
            self.device = DummyOLED()
    
    def display_access(self, ip, iface=None):
        """在OLED上显示设备名、mDNS地址和IPv4兜底"""
        if self.device is None:
            return
        
        try:
            hostname, local_dns_alias = get_device_identity()
            mdns_host = f"{hostname}.local"
            with canvas(self.device) as draw:
                draw.rectangle([(0, 0), (self.device.width, self.device.height)], fill=0)

                draw.text((2, 2), hostname[:21], fill=255)
                draw.text((2, 16), mdns_host[:21], fill=255)

                if ip:
                    draw.text((2, 32), f"IPv4 {ip}"[:21], fill=255)
                else:
                    draw.text((2, 32), "Waiting for DHCP..."[:21], fill=255)

                footer = None
                if local_dns_alias:
                    footer = local_dns_alias
                elif iface:
                    footer = f"IF {iface}"

                if footer:
                    draw.text((2, 48), footer[:21], fill=255)

            status = f"{mdns_host} | IP: {ip}" if ip else f"{mdns_host} | Waiting for DHCP"
            if iface:
                status += f" ({iface})"
            if local_dns_alias:
                status += f" alias={local_dns_alias}"
            print(f"[OLED] Displaying: {status}")
        except Exception as e:
            print(f"[OLED] Error displaying access info: {e}")
    
    def run(self):
        """主运行循环"""
        print("[OLED] Starting IP display service")
        
        while True:
            try:
                iface, ip = find_wifi_interface()
                
                # 只有IP变化时才更新显示
                if ip != self.current_ip:
                    self.current_ip = ip
                    self.display_access(ip, iface)
                
                time.sleep(2)  # 每2秒检查一次
            except KeyboardInterrupt:
                print("\n[OLED] Stopping service")
                break
            except Exception as e:
                print(f"[OLED] Error in main loop: {e}")
                time.sleep(5)
    
    def cleanup(self):
        if self.device and not isinstance(self.device, DummyOLED):
            self.device.cleanup()

if __name__ == "__main__":
    display = OLEDDisplay()
    try:
        display.run()
    finally:
        display.cleanup()
