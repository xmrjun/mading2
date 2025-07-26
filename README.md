# 🚀 Backpack 马丁策略交易系统

基于Backpack Exchange的智能化马丁格尔交易机器人，通过WebSocket实时监控市场，自动执行分层限价单策略，实现稳定的自动化交易。

## ⭐ 核心特性

- **🎯 马丁格尔策略** - 价格下跌时自动加仓摊低成本
- **📡 实时监控** - WebSocket实时价格和订单状态监控
- **🔄 自动循环** - 止盈后自动开启新一轮交易循环  
- **💰 资金优化** - 使用总余额(available+locked)最大化资金利用率
- **🛡️ 风险控制** - API限流、异常恢复、优雅关闭
- **📊 详细日志** - 完整的交易和错误日志记录

## 📦 项目结构

```
mading2/
├── martingale_trader.js          # 主程序入口
├── backpack_trading_config.json  # 配置文件
├── package.json                  # 项目依赖
├── logs/                         # 日志目录
└── src/                          # 源码模块
    ├── config/                   # 配置加载
    ├── core/                     # 核心交易逻辑
    ├── network/                  # WebSocket管理
    ├── services/                 # Backpack API服务
    └── utils/                    # 工具类
```

## ⚙️ 配置说明

编辑 `backpack_trading_config.json`:

```json
{
  "api": {
    "privateKey": "你的Backpack私钥",
    "publicKey": "你的Backpack公钥"
  },
  "trading": {
    "tradingCoin": "SOL",              // 交易币种 (SOL/BTC/ETH)
    "maxDropPercentage": 3.0,          // 价格下跌3%区间内分布订单
    "totalAmount": 1000,               // 参考投资金额
    "orderCount": 5,                   // 分5层递增订单
    "incrementPercentage": 25,         // 每层递增25%
    "takeProfitPercentage": 0.25       // 0.25%快速止盈
  },
  "advanced": {
    "minPositionValueThreshold": 50    // 持仓价值低于$50视为无持仓
  }
}
```

### 🔧 参数详解

| 参数 | 说明 | 示例 |
|------|------|------|
| `tradingCoin` | 交易币种 | SOL/BTC/ETH |
| `maxDropPercentage` | 价格下跌区间 | 3.0 (从当前价格向下3%) |
| `orderCount` | 订单层数 | 5 (分5个递增订单) |
| `incrementPercentage` | 金额递增比例 | 25 (每层递增25%) |
| `takeProfitPercentage` | 止盈目标 | 0.25 (0.25%收益率) |
| `minPositionValueThreshold` | 最小持仓阈值 | 50 (低于$50视为无持仓) |

## 🚀 快速开始

### 1. 环境准备
```bash
# 安装Node.js依赖
npm install

# 配置API密钥 
# 编辑 backpack_trading_config.json 设置你的API密钥
```

### 2. 启动交易
```bash
# 启动马丁策略交易器
node martingale_trader.js
```

### 3. 停止交易  
```bash
# 优雅关闭 (自动取消所有挂单)
Ctrl + C
```

## 📈 交易策略详解

### 马丁格尔核心逻辑

1. **📊 市场监控** - WebSocket实时获取SOL/USDC价格
2. **📋 分层下单** - 当前价格下方3%区间内创建5个限价单
3. **📈 递增策略** - 价格越低的订单金额越大(25%递增)
4. **🔄 自动加仓** - 订单成交时自动更新持仓成本
5. **💰 智能止盈** - 达到0.25%收益率立即卖出全部
6. **🔁 循环重启** - 止盈完成后自动开启新一轮

### 实际交易示例 (SOL @ $197.89)

```
🎯 当前SOL价格: $197.89
📋 订单分布区间: $191.75 - $197.89 (3%下跌)

订单1: 0.19 SOL @ $197.46 = $37.52 USDC
订单2: 0.23 SOL @ $196.07 = $45.10 USDC  
订单3: 0.29 SOL @ $194.69 = $56.46 USDC
订单4: 0.37 SOL @ $193.31 = $71.52 USDC
订单5: 0.47 SOL @ $191.92 = $90.20 USDC

💰 止盈条件: 平均成本 × 1.0025 (0.25%收益)
🔄 完成后: 自动开启下一轮循环
```

