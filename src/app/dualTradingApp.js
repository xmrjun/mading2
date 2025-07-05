const TradingApp = require('../app');
const DualTradingStrategy = require('../core/dualTradingStrategy');
const { log } = require('../utils/logger');

/**
 * 双策略交易应用
 * 支持两个策略并行运行
 */
class DualTradingApp extends TradingApp {
  /**
   * 构造函数
   * @param {Object} config - 双策略配置对象
   * @param {Object} logger - 日志对象
   */
  constructor(config, logger) {
    // 使用策略1配置初始化父类，作为主策略
    const strategy1Config = {
      api: config.api,
      trading: config.strategy1.trading,
      actions: {
        sellNonUsdcAssets: true,
        cancelAllOrders: true,
        restartAfterTakeProfit: true,
        autoRestartNoFill: true
      },
      advanced: config.strategy1.advanced,
      quantityPrecisions: {
        BTC: 5,
        ETH: 4,
        SOL: 2,
        DEFAULT: 2
      },
      pricePrecisions: {
        BTC: 0,
        ETH: 2,
        SOL: 2,
        DEFAULT: 2
      },
      minQuantities: {
        BTC: 0.00001,
        ETH: 0.001,
        SOL: 0.01,
        DEFAULT: 0.1
      },
      websocket: config.websocket
    };
    
    super(strategy1Config);
    
    // 保存原始双策略配置
    this.dualConfig = config;
    this.isDualStrategy = true;
    
    // 初始化双策略管理器
    this.dualStrategy = new DualTradingStrategy(config, this.logger);
    
    // 策略状态跟踪
    this.activeStrategies = {
      strategy1: { active: true, lastExecuteTime: null },
      strategy2: { active: true, lastExecuteTime: null }
    };
    
    // 全局统计
    this.globalStats = {
      totalTrades: 0,
      totalProfit: 0,
      totalLoss: 0,
      strategy1Trades: 0,
      strategy2Trades: 0
    };
  }
  
  /**
   * 初始化双策略环境
   */
  async initialize() {
    try {
      log('===== 初始化双策略交易环境 =====');
      log(`策略1: ${this.dualConfig.strategy1.name}`);
      log(`策略2: ${this.dualConfig.strategy2.name}`);
      log(`总资金: ${this.dualConfig.totalCapital} USDC`);
      
      // 调用父类初始化
      const parentInitResult = await super.initialize();
      if (!parentInitResult) {
        return false;
      }
      
      log('双策略应用初始化完成');
      return true;
    } catch (error) {
      log(`双策略初始化失败: ${error.message}`, true);
      return false;
    }
  }
  
  /**
   * 处理价格更新 - 重写父类方法
   * @param {Object} priceInfo - 价格信息
   */
  handlePriceUpdate(priceInfo) {
    try {
      // 调用父类的价格更新处理
      super.handlePriceUpdate(priceInfo);
      
      // 双策略特有的价格分析和决策
      this.analyzeDualStrategy(priceInfo);
    } catch (error) {
      log(`双策略价格更新处理出错: ${error.message}`, true);
    }
  }
  
  /**
   * 分析双策略执行条件
   * @param {Object} priceInfo - 价格信息
   */
  async analyzeDualStrategy(priceInfo) {
    try {
      // 检查全局风险控制
      if (!this.dualStrategy.canTrade()) {
        return;
      }
      
      // 准备市场数据
      const marketData = {
        currentPrice: priceInfo.price,
        priceHistory: this.getPriceHistory(),
        volatility: this.calculateCurrentVolatility(priceInfo)
      };
      
      // 让双策略管理器分析并执行
      const executed = await this.dualStrategy.analyzeMarketAndExecute(
        priceInfo.price, 
        marketData
      );
      
      if (executed) {
        log('双策略执行完成');
        
        // 更新全局统计
        this.updateGlobalStats();
      }
    } catch (error) {
      log(`双策略分析出错: ${error.message}`, true);
    }
  }
  
  /**
   * 执行交易操作 - 重写父类方法
   */
  async executeTrade() {
    try {
      log('===== 开始执行双策略交易 =====');
      
      // 检查当前价格
      if (!this.currentPrice || this.currentPrice <= 0) {
        log('警告: 当前价格无效，无法执行双策略交易');
        return false;
      }
      
      log(`当前价格: ${this.currentPrice} USDC`);
      
      // 取消所有现有订单
      await this.cancelAllOrders();
      
      // 执行初始策略评估
      const marketData = {
        currentPrice: this.currentPrice,
        priceHistory: [],
        volatility: { value: 1.0, isLowVolatility: true, isMediumVolatility: true }
      };
      
      // 执行双策略分析
      const result = await this.dualStrategy.analyzeMarketAndExecute(
        this.currentPrice,
        marketData
      );
      
      if (result) {
        log('双策略初始执行成功');
        
        // 启动双策略监控
        this.startDualStrategyMonitoring();
        
        return true;
      } else {
        log('双策略初始执行未找到合适的执行条件');
        return false;
      }
    } catch (error) {
      log(`双策略交易执行失败: ${error.message}`, true);
      return false;
    }
  }
  
