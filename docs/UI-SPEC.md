# KBChat UI 设计规范（深色 · 企业级）

风格关键词：深灰近黑、克制、高密度信息。参考 DeepSeek 官网聊天界面。

## 1. 设计 Token

### 1.1 颜色

| 名称 | HEX | CSS 变量 | 用途 | 对比度 |
|---|---|---|---|---|
| 背景主 | #1E1F20 | --color-bg | 应用主背景 | - |
| 侧边栏 | #18191A | --color-bg-sidebar | 侧边栏背景 | - |
| 表面 | #242526 | --color-surface | 卡片/输入框/弹窗 | - |
| 表面悬浮 | #2B2C2D | --color-surface-hover | hover 高亮表面 | - |
| 边框 | #3A3B3C | --color-border | 分割线/描边 | - |
| 文字主 | #ECECEC | --color-text | 正文/标题 | 11.2:1 |
| 文字次 | #9FA2A6 | --color-text-2 | 次要/说明文字 | 5.1:1 |
| 文字禁用 | #5C5E60 | --color-text-3 | 禁用/占位 | - |
| 思考折叠字 | #7C8FA6 | --color-text-think | "已深度思考"灰蓝小字 | 4.6:1 |
| 主色 | #3B82F6 | --color-primary | 主按钮/链接/选中 | 4.6:1 |
| 主色悬浮 | #2F6FDB | --color-primary-hover | 主按钮 hover | - |
| 主色激活 | #2758B3 | --color-primary-active | 主按钮 active | - |
| 主色浅底 | #1E2C42 | --color-primary-bg | 选中项底色/用户气泡 | - |
| 成功 | #34C77B | --color-success | 成功提示 | - |
| 警告 | #E8A33D | --color-warning | token 超配额预警 | - |
| 危险 | #E5484D | --color-danger | 删除/错误 | - |
| 危险浅底 | #3A2628 | --color-danger-bg | 删除确认底色 | - |

### 1.2 字体（系统字体栈）

```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
  "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
等宽(代码/ID): ui-monospace, SFMono-Regular, Consolas, monospace;
```

| 层级 | 字号/行高 | 字重 | 用途 |
|---|---|---|---|
| H1 | 20px/28px | 600 | 弹窗标题 |
| H2 | 16px/24px | 600 | 区块标题 |
| 正文 | 14px/22px | 400 | 消息正文、菜单 |
| 小字 | 12px/18px | 400 | token 计量、思考折叠、时间戳 |
| 代码 | 13px/20px | 400 | 代码块、等宽内容 |

### 1.3 间距 / 圆角 / 动效

| Token | 值 | 变量 | 用途 |
|---|---|---|---|
| 间距 | 4/8/12/16/24/32 | --space-* | 统一 4pt 阶梯 |
| 圆角-S | 6px | --radius-sm | 按钮/输入框/菜单项 |
| 圆角-M | 12px | --radius-md | 消息气泡/目录树容器 |
| 圆角-L | 24px | --radius-lg | 底部大输入框 |
| 动效时长 | 150ms(微) / 200ms(面板) | --motion-* | 缓动 ease-in-out |

### 1.4 CSS 变量交付块

```css
:root {
  --color-bg: #1E1F20;          --color-bg-sidebar: #18191A;
  --color-surface: #242526;     --color-surface-hover: #2B2C2D;
  --color-border: #3A3B3C;      --color-text: #ECECEC;
  --color-text-2: #9FA2A6;      --color-text-3: #5C5E60;
  --color-text-think: #7C8FA6;  --color-primary: #3B82F6;
  --color-primary-hover: #2F6FDB; --color-primary-active: #2758B3;
  --color-primary-bg: #1E2C42;  --color-success: #34C77B;
  --color-warning: #E8A33D;     --color-danger: #E5484D;
  --color-danger-bg: #3A2628;
  --radius-sm: 6px; --radius-md: 12px; --radius-lg: 24px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px;
  --space-4: 16px; --space-6: 24px; --space-8: 32px;
  --motion-fast: 150ms; --motion-panel: 200ms;
}
```

## 2. 组件七态

| 组件 | default | hover | active/focus | disabled | loading | error | selected |
|---|---|---|---|---|---|---|---|
| 主按钮 | bg #3B82F6，字 #FFF，radius 6 | #2F6FDB | #2758B3 + 2px #3B82F6 外描边 | bg #242526，字 #5C5E60，cursor not-allowed | 内联 spinner（800ms 旋转）+ 字"发送中" | bg #E5484D | - |
| 输入框 | bg #242526，border #3A3B3C | border #5C5E60 | border #3B82F6 + 无阴影 | bg #1E1F20，placeholder #5C5E60 | 右侧 spinner | border #E5484D + 下方 12px 红色错误文案 | - |
| 侧边栏菜单项 | 字 #ECECEC，padding 8/12，radius 6 | bg #2B2C2D | 边框 #3B82F6 | 字 #5C5E60 | 项前 14px spinner | 字 #E5484D | bg #1E2C42 + 字 #3B82F6 |
| 目录树节点 | 字 #ECECEC，缩进 16px/层，行高 32px | bg #2B2C2D + 箭头旋转 90°（150ms） | 边框 #3B82F6 | 字 #5C5E60，禁止展开 | 子项区 3 个骨架条 | 字 #E5484D + "加载失败" | bg #1E2C42，箭头常驻展开态 |

