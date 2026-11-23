# 验证脚本（开发用，不影响线上网站）

这些脚本是我改完功能后用来「自动跑一遍、确认没弄坏」的工具。它们通过 Chrome 的无头模式打开页面、塞入文件、检查结果并截图。

**线上网站完全不需要这些文件**，删掉也不影响任何人使用。

## 运行前提

| 要求 | 说明 |
|---|---|
| Node.js 22+ | 需要原生 WebSocket（Node 18 不行） |
| Google Chrome | 脚本里写死了 `C:/Program Files/Google/Chrome/Application/chrome.exe`，装在别处需要改 `CHROME` 常量 |
| 本地服务 | 先跑 `python -m http.server 8017 --bind 127.0.0.1`（或双击根目录的 `一键启动.bat`） |
| 测试素材 | `testdata/` 目录（3 个测试 SRT + 1 个术语清单 xlsx），不在仓库里，需要自己放 |
| 截图输出 | 脚本会自动创建 `shots/` 目录 |

## 常用脚本

| 脚本 | 作用 |
|---|---|
| `check-all-auto.js` | SRT 修复 + ST↔TT 替换全流程，验证自动写入「修复」/「替换」文件夹 |
| `check-precheck.js` | 原剧体检，需要 `testdata/` 里放视频素材 |
| `check-live.js` | 线上站点加载检查（JS 异常、请求失败、四页布局） |
| `check-live-repair.js` | 在**线上站点**跑一次真实修复，验证 Pyodide 与 pysubs2 可用 |
| `shot-compare.js` | 四个功能页的位置/宽度对齐检查并截图 |
| `shot-mobile.js` | 390px 窄屏排版检查 |
| `shot-home.js` | 首页封面截图 |
| `shot-brand.js` | 左上角品牌标记渲染检查 |
| `mkicon.js` | 从 SVG 生成各尺寸 favicon / apple-touch-icon |

其余 `shot-inject*.js`、`shot-head*.js`、`shot-plan.js`、`shot-scheme.js` 是历次做方案对比时的一次性截图脚本，留着供参考，日常不需要跑。

## 注意

- 脚本会自己起 Chrome 并监听 `928x~929x` 端口，跑完自动关闭。
- **不要**用这些脚本去动 8017 端口的服务——那个是网站本体。
