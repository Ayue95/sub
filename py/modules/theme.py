from __future__ import annotations

# ==========================================
# 苹果风 + 星空粉白系 全局视觉规范
# ==========================================

COLORS = {
    # 整个软件的底层背景（温润通透的微乳白/浅粉白，完美延伸首页氛围）
    "bg": "#F4EAEF",           
    # 卡片容器色（纯净的暖白，呈现悬浮毛玻璃质感）
    "card": "#FCFAF8",         
    # 次级容器/列表交替色（极具层次感的温润浅灰粉）
    "card_alt": "#F3EFEA",     
    # 文字体系（克制而有力量的深色系，拒绝生硬纯黑）
    "text_primary": "#1E1E2A", 
    "text_secondary": "#5A5A6A",
    "text_light": "#8E8E9A",   
    "text_body": "#2D2D3A",
    # 核心品牌色（您最爱的星空渐变粉色系里的优雅玫瑰粉）
    "primary": "#E8A0BF",      
    "primary_hover": "#D48BA8",# 鼠标悬停时微微加深，有机反馈
    "primary_light": "#FDF2F5",# 浅粉色背景，用于选中态或高亮标签
    "primary_border": "#F2D4DC",# 极细腻的粉边框
    # 边框与分割线（几乎隐形的高级感）
    "border": "#EBE7E2",
    "highlight_bg": "#F4F4F5",

    "success": "#4CAF50",
    "danger": "#E53935",
    "warning": "#FF9800",
    "info": "#2196F3",
}

# ==========================================
# 全局字体规范
# ==========================================

FONT = {
    "title": ("Microsoft YaHei", 20, "bold"),
    "subtitle": ("Microsoft YaHei", 14),
    "body": ("Microsoft YaHei", 13),
    "body_bold": ("Microsoft YaHei", 13, "bold"),
    "small": ("Microsoft YaHei", 11),
    "mono": ("Cascadia Code", 12),
}

# ==========================================
# 苹果风 UI尺寸与圆角规范
# ==========================================

RADIUS = 8
CARD_RADIUS = 12       # 升级为更大的苹果风柔和圆角
BUTTON_RADIUS = 8
ENTRY_HEIGHT = 32      # 稍微加高输入框，提升点击触感
CARD_PADDING = 12