## 3. 布局

### 3.1 总体框架

```
┌────────┬──────────────────────────────┐
│侧边栏   │ 顶栏 56px：汉堡｜模型选择｜深度思考档位│token计量条│
│260px   ├──────────────────────────────┤
│可收起为0│  对话流（居中 max-width 760px）  │
│        ├──────────────────────────────┤
│        │  底部输入框（max-width 760px，radius 24）│
└────────┴──────────────────────────────┘
```

- 侧边栏收起：宽度 260px→0，200ms ease-in-out；汉堡按钮固定在顶栏左端，收起后仍可见。
- 顶栏：高 56px，bg #1E1F20，底边框 1px #3A3B3C。模型选择为下拉（≥1024 显示模型名，<1024 仅图标）；深度思考档位为分段控件（关/标准/深度）；token 计量条宽 120px，<80% 绿 #34C77B，80-99% 黄 #E8A33D，100% 红 #E5484D 并禁用输入。

### 3.2 侧边栏（bg #18191A）

- 区块一「知识库」：标题行 + 「新建目录」按钮（仅图标 24×24）+「上传」主按钮；目录树（层级缩进 16px、展开箭头、文件项 hover 显示删除图标 #E5484D）；空态文案"暂无文件，点击上传"。
- 区块二「对话」：「新建对话」次级按钮通栏；对话项（标题 + 时间小字），hover bg #2B2C2D 并浮出重命名/删除图标，选中 bg #1E2C42。
- 导入/导出：固定在侧边栏底部一行两个图标按钮（上传箭头=导入 / 下载箭头=导出），带 tooltip。

### 3.3 对话区与消息

- 用户消息：右对齐，bg #1E2C42，radius 12（右上角 4px），padding 12/16，max-width 70%。
- AI 消息：左对齐无气泡，直接排版在背景上，max-width 760px；顶部「已深度思考（用时 X 秒）」折叠条，12px #7C8FA6，点击展开显示思考内容（bg #242526，radius 8）；正文 14px #ECECEC；底部操作行（复制/重新生成，12px 图标）。
- 加载态：AI 回复前显示三点呼吸动画（600ms 循环）；错误态：红字"生成失败，请重试"+ 重试按钮。

### 3.4 底部输入框

- 容器 max-width 760px 居中，bg #242526，radius 24，border #3A3B3C，focus 时 border #3B82F6；textarea 自适应 1-6 行；右下角发送主按钮 32×32，输入为空时禁用；支持 Enter 发送 / Shift+Enter 换行。

### 3.5 设置弹窗

- 遮罩 rgba(0,0,0,.6)；弹窗 480px 宽，bg #242526，radius 12，padding 24。
- 字段：Base URL（文本输入）、API Key（密码输入+显隐切换）、模型（下拉）、配额上限（数字输入）、思考档位（分段控件 关/标准/深度）。
- 底部右侧：取消（ghost）+ 保存（主按钮）；保存成功 toast 2s。入口：侧边栏底部齿轮图标。

## 4. 响应式断点

| 断点 | 布局 | 组件调整 |
|---|---|---|
| ≥1024 | 侧边栏 260px 常驻可收起 | 顶栏显示完整模型名与计量条 |
| 768-1023 | 侧边栏默认收起，点击汉堡以浮层(overlay)展开 | 顶栏计量条缩短为 80px，模型仅显示图标 |
| <768 | 侧边栏全屏浮层；对话区单列满宽 | 用户气泡 max-width 85%；顶栏仅保留汉堡+计量条；深度思考档位收进输入框内图标切换 |

## 5. 交互与动效

| 交互 | 反馈 | 时长 | 缓动 |
|---|---|---|---|
| 侧边栏收起/展开 | 宽度过渡 | 200ms | ease-in-out |
| 目录树展开 | 箭头旋转 90° + 子项高度展开 | 150ms | ease-in-out |
| 按钮点击 | 背景色阶切换 | 150ms | ease-in-out |
| 消息发送 | 用户气泡淡入上移 8px | 200ms | ease-out |
| 删除操作 | 弹确认框（危险主按钮 bg #E5484D） | 即时 | - |
