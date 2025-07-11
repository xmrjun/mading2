# 🚀 Backpack 智能交易系统

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2018.0.0-brightgreen)](https://nodejs.org/)

基于 **Backpack 交易所** 的智能自动化交易系统，采用简洁可靠的架构设计。

## 🎯 核心架构

```
🔄 API: 负责下单买进卖出
📡 WebSocket: 负责价格监控  
📝 日志: 记录交易，重启恢复
```

**就这么简单！**

## ✨ 核心特性

- 🎯 **本地日志统计** - 重启后自动恢复交易状态，数据永不丢失
- 📊 **智能交易策略** - 递增买入、动态止盈、风险控制
-  **实时价格监控** - WebSocket价格流，低延迟响应
- � **可靠性保障** - 自动重连、容错处理、状态恢复
- 🛡️ **独立运行** - 不依赖API余额查询，完全基于本地统计

## 🚀 快速开始

### 1. 安装
```bash
git clone https://github.com/xmrjun/mading2.git
cd mading2
npm install
```

### 2. 配置API密钥

编辑 `backpack_trading_config.json`：
```json
{
  "api": {
    "privateKey": "YOUR_PRIVATE_KEY",
    "publicKey": "YOUR_PUBLIC_KEY"
  },
  "trading": {
    "tradingCoin": "BTC",
    "maxDropPercentage": 7,
    "totalAmount": 2000,
    "orderCount": 8,
    "incrementPercentage": 50,
    "takeProfitPercentage": 0.25
  }
}
```

### 3. 启动交易
```bash
# 正常启动（推荐）
npm run single

# 全新启动（清理所有状态）
node start_single.js --fresh

# 双策略模式
npm run dual
```

## 🔑 关键创新：本地日志统计

### 传统方式的问题
```
❌ 重启后数据丢失
❌ 依赖API余额查询
❌ 网络问题导致状态错误
❌ 复杂的数据同步
```

### 我们的解决方案
```
✅ 本地日志记录所有交易
✅ 重启时自动读取日志恢复状态
✅ 完全基于本地数据计算盈亏
✅ 不依赖API余额查询
```

### 工作原理
```
交易执行 → 📝 写入日志 → 📊 更新统计
    ↓
重启应用 → 🔄 读取日志 → 📈 恢复状态
```

## 📊 运行效果

### 启动时的恢复过程
```bash
🔄 开始从本地日志恢复交易统计...
� 找到 3 个交易日志文件
📊 解析出 45 条交易记录
✅ 统计数据恢复完成
� 恢复结果:
   总持仓: 0.123456 BTC
   总成本: 5432.10 USDC
   平均价: 44150.25 USDC
   订单数: 12
```

### 实时交易状态
```
===== Backpack 自动交易系统 =====
当前时间: 1/15/2024, 2:30:25 PM
交易对: BTC_USDC
运行时间: 2小时15分钟

===== 实时交易状态 =====
WebSocket: 已连接 ✅
当前价格: 59244.5 USDC
涨跌幅: ↑ 0.20%
止盈目标: 0.25%
完成进度: 80%

===== 持仓统计 =====
总订单数: 5
已成交订单: 4
成交总数量: 0.004200 BTC
平均成交价: 59125.00 USDC
当前持仓价值: 248.83 USDC
盈亏金额: ↑ 0.50 USDC
盈亏百分比: ↑ 0.20%
```

## �️ 项目结构

```
├── src/
│   ├── core/                   # 核心逻辑
│   ├── services/               # API服务
│   │   └── logBasedStatsService.js  # 🔑 日志统计服务
│   ├── models/                 # 数据模型
│   └── utils/                  # 工具库
├── logs/                       # � 日志文件
│   ├── trades_2025-01-15.json  # 结构化交易日志
│   └── trading_2025-01-15.log  # 可读运行日志
├── config/                     # 配置文件
├── start_single.js             # 单策略启动
├── start_dual.js               # 双策略启动
└── package.json
```

## ⚙️ 配置说明

### 基础配置
```json
{
  "trading": {
    "tradingCoin": "BTC",           // 交易币种
    "maxDropPercentage": 7,         // 下跌7%开始买入
    "totalAmount": 2000,            // 总资金
    "orderCount": 8,                // 订单数量
    "incrementPercentage": 50,      // 递增百分比
    "takeProfitPercentage": 0.25    // 止盈百分比
  }
}
```

### 日志统计配置
```json
{
  "logBasedStats": {
    "enabled": true,                // 启用日志统计
    "logRetentionDays": 30,         // 保留天数
    "fallbackToAPI": true           // API备用方案
  }
}
```

## 🔧 故障排除

### 常见问题

#### 1. 重启后数据丢失
**现在不会发生！** 系统会自动从日志恢复所有状态。

#### 2. WebSocket连接失败
```bash
# 系统会自动重连，也可以手动重启
pm2 restart backpack-single
```

#### 3. 配置文件错误
```bash
# 验证JSON格式
node -e "console.log(JSON.parse(require('fs').readFileSync('backpack_trading_config.json', 'utf8')))"
```

## 🎮 PM2 运行支持

```bash
# 启动
pm2 start start_single.js --name "backpack-single"

# 重启（自动恢复状态）
pm2 restart backpack-single

# 管理
pm2 list
pm2 logs backpack-single
pm2 stop backpack-single
```

## 🔒 安全提醒

- ⚠️ **高风险警告** - 加密货币交易存在高风险
- 🔑 **API安全** - 妥善保管API密钥
- 💰 **小额测试** - 首次使用请用小额资金测试
- 📊 **持续监控** - 定期检查交易状态

## 🧪 测试功能

```bash
# 测试日志统计功能
node test_log_stats.js

# 查看日志文件
cat logs/trades_$(date +%Y-%m-%d).json
```

## 📝 更新日志

### v5.0.0 (2025-01-15) - 本地日志统计系统
- 🎯 **核心创新**：基于本地日志的完整统计系统
- � **自动记录**：每笔交易都记录到结构化日志
- � **完美恢复**：重启后自动读取日志恢复状态
- � **100%可靠**：不依赖API余额查询，本地日志为准
- � **双重格式**：结构化日志+可读日志
- �️ **容错处理**：日志损坏时自动跳过，不影响运行

### v4.2.0 (2025-01-15) - 对账和统计增强
- 🎯 完整启动对账系统
- � 定时对账功能
- 📊 部分成交实时统计
- � 基于统计数据止盈

### v4.1.0 (2025-01-15) - 实时持仓检查
- 🎯 实时持仓检查系统
- 🔍 智能差异检测
- ⚡ 基于真实持仓止盈

## 🌟 为什么选择我们？

1. **架构简单** - 三个组件，职责清晰
2. **数据可靠** - 本地日志，永不丢失
3. **使用简单** - 一键启动，自动恢复
4. **性能优秀** - WebSocket实时，API精准
5. **完全开源** - 代码透明，可自定义

---

**让交易变得简单可靠！** 🚀 