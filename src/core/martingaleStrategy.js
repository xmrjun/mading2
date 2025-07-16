const { log } = require('../utils/logger');
const { Order } = require('../models/Order');
const Formatter = require('../utils/formatter');

/**
 * 马丁格尔交易策略类
 * 核心原理：亏损时加倍下注，盈利时重置到基础金额
 */
class MartingaleStrategy {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    
    // 马丁格尔参数
    this.baseAmount = config.trading?.baseAmount || 50; // 基础投注金额
    this.martingaleMultiplier = config.trading?.martingaleMultiplier || 2; // 加倍系数
    this.maxConsecutiveLosses = config.trading?.maxConsecutiveLosses || 5; // 最大连续亏损
    this.takeProfitPercentage = config.trading?.takeProfitPercentage || 1.0; // 止盈百分比
    this.stopLossPercentage = config.trading?.stopLossPercentage || 10.0; // 止损百分比
    
    // 状态追踪
    this.consecutiveLosses = 0; // 连续亏损次数
    this.currentAmount = this.baseAmount; // 当前投注金额
    this.totalInvested = 0; // 总投入金额
    this.isRunning = false; // 策略是否运行中
    this.lastTradeResult = null; // 最后交易结果 'win' | 'loss' | null
    this.strategy_id = `martingale_${Date.now()}`; // 策略ID
    
    // 交易记录
    this.tradeHistory = [];
    this.currentPosition = null; // 当前持仓信息
    
