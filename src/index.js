const fs = require('fs');
const path = require('path');
const { Logger, log } = require('./utils/logger');
const TradingApp = require('./app');
const DualTradingApp = require('./app/dualTradingApp');
const ConfigLoader = require('./config/configLoader');
const TimeUtils = require('./utils/timeUtils');

// 全局日志记录器
let logger;

/**
 * 应用主函数
 */
async function main() {
  // 全局应用实例
  let app = null;
  let configInfo = null;
  
  try {
    // 初始化日志记录器
    logger = new Logger({
      logDir: path.join(__dirname, '../logs'),
      prefix: 'backpack_trading'
    });

    // 记录程序启动
    logger.log('=== Backpack 自动化交易系统启动 ===');
    logger.log('Node.js版本: ' + process.version);
    logger.log('WorkingDir: ' + process.cwd());
    logger.log('脚本基本路径: ' + __dirname);
    
    // 自动检测并加载配置文件
    try {
      configInfo = ConfigLoader.loadConfig(path.join(__dirname, '..'));
      logger.log(`检测到配置类型: ${configInfo.configType}`);
      logger.log(`配置文件路径: ${configInfo.configPath}`);
    } catch (configError) {
      logger.log(`配置加载失败: ${configError.message}`, true);
      process.exit(1);
    }
    
    // 根据配置类型创建相应的应用实例
    if (configInfo.configType === 'dual') {
      logger.log('===== 启动双策略模式 =====');
      logger.log(`策略1: ${configInfo.config.strategy1.name}`);
      logger.log(`策略2: ${configInfo.config.strategy2.name}`);
      logger.log(`总资金: ${configInfo.config.totalCapital} USDC`);
      
      // 创建双策略应用
      app = new DualTradingApp(configInfo.config, logger);
    } else {
      logger.log('===== 启动单策略模式 =====');
      logger.log(`交易币种: ${configInfo.config.trading?.tradingCoin}`);
      logger.log(`总投资额: ${configInfo.config.trading?.totalAmount} USDC`);
      logger.log(`订单数量: ${configInfo.config.trading?.orderCount}`);
      
      // 创建单策略应用
      app = new TradingApp(configInfo.config, logger);
    }
    
    // 设置SIGINT信号处理
    process.on('SIGINT', async () => {
      logger?.log('收到Ctrl+C信号，正在停止应用...');
      if (app && app.isRunning()) {
        await app.stop();
      }
      logger?.log('应用已停止，退出程序');
      process.exit(0);
    });
    
    try {
      // 初始化应用
      const initResult = await app.initialize();
      if (!initResult) {
        logger.log('初始化失败，退出程序');
        return;
      }
      
      // 启动应用
      await app.start();
      
      // 执行交易策略
      const tradeResult = await app.executeTrade();
      if (!tradeResult) {
        logger.log('交易执行失败');
      }
      
      // 持续运行，监控应用状态
      while (app.isRunning()) {
        // 记录当前状态
        if (TimeUtils.getElapsedTime(app.lastStatusLogTime) > 60000) { // 每分钟记录一次状态
          if (configInfo.configType === 'dual') {
            logger.log('双策略程序运行中...');
            // 显示双策略统计
            if (app.displayDualStats) {
              app.displayDualStats();
            }
          } else {
            logger.log('单策略程序运行中...');
          }
          app.lastStatusLogTime = TimeUtils.getCurrentTime();
        }
        
        // 如果需要重置状态（由于无订单成交或触发止盈），在应用内部执行重置
        // 不需要重启程序，只需重置应用状态
        
        // 等待一段时间
        await TimeUtils.delay(5000);
      }
      
      logger.log('应用已停止运行');
    } catch (error) {
      logger.log(`程序执行出错: ${error.message}`);
      logger.log(`错误堆栈: ${error.stack}`);
      
      // 确保应用停止
      if (app && app.isRunning()) {
        await app.stop();
      }
    }
    
    logger.log('程序执行完成，退出');
  } catch (error) {
    if (logger) {
      logger.log(`主程序异常: ${error.message}`);
      logger.log(`错误堆栈: ${error.stack}`);
    } else {
      console.error(`严重错误: ${error.message}`);
      console.error(error.stack);
    }
    
    // 确保应用停止
    if (app && app.isRunning()) {
      await app.stop();
    }
  }
}

/**
 * 设置进程退出处理
 */
function setupGracefulShutdown() {
  // 创建退出处理函数
  const exitHandler = (options, exitCode) => {
    try {
      if (options.cleanup) {
        logger?.log('清理资源...');
        
        // 确保日志被刷新
        if (logger && typeof logger.flush === 'function') {
          logger.flush();
        }
      }
      
      if (exitCode || exitCode === 0) {
        logger?.log(`程序退出，退出码: ${exitCode}`);
      }
      
      // 如果需要立即退出，使用setTimeout强制在此回调执行完后立即退出
      if (options.exit) {
        setTimeout(() => {
          process.exit(0);
        }, 0);
      }
    } catch (error) {
      console.error('退出过程中发生错误:', error);
      process.exit(1);
    }
  };
  
  // 捕获不同的退出信号 - 注意SIGINT已在main函数中处理
  process.on('exit', exitHandler.bind(null, { cleanup: true }));
  process.on('SIGTERM', exitHandler.bind(null, { cleanup: true, exit: true }));
  process.on('SIGUSR1', exitHandler.bind(null, { cleanup: true, exit: true }));
  process.on('SIGUSR2', exitHandler.bind(null, { cleanup: true, exit: true }));
  process.on('uncaughtException', (error) => {
    logger?.log(`未捕获的异常: ${error.message}`);
    logger?.log(`错误堆栈: ${error.stack}`);
    process.exit(1);  // 遇到未捕获的异常直接退出
  });
}

// 设置优雅退出
setupGracefulShutdown();

// 启动主程序
main().catch(error => {
  logger?.log(`主程序未捕获异常: ${error.message}`);
  logger?.log(`错误堆栈: ${error.stack}`);
  process.exit(1);
}); 