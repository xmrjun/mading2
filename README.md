# 🚀 Backpack 智能交易系统

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2018.0.0-brightgreen)](https://nodejs.org/)

基于 **Backpack 交易所** 的智能自动化交易系统，支持单策略和双策略模式的递增买入策略。

## ✨ 核心特性

- 🎯 **灵活启动模式**：支持全新启动和历史恢复两种模式
- 🔄 **自动对账系统**：启动时自动校验余额与统计一致性，强制同步
- 📊 **智能交易策略**：递增买入、动态止盈、风险控制
- 🔄 **双启动模式**：单策略专注投入 vs 双策略分散风险  
- 📈 **实时监控**：WebSocket价格流、实时统计显示
- 🛡️ **数据同步**：彻底解决重启后数据不匹配问题
- 🎯 **实时持仓检查**：基于真实持仓的智能止盈，防止手动卖出导致的问题

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
  },
  "reconciliation": {
    "enabled": true,
    "autoSyncOnStartup": true,
    "forceSync": true,
    "logDetailedReport": true,
    "tolerances": {
      "BTC": 0.0001,
      "ETH": 0.001,
      "SOL": 0.01,
      "DEFAULT": 0.0001
    }
  }
}
```

### 3. 启动交易

#### 🆕 **推荐启动方式**
```bash
# 正常启动（恢复历史订单 + 自动对账）
npm run single

# 全新启动（清理状态，从零开始）  
node start_single.js --fresh
```

#### 🔄 **双策略模式**
```bash
# 双策略启动（需要 dual_strategy_config.json）
npm run dual
```

#### 🧪 **测试对账功能**
```bash
# 独立测试对账功能
npm run test-reconciliation

# 自动测试（跳过确认）
npm run test-reconciliation-auto
```

## 🎯 启动模式说明

### 正常启动（推荐）
```bash
npm run single
```
**执行流程**：
1. ✅ 恢复历史交易记录
2. 🔍 **自动对账**：比较交易所余额与本地统计
3. ⚡ **智能同步**：自动校正数据差异
4. 📊 生成详细对账报告
5. 🚀 正常启动交易策略

**对账处理策略**：
- **余额 > 统计**：使用历史买入均价补充虚拟买单
- **余额 < 统计**：强制调整为真实余额（可能有手动卖出）
- **余额 = 统计**：确认数据一致，正常启动

### 全新启动 
```bash
node start_single.js --fresh
```
- 🧹 自动取消所有现有订单
- 🔄 清理历史数据，从零开始
- ✅ 确保数据完全匹配实际余额
- 💡 **推荐场景**：手动干预后重新开始

### 自动对账系统

**每次启动时自动执行**：
```
启动时执行
    ↓
1. 获取交易所真实余额
    ↓
2. 加载本地统计数据
    ↓
3. 计算差异并判断
    ↓
4. 执行智能同步策略
    ↓
5. 生成对账报告
    ↓
完成初始化
```

**示例对账输出**：
```
🔄 开始执行启动对账...

===== 启动自动对账系统 =====
🔍 对账检查结果:
   交易所真实余额: 0.004200 BTC
   本地统计数量: 0.004000 BTC
   差异: 0.000200 BTC
   允许误差: 0.000100 BTC

⚠️  检测到差异，开始强制同步...
📈 余额大于统计，可能原因: 部分成交记录未统计

📝 使用现有买入均价补充虚拟买单:
   补充数量: 0.000200 BTC
   参考价格: 59125.00 USDC
   补充金额: 11.83 USDC

✅ 对账完成，统计数据已自动校正
```

### 实时持仓检查系统

**核心功能**：防止手动卖出导致的止盈失效问题

**工作原理**：
```
每次价格更新时
    ↓
1. 获取交易所真实持仓
    ↓
2. 对比本地统计持仓
    ↓
3. 如果差异 > 阈值
    ↓
4. 自动校正本地统计
    ↓
5. 基于真实持仓计算止盈
```

**解决的问题**：
- ✅ 用户手动卖出50%，系统自动检测并调整
- ✅ 真实持仓为0时，自动跳过止盈检查
- ✅ 基于真实持仓计算止盈，确保准确性
- ✅ 显示详细的持仓差异和校正信息

**示例输出**：
```
🔄 检测到持仓差异: 本地统计 0.500000 vs 真实持仓 0.250000 (差异50.0%)
✅ 已校正本地统计: 持仓数量 0.250000 BTC
🎯 止盈检查: 当前涨幅 0.400% | 目标 0.25% | 进度 160.0%
   真实持仓: 0.250000 BTC | 平均价格: 50000.00 USDC
