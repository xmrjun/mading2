const Formatter = require('../utils/formatter');
const { log } = require('../utils/logger');
const { Order } = require('../models/Order');

/**
 * 交易策略类 - 负责计算交易策略和订单
 */
class TradingStrategy {
  /**
   * 构造函数
   * @param {Object} logger - 日志对象
   * @param {Object} config - 配置对象(可选)
   */
  constructor(logger, config = {}) {
    this.logger = logger;
    this.config = config;
    
    // 马丁格尔策略状态
    this.strategyState = {
      active: false,
      filledOrders: 0,
      totalOrders: config.trading?.orderCount || 10,
      averagePrice: 0,
      totalQuantity: 0,
      lastTradeTime: 0
    };
  }
  
  /**
   * 计算递增订单
   * @param {number} currentPrice - 当前市场价格
   * @param {number} maxDropPercentage - 最大跌幅百分比
   * @param {number} totalAmount - 总投资金额
   * @param {number} orderCount - 订单数量
   * @param {number} incrementPercentage - 递增百分比
   * @param {number} minOrderAmount - 最小订单金额
   * @param {string} tradingCoin - 交易币种
   * @param {string} symbol - 交易对符号
   * @returns {Array<Order>} 订单列表
   */
  calculateIncrementalOrders(
    currentPrice,
    maxDropPercentage,
    totalAmount,
    orderCount,
    incrementPercentage,
    minOrderAmount,
    tradingCoin,
    symbol,
    positionInfo = null
  ) {
    const orders = [];
    
    // 🔑 检查是否为补仓模式
    if (positionInfo && positionInfo.quantity > 0) {
      log(`🔄 补仓模式：已有 ${positionInfo.filledOrders} 单成交，创建剩余 ${orderCount - positionInfo.filledOrders} 个买单`);
      log(`📊 当前持仓：${positionInfo.quantity.toFixed(6)} ${tradingCoin} @ ${positionInfo.averagePrice.toFixed(2)} USDC`);
      
      // 调整订单数量和起始价格，基于持仓均价而非当前价格
      const remainingOrders = Math.max(0, orderCount - positionInfo.filledOrders);
      if (remainingOrders === 0) {
        log('✅ 所有计划订单已成交，无需创建新买单');
        return orders;
      }
      
      // 使用持仓均价作为基准，创建更低价位的买单
      const basePrice = positionInfo.averagePrice;
      log(`📈 基准价格（持仓均价）: ${basePrice.toFixed(2)} USDC`);
      
      // 从已成交订单的下一个价位开始创建
      const startOrderIndex = positionInfo.filledOrders;
      orderCount = remainingOrders;
      
      // 重新计算价格分布，基于持仓均价
      const totalDropFromAverage = 3.0; // 从均价开始下跌3%
      const lowestPrice = basePrice * (1 - totalDropFromAverage / 100);
      
      for (let i = 0; i < remainingOrders; i++) {
        const actualIndex = startOrderIndex + i;
        const priceStep = (basePrice - lowestPrice) / orderCount;
        let rawPrice = basePrice - (priceStep * (i + 1));
        
        // 调整价格到交易所接受的格式
        const price = Formatter.adjustPriceToTickSize(rawPrice, tradingCoin, this.config);
        
        // 计算递增订单金额
        const r = 1 + incrementPercentage / 100;
        const baseAmount = totalAmount * (r - 1) / (Math.pow(r, orderCount) - 1);
        const orderAmount = baseAmount * Math.pow(r, i);
        
        // 计算数量并调整精度
        const quantity = Formatter.adjustQuantityToStepSize(orderAmount / price, tradingCoin, this.config);
        const actualAmount = price * quantity;
        
        if (actualAmount >= minOrderAmount) {
          const orderData = {
            symbol,
            price,
            quantity,
            amount: actualAmount,
            side: 'Bid',
            orderType: 'Limit',
            timeInForce: 'GTC'
          };
          
          const order = new Order(orderData);
          orders.push(order);
          
          log(`📋 补仓订单${actualIndex + 1}: ${quantity.toFixed(6)} ${tradingCoin} @ ${price.toFixed(2)} USDC`);
        }
      }
      
      log(`✅ 补仓模式完成，创建了 ${orders.length} 个剩余买单`);
      return orders;
    }
    
    // 🔑 全新策略模式：第一个订单0.2%，后面订单在总3%区间内均匀分布
    const firstOrderDropPercentage = 0.2; // 第一个订单下跌0.2%
    const totalDropPercentage = 3.0; // 总的价格区间3%
    
    // 第一个订单价格
    const firstOrderPrice = currentPrice * (1 - firstOrderDropPercentage / 100);
    
    // 最低价格（总跌幅3%）
    const lowestPrice = currentPrice * (1 - totalDropPercentage / 100);
    
    // 后面4个订单在剩余区间内的价格步长
    const remainingOrders = orderCount - 1; // 剩余订单数量
    const priceStep = (firstOrderPrice - lowestPrice) / remainingOrders;
    
    // 计算基础订单金额（使用等比数列求和公式）
    // 总金额 = 基础金额 * (1 + r + r^2 + ... + r^(n-1))
    // 总金额 = 基础金额 * (1 - r^n) / (1 - r)
    // 基础金额 = 总金额 * (1 - r) / (1 - r^n)
    const r = 1 + incrementPercentage / 100; // 递增比例
    
    // 确保基础订单金额不小于最小订单金额
    const calculatedBaseAmount = totalAmount * (r - 1) / (Math.pow(r, orderCount) - 1);
    const baseAmount = Math.max(minOrderAmount, calculatedBaseAmount);
    
    // 计算实际总金额
    let actualTotalAmount = 0;
    for (let i = 0; i < orderCount; i++) {
      actualTotalAmount += baseAmount * Math.pow(r, i);
    }
    
    // 处理实际总金额超过用户输入的总金额的情况
    const orderAmounts = [];
    const scale = actualTotalAmount > totalAmount ? totalAmount / actualTotalAmount : 1;
    
    // 创建订单
    for (let i = 0; i < orderCount; i++) {
      let rawPrice;
      
      if (i === 0) {
        // 第一个订单：当前价格下跌0.2%
        rawPrice = firstOrderPrice;
      } else {
        // 后面的订单：在剩余2.8%区间内正确分布
        const remainingRange = firstOrderPrice - lowestPrice; // 2.8%的价格区间
        rawPrice = firstOrderPrice - (remainingRange * i / (orderCount - 1));
      }
      
      // 调整价格到交易所接受的格式
      const price = Formatter.adjustPriceToTickSize(rawPrice, tradingCoin, this.config);
      
      // 计算当前订单金额（递增并缩放）
      const orderAmount = baseAmount * Math.pow(r, i) * scale;
      
      // 计算数量并调整精度
      const quantity = Formatter.adjustQuantityToStepSize(orderAmount / price, tradingCoin, this.config);
      const actualAmount = price * quantity;
      
      // 只有当订单金额满足最小要求时才添加
      if (actualAmount >= minOrderAmount) {
        const orderData = {
          symbol,
          price,
          quantity,
          amount: actualAmount,
          side: 'Bid',
          orderType: 'Limit',
          timeInForce: 'GTC'
        };
        
        const order = new Order(orderData);
        orders.push(order);
        
        orderAmounts.push(actualAmount);
      }
    }
    
    // 如果没有生成任何订单，抛出错误
    if (orders.length === 0) {
      throw new Error('无法生成有效订单，请检查输入参数');
    }
    
    // 计算实际总金额
    const finalTotalAmount = orderAmounts.reduce((sum, amount) => sum + amount, 0);
    
    log(`计划总金额: ${totalAmount.toFixed(2)} USDC`);
    log(`实际总金额: ${finalTotalAmount.toFixed(2)} USDC`);
    
    return orders;
  }
  
