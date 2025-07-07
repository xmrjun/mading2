# 🚀 Backpack 智能交易系统

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2018.0.0-brightgreen)](https://nodejs.org/)

基于 **Backpack 交易所** 的智能自动化交易系统，支持单策略和双策略模式的递增买入策略。

## ✨ 核心特性

- 🎯 **灵活启动模式**：支持全新启动和历史恢复两种模式
- 📊 **智能交易策略**：递增买入、动态止盈、风险控制
- 🔄 **双启动模式**：单策略专注投入 vs 双策略分散风险  
- 📈 **实时监控**：WebSocket价格流、实时统计显示
- 🛡️ **数据同步**：修复长期运行数据不匹配问题

## 🚀 快速开始

### 1. 安装
```bash
git clone https://github.com/xmrjun/mading2.git
cd mading2
npm install
```

### 2. 配置API密钥

**编辑 `backpack_trading_config.json`**：
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

#### 🆕 **推荐启动方式**
```bash
# 正常启动（恢复历史订单）
node start_single.js

# 全新启动（清理状态，从零开始）  
node start_single.js --fresh
```

#### 🔄 **双策略模式**
```bash
# 双策略启动（需要 dual_strategy_config.json）
node start_dual.js
```

## 🎯 启动模式说明

### 正常启动
```bash
node start_single.js
```
- ✅ 恢复历史交易记录
- ✅ 保持数据连续性
- ✅ 适合系统重启后继续运行

### 全新启动 
```bash
node start_single.js --fresh
```
- 🧹 自动取消所有现有订单
- � 清理历史数据，从零开始
- ✅ 确保数据完全匹配实际余额
- 💡 **推荐场景**：手动干预后重新开始

## ⚙️ 配置说明

### 单策略配置 (`backpack_trading_config.json`)
```json
{
  "trading": {
    "tradingCoin": "BTC",           // 交易币种
    "maxDropPercentage": 7,         // 下跌7%开始买入
    "totalAmount": 2000,            // 总资金2000 USDC
    "orderCount": 8,                // 8个递增订单
    "incrementPercentage": 50,      // 递增50%
    "takeProfitPercentage": 0.25    // 止盈0.25%
  }
}
```

### 双策略配置 (`dual_strategy_config.json`)
```json
{
  "totalCapital": 5000,
  "strategy1": {
    "trading": {
      "maxDropPercentage": 0.8,     // 策略1: 小波动
      "totalAmount": 2500,
      "takeProfitPercentage": 0.06
    }
  },
  "strategy2": {
    "trading": {
      "maxDropPercentage": 1.5,     // 策略2: 大波动  
      "totalAmount": 2500,
      "takeProfitPercentage": 0.12
    }
  }
}
```

## 📊 运行效果

```
===== Backpack 自动交易系统 =====
当前时间: 7/6/2025, 5:41:48 PM
交易对: BTC_USDC
脚本启动时间: 7/6/2025, 5:41:42 PM
运行时间: 0小时0分6秒

===== 订单统计 =====
WebSocket: 已连接 (5:41:48 PM, 0秒前)
当前价格: 108944.5 USDC (来源: WebSocket轮询)
涨跌幅: ↑ 0.06%
止盈目标: 0.6%
完成进度: 10%
总订单数: 5
已成交订单: 1
成交总金额: 378.67 USDC
成交总数量: 0.003480 BTC
平均成交价: 108812.00 USDC
当前持仓价值: 378.96 USDC
盈亏金额: ↑ 0.30 USDC
盈亏百分比: ↑ 0.08%
```

## �️ 项目结构

```
├── src/                        # 源代码
│   ├── core/                   # 核心逻辑
│   ├── services/               # API服务
│   ├── models/                 # 数据模型
│   └── utils/                  # 工具库
├── logs/                       # 日志文件
├── backpack_trading_config.json # 单策略配置
├── dual_strategy_config.json   # 双策略配置
├── start_single.js             # 单策略启动脚本
├── start_dual.js               # 双策略启动脚本
└── package.json
```

## 🔧 故障排除

### 数据不匹配问题
如果系统显示的持仓与实际余额不符：
```bash
# 使用全新启动模式
node start_single.js --fresh
```

### 网络连接问题
```bash
# 检查WebSocket连接状态
# 系统会自动重连，无需手动干预
```

### 配置文件错误
```bash
# 验证JSON格式
node -e "console.log(JSON.parse(require('fs').readFileSync('backpack_trading_config.json', 'utf8')))"
```

## 🔒 安全提醒

- ⚠️ **高风险警告**：加密货币交易存在高风险
- 🔑 **API安全**：妥善保管API密钥，定期轮换
- 💰 **小额测试**：首次使用请用小额资金测试
- 📊 **持续监控**：定期检查交易状态和持仓

## � 最新更新

### v3.1.0 (2025-07-06)
- 🆕 **智能启动模式**：支持 `--fresh` 全新启动
- 🔧 **数据同步修复**：解决长期运行数据不匹配问题
- 🧹 **自动清理**：全新启动时自动取消现有订单
- 📊 **统计优化**：改进历史订单恢复和统计逻辑

## 📞 支持

- **GitHub**: [xmrjun/mading2](https://github.com/xmrjun/mading2)
- **Issues**: [报告问题](https://github.com/xmrjun/mading2/issues)

## 📄 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

## ⚠️ 免责声明

本项目仅供学习研究使用。使用者需自行承担交易风险，作者不对任何损失负责。

**投资有风险，入市需谨慎！**

---

**🌟 如果这个项目对您有帮助，请给我们一个 Star 支持！** 