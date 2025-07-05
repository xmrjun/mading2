# 🚀 Backpack 智能交易系统

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2018.0.0-brightgreen)](https://nodejs.org/)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-yellow)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)

一个基于 **Backpack 交易所** 的智能自动化交易系统，专为加密货币交易者设计。支持递增买入策略、实时价格监控、自动止盈和风险管理。

## ✨ 核心特性

### 🎯 智能交易策略
- **递增买入策略**：根据价格下跌程度，自动增加买入量
- **动态止盈**：达到预设盈利目标自动卖出
- **风险控制**：设置最大下跌百分比，控制风险敞口
- **多币种支持**：支持 BTC、ETH、SOL 等主流加密货币

### 📊 实时监控
- **WebSocket 价格流**：实时接收市场价格数据
- **交易统计**：实时计算成交量、均价和盈亏情况
- **状态监控**：监控订单状态、连接状态和系统健康度
- **日志记录**：详细的交易日志和错误记录

### 🔄 自动化管理
- **智能重启**：无订单成交或止盈后自动重启新一轮
- **订单管理**：自动创建、取消和跟踪订单
- **异常处理**：网络断线、API错误自动重试
- **优雅退出**：支持安全退出和资源清理

## 🏗️ 项目架构

```
backpack-trading-system/
├── src/                        # 源代码目录
│   ├── config/                 # 配置管理
│   │   └── configLoader.js     # 配置加载器
│   ├── core/                   # 核心业务逻辑
│   │   ├── orderManager.js     # 订单管理器
│   │   ├── priceMonitor.js     # 价格监控器
│   │   └── tradingStrategy.js  # 交易策略引擎
│   ├── models/                 # 数据模型
│   │   ├── Order.js           # 订单模型
│   │   └── TradeStats.js      # 交易统计模型
│   ├── network/                # 网络通信
│   │   └── webSocketManager.js # WebSocket管理器
│   ├── services/               # 服务层
│   │   └── backpackService.js  # Backpack API服务
│   ├── utils/                  # 工具库
│   │   ├── formatter.js        # 数据格式化
│   │   ├── logger.js          # 日志系统
│   │   └── timeUtils.js       # 时间工具
│   ├── app.js                  # 应用主类
│   └── index.js               # 程序入口
├── scripts/                    # 脚本目录
│   ├── start.js               # 启动脚本
│   └── stop.js                # 停止脚本
├── logs/                       # 日志目录
├── backpack_trading_config.json # 主配置文件
├── package.json               # 项目配置
└── README.md                  # 项目文档
```

## 🚀 快速开始

### 1. 环境要求
- **Node.js**: >= 18.0.0
- **npm**: >= 8.0.0
- **Backpack 交易所账户**和 API 密钥

### 2. 安装依赖
```bash
# 克隆项目
git clone https://github.com/yourusername/backpack-trading-system.git
cd backpack-trading-system

# 安装依赖
npm install
```

### 3. 配置 API 密钥
编辑 `backpack_trading_config.json` 文件：
```json
{
  "api": {
    "privateKey": "YOUR_PRIVATE_KEY_HERE",
    "publicKey": "YOUR_PUBLIC_KEY_HERE"
  }
}
```

### 4. 启动交易系统
```bash
# 方式1：直接启动（推荐）
node src/index.js

# 方式2：使用npm脚本
npm start

# 方式3：使用脚本管理器
npm run dev
```

## ⚙️ 配置说明

### 核心交易配置
```json
{
  "trading": {
    "tradingCoin": "BTC",           // 交易币种
    "maxDropPercentage": 1.2,       // 最大下跌百分比
    "totalAmount": 1000,            // 总投资金额(USDC)
    "orderCount": 4,                // 同时挂单数量
    "incrementPercentage": 20,      // 递增买入百分比
    "takeProfitPercentage": 0.08    // 止盈百分比
  }
}
```

### 功能开关
```json
{
  "actions": {
    "sellNonUsdcAssets": true,      // 启动时卖出非USDC资产
    "cancelAllOrders": true,        // 启动时取消现有订单
    "restartAfterTakeProfit": true, // 止盈后自动重启
    "autoRestartNoFill": true       // 无成交自动重启
  }
}
```

### 高级配置
```json
{
  "advanced": {
    "minOrderAmount": 10,                    // 最小订单金额
    "checkOrdersIntervalMinutes": 2,         // 订单检查间隔
    "monitorIntervalSeconds": 5,             // 监控间隔
    "noFillRestartMinutes": 0.5,            // 无成交重启时间
    "quickRestartAfterTakeProfit": true,     // 快速重启
    "maxDailyTrades": 20                     // 每日最大交易次数
  }
}
```

### 精度设置
```json
{
  "quantityPrecisions": {
    "BTC": 5,      // BTC数量精度
    "ETH": 4,      // ETH数量精度
    "SOL": 2,      // SOL数量精度
    "DEFAULT": 2   // 默认精度
  },
  "pricePrecisions": {
    "BTC": 0,      // BTC价格精度
    "ETH": 2,      // ETH价格精度
    "SOL": 2,      // SOL价格精度
    "DEFAULT": 2   // 默认精度
  }
}
```

## 📊 交易策略详解

### 递增买入策略
系统采用智能递增买入策略，核心思想是**在价格下跌时增加买入量**：

1. **初始设置**：在当前价格以下设置多个买入订单
2. **价格递减**：每个订单价格逐步降低
3. **数量递增**：随着价格降低，买入数量按比例增加
4. **成本平均**：通过多次买入降低平均成本
5. **止盈退出**：价格回升到盈利点自动卖出

### 风险管理
- **最大下跌保护**：设置最大容忍下跌幅度
- **资金分配**：智能分配每笔订单的资金
- **止损机制**：达到最大损失自动停止
- **时间限制**：设置交易时间窗口

## 🔧 高级功能

### 自动化管理
```javascript
// 自动重启配置
"restartAfterTakeProfit": true,    // 止盈后重启
"autoRestartNoFill": true,         // 无成交重启
"quickRestartAfterTakeProfit": true // 快速重启模式
```

### 实时监控
- **WebSocket 连接**：实时价格数据流
- **订单状态追踪**：实时监控订单执行情况
- **盈亏计算**：实时计算账户盈亏
- **系统健康检查**：监控系统运行状态

### 日志系统
```bash
logs/
├── app_2024-01-01.log           # 应用日志
├── trade_2024-01-01.log         # 交易日志
└── error_2024-01-01.log         # 错误日志
```

## 📈 使用示例

### 基础交易配置
```json
{
  "trading": {
    "tradingCoin": "SOL",
    "totalAmount": 500,
    "orderCount": 5,
    "maxDropPercentage": 3.0,
    "incrementPercentage": 15,
    "takeProfitPercentage": 1.5
  }
}
```

### 保守交易配置
```json
{
  "trading": {
    "tradingCoin": "BTC",
    "totalAmount": 1000,
    "orderCount": 3,
    "maxDropPercentage": 1.0,
    "incrementPercentage": 10,
    "takeProfitPercentage": 0.8
  }
}
```

### 激进交易配置
```json
{
  "trading": {
    "tradingCoin": "ETH",
    "totalAmount": 2000,
    "orderCount": 8,
    "maxDropPercentage": 5.0,
    "incrementPercentage": 25,
    "takeProfitPercentage": 2.0
  }
}
```

## 🛠️ 开发指南

### 本地开发
```bash
# 开发模式运行
npm run dev

# 启动测试
npm test

# 代码格式化
npm run lint
```

### 自定义策略
```javascript
// 在 src/core/tradingStrategy.js 中添加新策略
class CustomTradingStrategy {
  calculateOrderPrices(currentPrice, config) {
    // 自定义价格计算逻辑
  }
  
  shouldTakeProfit(currentPrice, averagePrice, config) {
    // 自定义止盈条件
  }
}
```

### 添加新的交易所
1. 在 `src/services/` 中创建新的交易所服务
2. 实现统一的接口规范
3. 在配置中添加交易所选择选项

## 🔒 安全注意事项

### API 密钥安全
- ✅ 使用环境变量存储敏感信息
- ✅ 定期轮换 API 密钥
- ✅ 设置 API 权限最小化原则
- ❌ 不要在代码中硬编码密钥

### 交易风险
- ⚠️ 加密货币交易存在高风险
- ⚠️ 建议先用小额资金测试
- ⚠️ 定期监控交易状态
- ⚠️ 设置合理的止损位

## 🤝 贡献指南

### 提交代码
1. Fork 项目
2. 创建特性分支: `git checkout -b feature/new-feature`
3. 提交更改: `git commit -m 'Add new feature'`
4. 推送分支: `git push origin feature/new-feature`
5. 创建 Pull Request

### 代码规范
- 使用 ESLint 进行代码检查
- 遵循 JavaScript Standard Style
- 添加适当的注释和文档
- 编写单元测试

### 报告问题
- 使用 GitHub Issues 报告 bug
- 提供详细的错误信息和复现步骤
- 包含系统环境信息

## 📝 更新日志

### v2.0.0 (2024-01-01)
- 🎉 全新模块化架构
- ✨ 新增实时 WebSocket 监控
- 🔧 优化交易策略引擎
- 📊 改进统计和日志系统
- 🐛 修复多个已知问题

### v1.x.x
- 基础交易功能
- 简单的买入卖出逻辑
- 基础配置管理

## 📞 支持与联系

- **GitHub Issues**: [项目问题追踪](https://github.com/yourusername/backpack-trading-system/issues)
- **讨论区**: [GitHub Discussions](https://github.com/yourusername/backpack-trading-system/discussions)
- **文档**: [项目文档](https://github.com/yourusername/backpack-trading-system/wiki)

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。

## ⚠️ 免责声明

本项目仅供学习和研究使用。加密货币交易存在高风险，可能导致资金损失。使用本软件进行交易时，请：

1. 充分了解交易风险
2. 仅投资您能承受损失的资金
3. 定期监控交易状态
4. 遵守当地法律法规

**作者不对使用本软件造成的任何损失承担责任。**

---

## 🌟 Star History

如果这个项目对您有帮助，请给我们一个 ⭐️ 支持！

[![Star History Chart](https://api.star-history.com/svg?repos=yourusername/backpack-trading-system&type=Date)](https://star-history.com/#yourusername/backpack-trading-system&Date)

---

**快速开始您的智能交易之旅！** 🚀 