  /**
   * 检查是否达到止盈条件
   * @param {number} currentPrice - 当前价格
   * @param {number} averagePrice - 平均买入价格
   * @param {number} takeProfitPercentage - 止盈百分比
   * @returns {boolean} 是否达到止盈条件
   */
  isTakeProfitTriggered(currentPrice, averagePrice, takeProfitPercentage) {
    if (!currentPrice || !averagePrice || averagePrice <= 0) {
      return false;
    }
    
    // 计算价格涨幅百分比
    const priceIncrease = ((currentPrice - averagePrice) / averagePrice) * 100;
    
    // 判断是否达到止盈条件
    return priceIncrease >= takeProfitPercentage;
  }

  /**
   * 检查价格是否仍然适合执行止盈
   * @param {number} triggerPrice - 触发止盈时的价格
   * @param {number} currentPrice - 当前价格
   * @param {number} maxPriceDeviation - 最大价格偏差百分比 (默认2%)
   * @returns {boolean} 是否仍然适合执行
   */
  isPriceStillValidForTakeProfit(triggerPrice, currentPrice, maxPriceDeviation = 2) {
    if (!triggerPrice || !currentPrice) return false;
    
    const deviation = Math.abs((currentPrice - triggerPrice) / triggerPrice) * 100;
    return deviation <= maxPriceDeviation;
  }

