# CEM AI Chatbot API — 上线实测记录

- 实测时间：2026-09-11（同事确认测试环境已开通）
- 测试主机：`https://te-service-api2.cem-macau.com`
- 规范来源：`docs/cem-ai-api-spec.txt`（AlphaSolution《CEM AI API 规范》）
- 结论一句话：**两个接口都已可用，端到端跑通；规范里有两处参数与网关实际不符，另有
  一个后端 500 缺陷，本文件逐条记下实测值，避免下次照文档改回。**

## 1. 可用性总览

| 接口 | 实测 | 说明 |
|---|---|---|
| `GET /api/contract/all/ai/{lang}` | ✅ HTTP 200，115 KB，约 0.9 s | `isSuccess:true`，`data.no_ca="151"`，`caInfo` 数组长度 151、合约号互不重复 |
| `GET /api/bill/{合約號}/ai/{lang}` | ✅ HTTP 200，约 0.6 KB，约 0.6 s | 真实合约号返回 `data.status:"OK"`、`err_code:"1000"`、`billInfo[0]` |
| 不存在的合约号 | ❌ HTTP 500，722 KB HTML | 见第 4 节，后端缺陷 |
| `?withAddress=...` | ❌ HTTP 422 | 见第 3 节，任何取值都被拒 |
| `?level=3` | ❌ 25 s 无响应 | 见第 3 节 |

鉴权：**无需任何请求头**，直接 GET 即可（与规范一致）。

## 2. 合约清单接口

`GET /api/contract/all/ai/zh` 返回 `data.caInfo[]`，每项字段（实测全量键）：

```
key, ca_no, name, tariff_class, nickname, bill_month, print_doc,
issue_date, due_date, next_read_date, units, amount, paid, paid_code,
ca_group, ca_group_code, ca_lang, ca_lang_code, ca_residential,
ca_residential_code, ca_restrict, ca_restrict_code, ca_enable,
ca_enable_code, ca_terminated, ca_ebill, ca_ebill_code,
ca_notification, ca_notification_code, ca_eis
```

样例（首条）：`ca_no:"0070878510"`、`tariff_class:"A1"`、`units:"284"`、
`amount:"200"`、`paid:"已繳費"`。

**注意**：这是测试环境，一次返回 151 张合约。客服回答不能整屏贴表，preset 已约束为
「先报总数 + 需要缴费的几笔，其余引导访客给合约号逐笔查」。

## 3. 账单接口

`GET /api/bill/0070878510/ai/zh` 返回 `data.billInfo[0]`，实测键（`level=1`，24 个）：

```
contractAccountNo, billingMonth, issueDate, dueDate, avoidDisconnectionDate,
consumption, printDoc, paymentStatus, dueAmount, oddAmount, balance,
nextMonthBegin, nextMonthEnd, monthBegin, monthEnd, meterReadingType,
gsUsed, gsRemains, billType, finalBill, bimsgCode, autopayDate, discVar,
AMIDisconType
```

**查询参数实测**：

| 参数 | 结果 |
|---|---|
| 不传 | ✅ 24 键 |
| `level=1` | ✅ 24 键（与不传相同） |
| `level=2` | ✅ 25 键（多 `disconnectionStatus`） |
| `level=5` | ✅ 25 键（多 `installationAddress`、`streetName`、`buildingName`） |
| `level=3` | ❌ 25 s 无响应（超时） |
| `withAddress=true` | ❌ HTTP 422 |
| `withAddress=false` | ❌ HTTP 422 |
| `withAddress=1` | ✅ 200，多地址字段 |
| `withAddress=0` | ✅ 200，同不传 |

`withAddress` 报错原文：

```json
{"isSuccess":false,"message":"The given data was invalid.",
 "exception":"Illuminate\\Validation\\ValidationException",
 "data":{"withAddress":["The with address field must be true or false."]}}
```

规范写的是 `withAddress: true|false`，但网关的布尔校验不认 `true`/`false`，只认 `1`/`0`
——校验文案与实际行为互相矛盾，属后端参数映射缺陷。

**因此 preset 里只使用实测可用的形式**：`level=1|2|5`，不传 `withAddress`。
`level=5` 已能拿到地址，需要地址时用它即可。

## 4. 后端缺陷：不存在的合约号返回 500 + 722 KB HTML

```
GET /api/bill/0001148907/ai/zh   →  HTTP 500, 722459 B, text/html; charset=UTF-8
```

返回的是 Laravel 调试页（非 JSON），异常：

```
TypeError: App\Http\Controllers\BillServiceController::failedJsonFromApiResponse():
  Argument #2 ($response) must be of type App\Services\CEM\Response\ApiResponseInterface,
  null given, called in /var/www/html/app/Http/Controllers/BillServiceController.php on line 159
in file /var/www/html/app/Http/Controllers/ServiceControllerTraits.php on line 44
```

zh/en/pt 三种语言、任意不存在的合约号均可复现。上游 CEM 查询返回 null 后，控制器把
null 传给了要求 `ApiResponseInterface` 的失败处理函数，崩在错误处理路径上——**该缺陷
还把 Laravel 调试页连堆栈一起暴露给了调用方**，生产环境应当同时修掉这两点（返回
规范信封 `9997/9999` + 关闭 debug 页）。

客服侧的防护（已实现）：`api-client` 的 `maxResponseBytes` 默认 256 KB，722 KB 的
HTML 会先被拦下并抛错，agent 看不到任何可用内容，配合 preset 的「不编造、礼貌兜底」
契约，访客得到的是「暂时查不到，请核对合约号或致电客服热线」。已实测验证。

## 5. 端到端实测（经容器 `/api/guest/chat`）

| 场景 | 耗时 | 结果 |
|---|---|---|
| zh 查某合约账单 | 8.5 s | 金额 `MOP 30.00`、到期日 `2026-04-17`、用电量 `175 kWh`、状态未缴，与接口原值一致 |
| zh 问名下合约 | 8.2 s | 报出总张数与缴费状态，引导提供合约号 |
| en 问 due amount/due date | 10.9 s | 全英文回答，数值一致 |
| zh 查不存在的合约号 | 13.1 s | 礼貌兜底，无任何编造金额 |

语言段按界面语言切换（zh/en/pt），三种语言接口均返回 200。

## 6. 复现命令

```sh
# 合约清单
curl -s "https://te-service-api2.cem-macau.com/api/contract/all/ai/zh" | head -c 300

# 账单
curl -s "https://te-service-api2.cem-macau.com/api/bill/0070878510/ai/zh"

# 不存在的合约号（复现 500）
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' \
  "https://te-service-api2.cem-macau.com/api/bill/0001148907/ai/zh"
```

## 7. 给同事的待办

1. `withAddress` 布尔校验改成接受 `true`/`false`（现在只认 `1`/`0`），或在规范里改成
   `withAddress: 1|0`——二者必须对齐。
2. `level=3` 在测试环境无响应，确认是上游慢还是路由未接。
3. 合约号不存在时应返回规范信封（`9997` CEM API 错误），而不是 500 + Laravel 调试页；
   生产环境请同时确认 `APP_DEBUG=false`。