## 📊 系统状态监控

### 实时状态显示
```
📊 === 马丁策略详细状态 ===
⏰ 时间: 2025-07-23 11:03:25
💰 当前价格: 197.89 USDC (15秒前)
📦 持仓情况:
  SOL持仓: 1.665444 SOL
  USDC余额: 1008.76 USDC (总余额=1008.76+0.00)
📈 持仓分析:
  平均成本: 196.90 USDC
  持仓价值: 329.23 USDC  
  浮动盈亏: +0.66 USDC (+0.199%)
  止盈目标: 0.25% ⏳未达到
🔄 订单状态:
  活跃订单: 5 个
  已成交: 3 个
📊 策略统计:
  完成周期: 8 轮
  总收益: +12.45 USDC
🌐 连接状态: ✅ WebSocket已连接
```

### 日志系统
- **交易日志**: `logs/martingale_YYYY-MM-DD.log`
- **错误日志**: `logs/error_YYYY-MM-DD.log`
- **API错误**: `logs/api_error_YYYY-MM-DD.log`

## 🛡️ 安全特性

### 资金安全
- **余额验证**: 下单前严格检查余额充足性
- **订单监控**: 实时监控订单状态防止异常
- **优雅退出**: 程序关闭时自动取消所有挂单
- **错误恢复**: API失败自动重试机制

### 技术防护
- **API限流**: 智能等待避免触发交易所限制
- **WebSocket重连**: 连接断开自动重连
- **异常处理**: 完善的错误捕获和日志记录
- **资源清理**: 程序退出时清理所有资源

## 🔧 高级配置

### 精度控制
```json
"quantityPrecisions": {
  "SOL": 2,    // SOL数量2位小数
  "BTC": 5,    // BTC数量5位小数  
  "ETH": 4     // ETH数量4位小数
},
"pricePrecisions": {
  "SOL": 2,    // SOL价格2位小数
  "BTC": 0,    // BTC价格整数
  "ETH": 2     // ETH价格2位小数
}
```

### WebSocket配置
```json
"websocket": {
  "url": "wss://ws.backpack.exchange",
  "options": {
    "reconnect": true,
    "reconnectInterval": 3000,
    "maxReconnectAttempts": 10
  }
}
```

## ⚠️ 风险提示

### 交易风险
- **市场风险**: 加密货币价格波动巨大，存在本金损失风险
- **马丁风险**: 连续下跌时可能面临较大回撤
- **流动性风险**: 极端行情下可能无法及时止盈

### 技术风险
- **API风险**: 密钥泄露可能导致资金损失
- **网络风险**: 网络中断可能影响交易执行  
- **程序风险**: 软件bug可能导致意外交易

### 使用建议
- **小额测试**: 首次使用建议小额资金测试
- **持续监控**: 定期检查系统运行状态
- **风险控制**: 只投入可承受损失的资金
- **备份安全**: 妥善保管API密钥

## 🛠️ 系统要求

- **Node.js**: 14.0+ 版本
- **内存**: 至少 512MB RAM
- **网络**: 稳定的网络连接
- **交易所**: Backpack Exchange 账户
- **资金**: 建议至少 $200 USDC

## 📞 技术支持

### 常见问题
- **连接失败**: 检查API密钥和网络连接
- **订单异常**: 查看日志文件排查问题  
- **余额不足**: 确保账户有足够USDC余额
- **止盈异常**: 检查SOL余额是否充足

### 联系方式
- **GitHub**: https://github.com/xmrjun/mading2
- **Issues**: https://github.com/xmrjun/mading2/issues

---

**⚖️ 免责声明**: 
本软件仅供学习和研究使用。加密货币交易存在高风险，可能导致部分或全部资金损失。使用者应充分了解风险并为自己的交易决策承担全部责任。开发者不对任何交易损失、技术故障或其他问题承担责任。请在充分了解风险的前提下谨慎使用。