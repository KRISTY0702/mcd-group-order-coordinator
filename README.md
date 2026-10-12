# 麦友多人点餐协调员 · mcd-group-order-coordinator

## 项目介绍

把「几个人各说一句想吃什么」变成「一个可确认、可分摊、可下单的麦当劳订单方案」。

基于已连接的 **mcd-mcp**（麦当劳官方 MCP）。外送且人数 ≥3 时默认走**企业团餐通道（beType=6）** —— 这是唯一同时提供官方搭配档位、满减满折规则（`query-promotions`）和助餐服务（`query-meal-assistance`）的链路。到店自取走 `beType=1`；**堂食只出清单，不支持下单**。

---

## 目标用户

- **办公室拼单的组织者**：4–10 人午餐/下午茶，需要汇总口味、算人均、避免重复点单
- **宿舍/合租夜宵的发起人**：人多嘴杂、有人忌口、有人「随便」，需要一个能推动收敛的方案
- **亲友出行的买单人**：一边要照顾老人小孩的口味与过敏，一边要控制预算
- **多人聚餐的协调者（到店自取/堂食）**：只需要一张准确的「人—餐品」清单带到店里
- **Agent/Skill 开发者**：想参考一个「多约束（预算+忌口+过敏+优惠+确认门）LLM 编排 + 离线可验证脚本」的完整范例

**共同前提**：使用者是**一个人**（发起人），他代替或已经收集了其他人的偏好。本 Skill 不代替群成员作真实授权或支付确认。

---

## 它做什么

1. **补齐信息**：就餐方式、地点、人数与称呼、每人偏好忌口、是否共享小食/餐具、期望时间
2. **征集偏好**：发起人还没收集时，生成可直接转发群聊的模板，让他贴回回复
3. **查门店与菜单**：`query-nearby-stores` / `delivery-query-stores` → `query-meals` → `query-meal-detail`
4. **建「人—餐品」映射**：每人 2–3 个候选，按官方团餐档位 + 忌口过滤；「随意」的成员匹配群体主流口味并标「待本人确认」
5. **识别冲突**：预算超限、忌口/过敏风险、售罄、券不可用、参数配对
6. **试算与三方案**：首选 + 「更稳妥」+「更丰富」，用 `calculate-price` 拿真实总价
7. **展示结构化确认单**，**等发起人明确说「确认下单」**才创建订单

## 它不做什么

- **不代替群成员作真实授权或支付确认** —— 只服务发起人一人，其他成员的「同意」都是发起人转述
- **不声称餐品对过敏人群绝对安全** —— 过敏/严重忌口走「高危致敏原黑名单」保守排除 + 醒目风险提示，仍要求自行核对官方餐品信息
- **不代付款、不代分摊转账**（MCP 无 AA 接口）
- **不自动领券**（`auto-bind-coupons` 禁用）；建议领券必须先取得明确同意
- **不新建地址**（`delivery-create-address` 需发起人明确要求并单独确认）
- **不抽奖、不兑换积分、不预约派对**
- **不编造任何餐品、库存、价格、优惠、门店** —— 拿不到就报 `MISSING_MCP_DATA` 并指明要调哪个工具
- **堂食不创建订单** —— MCP 无堂食下单能力，只出清单供现场点单

---

## 目录

```
mcd-group-order-coordinator/
├── SKILL.md                       主入口：目标/非目标、信息收集、群聊模板、
│                                  10 步工具调用顺序、确认单格式、异常处理、A–D 用例
├── README.md                      本文件
├── MCP_INTEGRATION.md             MCP Server / Tool / 调用链 / 业务价值 / 参数推导铁律
├── CONTEST_DECLARATION.md         参赛声明（官方原文，文件名与内容均不可改动）
├── workbuddy.md                   WorkBuddy 开发过程对话上下文（专项奖励核验用）
├── scripts/
│   ├── coordinate.mjs             协调主体：候选、冲突、三方案、AA 分账、确认单渲染
│   ├── validate-plan.mjs          下单前自检（退出码 0/1）
│   └── run-cases.mjs              A–D 验证用例离线执行器
├── schemas/
│   ├── group-request.schema.json  发起人输入契约（金额单位元）
│   └── order-plan.schema.json     方案输出契约
├── examples/
│   ├── group-request.example.json        发起人输入样例（可直接改）
│   └── mcd-snapshot.example.json         MCP 快照样例（哨兵值，需替换）
└── tests/
    └── cases.json                 A–D 用例定义 + 标注为测试数据的夹具
```