🎉 止盈条件达成！预计盈利: $25.00
```

## 🔧 核心功能详解

### 1. 完整启动对账系统

**原理**：余额为准，强制补齐包括均价和订单数

```javascript
// 对账框架（按您的要求实现）
async function reconcilePosition() {
    // 1. 查余额
    const realAmount = await api.getBalance('BTC');
    
    // 2. 查本地统计
    const statsAmount = tradeStats.totalFilledQuantity;
    
    // 3. 如不一致，强制补齐
    if (Math.abs(realAmount - statsAmount) > 1e-8) {
        // 🔑 关键：用余额为准，补齐均价和订单数
        const avgPrice = tradeStats.averagePrice || getCurrentMarketPrice();
        const patchAmount = (realAmount - statsAmount) * avgPrice;
        
        tradeStats.totalFilledQuantity = realAmount;
        tradeStats.totalFilledAmount += patchAmount;
        tradeStats.averagePrice = tradeStats.totalFilledAmount / tradeStats.totalFilledQuantity;
        tradeStats.filledOrders += 1; // 虚拟补单
    }
}
```

### 2. 部分成交实时统计

**原理**：每次成交变化都实时更新统计，不等订单完成

```javascript
// 检测部分成交
if (apiFilledQuantity > previousFilledQuantity) {
    const newFilledQuantity = apiFilledQuantity - previousFilledQuantity;
    const newFilledAmount = apiFilledAmount - previousFilledAmount;
    
    // 🔑 关键：实时更新统计数据（只统计新增部分）
    tradeStats.updatePartialFillStats(orderId, newFilledQuantity, newFilledAmount);
}
```

### 3. 基于统计数据止盈

**原理**：只要有持仓+均价就监控，不依赖订单列表

```javascript
// 🔑 修复前：依赖订单列表
if (this.tradeStats.filledOrders > 0 && this.running) {
    // 只有订单列表有数据才止盈
}

// ✅ 修复后：基于统计数据
if (this.tradeStats.totalFilledQuantity > 0 && this.tradeStats.averagePrice > 0) {
    // 只要有持仓和均价就监控止盈
    const profitPercent = (currentPrice - averagePrice) / averagePrice * 100;
    if (profitPercent >= takeProfitPercent) {
        // 执行止盈
    }
}
```

### 4. 异常情况处理

**有余额但均价为0的情况**：

```
🚨 [ERROR] 当前BTC有余额但均价为0，止盈/统计功能已暂停！
📢 [ERROR] 请手动补录买入均价或重置tradeStats！
🔧 [ERROR] 解决方案：使用 --fresh 重新开始或手动设置均价
```

**手动设置均价方法**：

```javascript
// 在应用运行时调用
await app.setManualAveragePrice(50000); // 设置均价为50000 USDC
```

### 5. 定时对账功能

**自动执行**：每小时检查一次，防止长期脱节

```
🕐 启动定时对账功能，间隔: 60 分钟
🔄 [定时对账] 开始执行定时对账...
✅ [定时对账] 数据一致，无需同步
```

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
  },
  "reconciliation": {
    "enabled": true,                // 启用自动对账
    "autoSyncOnStartup": true,      // 启动时自动执行
    "forceSync": true,              // 强制同步差异
    "logDetailedReport": true,      // 记录详细报告
    "tolerances": {                 // 允许误差范围
      "BTC": 0.0001,               // BTC精度
      "ETH": 0.001,                // ETH精度
      "SOL": 0.01,                 // SOL精度
      "DEFAULT": 0.0001            // 默认精度
    }
  },
  "advanced": {
    "realTimePositionCheck": true,  // 启用实时持仓检查
    "positionDifferenceThreshold": 5 // 持仓差异阈值(%)
  }
}
```

### 完整对账和统计增强配置
```json
{
  "reconciliation": {
    "enabled": true,                     // 启用对账功能
    "autoSyncOnStartup": true,           // 启动时自动对账
    "scheduledReconciliation": true,     // 启用定时对账
    "scheduledIntervalMinutes": 60,      // 对账间隔(分钟)
    "forceSync": true,                   // 强制同步差异
    "logDetailedReport": true            // 详细日志
  }
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
当前时间: 1/15/2024, 2:30:25 PM
交易对: BTC_USDC
脚本启动时间: 1/15/2024, 2:30:18 PM
运行时间: 0小时0分7秒

===== 自动对账完成 =====
✅ 对账通过，数据一致性良好
总持仓: 0.004200 BTC
总成本: 248.33 USDC
平均价: 59125.00 USDC

===== 实时交易状态 =====
WebSocket: 已连接 (2:30:25 PM, 0秒前)
当前价格: 59244.5 USDC (来源: WebSocket)
涨跌幅: ↑ 0.20%
止盈目标: 0.25%
完成进度: 80%
总订单数: 5
已成交订单: 4
成交总金额: 248.33 USDC
成交总数量: 0.004200 BTC
平均成交价: 59125.00 USDC
当前持仓价值: 248.83 USDC
盈亏金额: ↑ 0.50 USDC
盈亏百分比: ↑ 0.20%
```

