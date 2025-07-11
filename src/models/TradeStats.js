/**
 * 交易统计类 - 负责管理和计算交易统计数据
 */
// 导入日志工具
const { log } = require('../utils/logger');

class TradeStats {
  /**
   * 构造函数 - 初始化统计数据
   */
  constructor() {
    this.reset();
  }
  
  /**
   * 重置所有统计数据
   */
  reset() {
    this.totalOrders = 0;
    this.filledOrders = 0;
    this.totalFilledAmount = 0;
    this.totalFilledQuantity = 0;
    this.averagePrice = 0;
    this.lastUpdateTime = null;
    this.processedOrderIds = new Set();
  }
  
  /**
   * 更新统计信息
   * @param {Object} order - 订单信息
   * @returns {boolean} 是否已更新数据
   */
  updateStats(order) {
    if (!order || !order.id) return false;
    
    // 检查订单ID是否已处理过
    if (this.processedOrderIds.has(order.id)) {
      // 使用全局log函数（如果可用）记录已处理订单的情况
      if (typeof log === 'function') {
        log(`跳过已处理订单ID: ${order.id}`);
      }
      return false;
    }
    
    // 不再在这里增加totalOrders计数，因为订单创建时已经增加
    // 避免重复计数问题
    
    // 确保有成交信息再更新成交统计
    if (order.status === 'Filled' || order.status === 'PartiallyFilled') {
      // 确保使用数字类型进行计算
      const filledAmount = parseFloat(order.filledAmount || (order.price * order.quantity) || 0);
      const filledQuantity = parseFloat(order.filledQuantity || order.quantity || 0);
      const price = parseFloat(order.price || 0);
      
      // 检查数据有效性
      if (isNaN(filledAmount) || isNaN(filledQuantity) || isNaN(price)) {
        if (typeof log === 'function') {
          log(`订单${order.id}包含无效数据: 数量=${filledQuantity}, 金额=${filledAmount}, 价格=${price}`, true);
        }
        return false;
      }
      
      // 检查数据合理性
      if (filledAmount <= 0 || filledQuantity <= 0 || price <= 0) {
        if (typeof log === 'function') {
          log(`订单${order.id}数据不合理: 数量=${filledQuantity}, 金额=${filledAmount}, 价格=${price}`, true);
        }
        return false;
      }
      
      // 添加到已处理订单集合
      this.processedOrderIds.add(order.id);
      
      // 记录处理详情（如果log函数可用）
      if (typeof log === 'function') {
        log(`处理订单ID: ${order.id}, 状态: ${order.status}, 数量: ${filledQuantity}, 金额: ${filledAmount}`);
      }
      
      // 更新统计数据
      this.totalFilledAmount += filledAmount;
      this.totalFilledQuantity += filledQuantity;
      this.filledOrders++;
      
      // 记录已成交订单计数增加（如果log函数可用）
      if (typeof log === 'function') {
        log(`成交订单数增加到: ${this.filledOrders}, 订单ID: ${order.id}`);
      }
      
      // 只有当有效成交量存在时才计算均价
      if (this.totalFilledQuantity > 0) {
        this.averagePrice = this.totalFilledAmount / this.totalFilledQuantity;
        
        // 记录均价更新（如果log函数可用）
        if (typeof log === 'function') {
          log(`均价更新为: ${this.averagePrice.toFixed(2)}, 总成交量: ${this.totalFilledQuantity.toFixed(6)}`);
        }
      }
      
      this.lastUpdateTime = new Date();
      return true;
    } else {
      // 非成交状态订单（如果log函数可用）
      if (typeof log === 'function') {
        log(`订单${order.id}非成交状态: ${order.status}, 不更新成交统计`);
      }
    }
    
    return false;
  }
  
  /**
   * 计算当前盈亏情况
   * @param {number} currentPrice - 当前市场价格
   * @returns {Object|null} 盈亏信息对象，包含金额和百分比
   */
  calculateProfit(currentPrice) {
    if (this.filledOrders === 0 || this.totalFilledQuantity <= 0 || !currentPrice) {
      return null;
    }
    
    const currentValue = currentPrice * this.totalFilledQuantity;
    const profit = currentValue - this.totalFilledAmount;
    const profitPercent = profit / this.totalFilledAmount * 100;
    
    return {
      currentValue,
      profit,
      profitPercent
    };
  }
  
