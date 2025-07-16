const fs = require('fs');
const path = require('path');
const LogBasedStatsService = require('./src/services/logBasedStatsService');
const TradeStats = require('./src/models/TradeStats');

async function testOrderLogging() {
  console.log('=== 测试订单日志记录功能 ===');
  
  // 创建测试配置
  const config = {
    trading: {
      tradingCoin: 'ETH'
    }
  };
  
  // 创建统计实例
  const tradeStats = new TradeStats();
  
  // 创建日志服务
  const logBasedStats = new LogBasedStatsService(tradeStats, config, console);
  
  console.log('1. 测试创建买单记录...');
  try {
    logBasedStats.logBuyOrderCreated('test_order_001', 3000, 0.1);
    console.log('✓ 买单创建记录成功');
  } catch (error) {
    console.log('✗ 买单创建记录失败:', error.message);
  }
  
  console.log('2. 测试买单成交记录...');
  try {
    logBasedStats.logBuyOrderFilled('test_order_001', 0.1, 300, 3000);
    console.log('✓ 买单成交记录成功');
  } catch (error) {
    console.log('✗ 买单成交记录失败:', error.message);
  }
  
  console.log('3. 检查今天的日志文件是否存在...');
  const dateString = new Date().toISOString().split('T')[0];
  const logFile = path.join(process.cwd(), 'logs', `trades_${dateString}.json`);
  
  if (fs.existsSync(logFile)) {
    console.log('✓ 日志文件存在:', logFile);
    const content = fs.readFileSync(logFile, 'utf8');
    console.log('文件内容:');
    console.log(content);
  } else {
    console.log('✗ 日志文件不存在:', logFile);
  }
  
  console.log('4. 检查日志目录权限...');
  const logsDir = path.join(process.cwd(), 'logs');
  try {
    fs.accessSync(logsDir, fs.constants.W_OK);
    console.log('✓ 日志目录可写');
  } catch (error) {
    console.log('✗ 日志目录不可写:', error.message);
  }
}

testOrderLogging().catch(console.error);