const fs = require('fs');
const path = require('path');
const { Logger } = require('./src/utils/logger');
const BackpackService = require('./src/services/backpackService');
const ReconciliationService = require('./src/services/reconciliationService');
const TradeStats = require('./src/models/TradeStats');

/**
 * 对账功能测试脚本
 * 用于独立测试启动时自动对账功能
 */
async function testReconciliation() {
  let logger;
  
  try {
    // 初始化日志记录器
    logger = new Logger({
      logDir: path.join(__dirname, 'logs'),
      prefix: 'reconciliation_test'
    });

    console.log('=== Backpack 对账功能测试 ===');
    console.log('开始测试启动时自动对账功能...\n');
    
    // 检查配置文件
    const configPath = path.join(__dirname, 'backpack_trading_config.json');
    if (!fs.existsSync(configPath)) {
      console.log(`❌ 配置文件不存在: ${configPath}`);
      console.log('请确保存在 backpack_trading_config.json 文件');
      process.exit(1);
    }
    
    // 加载配置
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log(`✅ 已加载配置文件: ${configPath}`);
    console.log(`交易币种: ${config.trading?.tradingCoin || 'BTC'}`);
    
    // 检查对账配置
    if (!config.reconciliation || !config.reconciliation.enabled) {
      console.log('⚠️  对账功能未启用，将使用默认设置进行测试');
      config.reconciliation = {
        enabled: true,
        autoSyncOnStartup: true,
        forceSync: false, // 测试模式不强制同步
        logDetailedReport: true,
        tolerances: {
          "BTC": 0.0001,
          "ETH": 0.001,
          "SOL": 0.01,
          "DEFAULT": 0.0001
        }
      };
    } else {
      console.log('✅ 对账功能已启用');
      console.log(`自动启动对账: ${config.reconciliation.autoSyncOnStartup ? '是' : '否'}`);
      console.log(`强制同步: ${config.reconciliation.forceSync ? '是' : '否'}`);
    }
    
    // 初始化服务
    console.log('\n🔧 正在初始化服务...');
    const backpackService = new BackpackService(config, logger);
    const tradeStats = new TradeStats();
    const reconciliationService = new ReconciliationService(
      backpackService, 
      tradeStats, 
      config, 
      logger
    );
    
    console.log('✅ 服务初始化完成');
    
    // 模拟一些历史交易数据用于测试
    console.log('\n📊 模拟历史交易数据...');
    const mockTrades = [
      { quantity: 0.001, price: 58000, amount: 58 },
      { quantity: 0.002, price: 59000, amount: 118 },
      { quantity: 0.001, price: 60000, amount: 60 }
    ];
    
    let totalQuantity = 0;
    let totalAmount = 0;
    
    mockTrades.forEach((trade, index) => {
      totalQuantity += trade.quantity;
      totalAmount += trade.amount;
      console.log(`   模拟交易 ${index + 1}: ${trade.quantity} BTC @ ${trade.price} USDC`);
    });
    
    // 更新统计数据
    tradeStats.totalFilledQuantity = totalQuantity;
    tradeStats.totalFilledAmount = totalAmount;
    tradeStats.averagePrice = totalAmount / totalQuantity;
    tradeStats.filledOrders = mockTrades.length;
    tradeStats.lastUpdateTime = new Date();
    
    console.log(`📈 模拟统计数据:`);
    console.log(`   总数量: ${totalQuantity.toFixed(6)} BTC`);
    console.log(`   总金额: ${totalAmount.toFixed(2)} USDC`);
    console.log(`   平均价: ${tradeStats.averagePrice.toFixed(2)} USDC`);
    console.log(`   订单数: ${tradeStats.filledOrders}`);
    
    // 执行对账测试
    console.log('\n🔍 开始执行对账测试...');
    console.log('⚠️  注意：这将查询真实的交易所余额数据');
    
    // 询问用户是否继续
    if (process.argv.includes('--auto')) {
      console.log('自动模式：跳过确认，直接执行对账');
    } else {
      console.log('按 Ctrl+C 取消，或等待 5 秒后自动继续...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    const reconcileResult = await reconciliationService.reconcilePosition();
    
    // 显示结果
    console.log('\n📋 对账测试结果:');
    if (reconcileResult.success) {
      const report = reconciliationService.generateReconciliationReport(reconcileResult);
      console.log(report);
      
      if (reconcileResult.needSync) {
        console.log('⚡ 检测到差异，对账功能正常工作');
        if (config.reconciliation?.forceSync) {
          console.log('✅ 数据已自动校正');
        } else {
          console.log('ℹ️  测试模式：未执行实际同步');
        }
      } else {
        console.log('✅ 数据一致，对账功能验证成功');
      }
    } else {
      console.log(`❌ 对账测试失败: ${reconcileResult.error}`);
    }
    
    // 显示最终统计
    console.log('\n📊 测试后的统计数据:');
    console.log(`   总数量: ${tradeStats.totalFilledQuantity.toFixed(6)} ${config.trading?.tradingCoin || 'BTC'}`);
    console.log(`   总金额: ${tradeStats.totalFilledAmount.toFixed(2)} USDC`);
    console.log(`   平均价: ${tradeStats.averagePrice.toFixed(2)} USDC`);
    console.log(`   订单数: ${tradeStats.filledOrders}`);
    
    console.log('\n✅ 对账功能测试完成');
    
  } catch (error) {
    console.error(`❌ 测试过程发生错误: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

// 设置优雅退出
process.on('SIGINT', () => {
  console.log('\n\n⏹️  用户取消测试');
  process.exit(0);
});

// 显示帮助信息
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('对账功能测试脚本');
  console.log('');
  console.log('用法:');
  console.log('  node test_reconciliation.js           # 交互式测试');
  console.log('  node test_reconciliation.js --auto    # 自动测试（跳过确认）');
  console.log('  node test_reconciliation.js --help    # 显示帮助');
  console.log('');
  console.log('说明:');
  console.log('  该脚本会模拟一些历史交易数据，然后测试对账功能');
  console.log('  会查询真实的交易所余额并与模拟数据进行对比');
  console.log('  默认情况下不会修改实际数据，仅用于测试验证');
  process.exit(0);
}

// 启动测试
testReconciliation().catch(error => {
  console.error(`❌ 测试启动失败: ${error.message}`);
  process.exit(1);
});