---

## 安装方法

**前置条件**

| 项 | 要求 |
|---|---|
| WorkBuddy | 已安装桌面端 |
| Node.js | **≥ 18**（本机实测 v22.22.2；仅用内置模块，**零第三方依赖，无需 `npm install`**） |
| 连接器 | `mcd-mcp` 已连接并在连接器管理中「信任」启用（远程 HTTP MCP，`https://mcp.mcd.cn`） |
| 账号 | 麦当劳账号已登录（`query-my-account` 能返回积分即视为已登录） |

**安装（用户级，所有项目可用 —— 推荐）**

```bash
# 1. 把整个目录放进用户级 skills 目录
mkdir -p ~/.workbuddy/skills
cp -R /path/to/mcd-group-order-coordinator ~/.workbuddy/skills/

# 2. 赋予脚本可执行权限（可选）
chmod +x ~/.workbuddy/skills/mcd-group-order-coordinator/scripts/*.mjs

# 3. 验证：应输出 51 通过 / 0 失败
cd ~/.workbuddy/skills/mcd-group-order-coordinator
node --check scripts/coordinate.mjs && node scripts/run-cases.mjs
```

装好后**新开一个 WorkBuddy 会话**，说「用麦友多人点餐协调员帮我拼单」即可触发。

**安装（项目级，仅当前工作区）**：放到 `{你的工作区}/.workbuddy/skills/mcd-group-order-coordinator/`，步骤同上。

**卸载**：删除对应目录即可，不会残留任何数据（Skill 不写数据库、不缓存凭据）。

**配置说明**：本 Skill 不写任何配置文件，不含 Token/密钥。`mcd-mcp` 的凭据由 WorkBuddy 会话在运行时注入到 `~/.workbuddy/mcp.json` 的 `mcpServers["mcd-mcp"]`，脚本**不读取也不直连**，符合参赛声明的「配置文件仅使用环境变量占位符」要求。

---

## 使用示例：两种用法

### A. 在 WorkBuddy 里直接用（主要用法）

已安装在用户级 skills 目录，直接在会话里说：

> 帮我给 4 个同事点麦当劳午餐，公司在广州琶洲，总预算 150，小李不吃辣，小张不吃牛肉，AA。

模型按 `SKILL.md` 走：补齐缺失信息 → 查门店菜单 → 建映射 → 试算 → 展示确认单，**最后等你明确说「确认下单」**才调 `create-order`。

如果发起人还没收集大家意见，先给这段转发模板：

```
【麦当劳拼单】请按以下格式回复：昵称｜主食偏好/想吃的餐品｜忌口或不吃｜饮品及甜度/冰量｜预算（可选）｜随意则写"随意"。例：小王｜牛肉堡｜不要辣、不吃洋葱｜可乐少冰｜35元。
```

### B. 本地跑脚本

脚本**纯离线**，不连 MCP、不发网络请求。消费的是你（或模型）从 MCP 拿到的真实 JSON 快照。

```bash
cd ~/.workbuddy/skills/mcd-group-order-coordinator

# 1) 生成方案（首选 / 更稳妥 / 更丰富）+ 控制台渲染确认单
node scripts/coordinate.mjs \
  --request  examples/group-request.example.json \
  --snapshot examples/mcd-snapshot.example.json \
  --out      out/order-plan.json \
  --render

# 2) 指定某人选第 N 个候选（可重复）
node scripts/coordinate.mjs --request ... --snapshot ... --render \
  --pick 小王=1 --pick 小李=0

# 3) 下单前自检（退出码 0 通过 / 1 阻断）
node scripts/validate-plan.mjs --plan out/order-plan.json

# 4) 跑 A–D 验证用例
node scripts/run-cases.mjs
```

---

## 就餐方式与下单能力

