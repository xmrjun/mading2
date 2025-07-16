const fs = require('fs');
const path = require('path');
const LogBasedStatsService = require('./src/services/logBasedStatsService');
const TradeStats = require('./src/models/TradeStats');

async function fixMissingTrades() {
  console.log('=== 修复缺失的成交记录 ===');
  
  const config = {
    trading: {
      tradingCoin: 'ETH'
    }
  };
  
  const tradeStats = new TradeStats();
  const logBasedStats = new LogBasedStatsService(tradeStats, config, console);
  
  // 根据你提供的成交记录，手动添加缺失的FILLED记录
  const missingTrades = [
    {
      orderId: '3241462672', // 0.0052 ETH @ 2,949.12 USD
      quantity: 0.0052,
      price: 2949.12,
      filledAmount: 15.34
    },
    {
      orderId: '3241462534', // 0.0034 ETH @ 2,979.84 USD  
      quantity: 0.0034,
      price: 2979.84,
      filledAmount: 10.13
    }
  ];
  
  console.log('添加缺失的成交记录...');
  
  for (const trade of missingTrades) {
    console.log(`处理订单: ${trade.orderId} - ${trade.quantity} ETH @ ${trade.price} USD`);
    
    // 添加成交记录
    logBasedStats.logBuyOrderFilled(
      trade.orderId,
      trade.quantity,
      trade.filledAmount,
      trade.price
    );
    
    console.log(`✓ 已添加成交记录: ${trade.orderId}`);
  }
  
  console.log('\n=== 成交记录修复完成 ===');
  console.log('请重新启动交易系统查看更新后的统计数据');
}

fixMissingTrades().catch(console.error);