  /**
   * 带价格验证的止盈判断
   * @param {number} currentPrice - 当前价格
   * @param {number} averagePrice - 平均买入价
   * @param {number} takeProfitPercentage - 止盈百分比
   * @param {number} priceAge - 价格数据年龄(秒)
   * @returns {Object} 止盈判断结果
   */
  evaluateTakeProfitWithPriceValidation(currentPrice, averagePrice, takeProfitPercentage, priceAge = 0) {
    // 基本止盈判断
    const basicResult = this.isTakeProfitTriggered(currentPrice, averagePrice, takeProfitPercentage);
    
    // 价格数据时效性检查
    const isPriceRecent = priceAge < 30; // 价格数据30秒内有效
    
    // 价格变化合理性检查
    const priceChangePercent = ((currentPrice - averagePrice) / averagePrice) * 100;
    const isReasonableChange = priceChangePercent <= takeProfitPercentage * 1.5; // 不超过目标的1.5倍
    
    return {
      shouldTakeProfit: basicResult && isPriceRecent && isReasonableChange,
      reason: basicResult ? (isPriceRecent ? (isReasonableChange ? 'valid' : 'price_too_high') : 'price_too_old') : 'threshold_not_met',
      priceChangePercent,
      priceAge
    };
  }

  /**
   * 检查是否应该快速重启（用于高频交易）
   * @param {number} currentPrice - 当前价格
   * @param {number} averagePrice - 平均买入价格
   * @param {number} takeProfitPercentage - 止盈百分比
   * @returns {boolean} 是否应该快速重启
   */
  shouldQuickRestart(currentPrice, averagePrice, takeProfitPercentage) {
    // 如果达到止盈条件，应该快速重启
    if (this.isTakeProfitTriggered(currentPrice, averagePrice, takeProfitPercentage)) {
      return true;
    }
    
    // 如果没有持仓，也应该考虑重启
    if (!averagePrice || averagePrice <= 0) {
      return true;
    }
    
    return false;
  }

  /**
   * 计算高频交易的最优参数
   * @param {number} currentPrice - 当前价格
   * @param {Object} config - 配置对象
   * @returns {Object} 优化后的参数
   */
  calculateOptimalParameters(currentPrice, config) {
    // 基于当前价格和市场条件调整参数
    const optimized = {
      maxDropPercentage: config.trading.maxDropPercentage,
      takeProfitPercentage: config.trading.takeProfitPercentage,
      orderCount: config.trading.orderCount,
      totalAmount: config.trading.totalAmount
    };
    
    // 如果是高频模式，使用更小的参数
    if (config.advanced?.quickRestartAfterTakeProfit) {
      optimized.maxDropPercentage = Math.min(optimized.maxDropPercentage, 1.5);
      optimized.takeProfitPercentage = Math.min(optimized.takeProfitPercentage, 0.1);
      optimized.orderCount = Math.min(optimized.orderCount, 5);
    }
    
    return optimized;
  }
  
  /**
   * 计算最优卖出价格
   * @param {number} currentPrice - 当前市场价格
   * @param {string} tradingCoin - 交易币种
   * @returns {number} 最优卖出价格
   */
  calculateOptimalSellPrice(currentPrice, tradingCoin) {
    // 设置卖出价格略低于市场价（确保能够成交）
    return Formatter.adjustPriceToTickSize(currentPrice * 0.995, tradingCoin, this.config);
  }
  
  /**
   * 计算第二次卖出价格（更低）
   * @param {number} currentPrice - 当前市场价格
   * @param {string} tradingCoin - 交易币种
   * @returns {number} 二次卖出价格
   */
  calculateSecondSellPrice(currentPrice, tradingCoin) {
    // 使用更低的价格进行二次尝试（原价格的99%）
    return Formatter.adjustPriceToTickSize(currentPrice * 0.99, tradingCoin, this.config);
  }
  
