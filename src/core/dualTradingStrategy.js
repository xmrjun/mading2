const TradingStrategy = require('./tradingStrategy');
const { log } = require('../utils/logger');

/**
 * 双策略交易管理器
 * 支持两个策略并行运行，最大化交易频率和收益
 */
class DualTradingStrategy {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    
    // 创建两个独立的策略实例
    this.strategy1 = new SingleStrategy(config.strategy1, logger, 'Strategy1');
    this.strategy2 = new SingleStrategy(config.strategy2, logger, 'Strategy2');
    
    // 统一风险控制
    this.riskControl = {
      dailyTrades: 0,
      dailyProfit: 0,
      dailyLoss: 0,
      maxDailyLoss: config.riskControl.maxDailyLoss || 200,
      emergencyStopLoss: config.riskControl.emergencyStopLoss || 500,
      isEmergencyStop: false
    };
    
    // 策略状态跟踪
    this.strategyStates = {
      strategy1: { active: true, lastTradeTime: null },
      strategy2: { active: true, lastTradeTime: null }
    };
  }

  /**
   * 检查当前价格，决定哪个策略应该执行
   */
  async analyzeMarketAndExecute(currentPrice, marketData) {
    try {
      // 检查全局风险控制
      if (!this.canTrade()) {
        log('全局风险控制阻止交易');
        return false;
      }

      // 分析市场波动性，决定策略优先级
      const volatility = this.calculateVolatility(marketData);
      
      let results = [];
      
      // 策略1：高频小波动 (优先级更高)
      if (this.strategyStates.strategy1.active && volatility.isLowVolatility) {
        const result1 = await this.strategy1.evaluate(currentPrice, volatility);
        if (result1.shouldExecute) {
          results.push({ strategy: 'strategy1', result: result1 });
        }
      }
      
      // 策略2：中频大波动
      if (this.strategyStates.strategy2.active && volatility.isMediumVolatility) {
        const result2 = await this.strategy2.evaluate(currentPrice, volatility);
        if (result2.shouldExecute) {
          results.push({ strategy: 'strategy2', result: result2 });
        }
      }

      // 执行策略 (避免冲突)
      if (results.length > 0) {
        await this.executeStrategies(results, currentPrice);
        return true;
      }

      return false;
    } catch (error) {
      log(`双策略分析执行出错: ${error.message}`, true);
      return false;
    }
  }

  /**
   * 执行策略 (确保不冲突)
   */
  async executeStrategies(strategyResults, currentPrice) {
    // 按优先级排序：高频策略优先
    strategyResults.sort((a, b) => 
      a.strategy === 'strategy1' ? -1 : 1
    );

    for (const { strategy, result } of strategyResults) {
      try {
        // 检查策略间冲突
        if (this.hasStrategyConflict(strategy)) {
          log(`策略 ${strategy} 存在冲突，跳过执行`);
          continue;
        }

        // 执行策略
        const success = await this.executeStrategy(strategy, result, currentPrice);
        
        if (success) {
          this.updateStrategyState(strategy);
          // 为了避免冲突，成功执行一个策略后短暂等待
          await this.sleep(5000);
        }
      } catch (error) {
        log(`执行策略 ${strategy} 出错: ${error.message}`, true);
      }
    }
  }

  /**
   * 执行具体策略
   */
  async executeStrategy(strategyName, strategyResult, currentPrice) {
    const strategy = strategyName === 'strategy1' ? this.strategy1 : this.strategy2;
    const config = strategyName === 'strategy1' ? this.config.strategy1 : this.config.strategy2;
    
    try {
      log(`\n===== 执行 ${config.name} =====`);
      log(`当前价格: ${currentPrice}`);
      log(`策略参数: 下跌${config.trading.maxDropPercentage}%, 止盈${config.trading.takeProfitPercentage}%`);
      
      // 生成订单
      const orders = strategy.generateOrders(currentPrice, strategyResult);
      
      if (orders.length === 0) {
        log('未生成有效订单');
        return false;
      }

      // 记录订单信息
      log(`生成 ${orders.length} 个订单，总金额: ${this.calculateTotalAmount(orders)}美金`);
      orders.forEach((order, index) => {
        log(`订单${index + 1}: ${order.price}美金 买入 ${order.amount}美金`);
      });

      // 这里应该调用实际的交易API
      // const tradeResult = await this.executeOrders(orders);
      
      // 模拟交易成功
      this.recordTradeSuccess(strategyName, orders);
      
      return true;
    } catch (error) {
      log(`策略 ${strategyName} 执行失败: ${error.message}`, true);
      return false;
    }
  }

  /**
   * 计算市场波动性
   */
  calculateVolatility(marketData) {
    // 这里应该基于真实的市场数据计算
    // 现在使用简化版本
    const currentVolatility = Math.random() * 2; // 模拟0-2%的波动
    
    return {
      value: currentVolatility,
      isLowVolatility: currentVolatility < 1.0,   // 策略1适用
      isMediumVolatility: currentVolatility >= 0.8 && currentVolatility < 2.0, // 策略2适用
      isHighVolatility: currentVolatility >= 2.0
    };
  }

  /**
   * 检查策略冲突
   */
  hasStrategyConflict(strategyName) {
    const now = Date.now();
    const minInterval = 60000; // 1分钟最小间隔
    
    const otherStrategy = strategyName === 'strategy1' ? 'strategy2' : 'strategy1';
    const otherLastTrade = this.strategyStates[otherStrategy].lastTradeTime;
    
    if (otherLastTrade && (now - otherLastTrade) < minInterval) {
      return true;
    }
    
    return false;
  }

  /**
   * 更新策略状态
   */
  updateStrategyState(strategyName) {
    this.strategyStates[strategyName].lastTradeTime = Date.now();
    this.riskControl.dailyTrades++;
  }

  /**
   * 记录交易成功
   */
  recordTradeSuccess(strategyName, orders) {
    const totalAmount = this.calculateTotalAmount(orders);
    const config = strategyName === 'strategy1' ? this.config.strategy1 : this.config.strategy2;
    
    // 预估利润
    const estimatedProfit = totalAmount * (config.trading.takeProfitPercentage / 100);
    
    log(`${config.name} 交易启动成功:`);
    log(`- 投入金额: ${totalAmount}美金`);
    log(`- 预期利润: ${estimatedProfit.toFixed(2)}美金`);
    log(`- 今日交易次数: ${this.riskControl.dailyTrades + 1}`);
  }

  /**
   * 计算订单总金额
   */
  calculateTotalAmount(orders) {
    return orders.reduce((total, order) => total + order.amount, 0);
  }

  /**
   * 全局风险控制检查
   */
  canTrade() {
    // 检查紧急停止
    if (this.riskControl.isEmergencyStop) {
      return false;
    }

    // 检查每日亏损限制
    if (this.riskControl.dailyLoss >= this.riskControl.maxDailyLoss) {
      log(`达到每日最大亏损限制: ${this.riskControl.maxDailyLoss}美金`);
      return false;
    }

    // 检查每日交易次数 (两个策略合计)
    const maxDailyTrades = this.config.strategy1.advanced.maxDailyTrades + 
                          this.config.strategy2.advanced.maxDailyTrades;
    
    if (this.riskControl.dailyTrades >= maxDailyTrades) {
      log(`达到每日最大交易次数: ${maxDailyTrades}`);
      return false;
    }

    return true;
  }

  /**
   * 获取策略统计
   */
  getStrategyStats() {
    return {
      globalStats: {
        dailyTrades: this.riskControl.dailyTrades,
        dailyProfit: this.riskControl.dailyProfit,
        dailyLoss: this.riskControl.dailyLoss,
        netProfit: this.riskControl.dailyProfit - this.riskControl.dailyLoss
      },
      strategy1Stats: this.strategy1.getStats(),
      strategy2Stats: this.strategy2.getStats(),
      capitalUtilization: {
        strategy1: this.config.strategy1.trading.totalAmount,
        strategy2: this.config.strategy2.trading.totalAmount,
        total: this.config.totalCapital
      }
    };
  }

  /**
   * 睡眠函数
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * 单个策略实现
 */