## 🛠️ 项目结构

```
├── src/                        # 源代码
│   ├── core/                   # 核心逻辑
│   ├── services/               # API服务
│   │   └── reconciliationService.js  # 对账服务
│   ├── models/                 # 数据模型
│   └── utils/                  # 工具库
├── logs/                       # 日志文件
├── test_reconciliation.js      # 对账功能测试脚本
├── RECONCILIATION_EXAMPLE.md   # 对账使用示例
├── backpack_trading_config.json # 单策略配置
├── dual_strategy_config.json   # 双策略配置
├── start_single.js             # 单策略启动脚本
├── start_dual.js               # 双策略启动脚本
└── package.json
```

## 🔧 故障排除

### 对账相关问题

#### 1. 对账失败：无法获取余额
**原因**：API权限不足或网络问题  
**解决**：
```bash
# 检查API密钥权限
# 确保网络连接正常
```

#### 2. 差异过大导致对账异常
**原因**：长期未运行或大量手动操作  
**解决**：
```bash
# 检查交易所操作历史，确认差异原因
# 使用测试脚本验证
npm run test-reconciliation
```

#### 3. 无法获取参考价格进行对账
**原因**：本地无买入记录且无法获取市场价格  
**解决**：
```bash
# 确保有历史买入记录
# 检查网络连接和API访问
```

### 数据不匹配问题
如果系统显示的持仓与实际余额不符：
```bash
# 启动时会自动对账并校正
npm run single

# 或使用全新启动模式
node start_single.js --fresh

# 测试对账功能
npm run test-reconciliation
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

## 🎮 PM2 运行支持

完全支持 PM2 进程管理：

```bash
# 启动
pm2 start start_single.js --name "backpack-single"
pm2 start start_dual.js --name "backpack-dual"

# 重启时自动对账
pm2 restart backpack-single  # 重启时会自动执行对账

# 管理
pm2 list
pm2 logs backpack-single
pm2 stop backpack-single
```

## 🔒 安全提醒

- ⚠️ **高风险警告**：加密货币交易存在高风险
- 🔑 **API安全**：妥善保管API密钥，定期轮换
- 💰 **小额测试**：首次使用请用小额资金测试
- 📊 **持续监控**：定期检查交易状态和持仓
- 🛡️ **数据安全**：对账功能仅调整本地统计，不执行实际交易

## 📝 最新更新

### v4.2.0 (2025-01-15) - 完整对账和统计增强系统
- 🎯 **完整启动对账**：余额为准，强制补齐均价和订单数（绝不只补数量）
- 🕐 **定时对账功能**：每小时自动执行，防止长期运行脱节
- 📊 **部分成交实时统计**：每次成交都实时更新，不等订单完成
- 🔍 **基于统计数据止盈**：只要有持仓+均价就监控，不依赖订单列表
- 🚨 **异常情况高亮**：有余额但均价为0时醒目提示
- 🛠️ **手动补救功能**：提供手动设置均价的方法

### v4.1.0 (2025-01-15) - 实时持仓检查系统
- 🎯 **实时持仓检查**：每次价格更新时自动检查真实持仓
- 🔍 **智能差异检测**：自动发现手动卖出导致的持仓差异
- ⚡ **基于真实持仓止盈**：确保止盈计算基于实际持仓数量
- 📊 **详细持仓信息**：显示本地统计vs真实持仓对比
- 🛠️ **配置化控制**：支持开关和差异阈值设置
- 🔄 **自动校正机制**：检测到差异时自动调整本地统计

### v4.0.0 (2025-01-15) - 自动对账系统
- 🎯 **全新对账系统**：启动时自动校验余额与统计一致性
- ⚡ **智能同步策略**：基于真实交易记录的智能差异处理
- 🔍 **详细对账报告**：完整记录对账过程和结果
- 🧪 **独立测试功能**：专门的对账测试脚本
- 🛠️ **完全配置化**：支持精度、容忍度等个性化设置
- 🔄 **PM2完美兼容**：支持进程管理器重启自动对账

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