    log(`🎯 马丁格尔策略初始化完成:`);
    log(`   基础金额: ${this.baseAmount} USDC`);
    log(`   加倍系数: ${this.martingaleMultiplier}x`);
    log(`   最大连续亏损: ${this.maxConsecutiveLosses} 次`);
    log(`   止盈目标: ${this.takeProfitPercentage}%`);
    log(`   止损阈值: ${this.stopLossPercentage}%`);
  }

  /**
   * 开始马丁格尔策略
   */
  start() {
    if (this.isRunning) {
      log('⚠️ 马丁格尔策略已在运行中');
      return false;
    }
    
    this.isRunning = true;
    this.reset();
    log('🚀 马丁格尔策略已启动');
    return true;
  }

  /**
   * 停止马丁格尔策略
   */
  stop() {
    this.isRunning = false;
    log('⏹️ 马丁格尔策略已停止');
  }

  /**
   * 重置策略状态
   */
  reset() {
    this.consecutiveLosses = 0;
    this.currentAmount = this.baseAmount;
    this.totalInvested = 0;
    this.lastTradeResult = null;
    this.currentPosition = null;
    
    log('🔄 马丁格尔策略状态已重置');
  }

  /**
   * 计算下一笔交易的金额
   * @returns {number} 下一笔交易金额
   */
  calculateNextTradeAmount() {
    if (this.consecutiveLosses === 0) {
      return this.baseAmount;
    }
    
    // 马丁格尔公式：基础金额 * (倍数 ^ 连续亏损次数)
    const nextAmount = this.baseAmount * Math.pow(this.martingaleMultiplier, this.consecutiveLosses);
    
    // 检查是否超过最大风险
    const maxAmount = this.baseAmount * Math.pow(this.martingaleMultiplier, this.maxConsecutiveLosses);
    
    if (nextAmount > maxAmount) {
      log(`⚠️ 计算金额 ${nextAmount} 超过最大限制 ${maxAmount}，使用最大金额`);
      return maxAmount;
    }
    
    return nextAmount;
  }

  /**
   * 创建买入订单
   * @param {number} currentPrice 当前市场价格
   * @param {string} symbol 交易对
   * @param {string} tradingCoin 交易币种
   * @returns {Order|null} 订单对象
   */
  createBuyOrder(currentPrice, symbol, tradingCoin) {
    if (!this.isRunning) {
      log('❌ 策略未运行，无法创建订单');
      return null;
    }

    if (this.consecutiveLosses >= this.maxConsecutiveLosses) {
      log(`❌ 已达到最大连续亏损次数 ${this.maxConsecutiveLosses}，停止交易`);
      this.stop();
      return null;
    }

    const tradeAmount = this.calculateNextTradeAmount();
    
    // 计算买入价格 (略低于市场价以确保成交)
    const buyPriceReduction = 0.1; // 0.1% 低于市场价
    const buyPrice = currentPrice * (1 - buyPriceReduction / 100);
    const adjustedPrice = Formatter.adjustPriceToTickSize(buyPrice, tradingCoin, this.config);
    
    // 计算购买数量
    const quantity = Formatter.adjustQuantityToStepSize(tradeAmount / adjustedPrice, tradingCoin, this.config);
    const actualAmount = adjustedPrice * quantity;
    
    // 检查最小订单金额
    const minOrderAmount = this.config.advanced?.minOrderAmount || 10;
    if (actualAmount < minOrderAmount) {
      log(`❌ 订单金额 ${actualAmount} 小于最小金额 ${minOrderAmount}`);
      return null;
    }

    const orderData = {
      symbol,
      price: adjustedPrice,
      quantity,
      amount: actualAmount,
      side: 'Bid',
      orderType: 'Limit',
      timeInForce: 'GTC',
      strategy: 'martingale',
      martingale_level: this.consecutiveLosses,
      strategy_id: this.strategy_id
    };

    const order = new Order(orderData);
    
    log(`📈 马丁格尔买入订单 (Level ${this.consecutiveLosses}):`);
    log(`   价格: ${adjustedPrice.toFixed(2)} USDC`);
    log(`   数量: ${quantity.toFixed(6)} ${tradingCoin}`);
    log(`   金额: ${actualAmount.toFixed(2)} USDC`);
    log(`   连续亏损: ${this.consecutiveLosses} 次`);
    
    return order;
  }

  /**
   * 创建卖出订单 (止盈)
   * @param {number} currentPrice 当前市场价格
   * @param {number} averagePrice 持仓均价
   * @param {number} position 持仓数量
   * @param {string} symbol 交易对
   * @param {string} tradingCoin 交易币种
   * @returns {Order|null} 订单对象
   */
  createSellOrder(currentPrice, averagePrice, position, symbol, tradingCoin) {
    if (!this.currentPosition || position <= 0) {
      log('❌ 无持仓，无法创建卖出订单');
      return null;
    }

    // 计算止盈价格
    const takeProfitPrice = averagePrice * (1 + this.takeProfitPercentage / 100);
    
    // 使用当前市场价或止盈价格中的较高者
    const sellPrice = Math.max(currentPrice, takeProfitPrice);
    const adjustedPrice = Formatter.adjustPriceToTickSize(sellPrice, tradingCoin, this.config);
    
    // 卖出全部持仓
    const quantity = Formatter.adjustQuantityToStepSize(position, tradingCoin, this.config);
    const amount = adjustedPrice * quantity;

    const orderData = {
      symbol,
      price: adjustedPrice,
      quantity,
      amount,
      side: 'Ask',
      orderType: 'Limit',
      timeInForce: 'GTC',
      strategy: 'martingale_takeprofit',
      strategy_id: this.strategy_id
    };

    const order = new Order(orderData);
    
    log(`📉 马丁格尔止盈订单:`);
    log(`   价格: ${adjustedPrice.toFixed(2)} USDC`);
    log(`   数量: ${quantity.toFixed(6)} ${tradingCoin}`);
    log(`   金额: ${amount.toFixed(2)} USDC`);
    log(`   预期盈利: ${((adjustedPrice - averagePrice) * quantity).toFixed(2)} USDC`);
    
    return order;
  }

  /**
   * 处理交易结果
   * @param {string} result 交易结果 'win' | 'loss'
   * @param {number} profit 盈亏金额
   * @param {Object} tradeInfo 交易信息
   */
  processTradeResult(result, profit, tradeInfo = {}) {
    this.lastTradeResult = result;
    
    const tradeRecord = {
      timestamp: new Date(),
      result,
      profit,
      amount: this.currentAmount,
      level: this.consecutiveLosses,
      ...tradeInfo
    };
    
    this.tradeHistory.push(tradeRecord);

    if (result === 'win') {
      log(`✅ 马丁格尔交易盈利: +${profit.toFixed(2)} USDC`);
      log(`🎉 连续亏损结束，重置到基础金额`);
      
      // 盈利时重置策略
      this.consecutiveLosses = 0;
      this.currentAmount = this.baseAmount;
      this.currentPosition = null;
      
    } else if (result === 'loss') {
      log(`❌ 马丁格尔交易亏损: -${Math.abs(profit).toFixed(2)} USDC`);
      
      // 亏损时增加连续亏损计数
      this.consecutiveLosses++;
      this.currentAmount = this.calculateNextTradeAmount();
      
      log(`📊 连续亏损次数: ${this.consecutiveLosses}/${this.maxConsecutiveLosses}`);
      log(`💰 下次交易金额: ${this.currentAmount.toFixed(2)} USDC`);
      
      // 检查是否达到最大亏损
      if (this.consecutiveLosses >= this.maxConsecutiveLosses) {
        log(`🚨 达到最大连续亏损次数，策略自动停止`);
        this.stop();
      }
    }

    // 更新统计
    this.updateStatistics();
  }

  /**
   * 检查是否应该止盈
   * @param {number} currentPrice 当前价格
   * @param {number} averagePrice 持仓均价
   * @returns {boolean} 是否应该止盈
   */
  shouldTakeProfit(currentPrice, averagePrice) {
    if (!averagePrice || averagePrice <= 0) {
      return false;
    }

    const priceIncrease = ((currentPrice - averagePrice) / averagePrice) * 100;
    return priceIncrease >= this.takeProfitPercentage;
  }

  /**
   * 检查是否应该止损
   * @param {number} currentPrice 当前价格
   * @param {number} averagePrice 持仓均价
   * @returns {boolean} 是否应该止损
   */
  shouldStopLoss(currentPrice, averagePrice) {
    if (!averagePrice || averagePrice <= 0) {
      return false;
    }

    const priceDecrease = ((averagePrice - currentPrice) / averagePrice) * 100;
    return priceDecrease >= this.stopLossPercentage;
  }

  /**
   * 更新统计信息
   */
  updateStatistics() {
    const wins = this.tradeHistory.filter(t => t.result === 'win').length;
    const losses = this.tradeHistory.filter(t => t.result === 'loss').length;
    const totalProfit = this.tradeHistory.reduce((sum, t) => sum + t.profit, 0);
    
    log(`📊 马丁格尔策略统计:`);
    log(`   总交易: ${this.tradeHistory.length} 笔`);
    log(`   盈利: ${wins} 笔 | 亏损: ${losses} 笔`);
    log(`   胜率: ${(wins / (wins + losses) * 100).toFixed(1)}%`);
    log(`   总盈亏: ${totalProfit.toFixed(2)} USDC`);
    log(`   当前Level: ${this.consecutiveLosses}`);
  }

  /**
   * 获取策略状态
   * @returns {Object} 策略状态信息
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      consecutiveLosses: this.consecutiveLosses,
      currentAmount: this.currentAmount,
      maxLosses: this.maxConsecutiveLosses,
      totalTrades: this.tradeHistory.length,
      lastResult: this.lastTradeResult,
      riskLevel: this.consecutiveLosses / this.maxConsecutiveLosses
    };
  }

  /**
   * 设置持仓信息
   * @param {Object} position 持仓信息
   */
  setPosition(position) {
    this.currentPosition = position;
  }

  /**
   * 获取风险评估
   * @returns {Object} 风险评估信息
   */
  getRiskAssessment() {
    const riskLevel = this.consecutiveLosses / this.maxConsecutiveLosses;
    const potentialLoss = this.baseAmount * (Math.pow(this.martingaleMultiplier, this.maxConsecutiveLosses) - 1) / (this.martingaleMultiplier - 1);
    
    let riskCategory;
    if (riskLevel < 0.3) {
      riskCategory = '低风险';
    } else if (riskLevel < 0.7) {
      riskCategory = '中风险';
    } else {
      riskCategory = '高风险';
    }
    
    return {
      riskLevel: riskLevel,
      riskCategory: riskCategory,
      consecutiveLosses: this.consecutiveLosses,
      maxLosses: this.maxConsecutiveLosses,
      potentialMaxLoss: potentialLoss,
      nextTradeAmount: this.calculateNextTradeAmount()
    };
  }
}

module.exports = MartingaleStrategy;