# MCP 集成说明（mcd-mcp）

> 覆盖：**实际使用的麦当劳 MCP Server（第 1 节）· Tool（第 3 节）· 调用流程（第 4 节）· 业务价值（第 5 节）**

本文件记录的连接信息、工具名、参数与返回结构，**全部来自本机 mcd-mcp 的实际探测结果或工具自身的官方声明**。未做任何推测性补充。

> 来源标注规则：
> - **【实测】** = 本会话真实调用过，返回结构已验证
> - **【自述】** = 来自 MCP 工具列表中的官方 `Description` / `Output` 段落，未经真实调用验证

---

## 1. 连接信息

| 项 | 值 |
|---|---|
| Connector | `mcd-mcp` |
| 传输 | 远程 HTTP MCP |
| Endpoint | `https://mcp.mcd.cn` |
| 鉴权 | `Authorization` 请求头（**【自述】**由 WorkBuddy 会话注入，本地脚本无法独立获取） |
| 配置文件 | `~/.workbuddy/mcp.json` → `mcpServers["mcd-mcp"]` |
| 可用工具总数 | 35 |

**关键影响**：因为凭据由会话注入，本项目的 Node 脚本**不直连 MCP**。真实数据由模型按 `SKILL.md` 调用工具获取，再以 JSON 快照形式喂给脚本做离线编排。

### 连通性验证【实测】

```bash
# 调用 now-time-info
# 返回 200，服务器时间 2026-10-12 13:08:41 GMT+08:00
# 调用 query-my-account
# 返回 200，availablePoint = 130.9（麦享会积分）
```

**统一响应信封**【实测】：

```json
{
  "success": true,
  "code": 200,
  "message": "请求成功",
  "datetime": "2026-10-12 13:08:41",
  "traceId": "82c504dab8ca962216c0b53b98981b2d",
  "data": { }
}
```

---

## 1.5 三条业务硬约束（来自 Skill 规范，不是 MCP 限制）

1. **堂食不下单。** MCP 只支持 `beType` 1/2/5/6，没有堂食下单能力。堂食场景只做「查门店 + 查菜单 + 出人—餐品清单 + 估算」，**绝不调 `create-order`**。查菜单仍可用 `query-nearby-stores(beType=1)` + `query-meals(orderType=1, beType=1)`。
2. **领券必须先取得发起人明确同意。** `auto-bind-coupons` 默认禁用。若判断某张券值得领，先说明券面内容与代价，等发起人回复「领」再调。已经躺在卡包里的券（`query-my-coupons`）无需领，但**是否适用于当前订单必须再用 `query-store-coupons` 校验**。
3. **过敏/严重忌口只做风险提示，不做安全承诺。** MCP 不返回成分表与致敏原清单，`query-meal-detail` 也只给套餐组成与特调项。因此：对高危致敏原做**保守排除**（黑名单，`ALLERGEN_BLOCKED`），排除后仍输出 `RISK_NOTICE` 要求发起人自行核对官方餐品信息，**不能声称某餐品对该成员安全**。黑名单的组映射刻意写得比实际更宽（写「坚果」也会排除含「花生」的餐品），且**不因凑单压力放宽**；共享餐品取全员黑名单并集。发起人可设 `allergenPolicy.strict=false` 降级为「仅提示」。

---

## 2. 参数推导铁律

`beType` 决定 `orderType` 与 `beCode`，这是所有工具共用的规则，传错会报错：

| beType | 含义 | orderType | beCode |
|---|---|---|---|
| 1 | 到店自取 | 1 | **不传**（传了报错） |
| 5 | 得来速 Drive Through | 1 | 必传，取自 `query-nearby-stores` |
| 2 | 麦乐送外送 | 2 | 必传，取自 `delivery-query-stores` |
| 6 | 企业团餐（本 Skill 默认） | 2 | 必传，取自 `delivery-query-stores` |

其他共用规则：
- `reservationDate`：仅预约场景传，格式 `yyyy-MM-dd HH:mm`；非预约不传。
- `takeWayCode`：仅 `orderType=1` 需要，取自 `calculate-price` 的 `data.takeWayList[].code`。
- `gmServiceCode`：团餐 `calculate-price` / `create-order` 需要，取自 `query-meal-assistance`。
- `storeCode`：必须全数字。