  /**
   * 获取统计摘要
   * @returns {Object} 统计摘要对象
   */
  getSummary() {
    return {
      totalOrders: this.totalOrders,
      filledOrders: this.filledOrders,
      totalFilledAmount: this.totalFilledAmount,
      totalFilledQuantity: this.totalFilledQuantity,
      averagePrice: this.averagePrice,
      lastUpdateTime: this.lastUpdateTime,
      processedOrdersCount: this.processedOrderIds.size
    };
  }
  
  /**
   * 添加已处理订单ID
   * @param {string} orderId - 订单ID
   */
  addProcessedOrderId(orderId) {
    if (orderId) {
      this.processedOrderIds.add(orderId);
    }
  }
  
  /**
   * 检查订单ID是否已处理
   * @param {string} orderId - 订单ID
   * @returns {boolean} 是否已处理
   */
  isOrderProcessed(orderId) {
    return this.processedOrderIds.has(orderId);
  }
  
  /**
   * 更新部分成交统计数据
   * 用于处理订单的部分成交增量，确保实时统计
   * @param {string} orderId - 订单ID
   * @param {number} newFilledQuantity - 新增成交数量
   * @param {number} newFilledAmount - 新增成交金额
   * @returns {boolean} 是否更新成功
   */
  updatePartialFillStats(orderId, newFilledQuantity, newFilledAmount) {
    if (!orderId || !newFilledQuantity || !newFilledAmount) {
      if (typeof log === 'function') {
        log(`❌ [统计] 部分成交数据无效: orderId=${orderId}, quantity=${newFilledQuantity}, amount=${newFilledAmount}`, true);
      }
      return false;
    }
    
    // 转换为数字类型并验证
    const quantity = parseFloat(newFilledQuantity);
    const amount = parseFloat(newFilledAmount);
    
    if (isNaN(quantity) || isNaN(amount) || quantity <= 0 || amount <= 0) {
      if (typeof log === 'function') {
        log(`❌ [统计] 部分成交数据不合理: quantity=${quantity}, amount=${amount}`, true);
      }
      return false;
    }
    
    // 🔑 关键：增量更新统计数据
    this.totalFilledQuantity += quantity;
    this.totalFilledAmount += amount;
    
    // 重新计算平均价格
    if (this.totalFilledQuantity > 0) {
      this.averagePrice = this.totalFilledAmount / this.totalFilledQuantity;
    }
    
    this.lastUpdateTime = new Date();
    
    if (typeof log === 'function') {
      log(`✅ [统计] 部分成交统计已更新:`);
      log(`   订单ID: ${orderId}`);
      log(`   新增数量: ${quantity.toFixed(6)}`);
      log(`   新增金额: ${amount.toFixed(2)} USDC`);
      log(`   累计数量: ${this.totalFilledQuantity.toFixed(6)}`);
      log(`   累计金额: ${this.totalFilledAmount.toFixed(2)} USDC`);
      log(`   新均价: ${this.averagePrice.toFixed(2)} USDC`);
    }
    
    return true;
  }
  
  /**
   * 手动添加虚拟买单到统计数据
   * 用于对账时补齐统计数据
   * @param {number} quantity - 数量
   * @param {number} price - 价格
   * @returns {boolean} 是否添加成功
   */
  addVirtualOrder(quantity, price) {
    if (!quantity || !price || quantity <= 0 || price <= 0) {
      if (typeof log === 'function') {
        log(`❌ [统计] 虚拟订单数据无效: quantity=${quantity}, price=${price}`, true);
      }
      return false;
    }
    
    const amount = quantity * price;
    
    // 更新统计数据
    this.totalFilledQuantity += quantity;
    this.totalFilledAmount += amount;
    this.filledOrders += 1; // 虚拟订单计数
    
    // 重新计算平均价格
    if (this.totalFilledQuantity > 0) {
      this.averagePrice = this.totalFilledAmount / this.totalFilledQuantity;
    }
    
    this.lastUpdateTime = new Date();
    
    if (typeof log === 'function') {
      log(`✅ [统计] 虚拟订单已添加:`);
      log(`   数量: ${quantity.toFixed(6)}`);
      log(`   价格: ${price.toFixed(2)} USDC`);
      log(`   金额: ${amount.toFixed(2)} USDC`);
      log(`   订单数: ${this.filledOrders}`);
      log(`   新均价: ${this.averagePrice.toFixed(2)} USDC`);
    }
    
    return true;
  }
}

module.exports = TradeStats; 