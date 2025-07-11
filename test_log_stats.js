const LogBasedStatsService = require('./src/services/logBasedStatsService');
const TradeStats = require('./src/core/tradeStats');
const config = require('./config/config');

/**
 * 测试日志统计系统
 */
async function testLogBasedStats() {
  console.log('🧪 开始测试基于日志的统计系统...\n');
  
  // 1. 创建模拟的交易统计实例
  const tradeStats = new TradeStats();
  
  // 2. 创建日志统计服务
  const logBasedStats = new LogBasedStatsService(tradeStats, config, console);
  
  // 3. 模拟一系列交易操作
  console.log('📝 模拟交易操作记录...');
  
  // 创建买单1
  logBasedStats.logBuyOrderCreated('ord_001', 50000, 0.001);
  
  // 买单1成交
  logBasedStats.logBuyOrderFilled('ord_001', 0.001, 50, 50000);
  
  // 创建买单2
  logBasedStats.logBuyOrderCreated('ord_002', 49000, 0.002);
  
  // 买单2部分成交
  logBasedStats.logBuyPartialFilled('ord_002', 0.001, 49);
  
  // 买单2完全成交
  logBasedStats.logBuyOrderFilled('ord_002', 0.002, 98, 49000);
  
  // 创建卖单
  logBasedStats.logSellOrderFilled('ord_003', 0.0015, 75, 50000);
  
  // 统计更新
  logBasedStats.logStatsUpdated();
  
  console.log('\n✅ 交易操作记录完成');
  
  // 4. 等待一秒，然后恢复统计
  console.log('\n🔄 模拟重启恢复过程...');
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // 5. 重置统计实例（模拟重启）
  const newTradeStats = new TradeStats();
  const newLogBasedStats = new LogBasedStatsService(newTradeStats, config, console);
  
  // 6. 从日志恢复统计
  const recoveryResult = await newLogBasedStats.recoverStatsFromLogs();
  
  console.log('\n📊 恢复结果:', recoveryResult);
  
  // 7. 显示恢复后的统计
  if (recoveryResult.success && recoveryResult.recovered) {
    console.log('\n✅ 恢复成功！统计数据:');
    console.log(`   总持仓: ${newTradeStats.totalFilledQuantity.toFixed(6)} BTC`);
    console.log(`   总成本: ${newTradeStats.totalFilledAmount.toFixed(2)} USDC`);
    console.log(`   平均价: ${newTradeStats.averagePrice.toFixed(2)} USDC`);
    console.log(`   订单数: ${newTradeStats.filledOrders}`);
  } else {
    console.log('\n❌ 恢复失败:', recoveryResult.message);
  }
  
  console.log('\n🧪 测试完成');
}

// 运行测试
if (require.main === module) {
  testLogBasedStats().catch(console.error);
}

module.exports = { testLogBasedStats };