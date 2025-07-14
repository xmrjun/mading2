const Formatter = require('../utils/formatter');
const { log } = require('../utils/logger');
const { Order } = require('../models/Order');

/**
 * 马丁格尔交易策略类 - 实现真正的马丁格尔策略
 */
class MartingaleStrategy {
  constructor(logger, config = {}) {
    this.logger = logger;
    this.config = config;
    
    // 马丁格尔策略状态
    this.currentSequence = 0; // 当前序列中的位置
    this.consecutiveLosses = 0; // 连续亏损次数
    this.baseAmount = config.martingale?.baseAmount || 151; // 基础投资金额
    this.currentAmount = this.baseAmount; // 当前投资金额
    this.currentDirection = null; // 当前交易方向 ('buy' 或 'sell')
    this.sequenceStartPrice = null; // 序列开始时的价格
    this.lastTradeResult = null; // 上次交易结果
    this.maxConsecutiveLosses = config.martingale?.maxConsecutiveLosses || 5;
    this.totalRiskLimit = config.martingale?.totalRiskLimit || 10000;
    this.multiplier = config.martingale?.multiplier || 2; // 递增倍数
    this.stopLossPercentage = config.martingale?.stopLossPercentage || 2; // 止损百分比
    this.takeProfitPercentage = config.martingale?.takeProfitPercentage || 1; // 止盈百分比
    
    // 统计信息
    this.totalInvested = 0;
    this.totalProfitLoss = 0;
    this.sequenceHistory = [];
    this.isActive = false;
    
    this.logger.info('马丁格尔策略已初始化', {
      baseAmount: this.baseAmount,
      maxConsecutiveLosses: this.maxConsecutiveLosses,
      totalRiskLimit: this.totalRiskLimit
    });
  }

  /**
   * 分析市场并确定初始交易方向
   */
  analyzeMarketDirection(currentPrice, priceHistory = []) {
    // 简单的趋势分析
    if (priceHistory.length < 2) {
      // 无历史数据，默认买入
      return 'buy';
    }
    
    // 计算最近价格变化
    const recentPrices = priceHistory.slice(-5);
    const priceChange = recentPrices[recentPrices.length - 1] - recentPrices[0];
    
    // 如果价格上涨，预测回调，做空
    // 如果价格下跌，预测反弹，做多
    return priceChange > 0 ? 'sell' : 'buy';
  }

  /**
   * 检查是否应该停止交易
   */
  shouldStopTrading() {
    // 检查连续亏损次数
    if (this.consecutiveLosses >= this.maxConsecutiveLosses) {
      this.logger.warn(`连续亏损次数达到上限: ${this.consecutiveLosses}`);
      return true;
    }
    
    // 检查总投资金额
    if (this.totalInvested >= this.totalRiskLimit) {
      this.logger.warn(`总投资金额达到上限: ${this.totalInvested}`);
      return true;
    }
    
    // 检查下次交易金额是否超过风险限制
    const nextAmount = this.currentAmount * this.multiplier;
    if (this.totalInvested + nextAmount > this.totalRiskLimit) {
      this.logger.warn(`下次交易将超过风险限制: ${this.totalInvested + nextAmount}`);
      return true;
    }
    
    return false;
  }

  /**
   * 计算下一个交易订单
   */
  calculateNextOrder(currentPrice, symbol, tradingCoin, priceHistory = []) {
    if (this.shouldStopTrading()) {
      this.logger.error('🚫 马丁格尔策略已停止 - 达到风险限制');
      return null;
    }

    // 第一次交易或重置后，确定方向
    if (this.currentDirection === null) {
      this.currentDirection = this.analyzeMarketDirection(currentPrice, priceHistory);
      this.sequenceStartPrice = currentPrice;
      this.currentAmount = this.baseAmount;
      this.currentSequence = 1;
      
      this.logger.info('🎯 开始新的马丁格尔序列', {
        direction: this.currentDirection,
        startPrice: this.sequenceStartPrice,
        amount: this.currentAmount,
        sequence: this.currentSequence
      });
    }

    // 调整价格精度
    const adjustedPrice = Formatter.adjustPriceToTickSize(currentPrice, tradingCoin, this.config);
    
    // 计算数量
    const quantity = Formatter.adjustQuantityToStepSize(
      this.currentAmount / adjustedPrice, 
      tradingCoin, 
      this.config
    );
    
    // 创建订单
    const side = this.currentDirection === 'buy' ? 'Bid' : 'Ask';
    const orderData = {
      symbol,
      price: adjustedPrice,
      quantity,
      amount: this.currentAmount,
      side,
      orderType: 'Market', // 使用市价单确保成交
      timeInForce: 'GTC',
      martingaleSequence: this.currentSequence,
      martingaleDirection: this.currentDirection
    };
    
    const order = new Order(orderData);
    
    this.logger.info('📋 生成马丁格尔订单', {
      side: this.currentDirection,
      price: adjustedPrice,
      quantity: quantity,
      amount: this.currentAmount,
      sequence: this.currentSequence,
      consecutiveLosses: this.consecutiveLosses
    });
    
    return order;
  }