  /**
   * 计算进度百分比
   * @param {number} currentPrice - 当前价格
   * @param {number} averagePrice - 平均买入价格
   * @param {number} takeProfitPercentage - 止盈百分比
   * @returns {number} 完成进度百分比
   */
  calculateProgressPercentage(currentPrice, averagePrice, takeProfitPercentage) {
    if (!currentPrice || !averagePrice || averagePrice <= 0 || takeProfitPercentage <= 0) {
      return 0;
    }
    
    // 计算价格涨幅百分比
    const priceIncrease = ((currentPrice - averagePrice) / averagePrice) * 100;
    
    // 计算进度百分比，限制在0-100之间
    return Math.min(100, Math.max(0, (priceIncrease / takeProfitPercentage * 100)));
  }
  
  /**
   * 判断是否应该执行交易
   * @param {Object} params - 交易参数
   * @returns {Object|false} 交易信号或false
   */
  shouldExecuteTrade(params) {
    const { currentPrice, symbol, forceStart } = params;
    
    if (!currentPrice || currentPrice <= 0) {
      return false;
    }
    
    const now = Date.now();
    
    // 🔑 如果是强制开始新周期（止盈后），立即开始
    if (forceStart) {
      this.logger?.log(`🔥 强制开始新交易周期 (止盈后重启)`);
      this.strategyState.active = true;
      this.strategyState.lastTradeTime = now;
      
      const config = this.config.trading || {};
      const orderAmount = (config.totalAmount || 100) / (config.orderCount || 10);
      
      return {
        action: 'restart_after_takeprofit',
        side: 'BUY',
        price: currentPrice * 0.998, // 略低于市价买入
        quantity: (orderAmount / currentPrice).toFixed(2),
        amount: orderAmount,
        symbol: symbol
      };
    }
    
    // 检查是否已有活跃策略
    if (this.strategyState.active && this.strategyState.filledOrders >= this.strategyState.totalOrders) {
      return false; // 已达到最大订单数
    }
    
    // 检查交易频率限制（避免过于频繁）
    if (now - this.strategyState.lastTradeTime < 10000) { // 10秒限制
      return false;
    }
    
    // 如果没有活跃策略，可以开始新的马丁格尔策略
    if (!this.strategyState.active) {
      const config = this.config.trading || {};
      const orderAmount = (config.totalAmount || 100) / (config.orderCount || 10);
      
      this.strategyState.active = true;
      this.strategyState.lastTradeTime = now;
      
      return {
        action: 'start_martingale',
        side: 'BUY',
        price: currentPrice * 0.998, // 略低于市价买入
        quantity: (orderAmount / currentPrice).toFixed(2),
        amount: orderAmount,
        symbol: symbol
      };
    }
    
    return false;
  }
  
  /**
   * 判断是否应该取消订单
   * @param {Object} order - 订单对象
   * @param {Object} context - 上下文信息
   * @returns {boolean} 是否应该取消
   */
  shouldCancelOrder(order, context) {
    const { currentPrice, timeElapsed } = context;
    
    if (!order || !currentPrice || currentPrice <= 0) {
      return false;
    }
    
    // 订单超时取消（30分钟）
    if (timeElapsed > 1800000) {
      this.logger?.log(`订单${order.orderId}超时，准备取消`);
      return true;
    }
    
    // 价格偏离太大时取消（超过5%）
    const orderPrice = parseFloat(order.price);
    if (orderPrice > 0) {
      const priceDeviation = Math.abs((currentPrice - orderPrice) / orderPrice);
      if (priceDeviation > 0.05) {
        this.logger?.log(`订单${order.orderId}价格偏离过大(${(priceDeviation*100).toFixed(2)}%)，准备取消`);
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * 更新策略状态
   * @param {Object} update - 状态更新
   */
  updateStrategyState(update) {
    Object.assign(this.strategyState, update);
  }
  
  /**
   * 重置策略状态
   */
  resetStrategyState() {
    this.strategyState = {
      active: false,
      filledOrders: 0,
      totalOrders: this.config.trading?.orderCount || 10,
      averagePrice: 0,
      totalQuantity: 0,
      lastTradeTime: 0
    };
  }
  
  /**
   * 获取策略状态
   * @returns {Object} 当前策略状态
   */
  getStrategyState() {
    return { ...this.strategyState };
  }
}

module.exports = TradingStrategy; 