class SingleStrategy extends TradingStrategy {
  constructor(config, logger, name) {
    super(logger, config);
    this.name = name;
    this.config = config;
    this.stats = {
      trades: 0,
      profit: 0,
      loss: 0,
      successRate: 0
    };
  }

  /**
   * 评估是否应该执行策略
   */
  async evaluate(currentPrice, volatility) {
    const maxDrop = this.config.trading.maxDropPercentage;
    
    // 根据波动性判断是否适合当前策略
    const isVolatilityMatch = this.name === 'Strategy1' ? 
      volatility.isLowVolatility : volatility.isMediumVolatility;
    
    if (!isVolatilityMatch) {
      return { shouldExecute: false, reason: '波动性不匹配' };
    }

    // 检查价格是否在合适范围
    const priceInRange = this.isPriceInExecutionRange(currentPrice);
    
    if (!priceInRange) {
      return { shouldExecute: false, reason: '价格不在执行范围' };
    }

    return {
      shouldExecute: true,
      confidence: this.calculateConfidence(volatility),
      parameters: this.getOptimalParameters(currentPrice, volatility)
    };
  }

  /**
   * 生成订单
   */
  generateOrders(currentPrice, evaluationResult) {
    const orders = [];
    const config = this.config.trading;
    
    // 计算订单分布
    const maxDrop = config.maxDropPercentage / 100;
    const orderCount = config.orderCount;
    const totalAmount = config.totalAmount;
    
    // 价格步长
    const priceStep = (currentPrice * maxDrop) / (orderCount - 1);
    
    // 金额分配 (递增)
    const baseAmount = totalAmount / this.calculateTotalWeight(config.incrementPercentage, orderCount);
    
    for (let i = 0; i < orderCount; i++) {
      const price = currentPrice - (priceStep * i);
      const weight = Math.pow(1 + config.incrementPercentage / 100, i);
      const amount = baseAmount * weight;
      
      orders.push({
        price: Math.round(price * 100) / 100,
        amount: Math.round(amount * 100) / 100,
        quantity: Math.round((amount / price) * 100000) / 100000,
        level: i + 1
      });
    }
    
    return orders;
  }