  /**
   * 处理交易结果
   */
  async handleTradeResult(order, fillPrice, isProfit) {
    const tradeResult = {
      sequence: this.currentSequence,
      direction: this.currentDirection,
      entryPrice: order.price,
      fillPrice: fillPrice,
      amount: this.currentAmount,
      quantity: order.quantity,
      profit: isProfit,
      timestamp: new Date()
    };

    this.sequenceHistory.push(tradeResult);
    this.lastTradeResult = tradeResult;

    if (isProfit) {
      // 盈利 - 重置策略
      this.logger.info('✅ 交易盈利 - 重置马丁格尔策略', {
        sequence: this.currentSequence,
        profit: this.calculateProfit(order.price, fillPrice, order.quantity),
        direction: this.currentDirection
      });
      
      this.resetStrategy();
    } else {
      // 亏损 - 增加投资金额
      this.consecutiveLosses++;
      this.currentAmount *= this.multiplier;
      this.currentSequence++;
      
      this.logger.warn('❌ 交易亏损 - 增加投资金额', {
        sequence: this.currentSequence,
        consecutiveLosses: this.consecutiveLosses,
        currentAmount: this.currentAmount,
        direction: this.currentDirection
      });
    }

    // 更新统计
    this.totalInvested += order.amount;
    this.totalProfitLoss += isProfit ? 
      this.calculateProfit(order.price, fillPrice, order.quantity) : 
      -this.calculateLoss(order.price, fillPrice, order.quantity);
  }

  /**
   * 计算利润
   */
  calculateProfit(entryPrice, exitPrice, quantity) {
    if (this.currentDirection === 'buy') {
      return (exitPrice - entryPrice) * quantity;
    } else {
      return (entryPrice - exitPrice) * quantity;
    }
  }

  /**
   * 计算损失
   */
  calculateLoss(entryPrice, exitPrice, quantity) {
    return Math.abs(this.calculateProfit(entryPrice, exitPrice, quantity));
  }

  /**
   * 检查是否应该止盈
   */
  shouldTakeProfit(currentPrice, entryPrice) {
    const profitPercentage = this.currentDirection === 'buy' ? 
      ((currentPrice - entryPrice) / entryPrice) * 100 :
      ((entryPrice - currentPrice) / entryPrice) * 100;
    
    return profitPercentage >= this.takeProfitPercentage;
  }

  /**
   * 检查是否应该止损
   */
  shouldStopLoss(currentPrice, entryPrice) {
    const lossPercentage = this.currentDirection === 'buy' ? 
      ((entryPrice - currentPrice) / entryPrice) * 100 :
      ((currentPrice - entryPrice) / entryPrice) * 100;
    
    return lossPercentage >= this.stopLossPercentage;
  }

  /**
   * 重置策略状态
   */
  resetStrategy() {
    this.currentSequence = 0;
    this.consecutiveLosses = 0;
    this.currentAmount = this.baseAmount;
    this.currentDirection = null;
    this.sequenceStartPrice = null;
    this.lastTradeResult = null;
    
    this.logger.info('🔄 马丁格尔策略已重置');
  }

  /**
   * 获取策略状态
   */
  getStatus() {
    return {
      isActive: this.isActive,
      currentSequence: this.currentSequence,
      consecutiveLosses: this.consecutiveLosses,
      currentAmount: this.currentAmount,
      currentDirection: this.currentDirection,
      totalInvested: this.totalInvested,
      totalProfitLoss: this.totalProfitLoss,
      sequenceHistory: this.sequenceHistory,
      riskStatus: {
        shouldStop: this.shouldStopTrading(),
        remainingRisk: this.totalRiskLimit - this.totalInvested,
        maxConsecutiveLosses: this.maxConsecutiveLosses
      }
    };
  }

  /**
   * 启动策略
   */
  start() {
    this.isActive = true;
    this.logger.info('🚀 马丁格尔策略已启动');
  }

  /**
   * 停止策略
   */
  stop() {
    this.isActive = false;
    this.logger.info('🛑 马丁格尔策略已停止');
  }
}

module.exports = MartingaleStrategy;