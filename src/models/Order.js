/**
 * 订单类 - 负责管理单个订单的信息
 */
class Order {
  /**
   * 构造函数
   * @param {Object} orderData - 订单数据
   */
  constructor(orderData = {}) {
    this.id = orderData.id;
    this.symbol = orderData.symbol;
    this.price = parseFloat(orderData.price);
    this.quantity = parseFloat(orderData.quantity);
    this.amount = this.price * this.quantity;
    this.side = orderData.side || 'Bid'; // Bid: 买入, Ask: 卖出
    this.orderType = orderData.orderType || 'Limit';
    this.timeInForce = orderData.timeInForce || 'GTC';
    this.status = orderData.status || 'New';
    this.filledQuantity = parseFloat(orderData.filledQuantity || 0);
    this.filledAmount = parseFloat(orderData.filledAmount || 0);
    this.createTime = orderData.createTime || new Date();
    this.updateTime = orderData.updateTime || new Date();
    this.processed = orderData.processed || false;
    
    // 分批止盈相关属性
    this.takeProfitTriggered = orderData.takeProfitTriggered || false;
    this.takeProfitPrice = orderData.takeProfitPrice || 0;
    this.sellOrderId = orderData.sellOrderId || null;
    this.sellStatus = orderData.sellStatus || 'Pending'; // Pending, Created, Filled
    
    // 修复剩余数量初始化逻辑
    if (orderData.remainingQuantity !== undefined) {
      this.remainingQuantity = parseFloat(orderData.remainingQuantity);
    } else {
      // 如果没有指定剩余数量，使用已成交数量作为初始值
      this.remainingQuantity = this.filledQuantity;
    }
  }
  
  /**
   * 更新订单信息
   * @param {Object} data - 更新的数据
   */
  update(data) {
    if (!data) return;
    
    if (data.status) this.status = data.status;
    if (data.filledQuantity) {
      this.filledQuantity = parseFloat(data.filledQuantity);
      // 更新剩余数量（如果还没有触发止盈）
      if (!this.takeProfitTriggered) {
        this.remainingQuantity = this.filledQuantity;
      }
    }
    if (data.filledAmount) this.filledAmount = parseFloat(data.filledAmount);
    if (data.processed !== undefined) this.processed = data.processed;
    
    this.updateTime = new Date();
  }
  
  /**
   * 检查订单是否已成交
   * @returns {boolean} 是否已成交
   */
  isFilled() {
    return this.status === 'Filled';
  }
  
  /**
   * 检查订单是否部分成交
   * @returns {boolean} 是否部分成交
   */
  isPartiallyFilled() {
    return this.status === 'PartiallyFilled';
  }
  
  /**
   * 检查订单是否已处理（计入统计）
   * @returns {boolean} 是否已处理
   */
  isProcessed() {
    return this.processed;
  }
  
  /**
   * 标记订单为已处理
   */
  markAsProcessed() {
    this.processed = true;
  }
  
  /**
   * 计算止盈价格
   * @param {number} takeProfitPercentage - 止盈百分比
   * @returns {number} 止盈价格
   */
  calculateTakeProfitPrice(takeProfitPercentage) {
    if (!this.isFilled()) return 0;
    this.takeProfitPrice = this.price * (1 + takeProfitPercentage / 100);
    return this.takeProfitPrice;
  }
  
  /**
   * 检查是否达到止盈条件
   * @param {number} currentPrice - 当前价格
   * @returns {boolean} 是否达到止盈条件
   */
  shouldTakeProfit(currentPrice) {
    if (!this.isFilled() || this.takeProfitTriggered || this.takeProfitPrice <= 0) {
      return false;
    }
    return currentPrice >= this.takeProfitPrice;
  }
  
  /**
   * 触发止盈
   * @param {string} sellOrderId - 卖出订单ID
   */
  triggerTakeProfit(sellOrderId = null) {
    this.takeProfitTriggered = true;
    this.sellOrderId = sellOrderId;
    this.sellStatus = sellOrderId ? 'Created' : 'Pending';
    this.updateTime = new Date();
  }
  
  /**
   * 更新卖出状态
   * @param {string} status - 卖出状态
   * @param {number} soldQuantity - 已卖出数量
   */
  updateSellStatus(status, soldQuantity = 0) {
    this.sellStatus = status;
    if (soldQuantity > 0) {
      this.remainingQuantity = Math.max(0, this.remainingQuantity - soldQuantity);
    }
    this.updateTime = new Date();
  }
  
  /**
   * 检查是否完全卖出
   * @returns {boolean} 是否完全卖出
   */
  isFullySold() {
    return this.sellStatus === 'Filled' && this.remainingQuantity <= 0;
  }
  
  /**
   * 获取可卖出数量
   * @returns {number} 可卖出数量
   */
  getAvailableQuantity() {
    return this.remainingQuantity;
  }
  
  /**
   * 获取订单签名（用于防止重复创建）
   * @returns {string} 订单签名
   */
  getSignature() {
    return `${this.price}_${this.quantity}`;
  }
  
  /**
   * 从对象创建订单实例
   * @param {Object} data - 订单数据
   * @returns {Order} 订单实例
   */
  static fromObject(data) {
    return new Order(data);
  }
  