---

## 3. 本 Skill 使用的工具

### 3.1 时间与身份

| 工具名 | 参数 | 返回结构 | 来源 |
|---|---|---|---|
| `now-time-info` | 无 | `data.{timestamp, datetime, formatted, date, year, month, day, dayOfWeek, timezone, offset, utc}` | 【实测】 |
| `query-my-account` | 无 | `data.{accountId, availablePoint, accumulativePoint, currency, currentMouthExpirePoint, expiredPoint, frozenPoint, lastMouthExpirePoint, nextMouthExpirePoint, usedPoint}` | 【实测】 |

`now-time-info` 实测返回：

```json
{"success":true,"code":200,"message":"请求成功","datetime":"2026-10-12 13:08:41","traceId":"82c504dab8ca962216c0b53b98981b2d","data":{"timestamp":1791781721572,"datetime":"2026-10-12T13:08:41.572","formatted":"2026-10-12 13:08:41","date":"2026-10-12","year":2026,"month":10,"day":12,"dayOfWeek":"MONDAY","timezone":"GMT+08:00","offset":"+08:00","utc":"2026-10-12T05:08:41.572Z"}}
```

### 3.2 门店

| 工具名 | 必填参数 | 可选参数 | 说明 |
|---|---|---|---|
| `query-nearby-stores` | `beType`(1\|5)、`searchType`(1 收藏\|2 位置) | `city`、`keyword`（`searchType=2` 时必填） | 到店场景。`beType=1` 返回门店**无** `beCode`；`beType=5` 返回**有** `beCode` |
| `delivery-query-stores` | `addressId`、`beType`(2\|6) | — | 外送/团餐场景，按地址查可配送门店 |

返回结构【自述】：展示 `storeCode`、`beCode`（`beType=5` 时）；`reservation=true` 时含 `reservationTimeOptions`，`today=true` 标记「(今天)」。

### 3.3 地址

| 工具名 | 必填参数 | 可选参数 |
|---|---|---|
| `delivery-query-addresses` | 无 | — |
| `delivery-create-address` | `address`、`addressDetail`、`city`、`contactName`、`phone`（11 位纯数字） | `gender`（先生/女士） |

工具自述的下一步引导【自述】：团餐场景需引导用户提供**预算金额和人数**，以便计算人均预算。

### 3.4 菜单

| 工具名 | 必填参数 | 可选参数 |
|---|---|---|
| `query-meals` | `storeCode`、`orderType`、`beType` | `beCode`、`reservationDate` |
| `query-meal-detail` | `storeCode`、`orderType`、`beType`、`code` | `beCode`、`reservationDate` |

**官方团餐搭配档位**【自述，来自 `query-meals` Description】：

| 人均 | 搭配 |
|---|---|
| 20 元以下 | 小食 |
| 20–30 元 | 汉堡 + 小食 或 汉堡 + 饮料 |
| 30–40 元 | 汉堡 + 薯条/小食 + 饮料 |
| 40–50 元 | 汉堡 + 薯条 + 小食 + 饮料 |
| 50 元以上 | 丰富组合，优先不重复小食 |

**关于过敏与忌口**：`query-meals` / `query-meal-detail` 均不返回成分表或致敏原清单。忌口过滤是靠**餐品名与描述的关键字匹配**做的，属于尽力而为，**不能等同于官方成分核验**。命中过敏关键词时必须输出 `RISK_NOTICE`。

`query-meal-detail` 返回展示规则【自述】：
- `data.supportModify=true` → 商品名后标注「可特调」
- `choice.supportModify=true` → 该 choice 名后标注「可特调」
- 不主动展开特调列表，用户主动问才展示 `modification`
- 展示后总结默认选中搭配（`isDefault=1` 的 choices）

### 3.5 定价与下单

| 工具名 | 必填参数 | 可选参数 |
|---|---|---|
| `calculate-price` | `storeCode`、`orderType`、`beType` | `beCode`、`reservationDate`、`items[]`、`gmServiceCode`、`withOrder`、`needTableware` |
| `create-order` | `storeCode`、`orderType`、`beType` | `beCode`、`addressId`（orderType=2 必填）、`takeWayCode`（orderType=1 必填）、`reservationDate`、`items[]`、`remark`（≤50 字）、`needTableware`、`gmServiceCode`、`withOrder` |

