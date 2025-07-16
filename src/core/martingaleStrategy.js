const { log } = require('../utils/logger');
const { Order } = require('../models/Order');
const Formatter = require('../utils/formatter');

/**
 * 马丁格尔交易策略类
 * 核心原理：每次独立交易，亏损时加倍下注，盈利时重置
 * 修正版：实现真正的马丁格尔连续交易循环
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
    this.stopLossPercentage = config.trading?.stopLossPercentage || 3.0; // 止损百分比(应该较小)
    
    // 状态追踪
    this.consecutiveLosses = 0; // 连续亏损次数
    this.currentAmount = this.baseAmount; // 当前投注金额
    this.isRunning = false; // 策略是否运行中
    this.lastTradeResult = null; // 最后交易结果 'win' | 'loss' | null
    this.strategy_id = `martingale_${Date.now()}`; // 策略ID
    
    // 交易周期状态
    this.currentCycle = null; // 当前交易周期信息
    this.tradeHistory = [];
    this.isInTrade = false; // 是否在交易中
    
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
    this.isInTrade = false;
    this.currentCycle = null;
    log('⏹️ 马丁格尔策略已停止');
  }

  /**
   * 重置策略状态
   */
  reset() {
    this.consecutiveLosses = 0;
    this.currentAmount = this.baseAmount;
    this.lastTradeResult = null;
    this.currentCycle = null;
    this.isInTrade = false;
    
    log('🔄 马丁格尔策略状态已重置');
  }

  /**
   * 计算当前交易周期的投注金额
   * @returns {number} 当前周期投注金额
   */
  getCurrentTradeAmount() {
    if (this.consecutiveLosses === 0) {
      return this.baseAmount;
    }
    
    // 马丁格尔公式：基础金额 * (倍数 ^ 连续亏损次数)
    const amount = this.baseAmount * Math.pow(this.martingaleMultiplier, this.consecutiveLosses);
    
    // 检查是否超过最大风险
    const maxAmount = this.baseAmount * Math.pow(this.martingaleMultiplier, this.maxConsecutiveLosses);
    
    if (amount > maxAmount) {
      log(`⚠️ 计算金额 ${amount} 超过最大限制 ${maxAmount}，使用最大金额`);
      return maxAmount;
    }
    
    return amount;
  }

  /**
   * 检查是否可以开始新的交易周期
   * @returns {boolean} 是否可以开始新交易
   */
  canStartNewTrade() {
    if (!this.isRunning) {
      return false;
    }
    
    if (this.isInTrade) {
      return false; // 已在交易中
    }
    
    if (this.consecutiveLosses >= this.maxConsecutiveLosses) {
      log(`❌ 已达到最大连续亏损次数 ${this.maxConsecutiveLosses}，停止交易`);
      this.stop();
      return false;
    }
    
    return true;
  }

  /**
   * 开始新的交易周期
   * @param {number} currentPrice 当前市场价格
   * @param {string} symbol 交易对
   * @param {string} tradingCoin 交易币种
   * @returns {Order|null} 买入订单
   */
  startNewTradeCycle(currentPrice, symbol, tradingCoin) {
    if (!this.canStartNewTrade()) {
      return null;
    }

    const tradeAmount = this.getCurrentTradeAmount();
    
    // 计算买入价格 (市价单，略低于市场价确保成交)
    const buyPriceReduction = 0.05; // 0.05% 低于市场价
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

    // 创建交易周期信息
    this.currentCycle = {
      id: `cycle_${Date.now()}`,
      level: this.consecutiveLosses,
      investAmount: actualAmount,
      buyPrice: adjustedPrice,
      quantity: quantity,
      targetProfit: actualAmount * this.takeProfitPercentage / 100,
      maxLoss: actualAmount * this.stopLossPercentage / 100,
      startTime: new Date(),
      status: 'buying'
    };

    this.isInTrade = true;

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
      strategy_id: this.strategy_id,
      cycle_id: this.currentCycle.id
    };

    const order = new Order(orderData);
    
    log(`📈 马丁格尔买入订单 (Level ${this.consecutiveLosses}):`);
    log(`   周期ID: ${this.currentCycle.id}`);
    log(`   价格: ${adjustedPrice.toFixed(2)} USDC`);
    log(`   数量: ${quantity.toFixed(6)} ${tradingCoin}`);
    log(`   金额: ${actualAmount.toFixed(2)} USDC`);
    log(`   目标盈利: ${this.currentCycle.targetProfit.toFixed(2)} USDC`);
    log(`   最大亏损: ${this.currentCycle.maxLoss.toFixed(2)} USDC`);
    
    return order;
  }

  /**
   * 处理买入订单成交
   * @param {Object} orderInfo 订单信息
   */
  onBuyOrderFilled(orderInfo) {
    if (!this.currentCycle || this.currentCycle.status !== 'buying') {
      log('⚠️ 买入成交但无对应周期或状态不匹配');
      return;
    }

    // 更新周期状态
    this.currentCycle.status = 'holding';
    this.currentCycle.actualBuyPrice = parseFloat(orderInfo.avgPrice || orderInfo.price);
    this.currentCycle.actualQuantity = parseFloat(orderInfo.filledQuantity || orderInfo.quantity);
    this.currentCycle.actualInvestAmount = this.currentCycle.actualBuyPrice * this.currentCycle.actualQuantity;

    // 重新计算止盈止损价格
    this.currentCycle.takeProfitPrice = this.currentCycle.actualBuyPrice * (1 + this.takeProfitPercentage / 100);
    this.currentCycle.stopLossPrice = this.currentCycle.actualBuyPrice * (1 - this.stopLossPercentage / 100);

    log(`✅ 买入成交，等待止盈/止损:`);
    log(`   实际买价: ${this.currentCycle.actualBuyPrice.toFixed(2)} USDC`);
    log(`   实际数量: ${this.currentCycle.actualQuantity.toFixed(6)}`);
    log(`   止盈价格: ${this.currentCycle.takeProfitPrice.toFixed(2)} USDC`);
    log(`   止损价格: ${this.currentCycle.stopLossPrice.toFixed(2)} USDC`);
  }

  /**
   * 检查是否应该止盈
   * @param {number} currentPrice 当前价格
   * @returns {boolean} 是否应该止盈
   */
  shouldTakeProfit(currentPrice) {
    if (!this.currentCycle || this.currentCycle.status !== 'holding') {
      return false;
    }

    return currentPrice >= this.currentCycle.takeProfitPrice;
  }

  /**
   * 检查是否应该止损
   * @param {number} currentPrice 当前价格
   * @returns {boolean} 是否应该止损
   */
  shouldStopLoss(currentPrice) {
    if (!this.currentCycle || this.currentCycle.status !== 'holding') {
      return false;
    }

    return currentPrice <= this.currentCycle.stopLossPrice;
  }

  /**
   * 创建卖出订单
   * @param {number} currentPrice 当前市场价格
   * @param {string} symbol 交易对
   * @param {string} tradingCoin 交易币种
   * @param {string} reason 卖出原因 'takeprofit' | 'stoploss'
   * @returns {Order|null} 卖出订单
   */
  createSellOrder(currentPrice, symbol, tradingCoin, reason = 'takeprofit') {
    if (!this.currentCycle || this.currentCycle.status !== 'holding') {
      log('❌ 无持仓周期，无法创建卖出订单');
      return null;
    }

    // 使用市价单快速成交
    let sellPrice;
    if (reason === 'takeprofit') {
      sellPrice = Math.max(currentPrice, this.currentCycle.takeProfitPrice);
    } else {
      sellPrice = Math.min(currentPrice, this.currentCycle.stopLossPrice);
    }

    const adjustedPrice = Formatter.adjustPriceToTickSize(sellPrice, tradingCoin, this.config);
    const quantity = this.currentCycle.actualQuantity;
    const amount = adjustedPrice * quantity;

    this.currentCycle.status = 'selling';
    this.currentCycle.sellReason = reason;
    this.currentCycle.targetSellPrice = adjustedPrice;

    const orderData = {
      symbol,
      price: adjustedPrice,
      quantity,
      amount,
      side: 'Ask',
      orderType: 'Limit',
      timeInForce: 'GTC',
      strategy: `martingale_${reason}`,
      strategy_id: this.strategy_id,
      cycle_id: this.currentCycle.id
    };

    const order = new Order(orderData);
    
    const expectedProfit = (adjustedPrice - this.currentCycle.actualBuyPrice) * quantity;
    
    log(`📉 马丁格尔${reason === 'takeprofit' ? '止盈' : '止损'}订单:`);
    log(`   价格: ${adjustedPrice.toFixed(2)} USDC`);
    log(`   数量: ${quantity.toFixed(6)} ${tradingCoin}`);
    log(`   预期${expectedProfit >= 0 ? '盈利' : '亏损'}: ${expectedProfit.toFixed(2)} USDC`);
    
    return order;
  }

  /**
   * 处理卖出订单成交 - 完成交易周期
   * @param {Object} orderInfo 订单信息
   */
  onSellOrderFilled(orderInfo) {
    if (!this.currentCycle || this.currentCycle.status !== 'selling') {
      log('⚠️ 卖出成交但无对应周期或状态不匹配');
      return;
    }

    // 计算实际盈亏
    const actualSellPrice = parseFloat(orderInfo.avgPrice || orderInfo.price);
    const actualQuantity = parseFloat(orderInfo.filledQuantity || orderInfo.quantity);
    const actualProfit = (actualSellPrice - this.currentCycle.actualBuyPrice) * actualQuantity;

    // 完成周期记录
    this.currentCycle.status = 'completed';
    this.currentCycle.actualSellPrice = actualSellPrice;
    this.currentCycle.actualProfit = actualProfit;
    this.currentCycle.endTime = new Date();
    this.currentCycle.duration = this.currentCycle.endTime - this.currentCycle.startTime;

    // 判断交易结果
    const result = actualProfit > 0 ? 'win' : 'loss';
    
    // 记录到历史
    this.tradeHistory.push({...this.currentCycle});

    // 处理马丁格尔逻辑
    if (result === 'win') {
      log(`✅ 交易周期完成 - 盈利: +${actualProfit.toFixed(2)} USDC`);
      log(`🎉 连续亏损结束，重置到基础金额`);
      
      // 盈利时重置策略
      this.consecutiveLosses = 0;
      this.lastTradeResult = 'win';
      
    } else {
      log(`❌ 交易周期完成 - 亏损: ${actualProfit.toFixed(2)} USDC`);
      
      // 亏损时增加连续亏损计数
      this.consecutiveLosses++;
      this.lastTradeResult = 'loss';
      
      log(`📊 连续亏损次数: ${this.consecutiveLosses}/${this.maxConsecutiveLosses}`);
      
      // 检查是否达到最大亏损
      if (this.consecutiveLosses >= this.maxConsecutiveLosses) {
        log(`🚨 达到最大连续亏损次数，策略自动停止`);
        this.stop();
      }
    }

    // 重置交易状态，准备下一周期
    this.isInTrade = false;
    this.currentCycle = null;

    // 更新统计
    this.updateStatistics();
  }

  /**
   * 更新统计信息
   */
  updateStatistics() {
    const wins = this.tradeHistory.filter(t => t.actualProfit > 0).length;
    const losses = this.tradeHistory.filter(t => t.actualProfit <= 0).length;
    const totalProfit = this.tradeHistory.reduce((sum, t) => sum + t.actualProfit, 0);
    
    log(`📊 马丁格尔策略统计:`);
    log(`   总交易: ${this.tradeHistory.length} 笔`);
    log(`   盈利: ${wins} 笔 | 亏损: ${losses} 笔`);
    log(`   胜率: ${this.tradeHistory.length > 0 ? (wins / this.tradeHistory.length * 100).toFixed(1) : 0}%`);
    log(`   总盈亏: ${totalProfit.toFixed(2)} USDC`);
    log(`   当前Level: ${this.consecutiveLosses}`);
    log(`   下次金额: ${this.getCurrentTradeAmount().toFixed(2)} USDC`);
  }

  /**
   * 获取策略状态
   * @returns {Object} 策略状态信息
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      isInTrade: this.isInTrade,
      consecutiveLosses: this.consecutiveLosses,
      currentAmount: this.getCurrentTradeAmount(),
      maxLosses: this.maxConsecutiveLosses,
      totalTrades: this.tradeHistory.length,
      lastResult: this.lastTradeResult,
      riskLevel: this.consecutiveLosses / this.maxConsecutiveLosses,
      currentCycle: this.currentCycle
    };
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
      nextTradeAmount: this.getCurrentTradeAmount()
    };
  }
}

module.exports = MartingaleStrategy;