| 就餐方式 | beType | orderType | 能否下单 | 说明 |
|---|---|---|---|---|
| 外送（麦乐送） | 2 | 2 | 能 | 需 `addressId` |
| 外送（企业团餐，≥3 人默认） | 6 | 2 | 能 | 需 `addressId` + `gmServiceCode`；解锁满减与助餐服务 |
| 到店自取 | 1 | 1 | 能 | **不传 `beCode`**；需 `takeWayCode` |
| 得来速 | 5 | 1 | 能 | 需 `beCode` + `takeWayCode` |
| **堂食** | — | — | **不能** | 只出清单与估算，**绝不调 `create-order`** |

---

## 数据契约

### 输入 1：group-request（发起人填，金额单位元）

`scene` / `diningMode` / `headcount` / `totalBudget` / `location{city,keyword}` / `reservationDate` / `shareSnacks` / `needTableware` / `allergenPolicy{strict}` / `members[]{name, main, taste, avoid[], drink, budgetCap, flexible}`

`allergenPolicy.strict` 默认 `true`（命中致敏原即排除）；显式设为 `false` 时降级为「仅提示不排除」，但风险提示照给。

完整定义见 `schemas/group-request.schema.json`，样例见 `examples/group-request.example.json`。

### 输入 2：mcd-snapshot（MCP 真实返回，金额单位分）

| 字段 | 来源工具 |
|---|---|
| `store.{name,storeCode,beCode,beType,orderType}` | `delivery-query-stores` 或 `query-nearby-stores` |
| `addressId` | `delivery-query-addresses` |
| `gmServiceCode` | `query-meal-assistance` |
| `meals[]{code,name,priceFen,category,soldOut,desc}` | `query-meals`（`category` 按 汉堡/小食/薯条/饮料/甜品 归类） |
| `promotions[]` | `query-promotions`（规范化为 `{type, thresholdFen, offFen\|rateBp}`） |
| `coupons[]` | `query-store-coupons`（含 `applicable` 判定） |
| `fees.{deliveryFen,tablewareFen}` | `calculate-price` |
| `nowTime` | `now-time-info` |
| `priceResult.{subtotalFen,discountFen,deliveryFen,tablewareFen,totalFen}` | `calculate-price` |

**哨兵机制**：`examples/mcd-snapshot.example.json` 里所有 MCP 字段都是 `__FILL_FROM_<工具名>__`。脚本遇到会报 `MISSING_MCP_DATA` 并告诉你该调哪个工具，**不会替你编**。

**金额口径**：给了 `priceResult` → `priceSource="calculate-price"`，金额权威；没给 → `priceSource="ESTIMATE"`，仅用于方案对比，`readyToOrder` 恒为 false。

### 输出：order-plan

`store` / `diningMode` / `tier` / `money` / `members[]{chosen, candidates, splitYuan, status, risk}` / `shared` / `conflicts[]` / `alternatives[]` / `readyToOrder` / `mayCreateOrder` / `requiresHumanConfirmation` / `createOrderDraft`

`createOrderDraft` 的字段名与 `create-order` 的真实参数名一致，可直接透传。
**`mayCreateOrder` 是唯一放行开关**：只有「已确认 + 无阻断冲突 + 金额来自 `calculate-price` + 非堂食」时才为 `true`。

---

## 冲突与提示代码

| 代码 | 级别 | 含义 |
|---|---|---|
| `MISSING_MCP_DATA` | 阻断 | 快照缺字段，需补调 MCP |
| `STORE_PARAM_MISMATCH` | 阻断 | `beType`/`orderType`/`beCode` 配对错误 |
| `NO_CANDIDATE` | 阻断 | 该成员无可用候选 |
| `AVOID_CONFLICT` | 阻断 | 候选命中成员忌口 |
| `PER_PERSON_OVER_CAP` | 阻断 | 超该成员个人上限 |
| `BUDGET_EXCEEDED` | 阻断 | 合计超总预算 |
| `TIME_CONFLICT` | 阻断 | 预约时间格式错或早于当前 |
| `DINE_IN_NOT_ORDERABLE` | 阻断 | 堂食不支持下单，仅出清单 |
| `ALLERGEN_BLOCKED` | 提醒 | 高危致敏原黑名单命中，已排除 N 件餐品（指名到成员）；共享餐品取全员并集 |
| `SOLD_OUT` | 提醒 | 餐品售罄，已排除 |
| `NO_BUDGET` | 提醒 | 未设总预算 |
| `PRICE_NOT_AUTHORITATIVE` | 提醒 | 金额为估算，非 `calculate-price` |
| `RISK_NOTICE` | 提醒 | 过敏/严重忌口，需自行核对官方信息 |
| `COUPON_CONSENT_REQUIRED` | 提醒 | 涉及领券建议，需发起人明确同意 |
| `HEADCOUNT_MISMATCH` | 提醒 | `headcount` 与成员数不符 |