`items[]` 元素字段【自述】：
- `productCode`（必填）、`quantity`（必填，≥1）
- `couponId`、`couponCode`（选用券时）
- `modification.values[][]{code, key, quantity}`
- `roundList[]{round, comboItemList[]{code, quantity, modification}}`（套餐子项）

**`modification.key` 传参规则**【自述，易错点】：
- 选中的特调项：`key` = `query-meal-detail` 返回的 `selectedKey`
- 未选中的特调项：若 `unselectedKey` 非空，`key` = `unselectedKey`，**也必须传入**
- 即：含 `unselectedKey` 的特调组，该组**所有**项都要传

**价格单位**【自述】：`calculate-price` 返回的金额字段单位为**分**，展示需除以 100 转元。

`create-order` 后续引导【自述】：「可通过支付链接扫码或打开麦当劳 APP 完成支付，支付完成后回复『支付完成』或『支付失败』，会帮您查询最新的订单状态」。

### 3.6 订单

| 工具名 | 必填参数 | 说明 |
|---|---|---|
| `query-order` | `orderId` | 订单详细信息 |
| `order-list` | 无 | 历史订单（非商城订单；商城订单用 `mall-order-list`） |
| `cancel-order` | `orderId`、`cancelReasonCode` | 1=改主意了 / 2=重复下单 / 3=点错了点多了点少了 / 4=地址电话填错 / 5=送达时间选错 / -1=其它 |

### 3.7 优惠

| 工具名 | 必填参数 | 说明 |
|---|---|---|
| `query-store-coupons` | `storeCode`、`orderType`、`beType` | **指定门店 + 订单类型下可使用的券**，下单前看券用这个 |
| `query-my-coupons` | 无（`page`、`pageSize` 可选，最多 5 页 × 200 条） | 卡包里的券。自述明确：「不进行门店、渠道、配送方式等下单规则校验，因此不承诺可用于当前订单」 |
| `available-coupons` | 无 | 当前可领取的麦麦省券列表 |
| `auto-bind-coupons` | 无 | 一键领取。**本 Skill 禁用** |

### 3.8 团餐专用（仅 `beType=6`）

| 工具名 | 必填参数 | 返回结构【自述】 |
|---|---|---|
| `query-promotions` | `storeCode`、`orderType=2`、`beType=6` | 规则列表，每条含 `promotionId`、`promotionType`、`ruleCategory`、`beTypes`、`startTime`、`endTime`、`gmServiceCode`、`products`、`ruleDetail` |
| `query-meal-assistance` | `storeCode` | 助餐服务列表，选定后取 `gmServiceCode` |

枚举含义【自述】：
- `promotionType`：31 = 满额减，33 = 订单折扣
- `ruleCategory`：30 = 满折/折扣，40 = 满减
- `products`：适用餐品，`type` 1=包含 / 2=不包含 / 3=全部，`productCode` 为餐品编码

工具自述说明：规则已过滤掉时间无效或与在售餐品无交集的；**拿到规则后由大模型自行解读优惠并计算搭配，工具不做最优推荐**。

---

## 4. 完整调用链（团餐 beType=6）

```
delivery-query-addresses                       → addressId
delivery-query-stores(addressId, beType=6)     → storeCode + beCode
query-meals(storeCode, orderType=2, beType=6, beCode)   → 在售餐品 + productCode
query-promotions(storeCode, orderType=2, beType=6, beCode) → 满减/满折规则
query-meal-detail(storeCode, orderType=2, beType=6, beCode, code) → 组成 + 特调项
query-meal-assistance(storeCode, orderType=2, beType=6, beCode)   → gmServiceCode
query-store-coupons(storeCode, orderType=2, beType=6, beCode)     → 可用券
calculate-price(... + items + gmServiceCode)   → 价格（分）+ takeWayList
create-order(... + addressId + gmServiceCode)  → orderId
query-order(orderId)                           → 订单状态
```

---

## 5. 业务价值

### 5.1 一句话

把「一群人各说一句想吃什么」这件**靠人肉来回确认、极易扯皮**的事，压缩成**一次对话 + 一张可确认的确认单**；并且全程只用麦当劳官方数据，不编造、不越权下单。

