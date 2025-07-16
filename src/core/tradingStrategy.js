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
    symbol
  ) {
    const orders = [];
    
    // 计算价格区间
    const lowestPrice = currentPrice * (1 - maxDropPercentage / 100);
    // 🔑 修复：确保第一个订单不会按市场价立即成交
    // 将价格区间均匀分布，但第一个订单价格低于当前价格
    const priceStep = (currentPrice - lowestPrice) / orderCount; // 去掉 -1
    
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
      // 🔑 修复：确保所有订单价格都低于当前市场价
      // 第一个订单 (i=0) 价格现在是 currentPrice - priceStep，而不是 currentPrice
      const rawPrice = currentPrice - (priceStep * (i + 1)); // 加1确保第一个订单也低于市场价
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
}

module.exports = TradingStrategy; 