---

## 怎么验证

### 本地验证（不需要网络、不碰账户）

```bash
cd ~/.workbuddy/skills/mcd-group-order-coordinator

# 1. 语法自检（无第三方依赖，Node ≥ 18）
node --check scripts/coordinate.mjs \
  && node --check scripts/validate-plan.mjs \
  && node --check scripts/run-cases.mjs && echo "语法 OK"

# 2. A–D 验证用例（全部通过）
node scripts/run-cases.mjs

# 3. 哨兵保护验证：应报出大量 MISSING_MCP_DATA / STORE_PARAM_MISMATCH
node scripts/coordinate.mjs \
  --request examples/group-request.example.json \
  --snapshot examples/mcd-snapshot.example.json \
  --out out/order-plan.json --render

# 4. 自检脚本应「未通过」且退出码 1
node scripts/validate-plan.mjs --plan out/order-plan.json; echo "exit=$?"
```

第 3 步**预期输出一堆阻断冲突**并且末尾写「不得下单」—— 这正说明防编造机制生效。第 4 步预期 `exit=1`。

想验证「通过」路径：把 `examples/mcd-snapshot.example.json` 里的哨兵换成真实 MCP 返回（含 `priceResult`），并在 request 里加 `"confirmed": true`；自检全 PASS 且 `exit=0`。

### 在 WorkBuddy 中验证

1. 确认连接器 `mcd-mcp` 已连接：
   > 调用 now-time-info 看服务器时间

2. 让 Skill 走只读流程（**不下单**）：
   > 用麦友多人点餐协调员规划一下：广州，3 人，到店自取，总预算 110，小李不吃辣，小张对洋葱敏感。**先别下单，只出方案。**

3. 核对它是否展示了真实 `storeCode`、餐品名与价格来自 `query-meals`、洋葱风险被醒目提示、并且**停在确认单等你确认**。

4. 只有你明确说「确认下单」，它才应调用 `create-order`。

### A–D 用例覆盖

| 用例 | 场景 | 离线断言 |
|---|---|---|
| **A** | 4 人办公室午餐（不吃辣 / 素食 / 只要饮料 / 随意），外送 | 偏好整理、不下单 |
| **B** | 3 人到店自取，1 人对洋葱敏感 | 风险提示、不传 `beCode`、候选方案 |
| **C** | 菜品售罄 + 优惠券不可用 | 售罄排除、券不套用、重新计算 |
| **D** | 未说「确认下单」/ 说了「确认下单」 | `mayCreateOrder` false / true |
| **E1** | 坚果过敏 + 含花生餐品 | 组映射生效；不过度扩大到无过敏成员 |
| **E2** | 麸质过敏 → 汉堡全被排除 | `NO_CANDIDATE` + 「不要为凑单放宽黑名单」 |
| **E3** | `allergenPolicy.strict=false` | 只提示不排除，风险提示照给 |

---

## 已知限制

- 麦当劳 MCP 绑定**单个账号**，多人点餐只能合并成一个订单，分摊靠人工转账
- 优惠按整单生效，无法按人拆；分账时按各人金额比例摊，余数逐分分配
- `query-promotions` / `query-meal-assistance` 仅 `beType=6` 可用
- `calculate-price` 返回金额单位为**分**，脚本内部统一按分计算，展示转元
- **过敏与交叉污染无法验证**：MCP 不返回成分与致敏原清单。因此用「高危致敏原黑名单」做**保守排除**（宁可错杀）—— 麸质组会排除所有含「堡/卷/饼/面包」的餐品，可能导致该成员无候选。这是刻意行为，不因凑单压力放宽；排除后仍需自行核对官方成分
- **堂食无下单能力**：MCP 只支持外送、到店自取、得来速