### 5.2 用到的 MCP 能力 → 解决的真实痛点

| 用到的工具 | 解决的用户痛点 | 没有它时的现状 |
|---|---|---|
| `delivery-query-addresses` / `query-nearby-stores` / `delivery-query-stores` | 「公司附近到底哪家能送/能取」 | 反复在 App 里试地址、试门店 |
| `query-meals` + `query-meal-detail` | 「菜单上有什么、套餐里含什么、能不能特调」 | 群里发截图，信息过期、看不懂套餐构成 |
| `query-promotions`（限团餐）+ `query-store-coupons` | 「满减怎么凑最划算、哪张券真能用」 | 券写着可用、下单才发现不适用 |
| `query-meal-assistance` | 团餐助餐服务、人均预算怎么定 | 不知道团餐档位，人均拍脑袋 |
| `calculate-price` | 「最后到底付多少钱、要不要餐具、配送费多少」 | 只能看到商品价，含不含配送费靠猜 |
| `now-time-info` | 预约时间是否早于当前时刻的校验 | 预约填错时间被打回 |
| `create-order`（**仅确认后**）+ `query-order` | 一键成单、随时查状态 | 需要切到 App 手动重录一遍所有人的餐 |

### 5.3 三条被 MCP 能力边界约束、但转成了产品价值的设计

1. **团餐（`beType=6`）才有多人优惠能力** → Skill 默认把「外送且人数 ≥3」路由到团餐，自动解锁满减与助餐服务，人均预算也按官方档位给建议。这是把 MCP 的能力分布直接翻译成了默认最优路径。
2. **MCP 返回价格单位是「分」、优惠按整单生效** → Skill 在本地做 AA 分账：券按各人金额比例摊，余数逐分分配保证**合计分毫不差**（已用断言锁死）。这是 MCP 没有的能力，由脚本补齐。
3. **MCP 不返回成分表与致敏原** → 不假装安全，而是做**保守黑名单排除（宁可错杀）+ 醒目风险提示**，并允许发起人显式降级。宁可让过敏成员单独点单，也不给他一份可能致命的候选。

### 5.4 相比「直接问大模型点餐」的差异

- **数据真实**：所有门店、餐品、价格、优惠都来自 MCP 实时返回，拿不到就报 `MISSING_MCP_DATA` 并指明该调哪个工具，**不编造**
- **可验证**：51 条离线断言覆盖 A–D 规范用例 + E1–E3 过敏专项，`node scripts/run-cases.mjs` 一条命令全绿
- **有确认门**：`mayCreateOrder` 是唯一放行开关，只有「已确认 + 无阻断 + 价格来自 `calculate-price` + 非堂食」才为 `true`（D 用例验证「说了确认下单也不能冲掉阻断项」）

---

## 6. 已知坑

1. **`beType=1` 传 `beCode` 会报错。** 到店自取不要传。
2. **价格单位是分。** 展示必须 /100。
3. **`takeWayCode` 只能从 `calculate-price` 拿。** 不能自己填。
4. **`query-my-coupons` ≠ 当前订单可用券。** 判断可用必须调 `query-store-coupons`。
5. **`query-promotions` / `query-meal-assistance` 只支持 `beType=6`。** 其他场景调会失败。
6. **MCP 无 AA 分账接口。** 多人分摊只能本地算 + 人工转账。
7. **优惠按整单生效，无法按人拆分。** 分账时把优惠按各人金额比例摊。
8. **无法代他人支付。** 整个团餐是一个订单、一个账号、一次支付。

---

## 7. 本 Skill 明确不调用的工具

`auto-bind-coupons`（领券）、`draw-lottery`（抽奖，消耗积分）、`mall-create-order` / `mall-points-products` / `mall-product-detail` / `mall-order-list` / `mall-order-detail`（积分商城）、`party-order-create` / `query-party-city` / `query-party-store` / `query-party-store-date` / `query-party-store-session`（派对预约）、`query-lottery-info`、`query-my-prizes`、`query-survey-coupon`、`campaign-calendar`（活动日历）、`list-nutrition-foods`（营养数据，仅在发起人问热量时可选使用）、`delivery-create-address`（新增地址需单独确认）。
