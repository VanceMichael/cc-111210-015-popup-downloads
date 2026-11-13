# 跨窗口门户的附件领取自动化

本项目用于授权资料接入的单次查看与接收留存，并支持船代提单的批量领取。使用 Node.js 22。来源协议见 `docs/source-contract.md`。本地演练服务只绑定回环地址，数据不含真实个人资料或账号。

## 安装与运行

依赖由 `package-lock.json` 固定。首次准备环境运行 `npm ci --ignore-scripts`，浏览器项目使用 Playwright 1.56.1 对应的 Chromium；浏览器及系统库在镜像准备阶段安装，不在业务命令中下载。

```sh
npm run build
npm test
npm run demo
npm run demo:collect
npm start
```

`npm run demo` 启动本地来源和接入服务，实际获取单次查看结果并写入临时接收记录，显示完整 JSON，随后关闭服务并清理临时目录。通常在十秒内结束。`npm run demo:collect` 演示批量领取：两个同名 document.pdf 交错到达、预览窗口复用、旧预览页延后触发下载、预览窗口半途关闭、门户提示阻止、恢复核对与人工补领合并，全程打印事件流与最终台账。`npm start` 启动常驻服务，默认端口3000，可通过 PORT 与 DATA_DIR 修改监听端口和接收目录。设置 SOURCE_URL 可连接另一进程中已启动的本地来源；不设置时自动创建演练来源。恢复演练可先用 `npm run source` 在另一终端启动来源，记下输出地址，保持该进程运行，仅重启设置了 SOURCE_URL 的接入服务。

## 接口与模块

`GET /health` 查看状态，`GET /inspect` 查看来源，`GET /receive?key=sample` 保存单次接收，`GET /receipts/sample` 读取回执。相同key和相同内容可重复接收，不同内容拒绝覆盖。

`GET /collect` 对来源列表全部业务键执行批量领取，`GET /collect?keys=BILL-A,BILL-B` 只领取指定票；返回每票结果、事件流与台账。同一时间只允许一个批量领取，进行中的重复请求返回409。`GET /ledger` 读取当前领取台账。

`src/connector.mjs` 解释单次来源响应，`fixtures/source.mjs` 提供可重复启动的本地来源，`src/service.mjs` 组织访问入口，`src/store.mjs` 保存查看结果。`src/collector.mjs` 通过真实 Chromium 页面批量领取，`src/ledger.mjs` 保存领取台账与附件。`test/connector.test.mjs` 验证协议原语和演练源，`test/service.test.mjs` 验证服务与留存边界，`test/collector.test.mjs` 验证批量领取的归属、恢复与合并。

## 批量领取的归属规则

门户没有批量接口，领取只能按正常页面操作：点击列表行打开预览，再在预览页点击领取链接。多个窗口的附件文件名相同，归属不依赖窗口序号或文件名，只认证据链：

1. 列表行的业务键（`data-key`）；
2. 点击后实际打开的窗口（页面对象，同名窗口复用时跟踪其跳转）；
3. 预览页 DOM 声明的单据标识与 SHA256；
4. 该窗口触发的下载事件（发起页与下载地址中的单据标识）；
5. 下载字节的摘要必须与预览声明一致。

窗口复用、点击被门户提示阻止、旧预览页延后触发下载时，文件不会归到当前选中行：延后到达的下载按自身证据归入对应票据，无法建立证据的下载只记录不归属。下载完成、内容类型核对为 application/pdf、摘要与预览声明核对一致之前，该票不标记为已领取。

## 台账与恢复

台账写入数据目录的 `collection/ledger.json`，附件写入 `collection/bills/`。每票记录状态、摘要、预览声明摘要、内容类型、来源（auto/stray/manual-merge）、失败原因与冲突保留。恢复时先核对台账与既有文件：一致则跳过；文件被篡改或丢失则重新领取。人工补领的文件经预览声明核对后直接合并，不再下载；既有文件内容不同时不覆盖，改名保留并登记冲突。

生产接入地址与凭据需由部署配置给出；演练客户端拒绝访问回环以外的地址，批量领取只跟踪来源站点的页面与下载。文档中的接口不向外提供任意目标代理。异常以明确错误响应返回，接收失败不覆盖原回执。
