"""
二维码生成器 —— 使用 qrcode 库生成 PIL Image / 解码图片二维码
"""

import base64
import io
import logging
from typing import Optional

from PIL import Image

logger = logging.getLogger("clawbox.qr")

try:
    import qrcode
    HAS_QRCODE = True
except ImportError:
    HAS_QRCODE = False

try:
    import cv2
    import numpy as np
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False

_missing_qrcode_warned = False

# 高密度 WhatsApp QR (v12, 65 模块 + 静区) 在 152px 墨水屏上的最佳原生渲染尺寸:
# box_size=2 → (65+4)*2 = 138px, 完美网格不缩放。网页端生成的 438px 原图必须
# 解码重绘, 任何 NEAREST/BILINEAR 缩放都会破坏模块网格导致手机无法识别。
MAX_IMAGE_QR_FIT = 138


def generate_qr(data: str,
                size: int = 150,
                box_size: int = 6,
                border: int = 2) -> Optional[Image.Image]:
    """
    生成二维码 PIL Image

    Args:
        data: 要编码的字符串
        size: 输出图像的目标尺寸 (正方形)
        box_size: 每个小格的像素数
        border: 边框格数

    Returns:
        PIL Image (mode='1', 黑白) 或 None
    """
    global _missing_qrcode_warned

    if not HAS_QRCODE:
        if not _missing_qrcode_warned:
            logger.warning("qrcode 未安装，二维码功能不可用。安装: pip3 install 'qrcode[pil]'")
            _missing_qrcode_warned = True
        return None

    if not data or not data.strip():
        return None

    try:
        qr = qrcode.QRCode(
            version=None,  # 自动选择版本
            error_correction=qrcode.constants.ERROR_CORRECT_M,  # M 级容错 (~15%)
            box_size=box_size,
            border=border,
        )
        qr.add_data(data.strip())
        qr.make(fit=True)

        img = qr.make_image(fill_color="black", back_color="white")
        img = img.convert("1")  # 确保 1-bit 模式

        # 缩放到目标尺寸
        if img.size[0] != size:
            img = img.resize((size, size), Image.NEAREST)

        return img

    except (OSError, ValueError, TypeError) as e:
        logger.error(f"二维码生成失败: {type(e).__name__}: {e}")
        return None
    except Exception as e:
        logger.exception(f"二维码生成非预期失败: {e}")
        return None


def data_url_to_image(data_url: str,
                      size: Optional[int] = None) -> Optional[Image.Image]:
    """
    把 data:image/png;base64,... 图片二维码解码为 1-bit 黑白 PIL Image。

    WhatsApp 等平台返回的是二维码【图片】(data URL), 不是可编码字符串,
    无法用 generate_qr() 再次编码, 必须解码后直显。

    Args:
        data_url: data URL 字符串 (data:image/png;base64,...)
        size: 输出图像的目标尺寸 (正方形); None = 保持原始尺寸不缩放。
              高密度 QR (WhatsApp v12 65 模块) 缩放会破坏模块网格导致无法识别,
              必须原生直显, 见 2026-08-07 诊断 (qr_pipeline_test)。

    Returns:
        PIL Image (mode='1', 黑白) 或 None
    """
    if not isinstance(data_url, str) or not data_url.startswith("data:image/"):
        return None
    try:
        header, _, b64 = data_url.partition(",")
        if ";base64" not in header or not b64:
            return None
        raw = base64.b64decode(b64)
        img = Image.open(io.BytesIO(raw))
        img = img.convert("L")
        # 与屏幕渲染一致: 阈值 170 二值化 (笔画清晰/不粘连的最佳平衡点)
        img = img.point(lambda p: 0 if p < 170 else 255).convert("1")
        # 仅当显式指定目标尺寸时才缩放 (默认 None 保持原样)
        if size is not None and img.size[0] != size:
            img = img.resize((size, size), Image.NEAREST)
        return img
    except (OSError, ValueError) as e:
        # base64 损坏(ValueError)/图片无法解析(OSError, 含 UnidentifiedImageError)
        logger.error(f"二维码图片解码失败: {e}")
        return None


