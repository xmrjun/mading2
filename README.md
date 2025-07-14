# ETH 阶梯挂单交易系统

一个专为ETH/USD交易设计的自动化阶梯挂单系统，支持智能止盈和马丁格尔策略。

## 🎯 核心功能

- **阶梯限价单** - 在价格回撤区间内分层挂单
- **自动止盈** - 达到盈利目标自动卖出
- **持仓检测** - 智能跳过重复挂单
- **马丁格尔策略** - 可选的递增投资逻辑
- **实时监控** - WebSocket价格监控和交易执行

## � 配置说明

编辑 `backpack_trading_config.json` 文件：

```json
{
  "api": {
    "privateKey": "你的私钥",
    "publicKey": "你的公钥"
  },
  "trading": {
    "tradingCoin": "ETH",
    "totalAmount": 2000,           // 总投资金额 (USD)
    "maxDropPercentage": 7,        // 最大回撤百分比
    "orderCount": 8,               // 阶梯订单数量
    "incrementPercentage": 50,     // 订单递增百分比
    "takeProfitPercentage": 0.25,  // 止盈百分比
    "martingaleEnabled": false     // 马丁格尔策略开关
  }
}
```

### 关键参数

- `totalAmount`: 每轮投资总金额
- `maxDropPercentage`: 挂单价格范围（当前价格往下7%）
- `orderCount`: 将总金额分成几个阶梯挂单
- `takeProfitPercentage`: 盈利0.25%自动止盈

## 🚀 使用方法
git clone https://github.com/xmrjun/mading2.git
cd mading2

### 安装依赖
```bash
npm install
```

### 启动交易
```bash
node start_single.js
```

### 停止交易
```
Ctrl + C
```

## � 交易逻辑

1. **价格监控** - 实时获取ETH/USD价格
2. **阶梯挂单** - 在当前价格到-7%区间内挂8个限价单
3. **等待成交** - 价格回撤时订单逐步成交
4. **自动止盈** - 均价上涨0.25%时自动卖出
5. **重新开始** - 止盈后重新开始下一轮

## 💰 资金示例

以2000 USD为例：
- 当前价格: 3000 USD
- 挂单范围: 3000 → 2790 USD (-7%)
- 8个限价单: 每个约250 USD
- 止盈目标: 均价上涨0.25%

## ⚠️ 注意事项

- **风险自负** - 加密货币交易存在亏损风险
- **API安全** - 妥善保管交易所API密钥
- **资金管理** - 合理设置投资金额
- **实时监控** - 关注系统运行状态

## 📝 系统要求

- Node.js 14+
- 稳定的网络连接
- Backpack交易所账户

---

**免责声明**: 本软件仅供学习和研究使用，使用者需承担所有交易风险。 