  /**
   * 转换为API格式的订单参数
   * @returns {Object} API格式的订单参数
   */
  toApiParams() {
    return {
      symbol: this.symbol,
      side: this.side,
      orderType: this.orderType,
      quantity: this.quantity.toString(),
      price: this.price.toString(),
      timeInForce: this.timeInForce
    };
  }
}

/**
 * 订单管理器类 - 负责管理多个订单
 */
class OrderManager {
  /**
   * 构造函数
   */
  constructor() {
    this.orders = new Map();
    this.createdOrderSignatures = new Set();
    this.pendingOrderIds = new Set();
    this.allCreatedOrderIds = new Set();
  }
  
  /**
   * 添加订单
   * @param {Order} order - 订单实例
   * @returns {boolean} 是否成功添加
   */
  addOrder(order) {
    if (!order || !order.id) return false;
    
    this.orders.set(order.id, order);
    this.allCreatedOrderIds.add(order.id);
    this.createdOrderSignatures.add(order.getSignature());
    
    // 如果订单状态不是已成交，则添加到待处理列表
    if (order.status !== 'Filled') {
      this.pendingOrderIds.add(order.id);
    }
    
    return true;
  }
  
  /**
   * 获取订单
   * @param {string} orderId - 订单ID
   * @returns {Order|undefined} 订单实例或undefined
   */
  getOrder(orderId) {
    return this.orders.get(orderId);
  }
  
  /**
   * 更新订单状态
   * @param {string} orderId - 订单ID
   * @param {Object} data - 更新的数据
   * @returns {boolean} 是否成功更新
   */
  updateOrder(orderId, data) {
    const order = this.orders.get(orderId);
    if (!order) return false;
    
    order.update(data);
    
    // 如果订单成交，从待处理列表移除
    if (order.isFilled()) {
      this.pendingOrderIds.delete(orderId);
    }
    
    return true;
  }
  
  /**
   * 检查签名是否已存在（防止重复创建订单）
   * @param {string} signature - 订单签名
   * @returns {boolean} 是否已存在
   */
  hasOrderSignature(signature) {
    return this.createdOrderSignatures.has(signature);
  }
  
  /**
   * 重置所有订单数据
   */
  reset() {
    this.orders.clear();
    this.createdOrderSignatures.clear();
    this.pendingOrderIds.clear();
    this.allCreatedOrderIds.clear();
  }
  
  /**
   * 获取待处理的订单ID列表
   * @returns {Array<string>} 待处理的订单ID列表
   */
  getPendingOrderIds() {
    return Array.from(this.pendingOrderIds);
  }
  
  /**
   * 获取所有已创建的订单ID列表
   * @returns {Array<string>} 所有已创建的订单ID列表
   */
  getAllCreatedOrderIds() {
    return Array.from(this.allCreatedOrderIds);
  }
  
  /**
   * 移除待处理订单ID
   * @param {string} orderId - 订单ID
   */
  removePendingOrderId(orderId) {
    this.pendingOrderIds.delete(orderId);
  }
  
  /**
   * 更新待处理订单ID列表
   * @param {Array<string>} orderIds - 新的待处理订单ID列表
   */
  updatePendingOrderIds(orderIds) {
    this.pendingOrderIds = new Set(orderIds);
  }
  
  /**
   * 获取所有订单列表
   * @returns {Array<Order>} 所有订单列表
   */
  getAllOrders() {
    return Array.from(this.orders.values());
  }
  
  /**
   * 获取已成交但未止盈的买入订单
   * @returns {Array<Order>} 可以止盈的订单列表
   */
  getFilledBuyOrders() {
    return Array.from(this.orders.values()).filter(order => 
      order.side === 'Bid' && 
      order.isFilled() && 
      !order.takeProfitTriggered
    );
  }
  
  /**
   * 获取已触发止盈但未完全卖出的订单
   * @returns {Array<Order>} 待卖出的订单列表
   */
  getPendingSellOrders() {
    return Array.from(this.orders.values()).filter(order => 
      order.side === 'Bid' && 
      order.takeProfitTriggered && 
      !order.isFullySold()
    );
  }
  
  /**
   * 计算总的剩余可卖出数量
   * @returns {number} 总剩余可卖出数量
   */
  getTotalAvailableQuantity() {
    return Array.from(this.orders.values())
      .filter(order => order.side === 'Bid' && order.isFilled())
      .reduce((total, order) => total + order.getAvailableQuantity(), 0);
  }
  
  /**
   * 获取订单的统计信息
   * @returns {Object} 统计信息
   */
  getBatchStats() {
    const buyOrders = Array.from(this.orders.values()).filter(order => order.side === 'Bid');
    const filledOrders = buyOrders.filter(order => order.isFilled());
    const takeProfitOrders = filledOrders.filter(order => order.takeProfitTriggered);
    const fullySoldOrders = takeProfitOrders.filter(order => order.isFullySold());
    
    return {
      totalBuyOrders: buyOrders.length,
      filledBuyOrders: filledOrders.length,
      takeProfitTriggered: takeProfitOrders.length,
      fullySoldOrders: fullySoldOrders.length,
      pendingSellOrders: takeProfitOrders.length - fullySoldOrders.length,
      totalAvailableQuantity: this.getTotalAvailableQuantity()
    };
  }
}

module.exports = {
  Order,
  OrderManager
}; 