def decode_qr_string_from_data_url(data_url: str) -> Optional[str]:
    """从 data URL 图片中解码出二维码字符串 (用 cv2, 设备端已装).

    cv2.QRCodeDetector 对部分 WhatsApp 码(438px v12/v13)原尺寸解码会失败,
    实测 2x 上采样后可解 (2026-08-07 04:34 复现: 原图❌/2x✅)。
    因此按 原图 → 2x/3x/4x 线性上采样 依次尝试, 任一成功即返回。
    """
    if not isinstance(data_url, str) or not data_url.startswith("data:image/"):
        return None
    if not HAS_CV2:
        logger.warning("cv2 不可用, 无法解码高密度二维码字符串")
        return None
    try:
        header, _, b64 = data_url.partition(",")
        if ";base64" not in header or not b64:
            return None
        raw = base64.b64decode(b64)
        arr = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_GRAYSCALE)
        if arr is None:
            return None
        det = cv2.QRCodeDetector()
        # 候选: 原图 + 2x/3x/4x 线性上采样 (QRCodeDetector 对部分码需放大才识别)
        candidates = [("原图", arr)]
        for scale in (2, 3, 4):
            up = cv2.resize(arr, None, fx=scale, fy=scale,
                            interpolation=cv2.INTER_LINEAR)
            candidates.append((f"{scale}x上采样", up))
        for label, cand in candidates:
            data, _, _ = det.detectAndDecode(cand)
            if data:
                if label != "原图":
                    logger.info(f"二维码解码: {label}成功")
                return data
        return None
    except (OSError, ValueError, TypeError, AttributeError) as e:
        logger.error(f"二维码字符串解码失败: {type(e).__name__}: {e}")
        return None
    except Exception as e:
        logger.exception(f"二维码字符串解码非预期失败: {e}")
        return None


def generate_qr_fit(data: str,
                    max_size: int = MAX_IMAGE_QR_FIT,
                    border: int = 2) -> Optional[Image.Image]:
    """按屏幕最大尺寸原生重绘二维码 —— 完美网格, 不缩放。

    根据模块数反推 box_size, 使原生渲染直接铺满目标尺寸, 杜绝二次缩放。
    WhatsApp v12 (65 模块+静区=69): box_size=2 → 138px; v13 (81): box_size=1 → 81px。
    """
    if not HAS_QRCODE or not data or not data.strip():
        return None
    try:
        probe = qrcode.QRCode(version=None,
                              error_correction=qrcode.constants.ERROR_CORRECT_M,
                              box_size=1, border=border)
        probe.add_data(data.strip())
        probe.make(fit=True)
        modules = len(probe.modules)
        box = max(1, max_size // (modules + 2 * border))
        qr = qrcode.QRCode(version=None,
                           error_correction=qrcode.constants.ERROR_CORRECT_M,
                           box_size=box, border=border)
        qr.add_data(data.strip())
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        return img.convert("1")
    except (OSError, ValueError, TypeError) as e:
        logger.error(f"二维码原生重绘失败: {type(e).__name__}: {e}")
        return None
    except Exception as e:
        logger.exception(f"二维码原生重绘非预期失败: {e}")
        return None


def qr_image_fit_for_screen(data_url: str,
                            max_size: int = MAX_IMAGE_QR_FIT) -> Optional[Image.Image]:
    """解码 data URL 图片二维码 → 保证在屏幕上清晰可扫 (页面2 图片直显用)。

    1. 原图 ≤ max_size → 直接 1-bit 直显 (保持原始像素, 不缩放)
    2. 原图 > max_size (网页端生成的 438px 高密度码) → 缩放必破坏模块网格,
       先用 cv2 解码出字符串, 再原生重绘 (完美网格); 解码失败时降级直显原图
       (屏幕上会偏大但至少可见, 日志告警)。
    """
    img = data_url_to_image(data_url)
    if img is None:
        return None
    if img.size[0] <= max_size:
        return img
    string = decode_qr_string_from_data_url(data_url)
    if string:
        fitted = generate_qr_fit(string, max_size=max_size)
        if fitted is not None:
            logger.info(
                f"高密度二维码({img.size[0]}px) 解码成功 → 原生重绘 {fitted.size[0]}px 完美网格"
            )
            return fitted
        logger.warning("高密度二维码解码成功但重绘失败, 降级直显原图")
    else:
        logger.warning("高密度二维码字符串解码失败, 降级直显原图(可能不可扫)")
    return img