  /**
   * 启动双策略监控
   */
  startDualStrategyMonitoring() {
    // 如果已经在监控，先清除
    if (this.dualStrategyInterval) {
      clearInterval(this.dualStrategyInterval);
    }
    
    // 启动双策略专用监控
    this.dualStrategyInterval = setInterval(async () => {
      try {
        if (this.currentPriceInfo && this.currentPriceInfo.price) {
          await this.analyzeDualStrategy(this.currentPriceInfo);
        }
      } catch (error) {
        log(`双策略监控出错: ${error.message}`, true);
      }
    }, 30000); // 每30秒检查一次双策略执行条件
    
    log('双策略监控已启动');
  }
  
  /**
   * 计算当前波动性
   * @param {Object} priceInfo - 价格信息
   * @returns {Object} 波动性数据
   */
  calculateCurrentVolatility(priceInfo) {
    // 简化的波动性计算
    // 在实际应用中，这里应该基于历史价格数据计算真实的波动性
    const randomVolatility = Math.random() * 2;
    
    return {
      value: randomVolatility,
      isLowVolatility: randomVolatility < 1.0,
      isMediumVolatility: randomVolatility >= 0.8 && randomVolatility < 2.0,
      isHighVolatility: randomVolatility >= 2.0
    };
  }
  
  /**
   * 获取价格历史（简化版）
   * @returns {Array} 价格历史数组
   */
  getPriceHistory() {
    // 在实际应用中，这里应该返回真实的价格历史数据
    return [];
  }
  
  /**
   * 更新全局统计
   */
  updateGlobalStats() {
    try {
      const strategyStats = this.dualStrategy.getStrategyStats();
      
      this.globalStats = {
        totalTrades: strategyStats.globalStats.dailyTrades,
        totalProfit: strategyStats.globalStats.dailyProfit,
        totalLoss: strategyStats.globalStats.dailyLoss,
        netProfit: strategyStats.globalStats.netProfit,
        strategy1Trades: strategyStats.strategy1Stats.trades,
        strategy2Trades: strategyStats.strategy2Stats.trades
      };
    } catch (error) {
      log(`更新全局统计出错: ${error.message}`, true);
    }
  }
  
  /**
   * 显示双策略统计信息
   */
  displayDualStats() {
    try {
      const stats = this.dualStrategy.getStrategyStats();
      
      log('\n=== 双策略统计信息 ===');
      log(`总交易次数: ${stats.globalStats.dailyTrades}`);
      log(`总盈利: ${stats.globalStats.dailyProfit.toFixed(2)} USDC`);
      log(`总亏损: ${stats.globalStats.dailyLoss.toFixed(2)} USDC`);
      log(`净盈利: ${stats.globalStats.netProfit.toFixed(2)} USDC`);
      
      log('\n--- 策略1统计 ---');
      log(`名称: ${stats.strategy1Stats.name}`);
      log(`交易次数: ${stats.strategy1Stats.trades}`);
      log(`盈利: ${stats.strategy1Stats.profit.toFixed(2)} USDC`);
      log(`成功率: ${stats.strategy1Stats.successRate.toFixed(2)}%`);
      
      log('\n--- 策略2统计 ---');
      log(`名称: ${stats.strategy2Stats.name}`);
      log(`交易次数: ${stats.strategy2Stats.trades}`);
      log(`盈利: ${stats.strategy2Stats.profit.toFixed(2)} USDC`);
      log(`成功率: ${stats.strategy2Stats.successRate.toFixed(2)}%`);
      
      log('\n--- 资金利用率 ---');
      log(`策略1资金: ${stats.capitalUtilization.strategy1} USDC`);
      log(`策略2资金: ${stats.capitalUtilization.strategy2} USDC`);
      log(`总资金: ${stats.capitalUtilization.total} USDC`);
      log('========================\n');
    } catch (error) {
      log(`显示双策略统计出错: ${error.message}`, true);
    }
  }
  
  /**
   * 停止双策略应用
   */
  async stop() {
    log('正在停止双策略应用...');
    
    try {
      // 清除双策略监控
      if (this.dualStrategyInterval) {
        clearInterval(this.dualStrategyInterval);
        this.dualStrategyInterval = null;
      }
      
      // 显示最终统计
      this.displayDualStats();
      
      // 调用父类停止方法
      await super.stop();
      
      log('双策略应用已停止');
    } catch (error) {
      log(`停止双策略应用出错: ${error.message}`, true);
    }
  }
  
  /**
   * 重置双策略应用状态
   */
  resetAppState() {
    try {
      log('===== 重置双策略应用状态 =====');
      
      // 重置双策略管理器
      this.dualStrategy = new DualTradingStrategy(this.dualConfig, this.logger);
      
      // 重置策略状态
      this.activeStrategies = {
        strategy1: { active: true, lastExecuteTime: null },
        strategy2: { active: true, lastExecuteTime: null }
      };
      
      // 重置全局统计
      this.globalStats = {
        totalTrades: 0,
        totalProfit: 0,
        totalLoss: 0,
        strategy1Trades: 0,
        strategy2Trades: 0
      };
      
      // 调用父类重置方法
      super.resetAppState();
      
      log('双策略应用状态重置完成');
    } catch (error) {
      log(`重置双策略应用状态出错: ${error.message}`, true);
    }
  }
}

module.exports = DualTradingApp;