  /**
   * 计算总权重
   */
  calculateTotalWeight(incrementPercentage, orderCount) {
    let totalWeight = 0;
    for (let i = 0; i < orderCount; i++) {
      totalWeight += Math.pow(1 + incrementPercentage / 100, i);
    }
    return totalWeight;
  }

  /**
   * 检查价格是否在执行范围
   */
  isPriceInExecutionRange(currentPrice) {
    // 这里可以添加更复杂的价格范围检查逻辑
    return currentPrice > 50000 && currentPrice < 200000; // BTC价格合理范围
  }

  /**
   * 计算执行信心度
   */
  calculateConfidence(volatility) {
    // 基于波动性和历史成功率计算信心度
    const baseConfidence = 0.7;
    const volatilityFactor = volatility.value / 2.0; // 归一化
    
    return Math.min(0.95, baseConfidence + volatilityFactor * 0.2);
  }

  /**
   * 获取优化参数
   */
  getOptimalParameters(currentPrice, volatility) {
    return {
      adjustedTakeProfit: this.config.trading.takeProfitPercentage * (1 + volatility.value * 0.1),
      adjustedMaxDrop: this.config.trading.maxDropPercentage * (1 + volatility.value * 0.05)
    };
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      name: this.name,
      trades: this.stats.trades,
      profit: this.stats.profit,
      loss: this.stats.loss,
      successRate: this.stats.trades > 0 ? (this.stats.profit / (this.stats.profit + this.stats.loss)) * 100 : 0
    };
  }
}

module.exports = DualTradingStrategy;